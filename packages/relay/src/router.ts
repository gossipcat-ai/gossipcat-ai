/**
 * Message Router
 *
 * Routes messages to their destinations based on message type.
 * Handles all 9 MessageType cases with O(1) lookups via ConnectionManager.
 */

import { randomUUID } from 'crypto';
import { MessageEnvelope, MessageType } from '@gossip/types';
import { ConnectionManager } from './connection-manager';
import { AgentConnection } from './agent-connection';
import { ChannelManager } from './channels';
import { SubscriptionManager } from './subscription-manager';
import { PresenceTracker } from './presence';

export interface RouterMetrics {
  messagesRouted: number;
  messagesByType: Record<number, number>;
  routingErrors: number;
  averageLatencyMs: number;
}

export class MessageRouter {
  private channelManager: ChannelManager;
  private subscriptionManager: SubscriptionManager;
  private presenceTracker: PresenceTracker;
  private metrics: RouterMetrics = {
    messagesRouted: 0,
    messagesByType: {},
    routingErrors: 0,
    averageLatencyMs: 0
  };
  private totalLatency: number = 0;

  constructor(private connectionManager: ConnectionManager) {
    this.channelManager = new ChannelManager();
    this.subscriptionManager = new SubscriptionManager();
    this.presenceTracker = new PresenceTracker();
  }

  /**
   * Route an envelope to its destination. Sender must be pre-authenticated.
   */
  route(envelope: MessageEnvelope, _sender?: AgentConnection): void {
    const start = performance.now();

    try {
      switch (envelope.t) {
        case MessageType.DIRECT:
          this.routeDirect(envelope);
          break;
        case MessageType.CHANNEL:
          this.routeChannel(envelope);
          break;
        case MessageType.RPC_REQUEST:
          this.routeToAgent(envelope);
          break;
        case MessageType.RPC_RESPONSE:
          this.routeToAgent(envelope);
          break;
        case MessageType.SUBSCRIPTION:
          this.handleSubscription(envelope);
          break;
        case MessageType.UNSUBSCRIPTION:
          this.handleUnsubscription(envelope);
          break;
        case MessageType.PRESENCE:
          this.handlePresence(envelope);
          break;
        case MessageType.PING:
          this.handlePing(envelope);
          break;
        case MessageType.ERROR:
          this.routeDirect(envelope);
          break;
        default:
          this.sendError(envelope.sid, 'INVALID_TYPE', `Unknown message type: ${(envelope as any).t}`, envelope.id);
      }

      const latencyMs = performance.now() - start;
      this.metrics.messagesRouted++;
      this.metrics.messagesByType[envelope.t] = (this.metrics.messagesByType[envelope.t] || 0) + 1;
      this.totalLatency += latencyMs;
      this.metrics.averageLatencyMs = this.totalLatency / this.metrics.messagesRouted;
    } catch (error) {
      this.metrics.routingErrors++;
      try {
        this.sendError(
          envelope.sid,
          'INTERNAL_ERROR',
          error instanceof Error ? error.message : 'Unknown error',
          envelope.id
        );
      } catch { /* ignore */ }
    }
  }

  private routeDirect(envelope: MessageEnvelope): void {
    const receiver = this.connectionManager.getByAgentId(envelope.rid)
      || this.connectionManager.get(envelope.rid);

    if (!receiver || !receiver.isActive()) {
      this.sendError(envelope.sid, 'AGENT_NOT_FOUND', `Agent ${envelope.rid} not connected`, envelope.id);
      return;
    }

    try {
      receiver.send(envelope);
    } catch (error) {
      this.sendError(
        envelope.sid,
        'DELIVERY_FAILED',
        error instanceof Error ? error.message : 'Failed to deliver',
        envelope.id
      );
    }
  }

  private routeToAgent(envelope: MessageEnvelope): void {
    const receiver = this.connectionManager.getByAgentId(envelope.rid)
      || this.connectionManager.get(envelope.rid);

    if (!receiver || !receiver.isActive()) {
      this.sendError(envelope.sid, 'AGENT_NOT_FOUND', `Agent ${envelope.rid} not available`, envelope.id);
      return;
    }
    receiver.send(envelope);
  }

  private routeChannel(envelope: MessageEnvelope): void {
    const result = this.channelManager.broadcast(envelope.rid, envelope);
    if (result.failedCount > 0) {
      console.warn(`[Router] Channel broadcast to "${envelope.rid}" had ${result.failedCount} failures`);
    }
  }

  private handleSubscription(envelope: MessageEnvelope): void {
    const connection = this.connectionManager.getByAgentId(envelope.sid);
    if (!connection) return;

    this.channelManager.subscribe(envelope.rid, envelope.sid, connection);
    this.subscriptionManager.addSubscription(envelope.sid, envelope.rid);
  }

  private handleUnsubscription(envelope: MessageEnvelope): void {
    this.channelManager.unsubscribe(envelope.rid, envelope.sid);
    this.subscriptionManager.removeSubscription(envelope.sid, envelope.rid);
  }

  private handlePresence(envelope: MessageEnvelope): void {
    this.presenceTracker.handlePresenceMessage(envelope);
  }

  private handlePing(envelope: MessageEnvelope): void {
    this.presenceTracker.updateLastSeen(envelope.sid);

    const requester = this.connectionManager.getByAgentId(envelope.sid)
      || this.connectionManager.get(envelope.sid);
    if (!requester || !requester.isActive()) return;

    const pong: MessageEnvelope = {
      ...envelope,
      id: randomUUID(),
      sid: 'relay',
      rid: envelope.sid,
      ts: Date.now(),
      seq: 0
    };
    requester.send(pong);
  }

  private sendError(
    toAgentId: string,
    errorCode: string,
    description: string,
    relatedMessageId?: string
  ): void {
    const receiver = this.connectionManager.getByAgentId(toAgentId);
    if (!receiver || !receiver.isActive()) return;

    const errorMsg: MessageEnvelope = {
      v: 1,
      t: MessageType.ERROR,
      f: 0,
      id: randomUUID(),
      sid: 'relay',
      rid: toAgentId,
      rid_req: relatedMessageId,
      ts: Date.now(),
      seq: 0,
      ttl: 0,
      meta: { error_code: errorCode, description },
      body: new Uint8Array(0)
    };

    try {
      receiver.send(errorMsg);
    } catch { /* ignore */ }
  }

  /**
   * Clean up all resources for a disconnecting agent.
   */
  onAgentDisconnect(sessionId: string): void {
    const connection = this.connectionManager.get(sessionId);
    if (!connection) return;

    const agentId = connection.agentId;
    const channels = this.subscriptionManager.removeAllSubscriptions(agentId);
    for (const channelName of channels) {
      this.channelManager.unsubscribe(channelName, agentId);
    }
    this.presenceTracker.removePresence(agentId);
  }

  getMetrics(): RouterMetrics {
    return { ...this.metrics };
  }

  getChannelManager(): ChannelManager {
    return this.channelManager;
  }

  getPresenceTracker(): PresenceTracker {
    return this.presenceTracker;
  }
}
