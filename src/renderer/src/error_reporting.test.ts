import { describe, expect, it, vi } from 'vitest';
import type { RendererErrorReport } from '@shared/ipc';
import { installErrorReporting } from './error_reporting';

function setup(limit?: number) {
  const target = new EventTarget();
  const reports: RendererErrorReport[] = [];
  installErrorReporting(target, (report) => reports.push(report), limit);
  const fire = (type: string, props: Record<string, unknown>) =>
    target.dispatchEvent(Object.assign(new Event(type), props));
  return { reports, fire };
}

describe('installErrorReporting', () => {
  it('reports uncaught errors with their message and stack', () => {
    const { reports, fire } = setup();
    const error = new Error('boom');
    fire('error', { message: 'Uncaught Error: boom', error });
    expect(reports).toEqual([{ source: 'error', message: 'Uncaught Error: boom', stack: error.stack }]);
  });

  it('falls back to the thrown value when the event has no message', () => {
    const { reports, fire } = setup();
    fire('error', { message: '', error: new Error('from error') });
    fire('error', { message: '', error: 'a string was thrown' });
    expect(reports.map((report) => [report.message, report.stack === undefined])).toEqual([
      ['from error', false],
      ['a string was thrown', true],
    ]);
  });

  it('reports unhandled rejections for errors and for other values', () => {
    const { reports, fire } = setup();
    const error = new Error('rejected');
    fire('unhandledrejection', { reason: error });
    fire('unhandledrejection', { reason: 'plain reason' });
    expect(reports).toEqual([
      { source: 'unhandledrejection', message: 'rejected', stack: error.stack },
      { source: 'unhandledrejection', message: 'plain reason', stack: undefined },
    ]);
  });

  it('sends an error that repeats in a loop only once', () => {
    const { reports, fire } = setup();
    const error = new Error('again');
    for (let index = 0; index < 50; index++) fire('error', { message: 'again', error });
    expect(reports).toHaveLength(1);
  });

  it('stops after the limit', () => {
    const { reports, fire } = setup(3);
    for (let index = 0; index < 10; index++) fire('error', { message: `error ${index}`, error: undefined });
    expect(reports.map((report) => report.message)).toEqual(['error 0', 'error 1', 'error 2']);
  });

  it('does nothing until an error happens', () => {
    const report = vi.fn();
    installErrorReporting(new EventTarget(), report);
    expect(report).not.toHaveBeenCalled();
  });
});
