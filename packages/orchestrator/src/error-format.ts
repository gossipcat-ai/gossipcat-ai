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
 * retry (see `isRetryableTransportError`) — see llm-client.ts's fetchWithRetry503.
 */

/** Depth cap on cause-chain walking — prevents a cyclic/deep chain from looping forever. */
const MAX_CAUSE_DEPTH = 3;

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
    const val = (err as Record<string, unknown>)[key];
    if ((typeof val === 'string' || typeof val === 'number') && val !== '') {
      parts.push(`${key}=${val}`);
    }
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Describe a single level of the chain — never serializes an arbitrary object shape. */
function describeOne(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}${safeFieldsOf(err)}`;
  }
  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean') return String(err);
  if (err === null || err === undefined) return String(err);
  // Non-Error object thrown (or a cause that isn't itself an Error) — note the
  // type only. Do NOT serialize its keys: an unknown shape could carry request
  // context (headers/body) that must never reach a log or the dashboard.
  try {
    return `[non-Error value: ${Object.prototype.toString.call(err)}]`;
  } catch {
    return '[non-Error value]';
  }
}

/**
 * Recursively walk `err.cause` (and `AggregateError.errors`) up to `maxDepth`
 * levels, joining each level with " <- caused by: ". Handles non-Error throws
 * (string, object, null/undefined) without itself throwing. Safe to call on
 * any unknown value — this is meant to sit directly in a `catch (err)` block.
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
    if (typeof AggregateError !== 'undefined' && current instanceof AggregateError && Array.isArray(current.errors) && current.errors.length > 0) {
      const subErrors = current.errors.slice(0, 2).map(describeOne);
      const more = current.errors.length > 2 ? ` (+${current.errors.length - 2} more)` : '';
      segments.push(`[${current.errors.length} aggregated error(s)]: ${subErrors.join('; ')}${more}`);
    }

    current = current instanceof Error ? current.cause : undefined;
    depth++;
  }

  return segments.join(' <- caused by: ');
}

// ─── Transport-failure retry predicate ─────────────────────────────────────

/**
 * Node system-error / undici error codes that identify a socket/DNS/TLS-level
 * failure — as opposed to an HTTP response the server actually returned (which
 * must fail fast, never retried here) or a deliberate abort/cancellation.
 */
const TRANSPORT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENETUNREACH',
  'ENETDOWN', 'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
]);

function hasTransportCode(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code);
}

/**
 * True when `err` represents a socket/DNS/TLS-level transport failure that is
 * safe to retry — undici's generic "fetch failed" wrapper, or a recognized
 * system-error code, at the top level or one `cause` level down. False for:
 * anything that isn't an Error, a deliberate abort/timeout-cancellation
 * (`AbortError` / `TimeoutError`), and any error that doesn't match — in
 * particular a `new Error('OpenAI API error (4xx/5xx): ...')` or
 * `QuotaExhaustedException`, neither of which carries a transport code or the
 * bare "fetch failed" message, so an HTTP response the server actually
 * returned is never retried here.
 */
export function isRetryableTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;

  // undici's generic fetch-level wrapper — the real cause (if any) is nested
  // in err.cause, but even a bare "fetch failed" with no cause at all is a
  // transport-level failure by definition (it never got an HTTP response).
  if (err.message === 'fetch failed') return true;

  if (hasTransportCode(err)) return true;

  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && hasTransportCode(cause)) return true;

  return false;
}
