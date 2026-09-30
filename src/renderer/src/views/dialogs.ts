import { filterChats, type ChatSummary } from '@shared/chat';
import { formatCost, MODEL_OPTIONS, type Effort } from '@shared/models';
import { describeIndexStatus } from '@shared/index_status';
import type { IndexStatus, McpStatus } from '@shared/ipc';
import type { ProjectInfo, ProjectSettings } from '@shared/project';
import type { SecretName, Settings, SettingsView } from '@shared/settings';
import { parseMcpServers } from '@shared/settings';
import { h, icon } from '../dom';

function dialog(title: string, body: HTMLElement, footer: HTMLElement): HTMLDialogElement {
  const titleId = `dialog-title-${Math.random().toString(36).slice(2)}`;
  const element = h(
    'dialog',
    { class: 'app-dialog', 'aria-labelledby': titleId },
    h(
      'form',
      { method: 'dialog', class: 'dialog-content' },
      h(
        'div',
        { class: 'dialog-header' },
        h('h2', { id: titleId, class: 'h5 m-0' }, title),
        h('button', { class: 'btn-close', type: 'button', 'aria-label': 'Close', onclick: () => element.close() }),
      ),
      h('div', { class: 'dialog-body' }, body),
      h('div', { class: 'dialog-footer' }, footer),
    ),
  );
  element.addEventListener('close', () => element.remove());
  document.body.appendChild(element);
  element.showModal();
  return element;
}

function field(label: string, control: HTMLElement, help?: string): HTMLElement {
  const id = `field-${Math.random().toString(36).slice(2)}`;
  // The label must point at the input itself, which may be wrapped (e.g. in an input group).
  const target = control.matches('input, select, textarea')
    ? control
    : control.querySelector('input, select, textarea');
  (target ?? control).id = id;
  return h(
    'div',
    { class: 'mb-3' },
    h('label', { class: 'form-label', for: id }, label),
    control,
    help ? h('div', { class: 'form-text' }, help) : null,
  );
}

const SECRET_LABELS: Record<SecretName, [string, string]> = {
  anthropicApiKey: ['Anthropic API key', 'Needed for Claude models.'],
  openaiApiKey: ['OpenAI API key', 'Needed for OpenAI models and for semantic code search (embeddings).'],
  googleApiKey: ['Google API key', 'Optional, for web search. Also set the search engine id below.'],
};

export interface SettingsDialogActions {
  update(patch: Partial<Settings>): Promise<SettingsView>;
  setSecret(name: SecretName, value: string): Promise<SettingsView>;
  indexStatus(): Promise<IndexStatus>;
  rebuildIndex(): Promise<IndexStatus>;
  mcpStatus(): Promise<McpStatus[]>;
}

export function openSettingsDialog(settings: SettingsView, actions: SettingsDialogActions): void {
  const secretInputs = new Map<SecretName, HTMLInputElement>();
  const secretFields = (Object.keys(SECRET_LABELS) as SecretName[]).map((name) => {
    const [label, help] = SECRET_LABELS[name];
    const input = h('input', {
      type: 'password',
      class: 'form-control',
      autocomplete: 'off',
      placeholder: settings.secrets[name] ? 'Saved. Enter a new key to replace it.' : 'Not set',
    });
    secretInputs.set(name, input);
    const remove = settings.secrets[name]
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-outline-danger',
            onclick: async () => {
              await actions.setSecret(name, '');
              input.placeholder = 'Not set';
              remove?.remove();
            },
          },
          'Remove',
        )
      : null;
    return field(label, h('div', { class: 'input-group' }, input, remove), help);
  });

  const known = MODEL_OPTIONS.some((option) => option.id === settings.model);
  const modelSelect = h(
    'select',
    { class: 'form-select' },
    ...MODEL_OPTIONS.map((option) =>
      h('option', { value: option.id, selected: option.id === settings.model }, option.label),
    ),
    h('option', { value: '__custom', selected: !known }, 'Other model id…'),
  );
  const customModel = h('input', {
    class: 'form-control mt-2',
    value: known ? '' : settings.model,
    placeholder: 'e.g. claude-sonnet-5-5',
    hidden: known,
  });
  modelSelect.addEventListener('change', () => (customModel.hidden = modelSelect.value !== '__custom'));

  const effort = h(
    'select',
    { class: 'form-select' },
    ...(['low', 'medium', 'high', 'xhigh', 'max'] as Effort[]).map((level) =>
      h('option', { value: level, selected: level === settings.effort }, level),
    ),
  );
  const approval = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'ask', selected: settings.approvalMode === 'ask' }, 'Ask before edits and commands'),
    h('option', { value: 'auto', selected: settings.approvalMode === 'auto' }, 'Run edits and commands without asking'),
  );
  const allowedCommands = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: settings.allowedCommands,
    placeholder: 'npm test\nnpm run lint\ngit status',
  });
  const allowedNetworkHosts = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: settings.allowedNetworkHosts,
    placeholder: 'api.example.com\nlocalhost',
  });
  const theme = h(
    'select',
    { class: 'form-select' },
    h('option', { value: 'dark', selected: settings.theme === 'dark' }, 'Dark'),
    h('option', { value: 'light', selected: settings.theme === 'light' }, 'Light'),
  );
  const baseUrl = h('input', {
    class: 'form-control',
    value: settings.openaiBaseUrl,
    placeholder: 'https://api.openai.com/v1',
  });
  const searchEngine = h('input', { class: 'form-control', value: settings.googleSearchEngineId });
  const editor = h('input', { class: 'form-control', value: settings.editorCommand });
  const maxFiles = h('input', {
    class: 'form-control',
    type: 'number',
    min: 1,
    value: String(settings.maxIndexedFiles),
  });
  const error = h('div', { class: 'text-danger me-auto small' });

  const indexText = h('span', { class: 'small text-body-secondary flex-grow-1' }, 'Checking…');
  const reindex = h('button', { type: 'button', class: 'btn btn-outline-secondary btn-sm', disabled: true }, 'Reindex');
  // While an update runs (a rebuild, or one started by a code search), poll the status to show its progress.
  let poll: ReturnType<typeof setInterval> | undefined;
  const stopPolling = () => {
    clearInterval(poll);
    poll = undefined;
  };
  const startPolling = () => {
    poll ??= setInterval(() => void actions.indexStatus().then(showIndex, () => {}), 1000);
  };
  const showIndex = (status: IndexStatus) => {
    indexText.textContent = describeIndexStatus(status);
    reindex.disabled = !status.available || status.indexing;
    if (status.indexing) startPolling();
    else stopPolling();
  };
  reindex.addEventListener('click', async () => {
    reindex.disabled = true;
    indexText.textContent = 'Indexing… scanning files';
    startPolling();
    try {
      showIndex(await actions.rebuildIndex());
    } catch (err) {
      stopPolling();
      indexText.textContent = `Indexing failed: ${err instanceof Error ? err.message : String(err)}`;
      reindex.disabled = false;
    }
  });
  actions.indexStatus().then(showIndex, () => (indexText.textContent = 'Status unavailable'));
  const indexSection = h(
    'div',
    { class: 'mb-3' },
    h('div', { class: 'form-label' }, 'Code index (current project)'),
    h('div', { class: 'd-flex align-items-center gap-2' }, indexText, reindex),
  );

  const mcpServers = h('textarea', {
    class: 'form-control font-monospace',
    rows: 4,
    value: JSON.stringify(settings.mcpServers, null, 2),
    placeholder: '[{"name":"docs","transport":"http","url":"https://example.com/mcp"}]',
  });
  const mcpStatusText = h('span', { class: 'small text-body-secondary flex-grow-1' }, 'Checking…');
  actions.mcpStatus().then(
    (statuses) => {
      mcpStatusText.textContent = describeMcpStatus(statuses);
    },
    () => {
      mcpStatusText.textContent = 'Status unavailable';
    },
  );
  const mcpSection = h(
    'div',
    { class: 'mb-3' },
    h('div', { class: 'form-label' }, 'MCP servers'),
    mcpServers,
    h('div', { class: 'mt-1' }, mcpStatusText),
  );

  const body = h(
    'div',
    {},
    h('h3', { class: 'h6 text-body-secondary' }, 'API keys'),
    !settings.secretsEncrypted
      ? h(
          'div',
          { class: 'alert alert-warning py-2 small' },
          'Keys are stored unencrypted. System encryption may be unavailable or migration may have failed.',
        )
      : null,
    ...secretFields,
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Assistant'),
    field('Model', h('div', {}, modelSelect, customModel)),
    field(
      'Effort',
      effort,
      'How much the model thinks before acting (current Claude and OpenAI models). Higher is slower and costs more.',
    ),
    field('Approvals', approval),
    field(
      'Commands allowed without asking',
      allowedCommands,
      'One per line, used in "Ask" mode. "npm test" also allows "npm test -- foo". Commands with ; & | > < ` $ ( ) { } or a line break are always asked about. File edits are always asked about.',
    ),
    field(
      'Network hosts allowed without asking',
      allowedNetworkHosts,
      'Exact URL hostnames, one per line, used in "Ask" mode. Subdomains must be listed separately.',
    ),
    h('h3', { class: 'h6 text-body-secondary mt-4' }, 'Other'),
    field('Theme', theme),
    field('Editor command', editor, 'Opens files from the chat, e.g. code, cursor, subl.'),
    field('OpenAI-compatible base URL', baseUrl, 'Leave empty for api.openai.com.'),
    field('Google search engine id', searchEngine),
    field('Maximum files to index for code search', maxFiles),
    indexSection,
    field(
      'MCP servers (JSON)',
      mcpSection,
      'Model Context Protocol servers whose tools the agent may use (they always ask for approval). Stdio example: {"name":"fs","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}.',
    ),
  );

  const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const element = dialog(
    'Settings',
    body,
    h(
      'div',
      { class: 'd-flex w-100 align-items-center gap-2' },
      error,
      h('button', { type: 'button', class: 'btn btn-outline-secondary', onclick: () => element.close() }, 'Cancel'),
      save,
    ),
  );
  element.addEventListener('close', stopPolling);

  save.addEventListener('click', async () => {
    try {
      for (const [name, input] of secretInputs) {
        if (input.value.trim()) await actions.setSecret(name, input.value);
      }
      const model = modelSelect.value === '__custom' ? customModel.value.trim() : modelSelect.value;
      await actions.update({
        model,
        effort: effort.value as Effort,
        approvalMode: approval.value as Settings['approvalMode'],
        allowedCommands: allowedCommands.value.trim(),
        allowedNetworkHosts: allowedNetworkHosts.value.trim(),
        theme: theme.value as Settings['theme'],
        openaiBaseUrl: baseUrl.value.trim(),
        googleSearchEngineId: searchEngine.value.trim(),
        editorCommand: editor.value.trim(),
        maxIndexedFiles: Number(maxFiles.value),
        mcpServers: parseMcpServers(mcpServers.value),
      });
      element.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  });
}

// Instructions and the project's own allow-lists. The lists add to the global ones in Settings.
export function openProjectSettingsDialog(
  project: ProjectInfo,
  save: (settings: ProjectSettings) => Promise<unknown>,
): void {
  const instructions = h('textarea', { class: 'form-control font-monospace', rows: 8, value: project.instructions });
  const allowedCommands = h('textarea', {
    class: 'form-control font-monospace',
    rows: 3,
    value: project.allowedCommands ?? '',
    placeholder: 'npm test\ncargo check',
  });
  const allowedNetworkHosts = h('textarea', {
    class: 'form-control font-monospace',
    rows: 3,
    value: project.allowedNetworkHosts ?? '',
    placeholder: 'localhost\napi.example.com',
  });
  const error = h('div', { class: 'text-danger me-auto small' });
  const button = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save');
  const element = dialog(
    `Project settings for ${project.name}`,
    h(
      'div',
      {},
      field(
        'Instructions',
        instructions,
        'Added to every new chat in this project, e.g. commands to run tests, coding conventions or things to avoid.',
      ),
      h(
        'p',
        { class: 'small text-body-secondary mt-3 mb-2' },
        'For this project only, in addition to the lists in Settings. Same rules: one per line, used in "Ask" mode. These are kept with your app data, not in the project, so a repository cannot allow its own commands.',
      ),
      field(
        'Commands allowed without asking',
        allowedCommands,
        '"npm test" also allows "npm test -- foo". Commands with ; & | > < ` $ ( ) { } or a line break are always asked about.',
      ),
      field(
        'Network hosts allowed without asking',
        allowedNetworkHosts,
        'Exact URL hostnames. Subdomains must be listed separately.',
      ),
    ),
    h('div', { class: 'd-flex w-100 align-items-center gap-2' }, error, button),
  );
  button.addEventListener('click', async () => {
    try {
      await save({
        instructions: instructions.value,
        allowedCommands: allowedCommands.value.trim(),
        allowedNetworkHosts: allowedNetworkHosts.value.trim(),
      });
      element.close();
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err);
    }
  });
}

export interface HistoryDialogActions {
  open(id: string): Promise<void>;
  delete(id: string): Promise<ChatSummary[]>;
  clear(): Promise<ChatSummary[]>;
  // Also searches the messages, not only titles and projects.
  search(query: string): Promise<ChatSummary[]>;
}

const SEARCH_DELAY_MS = 250;

export function openHistoryDialog(chats: ChatSummary[], actions: HistoryDialogActions): void {
  const list = h('div', { class: 'list-group history-list' });
  const search = h('input', {
    type: 'search',
    class: 'form-control mb-2',
    placeholder: 'Search chats by title, project or message',
    'aria-label': 'Search chats',
  }) as HTMLInputElement;
  let all = chats;
  // Result of the last message search for the current query; until it arrives, titles and projects are filtered here.
  let found: ChatSummary[] | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchGeneration = 0;
  const render = (items: ChatSummary[]) => {
    all = items;
    const query = search.value.trim();
    const shown = query && found ? found : filterChats(items, query);
    list.replaceChildren(
      ...(shown.length === 0
        ? [
            h(
              'div',
              { class: 'text-body-secondary p-3' },
              items.length === 0 ? 'No saved chats yet.' : 'No chats match your search.',
            ),
          ]
        : shown.map((chat) =>
            h(
              'div',
              { class: 'list-group-item list-group-item-action d-flex align-items-center gap-2' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-link text-start text-decoration-none flex-grow-1 p-0 text-body',
                  onclick: async () => {
                    await actions.open(chat.id);
                    element.close();
                  },
                },
                h('div', { class: 'fw-semibold text-truncate' }, chat.title),
                h(
                  'div',
                  { class: 'small text-body-secondary text-truncate' },
                  `${new Date(chat.updatedAt).toLocaleString()}${chat.projectPath ? ` · ${chat.projectPath}` : ''}`,
                ),
                typeof chat.cost === 'number'
                  ? h(
                      'div',
                      { class: 'small text-body-secondary', title: 'Estimated from official list prices.' },
                      `≈ ${formatCost(chat.cost)}`,
                    )
                  : null,
                chat.snippet
                  ? h('div', { class: 'small fst-italic text-body-secondary text-truncate' }, chat.snippet)
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-sm btn-outline-secondary',
                  title: 'Delete',
                  onclick: async () => {
                    found = null;
                    render(await actions.delete(chat.id));
                    scheduleSearch();
                  },
                },
                icon('trash'),
              ),
            ),
          )),
    );
  };
  const scheduleSearch = () => {
    clearTimeout(searchTimer);
    const query = search.value.trim();
    if (!query) return;
    const generation = ++searchGeneration;
    searchTimer = setTimeout(async () => {
      try {
        const results = await actions.search(query);
        // Ignore an answer for a query the user has already changed.
        if (generation !== searchGeneration) return;
        found = results;
        render(all);
      } catch {
        // Keep the title and project filter if the message search fails.
      }
    }, SEARCH_DELAY_MS);
  };
  search.addEventListener('input', () => {
    found = null;
    searchGeneration++;
    render(all);
    scheduleSearch();
  });
  // The dialog is a form: Enter in the search box must not submit it and close the dialog.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  render(chats);
  const clearButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline-danger',
      onclick: async () => {
        if (!confirm('Delete all saved chats?')) return;
        found = null;
        render(await actions.clear());
      },
    },
    icon('trash'),
    ' Delete all',
  );
  const element = dialog('Chat history', h('div', {}, search, list), clearButton);
  element.addEventListener('close', () => clearTimeout(searchTimer));
  search.focus();
}

// One line per server for the settings dialog: "docs: connected — 3 tools" or the error.
function describeMcpStatus(statuses: McpStatus[]): string {
  if (statuses.length === 0) return 'No MCP servers configured.';
  return statuses
    .map((server) => {
      const state =
        server.state === 'connected' ? `connected — ${server.tools.length} tool(s)` : `error: ${server.error}`;
      return `${server.name}: ${state}`;
    })
    .join(' | ');
}
