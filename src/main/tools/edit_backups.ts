import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UndoResult } from '@shared/ipc';
import { sha256 } from './text_files';
import type { EditUndo } from './types';
import type { Workspace } from './workspace';

// Backups kept per chat. Older ones are deleted as new edits come in.
const MAX_BACKUPS_PER_CHAT = 50;
const CHAT_ID = /^[0-9a-f-]{36}$/;

interface StoredBackup {
  path: string;
  // Base64 of the file's bytes before the edit, or null when the edit created the file.
  before: string | null;
  afterHash: string;
}

// Copies of the files that approved edits changed, so an edit can be undone from its card in the chat. One JSON file per
// edit in <dir>/<chat id>/. These are copies of the user's own project files; they stay on this machine and are deleted
// with the chat.
export class EditBackups {
  constructor(private readonly dir: string) {}

  record(chatId: string, toolId: string, edit: EditUndo): void {
    const folder = this.chatFolder(chatId);
    mkdirSync(folder, { recursive: true });
    const stored: StoredBackup = {
      path: edit.path,
      before: edit.before ? edit.before.toString('base64') : null,
      afterHash: edit.afterHash,
    };
    writeFileSync(this.file(chatId, toolId), JSON.stringify(stored), 'utf8');
    this.prune(folder);
  }

  // Puts the file back as it was before the edit, but only if it is still exactly as the edit left it, so nothing
  // written since (by the user or by a later edit) is lost. The backup is used up by a successful undo.
  async undo(chatId: string, toolId: string, workspace: Workspace): Promise<UndoResult & { absolute: string }> {
    const stored = this.read(chatId, toolId);
    if (!stored) throw new Error('The backup for this edit is no longer available.');

    const file = workspace.resolve(stored.path);
    const current = existsSync(file) ? await readFile(file) : null;
    const created = stored.before === null;

    if (current === null) {
      if (!created) throw new Error(`${stored.path} was deleted after this edit, so there is nothing to put back.`);
      // Already gone: the state the user wants is reached.
      this.forget(chatId, toolId);
      return { path: stored.path, action: 'deleted', absolute: file };
    }
    if (sha256(current) !== stored.afterHash) {
      throw new Error(
        `${stored.path} was changed after this edit, so undoing it would lose those changes. Undo the later edits first, or restore the file with Git.`,
      );
    }

    if (created) await rm(file, { force: true });
    else await writeFile(file, Buffer.from(stored.before!, 'base64'));
    if (stored.path.endsWith('.gitignore')) workspace.invalidateIgnoreRules();
    this.forget(chatId, toolId);
    return { path: stored.path, action: created ? 'deleted' : 'restored', absolute: file };
  }

  deleteChat(chatId: string): void {
    if (CHAT_ID.test(chatId)) rmSync(this.chatFolder(chatId), { recursive: true, force: true });
  }

  deleteAll(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private read(chatId: string, toolId: string): StoredBackup | null {
    if (!CHAT_ID.test(chatId)) return null;
    try {
      const stored = JSON.parse(readFileSync(this.file(chatId, toolId), 'utf8')) as Partial<StoredBackup>;
      const valid =
        typeof stored.path === 'string' &&
        typeof stored.afterHash === 'string' &&
        (stored.before === null || typeof stored.before === 'string');
      return valid ? (stored as StoredBackup) : null;
    } catch {
      return null;
    }
  }

  private forget(chatId: string, toolId: string): void {
    rmSync(this.file(chatId, toolId), { force: true });
  }

  private chatFolder(chatId: string): string {
    if (!CHAT_ID.test(chatId)) throw new Error('Invalid chat id.');
    return join(this.dir, chatId);
  }

  // The id comes from the model, so it is hashed rather than used as a file name.
  private file(chatId: string, toolId: string): string {
    return join(this.chatFolder(chatId), `${createHash('sha256').update(toolId).digest('hex').slice(0, 40)}.json`);
  }

  private prune(folder: string): void {
    const files = readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, time: statSync(join(folder, name)).mtimeMs }))
      .sort((a, b) => b.time - a.time);
    for (const old of files.slice(MAX_BACKUPS_PER_CHAT)) rmSync(join(folder, old.name), { force: true });
  }
}
