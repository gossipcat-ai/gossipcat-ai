/**
 * Connection Manager
 *
 * Registry of active agent connections with O(1) lookup by session ID or agent ID.
 * Maintains a secondary agentIdIndex for O(1) getByAgentId() lookups.
 */

import { AgentConnection } from './agent-connection';

export class ConnectionManager {
  private connections: Map<string, AgentConnection> = new Map();
  private agentIdIndex: Map<string, AgentConnection> = new Map();

  /**
   * Register a new agent connection.
   * @throws Error if session ID is already registered
   */
  register(sessionId: string, connection: AgentConnection): void {
    if (this.connections.has(sessionId)) {
      throw new Error(`Session ID ${sessionId} already registered`);
    }
    if (this.agentIdIndex.has(connection.agentId)) {
      throw new Error(`Agent ID ${connection.agentId} is already connected`);
    }
    this.connections.set(sessionId, connection);
    this.agentIdIndex.set(connection.agentId, connection);
  }

  /**
   * Unregister a connection by session ID.
   * Removes from both indexes.
   */
  unregister(sessionId: string): boolean {
    const conn = this.connections.get(sessionId);
    if (conn) {
      this.agentIdIndex.delete(conn.agentId);
    }
    return this.connections.delete(sessionId);
  }

  /**
   * Get connection by session ID (O(1)).
   */
  get(sessionId: string): AgentConnection | undefined {
    return this.connections.get(sessionId);
  }

  /**
   * Get connection by agent ID (O(1) via secondary index).
   */
  getByAgentId(agentId: string): AgentConnection | undefined {
    return this.agentIdIndex.get(agentId);
  }

  /**
   * Get all active connections.
   */
  getAll(): AgentConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Check if session is registered.
   */
  has(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  /**
   * Number of active connections.
   */
  get count(): number {
    return this.connections.size;
  }

  /**
   * Clear all connections (for testing).
   */
  clear(): void {
    this.connections.clear();
    this.agentIdIndex.clear();
  }
}
