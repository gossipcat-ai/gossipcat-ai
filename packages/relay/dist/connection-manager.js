"use strict";
/**
 * Connection Manager
 *
 * Registry of active agent connections with O(1) lookup by session ID or agent ID.
 * Maintains a secondary agentIdIndex for O(1) getByAgentId() lookups.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
class ConnectionManager {
    connections = new Map();
    agentIdIndex = new Map();
    /**
     * Register a new agent connection.
     * @throws Error if session ID is already registered
     */
    register(sessionId, connection) {
        if (this.connections.has(sessionId)) {
            throw new Error(`Session ID ${sessionId} already registered`);
        }
        this.connections.set(sessionId, connection);
        this.agentIdIndex.set(connection.agentId, connection);
    }
    /**
     * Unregister a connection by session ID.
     * Removes from both indexes.
     */
    unregister(sessionId) {
        const conn = this.connections.get(sessionId);
        if (conn) {
            this.agentIdIndex.delete(conn.agentId);
        }
        return this.connections.delete(sessionId);
    }
    /**
     * Get connection by session ID (O(1)).
     */
    get(sessionId) {
        return this.connections.get(sessionId);
    }
    /**
     * Get connection by agent ID (O(1) via secondary index).
     */
    getByAgentId(agentId) {
        return this.agentIdIndex.get(agentId);
    }
    /**
     * Get all active connections.
     */
    getAll() {
        return Array.from(this.connections.values());
    }
    /**
     * Check if session is registered.
     */
    has(sessionId) {
        return this.connections.has(sessionId);
    }
    /**
     * Number of active connections.
     */
    get count() {
        return this.connections.size;
    }
    /**
     * Clear all connections (for testing).
     */
    clear() {
        this.connections.clear();
        this.agentIdIndex.clear();
    }
}
exports.ConnectionManager = ConnectionManager;
//# sourceMappingURL=connection-manager.js.map