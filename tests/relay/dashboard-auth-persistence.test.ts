import { DashboardAuth, AUTH_FILE_NAME } from '@gossip/relay/dashboard/auth';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-auth-'));
  mkdirSync(join(root, '.gossip'), { recursive: true });
  return root;
}

function authFile(root: string): string {
  return join(root, '.gossip', AUTH_FILE_NAME);
}

describe('DashboardAuth persistence (issue #548 item 3a)', () => {
  it('persists the key + sessions across init() calls (relay restart)', () => {
    const root = makeRoot();

    const a1 = new DashboardAuth();
    a1.init(root);
    const key = a1.getKey();
    const token = a1.createSession(key);
    expect(token).toBeTruthy();

    // Simulate a relay restart: a fresh instance loads from disk.
    const a2 = new DashboardAuth();
    a2.init(root);
    expect(a2.getKey()).toBe(key); // same key, not regenerated
    expect(a2.validateSession(token!)).toBe(true); // session survived
  });

  it('writes the auth file under .gossip/ with mode 0600', () => {
    const root = makeRoot();
    const auth = new DashboardAuth();
    auth.init(root);
    auth.createSession(auth.getKey());

    const path = authFile(root);
    expect(existsSync(path)).toBe(true);
    // Lower 9 permission bits should be 0o600 (owner read/write only).
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('prunes expired sessions on init() instead of wiping the key', () => {
    const root = makeRoot();

    const a1 = new DashboardAuth();
    a1.init(root);
    const key = a1.getKey();
    const liveToken = a1.createSession(key)!;

    // Hand-craft a file with one expired + one live session and the same key.
    const onDisk = JSON.parse(readFileSync(authFile(root), 'utf8'));
    onDisk.sessions.push({ token: 'a'.repeat(64), expiresAt: Date.now() - 1000 });
    writeFileSync(authFile(root), JSON.stringify(onDisk), 'utf8');

    const a2 = new DashboardAuth();
    a2.init(root);
    expect(a2.getKey()).toBe(key); // key kept
    expect(a2.validateSession(liveToken)).toBe(true); // live session kept
    expect(a2.validateSession('a'.repeat(64))).toBe(false); // expired pruned

    // The pruned expired session must not linger on disk after init re-persist.
    const after = JSON.parse(readFileSync(authFile(root), 'utf8'));
    expect(after.sessions.some((s: { token: string }) => s.token === 'a'.repeat(64))).toBe(false);
  });

  it('regenerates a fresh key when no file is persisted', () => {
    const root = makeRoot();
    const auth = new DashboardAuth();
    auth.init(root);
    expect(auth.getKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(existsSync(authFile(root))).toBe(true);
  });

  it('fails closed (regenerates) on a corrupt auth file', () => {
    const root = makeRoot();
    writeFileSync(authFile(root), '{ not valid json', 'utf8');

    const auth = new DashboardAuth();
    auth.init(root);
    expect(auth.getKey()).toMatch(/^[0-9a-f]{32}$/); // minted fresh, no throw
  });

  it('fails closed on a stale/invalid shape (wrong version, bad key)', () => {
    const root = makeRoot();
    writeFileSync(
      authFile(root),
      JSON.stringify({ version: 99, key: 'not-hex', sessions: [] }),
      'utf8',
    );

    const auth = new DashboardAuth();
    auth.init(root);
    expect(auth.getKey()).toMatch(/^[0-9a-f]{32}$/);
    expect(auth.getKey()).not.toBe('not-hex');
  });

  it('stays in-memory (no file) when init() is called without a projectRoot', () => {
    const root = makeRoot();
    const auth = new DashboardAuth();
    auth.init(); // memory-only mode
    auth.createSession(auth.getKey());
    expect(existsSync(authFile(root))).toBe(false);
  });

  it('fails closed when the file lists more than MAX_SESSIONS sessions', () => {
    // A persisted file with 60 future-dated sessions exceeds the MAX_SESSIONS (50)
    // cap enforced by isPersistedAuth — the file must be rejected and a fresh key
    // + empty session set minted instead (fail-closed).
    const root = makeRoot();
    const auth = new DashboardAuth();
    auth.init(root);
    const originalKey = auth.getKey();

    // Write a tampered file: 60 valid-looking future-dated sessions.
    const tamperedSessions = Array.from({ length: 60 }, (_, i) => ({
      token: String(i).padStart(64, 'a'),
      expiresAt: Date.now() + 60_000,
    }));
    writeFileSync(
      authFile(root),
      JSON.stringify({ version: 1, key: originalKey, sessions: tamperedSessions }),
      'utf8',
    );

    const auth2 = new DashboardAuth();
    auth2.init(root);
    // Must have regenerated — old key is NOT reused.
    expect(auth2.getKey()).not.toBe(originalKey);
    expect(auth2.getKey()).toMatch(/^[0-9a-f]{32}$/);
    // Sessions must be empty after fail-closed reset.
    const onDisk = JSON.parse(readFileSync(authFile(root), 'utf8'));
    expect(onDisk.sessions).toHaveLength(0);
  });

  it('fails closed when a session token is not 64 hex chars', () => {
    // Tokens that are wrong length or contain non-hex chars must be rejected.
    const root = makeRoot();
    const auth = new DashboardAuth();
    auth.init(root);
    const originalKey = auth.getKey();

    const badCases = [
      // 63 chars — one short
      { token: 'a'.repeat(63), expiresAt: Date.now() + 60_000 },
    ];
    writeFileSync(
      authFile(root),
      JSON.stringify({ version: 1, key: originalKey, sessions: badCases }),
      'utf8',
    );

    const auth2 = new DashboardAuth();
    auth2.init(root);
    expect(auth2.getKey()).not.toBe(originalKey);
    expect(auth2.getKey()).toMatch(/^[0-9a-f]{32}$/);

    // Also verify a non-hex token is rejected.
    const root2 = makeRoot();
    const auth3 = new DashboardAuth();
    auth3.init(root2);
    const key3 = auth3.getKey();
    writeFileSync(
      authFile(root2),
      JSON.stringify({
        version: 1,
        key: key3,
        sessions: [{ token: 'z'.repeat(64), expiresAt: Date.now() + 60_000 }],
      }),
      'utf8',
    );
    const auth4 = new DashboardAuth();
    auth4.init(root2);
    expect(auth4.getKey()).not.toBe(key3);
    expect(auth4.getKey()).toMatch(/^[0-9a-f]{32}$/);
  });

  it('regenerateKey() clears sessions and re-persists', () => {
    const root = makeRoot();
    const auth = new DashboardAuth();
    auth.init(root);
    const token = auth.createSession(auth.getKey())!;
    const oldKey = auth.getKey();

    auth.regenerateKey();
    expect(auth.getKey()).not.toBe(oldKey);
    expect(auth.validateSession(token)).toBe(false);

    // A restart picks up the new key, not the old one.
    const a2 = new DashboardAuth();
    a2.init(root);
    expect(a2.getKey()).toBe(auth.getKey());
  });
});
