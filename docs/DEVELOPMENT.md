# Development Guide

## Setup

Requirements: Node.js 22.12+ (22.x, 24.x or 26+, as Electron and Vitest need; declared in the `engines` field), Git.

```bash
npm install
npm run dev        # hot-reloading renderer, rebuilds main/preload on change
```

npm 11 runs dependency install scripts only for packages listed under `allowScripts` in `package.json` (`electron`, `esbuild`). If `node_modules/electron/dist` is missing after installing, run `node node_modules/electron/install.js`.

`node-pty` ships prebuilt binaries for Windows and macOS (x64 and arm64), so no compiler is needed there. On Linux it compiles from source; see the [node-pty prerequisites](https://github.com/microsoft/node-pty#dependencies).

### Amp orbs

`.agents/setup` prepares Debian-based Amp orbs with native build tools, Electron libraries, Xvfb and locked npm dependencies. It uses the orb's Node.js toolchain (Node 22.12+, 24.x or 26+, as required by Vitest 5), ensures the Electron binary is downloaded and checks `node-pty` loads. No API keys or backing services are needed for tests.

Amp snapshots the prepared environment. When setup runs again on a stale snapshot, it skips apt for installed packages and reuses `node_modules` when the package files, setup script, Node/npm versions and platform match. Changed inputs trigger `npm ci`; deleting `node_modules/.amp-setup-fingerprint` forces a reinstall. `.agents/resume` only checks dependency readiness, without installing anything or authenticating services.

```bash
.agents/setup             # also repairs missing dependencies
npm run typecheck
xvfb-run -a npm test       # unit tests, build and headless Electron tests
```

Both lifecycle scripts must be executable. They become available to future project orbs after reaching the project's default branch; a local commit alone does not activate them. No persistent server or shell-profile changes are required.

## Scripts

| Script                                    | Purpose                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                             | Development mode                                                                                                                                                                                                                                                                             |
| `npm start`                               | Build and run the production build                                                                                                                                                                                                                                                           |
| `npm run icons`                           | Regenerate native app and installer icons from `assets/logo-icon.svg`                                                                                                                                                                                                                        |
| `npm run build`                           | Build main, preload and renderer into `out/`                                                                                                                                                                                                                                                 |
| `npm run typecheck`                       | Type-check the Node side (`tsconfig.node.json`) and the renderer (`tsconfig.web.json`)                                                                                                                                                                                                       |
| `npm run lint`                            | Lint the repository with ESLint (`eslint.config.mjs`)                                                                                                                                                                                                                                        |
| `npm run format` / `npm run format:check` | Rewrite every file with Prettier / check formatting without writing                                                                                                                                                                                                                          |
| `npm test`                                | Unit tests, then build + end-to-end tests                                                                                                                                                                                                                                                    |
| `npm run test:unit` / `npm run test:e2e`  | One of the two                                                                                                                                                                                                                                                                               |
| `npm run perf`                            | Build, then measure long chats (`tests/perf/`): rendering and main-process CPU in the app (`out/perf-long-chat.json`; `PERF_TURNS=1000` for a longer chat), and the main process's work per streamed event (`out/perf-main-process.json`). Not part of `npm test`; see `docs/PERFORMANCE.md` |
| `npm run pack`                            | Unpacked app in `dist/`                                                                                                                                                                                                                                                                      |
| `npm run dist`                            | Installer (NSIS on Windows, DMG on macOS)                                                                                                                                                                                                                                                    |

Set `E2E_SCREENSHOTS=<folder>` when running the end-to-end tests to save screenshots of the main screens.

The end-to-end tests start the real app, but its windows are invisible: `launchApp` sets `PATCH_E2E_QUIET=1`, which makes the window fully transparent, keeps it out of the taskbar and shows it without taking focus (`window.ts`). It also turns off Chromium's slowing of hidden and covered windows (`index.ts`), which otherwise made tests time out now and then when other windows covered the test window. Set `E2E_SHOW_WINDOW=1` to watch a run.

To reproduce the cropped README panels without local paths or secrets: `npm run build`, then `E2E_DOC_SCREENSHOTS=docs/images xvfb-run -a npx vitest run --project e2e tests/e2e/documentation-visuals.test.ts`. The browser image combines its rendered toolbar with Electron's captured guest surface because Xvfb does not composite webviews into Playwright screenshots; the address field uses a documentation-only example URL. The same test measures text contrast for representative footer, approval and panel controls in both themes (including Decline hover/focus), requiring at least 4.5:1. It does not replace NVDA testing or a full accessibility audit.

Project-store tests use a fixed clock to cover equal-timestamp opens and reopening existing folders; newest-open ordering must survive reload without synthesizing future timestamps.

Cost estimates use standard [Anthropic prices](https://platform.claude.com/docs/en/about-claude/pricing) (default 5-minute cache writes) and [OpenAI prices](https://developers.openai.com/api/docs/pricing). OpenAI input totals include cached/read and cache-write tokens; providers normalize them into separate categories before accumulation. Requests above 272,000 input tokens retain their long-context bucket instead of selecting a tier from chat totals. Older saved usage lacks cache-write and per-request tier data, so historical estimates are incomplete. Custom endpoints, title generation, compaction summaries, embeddings, and failed requests are not included in the estimate.

`pack` and `dist` first run `scripts/ensure-closed.mjs`. On Windows, electron-builder cannot replace `dist/win-unpacked` while an app started from it is running, so the script stops with "Close Patch first" instead of an `EBUSY` error. An installed copy (outside `dist/`) does not matter.

Both local packaging scripts pass `--publish never`, including when CI environment variables are present. They build artifacts only and do not require a GitHub publishing token. The tag-triggered release workflow publishes explicitly.

Packaging does not rebuild native modules (`npmRebuild: false`) because `node-pty`'s prebuilt binaries work across Electron versions. macOS signing and notarization use electron-builder's standard environment variables (`CSC_LINK`, `APPLE_ID`, …).

### Application icons

`assets/logo-icon.svg` is the source for the application branding. After editing it, run `npm run icons` and commit the regenerated `build/icon.ico`, `build/icon.icns`, and `build/icon.png`. The generator rasterizes each size directly from the vector using resvg; Windows ICOs include 16–256 px images, and macOS ICNS files include 16–1024 px images.

The Windows executable, installer, and uninstaller use `build/icon.ico`; macOS uses `build/icon.icns`. The app window uses `build/icon.png`, copied into packaged resources by electron-builder, and the renderer favicon uses the source SVG. Toolbar action icons remain Bootstrap icons.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: a `format` job (`npm run format:check`), a `lint` job (`npm run lint`) and the `test` job on `windows-latest`, `ubuntu-latest` and `macos-latest` with Node 22 (`npm ci`, `npm run typecheck`, `npm run test:unit` and `npm run test:e2e` under `xvfb-run` on Linux). Run the same commands locally before pushing. Windows is the only supported platform. The Linux and macOS jobs are `continue-on-error` and their failures are not being fixed for now (see `TASKS.md`).

Patch's changelog follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). The removed CodeCompanion releases are consolidated under `Unreleased`; the package version alone does not indicate a published Patch release. Add user-facing entries under the applicable `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed` or `Security` category, omitting empty categories. When publishing Patch, move the relevant entries into `## [x.y.z] - YYYY-MM-DD`, retain an `Unreleased` section, link the release heading to its tag, and update the `Unreleased` link to compare that tag with `HEAD`. Do not link to the removed releases.

`.github/workflows/release.yml` runs when a tag such as `v0.1.0` is pushed. It checks that the tag matches the `package.json` version, runs the same checks as CI, builds the Windows installer with `electron-builder` and creates a GitHub release with `Patch-Installer.exe` attached. The release notes are the matching `## [x.y.z]` section of `CHANGELOG.md` plus a link to the full file at that tag; the run fails if the section is missing. To release: add the `## [x.y.z] - date` section to `CHANGELOG.md`, update the version, commit, then `git tag v0.1.0` and `git push origin v0.1.0`.

Before tagging, use the built app once against the real Anthropic and OpenAI APIs (with a throwaway profile via `PATCH_USER_DATA`): a task that edits a file, Undo, Stop and Resume, an image, and Compact chat on a chat with a few large file reads. The mock APIs in the end-to-end tests accept requests the real APIs reject; before 0.2.0, that let a bug through that made OpenAI chats fail after the first turn.

## Where to change things

| Goal                                                             | File                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add or rename a model, change defaults                           | `src/shared/models.ts`                                                                                                                                                                               |
| Change model prices used for the cost estimate                   | `MODEL_PRICING` in `src/shared/models.ts`                                                                                                                                                            |
| Enable a Claude API feature for a model                          | `claudeCapabilities` in `src/shared/models.ts`, request building in `src/main/llm/anthropic.ts`                                                                                                      |
| Change the system prompt                                         | `src/main/agent/system_prompt.ts`                                                                                                                                                                    |
| Add a tool                                                       | New `defineTool(...)` in `src/main/tools/`, register in `registry.ts`                                                                                                                                |
| Add a setting                                                    | `Settings` + `DEFAULT_SETTINGS` in `src/shared/settings.ts`, validation in `src/main/settings.ts`, field in `src/renderer/src/views/dialogs.ts`                                                      |
| Add a per-project setting                                        | `ProjectInfo`/`ProjectSettings` in `src/shared/project.ts`, `ProjectStore.updateSettings` in `src/main/projects.ts` (validation), `openProjectSettingsDialog` in `src/renderer/src/views/dialogs.ts` |
| Add an IPC channel                                               | `InvokeApi`/`EventMap` **and** `INVOKE`/`EVENTS` in `src/shared/ipc.ts`, handler in `src/main/index.ts`                                                                                              |
| Add a chat event                                                 | `ChatEvent` + `applyChatEvent` in `src/shared/chat.ts`                                                                                                                                               |
| Change which provider errors are retried, or the backoff         | `src/main/agent/retry.ts` (`retryDecision`, `MAX_RETRIES`); the loop is `runTurnWithRetries` in `src/main/agent/agent.ts`                                                                            |
| Change how compaction picks the cut or what the summarizer reads | `src/main/llm/compaction.ts` (sizes, `planCompaction`, the prompt); the provider-specific safe cuts and text are `compactionAdapter` in `anthropic.ts`, `openai.ts` and `openai_responses.ts`        |
| Change when the app suggests compacting                          | `COMPACT_SUGGESTED_TOKENS` in `src/shared/models.ts`                                                                                                                                                 |
| Make another tool undoable                                       | Return `undo` (`EditUndo`) from its `run`, as `write_file`/`edit_file` do in `src/main/tools/files.ts`; backups and the safety check are in `src/main/tools/edit_backups.ts`                         |
| Log a crash or problem                                           | `appLog.error(source, error, context)` from `src/main/app_log.ts`; see "Crash and error log" under Debugging                                                                                         |
| Add an item to the menu                                          | `src/main/menu.ts` (`MenuCommand` in `src/shared/ipc.ts` if the renderer must react)                                                                                                                 |
| UI                                                               | `src/renderer/src/app.ts`, `views/`, `styles.css`                                                                                                                                                    |
| Change MCP server handling                                       | `McpHub` in `src/main/tools/mcp.ts`; config type in `src/shared/settings.ts`                                                                                                                         |

## Conventions

- TypeScript strict mode plus `noUncheckedIndexedAccess`, `noImplicitOverride` and `noUnusedParameters`; index access returns `T | undefined`, so guard or assert after bounds checks. Prettier (`.prettierrc`: 120 columns, single quotes) is enforced by `npm run format:check` in CI. Run `npm run format` after changes. ESLint (`npm run lint`, flat config in `eslint.config.mjs`) is also enforced in CI; test files, the end-to-end harness, performance measurements and mock servers may use `any`, production sources may not.
- Renderer code builds DOM with `h()` (`src/renderer/src/dom.ts`), which inserts text safely. Use `trustedHtml` only for HTML that went through `renderMarkdown`/`renderDiff` (DOMPurify).
- Never pass API keys or unsanitized model output to the renderer as HTML.
- Keep the Claude conversation history append-only; add new request features through `claudeCapabilities` so models that do not support them keep working.
- Unit tests live next to the code (`*.test.ts`); user-visible behavior gets an end-to-end test in `tests/e2e/`.

## Debugging

- Log redaction recognizes standalone `sk-`, `gsk_` (Groq), `xai-` (xAI) and `AIza` keys, bearer tokens and named API-key/authorization fields. It runs before message/stack truncation. This is pattern-based protection for new entries, not a guarantee for arbitrary secret formats or a cleanup of existing logs; inspect logs before sharing them.
- **View → Toggle Developer Tools** for the renderer; the main process logs to the terminal that launched the app.
- `PATCH_USER_DATA=<folder>` starts with a clean profile.
- **Crash and error log**: `logs/app.log.jsonl` in the user data folder records uncaught errors, unhandled rejections, a crashed or hung UI (`render-process-gone`, `unresponsive`), helper processes that ended, failed IPC handlers (channel and error message; the arguments are not logged, but a message can repeat a path), the app page failing to load, errors that reach the top of the UI (`installErrorReporting` in the renderer sends them over `log:renderer-error`; identical errors once, at most 20 per page load), and errors shown in the chat, plus an `info` line per start (app and Electron version, platform) and one when a hung window responds again. Help → Show Log Folder opens the folder. Call `appLog.error(source, error, context)` from main-process code for anything else worth keeping; put only names, codes and numbers in `context`, never user content. Messages and stacks are redacted for API keys and tokens and cut to a fixed length.
- **Dropped tool fields**: when the model calls a tool without a required field (the known `new_string` problem in `edit_file`), one JSON line goes to `logs/tool-input-errors.jsonl` in the user data folder, with the tool, model and field names but never values. Count them per tool and model with, for example, `jq -r '[.tool, .model, (.missing | join(","))] | @tsv' tool-input-errors.jsonl | sort | uniq -c`. The file stays on the machine and rotates to `.old` at 512 KB.
