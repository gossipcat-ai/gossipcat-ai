import { readdirSync } from 'fs';
import { join } from 'path';

const SKIP = new Set([
  'node_modules', 'build', 'out', '.git', '.gossip', 'coverage',
  '__pycache__', '.next', '.nuxt', 'vendor', 'target', 'tmp', 'cache', 'logs',
]);

const MAX_CHILDREN = 15;

function isSkipped(name: string): boolean {
  return SKIP.has(name) || name.startsWith('.') || name.startsWith('dist');
}

function sanitizeName(name: string): string {
  return name.replace(/[\r\n<>]/g, '_');
}

/**
 * Discover top-level project directories for LLM grounding.
 * Returns an array of "dirName/: child1, child2, ..." strings.
 * Names are sanitized to prevent prompt injection via malicious directory names.
 */
export function discoverProjectStructure(projectRoot: string): string[] {
  try {
    const parts: string[] = [];
    const entries = readdirSync(projectRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || isSkipped(entry.name)) continue;
      try {
        const allChildren = readdirSync(join(projectRoot, entry.name))
          .filter(f => !f.startsWith('.'));
        if (allChildren.length === 0) continue;
        const shown = allChildren.slice(0, MAX_CHILDREN).map(sanitizeName);
        const suffix = allChildren.length > MAX_CHILDREN
          ? `, ...${allChildren.length - MAX_CHILDREN} more`
          : '';
        parts.push(`${sanitizeName(entry.name)}/: ${shown.join(', ')}${suffix}`);
      } catch { /* unreadable child dir */ }
    }
    return parts;
  } catch {
    return [];
  }
}
