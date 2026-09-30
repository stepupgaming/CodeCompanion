import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditBackups } from './edit_backups';
import { sha256 } from './text_files';
import { Workspace } from './workspace';

const chatId = '11111111-1111-1111-1111-111111111111';
const otherChat = '22222222-2222-2222-2222-222222222222';

let root: string;
let backups: EditBackups;
let workspace: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-undo-'));
  mkdirSync(join(root, 'project', 'src'), { recursive: true });
  workspace = new Workspace(join(root, 'project'));
  backups = new EditBackups(join(root, 'edit-backups'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project = (...parts: string[]) => join(root, 'project', ...parts);

// Records an edit the way the tools report it: the file now has `after`, and `before` is what it had.
function edit(toolId: string, path: string, before: Buffer | string | null, after: string, chat = chatId): void {
  writeFileSync(project(path), after);
  backups.record(chat, toolId, {
    path,
    before: before === null ? null : Buffer.from(before),
    afterHash: sha256(after),
  });
}

describe('EditBackups', () => {
  it('puts back the previous content of an edited file', async () => {
    edit('t1', 'src/a.ts', 'const a = 1;\n', 'const a = 2;\n');

    const result = await backups.undo(chatId, 't1', workspace);

    expect(result).toMatchObject({ path: 'src/a.ts', action: 'restored' });
    expect(result.absolute).toBe(workspace.resolve('src/a.ts'));
    expect(readFileSync(project('src', 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('deletes a file that the edit created', async () => {
    edit('t1', 'src/new.ts', null, 'export {};\n');

    const result = await backups.undo(chatId, 't1', workspace);

    expect(result).toMatchObject({ path: 'src/new.ts', action: 'deleted' });
    expect(existsSync(project('src', 'new.ts'))).toBe(false);
  });

  it('restores the exact bytes, including a file that was not valid UTF-8 and CRLF line ends', async () => {
    const bytes = Buffer.from([0x63, 0x6f, 0x6e, 0xff, 0xfe, 0x0d, 0x0a, 0x73, 0x74]);
    edit('t1', 'src/legacy.txt', bytes, 'utf8 now\n');

    await backups.undo(chatId, 't1', workspace);

    expect(readFileSync(project('src', 'legacy.txt')).equals(bytes)).toBe(true);
  });

  it('refuses when the file was changed after the edit, and leaves it alone', async () => {
    edit('t1', 'src/a.ts', 'one\n', 'two\n');
    writeFileSync(project('src', 'a.ts'), 'two\nand the user added this\n');

    await expect(backups.undo(chatId, 't1', workspace)).rejects.toThrow(/was changed after this edit/);

    expect(readFileSync(project('src', 'a.ts'), 'utf8')).toBe('two\nand the user added this\n');
    // The backup is still there for when the file is as the edit left it.
    writeFileSync(project('src', 'a.ts'), 'two\n');
    await expect(backups.undo(chatId, 't1', workspace)).resolves.toMatchObject({ action: 'restored' });
  });

  it('only undoes an earlier edit after the later ones on the same file are undone', async () => {
    edit('first', 'src/a.ts', 'v0\n', 'v1\n');
    edit('second', 'src/a.ts', 'v1\n', 'v2\n');

    await expect(backups.undo(chatId, 'first', workspace)).rejects.toThrow(/changed after this edit/);
    await backups.undo(chatId, 'second', workspace);
    expect(readFileSync(project('src', 'a.ts'), 'utf8')).toBe('v1\n');
    await backups.undo(chatId, 'first', workspace);
    expect(readFileSync(project('src', 'a.ts'), 'utf8')).toBe('v0\n');
  });

  it('refuses to restore a file that was deleted after the edit, but accepts that a created file is already gone', async () => {
    edit('edited', 'src/a.ts', 'one\n', 'two\n');
    edit('created', 'src/new.ts', null, 'x\n');
    rmSync(project('src', 'a.ts'));
    rmSync(project('src', 'new.ts'));

    await expect(backups.undo(chatId, 'edited', workspace)).rejects.toThrow(/was deleted after this edit/);
    await expect(backups.undo(chatId, 'created', workspace)).resolves.toMatchObject({ action: 'deleted' });
  });

  it('can be used once', async () => {
    edit('t1', 'src/a.ts', 'one\n', 'two\n');
    await backups.undo(chatId, 't1', workspace);
    await expect(backups.undo(chatId, 't1', workspace)).rejects.toThrow(/no longer available/);
  });

  it('has no backup for an unknown edit, another chat or an invalid chat id', async () => {
    edit('t1', 'src/a.ts', 'one\n', 'two\n');
    await expect(backups.undo(chatId, 'nope', workspace)).rejects.toThrow(/no longer available/);
    await expect(backups.undo(otherChat, 't1', workspace)).rejects.toThrow(/no longer available/);
    await expect(backups.undo('../evil', 't1', workspace)).rejects.toThrow(/no longer available/);
    expect(() => backups.record('../evil', 't1', { path: 'a', before: null, afterHash: 'x' })).toThrow(
      /Invalid chat id/,
    );
  });

  it('never leaves the project, even if a backup file was tampered with', async () => {
    writeFileSync(join(root, 'outside.txt'), 'outside');
    backups.record(chatId, 't1', {
      path: '../outside.txt',
      before: Buffer.from('changed'),
      afterHash: sha256('outside'),
    });

    await expect(backups.undo(chatId, 't1', workspace)).rejects.toThrow(/outside the project/);
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('outside');
  });

  it('ignores a backup file that is damaged', async () => {
    edit('t1', 'src/a.ts', 'one\n', 'two\n');
    const folder = join(root, 'edit-backups', chatId);
    const [file] = readdirSync(folder);
    writeFileSync(join(folder, file!), '{ not json');

    await expect(backups.undo(chatId, 't1', workspace)).rejects.toThrow(/no longer available/);
    expect(readFileSync(project('src', 'a.ts'), 'utf8')).toBe('two\n');
  });

  it('stores backups under a hash of the id, since the id comes from the model', () => {
    backups.record(chatId, '../../../etc/passwd', { path: 'a', before: null, afterHash: 'x' });
    backups.record(chatId, 'toolu_01ABC', { path: 'b', before: null, afterHash: 'y' });

    const names = readdirSync(join(root, 'edit-backups', chatId));
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{40}\.json$/);
    expect(readdirSync(root)).not.toContain('etc');
  });

  it('keeps the newest 50 backups of a chat', async () => {
    const fileOf = (toolId: string) =>
      join(root, 'edit-backups', chatId, `${createHash('sha256').update(toolId).digest('hex').slice(0, 40)}.json`);
    for (let index = 0; index < 55; index++) {
      writeFileSync(project('src', `f${index}.ts`), 'after');
      backups.record(chatId, `t${index}`, {
        path: `src/f${index}.ts`,
        before: Buffer.from('before'),
        afterHash: sha256('after'),
      });
      // Distinct modification times in the past, so which backup is the oldest is well defined.
      const when = new Date(2026, 0, 1, 0, 0, index);
      utimesSync(fileOf(`t${index}`), when, when);
    }

    expect(readdirSync(join(root, 'edit-backups', chatId))).toHaveLength(50);
    await expect(backups.undo(chatId, 't54', workspace)).resolves.toMatchObject({ action: 'restored' });
    await expect(backups.undo(chatId, 't0', workspace)).rejects.toThrow(/no longer available/);
  });

  it('deletes the backups of one chat, or of all chats', async () => {
    edit('t1', 'src/a.ts', 'one\n', 'two\n');
    edit('t2', 'src/b.ts', 'one\n', 'two\n', otherChat);

    backups.deleteChat(chatId);
    expect(existsSync(join(root, 'edit-backups', chatId))).toBe(false);
    expect(existsSync(join(root, 'edit-backups', otherChat))).toBe(true);
    backups.deleteChat('../nope');

    backups.deleteAll();
    expect(existsSync(join(root, 'edit-backups'))).toBe(false);
    await expect(backups.undo(otherChat, 't2', workspace)).rejects.toThrow(/no longer available/);
  });
});
