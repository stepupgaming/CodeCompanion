import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicCompletionClient, AnthropicConversation, createAnthropicClient } from './anthropic';
import { anthropicStream, MockApiServer } from './test_server';
import type { ToolSpec, TurnRequest } from './types';

const readFileTool: ToolSpec = {
  name: 'read_file',
  description: 'Read a file',
  schema: z.object({ path: z.string() }),
};

function request(overrides: Partial<TurnRequest> = {}): TurnRequest & { streamed: string[] } {
  const streamed: string[] = [];
  return {
    system: 'You are a test.',
    tools: [readFileTool],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => streamed.push(delta) },
    streamed,
    ...overrides,
  };
}

describe('AnthropicConversation', () => {
  let server: MockApiServer;
  let baseURL: string;

  beforeEach(async () => {
    server = new MockApiServer();
    baseURL = await server.start();
  });

  afterEach(() => server.stop());

  it('streams text and returns tool calls', async () => {
    server.queueSse(
      anthropicStream(
        [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
        'tool_use',
      ),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });

    const req = request();
    const result = await conversation.runTurn(req);

    expect(req.streamed.join('')).toBe('Let me look.');
    expect(result.text).toBe('Let me look.');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 3 });
    expect(result.contextTokens).toBe(17);
  });

  it('sends current-model features: adaptive thinking, effort, compaction, fallback, caching, eager tool input', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'xhigh',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'xhigh' });
    expect(body.context_management).toEqual({ edits: [{ type: 'compact_20260112' }] });
    expect(body.fallbacks).toBe('default');
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.temperature).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.tools[0]).toMatchObject({
      name: 'read_file',
      eager_input_streaming: true,
      input_schema: { type: 'object', required: ['path'] },
    });
    expect(headers['anthropic-beta']).toContain('compact-2026-01-12');
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  });

  it('sends a plain request to models without those features', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-haiku-4-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'hi' });
    await conversation.runTurn(request());

    const { body, headers } = server.requests[0]!;
    expect(body.thinking).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.context_management).toBeUndefined();
    expect(body.fallbacks).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('keeps history append-only and sends all tool results in one user message', async () => {
    server.queueSse(
      anthropicStream(
        [
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: 'b' } },
        ],
        'tool_use',
      ),
    );
    server.queueSse(anthropicStream([{ type: 'text', text: 'done' }], 'end_turn'));

    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read both' });
    await conversation.runTurn(request());
    conversation.addToolResults([
      { id: 'toolu_1', content: 'A' },
      { id: 'toolu_2', content: 'missing', isError: true },
    ]);
    await conversation.runTurn(request());

    const second = server.requests[1]!.body.messages;
    expect(second).toHaveLength(3);
    // The assistant turn is sent back exactly as it was returned.
    expect(second[1].role).toBe('assistant');
    expect(second[1].content.map((block: any) => [block.type, block.id])).toEqual([
      ['tool_use', 'toolu_1'],
      ['tool_use', 'toolu_2'],
    ]);
    expect(second[2].role).toBe('user');
    expect(second[2].content.map((block: any) => [block.type, block.tool_use_id, block.is_error])).toEqual([
      ['tool_result', 'toolu_1', undefined],
      ['tool_result', 'toolu_2', true],
    ]);
    expect(conversation.serialize().messages).toHaveLength(4);
  });

  it('commits pause and compaction continuations together, preserving their blocks and usage', async () => {
    server.queueSse(anthropicStream([{ type: 'text', text: 'First part' }], 'pause_turn'));
    const compacted = anthropicStream([], 'compaction');
    const block = { type: 'compaction', content: 'Server summary' };
    compacted.splice(
      1,
      0,
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: block } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    );
    server.queueSse(compacted);
    server.queueSse(
      anthropicStream(
        [
          { type: 'text', text: 'Final part' },
          { type: 'tool_use', id: 'toolu_final', name: 'read_file', input: { path: 'final.ts' } },
        ],
        'tool_use',
      ),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Continue the task' });
    const before = structuredClone(conversation.serialize().messages);
    const result = await conversation.runTurn(
      request({
        callbacks: { onText: () => expect(conversation.serialize().messages).toEqual(before) },
      }),
    );

    // Compare to the actual response blocks sent back, without relying on SDK-added optional fields.
    expect(server.requests[1]!.body.messages).toMatchObject([
      ...before,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'First part' }],
      },
    ]);
    expect(server.requests[2]!.body.messages).toEqual([
      ...server.requests[1]!.body.messages,
      { role: 'assistant', content: [block] },
    ]);
    const saved = conversation.serialize().messages;
    expect(saved.slice(0, 3)).toEqual(server.requests[2]!.body.messages);
    expect(saved).toHaveLength(4);
    expect(result.text).toBe('First part\n\nFinal part');
    expect(result.toolCalls).toEqual([{ id: 'toolu_final', name: 'read_file', input: { path: 'final.ts' } }]);
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 21, cacheReadTokens: 12, cacheWriteTokens: 9 });
  });

  it.each(['pause_turn', 'compaction'])(
    'discards a %s prefix when its continuation fails, then retries cleanly',
    async (reason) => {
      server.queueSse(anthropicStream([{ type: 'text', text: 'Discard this prefix' }], reason));
      server.queueJson(529, { type: 'error', error: { type: 'overloaded_error', message: 'Try again' } });
      server.queueSse(anthropicStream([{ type: 'text', text: 'Fresh answer' }], 'end_turn'));
      const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      conversation.addUserMessage({ text: 'Keep this request' });
      const before = structuredClone(conversation.serialize());

      await expect(conversation.runTurn(request())).rejects.toThrow(/Try again/);
      expect(conversation.serialize()).toEqual(before);
      expect(server.requests[1]!.body.messages).toHaveLength(2);
      const result = await conversation.runTurn(request());
      expect(server.requests[2]!.body.messages).toEqual(server.requests[0]!.body.messages);
      expect(result.text).toBe('Fresh answer');
      expect(conversation.serialize().messages).toHaveLength(2);
      expect(JSON.stringify(conversation.serialize())).not.toContain('Discard this prefix');
    },
  );

  it.each(['pause_turn', 'compaction'])(
    'does not save a %s prefix when the continuation is aborted',
    async (reason) => {
      server.queueSse(anthropicStream([{ type: 'text', text: 'Unsaved prefix' }], reason));
      server.queueSse(anthropicStream([{ type: 'text', text: 'Cancel here' }], 'end_turn'));
      const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
        model: 'claude-opus-5-5',
        effort: 'high',
      });
      conversation.addUserMessage({ text: 'Keep this request' });
      const before = structuredClone(conversation.serialize());
      const controller = new AbortController();
      await expect(
        conversation.runTurn(
          request({
            signal: controller.signal,
            callbacks: {
              onText: (text) => {
                if (text === 'Cancel here') controller.abort();
              },
            },
          }),
        ),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(2);
      expect(conversation.serialize()).toEqual(before);
    },
  );

  it('reports refusals with their explanation', async () => {
    const events = anthropicStream([{ type: 'text', text: '' }], 'refusal');
    const delta = events.find((event) => event.event === 'message_delta')!.data as any;
    delta.delta.stop_details = { type: 'refusal', category: 'cyber', explanation: 'Declined.' };
    server.queueSse(events);

    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'something' });
    const result = await conversation.runTurn(request());

    expect(result.stopReason).toBe('refusal');
    expect(result.refusal).toBeTruthy();
  });

  it('propagates API errors', async () => {
    server.queueJson(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'hi' });
    await expect(conversation.runTurn(request())).rejects.toThrow(/invalid x-api-key/);
  });

  it('closes tool calls left pending by an interrupted task when the next message is added', async () => {
    server.queueSse(
      anthropicStream([{ type: 'tool_use', id: 'toolu_9', name: 'read_file', input: { path: 'a.ts' } }], 'tool_use'),
    );
    const conversation = new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
    });
    conversation.addUserMessage({ text: 'Read a.ts' });
    await conversation.runTurn(request());
    expect(conversation.hasPendingToolCalls()).toBe(true);

    conversation.addUserMessage({ text: 'Continue.' });
    expect(conversation.hasPendingToolCalls()).toBe(false);
    const messages = conversation.serialize().messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
    const repaired = messages.at(-2)!;
    expect(repaired.role).toBe('user');
    expect(repaired.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true });
    expect(JSON.stringify(repaired)).toContain('the app was interrupted');
  });
});

describe('AnthropicCompletionClient', () => {
  it('returns schema-validated structured output without forcing a tool', async () => {
    const server = new MockApiServer();
    const baseURL = await server.start();
    server.queueJson(200, {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: '{"title":"Fix login bug"}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 5 },
    });
    const client = new AnthropicCompletionClient(createAnthropicClient('sk-test', baseURL), 'claude-haiku-4-5');
    const result = await client.complete('Title?', z.object({ title: z.string() }));
    await server.stop();

    expect(result).toEqual({ title: 'Fix login bug' });
    const body = server.requests[0]!.body;
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.tool_choice).toBeUndefined();
  });
});
