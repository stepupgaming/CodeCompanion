import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { launchApp, type RunningApp } from './app';

describe('crash and error log', () => {
  let running: RunningApp;
  const logFile = () => join(running.userData, 'logs', 'app.log.jsonl');
  const entries = (): Array<Record<string, any>> =>
    existsSync(logFile())
      ? readFileSync(logFile(), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];

  beforeAll(async () => {
    running = await launchApp();
  });

  afterAll(async () => {
    await running?.close();
  });

  it('notes each start with the versions', async () => {
    await vi.waitFor(() =>
      expect(entries().find((entry) => entry.source === 'app')).toMatchObject({ level: 'info', message: 'Started.' }),
    );
    expect(entries().find((entry) => entry.source === 'app')?.context).toMatchObject({ platform: process.platform });
  });

  it('logs an error that reaches the top of the UI', async () => {
    await running.page.evaluate(() => {
      setTimeout(() => {
        throw new Error('e2e renderer failure');
      });
    });
    await vi.waitFor(() =>
      expect(entries().find((entry) => entry.source === 'renderer')).toMatchObject({
        level: 'error',
        message: expect.stringContaining('e2e renderer failure'),
      }),
    );
  });

  it('logs a failing IPC call with its channel and error, but not its arguments', async () => {
    const missing = join(running.userData, 'no-such-folder');
    await running.page.evaluate((path) => window.api.invoke('project:open', path).catch(() => {}), missing);
    await vi.waitFor(() => expect(entries().some((entry) => entry.source === 'ipc')).toBe(true));

    const failure = entries().find((entry) => entry.source === 'ipc')!;
    // The arguments are not recorded as such; the error message may still mention a path, as this one does.
    expect(failure.context).toEqual({ channel: 'project:open' });
    expect(failure).toMatchObject({ level: 'error', message: expect.stringContaining('Folder not found') });
  });

  it('opens the log folder from Help → Show Log Folder', async () => {
    const labels = await running.app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help');
      return help?.submenu?.items.map((item) => item.label) ?? [];
    });
    expect(labels).toEqual(['Show Log Folder']);

    // Stand in for the file manager so the test does not open a window.
    const opened = await running.app.evaluate(async ({ Menu, shell }) => {
      const calls: string[] = [];
      const original = shell.openPath;
      shell.openPath = async (path: string) => {
        calls.push(path);
        return '';
      };
      try {
        const help = Menu.getApplicationMenu()?.items.find((item) => item.role === 'help');
        help?.submenu?.items[0]!.click();
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        shell.openPath = original;
      }
      return calls;
    });
    expect(opened).toEqual([join(running.userData, 'logs')]);
  });
});
