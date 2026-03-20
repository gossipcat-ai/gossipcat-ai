/**
 * Presence Tracker
 *
 * Tracks agent online/offline status with TTL-based automatic cleanup.
 * Agents must send PRESENCE or PING to extend their TTL.
 */
import { MessageEnvelope } from '@gossip/types';
export type PresenceStatus = 'online' | 'offline' | 'away' | 'busy' | string;
export interface PresenceEntry {
    agentId: string;
    status: PresenceStatus;
    lastSeen: number;
    metadata?: Record<string, any>;
}
export interface PresenceConfig {
    ttlMs?: number;
    cleanupIntervalMs?: number;
}
export declare class PresenceTracker {
    private presence;
    private cleanupTimer;
    private ttlMs;
    private cleanupIntervalMs;
    constructor(config?: PresenceConfig);
    recordPresence(agentId: string, status: PresenceStatus, metadata?: Record<string, any>): void;
    updateLastSeen(agentId: string): void;
    handlePresenceMessage(envelope: MessageEnvelope): void;
    getPresence(agentId: string): PresenceEntry | undefined;
    getAllPresence(): PresenceEntry[];
    removePresence(agentId: string): void;
    isOnline(agentId: string): boolean;
    getOnlineAgents(): string[];
    count(): number;
    cleanup(): number;
    stop(): void;
    clear(): void;
    private startCleanupTimer;
}
