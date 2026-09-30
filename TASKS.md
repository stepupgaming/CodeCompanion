# Tasks

Tick a box (`- [x]`) when a task is done.

The release checklists below record historical development work. Those releases have been removed; they are not available Patch releases. Patch's changelog starts with an unreleased baseline.

## Done

- [x] Complete the Patch naming cutover across runtime, profile directory, installer identity, environment variables, tests and documentation
- [x] Fix audit findings in chat deletion and active-project background cancellation, with late-callback and process-lifecycle regressions
- [x] Fix truncated/refused tool execution, final-request context accounting and pinned custom-endpoint summarizer selection
- [x] Strip untrusted inline styles, confine ignore-file reads and migrate/report plaintext API-key storage accurately
- [x] Add complete overlong-line continuation and fix Git rename discard and pre-first-commit diffs
- [x] Disable implicit local publishing and correct stale Undo, recent-project, compaction and performance documentation
- [x] Rewrite the changelog for Patch using Keep a Changelog, consolidating the removed releases into an unreleased baseline
- [x] Update project documentation and repository links for the Patch name; preserve current runtime filenames and historical release names
- [x] Replace application, executable, installer and uninstaller branding with `assets/logo-icon.svg`, with reproducible native icon generation
- [x] Rewrite the app in TypeScript with electron-vite
- [x] Terminal, browser and Git panels
- [x] Approval cards, Auto / Ask first mode
- [x] GPT-6 models through the OpenAI Responses API
- [x] Docs, changelog, `AGENTS.md`
- [x] Push to `PierrunoYT/patch`

## Release 0.1.0

- [x] Manually test the packaged Windows build
- [x] Build the NSIS installer (`npm run dist`, 119 MB, version 0.1.0); the packaged app starts cleanly
- [x] Run the installer, then check the Start menu entry, launch, and uninstall (worked)
- [x] Fix `npm run dist` failing with EBUSY when `dist/win-unpacked` is in use (a guard script asks you to close the app)
- [x] Add an end-to-end test for the OpenAI Responses path
- [x] Reset the version to `0.1.0` (new codebase)
- [x] Update the `CHANGELOG.md` date on release (2026-09-29)
- [x] Tag the release and publish the Windows installer on GitHub Releases (0.1.0 is Windows only)

## Release 0.1.1

- [x] Move the unreleased changelog entries into `[0.1.1] - 2026-09-30`, bump the version, tag `v0.1.1` (the release workflow builds and publishes the Windows installer)
- [x] Check that the `v0.1.1` release workflow passes and the installer is attached on GitHub Releases

## Later: other platforms (after the Windows release)

Won't fix for now: 0.1.0 supports Windows only, so these stay open but are not planned.

- [ ] ~~Test on macOS: build the DMG, check signing and notarization~~ (won't fix for now)
- [ ] ~~Test on Linux (`node-pty` compiles from source there) and add a Linux build target~~ (won't fix for now)

## Release 0.2.0

- [x] Run the built app against the real Anthropic and OpenAI APIs (edit and undo, stop and resume, an image, compact chat). Found and fixed OpenAI chats failing after the first turn (`parsed_arguments`), which v0.1.1 very likely has too
- [x] `read_file` on a file over 30,000 characters dropped the middle with only a "characters omitted" marker; it now reads whole lines in pages and says where to continue (seen with both GPT-6 Sol and Claude Opus 5.5 working around it with shell commands)
- [x] Make end-to-end teardown fail fast with a clear error (CI timed out once closing the app after `projects.test.ts`; not reproducible locally)
- [x] Audit the code and docs before the release (three reviews: main process, UI, docs against code). Fixed: the command allow-list could be bypassed through PowerShell `(...)`; a new file could be written outside the project through a folder link; "Open in editor" shell injection on macOS/Linux; mid-stream overload errors were not retried; custom-endpoint trimming could send a tool result without its call; a refusal with tool calls broke the chat; deleted chats came back; OpenAI compaction could split a reasoning item from its message; scrolling to the bottom with `content-visibility`; focus lost on Undo; and about 20 doc discrepancies
- [x] Move the unreleased changelog entries into `[0.2.0] - 2026-09-30` and bump the version to 0.2.0
- [x] Tag `v0.2.0` once CI is green, and check that the release workflow attaches the installer (published 2026-09-30; the first release run failed on the end-to-end teardown hang below, a second attempt of the same commit passed)

### Reliability

- [x] Add unit tests for `chat_store`, `projects` and `files` (only `chat_manager`, `settings` and `stores` are covered in `src/main`)
- [x] Add unit tests for the agent loop (`src/main/agent`): stop, resume, tool-result pairing and error paths
- [x] Log dropped-field tool errors (tool name and missing fields, never file contents) to make the open `edit_file` bug measurable
- [x] Log crashes and other problems locally (`logs/app.log.jsonl`): uncaught errors, crashed or hung UI, failed IPC calls, chat errors
- [x] Add a Help menu item that opens the log folder, and log renderer errors (`window.onerror`) through a new IPC channel
- [x] Retry transient provider errors (429, 5xx, network) with backoff, and show the retry in the chat

### Features

- [x] Add a "compact chat" action that summarizes old turns when a chat nears the context limit, keeping the history append-only
- [x] Add an undo for the last approved file edit (keep a backup per edit, restore from the diff card)
- [x] Show the running cost of a chat in the chat list, not only in the status bar
- [x] Let the user attach an image to a message for models that accept images, gated behind `claudeCapabilities`

### Quality

- [x] Add an end-to-end test for stop and resume of a long agent run
- [x] Add an end-to-end test for multi-project switching (separate chats and drafts)
- [x] Add a size limit and truncation notice for very large tool results shown in the UI
- [x] Review the renderer for long-chat performance (virtualize or paginate the message list) and record a measurement: not needed yet; three targeted fixes, see `docs/PERFORMANCE.md`

### Docs

- [x] Add a short user guide (`docs/USAGE.md`) covering approvals, allow-lists, resume and export
- [x] Keep `CHANGELOG.md` `[Unreleased]` in sync as each item above lands

## Next

### Paused implementation checkpoint

Stopped at the user's request, then prepared this unfinished checkpoint for their requested push. This batch is not feature-complete.

- **Windows teardown:** `TerminalService` now selects `useConptyDll` on Windows, with spawn-option and rapid restart unit tests. The worker reported 9 terminal tests, 435 unit tests and typecheck passing before later edits. Verified natively on Windows: the terminal, project and panel e2e files pass five runs in a row with the bundled ConPTY. The hang itself never reproduced locally, so keep an eye on the next Windows CI runs.
- **Performance:** `docs/PERFORMANCE.md` records three-run Linux orb comparisons. No renderer optimization was retained: candidates did not improve frame percentiles or broke scroll-follow. The original Windows/high-refresh regression remains open.
- **App-owned tool IDs:** done; `tests/e2e/undo.test.ts` reuses provider ids across turns as a regression.
- **Pending Undo notes:** done; saved with the chat (`pendingNotes`), tested in `src/main/agent/agent.test.ts` and `src/main/chat_manager.test.ts`.
- **Undo/send locking:** done; `ChatManager.busy` includes a running undo.
- **Checkpoint verification:** typecheck, all unit tests and the full end-to-end suite pass on Windows (the `long_run` test now waits for the third card before stopping).

### Remaining work

- [x] Add a per-project setting for allowed commands and network hosts (today they are global): Project settings…, added to the global lists
- [x] Measure the main process's per-event transcript updates during streaming in long chats: 30 µs per streamed piece at 5,000 items, no change needed (`docs/PERFORMANCE.md`)
- [ ] Streaming in a 5,000-item chat costs 14–21 ms per frame. Cause found: the 7 ms before the scroll fix was a chat that was not following the bottom, so the streamed answer was off screen; following costs layout across the 5,000 `content-visibility` siblings (`docs/PERFORMANCE.md`, "Windows bisection"). Next: try grouping older items into a few chunks
- [x] Fix the end-to-end teardown hang on Windows CI (2 of 5 runs around the 0.2.0 release, always after `projects.test.ts` with all tests passed). The harness's 20 s report shows `node-pty`'s `conpty_console_list_agent.js` crashing with `AttachConsole failed`: closing two project tabs quickly kills a terminal whose console is not ready yet, and the app then does not quit. The forked agents also print inspector output (Playwright starts the app with the inspector on, and forks inherit it), which may be why it only hangs under test; not reproducible locally (30 rapid open/close rounds quit in ~0.1 s). Options: `node-pty`'s `useConptyDll` (no agent process), or not killing a terminal that is still starting
- [x] Key edit backups and tool cards by an id of the app's own instead of the provider's tool-call id, which some OpenAI-compatible servers reuse across turns
- [x] Lock Undo against a message sent at the same moment (today the model is then told about the undo one message later)
- [x] Save the pending "you undid an edit" note with the chat, so it survives a restart
- [x] On the Anthropic path, keep the first part of a turn that was paused or compacted server-side out of the history until the turn completes, so a retry cannot leave it behind
- [x] Redact more token formats in the local log (custom-endpoint keys such as `gsk_…` or `xai-…`)

## Project setup

- [x] Prepare Amp orb lifecycle scripts with snapshot dependency reuse and headless Electron test prerequisites
- [x] Add a `LICENSE` file (MIT)
- [x] Add a GitHub Actions workflow: typecheck, unit tests, end-to-end tests (Windows only)
- [x] Add Linux and macOS jobs to the CI workflow (non-blocking until they pass; then remove `continue-on-error`)
- [ ] ~~Make the Linux and macOS CI jobs blocking once they pass~~ (won't fix for now; the jobs stay non-blocking and their failures are ignored)
- [x] Add a release workflow that builds the Windows installer (`.github/workflows/release.yml`, runs on `v*` tags)
- [x] Add screenshots to the README (`E2E_SCREENSHOTS` can generate them)
- [x] Add more README screenshots (settings, Git and browser panels) without local paths
- [x] Decide whether the repo should be public (it is public: https://github.com/PierrunoYT/patch)

## Features

- [x] Add unit tests for the Git, terminal and browser panel services; fix the browser stop-while-waiting bug they found
- [x] Fix `run_command` hanging after the command exited while a leftover child held the output pipe
- [x] Always inject `AGENTS.md` into the session and show in the UI that it is loaded
- [x] Add a stop-and-resume option for long agent runs, including reopening stopped chats
- [x] Show cost estimates next to the token usage in the status bar (Claude models at first; GPT-6 prices added later)
- [x] Add verified GPT-6 prices, per-request long-context tiers, and cache-write tokens to cost estimates
- [x] Add a setting to allow specific commands without approval
- [x] Support several open projects with separate chats and drafts (one active agent run; stop before switching)
- [x] Add a search box for saved chats (title and project path)
- [x] Search the message text of saved chats, not only title and project
- [x] Export a chat as Markdown

## Bugs

- [x] Keep recent-project ordering deterministic when opens share a timestamp, including reopening and reload
- [x] Tools were fixed when a chat was created, so adding an OpenAI key mid-chat gave no `search_code`. The tool list is now rebuilt every turn
- [x] Mention optional search/browser tools conditionally on the current tool list while keeping the system prompt frozen for caching
- [x] Stop logging `terminal:start` errors when no project is open (the terminal starts only once a project is open)
- [x] Editing an unread file failed only after the user approved the diff. The read check now also runs in the preview, so it is rejected before approval
- [x] "Invalid input" tool errors were vague when the model left out a field. They now name the missing and received fields
- [ ] The model sometimes drops a required field such as `new_string` in parallel `edit_file` calls; the app can only report it. Watch whether the clearer error and tool description reduce this (each occurrence is logged to `logs/tool-input-errors.jsonl`, see `docs/DEVELOPMENT.md`)

## Quality

- [x] Add unit tests for the panels (`browser`, `git`, `terminal`)
- [x] Add unit tests for the code index (`src/main/search`)
- [x] Show indexing progress in Settings while reindexing
- [x] Review the security model again before the release (findings fixed or documented under "Known limits" in `docs/ARCHITECTURE.md`)
- [x] Require approval for `fetch_url` and the `browser` tool on hosts outside an allow-list (browser subresources and Google search remain documented limits)
- [x] Check for accessibility problems (keyboard navigation, contrast): code audit done and fixed, see the changelog
- [x] Measure representative rendered text contrast in both themes, including approval controls and their hover/focus states
- [x] Redesign the UI around the Patch brand (tokens in `styles.css`, header, composer, tool cards, panels, dialogs); contrast checks still pass in both themes
- [ ] Test with a real screen reader (NVDA); requires a Windows session with NVDA, unavailable in the Linux orb. Not tested yet. Check: approval cards and finished answers are announced once, errors and retry notices are read, the Undo, Compact chat and project-tab buttons have sensible names, and tool cards read correctly once expanded (their content is now built on first expand). Also check the Undo and Open-in-editor buttons, which sit inside a card's `<summary>`: some screen readers flatten or skip buttons nested in a summary; if so, move a card's actions out of the summary
- [x] Resume tasks interrupted by a crash: checkpoint the conversation after every tool batch, detect unanswered tool calls on load, and repair the history with synthetic failed results on resume
- [x] Support MCP servers: configure them in Settings (JSON), expose their tools as namespaced approval-gated tools, show connection status per server
- [x] Add plan mode: the agent proposes a plan as an approval card before multi-step changes (opt-in setting, skipped in Auto mode)
- [x] Add a `task` tool that delegates research to a read-only subagent (own context window, capped turns, progress streamed to the parent)
- [x] Project skills: markdown files in `.codecompanion/skills/` listed in the system prompt and loaded on demand via `load_skill`
