import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnthropicConversation, createAnthropicClient } from './anthropic';
import { createOpenAIClient, OpenAIConversation } from './openai';
import { OpenAIResponsesConversation } from './openai_responses';
import { anthropicStream, MockApiServer } from './test_server';
import type { TurnRequest } from './types';

const big = (label: string, size = 12_000) => `${label} ${'x'.repeat(size)}`;

function request(): TurnRequest {
  return {
    system: 'sys',
    tools: [{ name: 'read_file', description: 'Read', schema: z.object({ path: z.string() }) }],
    signal: new AbortController().signal,
    callbacks: { onText: () => {} },
  };
}

let server: MockApiServer;
let baseURL: string;

beforeEach(async () => {
  server = new MockApiServer();
  baseURL = await server.start();
});

afterEach(() => server.stop());

describe('Anthropic conversation compaction', () => {
  // user, assistant, user, assistant (tool call), user (its result), assistant, user, user.
  const history = () => [
    { role: 'user', content: [{ type: 'text', text: big('TASK') }] },
    { role: 'assistant', content: [{ type: 'text', text: big('first answer') }] },
    { role: 'user', content: [{ type: 'text', text: big('SECOND-PROMPT') }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig' },
        { type: 'text', text: big('reading', 6_000) },
        { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: big('FILE-CONTENT') }] }],
    },
    { role: 'assistant', content: [{ type: 'text', text: big('third answer') }] },
    { role: 'user', content: [{ type: 'text', text: big('THIRD-PROMPT') }] },
    { role: 'user', content: [{ type: 'text', text: big('LATEST') }] },
  ];
  const create = (messages: unknown[], compaction?: { summary: string; keepFrom: number }) =>
    new AnthropicConversation(createAnthropicClient('sk-test', baseURL), {
      model: 'claude-opus-5-5',
      effort: 'high',
      messages: messages as never,
      compaction,
    });
  const ok = () => server.queueSse(anthropicStream([{ type: 'text', text: 'ok' }], 'end_turn'));

  it('cuts before an assistant message, never between a tool call and its result', () => {
    const plan = create(history()).planCompaction()!;

    // The result at index 4 alone is enough tail, but a tool result cannot start the history.
    expect(plan.keepFrom).toBe(3);
    expect(plan.messages).toBe(3);
    expect(plan.text).toContain('User: TASK');
    expect(plan.text).toContain('Assistant: first answer');
    expect(plan.text).toContain('User: SECOND-PROMPT');
    expect(plan.text).not.toContain('FILE-CONTENT');
  });

  it('describes tool calls and results briefly and leaves thinking out', () => {
    // Start after the first turns so the tool call and its result are among the messages being summarized.
    const plan = create([...history(), ...history()], { summary: 'S', keepFrom: 3 }).planCompaction()!;

    expect(plan.text).toContain('Assistant called read_file: {"path":"a.ts"}');
    expect(plan.text).toMatch(/Tool result: FILE-CONTENT x+/);
    expect(plan.text).not.toContain('hmm');
  });

  it('sends the summary and the messages from the cut on, and leaves the stored history alone', async () => {
    const original = history();
    const conversation = create(structuredClone(original));
    const plan = conversation.planCompaction()!;
    conversation.applyCompaction('THE SUMMARY', plan.keepFrom);
    ok();
    await conversation.runTurn(request());

    const sent = server.requests[0]!.body.messages;
    // The first kept message is an assistant one, so the summary is a message of its own in front of it.
    expect(sent).toHaveLength(original.length - 3 + 1);
    expect(sent[0].role).toBe('user');
    expect(sent[0].content[0].text).toContain('THE SUMMARY');
    expect(sent[1]).toEqual(original[3]);
    expect(JSON.stringify(sent)).not.toContain('TASK');
    expect(JSON.stringify(sent)).not.toContain('SECOND-PROMPT');

    const saved = conversation.serialize();
    expect(saved.messages).toHaveLength(original.length + 1);
    expect(saved.messages.slice(0, original.length)).toEqual(original);
    expect(saved.compaction).toEqual({ summary: 'THE SUMMARY', keepFrom: 3 });
  });

  it('adds the summary to the first kept message when that is one from the user', async () => {
    const original = history();
    const conversation = create(structuredClone(original));
    conversation.applyCompaction('THE SUMMARY', 6);
    ok();
    await conversation.runTurn(request());

    const sent = server.requests[0]!.body.messages;
    expect(sent).toHaveLength(2);
    expect(sent[0].content).toHaveLength(2);
    expect(sent[0].content[0].text).toContain('THE SUMMARY');
    expect(sent[0].content[1]).toEqual(original[6]!.content[0]);
    // The stored message was copied, not edited.
    expect(conversation.serialize().messages[6]).toEqual(original[6]);
  });

  it('sends the same request after the chat is saved and reopened', async () => {
    const first = create(history());
    first.applyCompaction('THE SUMMARY', first.planCompaction()!.keepFrom);
    const saved = JSON.parse(JSON.stringify(first.serialize()));
    ok();
    ok();
    await first.runTurn(request());

    const reopened = create(saved.messages, saved.compaction);
    await reopened.runTurn(request());
    // The first conversation added its reply after the request, so compare what was sent.
    expect(server.requests[1]!.body.messages).toEqual(server.requests[0]!.body.messages);
  });

  it('compacts again later from the previous summary, moving the cut forward', () => {
    const messages = [...history(), ...history(), ...history()];
    const conversation = create(messages, { summary: 'FIRST SUMMARY', keepFrom: 3 });
    const plan = conversation.planCompaction()!;

    expect(plan.keepFrom).toBeGreaterThan(3);
    expect(plan.text.startsWith('Summary of the earlier part')).toBe(true);
    expect(plan.text).toContain('FIRST SUMMARY');
    conversation.applyCompaction('SECOND SUMMARY', plan.keepFrom);
    expect(conversation.serialize().compaction).toEqual({ summary: 'SECOND SUMMARY', keepFrom: plan.keepFrom });
  });

  it('refuses a summary that no longer fits the history', () => {
    const conversation = create(history());
    expect(() => conversation.applyCompaction('S', 0)).toThrow(/changed/);
    expect(() => conversation.applyCompaction('S', 99)).toThrow(/changed/);
    expect(conversation.serialize().compaction).toBeUndefined();
  });
});

function chunk(delta: object, finishReason: string | null = null) {
  return {
    data: {
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-test',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    },
  };
}

describe('OpenAI conversation compaction', () => {
  const history = () => [
    { role: 'user', content: big('TASK') },
    { role: 'assistant', content: big('first answer') },
    {
      role: 'assistant',
      content: big('reading'),
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: big('FILE-CONTENT', 30_000) },
    { role: 'assistant', content: big('third answer') },
    { role: 'user', content: big('LATEST') },
  ];
  const create = (messages: unknown[], compaction: { summary: string; keepFrom: number } | null = null) =>
    new OpenAIConversation(createOpenAIClient('sk-test', baseURL), 'gpt-test', messages as never, compaction);
  const ok = () =>
    server.queueSse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop'), { data: '[DONE]' }]);

  it('never cuts before a tool message', () => {
    const plan = create(history()).planCompaction()!;
    expect(plan.keepFrom).toBe(2);
    expect(plan.text).toContain('User: TASK');
    expect(plan.text).not.toContain('FILE-CONTENT');
  });

  it('describes tool calls and results', () => {
    const plan = create([...history(), ...history(), ...history()], { summary: 'S', keepFrom: 2 }).planCompaction()!;
    expect(plan.text).toContain('Assistant called read_file: {"path":"a.ts"}');
    expect(plan.text).toMatch(/Tool result: FILE-CONTENT x+/);
  });

  it('sends the summary in front of the kept messages and stores everything', async () => {
    const original = history();
    const conversation = create(structuredClone(original));
    conversation.applyCompaction('THE SUMMARY', conversation.planCompaction()!.keepFrom);
    ok();
    await conversation.runTurn(request());

    const sent = server.requests[0]!.body.messages;
    // system, the summary, then the four kept messages.
    expect(sent).toHaveLength(1 + 1 + 4);
    expect(sent[1].role).toBe('user');
    expect(sent[1].content).toContain('THE SUMMARY');
    expect(sent[2]).toEqual(original[2]);
    expect(JSON.stringify(sent)).not.toContain('TASK');

    const saved = conversation.serialize();
    expect(saved.messages.slice(0, original.length)).toEqual(original);
    expect(saved.compaction).toEqual({ summary: 'THE SUMMARY', keepFrom: 2 });
  });

  it('joins the summary to a user message that comes first after the cut', async () => {
    const original = history();
    const conversation = create(structuredClone(original));
    conversation.applyCompaction('THE SUMMARY', 5);
    ok();
    await conversation.runTurn(request());

    const sent = server.requests[0]!.body.messages;
    expect(sent).toHaveLength(2);
    expect(sent[1].content).toMatch(/^Summary of the earlier part[\s\S]*THE SUMMARY[\s\S]*LATEST/);
    expect(conversation.serialize().messages[5]).toEqual(original[5]);
  });

  it('keeps the stored history whole when only the copy that is sent is trimmed', async () => {
    const huge = [
      { role: 'user', content: 'THE TASK' },
      ...Array.from({ length: 10 }, (_, index) => [
        { role: 'assistant', content: `answer ${index} ${'x'.repeat(60_000)}` },
        { role: 'user', content: `follow-up ${index}` },
      ]).flat(),
    ];
    const conversation = create(structuredClone(huge));
    ok();
    await conversation.runTurn(request());

    expect(JSON.stringify(server.requests[0]!.body.messages).length / 4).toBeLessThan(110_000);
    expect(conversation.serialize().messages.slice(0, huge.length)).toEqual(huge);
  });
});

describe('OpenAI Responses conversation compaction', () => {
  const text = (value: string) => [{ type: 'output_text', text: value, annotations: [] }];
  const history = () => [
    { role: 'user', content: [{ type: 'input_text', text: big('TASK') }] },
    { type: 'reasoning', id: 'rs_0', summary: [], encrypted_content: 'E0' },
    { type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: text(big('first answer')) },
    { role: 'user', content: [{ type: 'input_text', text: big('SECOND-PROMPT') }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'E1' },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'c1',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
      status: 'completed',
    },
    { type: 'function_call_output', call_id: 'c1', output: big('FILE-CONTENT', 30_000) },
    { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: text(big('third answer')) },
    { role: 'user', content: [{ type: 'input_text', text: big('LATEST') }] },
  ];
  const create = (items: unknown[], compaction: { summary: string; keepFrom: number } | null = null) =>
    new OpenAIResponsesConversation(
      createOpenAIClient('sk-test', baseURL),
      'gpt-6-sol',
      'high',
      items as never,
      compaction,
    );

  it('cuts before the reasoning item of a tool call, keeping the call, its reasoning and its output together', () => {
    const plan = create(history()).planCompaction()!;

    expect(plan.keepFrom).toBe(4);
    expect(plan.messages).toBe(4);
    expect(plan.text).toContain('User: TASK');
    expect(plan.text).toContain('Assistant: first answer');
    expect(plan.text).toContain('User: SECOND-PROMPT');
    expect(plan.text).not.toContain('FILE-CONTENT');
    // Encrypted reasoning says nothing a summary could use.
    expect(plan.text).not.toContain('E0');
  });

  it('never cuts between a reasoning item and the message it produced', () => {
    // Without the tool call, the latest safe point near the end would be the assistant message after rs_0.
    const items = [
      { role: 'user', content: [{ type: 'input_text', text: big('TASK', 40_000) }] },
      { type: 'reasoning', id: 'rs_0', summary: [], encrypted_content: 'E0' },
      { type: 'message', id: 'msg_0', role: 'assistant', status: 'completed', content: text(big('ANSWER', 40_000)) },
      { role: 'user', content: [{ type: 'input_text', text: big('LATEST', 2_000) }] },
    ];
    // msg_0 (index 2) follows rs_0, so it may not start the kept part.
    expect(create(items).planCompaction()?.keepFrom).not.toBe(2);
  });

  it('describes function calls and their output', () => {
    const plan = create([...history(), ...history(), ...history()], { summary: 'S', keepFrom: 4 }).planCompaction()!;
    expect(plan.text).toContain('Assistant called read_file: {"path":"a.ts"}');
    expect(plan.text).toMatch(/Tool result: FILE-CONTENT x+/);
  });

  it('sends the summary as the first item, then the items from the cut on, and stores everything', async () => {
    const original = history();
    const conversation = create(structuredClone(original));
    conversation.applyCompaction('THE SUMMARY', conversation.planCompaction()!.keepFrom);
    // A stream that is only created and completed is enough to read back the request that was sent.
    server.queueSse([
      {
        event: 'response.created',
        data: { type: 'response.created', sequence_number: 0, response: response('in_progress') },
      },
      {
        event: 'response.completed',
        data: { type: 'response.completed', sequence_number: 1, response: response('completed') },
      },
    ]);
    await conversation.runTurn(request());

    const input = server.requests[0]!.body.input;
    expect(input).toHaveLength(1 + (original.length - 4));
    expect(input[0].role).toBe('user');
    expect(input[0].content[0].text).toContain('THE SUMMARY');
    expect(input[1]).toEqual(original[4]);
    expect(JSON.stringify(input)).not.toContain('TASK');

    const saved = conversation.serialize();
    expect(saved.messages.slice(0, original.length)).toEqual(original);
    expect(saved.compaction).toEqual({ summary: 'THE SUMMARY', keepFrom: 4 });
  });
});

function response(status: string) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model: 'gpt-6-sol',
    status,
    output: [],
    usage: null,
    error: null,
    incomplete_details: null,
  };
}
