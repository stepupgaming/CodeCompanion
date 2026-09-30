import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SettingsStore } from '../settings';
import { LlmService } from './index';
import { createOpenAIClient } from './openai';
import { OpenAIResponsesConversation } from './openai_responses';
import { MockApiServer } from './test_server';
import type { TurnRequest } from './types';

const model = 'gpt-6-sol';

function baseResponse(status: string, output: unknown[], usage: unknown = null) {
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 0,
    model,
    status,
    output,
    usage,
    error: null,
    incomplete_details: null,
  };
}

// The event sequence the Responses API streams for a reasoning item, a text message and a function call.
function responseEvents() {
  const reasoning = {
    id: 'rs_1',
    type: 'reasoning',
    summary: [{ type: 'summary_text', text: 'Plan.' }],
    encrypted_content: 'ENCRYPTED',
  };
  const message = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Checking', annotations: [] }],
  };
  const call = {
    id: 'fc_1',
    type: 'function_call',
    call_id: 'call_1',
    name: 'read_file',
    arguments: '{"path":"a.ts"}',
    status: 'completed',
  };
  const events: Array<{ event: string; data: object }> = [];
  let sequence = 0;
  const add = (type: string, data: object) =>
    events.push({ event: type, data: { type, sequence_number: sequence++, ...data } });

  add('response.created', { response: baseResponse('in_progress', []) });
  add('response.output_item.added', { output_index: 0, item: { ...reasoning, summary: [] } });
  add('response.reasoning_summary_part.added', {
    item_id: 'rs_1',
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: '' },
  });
  add('response.reasoning_summary_text.delta', { item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Plan.' });
  add('response.reasoning_summary_text.done', { item_id: 'rs_1', output_index: 0, summary_index: 0, text: 'Plan.' });
  add('response.reasoning_summary_part.done', {
    item_id: 'rs_1',
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text: 'Plan.' },
  });
  add('response.output_item.done', { output_index: 0, item: reasoning });
  add('response.output_item.added', { output_index: 1, item: { ...message, status: 'in_progress', content: [] } });
  add('response.content_part.added', {
    item_id: 'msg_1',
    output_index: 1,
    content_index: 0,
    part: { type: 'output_text', text: '', annotations: [] },
  });
  add('response.output_text.delta', {
    item_id: 'msg_1',
    output_index: 1,
    content_index: 0,
    delta: 'Checking',
    logprobs: [],
  });
  add('response.output_text.done', {
    item_id: 'msg_1',
    output_index: 1,
    content_index: 0,
    text: 'Checking',
    logprobs: [],
  });
  add('response.content_part.done', { item_id: 'msg_1', output_index: 1, content_index: 0, part: message.content[0] });
  add('response.output_item.done', { output_index: 1, item: message });
  add('response.output_item.added', { output_index: 2, item: { ...call, arguments: '', status: 'in_progress' } });
  add('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 2, delta: call.arguments });
  add('response.function_call_arguments.done', {
    item_id: 'fc_1',
    output_index: 2,
    arguments: call.arguments,
    name: call.name,
  });
  add('response.output_item.done', { output_index: 2, item: call });
  add('response.completed', {
    response: baseResponse('completed', [reasoning, message, call], {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 18,
    }),
  });
  return events;
}

function request(): TurnRequest & { text: string[]; thinking: string[] } {
  const text: string[] = [];
  const thinking: string[] = [];
  return {
    system: 'sys',
    tools: [
      { name: 'read_file', description: 'Read', schema: z.object({ path: z.string(), offset: z.number().optional() }) },
    ],
    signal: new AbortController().signal,
    callbacks: { onText: (delta) => text.push(delta), onThinking: (delta) => thinking.push(delta) },
    text,
    thinking,
  };
}

describe('OpenAIResponsesConversation', () => {
  let server: MockApiServer;
  let baseURL: string;

  beforeEach(async () => {
    server = new MockApiServer();
    baseURL = await server.start();
  });

  afterEach(() => server.stop());

  it('streams text and reasoning summaries and returns function calls', async () => {
    server.queueSse(responseEvents());
    const conversation = new OpenAIResponsesConversation(createOpenAIClient('sk-test', baseURL), model, 'high');
    conversation.addUserMessage({ text: 'read a.ts' });

    const req = request();
    const result = await conversation.runTurn(req);

    expect(req.text.join('')).toBe('Checking');
    expect(req.thinking.join('')).toBe('Plan.');
    expect(result.text).toBe('Checking');
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 4,
      cacheWriteTokens: 3,
      longContext: false,
    });
    expect(result.contextTokens).toBe(12);
  });

  it('sends a stateless request with reasoning effort, encrypted reasoning and auto truncation', async () => {
    server.queueSse(responseEvents());
    const conversation = new OpenAIResponsesConversation(createOpenAIClient('sk-test', baseURL), model, 'xhigh');
    conversation.addUserMessage({ text: 'hi', images: [{ mediaType: 'image/png', base64: 'AAAA' }] });
    await conversation.runTurn(request());

    const { path, body } = server.requests[0]!;
    expect(path).toBe('/responses');
    expect(body).toMatchObject({
      model,
      instructions: 'sys',
      store: false,
      truncation: 'auto',
      reasoning: { effort: 'xhigh', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
    });
    expect(body.tools[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
      strict: false,
      parameters: { type: 'object' },
    });
    expect(body.input[0].content).toEqual([
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
      { type: 'input_text', text: 'hi' },
    ]);
    expect(body.temperature).toBeUndefined();
  });

  it('sends reasoning items back unchanged with the tool results', async () => {
    server.queueSse(responseEvents());
    server.queueSse(responseEvents());
    const conversation = new OpenAIResponsesConversation(createOpenAIClient('sk-test', baseURL), model, 'medium');
    conversation.addUserMessage({ text: 'read a.ts' });
    await conversation.runTurn(request());
    conversation.addToolResults([{ id: 'call_1', content: 'file contents' }]);
    await conversation.runTurn(request());

    const input = server.requests[1]!.body.input;
    expect(input.map((item: any) => item.type ?? item.role)).toEqual([
      'user',
      'reasoning',
      'message',
      'function_call',
      'function_call_output',
    ]);
    expect(input[1].encrypted_content).toBe('ENCRYPTED');
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file contents' });
    expect(conversation.serialize().api).toBe('responses');
  });

  it('sends back the output items exactly as the API returned them, without the fields the SDK adds', async () => {
    server.queueSse(responseEvents());
    server.queueSse(responseEvents());
    const conversation = new OpenAIResponsesConversation(createOpenAIClient('sk-test', baseURL), model, 'medium');
    conversation.addUserMessage({ text: 'read a.ts' });
    await conversation.runTurn(request());
    conversation.addToolResults([{ id: 'call_1', content: 'file contents' }]);
    await conversation.runTurn(request());

    // The real API rejects unknown fields: "400 Unknown parameter: 'input[1].parsed_arguments'".
    const input = server.requests[1]!.body.input;
    expect(input[2]).toEqual({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Checking', annotations: [] }],
    });
    expect(input[3]).toEqual({
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{"path":"a.ts"}',
      status: 'completed',
    });
    expect(JSON.stringify(input)).not.toMatch(/"parsed(_arguments)?"/);
    // Nor are they saved with the chat.
    expect(JSON.stringify(conversation.serialize().messages)).not.toMatch(/"parsed(_arguments)?"/);
  });

  it('repairs a chat saved with the SDK fields when it is sent again', async () => {
    server.queueSse(responseEvents());
    const saved = [
      { role: 'user', content: [{ type: 'input_text', text: 'read a.ts' }] },
      {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Checking', annotations: [], parsed: null }],
      },
      {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'read_file',
        arguments: '{}',
        status: 'completed',
        parsed_arguments: null,
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
    ];
    const conversation = new OpenAIResponsesConversation(
      createOpenAIClient('sk-test', baseURL),
      model,
      'medium',
      saved as never,
    );
    await conversation.runTurn(request());

    const input = server.requests[0]!.body.input;
    expect(JSON.stringify(input)).not.toMatch(/"parsed(_arguments)?"/);
    expect(input[2]).toEqual({
      id: 'fc_1',
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{}',
      status: 'completed',
    });
    expect(input[1].content[0]).toEqual({ type: 'output_text', text: 'Checking', annotations: [] });
  });

  it('reports truncated output', async () => {
    server.queueSse([
      {
        event: 'response.created',
        data: { type: 'response.created', sequence_number: 0, response: baseResponse('in_progress', []) },
      },
      {
        event: 'response.incomplete',
        data: {
          type: 'response.incomplete',
          sequence_number: 1,
          response: { ...baseResponse('incomplete', []), incomplete_details: { reason: 'max_output_tokens' } },
        },
      },
    ]);
    const conversation = new OpenAIResponsesConversation(createOpenAIClient('sk-test', baseURL), model, 'low');
    conversation.addUserMessage({ text: 'long' });
    const result = await conversation.runTurn(request());
    expect(result.stopReason).toBe('max_tokens');
  });

  it('closes function calls left pending by an interrupted task when the next message is added', () => {
    const conversation = new OpenAIResponsesConversation(createOpenAIClient('sk-test', baseURL), model, 'high', [
      { role: 'user', content: [{ type: 'input_text', text: 'read a.ts' }] },
      {
        type: 'function_call',
        call_id: 'call_9',
        name: 'read_file',
        arguments: '{"path":"a.ts"}',
        id: 'fc_9',
        status: 'completed',
      } as never,
    ]);
    expect(conversation.hasPendingToolCalls()).toBe(true);

    conversation.addUserMessage({ text: 'Continue.' });
    expect(conversation.hasPendingToolCalls()).toBe(false);
    const items = conversation.serialize().messages as Array<Record<string, unknown>>;
    expect(items.at(-1)).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] });
    expect(items.at(-2)).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_9',
      output: expect.stringContaining('the app was interrupted'),
    });
  });
});

describe('LlmService OpenAI routing', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-llm-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function service(baseUrl: string) {
    const cipher = { isAvailable: () => false, encrypt: (s: string) => s, decrypt: (s: string) => s };
    const settings = new SettingsStore(join(dir, 'settings.json'), cipher);
    settings.setSecret('openaiApiKey', 'sk-test');
    settings.update({ model, openaiBaseUrl: baseUrl });
    return new LlmService(settings);
  }

  it('uses the Responses API for api.openai.com', () => {
    expect(service('').createConversation().serialize().api).toBe('responses');
  });

  it('uses Chat Completions for custom OpenAI-compatible endpoints', () => {
    expect(service('http://localhost:11434/v1').createConversation().serialize().api).toBe('chat');
  });

  it('restores older chats without an api field as Chat Completions', () => {
    const restored = service('').restoreConversation({ provider: 'openai', model, messages: [] });
    expect(restored.serialize().api).toBe('chat');
  });
});
