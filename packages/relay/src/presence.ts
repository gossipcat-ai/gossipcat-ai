/**
 * Presence Tracker
 *
 * Tracks agent online/offline status with TTL-based automatic cleanup.
 * Agents must send PRESENCE or PING to extend their TTL.
 */

import { MessageEnvelope } from '@gossip/types';

type PresenceStatus = 'online' | 'offline' | 'away' | 'busy' | string;

interface PresenceEntry {
  agentId: string;
  status: PresenceStatus;
  lastSeen: number;
  metadata?: Record<string, any>;
}

interface PresenceConfig {
  ttlMs?: number;             // default: 60 minutes
  cleanupIntervalMs?: number; // default: 60 seconds
}

export class PresenceTracker {
  private presence: Map<string, PresenceEntry> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private ttlMs: number;
  private cleanupIntervalMs: number;

  constructor(config?: PresenceConfig) {
    this.ttlMs = config?.ttlMs ?? 3600000;          // 60 minutes
    this.cleanupIntervalMs = config?.cleanupIntervalMs ?? 60000; // 60 seconds
    this.startCleanupTimer();
  }

  recordPresence(agentId: string, status: PresenceStatus, metadata?: Record<string, any>): void {
    this.presence.set(agentId, { agentId, status, lastSeen: Date.now(), metadata });
  }

  updateLastSeen(agentId: string): void {
    const entry = this.presence.get(agentId);
    if (entry) {
      entry.lastSeen = Date.now();
    } else {
      this.recordPresence(agentId, 'online');
    }
  }

  handlePresenceMessage(envelope: MessageEnvelope): void {
    try {
      let status: PresenceStatus = 'online';
      let metadata: Record<string, any> | undefined;

      if (envelope.body && envelope.body.length > 0) {
        const bodyStr = new TextDecoder().decode(envelope.body);
        const bodyData = JSON.parse(bodyStr);
        status = bodyData.status || 'online';
        metadata = bodyData.metadata;
      }

      if (envelope.meta) {
        metadata = { ...metadata, ...envelope.meta };
      }

      this.recordPresence(envelope.sid, status, metadata);
    } catch {
      this.recordPresence(envelope.sid, 'online');
    }
  }

  getPresence(agentId: string): PresenceEntry | undefined {
    return this.presence.get(agentId);
  }

  getAllPresence(): PresenceEntry[] {
    return Array.from(this.presence.values());
  }

  removePresence(agentId: string): void {
    this.presence.delete(agentId);
  }

  isOnline(agentId: string): boolean {
    const entry = this.presence.get(agentId);
    return entry ? entry.status === 'online' : false;
  }

  getOnlineAgents(): string[] {
    return Array.from(this.presence.entries())
      .filter(([, entry]) => entry.status === 'online')
      .map(([id]) => id)
      .sort();
  }

  count(): number {
    return this.presence.size;
  }

  cleanup(): number {
    const now = Date.now();
    const expired: string[] = [];
    for (const [agentId, entry] of this.presence) {
      if (now - entry.lastSeen > this.ttlMs) {
        expired.push(agentId);
      }
    }
    for (const id of expired) {
      this.presence.delete(id);
    }
    return expired.length;
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  clear(): void {
    this.presence.clear();
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }
}
