/**
 * Channel Manager
 *
 * In-memory pub-sub channel management. No database or Redis dependencies.
 */

import { MessageEnvelope } from '@gossip/types';
import { AgentConnection } from './agent-connection';

export interface SubscribeResult {
  success: boolean;
  channelName: string;
  subscriberCount: number;
  wasCreated: boolean;
  error?: string;
  errorCode?: string;
}

export interface UnsubscribeResult {
  success: boolean;
  channelName: string;
  subscriberCount: number;
  wasDeleted: boolean;
  error?: string;
  errorCode?: string;
}

export interface BroadcastResult {
  success: boolean;
  channelName: string;
  subscriberCount: number;
  deliveredCount: number;
  failedCount: number;
  errors: Array<{ agentId: string; error: string }>;
}

class Channel {
  readonly name: string;
  private subscribers: Map<string, AgentConnection> = new Map();

  constructor(name: string) {
    this.name = name;
  }

  hasSubscriber(agentId: string): boolean {
    return this.subscribers.has(agentId);
  }

  subscribe(agentId: string, connection: AgentConnection): void {
    this.subscribers.set(agentId, connection);
  }

  unsubscribe(agentId: string): boolean {
    return this.subscribers.delete(agentId);
  }

  getSubscribers(): string[] {
    return Array.from(this.subscribers.keys());
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  isEmpty(): boolean {
    return this.subscribers.size === 0;
  }

  broadcast(envelope: MessageEnvelope): BroadcastResult {
    const senderId = envelope.sid;
    const errors: Array<{ agentId: string; error: string }> = [];
    let deliveredCount = 0;
    let failedCount = 0;

    for (const [agentId, connection] of this.subscribers) {
      if (agentId === senderId) continue;
      if (!connection.isActive()) continue;

      try {
        connection.send(envelope);
        deliveredCount++;
      } catch (error) {
        failedCount++;
        errors.push({
          agentId,
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }

    return {
      success: true,
      channelName: this.name,
      subscriberCount: this.subscribers.size,
      deliveredCount,
      failedCount,
      errors
    };
  }
}

export class ChannelManager {
  private channels: Map<string, Channel> = new Map();

  subscribe(channelName: string, agentId: string, connection: AgentConnection): SubscribeResult {
    if (!channelName || typeof channelName !== 'string') {
      return { success: false, channelName: channelName || '', subscriberCount: 0, wasCreated: false, error: 'Invalid channel name', errorCode: 'INVALID_CHANNEL_NAME' };
    }

    let channel = this.channels.get(channelName);
    const wasCreated = !channel;
    if (!channel) {
      channel = new Channel(channelName);
      this.channels.set(channelName, channel);
    }

    channel.subscribe(agentId, connection);
    return { success: true, channelName, subscriberCount: channel.getSubscriberCount(), wasCreated };
  }

  unsubscribe(channelName: string, agentId: string): UnsubscribeResult {
    const channel = this.channels.get(channelName);
    if (!channel) {
      return { success: false, channelName, subscriberCount: 0, wasDeleted: false, error: 'Channel not found', errorCode: 'CHANNEL_NOT_FOUND' };
    }

    const removed = channel.unsubscribe(agentId);
    if (!removed) {
      return { success: false, channelName, subscriberCount: channel.getSubscriberCount(), wasDeleted: false, error: 'Agent not subscribed', errorCode: 'NOT_SUBSCRIBED' };
    }

    const wasDeleted = channel.isEmpty();
    if (wasDeleted) {
      this.channels.delete(channelName);
    }

    return { success: true, channelName, subscriberCount: wasDeleted ? 0 : channel.getSubscriberCount(), wasDeleted };
  }

  unsubscribeAll(agentId: string): string[] {
    const subscribed: string[] = [];
    for (const [channelName, channel] of this.channels) {
      if (channel.hasSubscriber(agentId)) {
        channel.unsubscribe(agentId);
        subscribed.push(channelName);
      }
    }
    // Cleanup empty channels
    for (const [channelName, channel] of this.channels) {
      if (channel.isEmpty()) {
        this.channels.delete(channelName);
      }
    }
    return subscribed;
  }

  broadcast(channelName: string, envelope: MessageEnvelope): BroadcastResult {
    const channel = this.channels.get(channelName);
    if (!channel) {
      return { success: true, channelName, subscriberCount: 0, deliveredCount: 0, failedCount: 0, errors: [] };
    }
    return channel.broadcast(envelope);
  }

  getSubscribers(channelName: string): string[] {
    const channel = this.channels.get(channelName);
    return channel ? channel.getSubscribers() : [];
  }

  isSubscribed(channelName: string, agentId: string): boolean {
    const channel = this.channels.get(channelName);
    return channel ? channel.hasSubscriber(agentId) : false;
  }

  getChannelCount(): number {
    return this.channels.size;
  }

  getChannelNames(): string[] {
    return Array.from(this.channels.keys());
  }

  clear(): void {
    this.channels.clear();
  }
}
