import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

const LONG_ID = '22222222-2222-2222-2222-222222222222';

// 200 tall items: a long answer with a code block, as in a real chat.
function longTranscript(): TranscriptItem[] {
  return Array.from({ length: 100 }, (_, turn): TranscriptItem[] => [
    { kind: 'user', id: `u${turn}`, text: `Question ${turn}`, imageCount: 0 },
    {
      kind: 'assistant',
      id: `a${turn}`,
      text: `Answer ${turn}\n\n\`\`\`ts\n${Array.from({ length: 12 }, (_, line) => `const v${line} = ${turn};`).join('\n')}\n\`\`\``,
      thinking: '',
      streaming: false,
    },
  ]).flat();
}

describe('the transcript view (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  let profile: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-view-project-'));
    profile = mkdtempSync(join(tmpdir(), 'patch-view-profile-'));
    writeFileSync(join(project, 'notes.txt'), 'hello\n');
    mkdirSync(join(profile, 'chats'));
    writeFileSync(
      join(profile, 'chats', `${LONG_ID}.json`),
      JSON.stringify({
        version: 1,
        id: LONG_ID,
        title: 'Long chat',
        projectPath: project,
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
        system: 'system prompt',
        transcript: longTranscript(),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        conversation: { provider: 'anthropic', model: 'claude-opus-5-5', messages: [] },
        readFiles: [],
      }),
    );
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() }, { userData: profile });
    running.page.on('dialog', (dialog) => void dialog.accept());
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  // How far the chat is scrolled from its bottom, in pixels.
  const distanceFromBottom = () =>
    running.page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('.chat-scroll-wrap')!;
      return Math.round(container.scrollHeight - container.scrollTop - container.clientHeight);
    });

  it('opens a long chat at its end', async () => {
    await running.page.evaluate((id) => window.api.invoke('history:open', id), LONG_ID);
    await running.page.getByText('Answer 99', { exact: true }).waitFor();
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
  });

  it('keeps following the bottom when a tall approval card arrives, so Approve is in view', async () => {
    const newLines = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'read-notes', name: 'read_file', input: { path: 'notes.txt' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [
          { type: 'tool_use', id: 'tall-edit', name: 'write_file', input: { path: 'notes.txt', content: newLines } },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Written.' }], stopReason: 'end_turn' },
    );
    await running.page.getByLabel('Message', { exact: true }).fill('Rewrite the notes');
    await running.page.getByLabel('Message', { exact: true }).press('Enter');

    const approve = running.page
      .getByRole('group', { name: /Approval needed/ })
      .getByRole('button', { name: 'Approve' });
    await approve.waitFor();
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
    expect(await approve.isVisible()).toBe(true);
    const box = await approve.boundingBox();
    const viewport = await running.page.evaluate(
      () => document.querySelector<HTMLElement>('.chat-scroll-wrap')!.getBoundingClientRect().bottom,
    );
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport + 1);

    await approve.click();
    await running.page.getByText('Written.', { exact: true }).waitFor();
    await expect.poll(distanceFromBottom, { timeout: 5_000 }).toBeLessThan(5);
  });

  it('moves keyboard focus to the result after Undo instead of losing it', async () => {
    const undo = running.page.getByRole('button', { name: /^Undo / });
    await undo.focus();
    await running.page.keyboard.press('Enter');

    await running.page.getByText('Undone', { exact: true }).waitFor();
    await expect
      .poll(() =>
        running.page.evaluate(() => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName),
      )
      .toBe('Undone');
  });
});
