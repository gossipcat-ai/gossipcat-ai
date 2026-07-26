/**
 * Format an unknown thrown value into a diagnostic string that includes the
 * `cause` chain — undici (Node's global `fetch`) wraps the real OS/TLS/DNS
 * error in `error.cause` and leaves only the generic string "fetch failed" in
 * `error.message`. Left unhandled, that discards the ONLY information that
 * identifies the failure class (ECONNRESET, ETIMEDOUT, ENETUNREACH,
 * UND_ERR_CONNECT_TIMEOUT, EAI_AGAIN, CERT_HAS_EXPIRED, ...), which is exactly
 * why issue #657 ("fetch failed" with no further detail) was undiagnosable.
 *
 * Also classifies which of those failures are worth a bounded transport-level
 * retry (see `isRetryableTransportError` / `classifyTransportError`) — see
 * llm-client.ts's fetchWithRetry503.
 */

/** Depth cap on cause-chain walking — prevents a cyclic/deep chain from looping forever. */
const MAX_CAUSE_DEPTH = 3;

/**
 * Per-segment and total-output length caps. `describeOne` interpolates
 * `err.message` verbatim, and message strings are attacker/upstream-controlled
 * (e.g. `llm-client.ts`'s `LLM returned no choices: ${JSON.stringify(data)}`
 * embeds an entire provider response with no cap). Without a cap here, a
 * multi-megabyte message reaches the log line and the dashboard ERROR payload
 * verbatim. Mirrors the existing 200-char provider-body truncation convention
 * used at the HTTP-response boundary (llm-client.ts's `res.text()).slice(0, 200)`
 * call sites) but sized a little more generously since this formatter carries
 * a full cause chain, not a single response body.
 */
const MAX_SEGMENT_CHARS = 500;
const MAX_TOTAL_CHARS = 4000;

function truncate(str: string, maxChars: number): string {
  if (str.length <= maxChars) return str;
  const removed = str.length - maxChars;
  return `${str.slice(0, maxChars)}… [truncated ${removed} chars]`;
}

/**
 * Read a property that MIGHT be a throwing getter without letting the read
 * itself escape. `formatErrorWithCause`'s docstring promises it never throws
 * — a hostile/buggy `Error` subclass with a throwing `message`/`cause`/`name`
 * getter must not be able to violate that from a plain property read.
 */
function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Diagnostic fields worth surfacing from a Node system error (or a nested
 * cause). Deliberately a small allow-list: request body, headers, and any
 * Authorization/api-key value must NEVER appear here. If a field isn't on
 * this list it is not read at all, string or not.
 */
const SAFE_DIAGNOSTIC_FIELDS = ['code', 'errno', 'syscall', 'hostname', 'address', 'port'] as const;

function safeFieldsOf(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const parts: string[] = [];
  for (const key of SAFE_DIAGNOSTIC_FIELDS) {
    const val = safeRead(() => (err as Record<string, unknown>)[key], undefined);
    if ((typeof val === 'string' || typeof val === 'number') && val !== '') {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * Describe a single level of the chain — never serializes an arbitrary object
 * shape, never throws (every property read that could be a user-defined
 * getter is wrapped via `safeRead`), and never returns an unbounded string
 * (capped at `MAX_SEGMENT_CHARS`).
 */
function describeOne(err: unknown): string {
  let result: string;
  if (err instanceof Error) {
    const name = safeRead(() => err.name, 'Error');
    const rawMessage = safeRead(() => err.message, '[unreadable message]');
    const message = typeof rawMessage === 'string' ? rawMessage : safeRead(() => String(rawMessage), '[unreadable message]');
    result = `${name}: ${message}${safeFieldsOf(err)}`;
  } else if (typeof err === 'string') {
    result = err;
  } else if (typeof err === 'number' || typeof err === 'boolean') {
    result = String(err);
  } else if (err === null || err === undefined) {
    result = String(err);
  } else {
    // Non-Error object thrown (or a cause that isn't itself an Error) — note
    // the type only. Do NOT serialize its keys: an unknown shape could carry
    // request context (headers/body) that must never reach a log or the
    // dashboard.
    result = safeRead(() => `[non-Error value: ${Object.prototype.toString.call(err)}]`, '[non-Error value]');
  }
  return truncate(result, MAX_SEGMENT_CHARS);
}

/**
 * Recursively walk `err.cause` (and `AggregateError.errors`) up to `maxDepth`
 * levels, joining each level with " <- caused by: ". Handles non-Error throws
 * (string, object, null/undefined) without itself throwing. Safe to call on
 * any unknown value — this is meant to sit directly in a `catch (err)` block.
 *
 * Throw-safety: every property read on the (untrusted) error object — `.cause`,
 * `.errors` (AggregateError), `.message`/`.name` (in `describeOne`) — goes
 * through `safeRead` so a throwing getter degrades to a placeholder instead of
 * escaping this function. This function sits in the OUTERMOST catch of
 * worker-agent.ts's `executeTask` — if it throws, the task's ERROR event never
 * fires and the failure becomes an unhandled rejection instead of a reported
 * one, which is strictly worse than the pre-formatter behavior.
 */
export function formatErrorWithCause(err: unknown, maxDepth: number = MAX_CAUSE_DEPTH): string {
  // A direct null/undefined throw has no cause chain to walk — describe it
  // directly rather than falling into the loop (which only walks non-nullish
  // `current` and would otherwise silently produce an empty string).
  if (err === null || err === undefined) return String(err);

  const segments: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let depth = 0;

  while (current !== undefined && current !== null && depth <= maxDepth) {
    if (seen.has(current)) {
      segments.push('[circular cause — truncated]');
      break;
    }
    seen.add(current);
    segments.push(describeOne(current));

    // undici can throw an AggregateError when multiple connection attempts
    // fail (e.g. dual-stack). Fold in a couple of the aggregated sub-errors so
    // the real failure isn't hidden behind the bare "AggregateError" name.
    if (typeof AggregateError !== 'undefined' && current instanceof AggregateError) {
      const aggErr = current;
      const errorsList = safeRead(() => aggErr.errors, undefined);
      if (Array.isArray(errorsList) && errorsList.length > 0) {
        const subErrors = errorsList.slice(0, 2).map(describeOne);
        const more = errorsList.length > 2 ? ` (+${errorsList.length - 2} more)` : '';
        segments.push(truncate(`[${errorsList.length} aggregated error(s)]: ${subErrors.join('; ')}${more}`, MAX_SEGMENT_CHARS));
      }
    }

    const currentErr = current instanceof Error ? current : undefined;
    current = currentErr ? safeRead(() => currentErr.cause, undefined) : undefined;
    depth++;
  }

  return truncate(segments.join(' <- caused by: '), MAX_TOTAL_CHARS);
}

// ─── Transport-failure retry predicate ─────────────────────────────────────
//
// The retryable transport-error set is split by PHASE, not just "was this a
// socket/DNS/TLS-level failure" — because that alone doesn't say whether the
// request ever reached the server. A blind retry on an error that occurred
// AFTER the origin received (and possibly billed/executed) the request risks
// silently re-issuing an already-completed call. See issue #657 follow-up.

/**
 * Connect/DNS-phase error codes: these prove the TCP connection was never
 * established (DNS never resolved, the OS refused/couldn't route the
 * connection, or undici's own connect-phase timeout fired). The request body
 * was never sent, so a retry can never double-execute anything — unconditionally
 * safe to retry regardless of whether an idempotency key was sent.
 */
export const PRE_SEND_TRANSPORT_ERROR_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH',
]);

/**
 * Ambiguous-phase error codes: the failure surfaced AFTER a connection existed
 * (or in a state where whether the server received/processed the request
 * cannot be determined from the code alone) — e.g. a reset/timeout while
 * headers or body were in flight. A slow-but-successful origin call can look
 * exactly like this. Retrying blind risks double-billing/double-executing a
 * request the server already completed, so these are retryable ONLY when the
 * caller attached an idempotency key the origin can use to dedupe (see
 * `classifyTransportError` / llm-client.ts's `fetchWithRetry503`).
 *
 * Any transport-shaped code NOT in `PRE_SEND_TRANSPORT_ERROR_CODES` defaults
 * here (deny-by-default): ECONNABORTED / ENETDOWN / EPIPE / UND_ERR_BODY_TIMEOUT
 * / UND_ERR_DESTROYED / UND_ERR_CLOSED are not proven pre-send by their code
 * alone, so they're treated as ambiguous rather than assumed safe.
 */
export const AMBIGUOUS_TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'ECONNABORTED', 'ENETDOWN', 'EPIPE', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
]);

export type TransportErrorClass = 'pre-send' | 'ambiguous' | 'not-transport';

function classifyCode(code: unknown): TransportErrorClass | undefined {
  if (typeof code !== 'string') return undefined;
  if (PRE_SEND_TRANSPORT_ERROR_CODES.has(code)) return 'pre-send';
  if (AMBIGUOUS_TRANSPORT_ERROR_CODES.has(code)) return 'ambiguous';
  return undefined;
}

function codeOf(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
}

/**
 * Classify `err` for the bounded transport retry in llm-client.ts's
 * `fetchWithRetry503`:
 *  - `'pre-send'`  — proven to have never reached the server; always safe to retry.
 *  - `'ambiguous'` — transport-shaped, but whether the server processed the
 *    request is unknown; safe to retry ONLY when an idempotency key was sent.
 *  - `'not-transport'` — an HTTP response the server actually returned
 *    (4xx/5xx), a deliberate abort/timeout-cancellation, or anything else —
 *    never retried here.
 *
 * Looks at the top-level error code, then one `cause` level down (undici
 * commonly wraps the real OS error in `.cause`), then falls back to a bare
 * "fetch failed" message (STRICT equality — not a substring test, so
 * `'OpenAI API error (500): upstream fetch failed'` correctly classifies as
 * `'not-transport'`) — that bare wrapper carries no code at all, so it can't
 * be phase-classified and is treated as `'ambiguous'`.
 */
export function classifyTransportError(err: unknown): TransportErrorClass {
  if (!(err instanceof Error)) return 'not-transport';
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'not-transport';

  const topClass = classifyCode(codeOf(err));
  if (topClass) return topClass;

  const cause = (err as Error & { cause?: unknown }).cause;
  const causeClass = classifyCode(codeOf(cause));
  if (causeClass) return causeClass;

  if (err.message === 'fetch failed') return 'ambiguous';

  return 'not-transport';
}

/**
 * True when `err` represents a socket/DNS/TLS-level transport failure worth a
 * bounded retry (either phase — pre-send or ambiguous). Kept for existing
 * callers/tests; prefer `classifyTransportError` where the pre-send/ambiguous
 * distinction matters (idempotency-gated retry).
 */
export function isRetryableTransportError(err: unknown): boolean {
  return classifyTransportError(err) !== 'not-transport';
}
