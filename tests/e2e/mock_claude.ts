import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { anthropicStream } from '../../src/main/llm/test_server';

type Block = Parameters<typeof anthropicStream>[0][number];

export interface ScriptedTurn {
  blocks: Block[];
  stopReason: 'end_turn' | 'tool_use';
}

// A request the API rejects, e.g. a rate limit. retryAfterSeconds is sent as the Retry-After header.
export interface ScriptedFailure {
  failure: { status: number; type: string; retryAfterSeconds?: number };
}

// An answer that streams `text` and then never finishes, until the app aborts the request (Stop).
export interface ScriptedHang {
  hang: { text: string };
}

// An answer streamed as `chunks` text deltas, `intervalMs` apart, like a real model writing (for performance runs).
export interface ScriptedSlow {
  slow: { text: string; chunks: number; intervalMs: number };
}

// Mock Anthropic API for end-to-end tests. Streaming requests (agent turns) get the scripted turns in order;
// non-streaming requests (the small-model title) get a fixed structured answer.
export class MockClaude {
  readonly agentRequests: any[] = [];
  // Requests to summarize old turns (compact chat).
  readonly summaryRequests: any[] = [];
  private turns: Array<ScriptedTurn | ScriptedFailure | ScriptedHang | ScriptedSlow> = [];
  // Set once a hanging answer's text has been sent, and cleared when the app gives up on it.
  hanging = false;
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (!body.stream) {
          // A request to compact the chat asks for a summary; everything else asked for a title.
          const prompt = JSON.stringify(body.messages?.[0]?.content ?? '');
          if (prompt.includes('Summarize the earlier part')) this.summaryRequests.push(body);
          const answer = prompt.includes('Summarize the earlier part')
            ? '{"summary":"E2E SUMMARY of the earlier work."}'
            : '{"title":"Explore the project"}';
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'msg_title',
              type: 'message',
              role: 'assistant',
              model: body.model,
              content: [{ type: 'text', text: answer }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
          return;
        }
        this.agentRequests.push(body);
        const turn = this.turns.shift();
        if (!turn) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'no scripted turn' } }));
          return;
        }
        if ('failure' in turn) {
          const { status, type, retryAfterSeconds } = turn.failure;
          res.writeHead(status, {
            'content-type': 'application/json',
            ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
          });
          res.end(JSON.stringify({ type: 'error', error: { type, message: `scripted ${status}` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if ('hang' in turn) {
          // Everything up to the text, without the block, message end and stop events.
          for (const { event, data } of anthropicStream([{ type: 'text', text: turn.hang.text }], 'end_turn').slice(
            0,
            -3,
          )) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          this.hanging = true;
          res.on('close', () => (this.hanging = false));
          return;
        }
        if ('slow' in turn) {
          const { text, chunks, intervalMs } = turn.slow;
          const events = anthropicStream([{ type: 'text', text: '' }], 'end_turn');
          const send = ({ event, data }: { event: string; data: unknown }) =>
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          // message_start and content_block_start, then the deltas, then the rest without the empty delta.
          events.slice(0, 2).forEach(send);
          const size = Math.ceil(text.length / chunks);
          let index = 0;
          const timer = setInterval(() => {
            if (index * size >= text.length) {
              clearInterval(timer);
              events.slice(3).forEach(send);
              res.end();
              return;
            }
            send({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: text.slice(index * size, (index + 1) * size) },
              },
            });
            index++;
          }, intervalMs);
          res.on('close', () => clearInterval(timer));
          return;
        }
        for (const { event, data } of anthropicStream(turn.blocks, turn.stopReason)) {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
        res.end();
      });
    });
  }

  script(...turns: Array<ScriptedTurn | ScriptedFailure | ScriptedHang | ScriptedSlow>): void {
    this.turns.push(...turns);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    // A hanging answer or a kept-alive connection would otherwise keep the server from closing.
    this.server.closeAllConnections();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('The mock Claude API did not shut down within 5 s.')), 5_000).unref(),
    );
    return Promise.race([closed, timeout]);
  }
}
