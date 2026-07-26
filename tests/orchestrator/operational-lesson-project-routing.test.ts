/**
 * Issue #668 §1 + §3 — operator-authored process lessons.
 *
 *   §1: an `operational_lesson` signal produces a recallable lesson card, keyed
 *       by a session-scoped finding_id (no consensus round required).
 *   §3: `cross_cutting: true` files that card in the shared
 *       `.gossip/agents/_project/memory/knowledge/` instead of the recording
 *       agent's own dir, and it is retrievable from there.
 *
 * The routing is an EXPLICIT opt-in — nothing here infers "this looks
 * cross-cutting" from the lesson text.
 */

import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MemoryWriter,
  writeLessonCardsForSignals,
  OPERATIONAL_LESSON_SIGNALS,
  PROJECT_LESSON_AGENT_ID,
} from '../../packages/orchestrator/src/memory-writer';
import { MemorySearcher } from '../../packages/orchestrator/src/memory-searcher';

const roots: string[] = [];
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'gossip-op-lesson-'));
  roots.push(r);
  return r;
}
const knowledgeDir = (root: string, id: string) =>
  join(root, '.gossip', 'agents', id, 'memory', 'knowledge');

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WORKTREE_LESSON =
  'A dist-mcp bundle built inside a git worktree is always broken because the ' +
  'nested packages/tools/node_modules/zod is unreachable from a worktree.';

describe('operational_lesson → lesson card', () => {
  it('is registered as a lesson-producing signal', () => {
    expect(OPERATIONAL_LESSON_SIGNALS.has('operational_lesson')).toBe(true);
  });

  it('writes a card for a session-scoped finding_id with no consensus round', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson',
      agent_id: 'orchestrator',
      finding: 'Let four native relay windows expire',
      finding_id: 'session:2026-07-26-a38286c2:relay-window-expired',
      lesson: 'Relay windows expire; merged work then produces no cognitive summaries.',
    }]);
    const files = readdirSync(knowledgeDir(root, 'orchestrator'));
    expect(files).toEqual(['lesson-session_2026-07-26-a38286c2_relay-window-expired.md']);
    const body = readFileSync(join(knowledgeDir(root, 'orchestrator'), files[0]), 'utf-8');
    expect(body).toContain('type: lesson');
    expect(body).toContain('signal: operational_lesson');
    expect(body).toContain('**Why it failed:** Relay windows expire');
  });

  it('defaults to the recording agent when cross_cutting is absent', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson', agent_id: 'orchestrator', finding: 'x',
      finding_id: 'session:s1:not-shared', lesson: 'private to the orchestrator',
    }]);
    expect(existsSync(knowledgeDir(root, 'orchestrator'))).toBe(true);
    expect(existsSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID))).toBe(false);
  });

  it('still requires a finding_id', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson', agent_id: 'orchestrator', finding: 'x', lesson: 'y',
    }]);
    expect(existsSync(knowledgeDir(root, 'orchestrator'))).toBe(false);
  });
});

describe('cross-cutting lessons route to _project', () => {
  it('writes the card under _project, not the recording agent', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson',
      agent_id: 'orchestrator',
      finding: 'Built dist-mcp inside a worktree',
      finding_id: 'session:2026-07-26-a38286c2:worktree-dist-mcp-zod',
      lesson: WORKTREE_LESSON,
      cross_cutting: true,
    }]);
    expect(readdirSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID)))
      .toEqual(['lesson-session_2026-07-26-a38286c2_worktree-dist-mcp-zod.md']);
    expect(existsSync(knowledgeDir(root, 'orchestrator'))).toBe(false);
  });

  it('keeps provenance — agent is where it lives, origin_agent is who recorded it', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson', agent_id: 'orchestrator', finding: 'x',
      finding_id: 'session:s1:provenance', lesson: WORKTREE_LESSON, cross_cutting: true,
    }]);
    const dir = knowledgeDir(root, PROJECT_LESSON_AGENT_ID);
    const body = readFileSync(join(dir, readdirSync(dir)[0]), 'utf-8');
    expect(body).toContain(`agent: ${PROJECT_LESSON_AGENT_ID}`);
    expect(body).toContain('origin_agent: orchestrator');
  });

  it('is retrievable via a _project memory query', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson', agent_id: 'orchestrator',
      finding: 'Built dist-mcp inside a worktree; the bundle crashed on import',
      finding_id: 'session:2026-07-26-a38286c2:worktree-dist-mcp-zod',
      lesson: WORKTREE_LESSON, cross_cutting: true,
    }]);

    const results = new MemorySearcher(root).search(PROJECT_LESSON_AGENT_ID, 'worktree dist-mcp zod bundle', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toContain('worktree-dist-mcp-zod');
  });

  it('is NOT reachable from the recording agent\'s own query — that is the point', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson', agent_id: 'orchestrator', finding: 'x',
      finding_id: 'session:s1:worktree-dist-mcp-zod', lesson: WORKTREE_LESSON, cross_cutting: true,
    }]);
    expect(new MemorySearcher(root).search('orchestrator', 'worktree zod bundle', 5)).toEqual([]);
  });

  it('fail-closed: cross_cutting cannot unblock _system or _utility', () => {
    const root = freshRoot();
    for (const reserved of ['_system', '_utility']) {
      new MemoryWriter(root).writeLessonCard(reserved, {
        signal: 'operational_lesson', findingId: 'session:s1:blocked', finding: 'x',
        lesson: 'y', crossCutting: true,
      });
      expect(existsSync(knowledgeDir(root, reserved))).toBe(false);
    }
    expect(existsSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID))).toBe(false);
  });

  it('a NON-cross-cutting card for _project is still blocked (unchanged)', () => {
    const root = freshRoot();
    new MemoryWriter(root).writeLessonCard(PROJECT_LESSON_AGENT_ID, {
      signal: 'hallucination_caught', findingId: 'ab12cd34-ef56ab78:_project:f1', finding: 'x',
    });
    expect(existsSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID))).toBe(false);
  });
});
