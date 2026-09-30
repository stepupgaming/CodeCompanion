import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';

export interface RunningApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
  errors: string[];
  // Output the main process wrote to stderr (e.g. errors from IPC handlers).
  mainErrors: string[];
  close(): Promise<void>;
}

const CLOSE_TIMEOUT_MS = 20_000;

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Ends a process and everything it started.
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Launches the built app (run `npm run build` first) with a throwaway profile. Pass `userData` to start again on the
// profile of an earlier launch, as after a restart; that folder is then left for the caller to remove.
export async function launchApp(
  env: Record<string, string> = {},
  options: { userData?: string } = {},
): Promise<RunningApp> {
  const userData = options.userData ?? mkdtempSync(join(tmpdir(), 'codecompanion-e2e-'));
  const root = resolve(__dirname, '../..');
  const app = await electron.launch({
    args: [root],
    cwd: root,
    env: {
      ...process.env,
      PATCH_USER_DATA: userData,
      // Invisible windows that never take focus, so a test run does not flash windows over your work.
      // Set E2E_SHOW_WINDOW=1 to watch the tests.
      ...(process.env.E2E_SHOW_WINDOW ? {} : { PATCH_E2E_QUIET: '1' }),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  const mainErrors: string[] = [];
  app.process().stderr?.on('data', (data: Buffer) => mainErrors.push(data.toString()));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.waitForLoadState('domcontentloaded');

  return {
    app,
    page,
    userData,
    errors,
    mainErrors,
    async close() {
      // A hang here would otherwise surface as an opaque 60-second hook timeout. After 20 seconds the app is killed, so
      // no processes are left behind, and the test fails with what the main process printed.
      const pid = app.process().pid;
      const closed = await Promise.race([app.close().then(() => true), delay(CLOSE_TIMEOUT_MS).then(() => false)]);
      if (!closed) {
        killTree(pid);
        throw new Error(
          `The app did not quit within ${CLOSE_TIMEOUT_MS / 1000} s of being closed (pid ${pid}); it was killed. Main process output: ${mainErrors.join('').slice(-2000) || '(none)'}`,
        );
      }
      if (!options.userData) rmSync(userData, { recursive: true, force: true });
    },
  };
}
