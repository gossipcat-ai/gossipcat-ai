import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export type MemoryHygieneSeedResult =
  | { action: 'appended' }
  | { action: 'already-present' }
  | { action: 'skipped-no-claude-md' }
  | { action: 'error'; error: string };

/**
 * Idempotently seed the project CLAUDE.md with the gossipcat memory hygiene
 * convention block. See docs/specs/2026-04-17-memory-hygiene-propagation.md.
 *
 * Behavior:
 * - If CLAUDE.md does not exist: skip silently (do NOT create one).
 * - If "## Memory hygiene" heading is already present (case-insensitive, line-start):
 *   no-op.
 * - Otherwise: append the canonical block.
 */
export function seedMemoryHygiene(projectRoot: string): MemoryHygieneSeedResult {
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  try {
    if (!existsSync(claudeMdPath)) {
      return { action: 'skipped-no-claude-md' };
    }
    const existing = readFileSync(claudeMdPath, 'utf-8');
    if (/^## memory hygiene/im.test(existing)) {
      return { action: 'already-present' };
    }
    const block =
      '\n## Memory hygiene (gossipcat convention)\n\n' +
      'When saving a `project_*` memory, include a `status` field in the frontmatter:\n\n' +
      '- `status: open` — active backlog item, work in progress, or decision pending revisit\n' +
      '- `status: shipped` — the work it describes has landed; reference only\n' +
      '- `status: closed` — decision was made not to pursue; archive semantics\n\n' +
      'Without it, the dashboard defaults to "backlog" and applies staleness verification conservatively. See docs/specs/2026-04-17-memory-hygiene-propagation.md.\n';
    const sep = existing.endsWith('\n') ? '' : '\n';
    writeFileSync(claudeMdPath, existing + sep + block, 'utf-8');
    return { action: 'appended' };
  } catch (e) {
    return { action: 'error', error: (e as Error).message };
  }
}
