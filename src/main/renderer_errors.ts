import type { AppLog } from './app_log';

const MAX_MESSAGE = 5000;
const MAX_STACK = 8000;

// Writes errors reported by the sandboxed UI to the app log. The UI is not trusted, so the payload is validated,
// cut to a fixed length and capped in number, so a page stuck in an error loop cannot flood the log.
export class RendererErrorReporter {
  private count = 0;

  constructor(
    private readonly log: AppLog,
    private readonly limit = 100,
  ) {}

  report(input: unknown): void {
    if (typeof input !== 'object' || input === null) return;
    const { source, message, stack } = input as Record<string, unknown>;
    if ((source !== 'error' && source !== 'unhandledrejection') || typeof message !== 'string') return;
    if (this.count >= this.limit) return;
    this.count++;

    const error = new Error(message.slice(0, MAX_MESSAGE));
    error.name = source === 'error' ? 'RendererError' : 'RendererUnhandledRejection';
    // Without a stack from the UI, an empty one keeps this file's own stack out of the log.
    error.stack = typeof stack === 'string' ? stack.slice(0, MAX_STACK) : '';
    this.log.error('renderer', error);
    if (this.count === this.limit)
      this.log.warn('renderer', `Reached ${this.limit} UI errors; later ones are not logged.`);
  }
}
