import { describe, expect, it } from 'vitest';
import type { ChatSnapshot } from './chat';
import { chatToMarkdown, exportFileName } from './export';

const chat = (transcript: ChatSnapshot['transcript']): ChatSnapshot => ({
  id: '1',
  title: 'Fix the login bug',
  projectPath: 'D:\\code\\shop',
  model: 'claude-test',
  transcript,
  busy: false,
  resumable: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  agentFile: null,
});

describe('chatToMarkdown', () => {
  it('writes the header and both sides of the conversation', () => {
    const markdown = chatToMarkdown(
      chat([
        { kind: 'user', id: 'u', text: 'Why does login fail?', imageCount: 2 },
        { kind: 'assistant', id: 'a', text: 'The token expires.', thinking: 'hidden reasoning', streaming: false },
      ]),
    );
    expect(markdown).toBe(
      [
        '# Fix the login bug',
        '',
        '- Project: `D:\\code\\shop`',
        '- Model: claude-test',
        '',
        '## You',
        '',
        'Why does login fail?',
        '',
        '_(2 images attached)_',
        '',
        '## Assistant',
        '',
        'The token expires.',
        '',
      ].join('\n'),
    );
    expect(markdown).not.toContain('hidden reasoning');
  });

  it('shows tools with their command or diff and marks failures', () => {
    const markdown = chatToMarkdown(
      chat([
        {
          kind: 'tool',
          id: 't1',
          name: 'run_command',
          status: 'done',
          summary: 'Ran `npm test` (exit 0)',
          preview: { title: 'Run command', command: 'npm test' },
          output: 'lots of output',
        },
        {
          kind: 'tool',
          id: 't2',
          name: 'edit_file',
          status: 'declined',
          summary: 'Edited a.ts',
          preview: { title: 'Edit a.ts', diff: '-old\n+new\n' },
        },
        { kind: 'error', id: 'e', text: 'Rate limited.' },
      ]),
    );
    expect(markdown).toContain('> **run_command**: Ran `npm test` (exit 0)\n\n```sh\nnpm test\n```');
    expect(markdown).toContain('> **edit_file**: Edited a.ts (declined)\n\n```diff\n-old\n+new\n```');
    expect(markdown).toContain('> **Error:** Rate limited.');
    expect(markdown).not.toContain('lots of output');
  });

  it('marks an edit that was undone', () => {
    const markdown = chatToMarkdown(
      chat([
        {
          kind: 'tool',
          id: 't1',
          name: 'edit_file',
          status: 'done',
          summary: 'Edited a.ts',
          undo: 'undone',
          preview: { title: 'Edit a.ts', diff: '-a\n+b' },
        },
      ]),
    );
    expect(markdown).toContain('> **edit_file**: Edited a.ts (undone)');
  });

  it('says when a diff or command was too long to keep in full', () => {
    const markdown = chatToMarkdown(
      chat([
        {
          kind: 'tool',
          id: 't1',
          name: 'write_file',
          status: 'done',
          preview: {
            title: 'Create big.txt',
            diff: '+a',
            diffOmittedLines: 5000,
            command: 'x',
            commandOmittedChars: 12,
          },
        },
      ]),
    );
    expect(markdown).toContain('_(Diff too long to show in full: 5,000 more lines are not shown.)_');
    expect(markdown).toContain('_(Command too long to show in full: the last 12 characters are not shown.)_');
  });

  it('uses a longer fence when the content contains backticks', () => {
    const markdown = chatToMarkdown(
      chat([
        { kind: 'tool', id: 't', name: 'run_command', status: 'done', preview: { title: 'x', command: 'echo ```' } },
      ]),
    );
    expect(markdown).toContain('````sh\necho ```\n````');
  });
});

describe('exportFileName', () => {
  it('removes characters that are not allowed in file names', () => {
    expect(exportFileName('Fix: login/logout <bug>?')).toBe('Fix login logout bug.md');
  });

  it('falls back when nothing is left', () => {
    expect(exportFileName('???')).toBe('chat.md');
  });
});
