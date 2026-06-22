/**
 * Gossip Mesh error classes
 */

export class GossipError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'GossipError';
  }
}

export class GossipConnectionError extends GossipError {
  constructor(message: string) {
    super(message, 'CONNECTION_ERROR');
    this.name = 'GossipConnectionError';
  }
}

export class GossipProtocolError extends GossipError {
  constructor(message: string) {
    super(message, 'PROTOCOL_ERROR');
    this.name = 'GossipProtocolError';
  }
}

export class GossipSecurityError extends GossipError {
  constructor(message: string) {
    super(message, 'SECURITY_ERROR');
    this.name = 'GossipSecurityError';
  }
}

export class GossipRpcError extends GossipError {
  constructor(message: string) {
    super(message, 'RPC_ERROR');
    this.name = 'GossipRpcError';
  }
}
