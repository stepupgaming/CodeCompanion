import { describe, expect, it, vi } from 'vitest';
import type { AppLog } from './app_log';
import { RendererErrorReporter } from './renderer_errors';

function fakeLog() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as unknown as AppLog & {
    error: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
  };
}

describe('RendererErrorReporter', () => {
  it('logs the message and the stack from the UI as a renderer error', () => {
    const log = fakeLog();
    new RendererErrorReporter(log).report({
      source: 'error',
      message: 'x is undefined',
      stack: 'at render (app.js:1)',
    });

    expect(log.error).toHaveBeenCalledTimes(1);
    const [source, error] = log.error.mock.calls[0]!;
    expect(source).toBe('renderer');
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'RendererError', message: 'x is undefined', stack: 'at render (app.js:1)' });
  });

  it('marks unhandled rejections, and leaves out the stack when the UI sent none', () => {
    const log = fakeLog();
    new RendererErrorReporter(log).report({ source: 'unhandledrejection', message: 'failed' });

    const [, error] = log.error.mock.calls[0]!;
    expect(error.name).toBe('RendererUnhandledRejection');
    // Empty, not this file's own stack.
    expect(error.stack).toBe('');
  });

  it('ignores anything that is not a well-formed report', () => {
    const log = fakeLog();
    const reporter = new RendererErrorReporter(log);
    for (const input of [
      null,
      undefined,
      'text',
      7,
      {},
      { source: 'error' },
      { source: 'other', message: 'm' },
      { source: 'error', message: 5 },
    ]) {
      reporter.report(input);
    }
    expect(log.error).not.toHaveBeenCalled();
  });

  it('cuts oversized messages and stacks', () => {
    const log = fakeLog();
    new RendererErrorReporter(log).report({ source: 'error', message: 'm'.repeat(50_000), stack: 's'.repeat(50_000) });

    const [, error] = log.error.mock.calls[0]!;
    expect(error.message).toHaveLength(5000);
    expect(error.stack).toHaveLength(8000);
  });

  it('stops logging after the limit and says so once', () => {
    const log = fakeLog();
    const reporter = new RendererErrorReporter(log, 3);
    for (let index = 0; index < 10; index++) reporter.report({ source: 'error', message: `error ${index}` });

    expect(log.error).toHaveBeenCalledTimes(3);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('renderer', expect.stringContaining('3 UI errors'));
  });
});
