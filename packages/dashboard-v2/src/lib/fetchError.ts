/**
 * Pure error-formatting helpers for dashboard fetch diagnostics.
 * No browser-API or React dependencies — safe to import in node test environments.
 */

/**
 * Formats a raw fetch error into an actionable user-facing message that names
 * the failing endpoint. Exported for unit testing.
 *
 * Examples:
 *   formatFetchError('overview', 'API error: 500') → 'overview: HTTP 500'
 *   formatFetchError('consensus', 'Failed to fetch') → 'consensus: Failed to fetch'
 *
 * The "API error: <status>" pattern is emitted by packages/dashboard-v2/src/lib/api.ts
 * for any non-ok HTTP response. The 401 case is separately thrown as 'unauthorized'
 * (not "API error: 401"), so it passes through verbatim.
 */
export function formatFetchError(endpoint: string, rawMessage: string): string {
  const httpMatch = rawMessage.match(/^API error: (\d+)$/);
  const detail = httpMatch ? `HTTP ${httpMatch[1]}` : rawMessage;
  return `${endpoint}: ${detail}`;
}
