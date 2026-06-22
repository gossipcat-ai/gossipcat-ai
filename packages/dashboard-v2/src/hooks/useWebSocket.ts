import { useEffect, useRef } from 'react';
import { connectWs, onEvent } from '@/lib/ws';
import type { DashboardEvent } from '@/lib/types';

/**
 * Subscribe to dashboard WebSocket events. The handler is stored in a ref
 * and called via a stable wrapper, so the underlying `onEvent` subscription
 * is established ONCE per mount — not on every render. Callers can pass a
 * fresh closure each render without causing subscription churn or stale-state
 * races (e.g. event arriving in the window between setState and the next
 * render). Reviewer-recommended pattern; replaces the previous `[handler]`
 * dep array that thrashed the listener.
 */
export function useWebSocket(handler: (event: DashboardEvent) => void) {
  const handlerRef = useRef(handler);
  // Mirror the latest handler into the ref on every render. Cheap; no
  // effect needed since this is a plain assignment.
  handlerRef.current = handler;

  useEffect(() => {
    connectWs();
    return onEvent((event) => handlerRef.current(event));
  }, []);
}
