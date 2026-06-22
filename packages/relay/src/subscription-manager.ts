/**
 * Subscription Manager
 *
 * Tracks which channels each agent is subscribed to.
 * Provides reverse lookup (agent -> channels) complementing ChannelManager's
 * forward lookup (channel -> agents).
 */

export class SubscriptionManager {
  private subscriptions: Map<string, Set<string>> = new Map();

  addSubscription(agentId: string, channelName: string): void {
    let channels = this.subscriptions.get(agentId);
    if (!channels) {
      channels = new Set();
      this.subscriptions.set(agentId, channels);
    }
    channels.add(channelName);
  }

  removeSubscription(agentId: string, channelName: string): boolean {
    const channels = this.subscriptions.get(agentId);
    if (!channels) return false;
    const removed = channels.delete(channelName);
    if (channels.size === 0) {
      this.subscriptions.delete(agentId);
    }
    return removed;
  }

  getSubscriptions(agentId: string): Set<string> {
    return this.subscriptions.get(agentId) || new Set();
  }

  hasSubscription(agentId: string, channelName: string): boolean {
    const channels = this.subscriptions.get(agentId);
    return channels ? channels.has(channelName) : false;
  }

  /**
   * Remove all subscriptions for an agent.
   * Returns channel names the agent was subscribed to.
   */
  removeAllSubscriptions(agentId: string): string[] {
    const channels = this.subscriptions.get(agentId);
    if (!channels) return [];
    const channelNames = Array.from(channels);
    this.subscriptions.delete(agentId);
    return channelNames;
  }

  getAgentCount(): number {
    return this.subscriptions.size;
  }

  getTotalSubscriptions(): number {
    let total = 0;
    for (const channels of this.subscriptions.values()) {
      total += channels.size;
    }
    return total;
  }

  getSubscriptionCount(agentId: string): number {
    const channels = this.subscriptions.get(agentId);
    return channels ? channels.size : 0;
  }

  hasAnySubscriptions(agentId: string): boolean {
    const channels = this.subscriptions.get(agentId);
    return channels ? channels.size > 0 : false;
  }

  clear(): void {
    this.subscriptions.clear();
  }
}
