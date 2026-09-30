import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

// A local HTTP server that replays canned responses to the SDKs, so request building and stream parsing are
// tested through the real client code without network access.
export class MockApiServer {
  readonly requests: RecordedRequest[] = [];
  private responses: Array<(res: import('node:http').ServerResponse) => void> = [];
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        this.requests.push({ path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null });
        const next = this.responses.shift();
        if (!next) {
          res.writeHead(500).end('no canned response');
          return;
        }
        next(res);
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // Server-sent events, as both APIs stream them.
  queueSse(events: Array<{ event?: string; data: unknown }>): void {
    this.responses.push((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const { event, data } of events) {
        if (event) res.write(`event: ${event}\n`);
        res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
      }
      res.end();
    });
  }

  queueJson(status: number, body: unknown): void {
    this.responses.push((res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  }
}

// Builds the Anthropic streaming event sequence for a message made of text and tool_use blocks.
export function anthropicStream(
  blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }>,
  stopReason: string,
): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 3,
          },
        },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        event: 'content_block_start',
        data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
      });
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
      });
    } else {
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
      });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 7 },
    },
  });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}
