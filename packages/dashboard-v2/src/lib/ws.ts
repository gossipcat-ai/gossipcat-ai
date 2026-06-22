import type { DashboardEvent } from './types';

type Listener = (event: DashboardEvent) => void;

let ws: WebSocket | null = null;
let reconnectDelay = 3000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

export function connectWs(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/dashboard/ws`);

  ws.onopen = () => {
    reconnectDelay = 3000; // reset on successful connection
  };

  ws.onmessage = (e) => {
    try {
      const event: DashboardEvent = JSON.parse(e.data);
      listeners.forEach((fn) => fn(event));
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    ws = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // backoff up to 30s
      connectWs();
    }, reconnectDelay);
  };

  ws.onerror = () => {
    // onerror is always followed by onclose, so just let onclose handle reconnect
  };
}

export function disconnectWs(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onclose = null; // prevent reconnect
    ws.close();
    ws = null;
  }
}

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getWsState(): number {
  return ws?.readyState ?? WebSocket.CLOSED;
}
