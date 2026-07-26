/**
 * Issue #670 f2 — the `_project` merge must not degrade existing recall.
 *
 * `search('_project')` concatenates two surfaces scored by INCOMPARABLE
 * functions: BM25 over the `~/.claude` corpus (saturating, top observed ≈33) and
 * the local `scoreContent` (unbounded upward: up to 10 per keyword ×
 * MAX_KEYWORDS × importance). One global sort + `slice(0, limit)` therefore let
 * generic in-repo session/consensus knowledge dumps — and `tasks.jsonl` dispatch
 * rows — displace curated corpus hits.
 *
 * Fix under test: the in-repo surface is CAPPED to `lesson-*.md`, the artifact
 * the merge was added for (issue #668 §3). Anything else in
 * `.gossip/agents/_project/memory/` is invisible to a `_project` query, so every
 * query that does not match a lesson card returns exactly what it returned
 * before the merge existed. No score normalization is invented.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MemorySearcher } from '../../packages/orchestrator/src/memory-searcher';
import { PROJECT_LESSON_AGENT_ID } from '../../packages/orchestrator/src/memory-writer';

const roots: string[] = [];
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'gossip-project-surface-'));
  roots.push(r);
  return r;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const QUERY = 'consensus cross review relay window expired';

/** Seed `_project` memory with one session dump, one dispatch row, one lesson card. */
function seedProjectMemory(root: string, agentId = PROJECT_LESSON_AGENT_ID): void {
  const memDir = join(root, '.gossip', 'agents', agentId, 'memory');
  const kDir = join(memDir, 'knowledge');
  mkdirSync(kDir, { recursive: true });

  // A generic session knowledge dump — high `scoreContent` because it repeats
  // every keyword; exactly the shape that displaced curated corpus hits.
  writeFileSync(join(kDir, 'session-2026-07-20.md'), [
    '---',
    'name: session dump',
    'description: consensus cross review relay window expired notes',
    'importance: 1',
    '---',
    'consensus consensus consensus cross cross review review relay relay window window expired expired',
  ].join('\n'));

  writeFileSync(join(kDir, 'lesson-session.s1.relay-window-expired.deadbeef.md'), [
    '---',
    'name: lesson-operational_lesson-session.s1',
    'description: relay window expired before the consensus cross review landed',
    'type: lesson',
    'importance: 0.7',
    '---',
    '**Why it failed:** the relay window expired during cross review.',
  ].join('\n'));

  writeFileSync(join(memDir, 'tasks.jsonl'),
    JSON.stringify({ taskId: 't1', task: 'consensus cross review relay window expired dispatch', skills: [] }) + '\n');
}

describe('_project search surface is capped to lesson cards (issue #670 f2)', () => {
  it('does not surface generic session knowledge dumps', () => {
    const root = freshRoot();
    seedProjectMemory(root);
    const sources = new MemorySearcher(root).search(PROJECT_LESSON_AGENT_ID, QUERY, 10).map(r => r.source);
    expect(sources).not.toContain('session-2026-07-20.md');
  });

  it('does not surface tasks.jsonl dispatch rows', () => {
    const root = freshRoot();
    seedProjectMemory(root);
    const sources = new MemorySearcher(root).search(PROJECT_LESSON_AGENT_ID, QUERY, 10).map(r => r.source);
    expect(sources).not.toContain('tasks.jsonl');
  });

  it('still surfaces the cross-cutting lesson card — the reason the merge exists', () => {
    const root = freshRoot();
    seedProjectMemory(root);
    const sources = new MemorySearcher(root).search(PROJECT_LESSON_AGENT_ID, QUERY, 10).map(r => r.source);
    expect(sources).toEqual(['lesson-session.s1.relay-window-expired.deadbeef.md']);
  });

  it('a query matching NO lesson card returns the pre-merge result set (empty in-repo contribution)', () => {
    const root = freshRoot();
    seedProjectMemory(root);
    // "dispatch" appears only in the session dump / tasks.jsonl, never in a card.
    const results = new MemorySearcher(root).search(PROJECT_LESSON_AGENT_ID, 'dispatch worktree bundle zod', 10);
    expect(results).toEqual([]);
  });

  it('the cap is _project-only — a normal agent still sees its full memory dir', () => {
    const root = freshRoot();
    seedProjectMemory(root, 'sonnet-reviewer');
    const sources = new MemorySearcher(root).search('sonnet-reviewer', QUERY, 10).map(r => r.source);
    expect(sources).toContain('session-2026-07-20.md');
    expect(sources).toContain('tasks.jsonl');
    expect(sources).toContain('lesson-session.s1.relay-window-expired.deadbeef.md');
  });
});
