/**
 * Gossip Mesh error classes
 */
export declare class GossipError extends Error {
    code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
export declare class GossipConnectionError extends GossipError {
    constructor(message: string);
}
export declare class GossipProtocolError extends GossipError {
    constructor(message: string);
}
export declare class GossipSecurityError extends GossipError {
    constructor(message: string);
}
export declare class GossipRpcError extends GossipError {
    constructor(message: string);
}
