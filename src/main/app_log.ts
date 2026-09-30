import { JsonlLog } from './storage/jsonl_log';

const MAX_MESSAGE = 2000;
const MAX_STACK = 4000;

// Keys and tokens that could end up in an error message, e.g. a provider echoing a request header.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]'],
  [/\b(gsk_|xai-)[A-Za-z0-9_-]{8,}/g, '$1[redacted]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(x-api-key|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi, '$1$2[redacted]'],
];

export type LogLevel = 'error' | 'warn' | 'info';

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit} more characters)` : text;
}

// Local log of crashes and other problems (`logs/app.log.jsonl` in the user data folder). Entries hold what went wrong
// and where, never chat history or API keys (messages can still mention a path), and the file is never sent anywhere. Until a file is set
// (the user data folder is only known once the app starts) entries are dropped.
export class AppLog {
  private readonly log = new JsonlLog(null);

  setFile(file: string | null): void {
    this.log.setFile(file);
  }

  error(source: string, problem: unknown, context?: Record<string, string | number | boolean | null>): void {
    this.write('error', source, problem, context);
  }

  warn(source: string, problem: unknown, context?: Record<string, string | number | boolean | null>): void {
    this.write('warn', source, problem, context);
  }

  info(source: string, message: string, context?: Record<string, string | number | boolean | null>): void {
    this.write('info', source, message, context);
  }

  private write(level: LogLevel, source: string, problem: unknown, context?: Record<string, unknown>): void {
    const error = problem instanceof Error ? problem : null;
    const message = error
      ? `${error.name}: ${error.message}`
      : typeof problem === 'string'
        ? problem
        : safeString(problem);
    this.log.append({
      level,
      source,
      message: clip(redact(message), MAX_MESSAGE),
      ...(error?.stack ? { stack: clip(redact(error.stack), MAX_STACK) } : {}),
      ...(context ? { context } : {}),
    });
  }
}

function safeString(value: unknown): string {
  try {
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  } catch {
    return String(value);
  }
}

export const appLog = new AppLog();
