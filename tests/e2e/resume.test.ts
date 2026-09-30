import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('stop and resume end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-resume-e2e-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
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

  async function snapshot(): Promise<ChatSnapshot> {
    return running.page.evaluate(() => window.api.invoke('chat:snapshot'));
  }

  async function waitFor(check: (chat: ChatSnapshot) => boolean): Promise<ChatSnapshot> {
    for (let index = 0; index < 100; index++) {
      const chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `Timed out waiting for chat state: ${JSON.stringify(await snapshot())}; ${running.mainErrors.join(' ')}`,
    );
  }

  it('shows Resume after reopening a stopped approval and continues without another visible user message', async () => {
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'resume-command',
            name: 'run_command',
            input: { command: 'printf changed > file.txt' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Resumed after checking the current state.' }], stopReason: 'end_turn' },
    );

    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Change the file' }));
    await waitFor((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    await running.page.getByRole('button', { name: /Stop/ }).click();
    const paused = await waitFor((chat) => !chat.busy && chat.resumable);

    await running.page.evaluate(() => window.api.invoke('chat:new'));
    await running.page.evaluate((id) => window.api.invoke('history:open', id), paused.id);
    expect(await running.page.getByRole('button', { name: /Resume/ }).isVisible()).toBe(true);
    if (process.env.E2E_SCREENSHOTS) {
      await running.page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, 'resume-paused.png') });
    }

    await running.page.getByRole('button', { name: /Resume/ }).click();
    const resumed = await waitFor(
      (chat) => !chat.busy && !chat.resumable && chat.transcript.at(-1)?.kind === 'assistant',
    );
    expect(resumed.transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
    expect(JSON.stringify(claude.agentRequests.at(-1).messages.at(-1).content)).toContain('inspect the current state');
    expect(running.errors).toEqual([]);
  });
});
