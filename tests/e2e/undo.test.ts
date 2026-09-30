import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('undo an approved edit (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  const notes = () => join(project, 'notes.txt');

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-undo-project-'));
    writeFileSync(notes(), 'The secret word is pineapple.\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    // Undo asks "are you sure?" with a browser confirm; answer yes.
    running.page.on('dialog', (dialog) => void dialog.accept());
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  const toolTurn = (id: string, name: string, input: unknown) => ({
    blocks: [{ type: 'tool_use' as const, id, name, input }],
    stopReason: 'tool_use' as const,
  });
  const textTurn = (text: string) => ({ blocks: [{ type: 'text' as const, text }], stopReason: 'end_turn' as const });

  // Sends a message and approves every edit the assistant asks for until it is done.
  async function runTask(message: string): Promise<ChatSnapshot> {
    await running.page.evaluate((text) => window.api.invoke('chat:send', { text }), message);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await snapshot();
      const pending = current.transcript.find((item) => item.kind === 'tool' && item.status === 'awaiting-approval');
      if (pending)
        await running.page.evaluate((id) => window.api.invoke('chat:decide', id, { approved: true }), pending.id);
      else if (!current.busy && current.transcript.some((item) => item.kind === 'assistant')) return current;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error('Timed out waiting for the task');
  }

  // The app gives cards ids of its own, so cards are found by what they did.
  const cardsOf = (chat: ChatSnapshot, name: string) =>
    chat.transcript.filter((item) => item.kind === 'tool' && item.name === name);

  const toast = (text: string) => running.page.locator('.app-toast', { hasText: text }).first().waitFor();

  it('puts the file back from the card of the edit, and tells the model on the next message', async () => {
    claude.script(
      toolTurn('toolu_read', 'read_file', { path: 'notes.txt' }),
      toolTurn('toolu_edit', 'edit_file', { path: 'notes.txt', old_string: 'pineapple', new_string: 'mango' }),
      textTurn('Changed it.'),
    );
    const done = await runTask('Change the word to mango');
    expect(readFileSync(notes(), 'utf8')).toBe('The secret word is mango.\n');
    expect(cardsOf(done, 'edit_file').at(-1)).toMatchObject({ kind: 'tool', status: 'done', undo: 'available' });
    // Reading a file has nothing to undo.
    expect(cardsOf(done, 'read_file').at(-1)).not.toHaveProperty('undo');

    await running.page.getByLabel('Undo Edited notes.txt').click();
    await toast('Restored notes.txt');

    expect(readFileSync(notes(), 'utf8')).toBe('The secret word is pineapple.\n');
    expect(cardsOf(await snapshot(), 'edit_file').at(-1)).toMatchObject({ undo: 'undone' });
    await running.page.getByText('Undone', { exact: true }).waitFor();
    expect(await running.page.getByLabel('Undo Edited notes.txt').count()).toBe(0);

    // The model is told with the next message; the chat shows only what was typed.
    claude.script(textTurn('Understood.'));
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'What is the word now?' }));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && claude.agentRequests.length < 4)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const last = claude.agentRequests.at(-1).messages.at(-1);
    expect(JSON.stringify(last)).toContain('[Note from the app: The user undid your edit to notes.txt');
    expect(JSON.stringify(last)).toContain('What is the word now?');
    const shown = (await snapshot()).transcript
      .filter((item) => item.kind === 'user')
      .map((item) => (item as { text: string }).text);
    expect(shown.at(-1)).toBe('What is the word now?');
  });

  it('will not overwrite what changed after the edit, and keeps cards apart when the server reuses tool-call ids', async () => {
    // The same provider ids as in the first test: some OpenAI-compatible servers number calls from 1 in every turn.
    claude.script(
      toolTurn('toolu_read', 'read_file', { path: 'notes.txt' }),
      toolTurn('toolu_edit', 'edit_file', { path: 'notes.txt', old_string: 'pineapple', new_string: 'kiwi' }),
      textTurn('Done.'),
    );
    const second = await runTask('Change it to kiwi');
    const [first, latest] = cardsOf(second, 'edit_file');
    expect(first!.id).not.toBe(latest!.id);
    expect(first).toMatchObject({ undo: 'undone' });
    expect(latest).toMatchObject({ undo: 'available' });
    expect(readFileSync(notes(), 'utf8')).toBe('The secret word is kiwi.\n');

    writeFileSync(notes(), 'Rewritten by the user.\n');
    await running.page.getByLabel('Undo Edited notes.txt').click();
    await toast('was changed after this edit');

    expect(readFileSync(notes(), 'utf8')).toBe('Rewritten by the user.\n');
    // Still undoable, once the file is as the edit left it.
    expect(cardsOf(await snapshot(), 'edit_file').at(-1)).toMatchObject({ undo: 'available' });
    writeFileSync(notes(), 'The secret word is kiwi.\n');
    await running.page.getByLabel('Undo Edited notes.txt').click();
    await toast('Restored notes.txt');
    expect(readFileSync(notes(), 'utf8')).toBe('The secret word is pineapple.\n');
  });

  it('deletes a file the assistant created', async () => {
    claude.script(
      toolTurn('toolu_new', 'write_file', { path: 'created.txt', content: 'brand new\n' }),
      textTurn('Created it.'),
    );
    await runTask('Create created.txt');
    expect(readFileSync(join(project, 'created.txt'), 'utf8')).toBe('brand new\n');

    await running.page.getByLabel('Undo Created created.txt').click();
    await toast('Deleted created.txt');
    expect(existsSync(join(project, 'created.txt'))).toBe(false);
  });

  it('keeps the backups in the user data folder and removes them with the chat', async () => {
    const backups = join(running.userData, 'edit-backups');
    const chat = await snapshot();
    // All three edits were undone, which uses their backups up; make one more that stays.
    claude.script(toolTurn('toolu_keep', 'write_file', { path: 'kept.txt', content: 'kept\n' }), textTurn('Done.'));
    await runTask('Create kept.txt');
    expect(readdirSync(join(backups, chat.id))).toHaveLength(1);

    await running.page.evaluate((id) => window.api.invoke('history:delete', id), chat.id);
    expect(existsSync(join(backups, chat.id))).toBe(false);
  });
});
