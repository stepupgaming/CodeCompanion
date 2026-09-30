import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// The task tool delegates to a read-only subagent: the mock API sees the parent turn, the subagent's turns (a
// read_file call and its answer) and finally the parent finishing with the subagent's answer in its history.
describe('subagent task tool end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-task-e2e-'));
    writeFileSync(join(project, 'file.txt'), 'hello from the project\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));

    // 1. The parent asks the subagent to read the file.
    // 2./3. The subagent reads it and answers.
    // 4. The parent reports the answer.
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'task-1', name: 'task', input: { task: 'What does file.txt say?' } }],
        stopReason: 'tool_use',
      },
      {
        blocks: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'file.txt' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The file says: hello from the project' }], stopReason: 'end_turn' },
      { blocks: [{ type: 'text', text: 'Delegated answer: hello from the project' }], stopReason: 'end_turn' },
    );
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

  it('delegates to a read-only subagent and surfaces its answer', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'What does file.txt say?' }));
    const finished = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');

    const taskRow = finished.transcript.find(
      (item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool' && item.name === 'task',
    );
    expect(taskRow).toMatchObject({ status: 'done' });
    expect(taskRow?.summary).toContain('Subagent:');

    // The parent's final request contains the subagent's answer as the task result.
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('The file says: hello from the project');
    // Exactly four API turns: parent, subagent read, subagent answer, parent finish.
    expect(claude.agentRequests).toHaveLength(4);
    expect(running.errors).toEqual([]);
  });
});
