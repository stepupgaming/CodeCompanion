import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// More of switching between open projects, through the UI: instructions, drafts with images, the chat history, and
// switching while a task runs. tests/e2e/projects.test.ts covers the basics of separate chats and drafts.
describe('switching between open projects (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let root: string;
  let alpha: string;
  let beta: string;
  let betaChatId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'patch-switching-'));
    alpha = join(root, 'Alpha');
    beta = join(root, 'Beta');
    for (const path of [alpha, beta]) mkdirSync(path);
    writeFileSync(join(alpha, 'AGENTS.md'), 'ALPHA-AGENTS-RULES\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  const current = () => running.page.evaluate(() => window.api.invoke('project:current'));
  const tabs = () => running.page.getByRole('navigation', { name: 'Open projects' });
  const tab = (name: string) => tabs().getByRole('button', { name, exact: true });
  const message = () => running.page.getByLabel('Message', { exact: true });
  const attachments = () => running.page.locator('.composer-attachments .badge');

  async function waitFor(check: (chat: ChatSnapshot) => unknown, timeout = 20_000): Promise<ChatSnapshot> {
    const deadline = Date.now() + timeout;
    let chat = await snapshot();
    while (Date.now() < deadline) {
      chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out. project=${chat.projectPath} busy=${chat.busy} items=${chat.transcript.length} ${running.mainErrors.join(' ')}`,
    );
  }

  async function ask(text: string, answer: string): Promise<ChatSnapshot> {
    claude.script({ blocks: [{ type: 'text', text: answer }], stopReason: 'end_turn' });
    await message().fill(text);
    await message().press('Enter');
    return waitFor(
      (chat) => !chat.busy && chat.transcript.some((item) => item.kind === 'assistant' && item.text === answer),
    );
  }

  // Pastes a small PNG into the message box, the way the clipboard would.
  const pasteImage = (name: string) =>
    running.page.getByLabel('Message', { exact: true }).evaluate((input, fileName) => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgo='), (char) => char.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], fileName, { type: 'image/png' }));
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, name);

  it("builds each project's chat from that project's own instructions", async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    await ask('Hello Alpha', 'Alpha answered.');
    const alphaSystem = claude.agentRequests.at(-1).system[0].text;
    expect(alphaSystem).toContain('ALPHA-AGENTS-RULES');
    expect(alphaSystem).not.toContain('BETA-PROJECT-INSTRUCTIONS');

    await running.page.evaluate((path) => window.api.invoke('project:open', path), beta);
    await tab('Beta').waitFor();
    await running.page.evaluate(
      (path) => window.api.invoke('project:set-instructions', path, 'BETA-PROJECT-INSTRUCTIONS'),
      beta,
    );
    betaChatId = (await ask('Hello Beta', 'Beta answered.')).id;
    const betaSystem = claude.agentRequests.at(-1).system[0].text;
    expect(betaSystem).toContain('BETA-PROJECT-INSTRUCTIONS');
    expect(betaSystem).not.toContain('ALPHA-AGENTS-RULES');
    // The status bar says which instruction file the chat on screen uses.
    expect(await running.page.getByText('AGENTS.md loaded').isVisible()).toBe(false);
  });

  it('keeps attached images with the draft of their own project', async () => {
    await message().fill('Beta draft with an image');
    await pasteImage('beta-shot.png');
    await attachments().filter({ hasText: 'beta-shot.png' }).waitFor();

    await tab('Alpha').click();
    await expect.poll(async () => (await current())?.path).toBe(alpha);
    await running.page.getByText('Alpha answered.', { exact: true }).waitFor();
    expect(await message().inputValue()).toBe('');
    expect(await attachments().count()).toBe(0);
    expect(await running.page.getByText('AGENTS.md loaded').isVisible()).toBe(true);
    await pasteImage('alpha-shot.png');
    await attachments().filter({ hasText: 'alpha-shot.png' }).waitFor();

    await tab('Beta').click();
    await expect.poll(async () => (await current())?.path).toBe(beta);
    expect(await message().inputValue()).toBe('Beta draft with an image');
    await expect.poll(() => attachments().allTextContents()).toEqual([expect.stringContaining('beta-shot.png')]);

    await tab('Alpha').click();
    await expect.poll(() => attachments().allTextContents()).toEqual([expect.stringContaining('alpha-shot.png')]);
  });

  it("switches to the other project when one of its chats is opened from the history, keeping this project's draft", async () => {
    await message().fill('Alpha draft kept while away');
    await running.page.getByTitle('Chat history').click();
    // Chats are titled by the small model; both are "Explore the project", so pick Beta's by its project path.
    const betaRow = running.page.locator('.history-list .list-group-item', { hasText: beta });
    await betaRow.waitFor();
    await betaRow.getByRole('button').first().click();

    const opened = await waitFor((chat) => chat.id === betaChatId);
    expect(opened.projectPath).toBe(beta);
    expect((await current())?.path).toBe(beta);
    expect(await tab('Beta').getAttribute('aria-pressed')).toBe('true');
    await running.page.getByText('Beta answered.', { exact: true }).waitFor();

    await tab('Alpha').click();
    await expect.poll(() => message().inputValue()).toBe('Alpha draft kept while away');
  });

  it('refuses to switch tabs while a task is running, says why, and switches once it is stopped', async () => {
    claude.script({ hang: { text: 'Working on it' } });
    await message().fill('A long task');
    await message().press('Enter');
    await running.page.getByText('Working on it').waitFor();

    await tab('Beta').click();
    await running.page.locator('.app-toast', { hasText: 'Stop the current task' }).first().waitFor();
    expect((await current())?.path).toBe(alpha);
    expect(await tab('Alpha').getAttribute('aria-pressed')).toBe('true');

    await running.page.getByRole('button', { name: /Stop/ }).click();
    await waitFor((chat) => !chat.busy);
    await tab('Beta').click();
    await expect.poll(async () => (await current())?.path).toBe(beta);
    expect((await waitFor((chat) => chat.id === betaChatId)).busy).toBe(false);
    expect(running.errors).toEqual([]);
  });
});
