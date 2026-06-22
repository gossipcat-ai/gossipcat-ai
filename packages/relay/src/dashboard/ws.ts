import { WebSocket } from 'ws';
import { existsSync, statSync, createReadStream } from 'fs';
import { watch, type FSWatcher } from 'fs';
import { join } from 'path';

export interface DashboardEvent {
  type: 'task_dispatched' | 'task_completed' | 'task_failed'
      | 'consensus_started' | 'consensus_complete'
      | 'skill_changed' | 'agent_connected' | 'agent_disconnected'
      | 'log_lines';
  timestamp: string;
  data: Record<string, unknown>;
}

export class DashboardWs {
  private clients: Set<WebSocket> = new Set();
  private logWatcher: FSWatcher | null = null;
  private logOffset = 0;
  private logPath = '';
  private logReading = false;
  private logCarry = '';
  private logCapped = false; // true when last read started mid-file (64KB cap)

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  getClients(): Set<WebSocket> {
    return this.clients;
  }

  /** Start watching mcp.log for new lines and broadcasting them to connected clients. */
  startLogWatcher(projectRoot: string): void {
    // Idempotent: close any existing watcher before starting a new one.
    this.stopLogWatcher();

    this.logPath = join(projectRoot, '.gossip', 'mcp.log');
    if (!existsSync(this.logPath)) return;

    // Start from current end of file
    try { this.logOffset = statSync(this.logPath).size; } catch { this.logOffset = 0; }

    try {
      this.logWatcher = watch(this.logPath, () => {
        if (this.clients.size === 0) return; // no one listening
        this.readNewLines();
      });
    } catch { /* watch not supported or file gone */ }
  }

  stopLogWatcher(): void {
    if (this.logWatcher) {
      this.logWatcher.close();
      this.logWatcher = null;
    }
  }

  private readNewLines(): void {
    // Re-entrancy guard: if a stream read is already in flight, skip this tick.
    if (this.logReading) return;
    this.logReading = true;

    try {
      const currentSize = statSync(this.logPath).size;

      if (currentSize < this.logOffset) {
        // File was rotated/truncated — reset and re-read from start.
        this.logOffset = 0;
        this.logCarry = '';
      }

      if (currentSize === this.logOffset) {
        this.logReading = false;
        return;
      }

      // Cap read to 64KB per poll to avoid flooding clients.
      // When capping, discard logCarry (skipped bytes break continuity) and set logCapped
      // so the end callback knows to drop the first partial line.
      const capped = currentSize - this.logOffset > 65536;
      const readFrom = capped
        ? (this.logCarry = '', this.logCapped = true, currentSize - 65536)
        : (this.logCapped = false, this.logOffset);

      let stream;
      try {
        stream = createReadStream(this.logPath, { start: readFrom, end: currentSize - 1 });
      } catch {
        // createReadStream can throw synchronously (e.g. ENOMEM). Clear guard before returning.
        this.logReading = false;
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      stream.on('end', () => {
        this.logOffset = currentSize;
        this.logReading = false;

        let raw = Buffer.concat(chunks).toString('utf-8');

        // If the cap kicked in, readFrom was an arbitrary mid-file position.
        // The first bytes may be mid-line — drop up to the first newline.
        if (this.logCapped) {
          const nl = raw.indexOf('\n');
          raw = nl >= 0 ? raw.slice(nl + 1) : '';
          this.logCapped = false;
        }

        // Prepend any partial line carried over from the previous read.
        const text = this.logCarry + raw;

        const endsWithNewline = text.endsWith('\n');
        const parts = text.split('\n');

        // If the chunk doesn't end with a newline, the last part is incomplete.
        // Carry it forward; it will be prepended on the next read.
        this.logCarry = endsWithNewline ? '' : (parts.pop() ?? '');

        const lines = parts.filter(Boolean);
        if (lines.length === 0) return;

        this.broadcast({
          type: 'log_lines',
          timestamp: new Date().toISOString(),
          data: { lines },
        });
      });
      stream.on('error', () => { this.logReading = false; });
    } catch {
      this.logReading = false;
    }
  }

  broadcast(event: DashboardEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch { /* client gone */ }
      }
    }
  }
}
