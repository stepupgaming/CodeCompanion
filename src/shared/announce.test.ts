import { describe, expect, it } from 'vitest';
import { markAnnounced, newAnnouncements } from './announce';
import type { TranscriptItem } from './chat';

const assistant = (id: string, text: string, streaming = false): TranscriptItem => ({
  kind: 'assistant',
  id,
  text,
  thinking: '',
  streaming,
});
const tool = (
  id: string,
  status: 'awaiting-approval' | 'running' | 'done' | 'error' | 'declined',
  summary?: string,
): TranscriptItem => ({
  kind: 'tool',
  id,
  name: 'run_command',
  status,
  summary,
  preview: { title: 'Run command' },
});

describe('newAnnouncements', () => {
  it('waits for an answer to finish and then announces it once', () => {
    const announced = new Set<string>();
    expect(newAnnouncements([assistant('a', 'Hel', true)], announced)).toEqual([]);
    expect(newAnnouncements([assistant('a', 'Hello there', false)], announced)).toEqual(['Assistant: Hello there']);
    expect(newAnnouncements([assistant('a', 'Hello there', false)], announced)).toEqual([]);
  });

  it('shortens long answers', () => {
    const [message] = newAnnouncements([assistant('a', 'x'.repeat(400))], new Set());
    expect(message).toBe(`Assistant: ${'x'.repeat(300)}…`);
  });

  it('announces approval requests and failures but not successful tools', () => {
    const announced = new Set<string>();
    expect(newAnnouncements([tool('t', 'awaiting-approval')], announced)).toEqual(['Approval needed: Run command']);
    expect(newAnnouncements([tool('t', 'running')], announced)).toEqual([]);
    expect(newAnnouncements([tool('t', 'done', 'Ran `npm test`')], announced)).toEqual([]);
    expect(newAnnouncements([tool('u', 'error', 'Ran `npm test` (exit 1)')], announced)).toEqual([
      'Failed: Ran `npm test` (exit 1)',
    ]);
  });

  it('announces errors and notices, and skips the user’s own messages and empty answers', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'hi', imageCount: 0 },
      assistant('a', '   '),
      { kind: 'error', id: 'e', text: 'Rate limited.' },
      { kind: 'notice', id: 'n', text: 'Stopped.' },
    ];
    expect(newAnnouncements(items, new Set())).toEqual(['Error: Rate limited.', 'Stopped.']);
  });

  it('can mark an opened chat as already heard', () => {
    const announced = new Set<string>();
    const items = [assistant('a', 'Old answer')];
    markAnnounced(items, announced);
    expect(newAnnouncements(items, announced)).toEqual([]);
  });
});
