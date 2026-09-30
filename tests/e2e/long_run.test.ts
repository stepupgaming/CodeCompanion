import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// A multi-step run stopped in the middle of real work, then resumed, including after a restart of the app.
describe('stop and resume of a long agent run (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let url: string;
  let project: string;
  let profile: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-long-run-project-'));
    profile = mkdtempSync(join(tmpdir(), 'patch-long-run-profile-'));
    claude = new MockClaude();
    url = await claude.start();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: url }, { userData: profile });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    // Commands run without approval cards, so the run goes on by itself until it is stopped.
    await running.page.evaluate(() => window.api.invoke('settings:update', { approvalMode: 'auto' }));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  });

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  async function waitFor(check: (chat: ChatSnapshot) => unknown, timeout = 20_000): Promise<ChatSnapshot> {
    const deadline = Date.now() + timeout;
    let chat = await snapshot();
    while (Date.now() < deadline) {
      chat = await snapshot();
      if (check(chat)) return chat;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = chat.transcript.map((item) => `${item.kind}${'status' in item ? ` (${item.status})` : ''}`);
    throw new Error(
      `Timed out. busy=${chat.busy} resumable=${chat.resumable} transcript=${JSON.stringify(state)} ${running.mainErrors.join(' ')}`,
    );
  }

  const tool = (id: string, name: string, input: unknown) => ({
    blocks: [{ type: 'tool_use' as const, id, name, input }],
    stopReason: 'tool_use' as const,
  });
  const text = (value: string) => ({
    blocks: [{ type: 'text' as const, text: value }],
    stopReason: 'end_turn' as const,
  });
  const node = (script: string) => `node -e "${script}"`;
  const toolResults = (request: any) =>
    request.messages.flatMap((message: any) =>
      Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'tool_result') : [],
    );

  it('stops during a running command, keeps the finished steps, and resumes after a restart of the app', async () => {
    claude.script(
      tool('step-write', 'run_command', { command: node("require('fs').writeFileSync('step1.txt','done')") }),
      tool('step-read', 'read_file', { path: 'step1.txt' }),
      // Marks that it started, then would write late.txt after 3 seconds, unless it is killed first.
      tool('step-long', 'run_command', {
        command: node(
          "require('fs').writeFileSync('started.txt','x');setTimeout(()=>require('fs').writeFileSync('late.txt','too late'),3000)",
        ),
      }),
      text('Finished after resuming.'),
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Do the three steps' }));

    await waitFor((chat) => {
      const cards = chat.transcript.filter((item) => item.kind === 'tool');
      return cards.length === 3 && cards[2]!.status === 'running';
    });
    // Stop once the command is really running: stopping a shell that is still starting is a different, racy case.
    await expect.poll(() => existsSync(join(project, 'started.txt')), { timeout: 20_000 }).toBe(true);
    await running.page.getByRole('button', { name: /Stop/ }).click();
    const stopped = await waitFor((chat) => !chat.busy && chat.resumable);

    // The finished steps stay done; the command that was running is ended, not left behind.
    const cards = stopped.transcript.filter((item) => item.kind === 'tool');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ name: 'run_command', status: 'done' });
    expect(cards[1]).toMatchObject({ name: 'read_file', status: 'done' });
    expect(cards[2]).toMatchObject({ name: 'run_command', status: 'error' });
    expect(readFileSync(join(project, 'step1.txt'), 'utf8')).toBe('done');
    expect(claude.agentRequests).toHaveLength(3);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(existsSync(join(project, 'late.txt'))).toBe(false);

    // Restart the app on the same profile and continue from the saved chat.
    await running.close();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: url }, { userData: profile });
    await running.page.evaluate((id) => window.api.invoke('history:open', id), stopped.id);
    const resumeButton = running.page.getByRole('button', { name: /Resume/ });
    await resumeButton.waitFor();
    await resumeButton.click();
    const resumed = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');

    expect(resumed.transcript.at(-1)).toMatchObject({ text: 'Finished after resuming.' });
    expect(resumed.resumable).toBe(false);
    expect(resumed.transcript.filter((item) => item.kind === 'user')).toHaveLength(1);
    // Nothing was run again: only the one request after resuming.
    expect(claude.agentRequests).toHaveLength(4);

    // The model got the whole run back: every call has its result, the stopped one marked as an error, and the task
    // was not repeated, only the instruction to continue.
    const request = claude.agentRequests[3];
    const results = toolResults(request);
    expect(results.map((result: any) => result.tool_use_id)).toEqual(['step-write', 'step-read', 'step-long']);
    expect(results[2].is_error).toBe(true);
    expect(JSON.stringify(results[1].content)).toContain('done');
    const said = JSON.stringify(request.messages);
    expect(said.split('Do the three steps').length - 1).toBe(1);
    expect(JSON.stringify(request.messages.at(-1).content)).toContain('inspect the current state');
    expect(running.errors).toEqual([]);
  });

  it('stops while an answer is streaming, keeps what was shown, and resumes', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    claude.script({ hang: { text: 'Here is the first half of the ans' } }, text('Here is the whole answer.'));
    const before = claude.agentRequests.length;
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Explain it slowly' }));

    await running.page.getByText('Here is the first half of the ans').waitFor();
    // Changes to a message update its element in place (a new element would make a long chat restyle every frame).
    const bubble = await running.page.locator('.message.assistant').last().elementHandle();
    await running.page.getByRole('button', { name: /Stop/ }).click();
    const stopped = await waitFor((chat) => !chat.busy && chat.resumable);

    expect(stopped.transcript.map((item) => item.kind)).toEqual(['user', 'assistant', 'notice']);
    expect(stopped.transcript[1]).toMatchObject({ text: 'Here is the first half of the ans', streaming: false });
    expect(stopped.transcript[2]).toMatchObject({ text: 'Stopped.' });
    // The message went from streaming to finished in the same element.
    await expect
      .poll(() => bubble!.evaluate((node) => node.isConnected && !node.classList.contains('streaming')))
      .toBe(true);
    // The app gave up on the request: the mock saw the connection close.
    await expect.poll(() => claude.hanging).toBe(false);

    await running.page.getByRole('button', { name: /Resume/ }).click();
    const resumed = await waitFor((chat) => !chat.busy && chat.transcript.at(-1)?.kind === 'assistant');
    expect(resumed.transcript.at(-1)).toMatchObject({ text: 'Here is the whole answer.' });
    expect(claude.agentRequests.length - before).toBe(2);
    // The half answer was never recorded in the model's history, so it is not sent back as if it were complete.
    expect(JSON.stringify(claude.agentRequests.at(-1).messages)).not.toContain('first half');
    expect(running.errors).toEqual([]);
  });
});
