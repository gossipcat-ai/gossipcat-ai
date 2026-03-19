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
