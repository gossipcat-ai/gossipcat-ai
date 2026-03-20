"use strict";
/**
 * Gossip Mesh error classes
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GossipRpcError = exports.GossipSecurityError = exports.GossipProtocolError = exports.GossipConnectionError = exports.GossipError = void 0;
class GossipError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'GossipError';
    }
}
exports.GossipError = GossipError;
class GossipConnectionError extends GossipError {
    constructor(message) {
        super(message, 'CONNECTION_ERROR');
        this.name = 'GossipConnectionError';
    }
}
exports.GossipConnectionError = GossipConnectionError;
class GossipProtocolError extends GossipError {
    constructor(message) {
        super(message, 'PROTOCOL_ERROR');
        this.name = 'GossipProtocolError';
    }
}
exports.GossipProtocolError = GossipProtocolError;
class GossipSecurityError extends GossipError {
    constructor(message) {
        super(message, 'SECURITY_ERROR');
        this.name = 'GossipSecurityError';
    }
}
exports.GossipSecurityError = GossipSecurityError;
class GossipRpcError extends GossipError {
    constructor(message) {
        super(message, 'RPC_ERROR');
        this.name = 'GossipRpcError';
    }
}
exports.GossipRpcError = GossipRpcError;
//# sourceMappingURL=errors.js.map