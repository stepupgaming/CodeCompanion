// Measures what the main process does for each streamed event in a long chat: ChatSession applies every event to its
// own copy of the transcript (applyChatEvent, which builds a new item list per event) before sending it to the UI.
// Runs in Node without the app: a real ChatSession, a scripted model that streams a 20,000-character answer in many
// small pieces, and saved transcripts of different lengths. Not part of `npm test`; run `npm run perf`. Numbers vary
// by machine, so this prints them rather than asserting limits. Results are recorded in docs/PERFORMANCE.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, it } from 'vitest';
import { applyChatEvent, type ChatEvent, type TranscriptItem } from '../../src/shared/chat';
import { ChatSession } from '../../src/main/agent/session';
import type { Conversation, TurnRequest, TurnResult } from '../../src/main/llm/types';
import type { ToolContext } from '../../src/main/tools/types';
import { ANSWER, transcript } from './long_transcript';

// The SDKs hand over text in pieces of a few characters to a few dozen; 10 characters is a busy stream.
const CHUNK = 10;
const SIZES = [0, 250, 1000, 4000].map((turns) => ({ turns, items: turns * 5 }));

// A model that streams ANSWER in CHUNK-sized pieces, all at once, so only the app's own work is timed.
class StreamingConversation implements Conversation {
  readonly provider = 'anthropic' as const;
  readonly model = 'claude-opus-5-5';
  addUserMessage(): void {}
  addToolResults(): void {}
  async runTurn(request: TurnRequest): Promise<TurnResult> {
    for (let index = 0; index < ANSWER.length; index += CHUNK)
      request.callbacks.onText(ANSWER.slice(index, index + CHUNK));
    return {
      text: ANSWER,
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      contextTokens: 1,
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

function session(items: TranscriptItem[], onEvent: (event: ChatEvent) => void): ChatSession {
  return new ChatSession({
    projectPath: '/project',
    conversation: new StreamingConversation(),
    system: 'system prompt',
    agentFile: null,
    tools: () => [],
    transcript: items,
    approvalMode: () => 'ask',
    toolContext: (base) => base as ToolContext,
    smallModel: () => null,
    onEvent,
    onChange: () => {},
  });
}

interface Row {
  items: number;
  deltas: number;
  // One whole answer through ChatSession: every delta applied to the transcript and handed on for the UI.
  sessionMs: number;
  perDeltaUs: number;
  // applyChatEvent alone, for the same deltas.
  reducerMs: number;
  reducerPerDeltaUs: number;
  // What handing each event to the UI would take: webContents.send serializes it (structured clone), here JSON.
  serializeMs: number;
}

const rows: Row[] = [];

// The median of `runs` timings, after one untimed warm-up.
async function median(runs: number, work: () => Promise<void> | void): Promise<number> {
  await work();
  const times: number[] = [];
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    await work();
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe('main process: streamed events in a long chat', () => {
  afterAll(() => {
    console.log(
      `\nMain process, one ${ANSWER.length.toLocaleString('en-US')}-character answer in ${CHUNK}-character deltas\n`,
    );
    console.table(rows);
    mkdirSync(join(__dirname, '../../out'), { recursive: true });
    writeFileSync(join(__dirname, '../../out/perf-main-process.json'), JSON.stringify({ chunk: CHUNK, rows }, null, 2));
  });

  for (const { turns, items } of SIZES) {
    it(`${items} items`, async () => {
      const saved = transcript(turns);
      let deltas = 0;
      let serializeMs = 0;

      const sessionMs = await median(5, async () => {
        deltas = 0;
        await session(saved, (event) => {
          if (event.type === 'assistant-delta') deltas++;
        }).send({ text: 'Explain everything in detail' });
      });

      // The same events through the reducer alone: the user message, the start, every delta, the end.
      const events: ChatEvent[] = [
        { type: 'user', id: 'u', text: 'Explain everything in detail', imageCount: 0 },
        { type: 'assistant-start', id: 'a' },
        ...Array.from({ length: Math.ceil(ANSWER.length / CHUNK) }, (_, index): ChatEvent => ({
          type: 'assistant-delta',
          id: 'a',
          text: ANSWER.slice(index * CHUNK, (index + 1) * CHUNK),
        })),
        { type: 'assistant-end', id: 'a', text: ANSWER },
      ];
      const reducerMs = await median(5, () => {
        let current = saved;
        for (const event of events) current = applyChatEvent(current, event);
      });
      serializeMs = await median(5, () => {
        for (const event of events) JSON.stringify({ chatId: 'x', event });
      });

      rows.push({
        items,
        deltas,
        sessionMs: Math.round(sessionMs * 10) / 10,
        perDeltaUs: Math.round((sessionMs * 1000) / deltas),
        reducerMs: Math.round(reducerMs * 10) / 10,
        reducerPerDeltaUs: Math.round((reducerMs * 1000) / deltas),
        serializeMs: Math.round(serializeMs * 10) / 10,
      });
    }, 120_000);
  }
});
