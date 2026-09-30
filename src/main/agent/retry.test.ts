import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { abortableSleep, MAX_RETRIES, retryDecision } from './retry';

// Half of the jitter range, so the delay is exactly the backoff.
const middle = () => 0.5;

const status = (code: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`HTTP ${code}`), { status: code, ...extra });

describe('retryDecision: what is retried', () => {
  it.each([
    [429, 'Rate limited (429)'],
    [408, 'Request timed out (408)'],
    [500, 'Server error (500)'],
    [502, 'Server error (502)'],
    [503, 'Server error (503)'],
    [529, 'Provider overloaded (529)'],
  ])('retries HTTP %i', (code, reason) => {
    expect(retryDecision(status(code), 0, middle)).toEqual({ delayMs: 2000, reason });
  });

  it.each([400, 401, 403, 404, 413, 422])('shows HTTP %i straight away', (code) => {
    expect(retryDecision(status(code), 0, middle)).toBeNull();
  });

  it('does not retry aborts, plain errors or things that are not errors', () => {
    expect(retryDecision(new DOMException('aborted', 'AbortError'), 0, middle)).toBeNull();
    expect(retryDecision(Object.assign(new Error('x'), { name: 'APIUserAbortError' }), 0, middle)).toBeNull();
    expect(retryDecision(new Error('The model did not return a structured answer.'), 0, middle)).toBeNull();
    for (const value of [null, undefined, 'boom', 429, {}]) expect(retryDecision(value, 0, middle)).toBeNull();
  });

  it('does not retry a 429 that means the account is out of quota or credit', () => {
    expect(
      retryDecision(status(429, { code: 'insufficient_quota', message: 'You exceeded your current quota' }), 0, middle),
    ).toBeNull();
    expect(
      retryDecision(
        status(429, { error: { message: 'You have reached your specified API usage limits.' } }),
        0,
        middle,
      ),
    ).toBeNull();
  });

  it.each([
    ['a dropped connection', { code: 'ECONNRESET' }],
    ['a timeout', { code: 'ETIMEDOUT' }],
    ['a lookup that failed for now', { code: 'EAI_AGAIN' }],
    ['no network', { code: 'ENOTFOUND' }],
    ['a socket closed by the server', { code: 'UND_ERR_SOCKET' }],
    ['a code inside the cause, as fetch reports it', { message: 'fetch failed', cause: { code: 'ECONNRESET' } }],
    ['a code two causes down', { cause: { cause: { code: 'ETIMEDOUT' } } }],
    ['an SDK connection error', { name: 'APIConnectionError' }],
    ['an SDK timeout', { name: 'APIConnectionTimeoutError' }],
  ])('retries %s', (_name, props) => {
    expect(retryDecision(Object.assign(new Error('network'), props), 0, middle)).toMatchObject({ delayMs: 2000 });
  });

  it('does not retry a refused connection, which means nothing is listening', () => {
    expect(retryDecision(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), 0, middle)).toBeNull();
    expect(
      retryDecision(
        Object.assign(new Error('refused'), { name: 'APIConnectionError', cause: { code: 'ECONNREFUSED' } }),
        0,
        middle,
      ),
    ).toBeNull();
  });

  it.each([
    ['overloaded_error', { error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Provider error (overloaded)'],
    ['api_error', { error: { error: { type: 'api_error' } } }, 'Provider error (api)'],
    ['rate_limit_error', { error: { type: 'rate_limit_error' } }, 'Provider error (rate limit)'],
    ['server_error', { type: 'server_error' }, 'Provider error (server)'],
  ])('retries %s reported inside a stream', (_name, props, reason) => {
    expect(retryDecision(Object.assign(new Error('stream error'), props), 0, middle)).toEqual({
      delayMs: 2000,
      reason,
    });
  });

  it('does not retry an invalid request reported inside a stream', () => {
    expect(
      retryDecision(Object.assign(new Error('bad'), { error: { type: 'invalid_request_error' } }), 0, middle),
    ).toBeNull();
  });
});

describe('retryDecision: how long to wait', () => {
  it('doubles the wait for each retry and stops after the last one', () => {
    const delays = Array.from(
      { length: MAX_RETRIES + 1 },
      (_, attempt) => retryDecision(status(503), attempt, middle)?.delayMs ?? null,
    );
    expect(delays).toEqual([2000, 4000, 8000, 16000, null]);
  });

  it('varies the wait by up to a quarter either way', () => {
    expect(retryDecision(status(503), 1, () => 0)?.delayMs).toBe(3000);
    expect(retryDecision(status(503), 1, () => 1)?.delayMs).toBe(5000);
  });

  it('caps the backoff', () => {
    // Only reachable if MAX_RETRIES grows, so check the formula through the largest attempt that is allowed.
    const last = retryDecision(status(503), MAX_RETRIES - 1, () => 1)?.delayMs ?? 0;
    expect(last).toBeLessThanOrEqual(30_000 * 1.25);
  });

  it('waits as long as Retry-After says, in any of its forms', () => {
    const withHeaders = (headers: unknown) => retryDecision(status(429, { headers }), 0, middle)?.delayMs;
    expect(withHeaders(new Headers({ 'retry-after': '3' }))).toBe(3000);
    expect(withHeaders(new Headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(withHeaders({ 'retry-after': '7' })).toBe(7000);
    expect(withHeaders(new Headers({ 'retry-after': '0' }))).toBe(0);
    // retry-after-ms wins when both are sent.
    expect(withHeaders(new Headers({ 'retry-after-ms': '900', 'retry-after': '30' }))).toBe(900);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(withHeaders(new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:10 GMT' }))).toBe(10_000);
    vi.useRealTimers();
  });

  it('ignores a Retry-After it cannot read', () => {
    expect(retryDecision(status(429, { headers: new Headers({ 'retry-after': 'soon' }) }), 0, middle)?.delayMs).toBe(
      2000,
    );
    expect(retryDecision(status(429, { headers: 'not headers' }), 0, middle)?.delayMs).toBe(2000);
  });

  it('gives up when the provider asks for more than a minute', () => {
    expect(retryDecision(status(429, { headers: new Headers({ 'retry-after': '61' }) }), 0, middle)).toBeNull();
    expect(retryDecision(status(429, { headers: new Headers({ 'retry-after': '60' }) }), 0, middle)?.delayMs).toBe(
      60_000,
    );
  });
});

describe('retryDecision: errors from the provider SDKs', () => {
  it('reads Anthropic errors', () => {
    const rateLimited = Anthropic.APIError.generate(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } },
      'Slow down',
      new Headers({ 'retry-after': '2' }),
    );
    expect(retryDecision(rateLimited, 0, middle)).toEqual({ delayMs: 2000, reason: 'Rate limited (429)' });

    const overloaded = Anthropic.APIError.generate(
      529,
      { type: 'error', error: { type: 'overloaded_error' } },
      'Overloaded',
      new Headers(),
    );
    expect(retryDecision(overloaded, 0, middle)?.reason).toBe('Provider overloaded (529)');

    const unauthorized = Anthropic.APIError.generate(
      401,
      { type: 'error', error: { type: 'authentication_error' } },
      'Bad key',
      new Headers(),
    );
    expect(retryDecision(unauthorized, 0, middle)).toBeNull();

    expect(retryDecision(new Anthropic.APIConnectionError({ message: 'Connection error.' }), 0, middle)?.reason).toBe(
      'Connection problem',
    );
    expect(retryDecision(new Anthropic.APIConnectionTimeoutError(), 0, middle)?.reason).toBe('Request timed out');
    expect(retryDecision(new Anthropic.APIUserAbortError(), 0, middle)).toBeNull();
  });

  it('reads OpenAI errors', () => {
    const quota = OpenAI.APIError.generate(
      429,
      { code: 'insufficient_quota', message: 'You exceeded your current quota', type: 'insufficient_quota' },
      'You exceeded your current quota',
      new Headers(),
    );
    expect(retryDecision(quota, 0, middle)).toBeNull();

    const busy = OpenAI.APIError.generate(
      429,
      { code: 'rate_limit_exceeded', message: 'Rate limit reached' },
      'Rate limit reached',
      new Headers({ 'retry-after-ms': '2500' }),
    );
    expect(retryDecision(busy, 0, middle)).toEqual({ delayMs: 2500, reason: 'Rate limited (429)' });

    const down = OpenAI.APIError.generate(503, { message: 'unavailable' }, 'unavailable', new Headers());
    expect(retryDecision(down, 0, middle)?.reason).toBe('Server error (503)');

    expect(retryDecision(new OpenAI.APIConnectionError({ message: 'Connection error.' }), 0, middle)?.reason).toBe(
      'Connection problem',
    );
    expect(retryDecision(new OpenAI.APIUserAbortError(), 0, middle)).toBeNull();
  });
});

describe('retryDecision: errors sent inside a stream, built the way the SDKs build them', () => {
  it('retries an overloaded error in a Claude stream', () => {
    // As @anthropic-ai/sdk core/streaming.js does for an SSE `error` event after a 200 response.
    const body = { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } };
    const error = new Anthropic.APIError(undefined, body, undefined, new Headers(), 'overloaded_error');
    expect(retryDecision(error, 0, middle)).toEqual({ delayMs: 2000, reason: 'Provider error (overloaded)' });
  });

  it('retries an api_error in a Claude stream, and not an invalid request', () => {
    const transient = new Anthropic.APIError(
      undefined,
      { type: 'error', error: { type: 'api_error' } },
      undefined,
      new Headers(),
      'api_error',
    );
    expect(retryDecision(transient, 0, middle)?.reason).toBe('Provider error (api)');
    const invalid = new Anthropic.APIError(
      undefined,
      { type: 'error', error: { type: 'invalid_request_error' } },
      undefined,
      new Headers(),
      'invalid_request_error',
    );
    expect(retryDecision(invalid, 0, middle)).toBeNull();
  });

  it('retries a server error in an OpenAI stream', () => {
    // As openai core/streaming.js does for an SSE `error` event.
    const error = new OpenAI.APIError(
      undefined,
      { type: 'server_error', code: 'server_error', message: 'The server had an error' },
      undefined,
      new Headers(),
    );
    expect(retryDecision(error, 0, middle)?.reason).toBe('Provider error (server)');
  });

  it('does not retry an OpenAI stream error that will not pass', () => {
    const error = new OpenAI.APIError(
      undefined,
      { type: 'invalid_request_error', code: 'context_length_exceeded' },
      undefined,
      new Headers(),
    );
    expect(retryDecision(error, 0, middle)).toBeNull();
  });

  it('does not retry 501 or 505, which mean the server cannot do this at all', () => {
    expect(retryDecision(status(501), 0, middle)).toBeNull();
    expect(retryDecision(status(505), 0, middle)).toBeNull();
    expect(retryDecision(status(504), 0, middle)?.reason).toBe('Server error (504)');
  });
});

describe('abortableSleep', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves after the delay', async () => {
    vi.useFakeTimers();
    let done = false;
    const sleeping = abortableSleep(1000, new AbortController().signal).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(done).toBe(true);
  });

  it('rejects as soon as the signal aborts, without waiting out the delay', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = abortableSleep(60_000, controller.signal);
    const outcome = expect(sleeping).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1000, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
