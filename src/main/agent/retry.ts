// Decides whether a failed model request is worth repeating, and how long to wait first. Works on what the provider
// SDKs put on their errors (status, headers, error body, cause) rather than on their classes, so it covers Anthropic,
// OpenAI and OpenAI-compatible endpoints alike.

// Tries after the first: 4 retries wait about 2, 4, 8 and 16 seconds.
export const MAX_RETRIES = 4;
const BASE_DELAY_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
// A provider asking for a longer pause than this is not going to recover soon enough to be worth waiting for.
const MAX_RETRY_AFTER_MS = 60_000;

// Connection problems that usually pass. A refused connection (nothing listening, e.g. Ollama not started) does not.
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

// Errors sent inside a stream, where there is no HTTP status any more.
const TRANSIENT_ERROR_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error', 'server_error']);

// A 429 that means the account is out of quota or credit is not going to pass by waiting.
const QUOTA_PATTERN = /insufficient_quota|exceeded your current quota|usage limits|credit balance|billing/i;

export interface RetryDecision {
  delayMs: number;
  // Short and free of request content, shown to the user: "Rate limited (429)".
  reason: string;
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  code?: unknown;
  type?: unknown;
  headers?: unknown;
  error?: unknown;
  cause?: unknown;
}

// `attempt` counts the retries already made (0 before the first retry). Returns null when the error should be shown.
export function retryDecision(
  error: unknown,
  attempt: number,
  random: () => number = Math.random,
): RetryDecision | null {
  if (attempt >= MAX_RETRIES || !isObject(error)) return null;
  if (kind(error) === 'AbortError' || kind(error) === 'APIUserAbortError') return null;

  const reason = transientReason(error);
  if (!reason) return null;

  const requested = retryAfterMs(error);
  if (requested !== null && requested > MAX_RETRY_AFTER_MS) return null;
  const backoff = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * 2 ** attempt) * (0.75 + random() * 0.5);
  return { delayMs: Math.round(requested ?? backoff), reason };
}

function transientReason(error: ErrorLike): string | null {
  const status = typeof error.status === 'number' ? error.status : null;
  if (status !== null) {
    if (status === 429) return QUOTA_PATTERN.test(errorText(error)) ? null : 'Rate limited (429)';
    if (status === 408) return 'Request timed out (408)';
    if (status === 529) return 'Provider overloaded (529)';
    // 501 (not implemented) and 505 (HTTP version not supported) mean the server cannot do this at all.
    if (status === 501 || status === 505) return null;
    if (status >= 500 && status < 600) return `Server error (${status})`;
    return null;
  }

  const streamed = streamedErrorType(error);
  if (streamed && TRANSIENT_ERROR_TYPES.has(streamed)) {
    return streamed === 'rate_limit_error' && QUOTA_PATTERN.test(errorText(error))
      ? null
      : `Provider error (${streamed.replace(/_error$/, '').replace(/_/g, ' ')})`;
  }

  if (kind(error) === 'APIConnectionTimeoutError') return 'Request timed out';
  const code = networkCode(error);
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return `Connection problem (${code})`;
  if (kind(error) === 'APIConnectionError' && code !== 'ECONNREFUSED') return 'Connection problem';
  return null;
}

// The provider SDKs leave `name` as "Error" on their error classes, so the class name is what tells them apart.
function kind(error: ErrorLike): string | null {
  if (typeof error.name === 'string' && error.name !== 'Error') return error.name;
  const constructorName = (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof constructorName === 'string' ? constructorName : null;
}

// An error event sent inside a stream. The Anthropic SDK turns it into an APIError whose body is the event,
// { type: 'error', error: { type: 'overloaded_error' } }, and whose own `type` is the inner type; OpenAI's carries a
// `code` such as 'server_error'. The generic outer type 'error' says nothing, so the most specific value wins.
function streamedErrorType(error: ErrorLike): string | null {
  const candidates = [
    isObject(error.error) && isObject(error.error.error) ? error.error.error.type : undefined,
    isObject(error.error) && isObject(error.error.error) ? error.error.error.code : undefined,
    isObject(error.error) ? error.error.type : undefined,
    isObject(error.error) ? error.error.code : undefined,
    error.type,
    typeof error.status === 'number' ? undefined : error.code,
  ];
  const specific = candidates.filter((value): value is string => typeof value === 'string' && value !== 'error');
  return specific.find((value) => TRANSIENT_ERROR_TYPES.has(value)) ?? specific[0] ?? null;
}

function networkCode(error: ErrorLike): string | null {
  // fetch failures carry the real error one or two levels down: TypeError('fetch failed', { cause: { code } }).
  let current: unknown = error;
  for (let depth = 0; isObject(current) && depth < 4; depth++) {
    if (typeof current.code === 'string') return current.code;
    current = current.cause;
  }
  return null;
}

function errorText(error: ErrorLike): string {
  const parts = [error.message, error.code, isObject(error.error) ? JSON.stringify(error.error) : error.error];
  return parts.filter((part) => typeof part === 'string').join(' ');
}

// Retry-After (seconds or a date) or the non-standard retry-after-ms that OpenAI sends.
function retryAfterMs(error: ErrorLike): number | null {
  const millis = header(error, 'retry-after-ms');
  if (millis !== null && Number.isFinite(Number(millis)) && Number(millis) >= 0) return Number(millis);

  const value = header(error, 'retry-after');
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function header(error: ErrorLike, name: string): string | null {
  const headers = error.headers;
  if (!isObject(headers)) return null;
  const value =
    typeof headers.get === 'function' ? (headers.get as (key: string) => unknown).call(headers, name) : headers[name];
  return typeof value === 'string' && value !== '' ? value : null;
}

function isObject(value: unknown): value is ErrorLike & Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Waits `ms`, rejecting with an AbortError as soon as the signal aborts so a stop is not held up by a backoff.
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}
