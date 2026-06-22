import { RateLimiter } from '@gossip/orchestrator/rate-limiter';

describe('RateLimiter', () => {
  describe('count mode (weight=1)', () => {
    it('allows events up to maxWeight, then rejects', () => {
      const lim = new RateLimiter(1000, 5);
      for (let i = 0; i < 5; i++) {
        expect(lim.record('agent-a')).toBe(true);
      }
      expect(lim.record('agent-a')).toBe(false);
      expect(lim.record('agent-a')).toBe(false);
    });

    it('does not record events that exceed the cap (no consumed quota on rejection)', () => {
      const lim = new RateLimiter(1000, 3);
      for (let i = 0; i < 3; i++) lim.record('agent-a');
      expect(lim.currentWeight('agent-a')).toBe(3);
      expect(lim.record('agent-a')).toBe(false);
      // Rejected event must NOT show up in currentWeight.
      expect(lim.currentWeight('agent-a')).toBe(3);
    });
  });

  describe('weighted-sum mode', () => {
    it('caps the SUM of weights, not the count of events', () => {
      const lim = new RateLimiter(60_000, 100); // 100 byte budget
      expect(lim.record('token-a', 30)).toBe(true);
      expect(lim.record('token-a', 30)).toBe(true);
      expect(lim.record('token-a', 30)).toBe(true); // sum=90
      expect(lim.record('token-a', 20)).toBe(false); // 90+20=110 > 100
      expect(lim.record('token-a', 10)).toBe(true);  // 90+10=100, fits
      expect(lim.record('token-a', 1)).toBe(false);
    });

    it('rejects a single event whose weight alone exceeds maxWeight', () => {
      const lim = new RateLimiter(60_000, 50);
      expect(lim.record('token-a', 51)).toBe(false);
      // No quota was consumed.
      expect(lim.currentWeight('token-a')).toBe(0);
      // And subsequent fitting events still work.
      expect(lim.record('token-a', 25)).toBe(true);
    });

    it('rejects negative or non-finite weights', () => {
      const lim = new RateLimiter(1000, 100);
      expect(() => lim.record('k', -1)).toThrow();
      expect(() => lim.record('k', NaN)).toThrow();
      expect(() => lim.record('k', Infinity)).toThrow();
    });
  });

  describe('window rollover', () => {
    it('purges entries older than windowMs so quota frees up', async () => {
      const lim = new RateLimiter(150, 2);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(false);
      await new Promise((r) => setTimeout(r, 200));
      // Window fully rolled — both old entries are expired.
      expect(lim.currentWeight('a')).toBe(0);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(false);
    });

    it('partial-window rollover frees only the expired prefix', async () => {
      const lim = new RateLimiter(200, 4);
      lim.record('a'); // t0
      lim.record('a'); // t0
      await new Promise((r) => setTimeout(r, 120));
      lim.record('a'); // t≈120
      lim.record('a'); // t≈120
      expect(lim.record('a')).toBe(false);
      // Wait for the first two to expire but not the second pair.
      await new Promise((r) => setTimeout(r, 120));
      expect(lim.currentWeight('a')).toBe(2);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(false);
    });
  });

  describe('currentWeight accessor', () => {
    it('reports the live sum without recording anything', () => {
      const lim = new RateLimiter(60_000, 100);
      expect(lim.currentWeight('k')).toBe(0);
      lim.record('k', 25);
      expect(lim.currentWeight('k')).toBe(25);
      lim.record('k', 30);
      expect(lim.currentWeight('k')).toBe(55);
      // Calling currentWeight repeatedly is a pure read (no consumption).
      expect(lim.currentWeight('k')).toBe(55);
      expect(lim.currentWeight('k')).toBe(55);
    });
  });

  describe('multi-key isolation', () => {
    it('counts each key independently', () => {
      const lim = new RateLimiter(1000, 2);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(true);
      expect(lim.record('a')).toBe(false);
      // Key 'b' has its own quota.
      expect(lim.record('b')).toBe(true);
      expect(lim.record('b')).toBe(true);
      expect(lim.record('b')).toBe(false);
      expect(lim.currentWeight('a')).toBe(2);
      expect(lim.currentWeight('b')).toBe(2);
    });

    it('weighted mode isolates keys too', () => {
      const lim = new RateLimiter(60_000, 100);
      lim.record('token-a', 80);
      lim.record('token-b', 80);
      expect(lim.currentWeight('token-a')).toBe(80);
      expect(lim.currentWeight('token-b')).toBe(80);
      expect(lim.record('token-a', 30)).toBe(false); // a is full
      expect(lim.record('token-b', 20)).toBe(true);  // b still has room
    });
  });

  describe('constructor validation', () => {
    it('rejects non-positive windowMs', () => {
      expect(() => new RateLimiter(0, 1)).toThrow();
      expect(() => new RateLimiter(-1, 1)).toThrow();
      expect(() => new RateLimiter(NaN, 1)).toThrow();
    });
    it('rejects non-positive maxWeight', () => {
      expect(() => new RateLimiter(1000, 0)).toThrow();
      expect(() => new RateLimiter(1000, -1)).toThrow();
      expect(() => new RateLimiter(1000, NaN)).toThrow();
    });
  });

  describe('clear', () => {
    it('drops all tracking', () => {
      const lim = new RateLimiter(1000, 2);
      lim.record('a');
      lim.record('a');
      expect(lim.record('a')).toBe(false);
      lim.clear();
      expect(lim.currentWeight('a')).toBe(0);
      expect(lim.record('a')).toBe(true);
    });
  });
});
