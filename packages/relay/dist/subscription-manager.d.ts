/**
 * Subscription Manager
 *
 * Tracks which channels each agent is subscribed to.
 * Provides reverse lookup (agent -> channels) complementing ChannelManager's
 * forward lookup (channel -> agents).
 */
export declare class SubscriptionManager {
    private subscriptions;
    addSubscription(agentId: string, channelName: string): void;
    removeSubscription(agentId: string, channelName: string): boolean;
    getSubscriptions(agentId: string): Set<string>;
    hasSubscription(agentId: string, channelName: string): boolean;
    /**
     * Remove all subscriptions for an agent.
     * Returns channel names the agent was subscribed to.
     */
    removeAllSubscriptions(agentId: string): string[];
    getAgentCount(): number;
    getTotalSubscriptions(): number;
    getSubscriptionCount(agentId: string): number;
    hasAnySubscriptions(agentId: string): boolean;
    clear(): void;
}
