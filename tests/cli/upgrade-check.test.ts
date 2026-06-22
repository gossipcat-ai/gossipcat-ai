/**
 * Unit tests for the issue #452 upgrade-available check
 * (apps/cli/src/upgrade-check.ts): cached, opt-out, fail-silent npm-version
 * notice. Covers the pure semver compare, the sync cache reader, and the
 * fire-and-forget refresh (env opt-out, 24h freshness skip, fetch→write,
 * fail-silent on network error). Network is mocked — no real registry calls.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  getLastKnownLatest,
  checkForUpgrade,
  isUpgradeAvailable,
} from '../../apps/cli/src/upgrade-check';

const CACHE_REL = path.join('.gossip', 'upgrade-check.json');

function writeCache(dir: string, checkedAt: string, latestVersion: string): void {
  const p = path.join(dir, CACHE_REL);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ checkedAt, latestVersion }), 'utf8');
}

describe('isUpgradeAvailable', () => {
  it('true when latest is a strictly-greater major/minor/patch', () => {
    expect(isUpgradeAvailable('0.5.2', '0.5.3')).toBe(true);
    expect(isUpgradeAvailable('0.5.2', '0.6.0')).toBe(true);
    expect(isUpgradeAvailable('0.5.2', '1.0.0')).toBe(true);
  });

  it('false when equal or older', () => {
    expect(isUpgradeAvailable('0.5.2', '0.5.2')).toBe(false);
    expect(isUpgradeAvailable('0.5.2', '0.5.1')).toBe(false);
    expect(isUpgradeAvailable('1.0.0', '0.9.9')).toBe(false);
  });

  it('false when latest is null (cache miss)', () => {
    expect(isUpgradeAvailable('0.5.2', null)).toBe(false);
  });

  it("strips a leading 'v' on either side", () => {
    expect(isUpgradeAvailable('v0.5.2', '0.5.3')).toBe(true);
    expect(isUpgradeAvailable('0.5.2', 'v0.5.3')).toBe(true);
    expect(isUpgradeAvailable('v0.5.2', 'v0.5.2')).toBe(false);
  });

  it('ignores prerelease/build metadata when comparing the core x.y.z', () => {
    expect(isUpgradeAvailable('0.5.2', '0.5.2-beta.1')).toBe(false); // same core
    expect(isUpgradeAvailable('0.5.2-rc.1', '0.5.3')).toBe(true);
    expect(isUpgradeAvailable('0.5.2', '0.6.0+build.7')).toBe(true);
  });

  it('false on unparseable input (fewer than 3 numeric parts or non-numeric)', () => {
    expect(isUpgradeAvailable('0.5.2', '0.6')).toBe(false);
    expect(isUpgradeAvailable('garbage', '9.9.9')).toBe(false);
    expect(isUpgradeAvailable('0.5.2', 'latest')).toBe(false);
    expect(isUpgradeAvailable('0.5.2', '0.5.x')).toBe(false);
  });

  it('rejects empty version segments rather than coercing them to 0 (11e1156e f3)', () => {
    // Number('') === 0; without the strict /^\d+$/ guard, '1.2..9' would parse
    // as [1,2,0] and suppress a real upgrade. It must be rejected → false.
    expect(isUpgradeAvailable('0.5.2', '1.2..9')).toBe(false);
    expect(isUpgradeAvailable('0.5.2', '1..0')).toBe(false);
    expect(isUpgradeAvailable('0.5.2', '..')).toBe(false);
  });
});

describe('getLastKnownLatest', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-cache-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('returns the cached latestVersion when present', () => {
    writeCache(dir, new Date().toISOString(), '0.6.0');
    expect(getLastKnownLatest(dir)).toBe('0.6.0');
  });

  it('returns null when the cache file is missing', () => {
    expect(getLastKnownLatest(dir)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const p = path.join(dir, CACHE_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json', 'utf8');
    expect(getLastKnownLatest(dir)).toBeNull();
  });

  it('returns null when latestVersion is empty or missing', () => {
    writeCache(dir, new Date().toISOString(), '');
    expect(getLastKnownLatest(dir)).toBeNull();
  });
});

describe('checkForUpgrade', () => {
  let dir: string;
  const realFetch = global.fetch;
  const realEnv = process.env.GOSSIP_DISABLE_UPGRADE_CHECK;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-refresh-')); });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    global.fetch = realFetch;
    if (realEnv === undefined) delete process.env.GOSSIP_DISABLE_UPGRADE_CHECK;
    else process.env.GOSSIP_DISABLE_UPGRADE_CHECK = realEnv;
  });

  function mockFetch(impl: () => unknown): jest.Mock {
    const m = jest.fn(impl);
    (global as { fetch: unknown }).fetch = m;
    return m;
  }

  it('opt-out: GOSSIP_DISABLE_UPGRADE_CHECK=1 makes no network call and writes no cache', async () => {
    process.env.GOSSIP_DISABLE_UPGRADE_CHECK = '1';
    const m = mockFetch(() => { throw new Error('fetch should not be called'); });
    await checkForUpgrade(dir);
    expect(m).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, CACHE_REL))).toBe(false);
  });

  it('fresh cache (< 24h) skips the network', async () => {
    writeCache(dir, new Date().toISOString(), '0.6.0');
    const m = mockFetch(() => { throw new Error('fetch should not be called'); });
    await checkForUpgrade(dir);
    expect(m).not.toHaveBeenCalled();
    expect(getLastKnownLatest(dir)).toBe('0.6.0'); // unchanged
  });

  it('stale cache (> 24h) refreshes from the registry and writes the new version', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeCache(dir, stale, '0.5.0');
    const m = mockFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.7.0' }) }));
    await checkForUpgrade(dir);
    expect(m).toHaveBeenCalledTimes(1);
    expect(getLastKnownLatest(dir)).toBe('0.7.0');
  });

  it('missing cache refreshes and creates the cache file', async () => {
    mockFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '0.7.1' }) }));
    await checkForUpgrade(dir);
    expect(getLastKnownLatest(dir)).toBe('0.7.1');
  });

  it('fail-silent: a rejected fetch does not throw and writes no cache', async () => {
    mockFetch(() => Promise.reject(new Error('network down')));
    await expect(checkForUpgrade(dir)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(dir, CACHE_REL))).toBe(false);
  });

  it('fail-silent: a non-OK registry response does not write the cache', async () => {
    mockFetch(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    await checkForUpgrade(dir);
    expect(fs.existsSync(path.join(dir, CACHE_REL))).toBe(false);
  });
});
