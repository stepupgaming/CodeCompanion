// The complete contract between the main process and the renderer.
//
// InvokeApi: request/response calls from the renderer (ipcRenderer.invoke -> ipcMain.handle).
// EventMap:  one-way pushes from the main process to the renderer (webContents.send -> ipcRenderer.on).
//
// Both sides are typed from these maps, so a renamed channel or changed payload is a compile error.
import type { ApprovalDecision, ChatEvent, ChatSnapshot, ChatSummary, UserMessage } from './chat';
import type { GitStatus, PanelName } from './panels';
import type { ProjectInfo, ProjectSettings } from './project';
import type { SecretName, Settings, SettingsView, McpStatus } from './settings';

export type { McpStatus };

export interface AppInfo {
  version: string;
  platform: string;
}

export interface IndexStatus {
  // False when there is no project open or no OpenAI key (embeddings need one).
  available: boolean;
  reason?: string;
  indexed: boolean;
  indexing: boolean;
  // Chunks embedded so far in the running update; null while idle or still scanning files.
  progress: { embedded: number; total: number } | null;
  files: number;
  chunks: number;
}

// An error that reached the top of the UI, for the local crash log. Message and stack only, never page content.
export interface RendererErrorReport {
  source: 'error' | 'unhandledrejection';
  message: string;
  stack?: string;
}

// What undoing an edit did: put the previous content back, or removed a file the edit had created.
export interface UndoResult {
  path: string;
  action: 'restored' | 'deleted';
}

export type MenuCommand = 'open-project' | 'new-chat' | 'stop' | 'settings';

export type ImageAttachment = NonNullable<UserMessage['images']>[number] & { name: string };

export interface InvokeApi {
  'app:info': () => AppInfo;
  'log:renderer-error': (report: RendererErrorReport) => void;

  'settings:get': () => SettingsView;
  'settings:update': (patch: Partial<Settings>) => SettingsView;
  'settings:set-secret': (name: SecretName, value: string) => SettingsView;

  'index:status': () => IndexStatus;
  'index:rebuild': () => IndexStatus;

  // Connection state and tool names of each configured Model Context Protocol server.
  'mcp:status': () => McpStatus[];

  'project:choose': () => ProjectInfo | null;
  'project:open': (path: string) => ProjectInfo;
  'project:current': () => ProjectInfo | null;
  'project:list': () => ProjectInfo[];
  'project:opened': () => ProjectInfo[];
  'project:close': (path: string) => void;
  'project:set-instructions': (path: string, instructions: string) => ProjectInfo;
  // The instructions and the project's own allow-lists (added to the global ones in Settings).
  'project:update-settings': (path: string, settings: ProjectSettings) => ProjectInfo;
  'project:remove': (path: string) => ProjectInfo[];

  'chat:snapshot': () => ChatSnapshot;
  'chat:send': (message: UserMessage) => void;
  'chat:stop': () => void;
  'chat:resume': () => void;
  // Replaces older turns, in what is sent to the model, by a summary. Settles when the summary is in place.
  'chat:compact': () => void;
  // Puts back the file an approved edit changed (or removes the file it created), if the file is still as the edit left
  // it. The id is the id of the tool card. Refuses while the assistant is working.
  'edit:undo': (toolId: string) => UndoResult;
  'chat:new': () => ChatSnapshot;
  'chat:decide': (approvalId: string, decision: ApprovalDecision) => void;
  // Asks where to save, writes the current chat as Markdown and returns the path (null if cancelled).
  'chat:export': () => string | null;

  'history:list': () => ChatSummary[];
  'history:open': (id: string) => ChatSnapshot;
  'history:delete': (id: string) => ChatSummary[];
  'history:clear': () => ChatSummary[];
  // Chats whose title, project or messages contain every word of the query, with an excerpt for message matches.
  'history:search': (query: string) => ChatSummary[];

  'files:pick-images': () => ImageAttachment[];
  'files:open-in-editor': (path: string) => void;

  'terminal:start': (cols: number, rows: number) => void;
  'terminal:write': (data: string) => void;
  'terminal:resize': (cols: number, rows: number) => void;

  'git:status': () => GitStatus;
  'git:diff': (path: string | null) => string;
  'git:commit': (message: string) => GitStatus;
  'git:discard': (path: string) => GitStatus;
  'git:init': () => GitStatus;
}

export interface EventMap {
  'menu:command': MenuCommand;
  'app:notice': string;
  'settings:changed': SettingsView;
  'project:changed': ProjectInfo | null;
  'chat:event': { chatId: string; event: ChatEvent };
  'chat:snapshot': ChatSnapshot;
  'history:changed': ChatSummary[];
  'terminal:data': string;
  'terminal:exit': null;
  'panel:show': PanelName;
}

export type InvokeChannel = keyof InvokeApi;
export type EventChannel = keyof EventMap;

// Channels the preload script is allowed to forward. Written as records so that adding a channel to the contract
// without listing it here is a compile error.
const INVOKE: Record<InvokeChannel, true> = {
  'app:info': true,
  'log:renderer-error': true,
  'settings:get': true,
  'settings:update': true,
  'settings:set-secret': true,
  'index:status': true,
  'index:rebuild': true,
  'mcp:status': true,
  'project:choose': true,
  'project:open': true,
  'project:current': true,
  'project:list': true,
  'project:opened': true,
  'project:close': true,
  'project:set-instructions': true,
  'project:update-settings': true,
  'project:remove': true,
  'chat:snapshot': true,
  'chat:send': true,
  'chat:stop': true,
  'chat:resume': true,
  'chat:compact': true,
  'edit:undo': true,
  'chat:new': true,
  'chat:decide': true,
  'chat:export': true,
  'history:list': true,
  'history:open': true,
  'history:delete': true,
  'history:clear': true,
  'history:search': true,
  'files:pick-images': true,
  'files:open-in-editor': true,
  'terminal:start': true,
  'terminal:write': true,
  'terminal:resize': true,
  'git:status': true,
  'git:diff': true,
  'git:commit': true,
  'git:discard': true,
  'git:init': true,
};

const EVENTS: Record<EventChannel, true> = {
  'menu:command': true,
  'app:notice': true,
  'settings:changed': true,
  'project:changed': true,
  'chat:event': true,
  'chat:snapshot': true,
  'history:changed': true,
  'terminal:data': true,
  'terminal:exit': true,
  'panel:show': true,
};

export const INVOKE_CHANNELS = Object.keys(INVOKE) as InvokeChannel[];
export const EVENT_CHANNELS = Object.keys(EVENTS) as EventChannel[];
