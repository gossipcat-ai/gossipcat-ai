/**
 * Agent Connection
 *
 * Represents a single connected agent with its WebSocket reference.
 * Provides send() using Codec to encode outgoing MessageEnvelopes.
 */

import { WebSocket } from 'ws';
import { Codec, MessageEnvelope } from '@gossip/types';

const codec = new Codec();

/**
 * Per-socket liveness state for the heartbeat loop in server.ts.
 *
 * Kept as a module-level WeakMap instead of extending the WebSocket prototype
 * so we don't collide with `ws` internals and so stale entries GC automatically
 * when the socket object is released. Server-side heartbeat reads and writes
 * `pendingPong`; the `pong` handler below clears it on every live reply.
 */
export interface HeartbeatState {
  pendingPong: boolean;
}
export const livenessMap: WeakMap<WebSocket, HeartbeatState> = new WeakMap();

/**
 * AgentConnection wraps a WebSocket for a single authenticated agent session.
 */
export class AgentConnection {
  readonly sessionId: string;
  readonly agentId: string;
  private ws: WebSocket;
  private seq: number = 0;
  private active: boolean = true;

  constructor(sessionId: string, agentId: string, ws: WebSocket) {
    this.sessionId = sessionId;
    this.agentId = agentId;
    this.ws = ws;

    ws.on('close', () => {
      this.active = false;
    });

    // Heartbeat pong handler — the relay's heartbeat interval (server.ts)
    // marks each client as pendingPong=true before calling ws.ping(). When
    // the pong arrives, clear the flag so the next tick doesn't terminate
    // a live connection.
    ws.on('pong', () => {
      const entry = livenessMap.get(ws);
      if (entry) entry.pendingPong = false;
    });
  }

  /**
   * Send a MessageEnvelope to this agent via MessagePack encoding.
   */
  send(envelope: MessageEnvelope): void {
    if (!this.active || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Cannot send to ${this.agentId}: connection not open`);
    }
    const data = codec.encode(envelope);
    this.ws.send(data);
    this.seq++;
  }

  /**
   * Get next outgoing sequence number.
   */
  nextSeq(): number {
    return this.seq;
  }

  /**
   * Check if connection is still active.
   */
  isActive(): boolean {
    return this.active && this.ws.readyState === WebSocket.OPEN;
  }
}
