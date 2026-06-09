import { recordAuthFailure, clearAuthFailure, readRecentAuthFailures } from '@gossip/orchestrator';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('auth-state', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gossip-auth-state-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('record → read returns the entry', () => {
    recordAuthFailure(root, 'anthropic', 401);
    const failures = readRecentAuthFailures(root);
    expect(failures).toHaveLength(1);
    expect(failures[0].provider).toBe('anthropic');
    expect(failures[0].status).toBe(401);
    expect(typeof failures[0].at).toBe('number');
  });

  it('records two providers, then clearing one leaves only the other', () => {
    recordAuthFailure(root, 'anthropic', 401);
    recordAuthFailure(root, 'google', 403);
    expect(readRecentAuthFailures(root).map(f => f.provider).sort()).toEqual(['anthropic', 'google']);

    clearAuthFailure(root, 'anthropic');
    const remaining = readRecentAuthFailures(root);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].provider).toBe('google');
    expect(remaining[0].status).toBe(403);
  });

  it('filters entries older than the 6h TTL', () => {
    // Write a stale entry directly (at = 7h ago).
    const dir = join(root, '.gossip');
    mkdirSync(dir, { recursive: true });
    const sevenHoursAgo = Date.now() - 7 * 60 * 60 * 1000;
    writeFileSync(
      join(dir, 'auth-state.json'),
      JSON.stringify({ deepseek: { status: 401, at: sevenHoursAgo } }, null, 2),
    );
    expect(readRecentAuthFailures(root)).toEqual([]);

    // A fresh entry alongside the stale one is still returned (stale filtered out).
    recordAuthFailure(root, 'openai', 403);
    const fresh = readRecentAuthFailures(root);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].provider).toBe('openai');
  });

  it('returns [] for a missing file without throwing', () => {
    expect(readRecentAuthFailures(root)).toEqual([]);
  });

  it('returns [] for a malformed file without throwing', () => {
    const dir = join(root, '.gossip');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'auth-state.json'), '{ this is not: valid json');
    expect(() => readRecentAuthFailures(root)).not.toThrow();
    expect(readRecentAuthFailures(root)).toEqual([]);
  });

  it('writes nothing for an invalid provider name', () => {
    recordAuthFailure(root, 'bad/name', 401);
    expect(existsSync(join(root, '.gossip', 'auth-state.json'))).toBe(false);
    expect(readRecentAuthFailures(root)).toEqual([]);
  });

  it('rejects an over-long provider name (>32 chars)', () => {
    recordAuthFailure(root, 'a'.repeat(33), 401);
    expect(readRecentAuthFailures(root)).toEqual([]);
  });

  it('is a safe no-op when projectRoot is undefined', () => {
    expect(() => recordAuthFailure(undefined, 'anthropic', 401)).not.toThrow();
    expect(() => clearAuthFailure(undefined, 'anthropic')).not.toThrow();
    expect(readRecentAuthFailures(undefined)).toEqual([]);
  });

  it('preserves existing entries on merge-write', () => {
    recordAuthFailure(root, 'anthropic', 401);
    recordAuthFailure(root, 'google', 403);
    const raw = JSON.parse(readFileSync(join(root, '.gossip', 'auth-state.json'), 'utf-8'));
    expect(Object.keys(raw).sort()).toEqual(['anthropic', 'google']);
  });

  it('returns failures sorted newest-first', () => {
    const dir = join(root, '.gossip');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(dir, 'auth-state.json'),
      JSON.stringify({
        older: { status: 401, at: now - 1000 },
        newer: { status: 403, at: now - 10 },
      }, null, 2),
    );
    const out = readRecentAuthFailures(root);
    expect(out.map(f => f.provider)).toEqual(['newer', 'older']);
  });

  it('skips structurally-valid entries with non-numeric at/status', () => {
    const dir = join(root, '.gossip');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(dir, 'auth-state.json'),
      JSON.stringify({
        good: { status: 401, at: now - 10 },
        badAt: { status: 401, at: 'not-a-number' },
        badStatus: { status: 'nope', at: now - 10 },
      }),
    );
    const out = readRecentAuthFailures(root);
    expect(out.map(f => f.provider)).toEqual(['good']);
  });

  it('keeps an entry just inside the TTL window and drops one just past it', () => {
    const dir = join(root, '.gossip');
    mkdirSync(dir, { recursive: true });
    const ttl = 6 * 60 * 60 * 1000;
    const now = Date.now();
    // 60s margins swamp any wall-clock drift between write and read.
    writeFileSync(
      join(dir, 'auth-state.json'),
      JSON.stringify({
        justInside: { status: 401, at: now - ttl + 60_000 },  // age < ttl → kept
        justPast: { status: 401, at: now - ttl - 60_000 },    // age > ttl → dropped
      }),
    );
    const providers = readRecentAuthFailures(root, ttl).map(f => f.provider);
    expect(providers).toContain('justInside');
    expect(providers).not.toContain('justPast');
  });
});
