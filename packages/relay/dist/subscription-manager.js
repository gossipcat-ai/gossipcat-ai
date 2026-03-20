"use strict";
/**
 * Subscription Manager
 *
 * Tracks which channels each agent is subscribed to.
 * Provides reverse lookup (agent -> channels) complementing ChannelManager's
 * forward lookup (channel -> agents).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionManager = void 0;
class SubscriptionManager {
    subscriptions = new Map();
    addSubscription(agentId, channelName) {
        let channels = this.subscriptions.get(agentId);
        if (!channels) {
            channels = new Set();
            this.subscriptions.set(agentId, channels);
        }
        channels.add(channelName);
    }
    removeSubscription(agentId, channelName) {
        const channels = this.subscriptions.get(agentId);
        if (!channels)
            return false;
        const removed = channels.delete(channelName);
        if (channels.size === 0) {
            this.subscriptions.delete(agentId);
        }
        return removed;
    }
    getSubscriptions(agentId) {
        return this.subscriptions.get(agentId) || new Set();
    }
    hasSubscription(agentId, channelName) {
        const channels = this.subscriptions.get(agentId);
        return channels ? channels.has(channelName) : false;
    }
    /**
     * Remove all subscriptions for an agent.
     * Returns channel names the agent was subscribed to.
     */
    removeAllSubscriptions(agentId) {
        const channels = this.subscriptions.get(agentId);
        if (!channels)
            return [];
        const channelNames = Array.from(channels);
        this.subscriptions.delete(agentId);
        return channelNames;
    }
    getAgentCount() {
        return this.subscriptions.size;
    }
    getTotalSubscriptions() {
        let total = 0;
        for (const channels of this.subscriptions.values()) {
            total += channels.size;
        }
        return total;
    }
    getSubscriptionCount(agentId) {
        const channels = this.subscriptions.get(agentId);
        return channels ? channels.size : 0;
    }
    hasAnySubscriptions(agentId) {
        const channels = this.subscriptions.get(agentId);
        return channels ? channels.size > 0 : false;
    }
    clear() {
        this.subscriptions.clear();
    }
}
exports.SubscriptionManager = SubscriptionManager;
//# sourceMappingURL=subscription-manager.js.map