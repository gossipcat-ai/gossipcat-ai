/**
 * Issue #670 f1 + f3 — the lesson-card filename must be INJECTIVE.
 *
 * Two distinct `finding_id`s that land on the same card silently destroy the
 * first lesson: the write at `memory-writer.ts` `writeLessonCard` is
 * unconditional, and the prune guard reads the collision as an idempotent
 * update, so nothing anywhere reports the loss.
 *
 * Both historical collision sources are pinned here. They FAIL on the pre-#670
 * implementation (`sanitizeTaskId` mapped `:` → `_`, then a bare 96-char slice):
 *
 *   1. separator/payload ambiguity — `_` was both the join character and a legal
 *      character INSIDE each component (`SAFE_NAME` = /^[a-z0-9][a-z0-9_-]{0,62}$/,
 *      skill-engine.ts:28), so `session:a_b:c` and `session:a:b_c` flattened to
 *      the same `session_a_b_c`.
 *   2. truncation — two ids sharing a 96-char flattened prefix collapsed
 *      regardless of underscores.
 *
 * This directly backs the contract asserted in
 * `apps/cli/src/handlers/operational-lesson-id.ts` (a third id component is
 * REJECTED "because silently dropping a component would make two different ids
 * collapse to one lesson card") — the collapse used to happen one layer down.
 */

import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  MemoryWriter,
  writeLessonCardsForSignals,
  lessonCardSlug,
  LESSON_ID_SEPARATOR,
  PROJECT_LESSON_AGENT_ID,
} from '../../packages/orchestrator/src/memory-writer';
import { SAFE_NAME } from '../../packages/orchestrator/src/skill-engine';

const roots: string[] = [];
function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'gossip-lesson-collision-'));
  roots.push(r);
  return r;
}
const knowledgeDir = (root: string, id: string) =>
  join(root, '.gossip', 'agents', id, 'memory', 'knowledge');

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function writeTwo(root: string, idA: string, idB: string, signal = 'operational_lesson'): string[] {
  const w = new MemoryWriter(root);
  w.writeLessonCard('agent', { signal, findingId: idA, finding: 'first', lesson: 'LESSON-A' });
  w.writeLessonCard('agent', { signal, findingId: idB, finding: 'second', lesson: 'LESSON-B' });
  return readdirSync(knowledgeDir(root, 'agent')).sort();
}

describe('lesson card filename injectivity (issue #670 f1)', () => {
  it('the flattening separator is a character SAFE_NAME can never emit', () => {
    // If this ever fails, the separator is also a payload char and every
    // injectivity guarantee below collapses.
    expect(SAFE_NAME.test(LESSON_ID_SEPARATOR)).toBe(false);
    expect(SAFE_NAME.test(`a${LESSON_ID_SEPARATOR}b`)).toBe(false);
  });

  it('underscore-ambiguous ids get distinct cards — session:a_b:c vs session:a:b_c', () => {
    // Both pass parseOperationalFindingId today: each component is SAFE_NAME.
    const idA = 'session:a_b:c';
    const idB = 'session:a:b_c';
    expect(SAFE_NAME.test('a_b')).toBe(true); // the char that used to be the separator

    const files = writeTwo(freshRoot(), idA, idB);
    expect(files).toHaveLength(2);
    expect(lessonCardSlug(idA)).not.toEqual(lessonCardSlug(idB));
  });

  it('neither underscore-ambiguous lesson is destroyed by the other', () => {
    const root = freshRoot();
    const files = writeTwo(root, 'session:a_b:c', 'session:a:b_c');
    const bodies = files.map(f => readFileSync(join(knowledgeDir(root, 'agent'), f), 'utf-8'));
    expect(bodies.some(b => b.includes('LESSON-A'))).toBe(true);
    expect(bodies.some(b => b.includes('LESSON-B'))).toBe(true);
  });

  it('ids sharing a 96-char flattened prefix get distinct cards (truncation)', () => {
    // 'session.' (8) + 63 a's + '.' + 24 b's === exactly 96 chars flattened, so
    // the distinguishing suffix used to be sliced off entirely.
    const head = `session:${'a'.repeat(63)}:${'b'.repeat(24)}`;
    const idA = `${head}-one`;
    const idB = `${head}-two`;
    expect(SAFE_NAME.test(`${'b'.repeat(24)}-one`)).toBe(true); // still a valid slug component

    const root = freshRoot();
    const files = writeTwo(root, idA, idB);
    expect(files).toHaveLength(2);
    const bodies = files.map(f => readFileSync(join(knowledgeDir(root, 'agent'), f), 'utf-8'));
    expect(bodies.some(b => b.includes('LESSON-A'))).toBe(true);
    expect(bodies.some(b => b.includes('LESSON-B'))).toBe(true);
  });

  it('applies uniformly to the CONSENSUS id shape', () => {
    // <8hex>-<8hex>:<agent>:fN — agent ids are SAFE_NAME too, so they carry the
    // same `_` ambiguity. One slug function, so this cannot regress separately.
    const idA = 'b81956b2-e0fa4ea4:sonnet_reviewer:f1';
    const idB = 'b81956b2-e0fa4ea4:sonnet:reviewer_f1';
    expect(lessonCardSlug(idA)).not.toEqual(lessonCardSlug(idB));

    const files = writeTwo(freshRoot(), idA, idB, 'hallucination_caught');
    expect(files).toHaveLength(2);
  });

  it('stays idempotent — the SAME finding_id still overwrites one card', () => {
    const root = freshRoot();
    const w = new MemoryWriter(root);
    const id = 'session:2026-07-26-a38286c2:relay-window-expired';
    w.writeLessonCard('agent', { signal: 'operational_lesson', findingId: id, finding: 'x', lesson: 'first' });
    w.writeLessonCard('agent', { signal: 'operational_lesson', findingId: id, finding: 'x', lesson: 'second' });
    const files = readdirSync(knowledgeDir(root, 'agent'));
    expect(files).toHaveLength(1);
    expect(readFileSync(join(knowledgeDir(root, 'agent'), files[0]), 'utf-8')).toContain('second');
  });

  it('slug stays path-safe and bounded', () => {
    const slug = lessonCardSlug('a/b:c*d?e:f1');
    expect(slug).not.toMatch(/[/\\:*?"<>|]/);
    // 96-char head + separator + 8 hex digest
    expect(lessonCardSlug(`session:${'a'.repeat(63)}:${'b'.repeat(60)}`)).toHaveLength(96 + 1 + 8);
    expect(lessonCardSlug('')).toBe('');
  });
});

describe('cross_cutting is gated to operational lessons (issue #670 f3)', () => {
  it('does NOT publish a per-agent hallucination_caught verdict into shared _project', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'hallucination_caught',
      agent_id: 'sonnet-reviewer',
      finding: 'Claimed method X missing but it exists',
      finding_id: 'b81956b2-e0fa4ea4:sonnet-reviewer:f1',
      lesson: 'asserted absence without reading the file',
      cross_cutting: true,
    }]);
    expect(existsSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID))).toBe(false);
    expect(readdirSync(knowledgeDir(root, 'sonnet-reviewer'))).toHaveLength(1);
  });

  it('still routes an operational_lesson to _project', () => {
    const root = freshRoot();
    writeLessonCardsForSignals(root, [{
      signal: 'operational_lesson', agent_id: 'orchestrator', finding: 'x',
      finding_id: 'session:s1:shared', lesson: 'everyone needs this', cross_cutting: true,
    }]);
    expect(readdirSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID))).toHaveLength(1);
    expect(existsSync(knowledgeDir(root, 'orchestrator'))).toBe(false);
  });

  it('logs when a reserved agent id silently loses its cross_cutting card', () => {
    const root = freshRoot();
    const written: string[] = [];
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    try {
      new MemoryWriter(root).writeLessonCard('_utility', {
        signal: 'operational_lesson', findingId: 'session:s1:blocked', finding: 'x',
        lesson: 'y', crossCutting: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(knowledgeDir(root, '_utility'))).toBe(false);
    expect(existsSync(knowledgeDir(root, PROJECT_LESSON_AGENT_ID))).toBe(false);
    expect(written.join('')).toContain('lesson card dropped');
    expect(written.join('')).toContain('_utility');
  });
});
