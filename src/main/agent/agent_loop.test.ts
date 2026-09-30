import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ApprovalDecision, ChatEvent } from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import { AnthropicConversation, createAnthropicClient } from '../llm/anthropic';
import { anthropicStream, MockApiServer } from '../llm/test_server';
import type { Conversation, ImageData, ToolResult, TurnRequest, TurnResult, UserInput } from '../llm/types';
import {
  defineTool,
  ToolError,
  type AgentTool,
  type EditUndo,
  type ToolContext,
  type ToolOutput,
} from '../tools/types';
import { Agent, type DroppedFieldError } from './agent';

type Step = Partial<TurnResult> | ((request: TurnRequest) => Promise<Partial<TurnResult>>);

// A conversation that replays scripted model turns and records what the agent sent to it, in order.
class ScriptedConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'test-model';
  readonly log: string[] = [];
  readonly users: UserInput[] = [];
  readonly results: ToolResult[][] = [];
  turns = 0;

  constructor(private readonly steps: Step[] | ((turn: number) => Step)) {}

  addUserMessage(input: UserInput): void {
    this.users.push(input);
    this.log.push(`user:${input.text.slice(0, 12)}`);
  }

  addToolResults(results: ToolResult[]): void {
    this.results.push(results);
    this.log.push(`results:${results.map((result) => result.id).join(',')}`);
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const turn = this.turns++;
    this.log.push('turn');
    const step = typeof this.steps === 'function' ? this.steps(turn) : this.steps[turn];
    if (!step) throw new Error('unexpected extra turn');
    const partial = typeof step === 'function' ? await step(request) : step;
    if (partial.text) request.callbacks.onText(partial.text);
    return {
      text: '',
      toolCalls: [],
      stopReason: partial.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      contextTokens: 1,
      ...partial,
    };
  }

  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }

  planCompaction() {
    return null;
  }

  applyCompaction(): void {}

  hasPendingToolCalls(): boolean {
    return false;
  }
}

const image: ImageData = { mediaType: 'image/png', base64: 'AAAA' };

function tool(
  name: string,
  run: (input: Record<string, unknown>, context: ToolContext) => Promise<ToolOutput> | ToolOutput,
  extra: Partial<Pick<AgentTool, 'requiresApproval' | 'preview'>> = {},
): AgentTool {
  return defineTool({
    name,
    description: name,
    schema: z.object({ what: z.string().optional() }),
    requiresApproval: false,
    ...extra,
    async run(input, context) {
      return run(input, context);
    },
  });
}

// A tool that needs a string `what`, to check input validation.
const strict = defineTool({
  name: 'strict',
  description: 'strict',
  schema: z.object({ what: z.string() }),
  requiresApproval: false,
  async run({ what }) {
    return { content: `saw ${what}`, summary: `Saw ${what}`, images: [image] };
  },
});

function setup(
  steps: Step[] | ((turn: number) => Step),
  {
    tools = [] as AgentTool[],
    mode = 'auto' as ApprovalMode,
    requestApproval = vi.fn(async (): Promise<ApprovalDecision> => ({ approved: true })),
    onDroppedFields = undefined as ((error: DroppedFieldError) => void) | undefined,
    onEditApplied = undefined as ((toolId: string, edit: EditUndo) => void) | undefined,
    // Retries wait through this instead of real timers; the default returns at once.
    sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {}),
  } = {},
) {
  const conversation = new ScriptedConversation(steps);
  const events: ChatEvent[] = [];
  const agent = new Agent({
    conversation,
    system: 'system',
    tools: () => tools,
    approvalMode: () => mode,
    requestApproval,
    toolContext: (signal, onProgress) => ({ signal, onProgress, readFiles: new Set() }) as unknown as ToolContext,
    emit: (event) => events.push(event),
    onDroppedFields,
    onEditApplied,
    sleep,
    random: () => 0.5,
  });
  return { agent, conversation, events, requestApproval, sleep };
}

function eventsOf<T extends ChatEvent['type']>(events: ChatEvent[], type: T): Array<Extract<ChatEvent, { type: T }>> {
  return events.filter((event): event is Extract<ChatEvent, { type: T }> => event.type === type);
}

function call(id: string, name: string, input: unknown = {}) {
  return { id, name, input };
}

// Resolves once `started()` has been called, so a test can act while a tool is running.
function signalPair() {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  return { started, running };
}

describe('Agent: tool-result pairing', () => {
  it('answers every call, in order, whatever happened to it', async () => {
    const soft = tool('soft', () => ({ content: 'failed softly', isError: true, summary: 'Soft fail' }));
    const denied = tool('denied', () => {
      throw new ToolError('not allowed here');
    });
    const crash = tool('crash', () => {
      throw new Error('kaput');
    });
    const { agent, conversation, events } = setup(
      [
        {
          toolCalls: [
            call('t1', 'strict', { what: 'a' }),
            call('t2', 'missing'),
            call('t3', 'strict', { what: 42 }),
            call('t4', 'denied'),
            call('t5', 'crash'),
            call('t6', 'soft'),
          ],
        },
        { text: 'done' },
      ],
      { tools: [strict, soft, denied, crash] },
    );

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.results).toHaveLength(1);
    expect(conversation.results[0]!.map((result) => result.id)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(conversation.results[0]).toMatchObject([
      { content: 'saw a', images: [image] },
      { content: 'Unknown tool: missing', isError: true },
      { isError: true, content: expect.stringMatching(/^Invalid input for strict: what: .*Send every required field/) },
      { content: 'not allowed here', isError: true },
      { content: 'Error: kaput', isError: true },
      { content: 'failed softly', isError: true },
    ]);
    expect(conversation.results[0]![0]!.isError).toBeUndefined();

    // Unknown tools and invalid input never show up as started tools; everything else ends with a status.
    const starts = eventsOf(events, 'tool-start');
    expect(starts.map((event) => event.name)).toEqual(['strict', 'denied', 'crash', 'soft']);
    expect(new Set(starts.map((event) => event.id))).toHaveLength(4);
    expect(eventsOf(events, 'tool-end').map((event) => [event.id, event.status, event.summary])).toEqual([
      [starts[0]!.id, 'done', 'Saw a'],
      [starts[1]!.id, 'error', 'denied failed'],
      [starts[2]!.id, 'error', 'crash failed'],
      [starts[3]!.id, 'error', 'Soft fail'],
    ]);
  });

  it('sends results only after all calls of a turn and before the next model turn', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation } = setup([{ toolCalls: [call('a', 'look'), call('b', 'look')] }, { text: 'done' }], {
      tools: [look],
    });
    await agent.send({ text: 'go' }, new AbortController().signal);
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:a,b', 'turn']);
  });

  it('keeps the transcript event id for a call without an id', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation, events } = setup([{ toolCalls: [call('', 'look')] }, { text: 'done' }], {
      tools: [look],
    });
    await agent.send({ text: 'go' }, new AbortController().signal);

    const start = eventsOf(events, 'tool-start')[0]!;
    const end = eventsOf(events, 'tool-end')[0]!;
    expect(start.id).not.toBe('');
    expect(end.id).toBe(start.id);
    expect(conversation.results[0]![0]!.id).toBe('');
  });

  it('streams tool progress and only shows the output of command tools', async () => {
    const runCommand = tool('run_command', (_input, context) => {
      context.onProgress('line 1');
      return { content: 'exit code 0' };
    });
    const look = tool('look', () => ({ content: 'plain result' }));
    const { agent, events } = setup(
      [{ toolCalls: [call('c1', 'run_command'), call('c2', 'look')] }, { text: 'done' }],
      { tools: [runCommand, look] },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    const starts = eventsOf(events, 'tool-start');
    expect(eventsOf(events, 'tool-progress')).toEqual([{ type: 'tool-progress', id: starts[0]!.id, text: 'line 1' }]);
    expect(eventsOf(events, 'tool-end').map((event) => [event.id, event.output])).toEqual([
      [starts[0]!.id, 'exit code 0'],
      [starts[1]!.id, undefined],
    ]);
  });

  it('does not run a tool whose preview fails, and reports the reason', async () => {
    const run = vi.fn(() => ({ content: 'changed' }));
    const edit = tool('edit', run, {
      requiresApproval: true,
      preview: async () => {
        throw new Error('target file is missing');
      },
    });
    const { agent, conversation, events, requestApproval } = setup(
      [{ toolCalls: [call('e1', 'edit')] }, { text: 'ok' }],
      {
        mode: 'ask',
        tools: [edit],
      },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(run).not.toHaveBeenCalled();
    expect(requestApproval).not.toHaveBeenCalled();
    expect(conversation.results[0]![0]).toEqual({ id: 'e1', content: 'target file is missing', isError: true });
    const eventId = eventsOf(events, 'tool-start')[0]!.id;
    expect(eventId).not.toBe('e1');
    expect(eventsOf(events, 'tool-start')[0]).toMatchObject({ awaitingApproval: false });
    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({
      id: eventId,
      status: 'error',
      output: 'target file is missing',
    });
  });
});

describe('Agent: dropped-field reporting', () => {
  const edit = defineTool({
    name: 'edit_file',
    description: 'edit',
    schema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
    requiresApproval: false,
    async run() {
      return { content: 'edited' };
    },
  });

  it('reports the tool, the model and the field names, never the values', async () => {
    const reported: DroppedFieldError[] = [];
    const { agent } = setup(
      [
        {
          toolCalls: [
            call('t1', 'edit_file', { path: 'src/secret.ts', old_string: 'const password = "hunter2"' }),
            call('t2', 'edit_file', { path: 7, old_string: 'x' }),
          ],
        },
        { text: 'done' },
      ],
      { tools: [edit], onDroppedFields: (error) => reported.push(error) },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(reported).toEqual([
      {
        tool: 'edit_file',
        model: 'test-model',
        missing: ['new_string'],
        invalid: [],
        received: ['path', 'old_string'],
      },
      {
        tool: 'edit_file',
        model: 'test-model',
        missing: ['new_string'],
        invalid: ['path'],
        received: ['path', 'old_string'],
      },
    ]);
    expect(JSON.stringify(reported)).not.toMatch(/hunter2|secret\.ts/);
  });

  it('does not report valid calls, unknown tools or type errors without a missing field', async () => {
    const reported: DroppedFieldError[] = [];
    const { agent } = setup(
      [
        {
          toolCalls: [
            call('t1', 'edit_file', { path: 'a', old_string: 'b', new_string: 'c' }),
            call('t2', 'nope', {}),
            call('t3', 'edit_file', { path: 1, old_string: 'b', new_string: 'c' }),
          ],
        },
        { text: 'done' },
      ],
      { tools: [edit], onDroppedFields: (error) => reported.push(error) },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);
    expect(reported).toEqual([]);
  });

  it('reports a call with no fields at all, and still returns the error to the model', async () => {
    const reported: DroppedFieldError[] = [];
    const { agent, conversation } = setup([{ toolCalls: [call('t1', 'edit_file', {})] }, { text: 'done' }], {
      tools: [edit],
      onDroppedFields: (error) => reported.push(error),
    });
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(reported[0]).toMatchObject({ missing: ['path', 'old_string', 'new_string'], received: [] });
    expect(conversation.results[0]![0]).toMatchObject({ isError: true });
  });
});

describe('Agent: undoable edits', () => {
  const undo: EditUndo = { path: 'src/a.ts', before: Buffer.from('old'), afterHash: 'abc' };
  const editing = (output: Partial<ToolOutput> = {}) =>
    tool(
      'edit_file',
      () => ({ content: 'Edited src/a.ts.', summary: 'Edited src/a.ts', path: 'src/a.ts', undo, ...output }),
      {
        requiresApproval: true,
      },
    );
  const run = async (edit: AgentTool, onEditApplied?: (toolId: string, edit: EditUndo) => void) => {
    const setUp = setup([{ toolCalls: [call('t1', 'edit_file')] }, { text: 'done' }], { tools: [edit], onEditApplied });
    await setUp.agent.send({ text: 'go' }, new AbortController().signal);
    return setUp;
  };

  it('hands the backup of an approved edit over under the id of its tool card, and marks the card undoable', async () => {
    const kept: Array<[string, EditUndo]> = [];
    const { events } = await run(editing(), (toolId, edit) => kept.push([toolId, edit]));

    const eventId = eventsOf(events, 'tool-start')[0]!.id;
    expect(kept).toEqual([[eventId, undo]]);
    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({
      id: eventId,
      status: 'done',
      path: 'src/a.ts',
      undoable: true,
    });
  });

  it('does not show the backup to the model', async () => {
    const { conversation } = await run(editing(), () => {});
    expect(JSON.stringify(conversation.results)).not.toContain('afterHash');
    expect(conversation.results[0]![0]).toEqual({
      id: 't1',
      content: 'Edited src/a.ts.',
      isError: undefined,
      images: undefined,
    });
  });

  it('reports the edit as done but not undoable when the backup could not be kept', async () => {
    const { events, conversation } = await run(editing(), () => {
      throw new Error('disk full');
    });

    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({ status: 'done', undoable: false });
    expect(conversation.results[0]![0]!.isError).toBeUndefined();
  });

  it('offers no undo when nothing keeps backups, when the tool has none, or when the edit failed', async () => {
    const noKeeper = await run(editing());
    expect(eventsOf(noKeeper.events, 'tool-end')[0]!.undoable).toBe(false);

    const kept = vi.fn();
    const plain = await run(editing({ undo: undefined }), kept);
    expect(eventsOf(plain.events, 'tool-end')[0]!.undoable).toBeUndefined();

    const failed = await run(editing({ isError: true }), kept);
    expect(eventsOf(failed.events, 'tool-end')[0]).toMatchObject({ status: 'error', undoable: undefined });
    expect(kept).not.toHaveBeenCalled();
  });

  it('keeps no backup for an edit the user declined', async () => {
    const kept = vi.fn();
    const { events } = await (async () => {
      const setUp = setup([{ toolCalls: [call('t1', 'edit_file')] }], {
        tools: [editing()],
        mode: 'ask',
        requestApproval: vi.fn(async () => ({ approved: false })),
        onEditApplied: kept,
      });
      await setUp.agent.send({ text: 'go' }, new AbortController().signal);
      return setUp;
    })();

    expect(kept).not.toHaveBeenCalled();
    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({ status: 'declined' });
  });
});

describe('Agent: approvals', () => {
  it('asks only for tools that need approval in ask mode, passing the call id and the run signal', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const change = tool('change', () => ({ content: 'changed' }), { requiresApproval: true });
    const controller = new AbortController();
    const { agent, events, requestApproval } = setup(
      [{ toolCalls: [call('t1', 'look'), call('t2', 'change')] }, { text: 'done' }],
      { mode: 'ask', tools: [look, change] },
    );
    await agent.send({ text: 'go' }, controller.signal);

    expect(requestApproval).toHaveBeenCalledTimes(1);
    const changeId = eventsOf(events, 'tool-start').find((event) => event.name === 'change')?.id;
    expect(requestApproval).toHaveBeenCalledWith(changeId, controller.signal);
  });

  it('treats a decline with a blank note as a decline without feedback and skips the rest of the turn', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const change = tool('change', () => ({ content: 'changed' }), { requiresApproval: true });
    const { agent, conversation, events } = setup(
      [{ toolCalls: [call('t1', 'look'), call('t2', 'change'), call('t3', 'look')] }],
      {
        mode: 'ask',
        tools: [look, change],
        requestApproval: vi.fn(async () => ({ approved: false, feedback: '   ' })),
      },
    );

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.turns).toBe(1);
    expect(conversation.results[0]).toEqual([
      { id: 't1', content: 'ok', isError: undefined, images: undefined },
      { id: 't2', content: 'The user declined this action. Wait for further instructions.', isError: true },
      { id: 't3', content: 'Not run: the user declined an earlier action.', isError: true },
    ]);
    const changeId = eventsOf(events, 'tool-start').find((event) => event.name === 'change')?.id;
    expect(eventsOf(events, 'tool-end').find((event) => event.id === changeId)).toMatchObject({ status: 'declined' });
  });

  it('keeps repeated provider call ids separate while pairing results with the provider', async () => {
    const backups: string[] = [];
    const edit = tool(
      'edit',
      ({ what }) => ({
        content: `edited ${what}`,
        summary: `Edited ${what}`,
        undo: { path: String(what), before: Buffer.from('before'), afterHash: String(what) },
      }),
      { requiresApproval: true },
    );
    const { agent, conversation, events, requestApproval } = setup(
      [
        { toolCalls: [call('reused', 'edit', { what: 'a.ts' })] },
        { toolCalls: [call('reused', 'edit', { what: 'b.ts' })] },
        { text: 'done' },
      ],
      { mode: 'ask', tools: [edit], onEditApplied: (id) => backups.push(id) },
    );

    await agent.send({ text: 'edit both' }, new AbortController().signal);

    const cardIds = eventsOf(events, 'tool-start').map((event) => event.id);
    expect(cardIds).toHaveLength(2);
    expect(new Set(cardIds)).toHaveLength(2);
    expect(requestApproval).toHaveBeenCalledTimes(2);
    cardIds.forEach((id, index) =>
      expect(requestApproval).toHaveBeenNthCalledWith(index + 1, id, expect.any(AbortSignal)),
    );
    expect(backups).toEqual(cardIds);
    expect(eventsOf(events, 'tool-end').map((event) => event.id)).toEqual(cardIds);
    expect(conversation.results.map(([result]) => result!.id)).toEqual(['reused', 'reused']);
    expect(conversation.results.map(([result]) => result!.content)).toEqual(['edited a.ts', 'edited b.ts']);
  });

  it('does not run an approved tool when the stop arrived while waiting', async () => {
    const run = vi.fn(() => ({ content: 'changed' }));
    const change = tool('change', run, { requiresApproval: true });
    const controller = new AbortController();
    const { agent, conversation, events } = setup([{ toolCalls: [call('t1', 'change')] }], {
      mode: 'ask',
      tools: [change],
      requestApproval: vi.fn(async () => {
        controller.abort();
        return { approved: true };
      }),
    });

    expect(await agent.send({ text: 'go' }, controller.signal)).toBe(true);

    expect(run).not.toHaveBeenCalled();
    expect(conversation.results[0]![0]).toMatchObject({ id: 't1', isError: true });
    expect(conversation.results[0]![0]!.content).toContain('Stopped by the user before this action was approved');
    expect(eventsOf(events, 'tool-end')[0]).toMatchObject({ status: 'error', summary: 'Stopped' });
  });
});

describe('Agent: stop', () => {
  it('returns at once when the signal is already aborted, without calling the model', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, conversation, events } = setup([{ text: 'never' }]);

    expect(await agent.send({ text: 'go' }, controller.signal)).toBe(true);
    expect(conversation.turns).toBe(0);
    expect(events).toEqual([]);
  });

  it('answers the running tool and the calls after it when stopped mid-tool, then ends the run', async () => {
    const controller = new AbortController();
    const { started, running } = signalPair();
    const ran: string[] = [];
    const slow = tool(
      'slow',
      (_input, context) =>
        new Promise<ToolOutput>((resolve) => {
          started();
          context.signal.addEventListener('abort', () => resolve({ content: 'interrupted', isError: true }));
        }),
    );
    const look = tool('look', () => {
      ran.push('look');
      return { content: 'ok' };
    });
    const { agent, conversation } = setup(
      [{ toolCalls: [call('t1', 'slow'), call('t2', 'look')] }, { text: 'never' }],
      {
        tools: [slow, look],
      },
    );

    const sending = agent.send({ text: 'go' }, controller.signal);
    await running;
    controller.abort();

    expect(await sending).toBe(true);
    expect(ran).toEqual([]);
    expect(conversation.turns).toBe(1);
    expect(conversation.results[0]).toEqual([
      { id: 't1', content: 'interrupted', isError: true, images: undefined },
      { id: 't2', content: 'Not run: the user stopped the task.', isError: true },
    ]);
  });

  it('records the finished results before ending a run that was stopped between turns', async () => {
    const controller = new AbortController();
    const finishAndStop = tool('finish', () => {
      controller.abort();
      return { content: 'finished anyway' };
    });
    const { agent, conversation } = setup([{ toolCalls: [call('t1', 'finish')] }, { text: 'never' }], {
      tools: [finishAndStop],
    });

    expect(await agent.send({ text: 'go' }, controller.signal)).toBe(true);
    expect(conversation.turns).toBe(1);
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:t1']);
  });

  it('rethrows an abort from the model turn after closing the streamed message', async () => {
    const controller = new AbortController();
    const { agent, events } = setup([
      (request) =>
        new Promise((_resolve, reject) => {
          request.callbacks.onText('partial');
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          controller.abort();
        }),
    ]);

    await expect(agent.send({ text: 'go' }, controller.signal)).rejects.toThrow('aborted');
    const start = eventsOf(events, 'assistant-start')[0]!;
    expect(eventsOf(events, 'assistant-end')).toEqual([{ type: 'assistant-end', id: start.id }]);
  });
});

describe('Agent: resume', () => {
  it('continues after a stopped tool without repeating the request or running the skipped calls', async () => {
    const first = new AbortController();
    const { started, running } = signalPair();
    const ran: string[] = [];
    const slow = tool(
      'slow',
      (_input, context) =>
        new Promise<ToolOutput>((resolve) => {
          started();
          context.signal.addEventListener('abort', () => resolve({ content: 'interrupted', isError: true }));
        }),
    );
    const look = tool('look', () => {
      ran.push('look');
      return { content: 'ok' };
    });
    const { agent, conversation } = setup(
      [{ toolCalls: [call('t1', 'slow'), call('t2', 'look')] }, { text: 'Carried on' }],
      {
        tools: [slow, look],
      },
    );

    const sending = agent.send({ text: 'go' }, first.signal);
    await running;
    first.abort();
    expect(await sending).toBe(true);

    expect(await agent.resume(new AbortController().signal)).toBe(false);

    // Every call was answered before the continuation message, so the history stays valid for the provider.
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:t1,t2', 'user:Continue the', 'turn']);
    expect(conversation.users[0]!.text).toBe('go');
    expect(conversation.users[1]!.text).toContain('do not repeat the original request');
    expect(conversation.users[1]!.text).toContain('inspect the current state');
    expect(ran).toEqual([]);
  });

  it('reports a stop during a resumed run as interrupted again', async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, conversation } = setup([{ text: 'never' }]);

    expect(await agent.resume(controller.signal)).toBe(true);
    expect(conversation.turns).toBe(0);
    expect(conversation.users).toHaveLength(1);
  });
});

describe('Agent: error and limit paths', () => {
  it('closes the streamed message and rejects when the model call fails', async () => {
    const { agent, conversation, events } = setup([
      async (request) => {
        request.callbacks.onText('partial');
        throw new Error('connection reset');
      },
    ]);

    await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toThrow('connection reset');

    const [start] = eventsOf(events, 'assistant-start');
    expect(events.map((event) => event.type)).toEqual(['assistant-start', 'assistant-delta', 'assistant-end']);
    expect(eventsOf(events, 'assistant-end')[0]).toEqual({ type: 'assistant-end', id: start!.id });
    expect(conversation.results).toEqual([]);
    expect(agent.totals).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('keeps the results and usage of earlier turns when a later turn fails', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation } = setup(
      [
        {
          toolCalls: [call('t1', 'look')],
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 },
          contextTokens: 14,
        },
        async () => {
          throw new Error('rate limited');
        },
      ],
      { tools: [look] },
    );

    await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toThrow('rate limited');
    expect(conversation.results).toHaveLength(1);
    expect(agent.totals).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 4 });
  });

  it('does not run tool calls that come with a refusal, and explains the refusal', async () => {
    const run = vi.fn(() => ({ content: 'ran' }));
    const risky = tool('risky', run);
    const { agent, conversation, events } = setup(
      [
        { stopReason: 'refusal', refusal: 'Not able to help with that.', toolCalls: [call('t1', 'risky')] },
        { stopReason: 'refusal', toolCalls: [call('t2', 'risky')] },
      ],
      { tools: [risky] },
    );
    const signal = new AbortController().signal;

    expect(await agent.send({ text: 'one' }, signal)).toBe(false);
    expect(await agent.send({ text: 'two' }, signal)).toBe(false);

    expect(run).not.toHaveBeenCalled();
    // Each call still gets a result, or every later request in the chat would be rejected for a call without one.
    expect(conversation.results).toEqual([
      [{ id: 't1', content: 'Not run: the response was stopped by a refusal.', isError: true }],
      [{ id: 't2', content: 'Not run: the response was stopped by a refusal.', isError: true }],
    ]);
    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual([
      'Not able to help with that.',
      'The model declined this request.',
    ]);
  });

  it('does not run tool calls from a response cut off by a full context window', async () => {
    const run = vi.fn(() => ({ content: 'ran' }));
    const write = tool('write', run);
    const { agent, conversation } = setup(
      [{ stopReason: 'context_exceeded', toolCalls: [call('t1', 'write')] }, { text: 'ok' }],
      {
        tools: [write],
      },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(run).not.toHaveBeenCalled();
    expect(conversation.results[0]![0]).toMatchObject({
      id: 't1',
      isError: true,
      content: expect.stringContaining('may be cut off'),
    });
  });

  it('tells the user when the conversation is too long or the answer was cut off', async () => {
    const { agent, events } = setup([
      { stopReason: 'context_exceeded' },
      { stopReason: 'max_tokens', text: 'half an ans' },
    ]);
    const signal = new AbortController().signal;

    expect(await agent.send({ text: 'one' }, signal)).toBe(false);
    expect(await agent.send({ text: 'two' }, signal)).toBe(false);

    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual([
      'The conversation is too long for the model. Start a new chat.',
      'The response hit the output limit and may be incomplete.',
    ]);
  });

  it('gives up after 200 model turns of tool calls', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, conversation, events } = setup((turn) => ({ toolCalls: [call(`t${turn}`, 'look')] }), {
      tools: [look],
    });

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.turns).toBe(200);
    expect(conversation.results).toHaveLength(200);
    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual(['Stopped after 200 steps.']);
  });
});

describe('Agent: retrying transient provider errors', () => {
  const httpError = (code: number, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(`HTTP ${code}`), { status: code, ...extra });
  const fail =
    (error: Error): Step =>
    async () => {
      throw error;
    };

  it('waits, says so in the chat, and tries the request again', async () => {
    const { agent, conversation, events, sleep } = setup([fail(httpError(503)), { text: 'Recovered.' }]);

    expect(await agent.send({ text: 'go' }, new AbortController().signal)).toBe(false);

    expect(conversation.turns).toBe(2);
    expect(conversation.users).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(2000);
    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual([
      'Server error (503). Retrying in 2 s (retry 1 of 4)…',
    ]);
    expect(eventsOf(events, 'assistant-end').at(-1)).toMatchObject({ text: 'Recovered.' });
    expect(eventsOf(events, 'error')).toEqual([]);
  });

  it('puts the retry notice before the answer and drops the text the failed attempt streamed', async () => {
    const { agent, events } = setup([
      async (request) => {
        request.callbacks.onText('half an answ');
        throw httpError(429);
      },
      { text: 'Full answer.' },
    ]);
    await agent.send({ text: 'go' }, new AbortController().signal);

    const starts = eventsOf(events, 'assistant-start').map((event) => event.id);
    expect(starts).toHaveLength(2);
    expect(events.map((event) => event.type).filter((type) => type !== 'usage')).toEqual([
      'assistant-start',
      'assistant-delta',
      'assistant-restart',
      'assistant-end',
      'notice',
      'assistant-start',
      'assistant-delta',
      'assistant-end',
    ]);
    // The restart and end belong to the first attempt, the answer to the second.
    expect(eventsOf(events, 'assistant-restart')[0]!.id).toBe(starts[0]);
    expect(eventsOf(events, 'assistant-end').at(-1)).toMatchObject({ id: starts[1], text: 'Full answer.' });
  });

  it('backs off longer each time and gives up with the original error after four retries', async () => {
    const original = httpError(500);
    const { agent, conversation, events, sleep } = setup([
      fail(original),
      fail(original),
      fail(original),
      fail(original),
      fail(original),
    ]);

    await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toBe(original);

    expect(conversation.turns).toBe(5);
    expect(sleep.mock.calls.map((call) => call[0])).toEqual([2000, 4000, 8000, 16000]);
    expect(eventsOf(events, 'notice').map((event) => event.text)).toEqual([
      'Server error (500). Retrying in 2 s (retry 1 of 4)…',
      'Server error (500). Retrying in 4 s (retry 2 of 4)…',
      'Server error (500). Retrying in 8 s (retry 3 of 4)…',
      'Server error (500). Retrying in 16 s (retry 4 of 4)…',
    ]);
    // Every attempt's message is closed, including the last.
    expect(eventsOf(events, 'assistant-end')).toHaveLength(5);
  });

  it('keeps the text streamed by an attempt that is not retried', async () => {
    const { agent, events, sleep } = setup([
      async (request) => {
        request.callbacks.onText('partial answer');
        throw httpError(401);
      },
    ]);

    await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toThrow('HTTP 401');
    expect(sleep).not.toHaveBeenCalled();
    expect(eventsOf(events, 'assistant-restart')).toEqual([]);
    expect(eventsOf(events, 'notice')).toEqual([]);
  });

  it('shows errors that will not pass right away instead of retrying', async () => {
    for (const error of [
      httpError(400),
      httpError(404),
      httpError(429, { code: 'insufficient_quota' }),
      new Error('plain failure'),
    ]) {
      const { agent, conversation, sleep } = setup([fail(error)]);
      await expect(agent.send({ text: 'go' }, new AbortController().signal)).rejects.toBe(error);
      expect(conversation.turns).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it('waits as long as the provider asks', async () => {
    const { agent, sleep, events } = setup([
      fail(httpError(429, { headers: new Headers({ 'retry-after': '7' }) })),
      { text: 'ok' },
    ]);
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(sleep.mock.calls[0]![0]).toBe(7000);
    expect(eventsOf(events, 'notice')[0]!.text).toBe('Rate limited (429). Retrying in 7 s (retry 1 of 4)…');
  });

  it('retries a dropped connection', async () => {
    const dropped = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const { agent, events } = setup([fail(dropped), { text: 'ok' }]);
    await agent.send({ text: 'go' }, new AbortController().signal);
    expect(eventsOf(events, 'notice')[0]!.text).toContain('Connection problem (ECONNRESET)');
  });

  it('retries only the failed request, after the tools of earlier turns have run and been recorded', async () => {
    const run = vi.fn(() => ({ content: 'ok' }));
    const look = tool('look', run);
    const { agent, conversation } = setup(
      [
        {
          toolCalls: [call('t1', 'look')],
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
          contextTokens: 10,
        },
        fail(httpError(503)),
        { text: 'done', usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 0 }, contextTokens: 20 },
      ],
      { tools: [look] },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    expect(run).toHaveBeenCalledTimes(1);
    expect(conversation.log).toEqual(['user:go', 'turn', 'results:t1', 'turn', 'turn']);
    // The failed attempt used no tokens.
    expect(agent.totals).toMatchObject({ inputTokens: 30, outputTokens: 5 });
  });

  it('ends the run without another attempt when the user stops during the wait', async () => {
    const controller = new AbortController();
    const { started, running } = signalPair();
    const waitForStop = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          started();
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const { agent, conversation, events } = setup([fail(httpError(503)), { text: 'never' }], { sleep: waitForStop });

    const sending = agent.send({ text: 'go' }, controller.signal);
    await running;
    controller.abort();

    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(conversation.turns).toBe(1);
    expect(eventsOf(events, 'notice')).toHaveLength(1);
  });

  it('does not retry once the user has stopped', async () => {
    const controller = new AbortController();
    const { agent, conversation, sleep } = setup([
      async () => {
        controller.abort();
        throw httpError(503);
      },
      { text: 'never' },
    ]);

    await expect(agent.send({ text: 'go' }, controller.signal)).rejects.toThrow('HTTP 503');
    expect(conversation.turns).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('Agent: streaming and usage', () => {
  it('routes streamed text, thinking and restarts to one message id', async () => {
    const { agent, events } = setup([
      async (request) => {
        request.callbacks.onThinking?.('hmm');
        request.callbacks.onText('draft');
        request.callbacks.onRestart?.();
        // The scripted conversation streams the returned text after this step, as the final delta.
        return { text: 'final' };
      },
    ]);
    await agent.send({ text: 'go' }, new AbortController().signal);

    const start = eventsOf(events, 'assistant-start')[0]!;
    expect(events.filter((event) => event.type !== 'usage')).toEqual([
      { type: 'assistant-start', id: start.id },
      { type: 'thinking-delta', id: start.id, text: 'hmm' },
      { type: 'assistant-delta', id: start.id, text: 'draft' },
      { type: 'assistant-restart', id: start.id },
      { type: 'assistant-delta', id: start.id, text: 'final' },
      { type: 'assistant-end', id: start.id, text: 'final' },
    ]);
  });

  it('adds up usage over the turns of a task and emits the running totals', async () => {
    const look = tool('look', () => ({ content: 'ok' }));
    const { agent, events } = setup(
      [
        {
          toolCalls: [call('t1', 'look')],
          usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 },
          contextTokens: 15,
        },
        { text: 'done', usage: { inputTokens: 20, outputTokens: 3, cacheReadTokens: 6 }, contextTokens: 26 },
      ],
      { tools: [look] },
    );
    await agent.send({ text: 'go' }, new AbortController().signal);

    // contextTokens is the size of the last prompt (20 input + 6 cache reads), not a running total.
    const expected = { inputTokens: 30, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 1, contextTokens: 26 };
    expect(agent.totals).toEqual(expected);
    expect(eventsOf(events, 'usage').map((event) => event.totals.inputTokens)).toEqual([10, 30]);
    // Totals are copies, so callers cannot change the running count.
    agent.totals.inputTokens = 999;
    expect(agent.totals).toEqual(expected);
  });
});

describe('Agent: provider continuation usage', () => {
  it.each(['pause_turn', 'compaction'])(
    'keeps final context separate from billable input after %s',
    async (stopReason) => {
      const server = new MockApiServer();
      const baseURL = await server.start();
      try {
        for (const [inputTokens, reason] of [
          [140_000, stopReason],
          [40_000, 'end_turn'],
        ] as const) {
          const stream = anthropicStream([{ type: 'text', text: 'part' }], reason);
          const start = stream.find((event) => event.event === 'message_start')!.data as {
            message: {
              usage: { input_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
            };
          };
          Object.assign(start.message.usage, {
            input_tokens: inputTokens,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          });
          server.queueSse(stream);
        }
        const events: ChatEvent[] = [];
        const agent = new Agent({
          conversation: new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
            model: 'claude-opus-5-5',
            effort: 'high',
          }),
          system: 'sys',
          tools: () => [],
          approvalMode: () => 'auto',
          requestApproval: async () => ({ approved: true }),
          toolContext: () => {
            throw new Error('No tools in this turn');
          },
          emit: (event) => events.push(event),
        });
        await agent.send({ text: 'Continue' }, new AbortController().signal);

        expect(agent.totals).toMatchObject({ inputTokens: 180_000, contextTokens: 40_000 });
        expect(eventsOf(events, 'usage').at(-1)?.totals).toMatchObject({ inputTokens: 180_000, contextTokens: 40_000 });
      } finally {
        await server.stop();
      }
    },
  );
});
