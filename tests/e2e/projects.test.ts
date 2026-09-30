import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('multiple open projects', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let root: string;
  let alpha: string;
  let beta: string;
  let alphaId: string;
  let betaId: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-projects-'));
    alpha = join(root, 'Alpha');
    beta = join(root, 'Beta');
    for (const path of [alpha, beta]) mkdirSync(path);
    writeFileSync(join(alpha, 'notes.txt'), 'Only Alpha has apples.');
    writeFileSync(join(beta, 'notes.txt'), 'Only Beta has bananas.');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate(() =>
      window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-projects-test'),
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function waitFor(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    let current: ChatSnapshot | undefined;
    for (let i = 0; i < 100; i++) {
      current = await running.page.evaluate(() => window.api.invoke('chat:snapshot'));
      if (check(current)) return current;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Say what the chat looked like, so a failure can be told apart from a slow run.
    const state = current?.transcript.map(
      (item) =>
        `${item.kind}${'text' in item ? `: ${item.text.slice(0, 80)}` : ''}${'status' in item ? ` (${item.status})` : ''}`,
    );
    throw new Error(
      `Timed out waiting for project chat. busy=${current?.busy}, requests=${claude.agentRequests.length}, transcript=${JSON.stringify(state)}, main stderr=${running.mainErrors.join('').slice(-500)}`,
    );
  }

  async function readNotes(answer: string): Promise<ChatSnapshot> {
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: `read-${answer}`, name: 'read_file', input: { path: 'notes.txt' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: answer }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Read this project’s notes');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');
    return waitFor(
      (chat) => !chat.busy && chat.transcript.some((item) => item.kind === 'assistant' && item.text === answer),
    );
  }

  it('keeps chats, drafts and workspace file reads separate when switching tabs', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    // The IPC reply can arrive before the renderer restores this project's draft.
    await running.page
      .getByRole('navigation', { name: 'Open projects' })
      .getByRole('button', { name: 'Alpha', exact: true })
      .waitFor();
    alphaId = (await readNotes('Alpha ready')).id;
    expect(JSON.stringify(claude.agentRequests.at(-1).messages.at(-1))).toContain('Only Alpha has apples');
    await running.page.getByLabel('Message', { exact: true }).fill('Unsaved Alpha draft');
    await running.page.evaluate((path) => window.api.invoke('project:open', path), beta);
    await running.page
      .getByRole('navigation', { name: 'Open projects' })
      .getByRole('button', { name: 'Beta', exact: true })
      .waitFor();
    expect(await running.page.getByLabel('Message', { exact: true }).inputValue()).toBe('');
    betaId = (await readNotes('Beta ready')).id;
    expect(betaId).not.toBe(alphaId);
    expect(JSON.stringify(claude.agentRequests.at(-1).messages.at(-1))).toContain('Only Beta has bananas');
    await running.page.getByLabel('Message', { exact: true }).fill('Unsaved Beta draft');
    const tabs = running.page.getByRole('navigation', { name: 'Open projects' });
    await tabs.getByRole('button', { name: 'Alpha', exact: true }).click();
    await running.page.getByText('Alpha ready', { exact: true }).waitFor();
    expect((await waitFor((chat) => chat.id === alphaId)).projectPath).toBe(alpha);
    expect(await running.page.getByLabel('Message', { exact: true }).inputValue()).toBe('Unsaved Alpha draft');
    expect(await tabs.getByRole('button', { name: 'Alpha', exact: true }).getAttribute('aria-pressed')).toBe('true');
    if (process.env.E2E_SCREENSHOTS) {
      await running.page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, 'multiple-projects.png') });
    }
  });

  it('rejects switching during an approval and retains stopped state across project switches', async () => {
    claude.script({
      blocks: [{ type: 'tool_use', id: 'pending-project', name: 'run_command', input: { command: 'echo pending' } }],
      stopReason: 'tool_use',
    });
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Run a command' }));
    await waitFor((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    const error = await running.page.evaluate(
      (path) =>
        window.api.invoke('project:open', path).then(
          () => '',
          (error) => error.message,
        ),
      beta,
    );
    expect(error).toContain('Stop the current task');
    expect((await running.page.evaluate(() => window.api.invoke('project:current')))?.path).toBe(alpha);
    await running.page.evaluate(() => window.api.invoke('chat:stop'));
    await waitFor((chat) => !chat.busy && chat.resumable);
    await running.page.evaluate((path) => window.api.invoke('project:open', path), beta);
    expect((await waitFor((chat) => chat.id === betaId)).resumable).toBe(false);
    await running.page.evaluate((path) => window.api.invoke('project:open', path), alpha);
    expect((await waitFor((chat) => chat.id === alphaId)).resumable).toBe(true);
  });

  it('closes tabs without deleting saved chats and returns to an empty screen after the last tab', async () => {
    await running.page.getByRole('button', { name: 'Close project Alpha' }).click();
    await waitFor((chat) => chat.id === betaId);
    await running.page.getByRole('button', { name: 'Close project Beta' }).click();
    const empty = await waitFor((chat) => chat.id === '' && chat.projectPath === null);
    expect(empty.transcript).toEqual([]);
    expect(await running.page.evaluate(() => window.api.invoke('project:opened'))).toEqual([]);
    const saved = await running.page.evaluate(() => window.api.invoke('history:list'));
    expect(saved.map((chat) => chat.id)).toEqual(expect.arrayContaining([alphaId, betaId]));
    await running.page.evaluate((id) => window.api.invoke('history:open', id), alphaId);
    expect((await waitFor((chat) => chat.id === alphaId)).resumable).toBe(true);
    expect(running.errors).toEqual([]);
  });
});
