# Performance

## Long chats in the renderer (2026-09-30)

**Question:** does the chat UI need a virtualized or paginated message list for long chats?

**Answer:** not at this point. Three targeted changes roughly halved opening time and improved long-chat rendering, but the initial claim that a 5,000-item chat streamed as smoothly as an empty chat was based on an off-screen answer. The later [Windows bisection](#windows-bisection-2026-09-30) measured 14–21 ms median frames while actually following the answer, versus the earlier 7 ms off-screen result. Remaining costs include layout across the long transcript and rendering the growing answer.

### How it is measured

`npm run perf` (builds first) runs `tests/perf/long_chat.perf.ts`. The test is not part of `npm test` and asserts nothing. It writes its results to `out/perf-long-chat.json`.

- **The chat:** a synthetic saved chat of `PERF_TURNS` turns (default 250). Each turn has 5 items:
  - a request
  - a Markdown answer with a list and a 25-line highlighted code block
  - a `read_file` card
  - an `edit_file` card with a 30-line diff
  - a short reply
- **Open:** the time from `history:open` until the transcript is on screen and painted, measured in the page.
- **Streaming:** a 20,000-character answer (prose, lists, code blocks) streamed by the mock API as 400 deltas, 5 ms apart. The chat is streamed into twice: once empty, once after the long chat has been opened. Measured while it arrives:
  - `requestAnimationFrame` intervals (p50, p95, worst)
  - Chromium's script, layout and style-recalculation time, from the DevTools protocol's `Performance.getMetrics`
- **Window:** the invisible e2e test window, with background throttling off.

Machine: Intel Core Ultra 9 285K (24 threads), 47 GB RAM, Windows 11, Electron 44.4.5, 144 Hz display (a 7 ms frame is a full frame rate). Treat the numbers as relative; they vary by machine.

### Results

1,000 turns (5,000 items):

|                                     | DOM nodes | Open     | Frame p50 / p95 while streaming | Layout / style during the stream |
| ----------------------------------- | --------- | -------- | ------------------------------- | -------------------------------- |
| Empty chat (reference)              | 1.8k      | —        | 7 / 14 ms                       | 0.48 s / 0.32 s                  |
| Before                              | 456k      | 3,205 ms | 42 / 49 ms (~24 fps)            | 1.94 s / 0.20 s                  |
| + `content-visibility: auto`        | 456k      | 2,472 ms | 28 / 35 ms                      | 0.62 s / 3.02 s                  |
| + update changed items in place     | 456k      | 2,465 ms | 7 / 14 ms                       | 0.07 s / 0.05 s                  |
| + build card bodies on first expand | 166k      | 1,104 ms | 7 / 14 ms                       | 0.07 s / 0.05 s                  |

250 turns (1,250 items):

|                         | DOM nodes | Open   | Frame p50 / p95 while streaming |
| ----------------------- | --------- | ------ | ------------------------------- |
| Before                  | 114k      | 841 ms | 7 / 21 ms                       |
| After all three changes | 41.5k     | 297 ms | 7 / 7 ms                        |

### What was slow, and what changed

1. **Layout of the whole chat on every streamed frame.** The transcript is a flex column, and the message being streamed changes on every frame, so Chromium re-laid out the whole list each time.
   - _Fix:_ `.transcript > *` now has `content-visibility: auto` with `contain-intrinsic-size: auto 80px`. Items off screen are skipped for layout and paint, but stay in the DOM and the accessibility tree.
2. **Style recalculation of the whole chat on every frame.** This showed up once layout was cheap. Each frame, the streaming message's element was swapped for a new one, which invalidated the styles of its siblings (Bootstrap uses sibling and `:last-child` selectors).
   - _Fix:_ `TranscriptView` now updates a changed item's element in place (`morph`: same element, new attributes and children).
3. **Every finished tool card built its diff up front,** even though the card is collapsed. The diffs were most of the DOM (diff2html lays out a table row per line).
   - _Fix:_ a finished card's diff and output are built the first time the card is opened. Approval cards and running cards are unchanged.

### Follow-up: scrolling to the bottom (2026-09-30, 0.2.0 audit)

`content-visibility: auto` broke scrolling to the bottom. Items that were off screen count at their 80 px placeholder height until laid out, so:

- opening a chat of 200 tall items landed 3,300 px above the end;
- a new approval card appended while following the chat left Approve out of view.

The fix:

- after a chat is opened, the view jumps to the bottom again for 10 frames, and for 2 frames after an item is added;
- a view at the bottom stays there when the scroll area gets smaller;
- the user's own scrolling ends all of this.

`tests/e2e/transcript_view.test.ts` covers it.

**Cost, from three runs of each variant:**

| Streaming, frame p50 / p95 | 250 turns | 1,000 turns                              |
| -------------------------- | --------- | ---------------------------------------- |
| Before the fix             | 7 / 7 ms  | 7 / 14 ms (one run in three: 21 / 28 ms) |
| With the fix               | 7 / 21 ms | 14–21 / 28 ms                            |

Opening times are unchanged. For comparison, the same 1,000-turn chat was at 42 / 49 ms before the three changes above.

**Other ways that were measured and dropped:** each made streaming in the 1,000-turn chat two to three times slower.

- following every height change, with a frame loop or with a ResizeObserver on the transcript;
- laying out the newest items with an inline `content-visibility` style.

**Resolved by the later Windows bisection:** the old benchmark was not following the answer, so Chromium skipped its off-screen layout. Correctly following a visible answer exposes the layout cost of the long transcript; see [Windows bisection](#windows-bisection-2026-09-30).

**The benchmark is noisy:** the same build sometimes measures 7 ms and sometimes 21 ms, so compare at least three runs.

#### Linux orb follow-up (2026-09-30)

The regression was investigated again in a 4-vCPU Linux orb with Electron under Xvfb. This environment is much slower
than the Windows/144 Hz machine above, so these numbers are separate evidence and must not be compared directly with
that table. The measured command (after `npm run build`) was run three times for each variant:

```bash
E2E_SHOW_WINDOW=1 PERF_TURNS=1000 xvfb-run -a npx vitest run --project perf tests/perf/long_chat.perf.ts
```

`E2E_SHOW_WINDOW=1` matters under Xvfb: without it Chromium rendered the hidden window at about 1 frame/second, making
frame percentiles meaningless. With the checked-in implementation, the 5,000-item stream measured 50 / 67 ms p50 /
p95 in all three runs (layout 431, 450 and 429 ms; open 2,856, 2,789 and 3,013 ms). The empty-chat reference was 17 /
50 ms in all three runs, showing that this constrained orb cannot reproduce the original 7 ms reference either.

Tracing `TranscriptView.render()` confirmed one synchronous geometry path during each followed streaming update: it
reads `scrollHeight`, `scrollTop` and `clientHeight` to decide whether to follow, then assigns `scrollTop` from
`scrollHeight`. Two bounded candidates were measured and dropped:

- Caching the follow state removed the decision read but left the exact-bottom write. Three runs remained 50 / 67–83
  ms, with 434–452 ms of layout: no improvement.
- Caching the state and throttling the exact-bottom write to every 50 ms (plus a final write when streaming finished)
  reduced layout to 378–393 ms, but frame results remained 50 / 67–83 ms. The transcript E2E checks, extended locally
  to cover following a growing answer and stopping after a user scroll, passed, but the frame result did not justify
  the added timing and input-state complexity.

Removing the write entirely was not viable: a tall streamed answer finished about 740 px above the bottom, so browser
scroll anchoring does not preserve resize-follow here. No renderer change was kept. A useful next experiment needs a
Windows/high-refresh environment that reproduces the 14–21 ms regression; the Linux orb evidence bounds geometry
bookkeeping to part of layout cost, not the observed frame regression.

#### Windows bisection (2026-09-30)

Reproduced on the Windows machine (1,000 turns, three runs per variant, layout time during the stream):

| Variant                                                      | Frame p50 / p95 | Layout         |
| ------------------------------------------------------------ | --------------- | -------------- |
| Before the scroll fix (`ed40da2`)                            | 7 / 7 ms        | 74–77 ms       |
| Current (`af50695`)                                          | 14–21 / 21 ms   | 1,161–1,203 ms |
| Current, without the focus check in `render()`               | 14–21 / 21 ms   | 1,157–1,193 ms |
| Current, without the `ResizeObserver`                        | 14–21 / 21 ms   | 1,175–1,187 ms |
| Current, with block layout instead of flex for `.transcript` | 14–21 / 21 ms   | 1,084–1,087 ms |
| Current, without any scroll-to-bottom writes                 | 7 / 7 ms        | 77 ms          |

Finding: the regression is not a cost of the new code. Before the scroll fix, the jump to the bottom landed short, so the
view was not at the bottom, `stick` was false and the streamed answer sat off screen, where `content-visibility` skips
it. The 7 ms was the benchmark measuring a chat that was not following. With the view really at the bottom (what users
see), the streamed item is on screen and is laid out on every frame. The extra 0.6 s of layout over the empty chat
(0.5 s) is the price of 5,000 `content-visibility: auto` siblings around it; none of the small pieces accounts for it.

Ruled out: the focus check, the `ResizeObserver` and flex layout (a small gain, not kept). Not tried: grouping older
items into a few `content-visibility` chunks, so fewer elements take part in each layout.

### Not changed, and why

- **Re-rendering the streaming message's Markdown on each frame.** The whole answer so far is re-parsed, highlighted and sanitized on every frame: about 2.2 s of script over the 20,000-character answer, or about 3 ms per frame. This cost depends on the answer, not the chat, and is the same in an empty chat. If very long answers stutter, render only the last Markdown block while streaming.
- **Opening still renders every message's Markdown** (about 0.2 ms per item). A 5,000-item chat opens in about 1.1 s. Rendering off-screen messages lazily, or full virtualization, would help chats far longer than this. It would cost scroll-position bookkeeping and would break Find in page and the screen-reader view of the full chat, so it is not worth it yet.
- **The main process** also applies every streamed event to its own copy of the transcript. This was measured afterwards; see the next section.
- **`Performance.getMetrics` did not attribute the opening's script time** (it reported about 2 ms), so opening is measured by wall-clock time in the page instead.

## Streamed events in the main process (2026-09-30)

**Question:** in a long chat, does the main process slow down while an answer streams? `ChatSession` applies every streamed event to its own copy of the transcript (`applyChatEvent`, which builds a new item list for each event) before sending the event to the UI.

**Answer:** no, not at any chat length the renderer handles well. The cost grows with the chat, but stays small next to the rest of the main process's work.

### How it is measured

`npm run perf` also runs `tests/perf/main_process.perf.ts` and writes `out/perf-main-process.json`.

- It runs in Node, without the app.
- A real `ChatSession` opens saved transcripts of 0 to 20,000 items (the same generator as the renderer measurement, `tests/perf/long_transcript.ts`).
- A scripted model streams a 16,000-character answer in 10-character pieces, about 1,600 events, a busy stream.
- Timed: the whole answer through the session; `applyChatEvent` alone for the same events; and serializing each event the way sending it to the UI does. Each is the median of 5 runs after a warm-up.

`tests/perf/long_chat.perf.ts` also reports `mainCpuMs`, the main process's CPU time while an answer streams in the real app, from Electron's `app.getAppMetrics()`.

### Results

Same machine as above. The numbers were stable across three runs.

| Chat         | Per streamed piece | One whole answer (1,594 pieces) | Of that, `applyChatEvent` |
| ------------ | ------------------ | ------------------------------- | ------------------------- |
| empty        | 1 µs               | 1 ms                            | 0.2 ms                    |
| 1,250 items  | 8 µs               | 12 ms                           | 11 ms                     |
| 5,000 items  | 30 µs              | 48 ms                           | 35 ms                     |
| 20,000 items | 230 µs             | 370 ms                          | 355 ms                    |

- **Serializing the events for the UI:** 0.2 ms per answer at every size.
- **Main-process CPU in the real app:** measured while the 1,000-turn benchmark streams its answer, in 400 pieces over about 2 s.

  | Chat        | Main-process CPU |
  | ----------- | ---------------- |
  | empty       | 251–254 ms       |
  | 5,000 items | 192–222 ms       |

  The difference is within the noise. The transcript copies cost about 12 ms of that stream, which is lost among the rest of the main process's work: parsing the stream, IPC and saving.

### Conclusion

- **Linear up to 5,000 items, faster than linear after.** The cost grows linearly with the chat up to 5,000 items. From 5,000 to 20,000 items it grows 7.5 times for 4 times the items, probably because of garbage collection.
- **Where it could start to matter:** at 20,000 items and a fast stream of about 100 pieces a second, the copies would take roughly 2% of a core.
- **Nothing to change now.** If chats that long become common, the fix is to update the streaming item in place in the main process's copy, which is not shared with anything. The renderer already needs new objects for its own copy.
