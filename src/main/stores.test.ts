import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedChat } from './agent/session';
import { ChatStore } from './chat_store';
import { ProjectStore } from './projects';

let dir: string;

beforeEach(() => {
  // Resolved, because ProjectStore keeps real paths: on macOS the temp folder /var/... is a link to /private/var/...,
  // and looking a project up by the unresolved path would not find it.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-stores-')));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function chat(id: string, updatedAt: string): SavedChat {
  return {
    version: 1,
    id,
    title: `Chat ${id.slice(0, 4)}`,
    projectPath: null,
    createdAt: updatedAt,
    updatedAt,
    system: 's',
    transcript: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    conversation: { provider: 'anthropic', model: 'm', messages: [] },
    readFiles: [],
  };
}

const idA = '11111111-1111-1111-1111-111111111111';
const idB = '22222222-2222-2222-2222-222222222222';

describe('ChatStore', () => {
  it('saves, lists newest first, loads and deletes', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    store.save(chat(idB, '2026-02-01T00:00:00Z'));
    expect(store.list().map((item) => item.id)).toEqual([idB, idA]);
    expect(store.load(idA)?.title).toBe('Chat 1111');

    store.delete(idB);
    expect(new ChatStore(join(dir, 'chats')).list().map((item) => item.id)).toEqual([idA]);
  });

  it('searches titles, projects and message text, and explains message matches', () => {
    const store = new ChatStore(join(dir, 'chats'));
    const first = {
      ...chat(idA, '2026-01-01T00:00:00Z'),
      title: 'Fix login',
      transcript: [
        { kind: 'user' as const, id: 'u1', text: 'The refresh token is rejected by the API', imageCount: 0 },
        {
          kind: 'tool' as const,
          id: 't1',
          name: 'read_file',
          status: 'done' as const,
          output: 'only in tool output: zebra',
        },
      ],
    };
    const second = { ...chat(idB, '2026-02-01T00:00:00Z'), title: 'Dark mode', projectPath: 'D:\\code\\blog' };
    store.save(first);
    store.save(second);

    expect(store.search('   ').map((item) => item.id)).toEqual([idB, idA]);
    // A title match has no snippet; a message match carries an excerpt.
    expect(store.search('fix')).toEqual([expect.not.objectContaining({ snippet: expect.anything() })]);
    const [byMessage] = store.search('refresh token');
    expect(byMessage!.id).toBe(idA);
    expect(byMessage!.snippet).toContain('refresh token is rejected');
    // Words may be split between the title and the messages; tool output is not searched.
    expect(store.search('login rejected').map((item) => item.id)).toEqual([idA]);
    expect(store.search('zebra')).toEqual([]);
    expect(store.search('blog').map((item) => item.id)).toEqual([idB]);
  });

  it('forgets cached text when a chat changes or is deleted', () => {
    const store = new ChatStore(join(dir, 'chats'));
    const base = chat(idA, '2026-01-01T00:00:00Z');
    store.save({ ...base, transcript: [{ kind: 'user', id: 'u', text: 'alpha', imageCount: 0 }] });
    expect(store.search('alpha')).toHaveLength(1);
    store.save({
      ...base,
      updatedAt: '2026-01-02T00:00:00Z',
      transcript: [{ kind: 'user', id: 'u', text: 'beta', imageCount: 0 }],
    });
    expect(store.search('alpha')).toHaveLength(0);
    expect(store.search('beta')).toHaveLength(1);
    store.delete(idA);
    expect(store.search('beta')).toHaveLength(0);
  });

  it('rejects ids that are not UUIDs', () => {
    const store = new ChatStore(join(dir, 'chats'));
    expect(store.load('../settings')).toBeNull();
  });

  it('rebuilds a missing index from the chat files', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    rmSync(join(dir, 'chats', 'index.json'));
    expect(new ChatStore(join(dir, 'chats')).list().map((item) => item.id)).toEqual([idA]);
  });

  it('replaces a chat that is saved again instead of listing it twice', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    store.save({ ...chat(idA, '2026-01-02T00:00:00Z'), title: 'Renamed' });

    expect(store.list()).toEqual([
      // Model 'm' has no known price.
      { id: idA, title: 'Renamed', projectPath: null, updatedAt: '2026-01-02T00:00:00Z', cost: null },
    ]);
    expect(new ChatStore(join(dir, 'chats')).load(idA)?.title).toBe('Renamed');
  });

  it('returns null for chats that are missing or saved by another version', () => {
    const store = new ChatStore(join(dir, 'chats'));
    expect(store.load(idB)).toBeNull();
    writeFileSync(
      join(dir, 'chats', `${idB}.json`),
      JSON.stringify({ ...chat(idB, '2026-01-01T00:00:00Z'), version: 2 }),
    );
    expect(store.load(idB)).toBeNull();
    writeFileSync(join(dir, 'chats', `${idB}.json`), '{ not json');
    expect(store.load(idB)).toBeNull();
  });

  it('ignores delete requests for ids that are not UUIDs', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    store.delete('../chats/index');
    store.delete('index');
    expect(existsSync(join(dir, 'chats', 'index.json'))).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it('deletes every chat and its file', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save(chat(idA, '2026-01-01T00:00:00Z'));
    store.save(chat(idB, '2026-02-01T00:00:00Z'));
    store.deleteAll();

    expect(store.list()).toEqual([]);
    expect(store.search('chat')).toEqual([]);
    expect(store.load(idA)).toBeNull();
    expect(existsSync(join(dir, 'chats', `${idA}.json`))).toBe(false);
    expect(existsSync(join(dir, 'chats', `${idB}.json`))).toBe(false);
    expect(new ChatStore(join(dir, 'chats')).list()).toEqual([]);
  });

  it('requires every word to match and ignores case when searching', () => {
    const store = new ChatStore(join(dir, 'chats'));
    store.save({
      ...chat(idA, '2026-01-01T00:00:00Z'),
      title: 'Fix Login',
      projectPath: 'D:\\code\\Shop',
      transcript: [{ kind: 'user', id: 'u', text: 'Refresh TOKEN expired', imageCount: 0 }],
    });

    expect(store.search('FIX shop').map((item) => item.id)).toEqual([idA]);
    expect(store.search('token REFRESH').map((item) => item.id)).toEqual([idA]);
    expect(store.search('fix missing')).toEqual([]);
    expect(store.search('token missing')).toEqual([]);
  });

  it('rebuilds the index without corrupt, unsupported or foreign files', () => {
    const chats = join(dir, 'chats');
    mkdirSync(chats);
    const idC = '33333333-3333-3333-3333-333333333333';
    const idD = '44444444-4444-4444-4444-444444444444';
    writeFileSync(join(chats, `${idA}.json`), JSON.stringify(chat(idA, '2026-01-01T00:00:00Z')));
    writeFileSync(join(chats, `${idB}.json`), '{ truncated');
    writeFileSync(join(chats, `${idC}.json`), JSON.stringify({ ...chat(idC, '2026-01-02T00:00:00Z'), version: 2 }));
    writeFileSync(join(chats, 'notes.json'), JSON.stringify(chat(idD, '2026-01-03T00:00:00Z')));

    const store = new ChatStore(chats);
    expect(store.list().map((item) => item.id)).toEqual([idA]);
    // The recovered index is written back, so the next start does not have to scan the folder.
    rmSync(join(chats, `${idA}.json`));
    expect(new ChatStore(chats).list().map((item) => item.id)).toEqual([idA]);
  });

  it('lists the estimated cost of each chat, updated on every save', () => {
    const store = new ChatStore(join(dir, 'chats'));
    const opus = (usage: SavedChat['usage']) => ({
      ...chat(idA, '2026-01-01T00:00:00Z'),
      usage,
      conversation: { provider: 'anthropic' as const, model: 'claude-opus-5-5', messages: [] },
    });
    // Opus 5.5: $4 per million input tokens, $20 per million output tokens.
    store.save(opus({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    expect(store.list()[0]!.cost).toBeCloseTo(4);
    store.save(opus({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }));
    expect(store.list()[0]!.cost).toBeCloseTo(6);
    expect(new ChatStore(join(dir, 'chats')).list()[0]!.cost).toBeCloseTo(6);
  });

  it('lists no cost for unknown models and custom endpoints', () => {
    const store = new ChatStore(join(dir, 'chats'));
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const gpt = { provider: 'openai' as const, model: 'gpt-6-sol', messages: [] };
    store.save({ ...chat(idA, '2026-01-01T00:00:00Z'), usage });
    store.save({
      ...chat(idB, '2026-01-02T00:00:00Z'),
      usage,
      officialPricing: false,
      conversation: { ...gpt, api: 'responses' },
    });
    expect(store.list().map((item) => item.cost)).toEqual([null, null]);

    // Saved before officialPricing existed: OpenAI's own API is priced, Chat Completions (a custom endpoint) is not.
    store.save({ ...chat(idA, '2026-01-03T00:00:00Z'), usage, conversation: { ...gpt, api: 'responses' } });
    store.save({ ...chat(idB, '2026-01-04T00:00:00Z'), usage, conversation: { ...gpt, api: 'chat' } });
    expect(store.list().map((item) => item.cost)).toEqual([null, 2]);
  });

  it('corrects legacy OpenAI usage the way a reopened chat does', () => {
    const store = new ChatStore(join(dir, 'chats'));
    // Older totals counted the 500k cache reads in the input as well.
    const usage = { inputTokens: 1_500_000, outputTokens: 0, cacheReadTokens: 500_000 };
    store.save({
      ...chat(idA, '2026-01-01T00:00:00Z'),
      usage,
      conversation: { provider: 'openai', api: 'responses', model: 'gpt-6-sol', messages: [] },
    });
    // 1M input at $2 plus 500k cache reads at $0.20.
    expect(store.list()[0]!.cost).toBeCloseTo(2.1);
  });

  it('adds costs to an index written by an older version', () => {
    const chats = join(dir, 'chats');
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    new ChatStore(chats).save({
      ...chat(idA, '2026-01-01T00:00:00Z'),
      usage,
      conversation: { provider: 'anthropic', model: 'claude-opus-5-5', messages: [] },
    });
    writeFileSync(
      join(chats, 'index.json'),
      JSON.stringify([{ id: idA, title: 'Old', projectPath: null, updatedAt: '2026-01-01T00:00:00Z' }]),
    );

    expect(new ChatStore(chats).list()[0]!.cost).toBeCloseTo(4);
  });

  it('starts empty and writes no index for an empty folder', () => {
    const store = new ChatStore(join(dir, 'chats'));
    expect(store.list()).toEqual([]);
    expect(existsSync(join(dir, 'chats', 'index.json'))).toBe(false);
  });
});

describe('ProjectStore', () => {
  it('opens folders, remembers instructions and keeps recent projects', () => {
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const file = join(dir, 'projects.json');

    const store = new ProjectStore(file);
    store.open(one);
    const second = store.open(two);
    store.setInstructions(second.path, 'Use pnpm.');

    const reloaded = new ProjectStore(file);
    expect(reloaded.list().map((project) => project.name)).toEqual(['two', 'one']);
    expect(reloaded.list()[0]!.instructions).toBe('Use pnpm.');
    expect(reloaded.current()).toBeNull();
  });

  it('orders tied timestamps by the newest open, including reopening and reload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const file = join(dir, 'projects.json');

    const store = new ProjectStore(file);
    store.open(one);
    store.open(two);
    expect(store.list().map((project) => project.name)).toEqual(['two', 'one']);
    expect(store.list().map((project) => project.lastOpened)).toEqual([
      '2026-03-01T12:00:00.000Z',
      '2026-03-01T12:00:00.000Z',
    ]);
    expect(new ProjectStore(file).list().map((project) => project.name)).toEqual(['two', 'one']);

    store.open(one);
    expect(store.list().map((project) => project.name)).toEqual(['one', 'two']);
    expect(new ProjectStore(file).list().map((project) => project.name)).toEqual(['one', 'two']);
  });

  it('rejects paths that are not folders', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    writeFileSync(join(dir, 'file.txt'), '');
    expect(() => store.open(join(dir, 'file.txt'))).toThrow(/Folder not found/);
    expect(() => store.open(join(dir, 'missing'))).toThrow(/Folder not found/);
  });

  it('persists instructions for open projects beyond the recent-project limit', () => {
    const file = join(dir, 'projects.json');
    const store = new ProjectStore(file);
    for (let index = 0; index < 21; index++) {
      const path = join(dir, `project-${index}`);
      mkdirSync(path);
      store.open(path);
    }
    const first = join(dir, 'project-0');
    store.setInstructions(first, 'Keep the original project instructions');
    expect(new ProjectStore(file).open(first).instructions).toBe('Keep the original project instructions');
    expect(store.opened()).toHaveLength(21);
  });

  it('tracks open projects independently of recent order and closes without deleting history', () => {
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const store = new ProjectStore(join(dir, 'projects.json'));
    store.open(one);
    store.open(two);
    store.open(one);
    expect(store.opened().map((project) => project.name)).toEqual(['one', 'two']);
    store.close(two);
    expect(store.current()?.name).toBe('one');
    store.open(two);
    store.close(two);
    expect(store.current()?.name).toBe('one');
    expect(store.list()).toHaveLength(2);
    store.close(one);
    expect(store.current()).toBeNull();
    expect(store.opened()).toEqual([]);
  });

  it('makes another open project current when the current one is closed', () => {
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const store = new ProjectStore(join(dir, 'projects.json'));
    store.open(one);
    const second = store.open(two);
    expect(store.current()?.name).toBe('two');
    store.close(second.path);
    expect(store.current()?.name).toBe('one');
  });

  it('keeps instructions and a single entry when a project is opened again by another spelling of its path', () => {
    const one = join(dir, 'one');
    mkdirSync(one);
    const store = new ProjectStore(join(dir, 'projects.json'));
    const first = store.open(one);
    store.setInstructions(first.path, 'Run the tests first.');

    const again = store.open(join(one, '..', 'one', '.'));
    expect(again.path).toBe(first.path);
    expect(again.instructions).toBe('Run the tests first.');
    expect(store.list()).toHaveLength(1);
  });

  it('removes a project from the list, the open projects and the saved file', () => {
    const one = join(dir, 'one');
    const two = join(dir, 'two');
    mkdirSync(one);
    mkdirSync(two);
    const file = join(dir, 'projects.json');
    const store = new ProjectStore(file);
    const first = store.open(one);
    store.open(two);

    store.remove(first.path);
    expect(store.list().map((project) => project.name)).toEqual(['two']);
    expect(store.opened().map((project) => project.name)).toEqual(['two']);
    expect(new ProjectStore(file).list().map((project) => project.name)).toEqual(['two']);
    expect(() => store.setInstructions(first.path, 'gone')).toThrow(/Unknown project/);
  });

  it("stores a project's own allow-lists with its instructions, and keeps them after a reload", () => {
    const one = join(dir, 'one');
    mkdirSync(one);
    const file = join(dir, 'projects.json');
    const store = new ProjectStore(file);
    const opened = store.open(one);

    const updated = store.updateSettings(opened.path, {
      instructions: 'Use pnpm.',
      allowedCommands: '  pnpm test\npnpm lint  ',
      allowedNetworkHosts: 'localhost\n',
    });
    expect(updated).toMatchObject({
      instructions: 'Use pnpm.',
      allowedCommands: 'pnpm test\npnpm lint',
      allowedNetworkHosts: 'localhost',
    });
    expect(store.get(opened.path)).toMatchObject({ allowedCommands: 'pnpm test\npnpm lint' });
    expect(new ProjectStore(file).get(opened.path)).toMatchObject({
      instructions: 'Use pnpm.',
      allowedNetworkHosts: 'localhost',
    });
    // setInstructions leaves the lists alone.
    store.setInstructions(opened.path, 'Use bun.');
    expect(store.get(opened.path)).toMatchObject({ instructions: 'Use bun.', allowedCommands: 'pnpm test\npnpm lint' });
  });

  it('accepts only text for project settings, capped in size, and nothing else from the caller', () => {
    const one = join(dir, 'one');
    mkdirSync(one);
    const store = new ProjectStore(join(dir, 'projects.json'));
    const opened = store.open(one);

    for (const bad of [
      null,
      {},
      { instructions: 'x', allowedCommands: 5, allowedNetworkHosts: '' },
      { instructions: 'x', allowedCommands: '' },
    ]) {
      expect(() => store.updateSettings(opened.path, bad as never)).toThrow(/Invalid project setting/);
    }
    const updated = store.updateSettings(opened.path, {
      instructions: 'i'.repeat(60_000),
      allowedCommands: '',
      allowedNetworkHosts: '',
      path: '/elsewhere',
      name: 'renamed',
    } as never);
    expect(updated.instructions).toHaveLength(50_000);
    expect(updated.path).toBe(opened.path);
    expect(updated.name).toBe('one');
  });

  it('reads projects saved before the allow-lists existed, and knows nothing of other paths', () => {
    const file = join(dir, 'projects.json');
    const one = join(dir, 'one');
    writeFileSync(
      file,
      JSON.stringify([{ path: one, name: 'one', instructions: 'old', lastOpened: '2026-01-01T00:00:00.000Z' }]),
    );
    const store = new ProjectStore(file);
    expect(store.get(one)?.allowedCommands).toBeUndefined();
    expect(store.get(join(dir, 'unknown'))).toBeNull();
  });

  it('rejects instructions for a project it does not know', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    expect(() => store.setInstructions(join(dir, 'unknown'), 'text')).toThrow(/Unknown project/);
  });

  it('hands out copies so callers cannot change the stored projects', () => {
    const one = join(dir, 'one');
    mkdirSync(one);
    const store = new ProjectStore(join(dir, 'projects.json'));
    const opened = store.open(one);
    opened.instructions = 'changed by caller';
    store.opened()[0]!.instructions = 'changed by caller';
    expect(store.current()?.instructions).toBe('');
    expect(store.list()[0]!.instructions).toBe('');
  });

  it('forgets the oldest closed projects beyond the recent limit', () => {
    const store = new ProjectStore(join(dir, 'projects.json'));
    for (let index = 0; index < 25; index++) {
      const path = join(dir, `project-${index}`);
      mkdirSync(path);
      store.close(store.open(path).path);
    }
    const names = store.list().map((project) => project.name);
    expect(names).toHaveLength(20);
    expect(names[0]).toBe('project-24');
    expect(names).not.toContain('project-0');
  });

  it('starts empty when the saved file is missing or corrupt and skips malformed entries', () => {
    const file = join(dir, 'projects.json');
    expect(new ProjectStore(file).list()).toEqual([]);

    writeFileSync(file, '{ not json');
    expect(new ProjectStore(file).list()).toEqual([]);

    const valid = { path: join(dir, 'ok'), name: 'ok', instructions: '', lastOpened: '2026-01-01T00:00:00.000Z' };
    writeFileSync(file, JSON.stringify([null, { name: 'no path' }, { path: 5 }, valid]));
    expect(new ProjectStore(file).list()).toEqual([valid]);
  });
});
