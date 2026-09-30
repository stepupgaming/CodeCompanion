// Measures how the chat UI copes with a long chat: opening it, and streaming an answer at its end, against the same
// with an empty chat. Not part of `npm test`; run `npm run perf` (builds first). Numbers vary by machine, so this
// prints them rather than asserting limits. Results are recorded in docs/PERFORMANCE.md.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CDPSession } from 'playwright-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { TranscriptItem } from '../../src/shared/chat';
import { launchApp, type RunningApp } from '../e2e/app';
import { MockClaude } from '../e2e/mock_claude';
import { ANSWER, transcript } from './long_transcript';

const TURNS = Number(process.env.PERF_TURNS ?? 250);
const LONG_ID = '11111111-1111-1111-1111-111111111111';

function savedChat(id: string, project: string, items: TranscriptItem[]) {
  return {
    version: 1,
    id,
    title: `Long chat (${items.length} items)`,
    projectPath: project,
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    system: 'system prompt',
    transcript: items,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    conversation: { provider: 'anthropic', model: 'claude-opus-5-5', messages: [] },
    readFiles: [],
  };
}

interface Result {
  label: string;
  items: number;
  domNodes: number;
  openMs: number | null;
  frames: number;
  p50: number;
  p95: number;
  worst: number;
  longTasks: number;
  longTaskMs: number;
  // CPU time the main process used while the answer streamed (Electron's own process metrics).
  mainCpuMs: number | null;
  metrics: Record<string, number>;
}

const results: Result[] = [];

describe('long chat performance', () => {
  let running: RunningApp;
  let claude: MockClaude;
  let project: string;
  let profile: string;

  beforeAll(async () => {
    project = mkdtempSync(join(tmpdir(), 'patch-perf-project-'));
    profile = mkdtempSync(join(tmpdir(), 'patch-perf-profile-'));
    mkdirSync(join(profile, 'chats'));
    writeFileSync(
      join(profile, 'chats', `${LONG_ID}.json`),
      JSON.stringify(savedChat(LONG_ID, project, transcript(TURNS))),
    );
    claude = new MockClaude();
    running = await launchApp({ PATCH_TEST_ANTHROPIC_URL: await claude.start() }, { userData: profile });
    await running.page.evaluate((path) => window.api.invoke('project:open', path), project);
    await running.page.evaluate(() => window.api.invoke('settings:set-secret', 'anthropicApiKey', 'sk-ant-perf'));
  });

  afterAll(async () => {
    await running?.close();
    await claude?.stop();
    rmSync(project, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
    const rows = results.map(({ metrics, ...result }) => ({
      ...result,
      scriptMs: metrics.ScriptDuration,
      layoutMs: metrics.LayoutDuration,
      styleMs: metrics.RecalcStyleDuration,
    }));
    console.log(`\nLong chat performance (${TURNS} turns, ${TURNS * 5} items)\n`);
    console.table(rows);
    // Also kept in out/ (git-ignored), since test runners can swallow console output.
    mkdirSync(join(__dirname, '../../out'), { recursive: true });
    writeFileSync(join(__dirname, '../../out/perf-long-chat.json'), JSON.stringify({ turns: TURNS, rows }, null, 2));
  });

  // One session for the whole run: enabling the Performance domain again would reset its counters.
  let session: CDPSession | undefined;
  async function cdpMetrics(): Promise<Record<string, number>> {
    if (!session) {
      session = await running.page.context().newCDPSession(running.page);
      await session.send('Performance.enable', { timeDomain: 'threadTicks' });
    }
    const { metrics } = await session.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
  }

  const diffMetrics = (before: Record<string, number>, after: Record<string, number>) =>
    Object.fromEntries(
      ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((name) => [
        name,
        Math.round(((after[name] ?? 0) - (before[name] ?? 0)) * 1000),
      ]),
    );

  const domNodes = () => running.page.evaluate(() => document.querySelectorAll('.transcript *').length);

  // Seconds of CPU the main (browser) process has used since it started, or null where Electron does not report it.
  const mainCpuSeconds = () =>
    running.app.evaluate(
      ({ app }) => app.getAppMetrics().find((metric) => metric.type === 'Browser')?.cpu.cumulativeCPUUsage ?? null,
    );

  // Streams ANSWER into the open chat and records every frame and long task while it arrives.
  async function stream(label: string, items: number, openMs: number | null): Promise<void> {
    claude.script({ slow: { text: ANSWER, chunks: 400, intervalMs: 5 } });
    await running.page.evaluate(() => {
      const state = { frames: [] as number[], long: [] as number[], stop: false };
      (window as any).__perf = state;
      new PerformanceObserver((list) => list.getEntries().forEach((entry) => state.long.push(entry.duration))).observe({
        type: 'longtask',
      });
      let last = performance.now();
      const tick = (time: number) => {
        state.frames.push(time - last);
        last = time;
        if (!state.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const before = await cdpMetrics();
    const cpuBefore = await mainCpuSeconds();
    await running.page.evaluate(() => window.api.invoke('chat:send', { text: 'Explain everything in detail' }));
    await running.page.waitForFunction(
      (tail) =>
        [...document.querySelectorAll('.message.assistant:not(.streaming)')].some((node) =>
          node.textContent?.includes(tail),
        ),
      'Part 19',
      { timeout: 60_000, polling: 100 },
    );
    const after = await cdpMetrics();
    const cpuAfter = await mainCpuSeconds();
    const perf = await running.page.evaluate(() => {
      const state = (window as any).__perf;
      state.stop = true;
      return { frames: state.frames as number[], long: state.long as number[] };
    });
    const sorted = [...perf.frames].sort((a, b) => a - b);
    const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! * 10) / 10;
    results.push({
      label,
      items,
      domNodes: await domNodes(),
      openMs,
      frames: sorted.length,
      p50: at(0.5),
      p95: at(0.95),
      worst: Math.round(sorted.at(-1) ?? 0),
      longTasks: perf.long.length,
      longTaskMs: Math.round(perf.long.reduce((sum, value) => sum + value, 0)),
      mainCpuMs: cpuBefore === null || cpuAfter === null ? null : Math.round((cpuAfter - cpuBefore) * 1000),
      metrics: diffMetrics(before, after),
    });
  }

  it('streams into an empty chat', async () => {
    await stream('empty chat', 0, null);
  });

  it('opens a long chat and streams at its end', async () => {
    await running.page.evaluate(() => window.api.invoke('chat:new'));
    const before = await cdpMetrics();
    const openMs = await running.page.evaluate(async (id) => {
      const start = performance.now();
      await window.api.invoke('history:open', id);
      // Wait until the transcript is on screen and painted.
      while (document.querySelectorAll('.transcript > *').length === 0)
        await new Promise((resolve) => setTimeout(resolve, 5));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return Math.round(performance.now() - start);
    }, LONG_ID);
    const openMetrics = diffMetrics(before, await cdpMetrics());
    results.push({
      label: 'open long chat',
      items: TURNS * 5,
      domNodes: await domNodes(),
      openMs,
      frames: 0,
      p50: 0,
      p95: 0,
      worst: 0,
      longTasks: 0,
      longTaskMs: 0,
      mainCpuMs: null,
      metrics: openMetrics,
    });
    await stream('long chat', TURNS * 5, openMs);
  });
});
