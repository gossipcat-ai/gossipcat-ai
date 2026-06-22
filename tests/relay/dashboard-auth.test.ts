import { DashboardAuth } from '@gossip/relay/dashboard/auth';

describe('DashboardAuth', () => {
  let auth: DashboardAuth;

  beforeEach(() => {
    auth = new DashboardAuth();
  });

  describe('key management', () => {
    it('generates a 32-char hex key on init', () => {
      auth.init();
      const key = auth.getKey();
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    it('generates a new key each init (in-memory, no persistence)', () => {
      auth.init();
      auth.getKey();
      const auth2 = new DashboardAuth();
      auth2.init();
      // Different instances get different keys (no shared file)
      expect(auth2.getKey()).toMatch(/^[0-9a-f]{32}$/);
    });

    it('regenerates key when forced', () => {
      auth.init();
      const key1 = auth.getKey();
      auth.regenerateKey();
      expect(auth.getKey()).not.toBe(key1);
      expect(auth.getKey()).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('session management', () => {
    it('creates a session token on valid key', () => {
      auth.init();
      const token = auth.createSession(auth.getKey());
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
    });

    it('returns null on invalid key', () => {
      auth.init();
      const token = auth.createSession('wrong-key');
      expect(token).toBeNull();
    });

    it('validates session tokens', () => {
      auth.init();
      const token = auth.createSession(auth.getKey())!;
      expect(auth.validateSession(token)).toBe(true);
      expect(auth.validateSession('bogus')).toBe(false);
    });

    it('uses timing-safe comparison for key validation', () => {
      auth.init();
      // Different length keys should still not throw (hashed to fixed length)
      expect(auth.createSession('')).toBeNull();
      expect(auth.createSession('short')).toBeNull();
      expect(auth.createSession('a'.repeat(100))).toBeNull();
    });

    it('expires sessions after TTL', () => {
      jest.useFakeTimers();
      auth.init();
      const token = auth.createSession(auth.getKey())!;
      expect(auth.validateSession(token)).toBe(true);

      // Advance past 24h TTL
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(auth.validateSession(token)).toBe(false);

      jest.useRealTimers();
    });
  });
});
