import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatEvent, UsageTotals } from '@shared/chat';
import type { ApprovalMode } from '@shared/settings';
import type {
  CompactionPlan,
  CompletionClient,
  Conversation,
  ToolResult,
  TurnRequest,
  TurnResult,
  UserInput,
} from '../llm/types';
import { defineTool, type AgentTool, type ToolContext } from '../tools/types';
import { ChatSession, type ChatSessionOptions } from './session';

type Step = Partial<TurnResult> | ((request: TurnRequest) => Promise<Partial<TurnResult>>);

class ScriptedConversation implements Conversation {
  readonly provider: 'anthropic' | 'openai';
  readonly model = 'test-model';
  readonly users: UserInput[] = [];
  readonly toolResults: ToolResult[][] = [];
  turns = 0;
  // Simulates a chat saved mid-task: the history ends with tool calls that have no results.
  pending = false;

  constructor(
    private readonly steps: Step[],
    provider: 'anthropic' | 'openai' = 'anthropic',
  ) {
    this.provider = provider;
  }

  addUserMessage(input: UserInput): void {
    this.users.push(input);
  }

  addToolResults(results: ToolResult[]): void {
    this.toolResults.push(results);
    this.pending = false;
  }

  hasPendingToolCalls(): boolean {
    return this.pending;
  }

  async runTurn(request: TurnRequest): Promise<TurnResult> {
    const step = this.steps[this.turns++];
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

  // Compaction: what the plan is, and what was applied.
  plan: CompactionPlan | null = null;
  readonly applied: Array<{ summary: string; keepFrom: number }> = [];

  planCompaction(): CompactionPlan | null {
    return this.plan;
  }

  applyCompaction(summary: string, keepFrom: number): void {
    this.applied.push({ summary, keepFrom });
  }
}

const ran: string[] = [];

const lookTool = defineTool({
  name: 'look',
  description: 'read-only',
  schema: z.object({ what: z.string() }),
  requiresApproval: false,
  async run({ what }) {
    ran.push(`look:${what}`);
    return { content: `saw ${what}`, summary: `Looked at ${what}` };
  },
});

const changeTool = defineTool({
  name: 'change',
  description: 'needs approval',
  schema: z.object({ to: z.string() }),
  requiresApproval: true,
  async preview({ to }) {
    return { title: `Change to ${to}`, diff: `+${to}` };
  },
  async run({ to }) {
    ran.push(`change:${to}`);
    return { content: `changed to ${to}` };
  },
});

// A model turn that hangs until the user stops the task, then fails the way an aborted request does.
const abortingTurn: Step = (request) =>
  new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });

function setup(
  steps: Step[],
  {
    mode = 'ask' as ApprovalMode,
    tools = () => [lookTool, changeTool] as AgentTool[],
    isPreApproved = undefined as ((toolName: string, input: unknown) => boolean) | undefined,
    usage = undefined as UsageTotals | undefined,
    provider = 'anthropic' as 'anthropic' | 'openai',
    officialPricing = undefined as boolean | undefined,
    resumable = undefined as boolean | undefined,
    transcript = undefined as ChatSessionOptions['transcript'],
    readFiles = undefined as string[] | undefined,
    pendingNotes = undefined as string[] | undefined,
    smallModel = (() => null) as ChatSessionOptions['smallModel'],
    onEditApplied = undefined as ChatSessionOptions['onEditApplied'],
    pending = false,
  } = {},
) {
  ran.length = 0;
  const conversation = new ScriptedConversation(steps, provider);
  conversation.pending = pending;
  const events: ChatEvent[] = [];
  const saves: boolean[] = [];
  const session = new ChatSession({
    projectPath: '/project',
    conversation,
    officialPricing,
    system: 'system prompt',
    agentFile: null,
    tools,
    usage,
    resumable,
    transcript,
    readFiles,
    pendingNotes,
    approvalMode: () => mode,
    isPreApproved,
    toolContext: (base) =>
      ({
        ...base,
        workspace: null as never,
        shell: null as never,
        browser: null,
        codeSearch: null,
        webSearch: null,
      }) as ToolContext,
    smallModel,
    onEditApplied,
    onEvent: (event) => events.push(event),
    onChange: (immediate) => saves.push(immediate),
  });
  const nextApproval = () =>
    new Promise<string>((resolve) => {
      const check = () => {
        const pending = session
          .snapshot()
          .transcript.find((item) => item.kind === 'tool' && item.status === 'awaiting-approval');
        if (pending) resolve(pending.id);
        else setTimeout(check, 5);
      };
      check();
    });
  return { conversation, session, events, saves, nextApproval };
}

describe('agent loop', () => {
  it('answers without tools', async () => {
    const { session } = setup([{ text: 'Hello!' }]);
    await session.send({ text: 'hi' });
    const kinds = session.snapshot().transcript.map((item) => [item.kind, 'text' in item ? item.text : '']);
    expect(kinds).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello!'],
    ]);
    expect(session.busy).toBe(false);
  });

  it('runs read-only tools without approval and feeds results back', async () => {
    const { session, conversation } = setup([
      { text: 'Looking', toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] },
      { text: 'Done' },
    ]);
    await session.send({ text: 'go' });
    expect(ran).toEqual(['look:a']);
    expect(conversation.toolResults).toEqual([[{ id: 't1', content: 'saw a', isError: undefined, images: undefined }]]);
    const tool = session.snapshot().transcript.find((item) => item.kind === 'tool');
    expect(tool).toMatchObject({ status: 'done', summary: 'Looked at a' });
  });

  it('runs a call the user allowed in advance without asking, and still asks for the others', async () => {
    const { session, events } = setup(
      [{ toolCalls: [{ id: 't1', name: 'change', input: { to: 'allowed' } }] }, { text: 'ok' }],
      { isPreApproved: (name, input) => name === 'change' && (input as { to: string }).to === 'allowed' },
    );
    await session.send({ text: 'go' });
    expect(ran).toEqual(['change:allowed']);
    const start = events.find((event) => event.type === 'tool-start');
    expect(start).toMatchObject({ awaitingApproval: false, preview: { title: 'Change to allowed' } });
  });

  it('waits for approval and shows a preview', async () => {
    const { session, nextApproval } = setup([
      { toolCalls: [{ id: 't1', name: 'change', input: { to: 'x' } }] },
      { text: 'ok' },
    ]);
    const sending = session.send({ text: 'change it' });
    const id = await nextApproval();
    const pending = session.snapshot().transcript.find((item) => item.id === id);
    expect(pending).toMatchObject({ preview: { title: 'Change to x', diff: '+x' } });
    expect(ran).toEqual([]);

    session.decide(id, { approved: true });
    await sending;
    expect(ran).toEqual(['change:x']);
  });

  it('stops when the user declines without feedback, and skips remaining calls', async () => {
    const { session, conversation, nextApproval } = setup([
      {
        toolCalls: [
          { id: 't1', name: 'change', input: { to: 'x' } },
          { id: 't2', name: 'look', input: { what: 'b' } },
        ],
      },
    ]);
    const sending = session.send({ text: 'change it' });
    session.decide(await nextApproval(), { approved: false });
    await sending;

    expect(ran).toEqual([]);
    expect(conversation.turns).toBe(1);
    expect(conversation.toolResults[0]!.map((result) => [result.id, result.isError])).toEqual([
      ['t1', true],
      ['t2', true],
    ]);
  });

  it('continues with the user feedback when declining with a note', async () => {
    const { session, conversation, nextApproval } = setup([
      { toolCalls: [{ id: 't1', name: 'change', input: { to: 'x' } }] },
      { text: 'Understood, using y instead.' },
    ]);
    const sending = session.send({ text: 'change it' });
    session.decide(await nextApproval(), { approved: false, feedback: 'use y' });
    await sending;

    expect(conversation.turns).toBe(2);
    expect(conversation.toolResults[0]![0]!.content).toContain('use y');
  });

  it('skips approval in auto mode', async () => {
    const { session } = setup([{ toolCalls: [{ id: 't1', name: 'change', input: { to: 'z' } }] }, { text: 'done' }], {
      mode: 'auto',
    });
    await session.send({ text: 'go' });
    expect(ran).toEqual(['change:z']);
  });

  it('rejects invalid tool input without running the tool', async () => {
    const { session, conversation } = setup([
      { toolCalls: [{ id: 't1', name: 'look', input: { what: 42 } }] },
      { text: 'retrying' },
    ]);
    await session.send({ text: 'go' });
    expect(ran).toEqual([]);
    expect(conversation.toolResults[0]![0]!).toMatchObject({ isError: true });
    expect(conversation.toolResults[0]![0]!.content).toContain('Invalid input for look');
  });

  it('names missing fields and the fields that were received', async () => {
    const { session, conversation } = setup([
      { toolCalls: [{ id: 't1', name: 'change', input: {} }] },
      { text: 'retrying' },
    ]);
    await session.send({ text: 'go' });
    const content = conversation.toolResults[0]![0]!.content;
    expect(content).toContain('required but missing');
    expect(content).toContain('Received fields: (none)');
  });

  it('does not run tool calls from a response cut off at the output limit', async () => {
    const { session, conversation } = setup([
      { stopReason: 'max_tokens', toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] },
      { text: 'smaller' },
    ]);
    await session.send({ text: 'go' });
    expect(ran).toEqual([]);
    expect(conversation.toolResults[0]![0]!.content).toContain('output limit');
  });

  it('answers every pending call when stopped during approval', async () => {
    const { session, conversation, nextApproval } = setup([
      {
        toolCalls: [
          { id: 't1', name: 'change', input: { to: 'x' } },
          { id: 't2', name: 'look', input: { what: 'b' } },
        ],
      },
    ]);
    const sending = session.send({ text: 'go' });
    await nextApproval();
    session.stop();
    await sending;

    expect(conversation.toolResults[0]).toHaveLength(2);
    expect(session.busy).toBe(false);
    expect(ran).toEqual([]);
  });

  it('resumes after stopping during approval without rerunning the saved calls or duplicating the user message', async () => {
    const { session, conversation, nextApproval } = setup([
      {
        toolCalls: [
          { id: 't1', name: 'change', input: { to: 'x' } },
          { id: 't2', name: 'look', input: { what: 'b' } },
        ],
      },
      { text: 'Continued safely.' },
    ]);
    const sending = session.send({ text: 'change it' });
    await nextApproval();
    session.stop();
    await sending;

    expect(session.snapshot().resumable).toBe(true);
    expect(conversation.toolResults[0]).toHaveLength(2);
    await session.resume();

    expect(ran).toEqual([]);
    expect(conversation.users).toHaveLength(2);
    expect(conversation.users[0]!.text).toBe('change it');
    expect(conversation.users[1]!.text).toContain('inspect the current state');
    expect(session.snapshot().transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(session.snapshot().resumable).toBe(false);
  });

  it('does not offer resume when a stop arrives as the run finishes on its own', async () => {
    let stopNow = () => {};
    const { session } = setup([
      async () => {
        stopNow();
        return { text: 'Done.' };
      },
    ]);
    stopNow = () => session.stop();
    await session.send({ text: 'hi' });
    expect(session.snapshot().resumable).toBe(false);
  });

  it('resumes an aborted streaming turn and prevents simultaneous or duplicate resumes', async () => {
    const { session, conversation } = setup([
      (request) =>
        new Promise((_resolve, reject) => {
          request.callbacks.onText('partial');
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { text: 'finished' };
      },
    ]);
    const sending = session.send({ text: 'start once' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.stop();
    await sending;

    const resuming = session.resume();
    await expect(session.resume()).rejects.toThrow(/still working/);
    await resuming;
    await expect(session.resume()).rejects.toThrow(/no stopped run/);
    expect(conversation.users.map((user) => user.text).filter((text) => text === 'start once')).toHaveLength(1);
  });

  it('persists resumable state for a reopened chat', async () => {
    const first = setup([
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        ),
    ]);
    const sending = first.session.send({ text: 'pause me' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    first.session.stop();
    await sending;
    const saved = first.session.serialize();

    const reopened = setup([{ text: 'continued after reopen' }], {
      resumable: saved.resumable,
      transcript: saved.transcript,
    });
    expect(reopened.session.snapshot().resumable).toBe(true);
    await reopened.session.resume();
    expect(reopened.session.snapshot().transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
  });

  it('shows a notice, not an error, when a stop aborts the model call', async () => {
    const { session } = setup([abortingTurn]);
    const sending = session.send({ text: 'go' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.stop();
    await sending;

    const transcript = session.snapshot().transcript;
    expect(transcript.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped.' });
    expect(transcript.some((item) => item.kind === 'error')).toBe(false);
    expect(session.busy).toBe(false);
  });

  it('resumes after stopping a running tool: skipped calls stay skipped and every call has one result', async () => {
    const started: string[] = [];
    const slowTool = defineTool({
      name: 'slow',
      description: 'runs until stopped',
      schema: z.object({}),
      requiresApproval: false,
      run: (_input, context) =>
        new Promise((resolve) => {
          started.push('slow');
          context.signal.addEventListener('abort', () => resolve({ content: 'interrupted', isError: true }));
        }),
    });
    const { session, conversation } = setup(
      [
        {
          toolCalls: [
            { id: 't1', name: 'slow', input: {} },
            { id: 't2', name: 'look', input: { what: 'b' } },
          ],
        },
        { text: 'Carried on' },
      ],
      { tools: () => [slowTool, lookTool] },
    );
    const sending = session.send({ text: 'go' });
    while (started.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    session.stop();
    await sending;

    expect(session.snapshot().resumable).toBe(true);
    expect(conversation.toolResults[0]).toMatchObject([
      { id: 't1', content: 'interrupted', isError: true },
      { id: 't2', content: 'Not run: the user stopped the task.', isError: true },
    ]);

    await session.resume();
    expect(started).toEqual(['slow']);
    expect(ran).toEqual([]);
    expect(conversation.turns).toBe(2);
    expect(session.snapshot().resumable).toBe(false);
    expect(session.snapshot().transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Carried on' });
  });

  it('drops the resumable state when a new message is sent after a stop', async () => {
    const { session, conversation } = setup([abortingTurn, { text: 'fresh start' }]);
    const sending = session.send({ text: 'first' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    session.stop();
    await sending;
    expect(session.snapshot().resumable).toBe(true);

    await session.send({ text: 'second' });
    expect(session.snapshot().resumable).toBe(false);
    expect(conversation.users.map((user) => user.text)).toEqual(['first', 'second']);
    await expect(session.resume()).rejects.toThrow(/no stopped run/);
  });

  it('does not offer resume after a model error', async () => {
    const { session } = setup([
      async () => {
        throw new Error('500 server error');
      },
    ]);
    await session.send({ text: 'go' });
    expect(session.snapshot().resumable).toBe(false);
    await expect(session.resume()).rejects.toThrow(/no stopped run/);
  });

  it('ignores stop when nothing is running', () => {
    const { session, events } = setup([]);
    session.stop();
    expect(events).toEqual([]);
    expect(session.snapshot()).toMatchObject({ busy: false, resumable: false });
  });

  describe('undoing an edit', () => {
    const seenAsRead: boolean[] = [];
    // Edits /abs/a.ts (and so reads it), or reports whether the session still counts it as read.
    const fileTool = defineTool({
      name: 'file',
      description: 'edits or probes',
      schema: z.object({ probe: z.boolean().optional() }),
      requiresApproval: false,
      async run({ probe }, context) {
        if (probe) {
          seenAsRead.push(context.readFiles.has('/abs/a.ts'));
          return { content: 'probed' };
        }
        context.readFiles.add('/abs/a.ts');
        return {
          content: 'Edited',
          path: 'src/a.ts',
          undo: { path: 'src/a.ts', before: Buffer.from('old'), afterHash: 'h' },
        };
      },
    });
    const edited = () => {
      seenAsRead.length = 0;
      const kept: string[] = [];
      const made = setup(
        [
          { toolCalls: [{ id: 't1', name: 'file', input: {} }] },
          { text: 'Edited it.' },
          { toolCalls: [{ id: 't2', name: 'file', input: { probe: true } }] },
          { text: 'Probed.' },
          { text: 'Again.' },
        ],
        { tools: () => [fileTool], mode: 'auto', onEditApplied: (toolId) => kept.push(toolId) },
      );
      return { ...made, kept };
    };
    const restored = { path: 'src/a.ts', action: 'restored' as const };

    it('marks the card of the edit as undone and saves the chat', async () => {
      const { session, events, kept } = edited();
      await session.send({ text: 'edit it' });

      expect(kept).toHaveLength(1);
      const editId = kept[0]!;
      expect(session.snapshot().transcript.find((item) => item.id === editId)).toMatchObject({ undo: 'available' });
      session.editUndone(editId, restored, '/abs/a.ts');

      expect(session.snapshot().transcript.find((item) => item.id === editId)).toMatchObject({ undo: 'undone' });
      expect(events.at(-1)).toEqual({ type: 'tool-undone', id: editId });
      expect(session.serialize().transcript.find((item) => item.id === editId)).toMatchObject({ undo: 'undone' });
    });

    it('tells the model with the next message, once, and shows the user only what they typed', async () => {
      const { session, conversation, kept } = edited();
      await session.send({ text: 'edit it' });
      session.editUndone(kept[0]!, restored, '/abs/a.ts');

      await session.send({ text: 'now what?' });
      await session.send({ text: 'and then?' });

      expect(conversation.users[0]!.text).toBe('edit it');
      expect(conversation.users[1]!.text).toBe(
        '[Note from the app: The user undid your edit to src/a.ts: the file is back to how it was before that edit. Read it again before editing it.]\n\nnow what?',
      );
      expect(conversation.users[2]!.text).toBe('and then?');
      const shown = session
        .snapshot()
        .transcript.filter((item) => item.kind === 'user')
        .map((item) => item.text);
      expect(shown).toEqual(['edit it', 'now what?', 'and then?']);
    });

    it('says that a created file was deleted, and lists several undos together', async () => {
      const { session, conversation, kept } = edited();
      await session.send({ text: 'edit it' });
      session.editUndone(kept[0]!, { path: 'src/new.ts', action: 'deleted' }, '/abs/new.ts');
      session.editUndone(kept[0]!, restored, '/abs/a.ts');
      await session.send({ text: 'go on' });

      expect(conversation.users[1]!.text).toContain(
        'The user undid your creation of src/new.ts: the file was deleted.',
      );
      expect(conversation.users[1]!.text).toContain('The user undid your edit to src/a.ts');
      expect(conversation.users[1]!.text.endsWith('go on')).toBe(true);
    });

    it('makes the model read the file again: it no longer counts as read', async () => {
      const { session, kept } = edited();
      await session.send({ text: 'edit it' });
      session.editUndone(kept[0]!, restored, '/abs/a.ts');
      await session.send({ text: 'probe' });

      expect(seenAsRead).toEqual([false]);
    });

    it('persists pending undo notes through JSON and consumes them only once', async () => {
      const { session, kept } = edited();
      await session.send({ text: 'edit it' });
      session.editUndone(kept[0]!, { path: 'src/new.ts', action: 'deleted' }, '/abs/new.ts');
      session.editUndone(kept[0]!, restored, '/abs/a.ts');

      const saved = JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ChatSession['serialize']>;
      expect(saved.pendingNotes).toHaveLength(2);
      expect(saved.readFiles).not.toContain('/abs/a.ts');
      const reopened = setup([{ text: 'Continued.' }], {
        pendingNotes: saved.pendingNotes,
        readFiles: saved.readFiles,
      });
      saved.pendingNotes?.push('This must not alias the reopened session.');

      await reopened.session.send({ text: 'continue' });
      expect(reopened.conversation.users[0]!.text).toContain('The user undid your creation of src/new.ts');
      expect(reopened.conversation.users[0]!.text).toContain('The user undid your edit to src/a.ts');
      expect(reopened.conversation.users[0]!.text).not.toContain('must not alias');
      const consumed = JSON.parse(JSON.stringify(reopened.session.serialize())) as ReturnType<ChatSession['serialize']>;
      expect(consumed.pendingNotes).toEqual([]);

      const reloaded = setup([{ text: 'Again.' }], { pendingNotes: consumed.pendingNotes });
      await reloaded.session.send({ text: 'next' });
      expect(reloaded.conversation.users[0]!.text).toBe('next');
    });

    it('loads old saves without pending notes', async () => {
      const reopened = setup([{ text: 'Done.' }], { pendingNotes: undefined });
      await reopened.session.send({ text: 'continue' });
      expect(reopened.conversation.users[0]!.text).toBe('continue');
      expect(reopened.session.serialize().pendingNotes).toEqual([]);
    });

    it('also tells the model when the stopped task is resumed', async () => {
      const kept: string[] = [];
      const { session, conversation } = setup(
        [
          { toolCalls: [{ id: 't1', name: 'file', input: {} }] },
          { text: 'Edited.' },
          abortingTurn,
          { text: 'Continued.' },
        ],
        { tools: () => [fileTool], mode: 'auto', onEditApplied: (toolId) => kept.push(toolId) },
      );
      await session.send({ text: 'edit it' });
      const sending = session.send({ text: 'start' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      session.stop();
      await sending;

      session.editUndone(kept[0]!, restored, '/abs/a.ts');
      await session.resume();

      expect(conversation.users[2]!.text).toMatch(
        /^\[Note from the app: The user undid your edit to src\/a\.ts[^\]]*\]\n\nContinue the task/,
      );
    });
  });

  describe('compacting the chat', () => {
    const plan: CompactionPlan = { text: 'OLD TURNS AS TEXT', messages: 7, keepFrom: 3 };
    // Answers the compaction request; the chat title request that starts every chat is left to fail and fall back.
    const summarizer = (
      handler: (prompt: string, signal?: AbortSignal) => Promise<{ summary: string }>,
    ): CompletionClient => ({
      complete: ((prompt: string, _schema: unknown, signal?: AbortSignal) =>
        prompt.startsWith('Summarize the earlier part')
          ? handler(prompt, signal)
          : Promise.reject(new Error('no title'))) as CompletionClient['complete'],
    });

    it('summarizes the older turns, applies the summary and says so in the chat', async () => {
      const prompts: string[] = [];
      const { session, conversation, events } = setup([{ text: 'hello' }], {
        smallModel: () =>
          summarizer(async (prompt) => {
            prompts.push(prompt);
            return { summary: 'THE SUMMARY' };
          }),
      });
      await session.send({ text: 'hi' });
      conversation.plan = plan;
      // The scripted turn read 1 input token and no cache, so that is how large the prompt was.
      expect(session.snapshot().usage.contextTokens).toBe(1);

      await session.compact();

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('OLD TURNS AS TEXT');
      expect(conversation.applied).toEqual([{ summary: 'THE SUMMARY', keepFrom: 3 }]);
      expect(session.snapshot().transcript.at(-1)).toMatchObject({
        kind: 'notice',
        text: expect.stringContaining('Compacted 7 earlier messages'),
      });
      // The size of the prompt is not known until the next request.
      expect(session.snapshot().usage.contextTokens).toBeUndefined();
      expect(events.filter((event) => event.type === 'busy').slice(-2)).toEqual([
        { type: 'busy', busy: true },
        { type: 'busy', busy: false },
      ]);
      expect(session.busy).toBe(false);
    });

    it('says so when there is not enough history, without calling the model', async () => {
      const complete = vi.fn();
      const { session, conversation } = setup([], { smallModel: () => ({ complete }) as unknown as CompletionClient });

      await session.compact();

      expect(complete).not.toHaveBeenCalled();
      expect(conversation.applied).toEqual([]);
      expect(session.snapshot().transcript.at(-1)).toMatchObject({
        kind: 'notice',
        text: expect.stringContaining('not enough older history'),
      });
    });

    it('asks for an API key when there is no model to summarize with', async () => {
      const { session, conversation } = setup([]);
      conversation.plan = plan;

      await expect(session.compact()).rejects.toThrow(/API key/);
      expect(conversation.applied).toEqual([]);
      expect(session.busy).toBe(false);
    });

    it('shows the error and changes nothing when the summary fails', async () => {
      const { session, conversation } = setup([], {
        smallModel: () => summarizer(async () => Promise.reject(new Error('529 overloaded'))),
      });
      conversation.plan = plan;

      await session.compact();

      expect(conversation.applied).toEqual([]);
      expect(session.snapshot().transcript.at(-1)).toMatchObject({
        kind: 'error',
        text: 'Compacting failed: 529 overloaded',
      });
      expect(session.busy).toBe(false);
    });

    it('can be stopped, and then applies nothing even if the summary still arrives', async () => {
      let finish!: (value: { summary: string }) => void;
      const { session, conversation } = setup([], {
        smallModel: () => summarizer(() => new Promise((resolve) => (finish = resolve))),
      });
      conversation.plan = plan;

      const compacting = session.compact();
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(session.busy).toBe(true);
      session.stop();
      finish({ summary: 'TOO LATE' });
      await compacting;

      expect(conversation.applied).toEqual([]);
      expect(session.snapshot().transcript.at(-1)).toMatchObject({
        kind: 'notice',
        text: expect.stringContaining('unchanged'),
      });
      expect(session.snapshot().resumable).toBe(false);
      expect(session.busy).toBe(false);
    });

    it('blocks messages and a second compaction while it runs', async () => {
      let finish!: (value: { summary: string }) => void;
      const { session, conversation } = setup([{ text: 'hello' }], {
        smallModel: () => summarizer(() => new Promise((resolve) => (finish = resolve))),
      });
      conversation.plan = plan;

      const compacting = session.compact();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(session.send({ text: 'hi' })).rejects.toThrow(/still working/);
      await expect(session.compact()).rejects.toThrow(/still working/);
      finish({ summary: 'S' });
      await compacting;

      expect(conversation.applied).toHaveLength(1);
    });
  });

  it('shows model errors in the transcript', async () => {
    const { session } = setup([
      async () => {
        throw new Error('401 invalid x-api-key');
      },
    ]);
    await session.send({ text: 'go' });
    const last = session.snapshot().transcript.at(-1);
    expect(last).toMatchObject({ kind: 'error', text: '401 invalid x-api-key' });
    expect(session.busy).toBe(false);
  });

  it('reports refusals as a notice', async () => {
    const { session } = setup([{ stopReason: 'refusal', refusal: 'Declined for safety.' }]);
    await session.send({ text: 'go' });
    expect(session.snapshot().transcript.at(-1)).toMatchObject({ kind: 'notice', text: 'Declined for safety.' });
  });

  it('keeps streamed text when a turn fails midway', async () => {
    const { session } = setup([
      async (request) => {
        request.callbacks.onText('partial answer');
        throw new Error('connection reset');
      },
    ]);
    await session.send({ text: 'go' });
    const assistant = session.snapshot().transcript.find((item) => item.kind === 'assistant');
    expect(assistant).toMatchObject({ text: 'partial answer', streaming: false });
  });

  it('refuses a second message while busy', async () => {
    const { session, nextApproval } = setup([{ toolCalls: [{ id: 't1', name: 'change', input: { to: 'x' } }] }]);
    const sending = session.send({ text: 'first' });
    await nextApproval();
    await expect(session.send({ text: 'second' })).rejects.toThrow(/still working/);
    session.stop();
    await sending;
  });

  it('offers tools that become available while the chat is open', async () => {
    let available: AgentTool[] = [lookTool];
    const offered: string[][] = [];
    const record = (request: TurnRequest, result: Partial<TurnResult>) => {
      offered.push(request.tools.map((tool) => tool.name));
      return Promise.resolve(result);
    };
    const { session } = setup(
      [(request) => record(request, { text: 'one' }), (request) => record(request, { text: 'two' })],
      { tools: () => available },
    );
    await session.send({ text: 'first' });
    available = [lookTool, changeTool];
    await session.send({ text: 'second' });
    expect(offered).toEqual([['look'], ['look', 'change']]);
  });

  it('runs a tool added mid-chat within the same task', async () => {
    let available: AgentTool[] = [lookTool];
    const { session } = setup(
      [
        () => {
          available = [lookTool, changeTool];
          return Promise.resolve({ toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] });
        },
        { toolCalls: [{ id: 't2', name: 'change', input: { to: 'x' } }] },
        { text: 'done' },
      ],
      { mode: 'auto', tools: () => available },
    );
    await session.send({ text: 'go' });
    expect(ran).toEqual(['look:a', 'change:x']);
  });

  it('serializes and tracks usage', async () => {
    const { session } = setup([
      {
        text: 'a',
        contextTokens: 12,
        usage: {
          inputTokens: 7,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          longContext: true,
        },
      },
    ]);
    await session.send({ text: 'hi' });
    const saved = session.serialize();
    expect(saved.usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      // 7 input + 3 cache reads + 2 cache writes: the size of the prompt that was sent.
      contextTokens: 12,
      longContext: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 },
    });
    expect(saved.system).toBe('system prompt');
    expect(saved.transcript).toHaveLength(2);
  });

  it('restores legacy saved usage without cache writes', () => {
    const { session } = setup([], { usage: { inputTokens: 7, outputTokens: 5, cacheReadTokens: 3 } });
    expect(session.snapshot().usage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });

  it('normalizes legacy OpenAI input exactly once and suppresses custom endpoint pricing', () => {
    const { session } = setup([], {
      provider: 'openai',
      officialPricing: false,
      usage: { inputTokens: 17, outputTokens: 5, cacheReadTokens: 3 },
    });
    expect(session.snapshot().usage.inputTokens).toBe(14);
    expect(session.snapshot().officialPricing).toBe(false);
    const restored = setup([], { provider: 'openai', usage: session.serialize().usage });
    expect(restored.session.snapshot().usage.inputTokens).toBe(14);
  });

  it('accumulates multiple long requests without mutating earlier snapshots', async () => {
    const usage = {
      inputTokens: 280_000,
      outputTokens: 17,
      cacheReadTokens: 3,
      cacheWriteTokens: 5,
      longContext: true,
    };
    const { session } = setup([
      { text: 'first', usage },
      { text: 'second', usage },
    ]);
    await session.send({ text: 'one' });
    const first = session.snapshot();
    await session.send({ text: 'two' });
    expect(first.usage.longContext?.inputTokens).toBe(280_000);
    expect(session.snapshot().usage.longContext?.inputTokens).toBe(560_000);
  });
});

describe('crash recovery', () => {
  it('saves a checkpoint immediately after every tool-result batch', async () => {
    const { session, saves } = setup([
      { toolCalls: [{ id: 't1', name: 'look', input: { what: 'a' } }] },
      { toolCalls: [{ id: 't2', name: 'look', input: { what: 'b' } }] },
      { text: 'done' },
    ]);
    await session.send({ text: 'go' });
    // Two checkpoints (one per tool batch) plus the immediate save when the run finishes.
    expect(saves.filter((immediate) => immediate)).toHaveLength(3);
  });

  it('treats a conversation with unanswered tool calls as resumable', async () => {
    const { session } = setup([{ text: 'Continued.' }], { pending: true });
    expect(session.snapshot().resumable).toBe(true);

    await session.resume();
    expect(session.snapshot().resumable).toBe(false);
  });

  it('marks tool rows left unfinished by a crash as interrupted', () => {
    const { session } = setup([{ text: 'ok' }], {
      transcript: [
        { kind: 'user', id: 'u1', text: 'go', imageCount: 0 },
        { kind: 'tool', id: 't1', name: 'look', status: 'running' },
      ],
    });
    const tool = session.snapshot().transcript.find((item) => item.kind === 'tool');
    expect(tool).toMatchObject({ status: 'error', summary: 'look was interrupted' });
  });
});
