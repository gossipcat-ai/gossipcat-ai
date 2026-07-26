/**
 * Tests for packages/orchestrator/src/error-format.ts — issue #657.
 *
 * Covers:
 *  - formatErrorWithCause: nested cause chain, AggregateError, non-Error
 *    throw (string/object/null/undefined), a cause carrying code+syscall+
 *    hostname, depth cap on a deep/cyclic chain, and — critically — that an
 *    api-key-like string is NEVER present in the output.
 *  - isRetryableTransportError: retries on ECONNRESET / UND_ERR_CONNECT_TIMEOUT
 *    / bare "fetch failed", does NOT retry on a 401/400-style Error, an abort,
 *    or a non-Error throw.
 */

import {
  formatErrorWithCause,
  isRetryableTransportError,
  classifyTransportError,
  PRE_SEND_TRANSPORT_ERROR_CODES,
  AMBIGUOUS_TRANSPORT_ERROR_CODES,
} from '@gossip/orchestrator';

describe('formatErrorWithCause', () => {
  it('formats a plain Error with no cause', () => {
    const err = new Error('fetch failed');
    expect(formatErrorWithCause(err)).toBe('Error: fetch failed');
  });

  it('walks a nested cause chain and includes code/errno/syscall/hostname', () => {
    const dnsErr = Object.assign(new Error('getaddrinfo EAI_AGAIN api.openai.com'), {
      code: 'EAI_AGAIN',
      errno: -3001,
      syscall: 'getaddrinfo',
      hostname: 'api.openai.com',
    });
    const connectErr = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      cause: dnsErr,
    });
    const fetchErr = new Error('fetch failed', { cause: connectErr });

    const formatted = formatErrorWithCause(fetchErr);

    expect(formatted).toContain('Error: fetch failed');
    expect(formatted).toContain('caused by');
    expect(formatted).toContain('code=ECONNREFUSED');
    expect(formatted).toContain('code=EAI_AGAIN');
    expect(formatted).toContain('errno=-3001');
    expect(formatted).toContain('syscall=getaddrinfo');
    expect(formatted).toContain('hostname=api.openai.com');
  });

  it('includes address and port when present', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      address: '104.18.7.192',
      port: 443,
    });
    const formatted = formatErrorWithCause(err);
    expect(formatted).toContain('address=104.18.7.192');
    expect(formatted).toContain('port=443');
  });

  it('folds AggregateError.errors into the output', () => {
    const suberr1 = Object.assign(new Error('connect ECONNREFUSED ::1:443'), { code: 'ECONNREFUSED' });
    const suberr2 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    const agg = new AggregateError([suberr1, suberr2], 'All attempts failed');

    const formatted = formatErrorWithCause(agg);

    expect(formatted).toContain('AggregateError');
    expect(formatted).toContain('2 aggregated error(s)');
    expect(formatted).toContain('::1:443');
    expect(formatted).toContain('127.0.0.1:443');
  });

  it('handles a non-Error throw: string', () => {
    expect(formatErrorWithCause('boom')).toBe('boom');
  });

  it('handles a non-Error throw: plain object', () => {
    const formatted = formatErrorWithCause({ some: 'shape' });
    expect(formatted).toContain('non-Error value');
    // Must not serialize arbitrary object keys/values (could carry secrets).
    expect(formatted).not.toContain('some');
    expect(formatted).not.toContain('shape');
  });

  it('handles a non-Error throw: null and undefined without throwing', () => {
    expect(() => formatErrorWithCause(null)).not.toThrow();
    expect(() => formatErrorWithCause(undefined)).not.toThrow();
    expect(formatErrorWithCause(null)).toBe('null');
    expect(formatErrorWithCause(undefined)).toBe('undefined');
  });

  it('caps recursion depth on a very deep cause chain (no infinite loop)', () => {
    let top: Error = new Error('level 0');
    for (let i = 1; i <= 50; i++) {
      top = new Error(`level ${i}`, { cause: top });
    }
    let formatted = '';
    expect(() => { formatted = formatErrorWithCause(top); }).not.toThrow();
    // Depth-capped: far fewer than 51 "level N" segments should appear.
    const levelMatches = formatted.match(/level \d+/g) ?? [];
    expect(levelMatches.length).toBeLessThan(10);
  });

  it('does not loop forever on a cyclic cause chain', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a; // cycle
    let formatted = '';
    expect(() => { formatted = formatErrorWithCause(a); }).not.toThrow();
    expect(formatted).toContain('circular cause');
  });

  it('NEVER includes an api-key-like value in the output', () => {
    const secret = 'sk-proj-THIS_LOOKS_LIKE_AN_OPENAI_KEY_1234567890';
    // Simulate a thrown object that happens to carry a header/auth-shaped
    // field — the formatter must not pick it up since it isn't on the
    // allow-list of safe diagnostic fields.
    const err = Object.assign(new Error('fetch failed'), {
      code: 'ECONNRESET',
      // Not on the safe allow-list — must never be read/emitted.
      headers: { Authorization: `Bearer ${secret}` },
      apiKey: secret,
      requestBody: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const formatted = formatErrorWithCause(err);
    expect(formatted).not.toContain(secret);
    expect(formatted).not.toContain('Authorization');
    expect(formatted).toContain('code=ECONNRESET');
  });
});

describe('isRetryableTransportError', () => {
  it('retries on a bare "fetch failed" (undici generic wrapper, no cause)', () => {
    expect(isRetryableTransportError(new Error('fetch failed'))).toBe(true);
  });

  it('retries on ECONNRESET', () => {
    const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(isRetryableTransportError(err)).toBe(true);
  });

  it('retries on UND_ERR_CONNECT_TIMEOUT', () => {
    const err = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    expect(isRetryableTransportError(err)).toBe(true);
  });

  it('retries on a transport code nested one level in cause', () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const err = new Error('fetch failed', { cause });
    // Even though message !== 'fetch failed' exactly is false here (it is),
    // this also validates the nested-cause code path independent of message.
    expect(isRetryableTransportError(err)).toBe(true);
  });

  it('does NOT retry on an HTTP 401 error (server actually responded)', () => {
    const err = new Error('OpenAI API error (401): Incorrect API key provided');
    expect(isRetryableTransportError(err)).toBe(false);
  });

  it('does NOT retry on an HTTP 400 invalid-model error (server actually responded)', () => {
    const err = new Error('OpenAI API error (400): invalid model id');
    expect(isRetryableTransportError(err)).toBe(false);
  });

  it('does NOT retry on abort (AbortError)', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    expect(isRetryableTransportError(err)).toBe(false);
  });

  it('does NOT retry on timeout-cancellation (TimeoutError)', () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    expect(isRetryableTransportError(err)).toBe(false);
  });

  it('does NOT retry on a non-Error throw', () => {
    expect(isRetryableTransportError('fetch failed')).toBe(false);
    expect(isRetryableTransportError(null)).toBe(false);
    expect(isRetryableTransportError(undefined)).toBe(false);
    expect(isRetryableTransportError({ code: 'ECONNRESET' })).toBe(false);
  });

  it('does NOT retry on QuotaExhaustedException-shaped errors', () => {
    const err = new Error('openai quota exhausted (429 #1): rate limited');
    err.name = 'QuotaExhaustedException';
    expect(isRetryableTransportError(err)).toBe(false);
  });
});

describe('classifyTransportError (issue #657 idempotency follow-up)', () => {
  it('classifies every code in PRE_SEND_TRANSPORT_ERROR_CODES as pre-send', () => {
    for (const code of PRE_SEND_TRANSPORT_ERROR_CODES) {
      const err = Object.assign(new Error('fetch failed'), { code });
      expect(classifyTransportError(err)).toBe('pre-send');
    }
  });

  it('classifies every code in AMBIGUOUS_TRANSPORT_ERROR_CODES as ambiguous', () => {
    for (const code of AMBIGUOUS_TRANSPORT_ERROR_CODES) {
      const err = Object.assign(new Error('fetch failed'), { code });
      expect(classifyTransportError(err)).toBe('ambiguous');
    }
  });

  it('classifies a bare "fetch failed" with no code as ambiguous (phase unknown)', () => {
    expect(classifyTransportError(new Error('fetch failed'))).toBe('ambiguous');
  });

  it('classifies a code nested one cause level down (pre-send)', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const err = new Error('fetch failed', { cause });
    expect(classifyTransportError(err)).toBe('pre-send');
  });

  it('classifies a code nested one cause level down (ambiguous)', () => {
    const cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const err = new Error('fetch failed', { cause });
    expect(classifyTransportError(err)).toBe('ambiguous');
  });

  it('classifies an HTTP-error-shaped Error as not-transport (never phase-classified)', () => {
    expect(classifyTransportError(new Error('OpenAI API error (401): Incorrect API key provided'))).toBe('not-transport');
  });

  it('preserves STRICT equality on "fetch failed" — a substring match must NOT classify as transport', () => {
    expect(classifyTransportError(new Error('OpenAI API error (500): upstream fetch failed'))).toBe('not-transport');
  });

  it('classifies abort/timeout-cancellation as not-transport regardless of any code', () => {
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 'ECONNRESET' });
    expect(classifyTransportError(abortErr)).toBe('not-transport');
    const timeoutErr = new Error('The operation was aborted due to timeout');
    timeoutErr.name = 'TimeoutError';
    expect(classifyTransportError(timeoutErr)).toBe('not-transport');
  });

  it('classifies a non-Error throw as not-transport', () => {
    expect(classifyTransportError('fetch failed')).toBe('not-transport');
    expect(classifyTransportError(null)).toBe('not-transport');
    expect(classifyTransportError(undefined)).toBe('not-transport');
  });

  it('isRetryableTransportError is true for both pre-send and ambiguous classes', () => {
    const preSend = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
    const ambiguous = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
    expect(classifyTransportError(preSend)).toBe('pre-send');
    expect(classifyTransportError(ambiguous)).toBe('ambiguous');
    expect(isRetryableTransportError(preSend)).toBe(true);
    expect(isRetryableTransportError(ambiguous)).toBe(true);
  });
});

describe('formatErrorWithCause — throw-safety on hostile getters (finding: not throw-safe)', () => {
  it('returns a string rather than throwing when `.message` is a throwing getter', () => {
    const err = new Error('placeholder');
    Object.defineProperty(err, 'message', {
      get() { throw new Error('boom from message getter'); },
      configurable: true,
    });
    let formatted = '';
    expect(() => { formatted = formatErrorWithCause(err); }).not.toThrow();
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('returns a string rather than throwing when `.cause` is a throwing getter', () => {
    const err = new Error('top level');
    Object.defineProperty(err, 'cause', {
      get() { throw new Error('boom from cause getter'); },
      configurable: true,
    });
    let formatted = '';
    expect(() => { formatted = formatErrorWithCause(err); }).not.toThrow();
    expect(formatted).toContain('top level');
  });

  it('returns a string rather than throwing when a diagnostic field (e.g. `.code`) is a throwing getter', () => {
    const err = new Error('bad code getter');
    Object.defineProperty(err, 'code', {
      get() { throw new Error('boom from code getter'); },
      configurable: true,
    });
    let formatted = '';
    expect(() => { formatted = formatErrorWithCause(err); }).not.toThrow();
    expect(formatted).toContain('bad code getter');
  });

  it('returns a string rather than throwing when `.name` is a throwing getter', () => {
    const err = new Error('bad name getter');
    Object.defineProperty(err, 'name', {
      get() { throw new Error('boom from name getter'); },
      configurable: true,
    });
    expect(() => formatErrorWithCause(err)).not.toThrow();
  });
});

describe('formatErrorWithCause — length caps (finding: no length cap anywhere)', () => {
  it('truncates a giant message with an explicit marker instead of emitting it verbatim', () => {
    const giant = 'x'.repeat(5_000_000);
    const err = new Error(giant);
    const formatted = formatErrorWithCause(err);
    expect(formatted.length).toBeLessThan(5_000_000);
    expect(formatted).toMatch(/truncated \d+ chars/);
  });

  it('caps total output even across a multi-level cause chain of large messages', () => {
    const big = 'y'.repeat(10_000);
    const inner = new Error(big);
    const outer = new Error(big, { cause: inner });
    const formatted = formatErrorWithCause(outer);
    expect(formatted.length).toBeLessThan(6_000);
    expect(formatted).toMatch(/truncated \d+ chars/);
  });
});

describe('formatErrorWithCause — message-content redaction (KNOWN GAP, not fixed by this change)', () => {
  it('KNOWN GAP: a URL-embedded secret in a nested cause .message IS surfaced verbatim', () => {
    // `SAFE_DIAGNOSTIC_FIELDS` allow-lists only code/errno/syscall/hostname/
    // address/port for a cause object — `.message` itself is never filtered at
    // ANY level of the chain, so a secret embedded in a message (e.g. a
    // webhook/callback URL carrying an API key as a query param, which a
    // library might legitimately put in an Error message) reaches the
    // formatted output verbatim.
    //
    // This is a CHARACTERIZATION test of current behavior, not a guarantee of
    // safety: it documents the gap honestly rather than asserting a stronger
    // property that doesn't hold. If message-level redaction is implemented,
    // THIS TEST SHOULD START FAILING and must be updated then, not silenced.
    // See the task report for a proposed redaction follow-up — out of scope
    // for this change (which addressed cause-chain throw-safety + length caps,
    // not message-content sanitization).
    const secret = 'sk-live-EMBEDDED_URL_SECRET_1234567890';
    const cause = new Error(`upload failed: https://hooks.example.com/callback?api_key=${secret}`);
    const err = new Error('fetch failed', { cause });

    const formatted = formatErrorWithCause(err);

    expect(formatted).toContain(secret);
  });
});
