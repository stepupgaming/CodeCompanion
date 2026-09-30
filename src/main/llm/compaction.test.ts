import { describe, expect, it } from 'vitest';
import {
  compactionPrompt,
  estimateChars,
  nextState,
  planCompaction,
  summaryNote,
  type CompactionAdapter,
  type CompactionState,
} from './compaction';

interface Message {
  text: string;
  safe?: boolean;
}

// Messages of about `size` characters each, all safe places to cut unless said otherwise.
const message = (size: number, label = 'm', safe = true): Message => ({ text: label.repeat(size), safe });
const adapter: CompactionAdapter<Message> = { safeCut: (item) => item.safe !== false, describe: (item) => [item.text] };
const ten = (): Message[] => Array.from({ length: 10 }, (_, index) => message(10_000, String(index)));

describe('planCompaction', () => {
  it('has nothing to do for a short chat', () => {
    expect(planCompaction([message(1_000), message(1_000), message(1_000)], null, adapter)).toBeNull();
    expect(planCompaction([], null, adapter)).toBeNull();
  });

  it('keeps the last ~40k characters and summarizes what is before them', () => {
    const plan = planCompaction(ten(), null, adapter)!;

    // Four messages of 10k are the smallest tail of at least 40k characters.
    expect(plan.keepFrom).toBe(6);
    expect(plan.messages).toBe(6);
    expect(plan.text).toContain('0'.repeat(100));
    expect(plan.text).toContain('5'.repeat(100));
    expect(plan.text).not.toContain('6'.repeat(100));
  });

  it('never cuts where the history cannot start, and cuts earlier instead', () => {
    const messages = ten();
    messages[6]!.safe = false;
    expect(planCompaction(messages, null, adapter)!.keepFrom).toBe(5);

    for (const index of [6, 5, 4, 3]) messages[index]!.safe = false;
    expect(planCompaction(messages, null, adapter)!.keepFrom).toBe(2);

    for (const item of messages) item.safe = false;
    expect(planCompaction(messages, null, adapter)).toBeNull();
  });

  it('has nothing to do when the part before the tail is too small to be worth summarizing', () => {
    // The last four messages fill the 40k tail, which leaves only the two small ones before them.
    const messages = [message(500), message(500), ...Array.from({ length: 4 }, () => message(10_000))];
    expect(planCompaction(messages, null, adapter)).toBeNull();
  });

  it('never cuts at the first message, which would summarize nothing', () => {
    expect(planCompaction([message(60_000), message(60_000)], null, adapter)).toBeNull();
  });

  it('continues after an earlier compaction and hands the old summary to the summarizer', () => {
    const messages = Array.from({ length: 20 }, (_, index) => message(10_000, String.fromCharCode(97 + index)));
    const state: CompactionState = { summary: 'EARLIER SUMMARY', keepFrom: 6 };
    const plan = planCompaction(messages, state, adapter)!;

    expect(plan.keepFrom).toBeGreaterThan(6);
    expect(plan.messages).toBe(plan.keepFrom - 6);
    expect(plan.text.startsWith(summaryNote('EARLIER SUMMARY'))).toBe(true);
    // Messages already replaced by the earlier summary are not read again.
    expect(plan.text).not.toContain('a'.repeat(100));
    expect(plan.text).toContain('g'.repeat(100));
  });

  it('has nothing to do when little was added since the last compaction', () => {
    const messages = ten();
    expect(planCompaction(messages, { summary: 'S', keepFrom: 6 }, adapter)).toBeNull();
  });

  it('leaves out the middle when the old turns are more than a summarizer can read', () => {
    const messages = Array.from({ length: 16 }, (_, index) => message(60_000, String.fromCharCode(65 + index)));
    const plan = planCompaction(messages, null, adapter)!;

    expect(plan.text.length).toBeLessThan(301_000);
    expect(plan.text).toContain('left out');
    expect(plan.text.startsWith('A'.repeat(100))).toBe(true);
  });
});

describe('nextState', () => {
  it('stores the trimmed summary and the cut', () => {
    expect(nextState(null, 10, '  The notes.\n', 4)).toEqual({ summary: 'The notes.', keepFrom: 4 });
  });

  it('moves the cut forward only, and only inside the history', () => {
    const state = { summary: 'S', keepFrom: 4 };
    expect(() => nextState(state, 10, 'new', 4)).toThrow(/changed/);
    expect(() => nextState(state, 10, 'new', 2)).toThrow(/changed/);
    expect(() => nextState(null, 10, 'new', 10)).toThrow(/changed/);
    expect(nextState(state, 10, 'new', 9)).toEqual({ summary: 'new', keepFrom: 9 });
  });

  it('refuses an empty summary', () => {
    expect(() => nextState(null, 10, '  \n', 4)).toThrow(/empty/);
  });
});

describe('text helpers', () => {
  it('counts an embedded image as a fixed small size, not its base64 length', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(2_000_000) } };
    const dataUrl = { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(2_000_000)}` } };
    expect(estimateChars(image)).toBeLessThan(2_500);
    expect(estimateChars(dataUrl)).toBeLessThan(2_500);
    expect(estimateChars({ text: 'x'.repeat(5_000) })).toBeGreaterThan(5_000);
  });

  it('tells the model what the summary stands for', () => {
    expect(summaryNote('THE NOTES')).toContain('THE NOTES');
    expect(summaryNote('THE NOTES')).toMatch(/compacted/);
  });

  it('asks the summarizer to keep what the assistant would have to rediscover', () => {
    const prompt = compactionPrompt('User: hello');
    expect(prompt).toContain('User: hello');
    for (const topic of ['goal', 'files', 'commands', 'still has to be done']) expect(prompt).toContain(topic);
  });
});
