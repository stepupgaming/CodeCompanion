import { describe, expect, it } from 'vitest';
import {
  applyChatEvent,
  diffNotice,
  filterChats,
  limitPreview,
  outputNotice,
  searchSnippet,
  transcriptSearchText,
  TRANSCRIPT_LIMITS,
  type ChatEvent,
  type ChatSummary,
  type TranscriptItem,
} from './chat';

const run = (events: ChatEvent[]) => events.reduce<TranscriptItem[]>(applyChatEvent, []);

describe('transcriptSearchText and searchSnippet', () => {
  it('collects only what the user and the assistant said', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'Why does login fail?', imageCount: 0 },
      { kind: 'tool', id: 't', name: 'read_file', status: 'done', output: 'secret tool output' },
      { kind: 'assistant', id: 'a', text: 'The token expires.', thinking: 'private thoughts', streaming: false },
    ];
    expect(transcriptSearchText(items)).toBe('Why does login fail?\nThe token expires.');
  });

  it('cuts a one-line excerpt around the first match', () => {
    const text = `${'a '.repeat(100)}the needle is here\n${'b '.repeat(100)}`;
    const snippet = searchSnippet(text, ['needle'])!;
    expect(snippet).toContain('the needle is here');
    expect(snippet).not.toContain('\n');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThan(200);
  });

  it('returns nothing when no word is in the text', () => {
    expect(searchSnippet('nothing here', ['needle'])).toBeUndefined();
    expect(searchSnippet('short text with word', ['word'])).toBe('short text with word');
  });
});

describe('filterChats', () => {
  const chat = (id: string, title: string, projectPath: string | null): ChatSummary => ({
    id,
    title,
    projectPath,
    updatedAt: '2026-09-30T00:00:00.000Z',
  });
  const chats = [
    chat('1', 'Fix login bug', 'D:\\code\\shop'),
    chat('2', 'Add dark mode', 'D:\\code\\blog'),
    chat('3', 'Notes', null),
  ];

  it('returns everything for a blank query', () => {
    expect(filterChats(chats, '  ')).toBe(chats);
  });

  it('matches the title or project path, ignoring case', () => {
    expect(filterChats(chats, 'LOGIN').map((c) => c.id)).toEqual(['1']);
    expect(filterChats(chats, 'blog').map((c) => c.id)).toEqual(['2']);
  });

  it('requires every word to match', () => {
    expect(filterChats(chats, 'fix shop').map((c) => c.id)).toEqual(['1']);
    expect(filterChats(chats, 'fix blog')).toEqual([]);
  });
});

describe('applyChatEvent', () => {
  it('builds a streamed assistant message and finalizes it', () => {
    const items = run([
      { type: 'assistant-start', id: 'a' },
      { type: 'assistant-delta', id: 'a', text: 'Hel' },
      { type: 'assistant-delta', id: 'a', text: 'lo' },
      { type: 'assistant-end', id: 'a', text: 'Hello.' },
    ]);
    expect(items).toEqual([{ kind: 'assistant', id: 'a', text: 'Hello.', thinking: '', streaming: false }]);
  });

  it('drops empty assistant bubbles from tool-only turns', () => {
    expect(
      run([
        { type: 'assistant-start', id: 'a' },
        { type: 'assistant-end', id: 'a', text: '' },
      ]),
    ).toEqual([]);
  });

  it('keeps streamed text when ended without final text', () => {
    const items = run([
      { type: 'assistant-start', id: 'a' },
      { type: 'assistant-delta', id: 'a', text: 'partial' },
      { type: 'assistant-end', id: 'a' },
    ]);
    expect(items[0]).toMatchObject({ text: 'partial', streaming: false });
  });

  it('tracks a tool through approval, progress and completion', () => {
    const items = run([
      {
        type: 'tool-start',
        id: 't',
        name: 'run_command',
        awaitingApproval: true,
        preview: { title: 'Run', command: 'ls' },
      },
      { type: 'tool-running', id: 't' },
      { type: 'tool-progress', id: 't', text: 'a\n' },
      { type: 'tool-progress', id: 't', text: 'b\n' },
      { type: 'tool-end', id: 't', status: 'done', summary: 'Ran ls' },
    ]);
    expect(items[0]).toMatchObject({ status: 'done', summary: 'Ran ls', output: 'a\nb\n', preview: { command: 'ls' } });
  });

  it('ignores metadata events', () => {
    expect(
      run([
        { type: 'busy', busy: true },
        { type: 'title', title: 'x' },
      ]),
    ).toEqual([]);
  });
});

describe('size limits for tool cards', () => {
  const start: ChatEvent = { type: 'tool-start', id: 't1', name: 'run_command', awaitingApproval: false };
  const tool = (items: TranscriptItem[]) => items[0] as Extract<TranscriptItem, { kind: 'tool' }>;
  const limit = TRANSCRIPT_LIMITS.outputChars;

  it('keeps short output as it is, with nothing marked as left out', () => {
    const item = tool(
      run([
        start,
        { type: 'tool-progress', id: 't1', text: 'hello\n' },
        { type: 'tool-end', id: 't1', status: 'done', summary: 's' },
      ]),
    );
    expect(item.output).toBe('hello\n');
    expect(item.outputOmittedChars).toBeUndefined();
  });

  it('keeps the end of long streamed output and counts everything left out over all chunks', () => {
    const chunks = Array.from({ length: 5 }, (_, index) => ({
      type: 'tool-progress' as const,
      id: 't1',
      text: String(index).repeat(10_000),
    }));
    const item = tool(run([start, ...chunks]));

    expect(item.output).toHaveLength(limit);
    expect(item.output!.endsWith('4'.repeat(10_000))).toBe(true);
    expect(item.outputOmittedChars).toBe(50_000 - limit);
  });

  it('counts from the final output alone when the tool reports one', () => {
    const streamed = [start, { type: 'tool-progress' as const, id: 't1', text: 'x'.repeat(50_000) }];
    const long = tool(
      run([...streamed, { type: 'tool-end', id: 't1', status: 'done', summary: 's', output: 'y'.repeat(limit + 7) }]),
    );
    expect(long.output).toBe('y'.repeat(limit));
    expect(long.outputOmittedChars).toBe(7);

    const short = tool(
      run([...streamed, { type: 'tool-end', id: 't1', status: 'done', summary: 's', output: 'done' }]),
    );
    expect(short).toMatchObject({ output: 'done' });
    expect(short.outputOmittedChars).toBeUndefined();

    // Without a final output, what streamed stays, with its count.
    const kept = tool(run([...streamed, { type: 'tool-end', id: 't1', status: 'done', summary: 's' }]));
    expect(kept.outputOmittedChars).toBe(50_000 - limit);
  });

  it('keeps the first lines of a long diff, whole lines only, and says how many are left out', () => {
    const diff = Array.from({ length: 5_000 }, (_, index) => `+line ${index}`).join('\n');
    const item = tool(
      run([
        {
          type: 'tool-start',
          id: 't1',
          name: 'write_file',
          awaitingApproval: true,
          preview: { title: 'Create a', diff },
        },
      ]),
    );

    expect(item.preview!.diff!.split('\n')).toHaveLength(TRANSCRIPT_LIMITS.diffLines);
    expect(item.preview!.diff!.split('\n').at(-1)).toBe(`+line ${TRANSCRIPT_LIMITS.diffLines - 1}`);
    expect(item.preview!.diffOmittedLines).toBe(5_000 - TRANSCRIPT_LIMITS.diffLines);
  });

  it('also cuts a diff of few but very long lines by size', () => {
    const diff = Array.from({ length: 10 }, () => `+${'z'.repeat(50_000)}`).join('\n');
    const preview = limitPreview({ title: 't', diff })!;
    expect(preview.diff!.length).toBeLessThanOrEqual(TRANSCRIPT_LIMITS.diffChars);
    expect(preview.diffOmittedLines).toBe(7);
  });

  it('keeps the start of a very long command', () => {
    const preview = limitPreview({ title: 't', command: 'echo '.repeat(10_000) })!;
    expect(preview.command).toHaveLength(TRANSCRIPT_LIMITS.commandChars);
    expect(preview.commandOmittedChars).toBe(50_000 - TRANSCRIPT_LIMITS.commandChars);
  });

  it('leaves small previews untouched', () => {
    const preview = { title: 'Edit a', diff: '-a\n+b' };
    expect(limitPreview(preview)).toBe(preview);
    expect(limitPreview(undefined)).toBeUndefined();
  });

  it('warns before approval that the hidden part is applied too', () => {
    expect(diffNotice(3000, false)).toBe('Diff too long to show in full: 3,000 more lines are not shown.');
    expect(diffNotice(3000, true)).toContain('Approving applies the whole change, including the part not shown');
    expect(outputNotice(12_345)).toBe(
      'Output too long to show in full: the first 12,345 characters are not shown, only the last 20,000.',
    );
  });
});

describe('undoing an edit', () => {
  const start: ChatEvent = { type: 'tool-start', id: 't1', name: 'edit_file', awaitingApproval: false };

  it('marks a finished edit that has a backup as undoable, and as undone after the undo', () => {
    const done = run([
      start,
      { type: 'tool-end', id: 't1', status: 'done', summary: 'Edited a.ts', path: 'a.ts', undoable: true },
    ]);
    expect(done[0]).toMatchObject({ kind: 'tool', status: 'done', undo: 'available' });

    const undone = run([
      start,
      { type: 'tool-end', id: 't1', status: 'done', summary: 'Edited a.ts', undoable: true },
      { type: 'tool-undone', id: 't1' },
    ]);
    expect(undone[0]).toMatchObject({ undo: 'undone' });
  });

  it('offers no undo without a backup, for a failed edit, or for a declined one', () => {
    expect(run([start, { type: 'tool-end', id: 't1', status: 'done', summary: 's' }])[0]).not.toHaveProperty('undo');
    expect(
      run([start, { type: 'tool-end', id: 't1', status: 'error', summary: 's', undoable: true }])[0],
    ).not.toHaveProperty('undo');
    expect(
      run([start, { type: 'tool-end', id: 't1', status: 'declined', summary: 's', undoable: true }])[0],
    ).not.toHaveProperty('undo');
  });

  it('only marks an edit that could be undone, and leaves other items alone', () => {
    const items = run([
      start,
      { type: 'tool-end', id: 't1', status: 'done', summary: 's' },
      { type: 'user', id: 'u1', text: 'hi', imageCount: 0 },
    ]);
    expect(applyChatEvent(items, { type: 'tool-undone', id: 't1' })).toEqual(items);
    expect(applyChatEvent(items, { type: 'tool-undone', id: 'u1' })).toEqual(items);
    expect(applyChatEvent(items, { type: 'tool-undone', id: 'missing' })).toEqual(items);
  });
});
