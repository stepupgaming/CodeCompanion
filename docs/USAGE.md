# Using Patch

A short guide to the parts that need explaining: approvals, allow-lists, stopping and resuming, and exporting a chat. For installing and building, see the [README](../README.md).

## Start

1. **File → Open Project…** (`Ctrl+O`) and pick a folder. The assistant can only read and change files inside it.
2. Open **Settings** (gear icon, `Ctrl+,`) and add an API key: Anthropic for Claude models, OpenAI for GPT-6 models and for semantic code search. Keys are encrypted when system encryption is available; Settings warns about plaintext storage if encryption is unavailable or migration fails. Existing plaintext keys are migrated when encryption becomes available. Stored keys are never shown again; type a new one to replace it, or press **Remove**.
3. Type a task in the box at the bottom and press `Enter` (`Shift+Enter` for a new line). Attach or paste images with the paperclip button (PNG, JPEG, GIF or WebP, up to 5 MB each, whether attached or pasted). All built-in models accept images. For a Claude model id entered under _Other model id…_ that the app does not know, the paperclip is disabled, pasting an image shows why, and images already in the draft are marked and cannot be sent: start a new chat with a built-in model to use them. OpenAI-compatible endpoints are not checked, since the app cannot know what their models accept; the endpoint's own error is shown if it refuses.

Each chat keeps the model it started with. Changing the model in Settings applies to new chats.

### Tell it about your project

- **Project instructions**: the project menu (the folder button at the top) → _Project settings…_. The text is added to every new chat in that project, e.g. "Run `npm test` after changes" or "Never edit `generated/`".
- **`AGENTS.md`** (or `CLAUDE.md`) in the project root is added to every chat automatically. The status bar shows "AGENTS.md loaded".

Both are prompt text, not enforced rules: the assistant can still get them wrong, which is why approvals exist.

## Approvals

By default the assistant asks before it changes anything. A card appears in the chat showing what it wants to do, with **Approve** and **Decline** buttons.

| It wants to…                                             | What you see     |
| -------------------------------------------------------- | ---------------- |
| Edit or create a file (`edit_file`, `write_file`)        | The diff         |
| Run a command (`run_command`)                            | The command text |
| Fetch a page or use the browser (`fetch_url`, `browser`) | The URL          |

Reading files, listing folders, searching the code and web search never ask.

Very large diffs are shown only in part: the first 2,000 lines. The approval card then says so in a yellow warning, because approving applies the whole change, including the part you cannot see. Decline and ask for smaller edits if you want to review everything. Long command output shows its last 20,000 characters, with a note that the start was left out.

- **Approve** runs it and the assistant continues.
- **Decline** with the box left empty stops the task. Any other calls the assistant had planned for that step are skipped.
- **Decline with a note** ("use pnpm instead") sends the note to the assistant, which adjusts and carries on. Use this rather than an empty decline when you want it to try something else.

Existing files must be read by the assistant in the same chat before it can change them, and a file that was not read is rejected before you are asked to approve.

### Undo an edit

Every approved file edit keeps a copy of the file as it was. The edit's card in the chat gets an **Undo** button (it also shows in Auto mode). Press it and confirm to put the file back, or to delete a file the assistant created.

- Undo only works while the file is exactly as the edit left it, so it never throws away something you or a later edit wrote afterwards. If the file changed, you get a message saying so and nothing is touched. Undo the later edits first (newest first), or restore the file with Git.
- It is available while the assistant is idle. Stop the task first if it is still working.
- The assistant is told with your next message that you undid the edit, and has to read the file again before it changes it. The card then shows **Undone**.
- Only file edits made with the assistant's edit and write tools can be undone. Changes made by commands it ran (`npm install`, `git checkout`, a code generator) cannot; the Git panel and Git itself are the way back for those.
- The copies are kept in the app's data folder (`edit-backups`), the last 50 edits of each chat, and are deleted with the chat. They are copies of your own project files, so they are as sensitive as the files.

### Ask first or Auto

**Settings → Approvals**, or the **Ask first** / **Auto** button in the header, chooses between:

- **Ask before edits and commands** (default): as above.
- **Run edits and commands without asking** (Auto): nothing waits for you. Commands run in your shell with your permissions, so use it only for work you would let anyone on your keyboard do.

Even in Auto mode, a fetch or browser redirect to another host is blocked; the assistant has to ask for the new address as a separate step.

## Allow-lists

Two lists let specific things skip the approval card while **Ask** mode stays on. Both are empty by default, and there are two places to fill them:

- **Settings**: for every project.
- **Project settings…** in the project menu (the folder button at the top): for the open project only, in addition to the lists in Settings. A command or host is allowed when either list has it. Use this for what only makes sense in one project, such as `cargo check` or that project's dev server host. These lists are kept with the app's data, not in the project folder, so a repository you clone cannot allow its own commands. They apply at once, also to a chat that is already open.

The rules below are the same for both.

### Commands allowed without asking

One command per line. A line allows that exact command and the same command followed by arguments:

```
npm test
npm run lint
git status
# lines starting with # are comments
```

- `npm test` also allows `npm test -- --watch`, but not `npm testing` or `npm run test`.
- Any command containing `;`, `&`, `|`, `>`, `<`, a backtick, `$`, `(`, `)`, `{`, `}` or a line break is always asked about, so an allowed `npm test` cannot become `npm test && rm -rf .`, nor, in PowerShell (which runs the commands on Windows), `npm test (Remove-Item -Recurse src)`. Ordinary arguments such as `npm install @types/node` or `npx vitest run "src/a b.test.ts"` still match.
- File edits are always asked about, whatever is on this list.
- Only allow commands you would run yourself. `npm run` would let the assistant run any script in `package.json`.

### Network hosts allowed without asking

One hostname per line, matched exactly and on any port:

```
localhost
api.example.com
```

- `localhost` allows `http://localhost:3000/`. `example.com` does **not** allow `www.example.com`; list each subdomain.
- Approved hosts can receive whatever the assistant sends them, and this is not a network sandbox: page subresources and Google search are not filtered. Keep projects with secrets out of chats that read untrusted pages.

## Stop and Resume

- **Stop** (the red button, or `Ctrl+.`) aborts the current request, running foreground commands and background commands belonging to the active project, including commands still starting. Other projects' background jobs and the interactive terminal are unaffected. It also cancels a wait before a retry.
- The composer then shows **Resume**. Resume continues the task from the conversation so far without you retyping the request. The assistant is told that an interrupted action may have partly happened, so it checks the current state before repeating anything with side effects.
- The Resume state is saved with the chat, so it is still there after you close the app and reopen the chat from the history.
- Sending a new message instead of resuming drops the Resume option.

Resume continues from the conversation, not from an exact checkpoint. Look at the diff and Git panel after resuming a run that was stopped mid-command.

## When the provider has a problem

Rate limits (429), server errors (5xx) and dropped connections are retried automatically, up to 4 times, waiting longer each time or as long as the provider asks. Each retry shows a line in the chat, for example "Rate limited (429). Retrying in 2 s (retry 1 of 4)…". **Stop** works during the wait. If the retries run out, or the problem is one a retry cannot fix (a wrong key, an unknown model, no credit), the error is shown in the chat.

## Chats and projects

- **New chat**: `Ctrl+N`. Chats are saved automatically.
- **Chat history** (clock icon): search by title, project or message text (every word must match, and matching messages show an excerpt), open, delete one chat or clear all. Deleting removes the chat for good, also when it is open or in another project's tab, together with its edit backups; late title responses cannot restore it. Wait until a running task is stopped or an Undo finishes before deleting that chat. Each chat shows its estimated cost so far ("≈ $0.42"), as of its last save; chats on a custom endpoint or a model without a known price show none.
- **Several projects**: opening another project adds a tab. Each tab has its own chat and its own unsent draft. Stop the current task before switching; only one task runs at a time. Closing a tab keeps its saved chats.

### Compact a long chat

Every request re-sends the conversation, so a long chat gets slower and costs more, and eventually no longer fits in the model's context window. The status bar shows **Context: 96k**, the size of the last prompt. From 150k it says "consider compacting" and the **Compact chat** button in the header (arrows icon) turns yellow.

Press it to have the older turns summarized. Standard provider chats use a small model (Claude Haiku 4.5 or GPT-6 Luna, according to the chat's provider and available keys). A custom OpenAI-compatible chat uses its own pinned model on that endpoint for the summary, which requires JSON-schema structured-output support. From then on the summary is sent in place of older turns, followed by the most recent part of the chat (roughly the last 10k tokens) exactly as it was.

- Your chat on screen does not change; a notice says how many messages were replaced. **Stop** cancels a compaction in progress and leaves the chat unchanged.
- Nothing is deleted. The saved chat file keeps every message, so a compacted chat can still be searched and exported in full. Compacting again later summarizes the previous summary together with what came after it.
- The first request afterwards re-reads the whole prompt once, so it costs like the first message of a chat. The summarizing request itself is not counted in the token totals.
- A summary can lose detail. If the assistant seems to have forgotten something, say it again. For a task that is nearly finished, starting a new chat can work better.
- Nothing happens for a short chat ("not enough older history"). Current Claude models also compact on the server side, and OpenAI chats otherwise drop their oldest turns once the context fills up. Manual compaction keeps a summary of those turns instead; custom endpoints must support the selected summarizer model and JSON-schema structured output. If they reject the summary request, the error is shown and the conversation is left unchanged.

### Export

The download button in the chat header (_Export chat_) asks where to save and writes the chat as a Markdown file: your messages, the assistant's answers, and the diffs and commands it proposed (an edit you undid is marked "(undone)"). Tool output and the assistant's thinking are left out.

## Settings

Besides the API keys, approvals and allow-lists described above, **Settings** has:

- **Model**, and **Other model id…** for a model that is not in the list. A chat keeps the model it started with.
- **Effort**: how much the model thinks before acting (current Claude and OpenAI models); higher is slower and costs more. Answers show the model's reasoning under a collapsed **Thinking** line.
- **Theme**: dark or light.
- **Editor command**: what the **Open in editor** link on a tool card runs, e.g. `code`, `cursor` or `subl`.
- **OpenAI-compatible base URL**: for Ollama, OpenRouter, LM Studio and similar. Leave it empty for OpenAI itself.
- **Google search engine id**: with a Google API key, turns on web search.
- **Maximum files to index for code search**, and the current project's index status with a **Reindex** button.

The project menu (the folder button at the top) has **Project settings…** for the open project (its instructions and its own allow-lists, see above). **Remove from recent** is on each recent project's row on the welcome screen, shown when no project is open.

## Side panel

The panel button in the header shows or hides the side panel with three tabs:

- **Terminal**: a normal shell in the project folder, separate from the commands the assistant runs.
- **Browser**: where the assistant checks web apps, and where you can look at them yourself. Type an address such as `http://localhost:3000` in the address bar.
- **Git**: changed files with diffs, **Commit all** with a message, per-file discard (which deletes new files, so it asks first), and **Initialize repository** for folders that are not repositories yet.

Before a repository's first commit, the diff includes staged additions and any later working-tree changes. Discarding a renamed file restores its original committed path and removes the renamed destination, including edits to it; review the diff before confirming.

## Where things are

- Settings, projects, saved chats and code indexes are in the app's user data folder. **Help → Show Log Folder** opens its `logs` folder.
- `logs/app.log.jsonl` records crashes and other problems, one JSON line each, plus a line per start with the app and Electron version and platform. It holds error messages and stack traces (which can mention file paths), not your chat history or API keys, and it is never sent anywhere. Attach it when reporting a bug, after a glance at what is in it.
- The `PATCH_USER_DATA=<folder>` environment variable selects a profile directory. The default is `Patch` under the system application-data directory; to reuse an existing profile, point this variable at its folder.

## Costs

The status bar shows token totals and, for the built-in Claude and GPT-6 models, an estimated cost including cache reads and writes. Custom OpenAI-compatible endpoints have no official price, so no estimate is shown. A request that fails part-way and is retried can be billed for the part that was already generated.
