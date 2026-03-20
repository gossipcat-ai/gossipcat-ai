"use strict";
/**
 * Channel Manager
 *
 * In-memory pub-sub channel management. No database or Redis dependencies.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelManager = void 0;
class Channel {
    name;
    subscribers = new Map();
    constructor(name) {
        this.name = name;
    }
    hasSubscriber(agentId) {
        return this.subscribers.has(agentId);
    }
    subscribe(agentId, connection) {
        this.subscribers.set(agentId, connection);
    }
    unsubscribe(agentId) {
        return this.subscribers.delete(agentId);
    }
    getSubscribers() {
        return Array.from(this.subscribers.keys());
    }
    getSubscriberCount() {
        return this.subscribers.size;
    }
    isEmpty() {
        return this.subscribers.size === 0;
    }
    broadcast(envelope) {
        const senderId = envelope.sid;
        const errors = [];
        let deliveredCount = 0;
        let failedCount = 0;
        for (const [agentId, connection] of this.subscribers) {
            if (agentId === senderId)
                continue;
            if (!connection.isActive())
                continue;
            try {
                connection.send(envelope);
                deliveredCount++;
            }
            catch (error) {
                failedCount++;
                errors.push({
                    agentId,
                    error: error instanceof Error ? error.message : 'Unknown error'
                });
            }
        }
        return {
            success: true,
            channelName: this.name,
            subscriberCount: this.subscribers.size,
            deliveredCount,
            failedCount,
            errors
        };
    }
}
class ChannelManager {
    channels = new Map();
    subscribe(channelName, agentId, connection) {
        if (!channelName || typeof channelName !== 'string') {
            return { success: false, channelName: channelName || '', subscriberCount: 0, wasCreated: false, error: 'Invalid channel name', errorCode: 'INVALID_CHANNEL_NAME' };
        }
        let channel = this.channels.get(channelName);
        const wasCreated = !channel;
        if (!channel) {
            channel = new Channel(channelName);
            this.channels.set(channelName, channel);
        }
        channel.subscribe(agentId, connection);
        return { success: true, channelName, subscriberCount: channel.getSubscriberCount(), wasCreated };
    }
    unsubscribe(channelName, agentId) {
        const channel = this.channels.get(channelName);
        if (!channel) {
            return { success: false, channelName, subscriberCount: 0, wasDeleted: false, error: 'Channel not found', errorCode: 'CHANNEL_NOT_FOUND' };
        }
        const removed = channel.unsubscribe(agentId);
        if (!removed) {
            return { success: false, channelName, subscriberCount: channel.getSubscriberCount(), wasDeleted: false, error: 'Agent not subscribed', errorCode: 'NOT_SUBSCRIBED' };
        }
        const wasDeleted = channel.isEmpty();
        if (wasDeleted) {
            this.channels.delete(channelName);
        }
        return { success: true, channelName, subscriberCount: wasDeleted ? 0 : channel.getSubscriberCount(), wasDeleted };
    }
    unsubscribeAll(agentId) {
        const subscribed = [];
        for (const [channelName, channel] of this.channels) {
            if (channel.hasSubscriber(agentId)) {
                channel.unsubscribe(agentId);
                subscribed.push(channelName);
            }
        }
        // Cleanup empty channels
        for (const [channelName, channel] of this.channels) {
            if (channel.isEmpty()) {
                this.channels.delete(channelName);
            }
        }
        return subscribed;
    }
    broadcast(channelName, envelope) {
        const channel = this.channels.get(channelName);
        if (!channel) {
            return { success: true, channelName, subscriberCount: 0, deliveredCount: 0, failedCount: 0, errors: [] };
        }
        return channel.broadcast(envelope);
    }
    getSubscribers(channelName) {
        const channel = this.channels.get(channelName);
        return channel ? channel.getSubscribers() : [];
    }
    isSubscribed(channelName, agentId) {
        const channel = this.channels.get(channelName);
        return channel ? channel.hasSubscriber(agentId) : false;
    }
    getChannelCount() {
        return this.channels.size;
    }
    getChannelNames() {
        return Array.from(this.channels.keys());
    }
    clear() {
        this.channels.clear();
    }
}
exports.ChannelManager = ChannelManager;
//# sourceMappingURL=channels.js.map