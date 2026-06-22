/**
 * Single source of truth for gossipcat's own version.
 *
 * Previously, three code paths each read the version independently:
 *   - mcp-server-sdk.ts had a hardcoded literal (lied after every release)
 *   - gossip-update.ts walked `__dirname + ../../../../package.json` (fragile to
 *     install layout — fell through to '0.0.0' when globally installed)
 *   - gossip_bug_feedback read `process.cwd()/package.json` (wrong package
 *     entirely — returned the CALLING project's version when gossipcat was
 *     used via MCP from another repo)
 *
 * This helper walks up from __dirname until it finds a package.json whose
 * `name` is "gossipcat", which works across dev, global install, local dep,
 * and bundled layouts. Cached after first resolution.
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

let cached: string | null = null;

export function getGossipcatVersion(): string {
  if (cached !== null) return cached;
  cached = resolveVersion();
  return cached;
}

function resolveVersion(): string {
  let dir = __dirname;
  const root = resolve('/');
  // Hard cap on walk depth as a safety net against pathological layouts
  for (let i = 0; i < 20 && dir !== root; i++) {
    const candidate = resolve(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (pkg && pkg.name === 'gossipcat' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      } catch { /* keep walking — malformed package.json shouldn't stop us */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}
