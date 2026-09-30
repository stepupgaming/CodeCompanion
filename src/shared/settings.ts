import { DEFAULT_MODEL, type Effort } from './models';

export type Theme = 'dark' | 'light';

// 'ask': file edits and shell commands wait for approval. 'auto': the agent runs them directly.
export type ApprovalMode = 'ask' | 'auto';

// One Model Context Protocol server whose tools are offered to the agent. Stdio servers run as child processes of
// the app; HTTP servers are Streamable HTTP endpoints.
export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  // Stdio: executable and arguments.
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP: endpoint URL.
  url?: string;
  headers?: Record<string, string>;
}

export interface McpStatus {
  name: string;
  state: 'connected' | 'error' | 'disabled';
  error?: string;
  tools: string[];
}

export interface Settings {
  model: string;
  // How much the model thinks before acting (current Claude models and OpenAI via the Responses API).
  effort: Effort;
  approvalMode: ApprovalMode;
  // Plan mode: the agent proposes a plan as an approval card before working through multi-step changes.
  planMode: boolean;
  // Commands that run without approval in 'ask' mode, one per line; a line also allows the command with arguments
  // ("npm test" allows "npm test -- foo"). Commands with shell operators (; & | > < ` $() are never allowed this way.
  allowedCommands: string;
  // Exact http(s) URL hostnames that network tools may contact without asking, one per line.
  allowedNetworkHosts: string;
  theme: Theme;
  // Base URL for an OpenAI-compatible API. Empty means api.openai.com.
  openaiBaseUrl: string;
  // Command used to open files from chat links, e.g. "code" or "cursor". The file path is appended.
  editorCommand: string;
  maxIndexedFiles: number;
  googleSearchEngineId: string;
  // Model Context Protocol servers. Their tools are offered to the agent with approval required, like file edits.
  mcpServers: McpServerConfig[];
}

export const DEFAULT_SETTINGS: Settings = {
  model: DEFAULT_MODEL,
  effort: 'high',
  approvalMode: 'ask',
  planMode: false,
  allowedCommands: '',
  allowedNetworkHosts: '',
  theme: 'dark',
  openaiBaseUrl: '',
  editorCommand: 'code',
  maxIndexedFiles: 2000,
  googleSearchEngineId: '',
  mcpServers: [],
};

export type SecretName = 'anthropicApiKey' | 'openaiApiKey' | 'googleApiKey';

export const SECRET_NAMES: SecretName[] = ['anthropicApiKey', 'openaiApiKey', 'googleApiKey'];

// Validates one entry of the MCP servers setting; returns an error message or null when it is usable.
function mcpServerError(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return 'every entry must be an object';
  const server = entry as Record<string, unknown>;
  if (typeof server.name !== 'string' || !server.name.trim()) return '"name" is required';
  if (server.transport !== 'stdio' && server.transport !== 'http') return '"transport" must be "stdio" or "http"';
  if (server.transport === 'stdio' && typeof server.command !== 'string') return 'stdio servers need a "command"';
  if (server.transport === 'http' && (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url)))
    return 'http servers need an "url" starting with http(s)://';
  for (const key of ['args', 'headers', 'env'] as const) {
    const value = server[key];
    if (value === undefined) continue;
    if (key === 'args') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        return '"args" must be string arrays';
    } else if (typeof value !== 'object' || value === null) {
      return `"${key}" must be an object`;
    }
  }
  return null;
}

// Parses the JSON the settings dialog collects for MCP servers, throwing a readable error when unusable.
export function parseMcpServers(text: string): McpServerConfig[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`MCP servers must be valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) throw new Error('MCP servers must be a JSON array of server objects.');
  for (const [index, entry] of parsed.entries()) {
    const problem = mcpServerError(entry);
    if (problem) throw new Error(`MCP servers: entry ${index + 1}: ${problem}`);
  }
  return parsed as McpServerConfig[];
}

// Drops entries that cannot work (e.g. from a hand-edited settings file) instead of failing to start.
export function sanitizeMcpServers(servers: unknown): McpServerConfig[] {
  if (!Array.isArray(servers)) return [];
  return servers.filter((entry) => mcpServerError(entry) === null) as McpServerConfig[];
}

// What the renderer sees. Secrets never leave the main process; the UI only learns whether each one is set.
export interface SettingsView extends Settings {
  secrets: Record<SecretName, boolean>;
  secretsEncrypted: boolean;
}
