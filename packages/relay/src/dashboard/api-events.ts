import { IncomingMessage, ServerResponse } from 'http';

export interface DashboardEventEntry {
  id: number;
  type: 'task.completed' | 'consensus.completed';
  payload: Record<string, unknown>;
  ts: string;
}

const RING_MAX = 100;
const KEEPALIVE_MS = 25_000;

let nextId = 1;
const ring: DashboardEventEntry[] = [];
const clients = new Set<ServerResponse>();

/**
 * Push a new event into the ring buffer and fan out to all connected SSE clients.
 * Called from native-tasks.ts and collect.ts after their respective completions.
 */
export function emitDashboardEvent(
  type: DashboardEventEntry['type'],
  payload: Record<string, unknown>,
): void {
  const entry: DashboardEventEntry = {
    id: nextId++,
    type,
    payload,
    ts: new Date().toISOString(),
  };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  const data = `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const res of clients) {
    try { res.write(data); } catch { /* client disconnected */ }
  }
}

/**
 * SSE endpoint handler at /dashboard/api/events.
 * Supports ?last_id=N for catch-up replay on reconnect.
 */
export function handleEventsSSE(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Replay buffered events newer than the client's last known id
  const url = req.url ?? '';
  const qIdx = url.indexOf('?');
  const search = qIdx >= 0 ? url.slice(qIdx + 1) : '';
  const lastId = parseInt(new URLSearchParams(search).get('last_id') ?? '0', 10) || 0;

  for (const entry of ring) {
    if (entry.id > lastId) {
      res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
    }
  }

  clients.add(res);

  // Keepalive comment every 25s to prevent proxy / browser connection drops
  const keepalive = setInterval(() => {
    try { res.write(':keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, KEEPALIVE_MS);
  // Unref so the timer doesn't prevent node from exiting in tests or clean shutdowns
  if (typeof keepalive === 'object' && keepalive !== null && 'unref' in keepalive) {
    (keepalive as NodeJS.Timeout).unref();
  }

  req.on('close', () => {
    clearInterval(keepalive);
    clients.delete(res);
  });
}
