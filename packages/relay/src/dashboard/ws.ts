import { WebSocket } from 'ws';

export interface DashboardEvent {
  type: 'task_dispatched' | 'task_completed' | 'task_failed'
      | 'consensus_started' | 'consensus_complete'
      | 'skill_changed' | 'agent_connected' | 'agent_disconnected';
  timestamp: string;
  data: Record<string, unknown>;
}

export class DashboardWs {
  private clients: Set<WebSocket> = new Set();

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

  broadcast(event: DashboardEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch { /* client gone */ }
      }
    }
  }
}
