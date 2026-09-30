import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { defineTool, truncateOutput } from './types';

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;
const MAX_BUFFERED_CHARS = 1_000_000;
const EXIT_DRAIN_MS = 500;

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

interface BackgroundCommand {
  id: number;
  command: string;
  process: ChildProcess;
  output: string;
  exitCode: number | null | undefined;
  detachAbort: () => void;
}

// The shell the agent's commands run in. Named in the system prompt so the model writes matching syntax.
export function shellName(): string {
  return process.platform === 'win32' ? 'PowerShell' : process.env.SHELL?.split('/').pop() || 'bash';
}

function shellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    // UTF-8 output so non-ASCII text survives.
    const prelude = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;';
    return {
      file: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', prelude + command],
    };
  }
  return { file: process.env.SHELL || '/bin/bash', args: ['-lc', command] };
}

// Runs agent commands in the project directory. Each command gets a fresh shell, so `cd` does not persist.
export class ShellRunner {
  private readonly background = new Map<number, BackgroundCommand>();
  private nextId = 1;

  constructor(private readonly cwd: () => string) {}

  run(
    command: string,
    {
      timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
      signal,
      onOutput,
    }: { timeoutSeconds?: number; signal?: AbortSignal; onOutput?: (text: string) => void } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      // A stop that came in before the command could start: an abort listener added now would never fire.
      if (signal?.aborted) return resolve({ exitCode: null, output: '', timedOut: false, aborted: true });
      const child = this.spawn(command);
      let output = '';
      let timedOut = false;
      let aborted = false;

      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output = (output + text).slice(-MAX_BUFFERED_CHARS);
        onOutput?.(text);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      const timer = setTimeout(
        () => {
          timedOut = true;
          killTree(child);
        },
        Math.min(timeoutSeconds, MAX_TIMEOUT_SECONDS) * 1000,
      );
      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      let finished = false;
      const finish = (exitCode: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ exitCode, output, timedOut, aborted });
      };
      child.on('error', (error) => {
        output += `\n${error.message}`;
        finish(null);
      });
      // 'close' waits for the output pipes, which a leftover child (a test worker, a dev server the command started)
      // can hold open long after the command itself ended. Give the pipes a moment to drain, then stop waiting.
      child.on('exit', (code) => setTimeout(() => finish(code), EXIT_DRAIN_MS));
      child.on('close', (code) => finish(code));
    });
  }

  startBackground(command: string, signal?: AbortSignal): BackgroundCommand {
    signal?.throwIfAborted();
    const child = this.spawn(command);
    const onAbort = () => this.stopBackground(entry.id);
    const entry: BackgroundCommand = {
      id: this.nextId++,
      command,
      process: child,
      output: '',
      exitCode: undefined,
      detachAbort: () => signal?.removeEventListener('abort', onAbort),
    };
    const collect = (chunk: Buffer) => {
      entry.output = (entry.output + chunk.toString('utf8')).slice(-MAX_BUFFERED_CHARS);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('close', (code) => {
      entry.exitCode = code;
      entry.detachAbort();
    });
    child.on('error', (error) => {
      entry.output += `\n${error.message}`;
      entry.exitCode = null;
      entry.detachAbort();
    });
    this.background.set(entry.id, entry);
    signal?.addEventListener('abort', onAbort, { once: true });
    // An abort during spawning must not leave an untracked command alive.
    if (signal?.aborted) onAbort();
    return entry;
  }

  getBackground(id: number): BackgroundCommand | undefined {
    return this.background.get(id);
  }

  stopBackground(id: number): boolean {
    const entry = this.background.get(id);
    if (!entry) return false;
    entry.detachAbort();
    if (entry.exitCode === undefined) killTree(entry.process);
    this.background.delete(id);
    return true;
  }

  // Called on Stop, when a chat/project closes, or when the app quits.
  stopAll(): void {
    for (const id of [...this.background.keys()]) this.stopBackground(id);
  }

  private spawn(command: string): ChildProcess {
    const { file, args } = shellCommand(command);
    return spawn(file, args, {
      cwd: this.cwd(),
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Own process group on POSIX so the whole tree can be killed.
      detached: process.platform !== 'win32',
    });
  }
}

function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

export function formatResult(command: string, result: CommandResult): string {
  const status = result.aborted
    ? 'Stopped by the user.'
    : result.timedOut
      ? 'Timed out and was stopped.'
      : `Exit code: ${result.exitCode ?? 'unknown'}`;
  const output = stripAnsi(result.output).trim();
  return `$ ${command}\n${status}\n${output ? truncateOutput(output) : '(no output)'}`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export const runCommandTool = defineTool({
  name: 'run_command',
  description: `Run a shell command (${shellName()}) in the project root and return its output and exit code. Each call starts a fresh shell: use paths instead of cd. Set background to true for servers and watchers that do not exit, then read their output with command_output.`,
  schema: z.object({
    command: z.string().min(1),
    background: z.boolean().optional().describe('Start without waiting for it to finish (servers, watchers).'),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_SECONDS)
      .optional()
      .describe(`Default ${DEFAULT_TIMEOUT_SECONDS}.`),
  }),
  requiresApproval: true,
  async preview({ command, background }) {
    return { title: background ? 'Start background command' : 'Run command', command };
  },
  async run({ command, background, timeout_seconds }, context) {
    if (background) {
      const entry = context.shell.startBackground(command, context.signal);
      // Give servers a moment so early errors (port in use, syntax errors) show up in the result.
      await delay(3000, undefined, { signal: context.signal });
      const status = entry.exitCode === undefined ? 'still running' : `exited with code ${entry.exitCode}`;
      return {
        content: `Started background command ${entry.id} (${status}).\n${truncateOutput(stripAnsi(entry.output)) || '(no output yet)'}`,
        summary: `Started \`${command}\` in the background`,
      };
    }
    const result = await context.shell.run(command, {
      timeoutSeconds: timeout_seconds,
      signal: context.signal,
      onOutput: (text) => context.onProgress(stripAnsi(text)),
    });
    return {
      content: formatResult(command, result),
      isError: result.exitCode !== 0,
      summary: `Ran \`${command}\` (${result.timedOut ? 'timed out' : `exit ${result.exitCode}`})`,
    };
  },
});

export const commandOutputTool = defineTool({
  name: 'command_output',
  description: 'Get the output of a background command started with run_command, or stop it.',
  schema: z.object({
    id: z.number().int(),
    stop: z.boolean().optional().describe('Stop the command after reading its output.'),
  }),
  requiresApproval: false,
  async run({ id, stop }, context) {
    const entry = context.shell.getBackground(id);
    if (!entry) return { content: `No background command with id ${id}.`, isError: true };
    const status = entry.exitCode === undefined ? 'running' : `exited with code ${entry.exitCode}`;
    const output = truncateOutput(stripAnsi(entry.output).trim()) || '(no output)';
    if (stop) context.shell.stopBackground(id);
    return {
      content: `Command ${id}: ${entry.command}\nStatus: ${stop ? 'stopped' : status}\n${output}`,
      summary: `${stop ? 'Stopped' : 'Checked'} background command ${id}`,
    };
  },
});
