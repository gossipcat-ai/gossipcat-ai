/**
 * Connection Manager
 *
 * Registry of active agent connections with O(1) lookup by session ID or agent ID.
 * Maintains a secondary agentIdIndex for O(1) getByAgentId() lookups.
 */
import { AgentConnection } from './agent-connection';
export declare class ConnectionManager {
    private connections;
    private agentIdIndex;
    /**
     * Register a new agent connection.
     * @throws Error if session ID is already registered
     */
    register(sessionId: string, connection: AgentConnection): void;
    /**
     * Unregister a connection by session ID.
     * Removes from both indexes.
     */
    unregister(sessionId: string): boolean;
    /**
     * Get connection by session ID (O(1)).
     */
    get(sessionId: string): AgentConnection | undefined;
    /**
     * Get connection by agent ID (O(1) via secondary index).
     */
    getByAgentId(agentId: string): AgentConnection | undefined;
    /**
     * Get all active connections.
     */
    getAll(): AgentConnection[];
    /**
     * Check if session is registered.
     */
    has(sessionId: string): boolean;
    /**
     * Number of active connections.
     */
    get count(): number;
    /**
     * Clear all connections (for testing).
     */
    clear(): void;
}
