import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('DashboardAuth', () => {
  let projectRoot: string;
  let auth: DashboardAuth;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    auth = new DashboardAuth(projectRoot);
  });

  describe('key management', () => {
    it('generates a 32-char hex key on first init', () => {
      auth.init();
      const keyPath = join(projectRoot, '.gossip', 'dashboard-key');
      expect(existsSync(keyPath)).toBe(true);
      const key = readFileSync(keyPath, 'utf-8').trim();
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    it('reuses existing key on subsequent inits', () => {
      auth.init();
      const key1 = auth.getKey();
      const auth2 = new DashboardAuth(projectRoot);
      auth2.init();
      expect(auth2.getKey()).toBe(key1);
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
