import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { GitStatus, PanelName } from '@shared/panels';
import { h, icon, setChildren, trustedHtml } from '../dom';
import { renderDiff } from '../markdown';

const api = window.api;

interface Panel {
  element: HTMLElement;
  // Called each time the tab becomes visible.
  shown(): void;
  projectChanged(): void;
}

// Right-hand side of the window: Terminal, Browser and Git tabs. Each tab is built the first time it is shown.
export class Panels {
  readonly element = h('div', { class: 'panels' });
  private readonly tabBar = h('div', { class: 'panel-tabs', role: 'tablist' });
  private readonly body = h('div', { class: 'panel-body' });
  private readonly panels = new Map<PanelName, Panel>();
  private active: PanelName | null = null;

  constructor(
    private readonly theme: () => 'dark' | 'light',
    private readonly onError: (error: unknown) => void,
    private readonly hasProject: () => boolean,
  ) {
    const tabs: Array<[PanelName, string, string]> = [
      ['terminal', 'Terminal', 'terminal'],
      ['browser', 'Browser', 'window'],
      ['git', 'Git', 'git'],
    ];
    for (const [name, label, iconName] of tabs) {
      this.tabBar.appendChild(
        h(
          'button',
          {
            id: `panel-tab-${name}`,
            class: 'panel-tab',
            role: 'tab',
            'aria-controls': `panel-${name}`,
            tabindex: -1,
            dataset: { panel: name },
            onclick: () => this.show(name),
          },
          icon(iconName),
          ` ${label}`,
        ),
      );
    }
    // Arrow keys move between tabs, as in a native tab strip; only the selected tab is in the Tab order.
    this.tabBar.addEventListener('keydown', (event) => {
      const names = tabs.map(([name]) => name);
      const current = names.indexOf(this.active ?? names[0]!);
      const next =
        event.key === 'ArrowRight'
          ? (current + 1) % names.length
          : event.key === 'ArrowLeft'
            ? (current - 1 + names.length) % names.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? names.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      const target = names[next]!;
      this.show(target);
      this.tabBar.querySelector<HTMLElement>(`#panel-tab-${target}`)?.focus();
    });
    this.element.append(this.tabBar, this.body);
  }

  show(name: PanelName): void {
    let panel = this.panels.get(name);
    if (!panel) {
      panel = this.create(name);
      panel.element.id = `panel-${name}`;
      panel.element.setAttribute('role', 'tabpanel');
      panel.element.setAttribute('aria-labelledby', `panel-tab-${name}`);
      this.panels.set(name, panel);
      this.body.appendChild(panel.element);
    }
    for (const [other, { element }] of this.panels) element.hidden = other !== name;
    for (const tab of this.tabBar.querySelectorAll<HTMLElement>('.panel-tab')) {
      const selected = tab.dataset.panel === name;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    this.active = name;
    panel.shown();
  }

  projectChanged(): void {
    for (const panel of this.panels.values()) panel.projectChanged();
    if (this.active) this.panels.get(this.active)?.shown();
  }

  // The agent changed files or ran a command; refresh the Git view if it is open.
  filesChanged(): void {
    if (this.active === 'git') this.panels.get('git')?.shown();
  }

  private create(name: PanelName): Panel {
    if (name === 'terminal') return new TerminalPanel(this.hasProject);
    if (name === 'browser') return new BrowserPanel();
    return new GitPanel(this.theme, this.onError);
  }
}

class TerminalPanel implements Panel {
  readonly element = h('div', { class: 'terminal-panel' });
  private readonly terminal = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0b0f14' },
  });
  private readonly fit = new FitAddon();
  private started = false;
  private noProjectShown = false;

  constructor(private readonly hasProject: () => boolean) {
    this.terminal.loadAddon(this.fit);
    this.terminal.open(this.element);
    this.terminal.onData((data) => {
      if (this.started) void api.invoke('terminal:write', data);
      else if (data === '\r') this.start();
    });
    api.on('terminal:data', (data) => this.terminal.write(data));
    api.on('terminal:exit', () => {
      this.started = false;
      this.terminal.write('\r\n[shell exited — press Enter to restart]\r\n');
    });
    new ResizeObserver(() => this.resize()).observe(this.element);
  }

  shown(): void {
    requestAnimationFrame(() => {
      this.resize();
      if (!this.started) this.start();
      this.terminal.focus();
    });
  }

  projectChanged(): void {
    this.started = false;
    this.noProjectShown = false;
    this.terminal.reset();
  }

  private start(): void {
    // Without a project the main process would reject the call (and log an error), so do not ask.
    if (!this.hasProject()) {
      if (!this.noProjectShown) this.terminal.write('Open a project to use the terminal.\r\n');
      this.noProjectShown = true;
      return;
    }
    this.fit.fit();
    api.invoke('terminal:start', this.terminal.cols, this.terminal.rows).then(
      () => (this.started = true),
      // Shown in the terminal rather than as an error toast.
      (error) => this.terminal.write(`${error instanceof Error ? error.message.replace(/^.*Error: /, '') : error}\r\n`),
    );
  }

  private resize(): void {
    if (this.element.hidden || this.element.clientWidth === 0) return;
    this.fit.fit();
    if (this.started) void api.invoke('terminal:resize', this.terminal.cols, this.terminal.rows);
  }
}

class BrowserPanel implements Panel {
  readonly element = h('div', { class: 'browser-panel' });
  private readonly webview: HTMLElement & {
    src: string;
    loadURL(url: string): Promise<void>;
    goBack(): void;
    goForward(): void;
    reload(): void;
    openDevTools(): void;
    getURL(): string;
  };
  private readonly address = h('input', {
    class: 'form-control form-control-sm',
    placeholder: 'http://localhost:3000',
    'aria-label': 'Address',
  });

  constructor() {
    // Created with an isolated session partition. The main process strips Node access from the guest.
    this.webview = document.createElement('webview') as never;
    this.webview.setAttribute('partition', 'persist:browser');
    this.webview.setAttribute('src', 'about:blank');
    this.webview.className = 'browser-view';
    this.webview.addEventListener('did-navigate', () => (this.address.value = this.url()));
    this.webview.addEventListener('did-navigate-in-page', () => (this.address.value = this.url()));

    this.address.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      let url = this.address.value.trim();
      if (!url) return;
      if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
      void this.webview.loadURL(url).catch(() => {});
    });

    const button = (name: string, title: string, action: () => void) =>
      h('button', { class: 'btn btn-sm btn-outline-secondary', title, onclick: action }, icon(name));

    this.element.append(
      h(
        'div',
        { class: 'browser-toolbar' },
        button('arrow-left', 'Back', () => this.webview.goBack()),
        button('arrow-right', 'Forward', () => this.webview.goForward()),
        button('arrow-clockwise', 'Reload', () => this.webview.reload()),
        this.address,
        button('bug', 'Developer tools', () => this.webview.openDevTools()),
      ),
      this.webview,
    );
  }

  shown(): void {}

  projectChanged(): void {}

  private url(): string {
    try {
      const url = this.webview.getURL();
      return url === 'about:blank' ? '' : url;
    } catch {
      return '';
    }
  }
}

class GitPanel implements Panel {
  readonly element = h('div', { class: 'git-panel' });
  private readonly fileList = h('div', { class: 'git-files list-group list-group-flush' });
  private readonly diffView = h('div', { class: 'git-diff' });
  private readonly message = h('input', {
    class: 'form-control form-control-sm',
    placeholder: 'Commit message',
    'aria-label': 'Commit message',
  });
  private readonly header = h('div', { class: 'git-header' });
  private selected: string | null = null;
  private status: GitStatus | null = null;

  constructor(
    private readonly theme: () => 'dark' | 'light',
    private readonly onError: (error: unknown) => void,
  ) {
    this.message.addEventListener('keydown', (event) => event.key === 'Enter' && void this.commit());
    this.element.append(this.header, h('div', { class: 'git-split' }, this.fileList, this.diffView));
  }

  shown(): void {
    void this.refresh();
  }

  projectChanged(): void {
    this.selected = null;
  }

  private async refresh(): Promise<void> {
    try {
      this.status = await api.invoke('git:status');
    } catch {
      setChildren(this.header, h('div', { class: 'text-body-secondary p-3' }, 'Open a project to see its changes.'));
      this.fileList.replaceChildren();
      this.diffView.replaceChildren();
      return;
    }
    const status = this.status;
    if (!status.isRepo) {
      setChildren(
        this.header,
        h(
          'div',
          { class: 'p-3' },
          h('p', { class: 'text-body-secondary' }, 'This project is not a Git repository.'),
          h(
            'button',
            { class: 'btn btn-sm btn-outline-secondary', onclick: () => this.run(() => api.invoke('git:init')) },
            'Initialize repository',
          ),
        ),
      );
      this.fileList.replaceChildren();
      this.diffView.replaceChildren();
      return;
    }

    setChildren(
      this.header,
      h(
        'div',
        { class: 'git-commit-row' },
        h('span', { class: 'badge text-bg-secondary' }, icon('git'), ` ${status.branch ?? 'detached'}`),
        this.message,
        h(
          'button',
          { class: 'btn btn-sm btn-primary', disabled: status.files.length === 0, onclick: () => void this.commit() },
          'Commit all',
        ),
        h(
          'button',
          { class: 'btn btn-sm btn-outline-secondary', title: 'Refresh', onclick: () => void this.refresh() },
          icon('arrow-clockwise'),
        ),
      ),
    );

    if (this.selected && !status.files.some((file) => file.path === this.selected)) this.selected = null;
    setChildren(
      this.fileList,
      status.files.length === 0 ? h('div', { class: 'text-body-secondary p-3' }, 'No changes.') : null,
      ...status.files.map((file) =>
        h(
          'div',
          { class: `list-group-item git-file${file.path === this.selected ? ' active' : ''}` },
          h(
            'button',
            {
              class: 'btn btn-link p-0 text-reset text-decoration-none text-truncate text-start flex-grow-1',
              title: file.path,
              onclick: () => this.select(file.path),
            },
            file.path,
          ),
          h(
            'span',
            { class: `git-status git-${file.status}`, title: file.status, 'aria-label': file.status },
            file.status.charAt(0).toUpperCase(),
          ),
          h(
            'button',
            {
              class: 'btn btn-sm btn-link p-0 text-secondary',
              title: file.status === 'untracked' ? 'Delete new file' : 'Discard changes',
              onclick: () => {
                const verb = file.status === 'untracked' ? 'Delete the new file' : 'Discard all changes to';
                if (confirm(`${verb} ${file.path}?`)) this.run(() => api.invoke('git:discard', file.path));
              },
            },
            icon('arrow-counterclockwise'),
          ),
        ),
      ),
    );
    await this.renderDiff();
  }

  private select(path: string): void {
    this.selected = this.selected === path ? null : path;
    void this.refresh();
  }

  private async renderDiff(): Promise<void> {
    if (!this.status?.files.length) {
      this.diffView.replaceChildren();
      return;
    }
    const diff = await api.invoke('git:diff', this.selected);
    setChildren(
      this.diffView,
      diff
        ? trustedHtml('div', '', renderDiff(diff, this.theme()))
        : h('div', { class: 'text-body-secondary p-3' }, 'No textual changes.'),
    );
  }

  private async commit(): Promise<void> {
    const message = this.message.value.trim();
    if (!message) {
      this.message.focus();
      return;
    }
    this.run(async () => {
      const status = await api.invoke('git:commit', message);
      this.message.value = '';
      return status;
    });
  }

  private run(action: () => Promise<unknown>): void {
    action().then(
      () => void this.refresh(),
      (error) => this.onError(error),
    );
  }
}
