// Manual "compact chat": old turns are replaced, in what is sent to the model, by a summary. The stored history is
// never edited or shortened (it stays append-only, and a chat file keeps every message). A CompactionState only says
// "send the summary, then the messages from keepFrom on", and a later compaction moves keepFrom forward.

export interface CompactionState {
  summary: string;
  // Index into the stored messages of the first message that is still sent as it was.
  keepFrom: number;
}

// What the summarizer is given and what applying its answer will do.
export interface CompactionPlan {
  // The old turns as plain text, ready for the summarizer.
  text: string;
  // How many stored messages the summary will replace.
  messages: number;
  keepFrom: number;
}

// Roughly the last 10k tokens stay as they were, so the model keeps the exact state of what it was just doing.
const KEEP_TAIL_CHARS = 40_000;
// Below this there is nothing worth summarizing.
const MIN_HEAD_CHARS = 8_000;
// The summarizer has a context window too. Past this the middle of the old turns is left out of what it reads.
const MAX_SUMMARY_INPUT_CHARS = 300_000;
// How much of each part of an old turn the summarizer is shown.
export const MAX_TOOL_RESULT_CHARS = 1_500;
export const MAX_TOOL_INPUT_CHARS = 600;
export const MAX_TEXT_CHARS = 6_000;

// The provider-specific parts of planning: where the history may be cut, and how a message reads as text.
export interface CompactionAdapter<T> {
  // True when the history can start at this message without separating a tool call from its result.
  safeCut(message: T, index: number, all: T[]): boolean;
  describe(message: T): string[];
}

export function planCompaction<T>(
  messages: T[],
  state: CompactionState | null,
  adapter: CompactionAdapter<T>,
): CompactionPlan | null {
  const start = state?.keepFrom ?? 0;
  const sizes = messages.map(estimateChars);

  // Latest safe cut that still leaves KEEP_TAIL_CHARS after it.
  let tail = 0;
  let cut = -1;
  for (let index = messages.length - 1; index > start; index--) {
    tail += sizes[index] ?? 0;
    if (tail >= KEEP_TAIL_CHARS && adapter.safeCut(messages[index]!, index, messages)) {
      cut = index;
      break;
    }
  }
  if (cut <= start + 1) return null;

  const head = sizes.slice(start, cut).reduce((sum, size) => sum + size, 0);
  if (head < MIN_HEAD_CHARS) return null;

  const lines = messages.slice(start, cut).flatMap((message) => adapter.describe(message));
  return { text: summaryInput(state?.summary ?? null, lines), messages: cut - start, keepFrom: cut };
}

// Checks an answer before it is stored: the cut must move forward and stay inside the history.
export function nextState(
  state: CompactionState | null,
  messageCount: number,
  summary: string,
  keepFrom: number,
): CompactionState {
  const text = summary.trim();
  if (!text) throw new Error('The summary was empty.');
  if (keepFrom <= (state?.keepFrom ?? 0) || keepFrom >= messageCount) {
    throw new Error('The chat changed while it was being summarized.');
  }
  return { summary: text, keepFrom };
}

// The summary as it is shown to the model, in place of the turns it replaces.
export function summaryNote(summary: string): string {
  return `Summary of the earlier part of this conversation (those messages were compacted to save space):\n\n${summary}`;
}

export function compactionPrompt(text: string): string {
  return [
    'Summarize the earlier part of a coding assistant conversation so the assistant can continue the work with only',
    'your summary and the most recent messages. Keep everything it would otherwise have to rediscover:',
    "- the user's goal and every instruction, preference and constraint they gave",
    '- decisions made and why',
    '- files created, changed or read (with paths) and what was done to them',
    '- commands that were run and what they showed, including failures and their causes',
    '- what is finished, what is in progress, and what still has to be done',
    '- names, paths, numbers and other exact details that will be needed again',
    'Write it as plain text notes, at most about 1,500 words. Do not address the user and do not add advice.',
    '',
    'Conversation:',
    '',
    text,
  ].join('\n');
}

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text;
}

// Base64 image data would dominate the size while costing far fewer tokens than its length suggests.
export function estimateChars(message: unknown): number {
  return JSON.stringify(message, (key, value) => {
    if (typeof value !== 'string' || value.length < 2_000) return value;
    return key === 'data' || value.startsWith('data:') ? '[image]'.padEnd(1_500) : value;
  }).length;
}

function summaryInput(previousSummary: string | null, lines: string[]): string {
  const parts = [...(previousSummary ? [summaryNote(previousSummary)] : []), ...lines];
  const text = parts.join('\n');
  if (text.length <= MAX_SUMMARY_INPUT_CHARS) return text;
  const half = Math.floor(MAX_SUMMARY_INPUT_CHARS / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - MAX_SUMMARY_INPUT_CHARS} characters from the middle are left out …]\n\n${text.slice(-half)}`;
}
