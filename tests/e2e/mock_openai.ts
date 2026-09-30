import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ScriptedResponse {
  text?: string;
  // A reasoning item that is returned encrypted and must be sent back unchanged.
  reasoning?: { summary: string; encrypted: string };
  call?: { id: string; name: string; input: unknown };
}

const MODEL = 'gpt-6-sol';

function response(status: string, output: unknown[], usage: unknown = null) {
  return {
    id: 'resp_e2e',
    object: 'response',
    created_at: 0,
    model: MODEL,
    status,
    output,
    usage,
    error: null,
    incomplete_details: null,
  };
}

// The event sequence the Responses API streams for the scripted output items.
function responseEvents(turn: ScriptedResponse): Array<{ event: string; data: object }> {
  const events: Array<{ event: string; data: object }> = [];
  let sequence = 0;
  const add = (type: string, data: object) =>
    events.push({ event: type, data: { type, sequence_number: sequence++, ...data } });
  const output: unknown[] = [];
  add('response.created', { response: response('in_progress', []) });

  if (turn.reasoning) {
    const item = {
      id: 'rs_e2e',
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: turn.reasoning.summary }],
      encrypted_content: turn.reasoning.encrypted,
    };
    const index = output.length;
    output.push(item);
    add('response.output_item.added', { output_index: index, item: { ...item, summary: [] } });
    add('response.reasoning_summary_part.added', {
      item_id: item.id,
      output_index: index,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
    add('response.reasoning_summary_text.delta', {
      item_id: item.id,
      output_index: index,
      summary_index: 0,
      delta: turn.reasoning.summary,
    });
    add('response.reasoning_summary_text.done', {
      item_id: item.id,
      output_index: index,
      summary_index: 0,
      text: turn.reasoning.summary,
    });
    add('response.reasoning_summary_part.done', {
      item_id: item.id,
      output_index: index,
      summary_index: 0,
      part: item.summary[0],
    });
    add('response.output_item.done', { output_index: index, item });
  }

  if (turn.text) {
    const item = {
      id: 'msg_e2e',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: turn.text, annotations: [] }],
    };
    const index = output.length;
    output.push(item);
    add('response.output_item.added', { output_index: index, item: { ...item, status: 'in_progress', content: [] } });
    add('response.content_part.added', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    add('response.output_text.delta', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      delta: turn.text,
      logprobs: [],
    });
    add('response.output_text.done', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      text: turn.text,
      logprobs: [],
    });
    add('response.content_part.done', {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: item.content[0],
    });
    add('response.output_item.done', { output_index: index, item });
  }

  if (turn.call) {
    const args = JSON.stringify(turn.call.input);
    const item = {
      id: 'fc_e2e',
      type: 'function_call',
      call_id: turn.call.id,
      name: turn.call.name,
      arguments: args,
      status: 'completed',
    };
    const index = output.length;
    output.push(item);
    add('response.output_item.added', { output_index: index, item: { ...item, arguments: '', status: 'in_progress' } });
    add('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: args });
    add('response.function_call_arguments.done', {
      item_id: item.id,
      output_index: index,
      arguments: args,
      name: item.name,
    });
    add('response.output_item.done', { output_index: index, item });
  }

  add('response.completed', {
    response: response('completed', output, {
      input_tokens: 12,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens: 6,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 18,
    }),
  });
  return events;
}

// Mock OpenAI API for end-to-end tests. `/responses` (agent turns) replays the scripted turns in order;
// `/chat/completions` (the small-model chat title) gets a fixed structured answer.
export class MockOpenAI {
  readonly agentRequests: any[] = [];
  private turns: ScriptedResponse[] = [];
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (req.url?.endsWith('/chat/completions')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'chatcmpl_title',
              object: 'chat.completion',
              created: 0,
              model: body.model,
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: '{"title":"Read the notes"}', refusal: null },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        this.agentRequests.push({ path: req.url, body });
        // Like the real API: fields the SDK adds to responses are not valid input and are rejected.
        const invalid = (body.input ?? []).findIndex(
          (item: any) =>
            'parsed_arguments' in item ||
            (Array.isArray(item.content) && item.content.some((part: any) => part && 'parsed' in part)),
        );
        if (invalid >= 0) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: `Unknown parameter: 'input[${invalid}].parsed_arguments'.`,
                type: 'invalid_request_error',
              },
            }),
          );
          return;
        }
        const turn = this.turns.shift();
        if (!turn) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'no scripted turn', type: 'api_error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const { event, data } of responseEvents(turn))
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      });
    });
  }

  script(...turns: ScriptedResponse[]): void {
    this.turns.push(...turns);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    // A kept-alive connection would otherwise keep the server from closing.
    this.server.closeAllConnections();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('The mock OpenAI API did not shut down within 5 s.')), 5_000).unref(),
    );
    return Promise.race([closed, timeout]);
  }
}
