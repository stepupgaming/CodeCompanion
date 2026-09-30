import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ChatSnapshot, TranscriptItem } from '../../src/shared/chat';
import type { McpServerConfig, McpStatus } from '../../src/shared/settings';
import { launchApp, type RunningApp } from './app';
import { MockClaude } from './mock_claude';

// MCP servers configured in Settings must have their tools offered to the model (namespaced and
// approval-gated), and a call must reach the server and return its output.
describe('MCP tools end to end', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  const mockServerScript = join(__dirname, 'mock_mcp_server.mjs');

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'cc-mcp-e2e-'));
    writeFileSync(join(project, 'file.txt'), 'original\n');
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-e2e'));
    const servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    await running.page.evaluate(
      (configured) => window.api.invoke('settings:update', { mcpServers: configured }),
      servers,
    );
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
  });

  async function mcpStatus(): Promise<McpStatus[]> {
    return running.page.evaluate(() => window.api.invoke('mcp:status'));
  }

  async function waitForStatus(): Promise<McpStatus[]> {
    for (let index = 0; index < 50; index++) {
      const status = await mcpStatus();
      if (status[0]?.state === 'connected') return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`MCP server never connected: ${JSON.stringify(await mcpStatus())}`);
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

  it('offers a namespaced tool and runs it after approval', async () => {
    const status = await waitForStatus();
    expect(status[0]!.tools).toEqual(['mcp_test_echo']);

    claude.script(
      {
        blocks: [{ type: 'tool_use', id: 'mcp-1', name: 'mcp_test_echo', input: { text: 'hello' } }],
        stopReason: 'tool_use',
      },
      { blocks: [{ type: 'text', text: 'The tool answered.' }], stopReason: 'end_turn' },
    );

    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Echo hello with the test tool' }));
    const isPendingTool = (item: TranscriptItem): item is Extract<TranscriptItem, { kind: 'tool' }> =>
      item.kind === 'tool' && item.status === 'awaiting-approval';
    await waitFor((chat) => chat.transcript.some(isPendingTool));

    // The MCP tool waits for approval like file edits do; approve it.
    const pending = (await snapshot()).transcript.find(isPendingTool);
    await running.page.evaluate((id) => window.api.invoke('chat:decide', id, { approved: true }), pending!.id);

    const finished = await waitFor((chat) => !chat.busy);
    const toolRow = finished.transcript.find(
      (item): item is Extract<TranscriptItem, { kind: 'tool' }> => item.kind === 'tool',
    );
    expect(toolRow).toMatchObject({ status: 'done', summary: 'mcp_test_echo' });
    expect(JSON.stringify(claude.agentRequests.at(-1))).toContain('echo:hello');
    expect(running.errors).toEqual([]);
  });
});
