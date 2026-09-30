import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { TurnResult, UserInput } from '../llm/types';
import type { Conversation, ToolResult } from '../llm/types';
import { defineTool, type ToolContext } from './types';
import { createTaskTool } from './task';

type Step = Partial<TurnResult>;

// Same idea as the agent loop tests: a conversation that replays scripted turns.
class ScriptedConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'test-model';
  readonly users: UserInput[] = [];
  turns = 0;

  constructor(private readonly steps: Step[]) {}

  addUserMessage(input: UserInput): void {
    this.users.push(input);
  }

  addToolResults(results: ToolResult[]): void {
    this.toolResults.push(results);
  }

  toolResults: ToolResult[][] = [];

  hasPendingToolCalls(): boolean {
    return false;
  }

  planCompaction() {
    return null;
  }

  applyCompaction(): void {}

  async runTurn(): Promise<TurnResult> {
    const step = this.steps[this.turns++];
    if (!step) throw new Error('unexpected extra turn');
    return {
      text: '',
      toolCalls: [],
      contextTokens: 0,
      stopReason: step.toolCalls?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0 },
      ...step,
    };
  }

  serialize() {
    return { provider: this.provider, model: this.model, messages: [] };
  }
}

describe('task tool (subagent)', () => {
  it('runs a read-only subagent and returns its answer with usage', async () => {
    const ran: string[] = [];
    const readTool = defineTool({
      name: 'read_file',
      description: 'read',
      schema: z.object({ path: z.string() }),
      requiresApproval: false,
      async run({ path }) {
        ran.push(`read:${path}`);
        return { content: 'file contents', summary: `Read ${path}` };
      },
    });
    // Must never run: the subagent only gets the read-only subset.
    const writeTool = defineTool({
      name: 'write_file',
      description: 'write',
      schema: z.object({ path: z.string(), content: z.string() }),
      requiresApproval: true,
      async run() {
        ran.push('write');
        return { content: 'written' };
      },
    });
    const taskTool = createTaskTool({
      createConversation: () =>
        new ScriptedConversation([
          { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'a.ts' } }] },
          { text: 'The answer is 42.' },
        ]),
      system: 'system prompt',
      tools: () => [readTool, writeTool],
    });

    const progress: string[] = [];
    const context = {
      signal: new AbortController().signal,
      onProgress: (text: string) => progress.push(text),
    } as never as ToolContext;
    const output = await taskTool.run({ task: 'Find the answer in a.ts' }, context);

    expect(ran).toEqual(['read:a.ts']);
    expect(output.content).toContain('The answer is 42.');
    expect(output.content).toContain('Subagent token usage: 4 in / 2 out');
    expect(output.isError).toBe(false);
    expect(output.summary).toContain('Find the answer in a.ts');
    // The nested run streamed its progress into the parent transcript.
    expect(progress).toContain('[done] Read a.ts');
    expect(progress).toContain('The answer is 42.');
  });

  it('reports an error result when the subagent returns no answer', async () => {
    const taskTool = createTaskTool({
      createConversation: () => new ScriptedConversation([{ text: '' }]),
      system: 'system prompt',
      tools: () => [],
    });
    const output = await taskTool.run({ task: 'Look around' }, {
      signal: new AbortController().signal,
      onProgress: () => {},
    } as never as ToolContext);
    expect(output.isError).toBe(true);
    expect(output.content).toContain('returned no answer');
  });
});
