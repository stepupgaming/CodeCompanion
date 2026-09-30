import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommandTool, ShellRunner } from './shell';
import type { ToolContext } from './types';
import { Workspace } from './workspace';

const command =
  "node -e \"require('net').createServer().listen(0, '127.0.0.1', () => console.log('background-ready'))\"";

describe('background command cancellation', () => {
  let root: string;
  let shell: ShellRunner;
  let controller: AbortController;
  let context: ToolContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'patch-shell-stop-'));
    shell = new ShellRunner(() => root);
    controller = new AbortController();
    context = {
      shell,
      signal: controller.signal,
      workspace: new Workspace(root),
      readFiles: new Set(),
      browser: null,
      codeSearch: null,
      webSearch: null,
      onProgress() {},
    };
  });

  afterEach(() => {
    shell.stopAll();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not launch a background command with an already-aborted signal', async () => {
    controller.abort();
    await expect(
      runCommandTool.run(
        {
          command: "node -e \"require('fs').writeFileSync('unexpected.txt', 'started')\"",
          background: true,
        },
        context,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(root, 'unexpected.txt'))).toBe(false);
    expect(shell.getBackground(1)).toBeUndefined();
  });

  it('terminates a command when Stop arrives during launch, before the abort listener is installed', async () => {
    shell = new ShellRunner(() => {
      controller.abort();
      return root;
    });
    const entry = shell.startBackground(command, controller.signal);
    await once(entry.process, 'close');
    expect(shell.getBackground(entry.id)).toBeUndefined();
    expect(entry.exitCode).not.toBeUndefined();
  }, 20_000);

  it('cancels the startup wait immediately and terminates its process', async () => {
    const pending = runCommandTool.run({ command, background: true }, context);
    const entry = shell.getBackground(1)!;
    const closed = once(entry.process, 'close');
    controller.abort();

    // Abort must settle without waiting for the three-second startup timer.
    const result = await Promise.race([
      pending.then(
        () => 'finished',
        (error: Error) => error.name,
      ),
      new Promise<string>((resolve) => setImmediate(() => resolve('still waiting'))),
    ]);
    expect(result).toBe('AbortError');
    await closed;
    expect(shell.getBackground(entry.id)).toBeUndefined();
  }, 20_000);

  it('keeps a background command cancellable after its startup result has returned', async () => {
    const result = await runCommandTool.run({ command, background: true }, context);
    const entry = shell.getBackground(1)!;
    expect(result.content).toContain('still running');
    expect(result.content).toContain('background-ready');
    const closed = once(entry.process, 'close');
    controller.abort();
    await closed;
    expect(shell.getBackground(entry.id)).toBeUndefined();
  }, 20_000);
});
