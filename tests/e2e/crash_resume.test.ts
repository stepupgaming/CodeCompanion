import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// A chat saved while the app crashed mid-task: the conversation ends with a tool_use block that never got its
// result, and the transcript still shows the tool as running. The app must offer Resume, repair the history with
// a synthetic tool result, and continue the task.
describe('resume after a crash end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  let userData: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-crash-e2e-'));
    userData = mkdtempSync(join(tmpdir(), 'cc-crash-e2e-profile-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
    seedCrashedChat();
    claude = new MockClaude();
    running = await launchApp({
      PATCH_USER_DATA: userData,
      PATCH_TEST_ANTHROPIC_URL: await claude.start(),
    });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });

  // The chat file the app would have written right before the crash, with the tool batch saved but no results.
  function seedCrashedChat(): string {
    const id = randomUUID();
    const chat = {
      version: 1,
      id,
      title: 'Crashed task',
      projectPath: project,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      system: 'You are a test.',
      transcript: [
        { kind: 'user', id: 'u1', text: 'Change the file', imageCount: 0 },
        { kind: 'tool', id: 'crash-tool-1', name: 'run_command', status: 'running' },
      ],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      conversation: {
        provider: 'anthropic',
        model: 'claude-sonnet-5-5',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Change the file' }] },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will change the file.' },
              {
                type: 'tool_use',
                id: 'crash-tool-1',
                name: 'run_command',
                input: { command: 'printf changed > file.txt' },
              },
            ],
          },
        ],
      },
      readFiles: [],
      agentFile: null,
    };
    const chatsDir = join(userData, 'chats');
    mkdirSync(chatsDir, { recursive: true });
    writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify(chat, null, 2));
    return id;
  }

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

  it('offers Resume for a chat interrupted by a crash and continues with a valid repaired history', async () => {
    const opened = await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    expect(opened).toBeTruthy();
    const chats = await running.page.evaluate(() => window.api.invoke('history:list'));
    const chatId = chats[0]!.id;
    await running.page.evaluate((id) => window.api.invoke('history:open', id), chatId);

    const paused = await waitFor((chat) => chat.resumable && !chat.busy);
    const toolRow = paused.transcript.find((item) => item.kind === 'tool');
    expect(toolRow).toMatchObject({ status: 'error', summary: 'run_command was interrupted' });
    expect(await running.page.getByRole('button', { name: /Resume/ }).isVisible()).toBe(true);

    claude.script({ blocks: [{ type: 'text', text: 'Recovered and finished.' }], stopReason: 'end_turn' });
    await running.page.getByRole('button', { name: /Resume/ }).click();
    const finished = await waitFor((chat) => !chat.busy && !chat.resumable);
    expect(finished.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Recovered and finished.' });
    // The continuation must not look like a new user message in the transcript.
    expect(finished.transcript.filter((item) => item.kind === 'user')).toHaveLength(1);

    // The repaired request closes the dangling tool call before the continuation instruction.
    const messages = claude.agentRequests.at(-1).messages;
    expect(JSON.stringify(messages.at(-2))).toContain('crash-tool-1');
    expect(JSON.stringify(messages.at(-2))).toContain('the app was interrupted');
    expect(JSON.stringify(messages.at(-1))).toContain('Continue the task');
    expect(running.errors).toEqual([]);
  });
});
