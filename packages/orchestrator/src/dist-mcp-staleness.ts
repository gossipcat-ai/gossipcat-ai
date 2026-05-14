import { existsSync, statSync, readdirSync, appendFileSync } from 'fs';
import { join, dirname, resolve } from 'path';

export interface StalenessResult {
  stale: boolean;
  deltaMs: number;
  newestSrc?: string;
  bundlePath?: string;
  skipped: 'installed' | 'no-bundle' | 'suppressed' | null;
}

const SRC_ROOTS = ['packages/orchestrator/src', 'apps/cli/src'];

function walk(dir: string, onFile: (path: string, mtimeMs: number) => void): void {
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf-8' }) as import('fs').Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile() && name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      try {
        onFile(full, statSync(full).mtimeMs);
      } catch { /* skip unreadable */ }
    }
  }
}

let cached: StalenessResult | null = null;

export function checkDistMcpStaleness(bundlePath?: string): StalenessResult {
  if (cached) return cached;
  if (process.env.GOSSIPCAT_SUPPRESS_STALENESS === '1') {
    return (cached = { stale: false, deltaMs: 0, skipped: 'suppressed' });
  }
  if (!bundlePath) {
    // Called without explicit path before cache populated — caller (e.g. bootstrap) is
    // a downstream consumer; the boot-time site in mcp-server-sdk.ts is responsible for
    // priming the cache. Return a benign skip rather than guessing the bundle location.
    return { stale: false, deltaMs: 0, skipped: 'no-bundle' };
  }

  // Bundle lives at <repoRoot>/dist-mcp/mcp-server.js → repoRoot = dirname(dirname(bundle))
  const repoRoot = dirname(dirname(resolve(bundlePath)));

  // Skip if bundle absent (cleaned tree; check has nothing to assess)
  let bundleMtime: number;
  try {
    bundleMtime = statSync(bundlePath).mtimeMs;
  } catch {
    return (cached = { stale: false, deltaMs: 0, skipped: 'no-bundle' });
  }

  // Skip-on-installed: package.json files[] excludes src/ — if no src tree exists,
  // we're in an npm-installed layout, not a dev clone. Never warn end users.
  for (const root of SRC_ROOTS) {
    if (!existsSync(join(repoRoot, root))) {
      return (cached = { stale: false, deltaMs: 0, skipped: 'installed' });
    }
  }

  let newestMtime = 0;
  let newestPath: string | undefined;
  for (const root of SRC_ROOTS) {
    walk(join(repoRoot, root), (path, mtimeMs) => {
      if (mtimeMs > newestMtime) {
        newestMtime = mtimeMs;
        newestPath = path;
      }
    });
  }

  const deltaMs = newestMtime - bundleMtime;
  return (cached = {
    stale: bundleMtime < newestMtime,
    deltaMs,
    newestSrc: newestPath,
    bundlePath,
    skipped: null,
  });
}

export function resetStalenessCache(): void {
  cached = null;
}

export function formatStalenessWarning(result: StalenessResult): string | null {
  if (!result.stale || result.skipped) return null;
  const mins = Math.round(result.deltaMs / 60000);
  const ageLabel = mins < 60 ? `${mins}m` : mins < 1440 ? `${(mins / 60).toFixed(1)}h` : `${(mins / 1440).toFixed(1)}d`;
  const newest = result.newestSrc ? ` (newest: ${result.newestSrc.split('/src/')[1] ?? result.newestSrc})` : '';
  return `dist-mcp/mcp-server.js is ${ageLabel} older than source${newest} — run \`npm run build:mcp\` and \`/mcp\` reconnect`;
}

export function logStalenessToMcpLog(result: StalenessResult, projectRoot: string): void {
  const msg = formatStalenessWarning(result);
  if (!msg) return;
  try {
    appendFileSync(join(projectRoot, '.gossip', 'mcp.log'), `[gossipcat] ⚠ ${msg}\n`);
  } catch { /* never break boot on a log-write failure */ }
}

export function renderStalenessBanner(result: StalenessResult): string {
  const msg = formatStalenessWarning(result);
  if (!msg) return '';
  return `> ⚠ **Bundle staleness:** ${msg}\n\n`;
}
