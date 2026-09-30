import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// A project's own allow-lists: set in the Project settings dialog, used for that project only, in addition to the
// global lists in Settings.
describe('per-project allow-lists (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let root: string;
  let alpha: string;
  let beta: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'patch-project-settings-'));
    alpha = join(root, 'Alpha');
    beta = join(root, 'Beta');
    for (const path of [alpha, beta]) mkdirSync(path);
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    // Ask mode, with a global list that allows something else.
    await running.page.evaluate(() =>
      window.api.invoke('settings:update', { approvalMode: 'ask', allowedCommands: 'git --version' }),
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  async function waitFor(check: (chat: ChatSnapshot) => unknown): Promise<ChatSnapshot> {
    const deadline = Date.now() + 20_000;
    let chat = await snapshot();
    while (Date.now() < deadline) {
      chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${JSON.stringify(chat.transcript.map((item) => item.kind))}`);
  }

  // The model runs one command; returns whether it waited for approval or ran by itself.
  async function runCommand(command: string, id: string): Promise<'asked' | 'ran'> {
    claude.script(
      { blocks: [{ type: 'tool_use', id, name: 'run_command', input: { command } }], stopReason: 'tool_use' },
      { blocks: [{ type: 'text', text: `Done ${id}` }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await running.page.evaluate((text) => window.api.invoke('chat:send', { text }), `Run ${command}`);
    const chat = await waitFor((current) =>
      current.transcript.some(
        (item) => item.kind === 'tool' && item.name === 'run_command' && item.status !== 'running',
      ),
    );
    const card = chat.transcript.find((item) => item.kind === 'tool' && item.name === 'run_command');
    if (card?.kind === 'tool' && card.status === 'awaiting-approval') {
      // Approve rather than stop, so the scripted follow-up answer is used up (the commands are harmless).
      await running.page.evaluate((cardId) => window.api.invoke('chat:decide', cardId, { approved: true }), card.id);
      await waitFor((current) => !current.busy);
      return 'asked';
    }
    await waitFor((current) => !current.busy);
    return 'ran';
  }

  it('saves a command for one project from the Project settings dialog', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    await running.page.locator('.project-button').click();
    await running.page.getByText('Project settings…').click();

    const dialog = running.page.getByRole('dialog', { name: 'Project settings for Alpha' });
    await dialog.getByLabel('Commands allowed without asking').fill('node --version');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await dialog.waitFor({ state: 'hidden' });

    const saved = await running.page.evaluate(() => window.api.invoke('project:current'));
    expect(saved).toMatchObject({ name: 'Alpha', allowedCommands: 'node --version' });
  });

  it('runs that command without asking in that project, and still allows the global list there', async () => {
    expect(await runCommand('node --version', 'alpha-node')).toBe('ran');
    expect(await runCommand('git --version', 'alpha-git')).toBe('ran');
    expect(await runCommand('npm --version', 'alpha-npm')).toBe('asked');
  });

  it('still asks for it in another project', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), beta);
    expect(await runCommand('node --version', 'beta-node')).toBe('asked');
    expect(await runCommand('git --version', 'beta-git')).toBe('ran');
  });

  it('shows the saved lists again when the dialog is reopened', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    await running.page.locator('.project-button').click();
    await running.page.getByText('Project settings…').click();
    const dialog = running.page.getByRole('dialog', { name: 'Project settings for Alpha' });
    expect(await dialog.getByLabel('Commands allowed without asking').inputValue()).toBe('node --version');
    await dialog.getByRole('button', { name: 'Close' }).click();
    expect(running.errors).toEqual([]);
  });
});
