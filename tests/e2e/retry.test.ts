import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('retrying transient provider errors (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-retry-project-'));
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

  async function waitForIdle(timeout = 20_000): Promise<ChatSnapshot> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await snapshot();
      if (!current.busy && current.transcript.some((item) => item.kind === 'assistant' || item.kind === 'error'))
        return current;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for the chat');
  }

  it('waits out a rate limit, shows the retry in the chat and then answers', async () => {
    claude.script(
      { failure: { status: 429, type: 'rate_limit_error', retryAfterSeconds: 1 } },
      { failure: { status: 529, type: 'overloaded_error', retryAfterSeconds: 1 } },
      { blocks: [{ type: 'text', text: 'Back again.' }], stopReason: 'end_turn' },
    );
    const before = claude.agentRequests.length;
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Are you there?' }));

    const done = await waitForIdle();

    // One request per attempt: the SDK no longer retries behind the app's back.
    expect(claude.agentRequests.length - before).toBe(3);
    expect(done.transcript.map((item) => item.kind)).toEqual(['user', 'notice', 'notice', 'assistant']);
    expect(
      done.transcript.filter((item) => item.kind === 'notice').map((item) => (item as { text: string }).text),
    ).toEqual([
      'Rate limited (429). Retrying in 1 s (retry 1 of 4)…',
      'Provider overloaded (529). Retrying in 1 s (retry 2 of 4)…',
    ]);
    expect(done.transcript.at(-1)).toMatchObject({ kind: 'assistant', text: 'Back again.' });
    // The retries are part of the saved chat too.
    const saved = await running.page.evaluate(() => window.api.invoke('history:list'));
    expect(saved.length).toBeGreaterThan(0);
  });

  it('shows an error that a retry cannot fix straight away', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    claude.script({ failure: { status: 401, type: 'authentication_error' } });
    const before = claude.agentRequests.length;
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Hello?' }));

    const done = await waitForIdle();

    expect(claude.agentRequests.length - before).toBe(1);
    expect(done.transcript.map((item) => item.kind)).toEqual(['user', 'error']);
  });

  it('can be stopped while it waits to retry', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    claude.script({ failure: { status: 503, type: 'api_error', retryAfterSeconds: 30 } });
    const before = claude.agentRequests.length;
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Wait for me' }));

    const deadline = Date.now() + 10_000;
    while (!(await snapshot()).transcript.some((item) => item.kind === 'notice') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const stopped = Date.now();
    await running.page.evaluate(() => window.api.invoke('chat:stop'));
    const done = await (async () => {
      while (Date.now() < stopped + 10_000) {
        const current = await snapshot();
        if (!current.busy) return current;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Still busy after Stop');
    })();

    // Stopped well before the 30 second wait was over, with nothing sent again.
    expect(Date.now() - stopped).toBeLessThan(5_000);
    expect(claude.agentRequests.length - before).toBe(1);
    expect(done.transcript.at(-1)).toMatchObject({ kind: 'notice', text: 'Stopped.' });
    expect(done.resumable).toBe(true);
  });
});
