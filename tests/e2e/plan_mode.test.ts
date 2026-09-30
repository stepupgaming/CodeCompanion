import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// Plan mode: the model proposes a plan through the propose_plan tool, it is shown as an approval card with the
// plan text, and after approval the model continues with the plan result in its history.
describe('plan mode end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-plan-e2e-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    await running.page.evaluate(() => window.api.invoke('settings:update', { planMode: true }));
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

  it('shows the plan on an approval card and continues after approval', async () => {
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'plan-1',
            name: 'propose_plan',
            input: { plan: '1. Write the file\n2. Run the tests', summary: 'Add a file safely' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Plan carried out.' }], stopReason: 'end_turn' },
    );

    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Add a file' }));
    const pending = await waitFor((chat) =>
      chat.transcript.some((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    const card = pending.transcript.find(
      (item): item is Extract<TranscriptItem, { kind: 'tool' }> =>
        item.kind === 'tool' && item.status === 'awaiting-approval',
    );
    expect(card).toMatchObject({ name: 'propose_plan', preview: { title: 'Add a file safely' } });
    expect(card?.preview?.text).toContain('Write the file');

    await running.page.evaluate((id) => window.api.invoke('chat:decide', id, { approved: true }), card!.id);
    const finished = await waitFor((chat) => !chat.busy);
    const toolRow = finished.transcript.find((item) => item.kind === 'tool');
    expect(toolRow).toMatchObject({ status: 'done', summary: 'Plan approved: Add a file safely' });
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('The user approved the plan');
    expect(running.errors).toEqual([]);
  });
});
