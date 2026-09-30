import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpStatus } from '@shared/settings';
import type { JsonObjectSchema } from '../llm/types';
import { ToolError, type AgentTool, type ToolOutput } from './types';

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 120_000;

interface ServerState {
  config: McpServerConfig;
  client: Client | null;
  error?: string;
  tools: AgentTool[];
}

interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: JsonObjectSchema;
}

// Connects to the configured Model Context Protocol servers and exposes their tools to the agent. Connections are
// refreshed in the background; the per-turn tool callback needs a synchronous list, so it reads the cache.
export class McpHub {
  private readonly states = new Map<string, ServerState>();
  private updating: Promise<void> | null = null;

  constructor(
    private readonly getServers: () => McpServerConfig[],
    private readonly onToolsChanged: () => void,
    private readonly clientInfo = { name: 'CodeCompanion', version: '0.1.0' },
  ) {}

  // Reconnects every configured server in the background. Called at startup and when the servers setting changes.
  start(): void {
    void this.refresh();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => closeClient(state)));
  }

  tools(): AgentTool[] {
    return [...this.states.values()].flatMap((state) => state.tools);
  }

  status(): McpStatus[] {
    return this.getServers().map((config) => {
      const state = this.states.get(config.name);
      if (!state) return { name: config.name, state: 'disabled' as const, tools: [] };
      return {
        name: config.name,
        state: state.client ? ('connected' as const) : ('error' as const),
        error: state.error,
        tools: state.tools.map((tool) => tool.name),
      };
    });
  }

  async refresh(): Promise<void> {
    this.updating ??= this.refreshNow().finally(() => (this.updating = null));
    return this.updating;
  }

  private async refreshNow(): Promise<void> {
    const configs = this.getServers();
    for (const [name, state] of [...this.states]) {
      if (!configs.some((config) => config.name === name)) {
        await closeClient(state);
        this.states.delete(name);
      }
    }
    await Promise.all(configs.map((config) => this.connectOne(config)));
    this.onToolsChanged();
  }

  private async connectOne(config: McpServerConfig): Promise<void> {
    const existing = this.states.get(config.name);
    if (existing?.client && JSON.stringify(existing.config) === JSON.stringify(config)) return;
    if (existing) {
      await closeClient(existing);
      existing.client = null;
      existing.tools = [];
    }
    const state: ServerState = existing ?? { config, client: null, tools: [] };
    state.config = config;
    this.states.set(config.name, state);
    // Tool names are unique across all servers; take the current ones, then add each chosen name as we map tools.
    const taken = new Set(
      [...this.states.values()]
        .filter((entry) => entry !== state)
        .flatMap((entry) => entry.tools.map((tool) => tool.name)),
    );

    try {
      const client = new Client(this.clientInfo, { capabilities: {} });
      const transport =
        config.transport === 'stdio'
          ? new StdioClientTransport({
              command: config.command!,
              args: config.args ?? [],
              env: { ...getDefaultEnvironment(), ...config.env },
            })
          : new StreamableHTTPClientTransport(new URL(config.url!), { requestInit: { headers: config.headers } });
      await withTimeout(client.connect(transport), `connecting to ${config.name} timed out`);
      const listed = await withTimeout(client.listTools(), `listing tools of ${config.name} timed out`);
      state.client = client;
      state.error = undefined;
      state.tools = listed.tools.map((tool) => this.toAgentTool(config, state, tool as McpToolDescription, taken));
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      state.tools = [];
    }
  }

  private toAgentTool(
    config: McpServerConfig,
    state: ServerState,
    tool: McpToolDescription,
    taken: Set<string>,
  ): AgentTool {
    const name = qualifiedToolName(config.name, tool.name, taken);
    taken.add(name);
    return {
      name,
      description: tool.description ?? '',
      jsonSchema: tool.inputSchema ?? { type: 'object' },
      // MCP tools come from outside the app; they always wait for approval like file edits do.
      requiresApproval: true,
      run: async (input) => {
        const client = state.client;
        if (!client) throw new ToolError(`The MCP server "${config.name}" is not connected.`);
        const result = await client.callTool({ name: tool.name, arguments: input }, undefined, {
          timeout: CALL_TIMEOUT_MS,
        });
        return toToolOutput(result as McpToolResult);
      },
    };
  }
}

// Namespaced tool name the model sees: mcp_<server>_<tool>, sanitized to what the provider APIs accept.
function qualifiedToolName(server: string, tool: string, taken: Set<string>): string {
  const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32);
  let name = `mcp_${sanitize(server)}_${sanitize(tool)}`.slice(0, 64);
  for (let suffix = 2; taken.has(name); suffix++) name = `${name.slice(0, 62)}_${suffix}`;
  return name;
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function toToolOutput(result: McpToolResult): ToolOutput {
  const text = (result.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
  const images = (result.content ?? []).flatMap((block) =>
    block.type === 'image' && block.data && isSupportedImage(block.mimeType)
      ? [{ mediaType: block.mimeType as 'image/png', base64: block.data }]
      : [],
  );
  return { content: text || '(no output)', isError: result.isError || undefined, images };
}

function isSupportedImage(mimeType: unknown): mimeType is 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/gif' || mimeType === 'image/webp';
}

async function closeClient(state: ServerState): Promise<void> {
  try {
    await state.client?.close();
  } catch {
    // A server that will not close cleanly does not matter; the process is going away anyway.
  }
  state.client = null;
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), CONNECT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
