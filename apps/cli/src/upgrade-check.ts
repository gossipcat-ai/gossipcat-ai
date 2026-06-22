import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';

// Shape of the on-disk upgrade-check cache.
interface UpgradeCache {
  checkedAt: string; // ISO timestamp of the last successful registry fetch
  latestVersion: string; // version string reported by the npm registry
}

const CACHE_REL = join('.gossip', 'upgrade-check.json');
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cachePath(cwd: string): string {
  // Always derived from cwd — no external path input is accepted.
  return join(cwd, CACHE_REL);
}

/**
 * Dumb synchronous cache reader. Returns the last-known latest version string
 * from `.gossip/upgrade-check.json` under `cwd`, or null on any
 * missing-file / read / parse error. Makes NO network call and applies NO env
 * gating — the env opt-out lives in checkForUpgrade + the emit site.
 */
export function getLastKnownLatest(cwd: string = process.cwd()): string | null {
  try {
    const raw = readFileSync(cachePath(cwd), 'utf8');
    const data = JSON.parse(raw) as Partial<UpgradeCache>;
    return typeof data.latestVersion === 'string' && data.latestVersion.length > 0
      ? data.latestVersion
      : null;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget background refresh of the upgrade-check cache. Never throws
 * and never returns a meaningful value — callers should `void` it.
 *
 * - Returns immediately (no network) when GOSSIP_DISABLE_UPGRADE_CHECK === '1'.
 * - Returns immediately (no network) when a fresh (< 24h) cache already exists.
 * - Otherwise fetches the latest version from the npm registry and writes the
 *   cache atomically (temp file + rename). Every error path is swallowed.
 */
export async function checkForUpgrade(cwd: string = process.cwd()): Promise<void> {
  try {
    if (process.env.GOSSIP_DISABLE_UPGRADE_CHECK === '1') return;

    const path = cachePath(cwd);

    // Skip the network when a fresh cache is present.
    try {
      const raw = readFileSync(path, 'utf8');
      const data = JSON.parse(raw) as Partial<UpgradeCache>;
      if (typeof data.checkedAt === 'string') {
        const checkedMs = new Date(data.checkedAt).getTime();
        if (Number.isFinite(checkedMs) && Date.now() - checkedMs < TTL_MS) return;
      }
    } catch {
      // No cache / unreadable / unparseable → fall through to refresh.
    }

    // Same fetch shape as getLatestVersion in handlers/gossip-update.ts.
    const res = await fetch('https://registry.npmjs.org/gossipcat/latest');
    if (!res.ok) return;
    const json = (await res.json()) as { version?: unknown };
    if (typeof json.version !== 'string' || json.version.length === 0) return;

    const cache: UpgradeCache = {
      checkedAt: new Date().toISOString(),
      latestVersion: json.version,
    };

    // Atomic write: temp file in the same dir + rename.
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      // Directory may already exist or be uncreatable; the write below will
      // simply fail-silent if the dir is missing.
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    try {
      renameSync(tmp, path);
    } catch (err) {
      // Clean up the temp file so a failed rename (cross-device link, race)
      // doesn't leave .gossip/upgrade-check.json.<pid>.tmp residue accumulating.
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      throw err; // re-throw into the outer fail-silent catch
    }
  } catch {
    // Fail-silent: a background upgrade check must never break the caller.
  }
}

function parseSemver(v: string): [number, number, number] | null {
  // Strip leading 'v', drop prerelease (-) and build (+) metadata.
  const core = v.trim().replace(/^v/, '').split('-')[0].split('+')[0];
  const parts = core.split('.');
  if (parts.length < 3) return null;
  const seg = parts.slice(0, 3);
  // Each of the first three segments must be all-digits. Without this,
  // Number('') coerces to 0, so a malformed '1.2..9' would parse as [1,2,0]
  // instead of being rejected (consensus 11e1156e-febd4304 f3).
  if (!seg.every((p) => /^\d+$/.test(p))) return null;
  const nums = seg.map((p) => Number(p));
  return [nums[0], nums[1], nums[2]];
}

/**
 * Pure semver compare. Returns true iff `latest` is a strictly-greater x.y.z
 * than `current`. Returns false when latest is null or either side fails to
 * parse. Hand-rolled — no new dependency.
 */
export function isUpgradeAvailable(current: string, latest: string | null): boolean {
  if (!latest) return false;
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}
