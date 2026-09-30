import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('very large tool results in the chat (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-large-project-'));
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  async function waitFor(check: (chat: ChatSnapshot) => unknown): Promise<ChatSnapshot> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out: ${running.mainErrors.join(' ')}`);
  }

  it('shows the start of a huge diff with a warning before approval, and approving still writes all of it', async () => {
    const content = Array.from({ length: 6_000 }, (_, index) => `line ${index}`).join('\n') + '\n';
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'big-write', name: 'write_file', input: { path: 'big.txt', content } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Written.' }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Write a big file' }));

    const card = running.page.getByRole('group', { name: /Approval needed/ });
    await card.waitFor();
    const warning = card.getByRole('note');
    await warning.waitFor();
    expect(await warning.textContent()).toMatch(/more lines are not shown\. Approving applies the whole change/);
    // Only the kept part is laid out.
    expect(await card.getByText('line 1500', { exact: true }).count()).toBe(1);
    expect(await card.getByText('line 5999', { exact: true }).count()).toBe(0);

    await card.getByRole('button', { name: 'Approve' }).click();
    const done = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');
    expect(readFileSync(join(project, 'big.txt'), 'utf8')).toBe(content);
    const item = done.transcript.find((entry) => entry.kind === 'tool' && entry.path === 'big.txt');
    expect(item).toMatchObject({ kind: 'tool', status: 'done' });
    expect(item?.kind === 'tool' && item.preview?.diffOmittedLines).toBeGreaterThan(0);
  });

  it('keeps the end of very long command output and says the start was left out', async () => {
    await running.page.evaluate(() => window.api.invoke('settings:update', { approvalMode: 'auto' }));
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'loud',
            name: 'run_command',
            input: { command: `node -e "process.stdout.write('a'.repeat(60000)+'THE-END')"` },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Ran it.' }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Print a lot' }));
    const done = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');

    const item = done.transcript.find((entry) => entry.kind === 'tool' && entry.name === 'run_command');
    expect(item?.kind === 'tool' && item.output?.length).toBeLessThanOrEqual(20_000);
    expect(item?.kind === 'tool' && item.output).toContain('THE-END');
    expect(item?.kind === 'tool' && item.outputOmittedChars).toBeGreaterThan(0);

    expect(item?.kind).toBe('tool');
    const card = running.page.locator(`.tool-card[data-id="${item?.id}"]`);
    await card.locator('summary').click();
    await card.getByText(/Output too long to show in full/).waitFor();
  });
});
