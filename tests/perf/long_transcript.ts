// A realistic long chat for the performance measurements: per turn, a request, an answer with markdown and a code
// block, a read, an edit with a diff, and a short reply (5 items).
import type { TranscriptItem } from '../../src/shared/chat';

export function code(turn: number): string {
  return Array.from(
    { length: 25 },
    (_, line) => `  const value${line} = compute(${turn}, ${line}); // step ${line}`,
  ).join('\n');
}

function diff(turn: number): string {
  const lines = Array.from({ length: 15 }, (_, line) => [
    `-  old line ${line} of file ${turn}`,
    `+  new line ${line} of file ${turn}`,
  ]).flat();
  return [`--- a/src/file${turn}.ts`, `+++ b/src/file${turn}.ts`, '@@ -1,15 +1,15 @@', ...lines].join('\n');
}

export function transcript(turns: number): TranscriptItem[] {
  return Array.from({ length: turns }, (_, turn): TranscriptItem[] => [
    { kind: 'user', id: `u${turn}`, text: `Please update file ${turn} and explain what changes.`, imageCount: 0 },
    {
      kind: 'assistant',
      id: `a${turn}`,
      text: `Here is the plan for **file ${turn}**:\n\n1. Read it\n2. Change the loop\n3. Run the tests\n\n\`\`\`ts\nfunction update${turn}() {\n${code(turn)}\n}\n\`\`\`\n\nThis keeps the behaviour the same.`,
      thinking: '',
      streaming: false,
    },
    {
      kind: 'tool',
      id: `r${turn}`,
      name: 'read_file',
      status: 'done',
      summary: `Read src/file${turn}.ts (120 lines)`,
      path: `src/file${turn}.ts`,
    },
    {
      kind: 'tool',
      id: `e${turn}`,
      name: 'edit_file',
      status: 'done',
      summary: `Edited src/file${turn}.ts`,
      path: `src/file${turn}.ts`,
      preview: { title: `Edit src/file${turn}.ts`, diff: diff(turn) },
    },
    { kind: 'assistant', id: `b${turn}`, text: `Done with file ${turn}.`, thinking: '', streaming: false },
  ]).flat();
}

// A 20,000-character answer with prose and code blocks, streamed like a model would.
export const ANSWER = Array.from(
  { length: 20 },
  (_, part) =>
    `### Part ${part}\n\nSome explanation of part ${part} with \`inline code\` and a list:\n\n- one\n- two\n\n\`\`\`ts\n${code(part).slice(0, 700)}\n\`\`\`\n\n`,
)
  .join('')
  .slice(0, 20_000);
