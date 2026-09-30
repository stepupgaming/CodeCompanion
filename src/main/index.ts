import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { join } from 'node:path';
import { SECRET_NAMES } from '@shared/settings';
import { ToolErrorLog } from './agent/tool_error_log';
import { EditBackups } from './tools/edit_backups';
import { appLog } from './app_log';
import { ChatManager } from './chat_manager';
import { ChatStore } from './chat_store';
import { chatToMarkdown, exportFileName } from '@shared/export';
import { openInEditor, pickImages, saveTextFile } from './files';
import { handle, send } from './ipc';
import { LlmService } from './llm';
import { createOpenAIClient } from './llm/openai';
import { CodeIndex, openAIEmbedder, searchCodeTool } from './search/code_index';
import { buildMenu } from './menu';
import { ProjectStore } from './projects';
import { RendererErrorReporter } from './renderer_errors';
import { SettingsStore } from './settings';
import { Workspace } from './tools/workspace';
import type { IndexStatus } from '@shared/ipc';
import { BrowserService } from './panels/browser';
import { GitService } from './panels/git';
import { TerminalService } from './panels/terminal';
import { createMainWindow } from './window';

app.setName('Patch');

app.setPath('userData', process.env.PATCH_USER_DATA || join(app.getPath('appData'), 'Patch'));

// Crashes and other problems go to a local log (never sent anywhere). Set up before anything else can fail.
appLog.setFile(join(app.getPath('userData'), 'logs', 'app.log.jsonl'));
process.on('uncaughtException', (error) => {
  appLog.error('uncaught-exception', error);
  // A listener replaces Electron's own error dialog, so keep telling the user.
  dialog.showErrorBox('Patch hit an unexpected error', error instanceof Error ? error.message : String(error));
});
process.on('unhandledRejection', (reason) => appLog.error('unhandled-rejection', reason));
app.on('render-process-gone', (_event, _contents, details) =>
  appLog.error('render-process-gone', `The UI process ended: ${details.reason}`, { exitCode: details.exitCode }),
);
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') {
    appLog.error('child-process-gone', `A ${details.type} process ended: ${details.reason}`, {
      exitCode: details.exitCode,
    });
  }
});

// End-to-end tests run in an invisible window (see window.ts). Chromium would treat it as hidden or covered and slow
// its timers and rendering, which makes tests time out, so that is switched off for test runs only.
if (process.env.PATCH_E2E_QUIET === '1') {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

let mainWindow: BrowserWindow | null = null;

function createSettings(): SettingsStore {
  return new SettingsStore(join(app.getPath('userData'), 'settings.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, 'base64')),
  });
}

function start(): void {
  appLog.info('app', 'Started.', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
  });
  const userData = app.getPath('userData');
  const settings = createSettings();
  const projects = new ProjectStore(join(userData, 'projects.json'));
  const chats = new ChatStore(join(userData, 'chats'));
  const editBackups = new EditBackups(join(userData, 'edit-backups'));
  const toolErrorLog = new ToolErrorLog(join(userData, 'logs', 'tool-input-errors.jsonl'));
  const llm = new LlmService(settings);
  const browser = new BrowserService(() => send(mainWindow, 'panel:show', 'browser'));
  const terminal = new TerminalService(
    (data) => send(mainWindow, 'terminal:data', data),
    () => send(mainWindow, 'terminal:exit', null),
  );
  const git = () => {
    const project = projects.current();
    if (!project) throw new Error('No project is open.');
    return new GitService(project.path);
  };
  const codeIndexes = new Map<string, CodeIndex>();
  // A changed key or endpoint means new embeddings; drop cached indexes so they are rebuilt with the new client.
  settings.on('change', () => codeIndexes.clear());

  const indexFor = (workspace: Workspace): CodeIndex | null => {
    // Embeddings use the OpenAI API, so semantic search is offered only when that key is set.
    const key = settings.getSecret('openaiApiKey');
    if (!key) return null;
    let index = codeIndexes.get(workspace.root);
    if (!index) {
      const embedder = openAIEmbedder(createOpenAIClient(key, settings.get().openaiBaseUrl));
      index = new CodeIndex(workspace, embedder, join(userData, 'indexes'), () => settings.get().maxIndexedFiles);
      codeIndexes.set(workspace.root, index);
    }
    return index;
  };
  const indexStatus = (index: CodeIndex | null, reason?: string): IndexStatus =>
    index
      ? {
          available: true,
          indexed: index.fileCount > 0,
          indexing: index.isUpdating,
          progress: index.updateProgress,
          files: index.fileCount,
          chunks: index.chunkCount,
        }
      : { available: false, reason, indexed: false, indexing: false, progress: null, files: 0, chunks: 0 };
  const currentIndex = (): { index: CodeIndex | null; reason?: string } => {
    const project = projects.current();
    if (!project) return { index: null, reason: 'Open a project first.' };
    const index = indexFor(new Workspace(project.path));
    return index ? { index } : { index: null, reason: 'Set an OpenAI API key to enable code indexing.' };
  };

  const manager = new ChatManager({
    settings,
    projects,
    chats,
    llm,
    browser: () => browser,
    codeSearch: (workspace) => {
      const index = indexFor(workspace);
      return index ? { search: index, tools: [searchCodeTool(index)] } : null;
    },
    emit: (event, chatId) => {
      // Model and provider failures shown in the chat (the error text, not the conversation).
      if (event.type === 'error') appLog.error('chat', event.text);
      send(mainWindow, 'chat:event', { chatId, event });
    },
    onSnapshot: (snapshot) => send(mainWindow, 'chat:snapshot', snapshot),
    onHistoryChanged: () => send(mainWindow, 'history:changed', chats.list()),
    onDroppedFields: (error) => toolErrorLog.record(error),
    edits: editBackups,
  });

  const openProject = (path: string) => {
    manager.requireIdle();
    const project = projects.open(path);
    manager.projectChanged();
    terminal.stop();
    send(mainWindow, 'project:changed', project);
    return project;
  };

  handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));
  const rendererErrors = new RendererErrorReporter(appLog);
  handle('log:renderer-error', (report) => rendererErrors.report(report));

  handle('settings:get', () => settings.view());
  handle('settings:update', (patch) => settings.update(patch));
  handle('settings:set-secret', (name, value) => {
    if (!SECRET_NAMES.includes(name)) throw new Error(`Unknown secret: ${name}`);
    return settings.setSecret(name, value);
  });
  settings.on('change', (view) => send(mainWindow, 'settings:changed', view));

  handle('index:status', () => {
    const { index, reason } = currentIndex();
    return indexStatus(index, reason);
  });
  handle('index:rebuild', async () => {
    const { index, reason } = currentIndex();
    if (!index) throw new Error(reason);
    await index.rebuild();
    return indexStatus(index);
  });

  handle('project:choose', async () => {
    const options = { properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled || !result.filePaths[0] ? null : openProject(result.filePaths[0]);
  });
  handle('project:open', (path) => openProject(path));
  handle('project:current', () => projects.current());
  handle('project:list', () => projects.list());
  handle('project:opened', () => projects.opened());
  handle('project:close', (path) => {
    manager.requireIdle();
    manager.closeProject(path);
    projects.close(path);
    manager.projectChanged();
    terminal.stop();
    send(mainWindow, 'project:changed', projects.current());
  });
  handle('project:set-instructions', (path, instructions) => projects.setInstructions(path, instructions));
  handle('project:update-settings', (path, projectSettings) => projects.updateSettings(path, projectSettings));
  handle('project:remove', (path) => {
    manager.requireIdle();
    manager.closeProject(path);
    projects.remove(path);
    manager.projectChanged();
    terminal.stop();
    send(mainWindow, 'project:changed', projects.current());
    return projects.list();
  });

  handle('chat:snapshot', () => manager.snapshot());
  handle('chat:send', (message) => {
    // Returns once the chat has started; progress arrives as chat:event messages.
    manager.send(message).catch(() => {});
  });
  handle('chat:stop', () => manager.stop());
  handle('chat:resume', () => {
    manager.resume().catch(() => {});
  });
  // Awaited, unlike send and resume, so a setup problem (no summarizing model, nothing to compact) reaches the UI.
  handle('chat:compact', () => manager.compact());
  handle('edit:undo', (toolId) => manager.undoEdit(typeof toolId === 'string' ? toolId : ''));
  handle('chat:new', () => manager.newChat());
  handle('chat:decide', (approvalId, decision) => manager.decide(approvalId, decision));
  handle('chat:export', () => {
    const chat = manager.snapshot();
    if (chat.transcript.length === 0) throw new Error('This chat is empty; there is nothing to export.');
    return saveTextFile(mainWindow, exportFileName(chat.title), chatToMarkdown(chat));
  });

  handle('history:list', () => chats.list());
  handle('history:open', (id) => {
    const snapshot = manager.open(id);
    terminal.stop();
    send(mainWindow, 'project:changed', projects.current());
    return snapshot;
  });
  handle('history:delete', (id) => {
    manager.forget([id]);
    chats.delete(id);
    // The backups of a chat's edits go with the chat.
    editBackups.deleteChat(id);
    return chats.list();
  });
  handle('history:search', (query) => chats.search(typeof query === 'string' ? query.slice(0, 200) : ''));
  handle('history:clear', () => {
    manager.forget('all');
    chats.deleteAll();
    editBackups.deleteAll();
    return chats.list();
  });

  handle('files:pick-images', () => pickImages(mainWindow));
  handle('files:open-in-editor', (path) => {
    const project = projects.current();
    if (!project) throw new Error('No project is open.');
    openInEditor(settings.get().editorCommand, project.path, path);
  });

  handle('terminal:start', (cols, rows) => {
    const project = projects.current();
    if (!project) throw new Error('Open a project to use the terminal.');
    terminal.start(project.path, cols, rows);
  });
  handle('terminal:write', (data) => terminal.write(data));
  handle('terminal:resize', (cols, rows) => terminal.resize(cols, rows));

  handle('git:status', () => git().status());
  handle('git:diff', (path) => git().diff(path));
  handle('git:commit', (message) => git().commit(message));
  handle('git:discard', (path) => git().discard(path));
  handle('git:init', () => git().init());

  const openWindow = () => createMainWindow((guest) => browser.attach(guest));
  buildMenu(() => mainWindow, join(userData, 'logs'));
  mainWindow = openWindow();
  mainWindow.on('closed', () => (mainWindow = null));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = openWindow();
    }
  });
  app.on('before-quit', () => {
    manager.dispose();
    terminal.stop();
  });
}

app.whenReady().then(start);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
