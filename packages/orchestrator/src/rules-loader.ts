import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, join, dirname } from 'path';

/**
 * Resolve the bundled default rules file. We try multiple candidate paths
 * because esbuild bundles this module into dist-mcp/mcp-server.js, which
 * changes `__dirname` semantics relative to the source layout.
 *
 * Candidates (in order):
 *   1. <__dirname>/default-rules/gossipcat-rules.md
 *      — production: __dirname is dist-mcp/, build:mcp copies default-rules there
 *      — dev (ts-node): __dirname is packages/orchestrator/src/, file lives next to this module
 *   2. <__dirname>/../default-rules/gossipcat-rules.md
 *      — fallback for compiled-but-not-bundled layouts (packages/orchestrator/dist/)
 *   3. <cwd>/packages/orchestrator/src/default-rules/gossipcat-rules.md
 *      — last-resort dev fallback when running from monorepo root
 */
export function findBundledRules(): string | null {
  const candidates = [
    resolve(__dirname, 'default-rules', 'gossipcat-rules.md'),
    resolve(__dirname, '..', 'default-rules', 'gossipcat-rules.md'),
    resolve(process.cwd(), 'packages', 'orchestrator', 'src', 'default-rules', 'gossipcat-rules.md'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * On first boot, materialize `.gossip/rules.md` from the bundled default if
 * it doesn't already exist. This gives consumer projects ONE source of truth
 * at runtime that they can edit, while still shipping sane defaults.
 */
export function ensureRulesFile(projectRoot: string): { created: boolean; path: string | null } {
  const target = join(projectRoot, '.gossip', 'rules.md');
  if (existsSync(target)) return { created: false, path: target };

  const bundled = findBundledRules();
  if (!bundled) return { created: false, path: null };

  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(bundled, target);
    return { created: true, path: target };
  } catch {
    return { created: false, path: null };
  }
}

/**
 * Read the project's rules file (`.gossip/rules.md`), falling back to the
 * bundled default if missing. Returns null only if BOTH are unavailable.
 */
export function readRulesContent(projectRoot: string): string | null {
  const local = join(projectRoot, '.gossip', 'rules.md');
  if (existsSync(local)) {
    try { return readFileSync(local, 'utf-8'); } catch { /* fall through */ }
  }
  const bundled = findBundledRules();
  if (bundled) {
    try { return readFileSync(bundled, 'utf-8'); } catch { /* fall through */ }
  }
  return null;
}
