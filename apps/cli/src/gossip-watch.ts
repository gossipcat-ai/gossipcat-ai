/**
 * gossip_watch core filter logic. Extracted for unit testing.
 *
 * Design: consensus 59e6b6cc-fd9e4d27. Cursor-based pull over
 * agent-performance.jsonl. Max 24h lookback; evidence redaction at the
 * boundary to mitigate secret leakage via watcher.
 */

export const WATCH_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const WATCH_MAX_EVENTS = 500;
export const WATCH_EVIDENCE_CAP = 200;

export interface WatchResult {
  events: Array<Record<string, unknown>>;
  next_cursor: string;
  count: number;
  truncated: boolean;
}

/**
 * Filter and redact signals from a jsonl file's raw text. Returns events
 * newer than `cursor` (up to 24h old), capped at `maxEvents`, in
 * chronological order, with long `evidence` fields truncated.
 *
 * Append-only invariant: the underlying jsonl only grows at the end, so the
 * walk is back-to-front and stops at the first entry <= sinceMs. Reverse on
 * return to hand back chronological order.
 */
export function filterWatchEvents(
  rawJsonl: string,
  opts: { cursor?: string; maxEvents?: number; now?: number },
): WatchResult {
  const now = opts.now ?? Date.now();
  const cap = Math.min(opts.maxEvents ?? WATCH_MAX_EVENTS, WATCH_MAX_EVENTS);
  const floor = now - WATCH_MAX_LOOKBACK_MS;

  let sinceMs = floor;
  if (opts.cursor) {
    const parsed = Date.parse(opts.cursor);
    if (!Number.isNaN(parsed)) sinceMs = Math.max(parsed, floor);
  }

  const lines = rawJsonl.split('\n');
  const events: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line); } catch { continue; }
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    if (Number.isNaN(ts)) continue;
    if (ts <= sinceMs) break;
    if (typeof rec.evidence === 'string' && rec.evidence.length > WATCH_EVIDENCE_CAP) {
      const orig = rec.evidence as string;
      rec = { ...rec, evidence: `${orig.slice(0, WATCH_EVIDENCE_CAP)}…[truncated ${orig.length - WATCH_EVIDENCE_CAP} chars]` };
    }
    events.push(rec);
    if (events.length >= cap) { truncated = true; break; }
  }
  events.reverse();

  const lastTs = events.length > 0
    ? (events[events.length - 1].timestamp as string)
    : new Date(sinceMs).toISOString();
  return { events, next_cursor: lastTs, count: events.length, truncated };
}
