/**
 * csrf-guard.ts — cross-origin guard for COOKIE-authenticated, state-changing
 * dashboard API requests.
 *
 * The session cookie is SameSite=Strict, but "same-site" is not "same-origin":
 * a page on the same host at another port (e.g. http://localhost:5174 next to
 * the relay on :24420) is same-site, so the browser attaches the cookie to its
 * cross-origin `fetch(…, {method:'POST', credentials:'include'})`. A
 * `text/plain` body is a CORS "simple request" — no preflight — so without this
 * guard such a page could POST into /dashboard/api/bridge and steer Claude.
 *
 * Rules (cookie auth only — Bearer clients never carry ambient credentials):
 *   1. Safe methods (GET/HEAD/OPTIONS) pass.
 *   2. `Origin` present → must equal `http(s)://<Host>` of this request. The
 *      dashboard (and the vite dev proxy, which keeps Host) is same-origin; the
 *      shared-chat page (apps/cli/src/shared-chat-web.ts) validates its own
 *      origin and then rewrites Origin to the relay origin it proxies to.
 *   3. `Origin` absent → `Sec-Fetch-Site: same-origin` is required (browsers
 *      always send one of the two on a POST; anything else is not a browser
 *      we can trust with the cookie, and should use a Bearer key).
 *   4. Requests that may carry a body must be `Content-Type: application/json`
 *      — that forces a CORS preflight for any cross-origin browser sender.
 */

import type { IncomingMessage } from 'http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfVerdict = { ok: true } | { ok: false; status: number; error: string };

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** True when `origin` is exactly the origin of the request's own Host. */
export function isSameOrigin(req: IncomingMessage, origin: string): boolean {
  const host = header(req, 'host');
  if (!host || !/^[A-Za-z0-9.\-[\]:]{1,255}$/.test(host)) return false;
  const o = origin.trim().toLowerCase();
  const h = host.toLowerCase();
  return o === `http://${h}` || o === `https://${h}`;
}

/** Cross-origin / content-type check for a cookie-authenticated request. */
export function checkCookieRequest(req: IncomingMessage): CsrfVerdict {
  const method = (req.method ?? 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true };

  const origin = header(req, 'origin');
  if (origin !== undefined) {
    if (!isSameOrigin(req, origin)) {
      return { ok: false, status: 403, error: 'Cross-origin request rejected' };
    }
  } else if ((header(req, 'sec-fetch-site') ?? '').toLowerCase() !== 'same-origin') {
    return { ok: false, status: 403, error: 'Missing Origin on a cookie-authenticated request (use a Bearer key for non-browser clients)' };
  }

  // Only an explicit empty body (Content-Length: 0, or DELETE without one) is exempt.
  const length = header(req, 'content-length');
  const emptyBody = length === '0' || (method === 'DELETE' && length === undefined && header(req, 'transfer-encoding') === undefined);
  if (!emptyBody) {
    const type = (header(req, 'content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return { ok: false, status: 415, error: 'Content-Type must be application/json' };
    }
  }
  return { ok: true };
}
