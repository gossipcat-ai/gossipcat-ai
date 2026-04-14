/**
 * Message Rate Limiter
 *
 * Per-agent message-count gate on a sliding window. This is now a thin
 * adapter over the generic `RateLimiter` in `@gossip/orchestrator` so the
 * relay's count-mode gate and the HTTP file bridge's weighted-sum quota
 * share one substrate. Public API is preserved so existing test importers
 * and any future relay wiring continue to work without changes.
 */

import { RateLimiter } from '@gossip/orchestrator/rate-limiter';

export interface RateLimiterConfig {
  maxMessages: number;
  windowMs: number;
}

export class MessageRateLimiter {
  private readonly inner: RateLimiter;

  constructor(config: RateLimiterConfig) {
    this.inner = new RateLimiter(config.windowMs, config.maxMessages);
  }

  /**
   * Records a message from an agent and checks whether they are within the
   * rate limit. Returns `true` if the message is allowed, `false` if the
   * agent has exceeded their quota for the current window.
   */
  public isAllowed(agentId: string): boolean {
    return this.inner.record(agentId, 1);
  }

  /** Clears all tracking data (for testing). */
  public clear(): void {
    this.inner.clear();
  }
}
