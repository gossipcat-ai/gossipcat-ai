"use strict";
/**
 * Presence Tracker
 *
 * Tracks agent online/offline status with TTL-based automatic cleanup.
 * Agents must send PRESENCE or PING to extend their TTL.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceTracker = void 0;
class PresenceTracker {
    presence = new Map();
    cleanupTimer = null;
    ttlMs;
    cleanupIntervalMs;
    constructor(config) {
        this.ttlMs = config?.ttlMs ?? 3600000; // 60 minutes
        this.cleanupIntervalMs = config?.cleanupIntervalMs ?? 60000; // 60 seconds
        this.startCleanupTimer();
    }
    recordPresence(agentId, status, metadata) {
        this.presence.set(agentId, { agentId, status, lastSeen: Date.now(), metadata });
    }
    updateLastSeen(agentId) {
        const entry = this.presence.get(agentId);
        if (entry) {
            entry.lastSeen = Date.now();
        }
        else {
            this.recordPresence(agentId, 'online');
        }
    }
    handlePresenceMessage(envelope) {
        try {
            let status = 'online';
            let metadata;
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
        }
        catch {
            this.recordPresence(envelope.sid, 'online');
        }
    }
    getPresence(agentId) {
        return this.presence.get(agentId);
    }
    getAllPresence() {
        return Array.from(this.presence.values());
    }
    removePresence(agentId) {
        this.presence.delete(agentId);
    }
    isOnline(agentId) {
        const entry = this.presence.get(agentId);
        return entry ? entry.status === 'online' : false;
    }
    getOnlineAgents() {
        return Array.from(this.presence.keys()).sort();
    }
    count() {
        return this.presence.size;
    }
    cleanup() {
        const now = Date.now();
        const expired = [];
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
    stop() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    clear() {
        this.presence.clear();
    }
    startCleanupTimer() {
        this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupIntervalMs);
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }
}
exports.PresenceTracker = PresenceTracker;
//# sourceMappingURL=presence.js.map