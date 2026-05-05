import { useEffect } from 'react';

// Minimal window surface needed — avoids importing full lib.dom in node test environments.
declare const window: {
  EventSource: typeof EventSource;
  localStorage: { getItem(k: string): string | null; setItem(k: string, v: string): void };
} | undefined;

export interface DashboardEvent {
  id: number;
  type: 'task.completed' | 'consensus.completed';
  payload: Record<string, unknown>;
  ts: string;
}

const LS_KEY = 'dashboard:lastEventId';

/** Read persisted last-seen event id from localStorage (default 0). */
export function readLastEventId(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(LS_KEY);
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Persist last-seen event id to localStorage. */
export function writeLastEventId(id: number): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LS_KEY, String(id));
}

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 5_000;

/**
 * Opens an SSE connection to /dashboard/api/events and calls `onEvent` for each
 * message. Replays missed events using `?last_id=N` on connect.
 * Cleans up (closes EventSource) on unmount.
 *
 * Uses manual reconnect (close + setTimeout) instead of relying on native
 * EventSource auto-reconnect so that the persisted last_id is re-read on each
 * reconnect attempt — native auto-reconnect snapshots the URL at construction
 * time and would replay from the original last_id forever.
 */
export function useEventStream(onEvent: (e: DashboardEvent) => void): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;

    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = BACKOFF_MIN_MS;
    let destroyed = false;

    function open(): void {
      if (destroyed) return;
      const lastId = readLastEventId();
      es = new window!.EventSource(`/dashboard/api/events?last_id=${lastId}`);

      es.onmessage = (evt: MessageEvent) => {
        try {
          const data: DashboardEvent = JSON.parse(evt.data);
          onEvent(data);
          writeLastEventId(data.id);
          backoff = BACKOFF_MIN_MS; // reset on successful message
        } catch {
          /* malformed event — skip */
        }
      };

      es.onerror = () => {
        if (es) { es.close(); es = null; }
        if (destroyed) return;
        retryTimer = setTimeout(() => { open(); }, backoff);
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      };
    }

    open();

    return () => {
      destroyed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (es) { es.close(); es = null; }
    };
  // onEvent is intentionally excluded — callers should memoize it (useCallback)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
