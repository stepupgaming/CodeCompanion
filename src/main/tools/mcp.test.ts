import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { McpServerConfig } from '@shared/settings';
import { McpHub } from './mcp';

// The mock MCP server used by the end-to-end tests; spawning it here exercises the real client over stdio.
const mockServerScript = join(__dirname, '../../../tests/e2e/mock_mcp_server.mjs');

describe('McpHub', () => {
  it('connects over stdio, lists tools and calls one', async () => {
    const servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    let changed = 0;
    const hub = new McpHub(
      () => servers,
      () => changed++,
    );
    try {
      await hub.refresh();

      expect(changed).toBe(1);
      expect(hub.status()).toEqual([{ name: 'test', state: 'connected', tools: ['mcp_test_echo'] }]);
      const tools = hub.tools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.requiresApproval).toBe(true);
      expect(tools[0]!.jsonSchema).toEqual({
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      });

      const output = await tools[0]!.run({ text: 'hi' }, {} as never);
      expect(output.content).toBe('echo:hi');
      expect(output.isError).toBeUndefined();
    } finally {
      await hub.stop();
    }
  });

  it('reports a server that cannot start and still serves the others', async () => {
    const servers: McpServerConfig[] = [
      { name: 'broken', transport: 'stdio', command: 'definitely-not-a-real-command-12345' },
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    try {
      await hub.refresh();
      const status = Object.fromEntries(hub.status().map((entry) => [entry.name, entry]));
      expect(status.broken).toMatchObject({ state: 'error' });
      expect(status.broken!.error).toBeTruthy();
      expect(status.test).toMatchObject({ state: 'connected' });
      expect(hub.tools().map((tool) => tool.name)).toEqual(['mcp_test_echo']);
    } finally {
      await hub.stop();
    }
  });

  it('drops removed servers and reconnects changed ones', async () => {
    let servers: McpServerConfig[] = [
      { name: 'test', transport: 'stdio', command: process.execPath, args: [mockServerScript] },
    ];
    const hub = new McpHub(
      () => servers,
      () => {},
    );
    try {
      await hub.refresh();
      expect(hub.tools()).toHaveLength(1);

      servers = [];
      await hub.refresh();
      expect(hub.tools()).toEqual([]);
      expect(hub.status()).toEqual([]);
    } finally {
      await hub.stop();
    }
  });
});
