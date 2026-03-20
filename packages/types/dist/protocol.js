"use strict";
/**
 * @gossip/types - Protocol constants and wire format types
 *
 * Shared TypeScript type definitions for Gossip Mesh protocol.
 * Used by relay, client, and orchestrator packages.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceStatus = exports.ConnectionState = exports.TransportState = exports.FieldNames = exports.MessageType = void 0;
/**
 * Message type discriminators (1-9)
 */
var MessageType;
(function (MessageType) {
    MessageType[MessageType["DIRECT"] = 1] = "DIRECT";
    MessageType[MessageType["CHANNEL"] = 2] = "CHANNEL";
    MessageType[MessageType["RPC_REQUEST"] = 3] = "RPC_REQUEST";
    MessageType[MessageType["RPC_RESPONSE"] = 4] = "RPC_RESPONSE";
    MessageType[MessageType["SUBSCRIPTION"] = 5] = "SUBSCRIPTION";
    MessageType[MessageType["UNSUBSCRIPTION"] = 6] = "UNSUBSCRIPTION";
    MessageType[MessageType["PRESENCE"] = 7] = "PRESENCE";
    MessageType[MessageType["PING"] = 8] = "PING";
    MessageType[MessageType["ERROR"] = 9] = "ERROR"; // Error reporting
})(MessageType || (exports.MessageType = MessageType = {}));
/**
 * Short field names for wire format (minimize overhead)
 */
exports.FieldNames = {
    version: 'v',
    messageType: 't',
    flags: 'f',
    messageId: 'id',
    senderId: 'sid',
    receiverId: 'rid',
    requestId: 'rid_req',
    timestamp: 'ts',
    sequence: 'seq',
    ttl: 'ttl',
    metadata: 'meta',
    body: 'body'
};
var TransportState;
(function (TransportState) {
    TransportState["DISCONNECTED"] = "disconnected";
    TransportState["CONNECTING"] = "connecting";
    TransportState["CONNECTED"] = "connected";
    TransportState["RECONNECTING"] = "reconnecting";
    TransportState["CLOSED"] = "closed";
})(TransportState || (exports.TransportState = TransportState = {}));
/**
 * Connection states
 */
var ConnectionState;
(function (ConnectionState) {
    ConnectionState["DISCONNECTED"] = "disconnected";
    ConnectionState["CONNECTING"] = "connecting";
    ConnectionState["CONNECTED"] = "connected";
    ConnectionState["RECONNECTING"] = "reconnecting";
    ConnectionState["ERROR"] = "error";
})(ConnectionState || (exports.ConnectionState = ConnectionState = {}));
/**
 * Presence status
 */
var PresenceStatus;
(function (PresenceStatus) {
    PresenceStatus["ONLINE"] = "online";
    PresenceStatus["OFFLINE"] = "offline";
    PresenceStatus["AWAY"] = "away";
    PresenceStatus["BUSY"] = "busy";
})(PresenceStatus || (exports.PresenceStatus = PresenceStatus = {}));
//# sourceMappingURL=protocol.js.map