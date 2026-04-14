import { MessageRateLimiter } from '@gossip/relay/message-rate-limiter';

describe('MessageRateLimiter', () => {
  let limiter: MessageRateLimiter;
  const agentId = 'test-agent';
  const config = { maxMessages: 5, windowMs: 1000 };

  beforeEach(() => {
    limiter = new MessageRateLimiter(config);
  });

  it('should allow messages within the limit', () => {
    for (let i = 0; i < config.maxMessages; i++) {
      expect(limiter.isAllowed(agentId)).toBe(true);
    }
  });

  it('should deny messages that exceed the limit', () => {
    for (let i = 0; i < config.maxMessages; i++) {
      limiter.isAllowed(agentId);
    }
    expect(limiter.isAllowed(agentId)).toBe(false);
  });

  it('should reset the count after the window expires', async () => {
    for (let i = 0; i < config.maxMessages; i++) {
      limiter.isAllowed(agentId);
    }
    expect(limiter.isAllowed(agentId)).toBe(false);

    // Wait for the window to pass
    await new Promise(resolve => setTimeout(resolve, config.windowMs + 100));

    expect(limiter.isAllowed(agentId)).toBe(true);
  });

  it('should handle multiple agents independently', () => {
    const agent2Id = 'test-agent-2';

    for (let i = 0; i < config.maxMessages; i++) {
      expect(limiter.isAllowed(agentId)).toBe(true);
      expect(limiter.isAllowed(agent2Id)).toBe(true);
    }

    expect(limiter.isAllowed(agentId)).toBe(false);
    expect(limiter.isAllowed(agent2Id)).toBe(false);
  });

  it('should not let old messages affect the current window', async () => {
    // Send some messages
    limiter.isAllowed(agentId);
    limiter.isAllowed(agentId);

    // Wait for half the window
    await new Promise(resolve => setTimeout(resolve, config.windowMs / 2));

    // Send more messages up to one-below the cap so the next call lands
    // exactly at the cap (returns true), and the call after exceeds (false).
    for (let i = 0; i < config.maxMessages - 3; i++) {
      limiter.isAllowed(agentId);
    }
    expect(limiter.isAllowed(agentId)).toBe(true); // 5th in window — at the limit
    expect(limiter.isAllowed(agentId)).toBe(false); // 6th in window — exceeds

    // Wait for the first messages to expire
    await new Promise(resolve => setTimeout(resolve, config.windowMs / 2 + 100));

    // Now should be able to send 2 messages again
    expect(limiter.isAllowed(agentId)).toBe(true);
    expect(limiter.isAllowed(agentId)).toBe(true);
    expect(limiter.isAllowed(agentId)).toBe(false);
  });

  it('clear should reset all tracking', () => {
    for (let i = 0; i < config.maxMessages; i++) {
      limiter.isAllowed(agentId);
    }
    expect(limiter.isAllowed(agentId)).toBe(false);

    limiter.clear();
    expect(limiter.isAllowed(agentId)).toBe(true);
  });
});
