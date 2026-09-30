# Patch

<img src="assets/logo-icon.svg" width="96" height="96" alt="Patch application icon" />

A desktop AI coding assistant. Open a project folder, describe a task, and Patch reads the code, edits files, runs commands and checks its work, asking for your approval before it changes anything.

Patch is a from-scratch TypeScript desktop coding assistant. [CHANGELOG.md](CHANGELOG.md) tracks the unreleased baseline using Keep a Changelog.

Repository: https://github.com/PierrunoYT/patch

The application and installer are named Patch (`Patch.exe` and `Patch-Installer.exe` on Windows). The default profile directory is `Patch` under the system application-data directory. Environment variables use the `PATCH_*` prefix. Existing profiles are not migrated automatically: set `PATCH_USER_DATA` to an existing profile folder to reuse its settings, keys and chats. The installer uses the `patch` application ID and does not upgrade installations with a different ID.

![The assistant shows a diff and waits for Approve or Decline before editing a file](docs/images/approval.png)

- Model Context Protocol (MCP) servers: configure them in Settings (stdio or Streamable HTTP) and their tools are offered to the assistant, always behind an approval card

## Features

- Chat with Claude (Opus 5.5 by default, Sonnet 5.5, Haiku 4.5), OpenAI GPT-6 (Astra, Sol, Luna) or any OpenAI-compatible endpoint, with streaming answers
- Works directly in your project: read, search, edit and create files, run commands
- Every file change and command is shown first (diffs, command text) and waits for **Approve** or **Decline** — or switch to **Auto** mode
- Decline with a note ("use pnpm instead") and the assistant adjusts
- **Undo** on the card of any approved file edit puts the file back (or deletes a file the assistant created), as long as the file is still as the edit left it; the assistant is told and has to read the file again
- Semantic code search over the project (needs an OpenAI key for embeddings, which can be added mid-chat); Settings shows whether the project is indexed (with progress while it builds) and can reindex it
- Built-in browser the assistant uses to check web apps: console output and screenshots
- Interactive terminal and a Git panel (diffs, commit, discard) next to the chat
- Web search (Google Custom Search) and page fetching
- Long chats are handled by server-side compaction (current Claude models), and **Compact chat** (header button) summarizes older turns on demand; custom endpoints must support structured-output summaries using the chat's model. The status bar shows the latest request's prompt size, not the sum across Claude continuations. The full history stays in the saved chat
- Rate limits (429), server errors (5xx) and dropped connections are retried automatically, up to 4 times, waiting about 2 to 16 seconds or as long as the provider asks (up to a minute); each retry is shown in the chat and **Stop** works during the wait
- Failed or stopped Claude continuations after a server-side pause or compaction leave saved model history unchanged; retries start from the history before that attempt
- Stop a running task, including its project's background commands, and use **Resume** to continue it after cancellation settles, including after reopening the saved chat; the model is instructed to check interrupted actions before retrying them
- Keep several projects open in tabs, each with its own chat and unsent draft. Stop the current task before switching; one agent run is active at a time
- Chats are saved automatically and can be searched by title, project or message text, and exported as Markdown (download button in the header); per-project custom instructions
- `AGENTS.md` (or `CLAUDE.md`) in the project root is always added to the chat's instructions; the status bar shows "AGENTS.md loaded"
- Image attachments (attach or paste) for models that accept images; the paperclip and paste are disabled for a Claude model id the app does not know to accept images (entered under _Other model id…_)
- Token totals and estimated cost for the built-in Claude and GPT-6 models, including cache reads and writes, in the status bar, and each chat's estimated cost in the chat history; custom endpoints have no official-price estimate

## Getting started

Requirements: Node.js 22.12+ (22.x, 24.x or 26+, as Electron and Vitest need), Git (optional, for the Git panel).

```bash
npm install
npm start
```

Then:

1. **File → Open Project…** and pick a folder.
2. Open **Settings** (gear icon, `Ctrl+,`) and add your Anthropic API key (and optionally an OpenAI key for code search, and a Google API key + search engine id for web search).
3. Describe a task, e.g. _"Add input validation to the signup form and a test for it."_

Recent projects are ordered by the latest open, including folders opened within the same millisecond.

To build an installer: `npm run dist` (Windows NSIS installer or macOS DMG in `dist/`). Local `pack` and `dist` commands never publish; releases are published by the tag-triggered release workflow.

For development in Amp orbs, the repository includes setup and resume scripts to prepare and reuse dependencies. See [orb setup](docs/DEVELOPMENT.md#amp-orbs) for requirements and headless test commands.

## Keyboard shortcuts

| Shortcut                | Action             |
| ----------------------- | ------------------ |
| `Enter` / `Shift+Enter` | Send / new line    |
| `Ctrl+O`                | Open project       |
| `Ctrl+N`                | New chat           |
| `Ctrl+.`                | Stop the assistant |
| `Ctrl+,`                | Settings           |

(`Cmd` instead of `Ctrl` on macOS.)

## Privacy and security

- The app talks only to the APIs you configure (Anthropic, OpenAI or your OpenAI-compatible endpoint, Google search) and to pages you or the assistant open. There is no telemetry and no update check. Crashes and errors are written to a log file in the app's data folder (`logs/app.log.jsonl`) for your own troubleshooting, along with a line per start giving the app and Electron version and platform; it holds error messages and stack traces (which can mention file paths), not your chat history, and is never sent anywhere. Recognized API-key formats, including Groq (`gsk_…`) and xAI (`xai-…`), are redacted from new messages and stacks; review logs before sharing because arbitrary secret formats may not be recognized. **Help → Show Log Folder** opens it.
- To make **Undo** possible, the previous version of every file the assistant edits is copied to the app's data folder (`edit-backups`, the latest 50 edits per chat, deleted with the chat). Those copies are not encrypted; delete the chat if a project contains secrets you do not want copied.
- API keys are encrypted with the operating system's keychain (Electron `safeStorage`) when available and never reach the UI process. Without system encryption, keys are stored as plaintext and Settings warns. Existing plaintext keys are migrated when encryption becomes available; failed migration keeps the warning and preserves the keys.
- The assistant's file access is confined to the open project folder, including through links: a file is checked where it would really be written, even when it does not exist yet. Commands run in your shell with your permissions — keep **Ask first** mode on unless you trust the task. In Settings, "Commands allowed without asking" lists commands (one per line, for example `npm test`) that skip the approval card in Ask first mode; a line also allows the command with arguments. **Project settings…** in the project menu has the same two lists for one project, added to the global ones; they are kept with the app's data, not in the project, so a repository cannot allow its own commands. Commands containing `;`, `&`, `|`, `>`, `<`, a backtick, `$`, `(`, `)`, `{`, `}` or a line break are always asked about (PowerShell, which runs the commands on Windows, runs `(...)` and `{...}` even inside a program's arguments), and file edits always wait for you. Only allow commands you would run yourself: `npm run` would let the assistant run any script in `package.json`.
- The UI runs sandboxed without Node.js access; model output is sanitized before display.
- In **Ask first** mode, page fetching and browser tools require approval unless their exact hostname is listed in Settings → "Network hosts allowed without asking". The list starts empty and does not include subdomains automatically. Cross-host redirects require a separate tool call; browser popups are denied. **Auto** mode skips tool approvals. This is not a network sandbox: browser subresources and Google search are not covered, and approved hosts may receive private data. Avoid untrusted pages in projects with secrets.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model).

## Documentation

<details>
<summary>Settings, Git changes, and browser preview</summary>

![Settings with model and API configuration](docs/images/settings.png)
![Git panel showing a new preview page and its diff](docs/images/git.png)
![Browser panel showing an application preview](docs/images/browser.png)

</details>

- [User guide](docs/USAGE.md) — approvals, allow-lists, stop and resume, chat history and export
- [Architecture](docs/ARCHITECTURE.md) — processes, IPC contract, agent loop, providers, tools, storage, security model
- [Development guide](docs/DEVELOPMENT.md) — setup, scripts, tests, where to change things
- [Performance](docs/PERFORMANCE.md) — long-chat measurements and what was changed
- [Contributing](CONTRIBUTING.md)
- [Tasks](TASKS.md) — roadmap with checkboxes
- [AGENTS.md](AGENTS.md) — guidance for AI coding agents working on this repo

## License

[MIT](LICENSE)
