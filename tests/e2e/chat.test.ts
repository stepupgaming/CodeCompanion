import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot } from '../../src/shared/chat';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

describe('chat end to end (mock Claude API)', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  let web: Server;
  let webUrl: string;
  let webRequests = 0;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-e2e-project-'));
    writeFileSync(join(project, 'notes.txt'), 'The secret word is pineapple.\n');
    writeFileSync(join(project, 'AGENTS.md'), 'Always answer in lowercase.\n');
    claude = new MockClaude();
    const url = await claude.start();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: url });
    web = createServer((_request, response) => {
      webRequests++;
      response.setHeader('content-type', 'text/html');
      response.end('<html><head><title>Network test</title></head><body>Approved page</body></html>');
    });
    await new Promise<void>((resolve) => web.listen(0, '127.0.0.1', resolve));
    webUrl = `http://127.0.0.1:${(web.address() as { port: number }).port}/`;
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    await new Promise<void>((resolve) => web?.close(() => resolve()));
    rmSync(project, { recursive: true, force: true });
  });

  const invoke = (script: string) => running.page.evaluate(script);

  const snapshot = () => running.page.evaluate(() => window.api.invoke('chat:snapshot'));

  // Polls until `check` passes on the current chat snapshot (Playwright's waitForFunction does not await promises).
  async function waitFor<T>(check: (snapshot: ChatSnapshot) => T, timeout = 20_000): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const result = check(await snapshot());
      if (result) return result as NonNullable<T>;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Timed out waiting for the chat');
  }

  const waitForIdle = () => waitFor((current) => (!current.busy && current.transcript.length > 1 ? current : null));

  it('refuses to chat before a project is open', async () => {
    const message = await invoke(
      `window.api.invoke('chat:send', { text: 'hi' }).then(() => 'sent', (error) => error.message)`,
    );
    expect(message).toContain('Open a project');
  });

  it('asks for an API key when none is set', async () => {
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    const message = await invoke(
      `window.api.invoke('chat:send', { text: 'hi' }).then(() => 'sent', (error) => error.message)`,
    );
    expect(message).toContain('Anthropic API key');
  });

  it('runs a tool-using conversation and saves it', async () => {
    await invoke(`window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e')`);
    claude.script(
      {
        blocks: [
          { type: 'text', text: 'Let me read the notes.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'notes.txt' } },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The secret word is pineapple.' }], stopReason: 'end_turn' },
    );

    await invoke(`window.api.invoke('chat:send', { text: 'What is the secret word?' })`);
    const snapshot = await waitForIdle();

    const kinds = snapshot.transcript.map((item) => item.kind);
    expect(kinds).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(snapshot.transcript[2]).toMatchObject({
      name: 'read_file',
      status: 'done',
      summary: 'Read notes.txt (2 lines)',
    });
    expect(snapshot.transcript[3]).toMatchObject({ text: 'The secret word is pineapple.' });

    // The tool result went back to the model with the file content.
    const second = claude.agentRequests[1];
    const toolResult = second.messages.at(-1).content[0];
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    expect(JSON.stringify(toolResult.content)).toContain('pineapple');

    // The system prompt describes the project.
    expect(claude.agentRequests[0].system[0].text).toContain(project.split(/[\\/]/).pop());

    // AGENTS.md is injected into the system prompt and reported to the UI.
    expect(claude.agentRequests[0].system[0].text).toContain('Always answer in lowercase.');
    expect(snapshot.agentFile).toBe('AGENTS.md');

    // Saved automatically, with a generated title.
    let history: any[] = [];
    for (let i = 0; i < 25 && history.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      history = (await invoke(`window.api.invoke('history:list')`)) as any[];
    }
    expect(history[0].title).toBe('Explore the project');
    expect(readdirSync(join(running.userData, 'chats')).some((name) => name.endsWith('.json'))).toBe(true);
  });

  it('waits for approval before editing and applies the edit once approved', async () => {
    claude.script(
      {
        blocks: [
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'edit_file',
            input: { path: 'notes.txt', old_string: 'pineapple', new_string: 'mango' },
          },
        ],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'Changed it.' }], stopReason: 'end_turn' },
    );
    await invoke(`window.api.invoke('chat:send', { text: 'Change the word to mango' })`);

    const pending = await waitFor((current) =>
      current.transcript.find((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    expect(pending.kind === 'tool' && pending.preview?.diff).toContain('+The secret word is mango.');

    await running.page.evaluate(
      (approvalId) => window.api.invoke('chat:decide', approvalId, { approved: true }),
      pending.id,
    );
    await waitFor((current) => !current.busy && current.transcript.at(-1)?.kind === 'assistant');
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toContain('mango');
  });

  it('reopens a saved chat from history', async () => {
    const before = (await invoke(`window.api.invoke('chat:snapshot')`)) as ChatSnapshot;
    await invoke(`window.api.invoke('chat:new')`);
    const empty = (await invoke(`window.api.invoke('chat:snapshot')`)) as ChatSnapshot;
    expect(empty.transcript).toEqual([]);

    const reopened = (await running.page.evaluate(
      (id) => window.api.invoke('history:open', id),
      before.id,
    )) as ChatSnapshot;
    expect(reopened.transcript.map((item) => item.kind)).toEqual(before.transcript.map((item) => item.kind));
    expect(existsSync(join(running.userData, 'chats', `${before.id}.json`))).toBe(true);
  });

  it.each(['fetch_url', 'browser'])('asks before %s contacts an unlisted host', async (name) => {
    await running.page.evaluate(() =>
      window.api.invoke('settings:update', { approvalMode: 'ask', allowedNetworkHosts: '' }),
    );
    const before = webRequests;
    claude.script({
      blocks: [{ type: 'tool_use', id: `network-${name}`, name, input: { url: webUrl } }],
      stopReason: 'tool_use',
    });
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Open the test page' }));
    const pending = await waitFor((current) =>
      current.transcript.find((item) => item.kind === 'tool' && item.status === 'awaiting-approval'),
    );
    expect(pending).toMatchObject({ preview: { title: expect.stringContaining(webUrl) } });
    expect(webRequests).toBe(before);
    if (process.env.E2E_SCREENSHOTS) {
      await running.page.screenshot({ path: join(process.env.E2E_SCREENSHOTS, `${name}-approval.png`) });
    }
    await running.page.evaluate((id) => window.api.invoke('chat:decide', id, { approved: false }), pending.id);
    await waitFor((current) => !current.busy);
    expect(webRequests).toBe(before);
  });

  it.each(['ask', 'auto'] as const)('runs allowed network calls in %s mode', async (approvalMode) => {
    await running.page.evaluate(
      (mode) =>
        window.api.invoke('settings:update', {
          approvalMode: mode,
          allowedNetworkHosts: mode === 'ask' ? '127.0.0.1' : '',
        }),
      approvalMode,
    );
    const before = webRequests;
    claude.script(
      {
        blocks: [{ type: 'tool_use', id: `allowed-${approvalMode}`, name: 'fetch_url', input: { url: webUrl } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: `Network ${approvalMode} complete` }], stopReason: 'end_turn' },
    );
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Fetch the test page' }));
    const current = await waitForIdle();
    expect(webRequests).toBe(before + 1);
    expect(current.transcript.at(-1)).toMatchObject({ text: `Network ${approvalMode} complete` });
  });

  it('runs without renderer errors', () => {
    expect(running.errors).toEqual([]);
  });
});
