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

/**
 * Opens an SSE connection to /dashboard/api/events and calls `onEvent` for each
 * message. Replays missed events using `?last_id=N` on connect.
 * Cleans up (closes EventSource) on unmount.
 */
export function useEventStream(onEvent: (e: DashboardEvent) => void): void {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') return;

    const lastId = readLastEventId();
    const es = new window.EventSource(`/dashboard/api/events?last_id=${lastId}`);

    es.onmessage = (evt: MessageEvent) => {
      try {
        const data: DashboardEvent = JSON.parse(evt.data);
        onEvent(data);
        writeLastEventId(data.id);
      } catch {
        /* malformed event — skip */
      }
    };

    return () => { es.close(); };
  // onEvent is intentionally excluded — callers should memoize it (useCallback)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
