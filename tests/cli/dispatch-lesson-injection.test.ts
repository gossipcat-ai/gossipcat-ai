// tests/cli/dispatch-lesson-injection.test.ts
//
// Issue #669 — the native dispatch path splices the RECALLED LESSONS block into
// an ALREADY-ASSEMBLED prompt (post warm-cache), so this exercises the splice
// contract that `maybeInjectLessons` in apps/cli/src/handlers/dispatch.ts relies
// on: the block lands before the trailing `Task:` segment and the task stays
// last.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assemblePrompt } from '../../packages/orchestrator/src/prompt-assembler';
import { MemoryWriter } from '../../packages/orchestrator/src/memory-writer';
import {
  selectLessons,
  renderLessonBlock,
  LESSON_CLAMP_LINE,
  LESSON_CONSENSUS_FORBIDDEN_CLAUSE,
} from '../../packages/orchestrator/src/lesson-injector';

const NATIVE_TASK_ANCHOR = '\n\n---\n\nTask: ';

const WORKTREE_TASK =
  'Rebuild the dist-mcp bundle after changing the mcp-server-sdk entrypoint and confirm the binary suites pass. You are working inside a git worktree.';
const OFF_DOMAIN_TASK =
  'Rename the CSS custom property --surface-muted to --surface-subtle across the stylesheet and update the two usages in the footer component.';

/** Mirror of maybeInjectLessons' splice (dispatch.ts). */
function splice(prompt: string, block: string): string {
  if (!block) return prompt;
  const anchor = prompt.lastIndexOf(NATIVE_TASK_ANCHOR);
  if (anchor < 0) return `${prompt}\n\n${block}`;
  return `${prompt.slice(0, anchor)}\n\n${block}${prompt.slice(anchor)}`;
}

function seed(): string {
  const root = mkdtempSync(join(tmpdir(), 'gossip-cli-lesson-'));
  new MemoryWriter(root).writeLessonCard('_project', {
    signal: 'operational_lesson',
    findingId: 'aa11bb22-cc33dd44:orchestrator:f1',
    finding: 'dist-mcp binary suites failed inside a git worktree and were reported as a real regression',
    lesson:
      'Never build or verify the dist-mcp bundle inside a git worktree — the nested packages/tools/node_modules/zod is unreachable, so the bundle collapses to one zod and crashes at import.',
    taskTokens: 'dist-mcp bundle worktree zod binary suites rebuild entrypoint',
    crossCutting: true,
  });
  return root;
}

/** Stand-in for the assembled (possibly warm-cached) native prompt. */
const nativePrompt = (task: string) =>
  assemblePrompt({ identity: '## Identity\nagent_id: impl-1', skills: 'SKILLS BODY', task });

describe('native dispatch lesson injection (issue #669)', () => {
  it('splices the block before the Task: tail for a matching task', () => {
    const root = seed();
    const lessons = selectLessons(root, 'impl-1', WORKTREE_TASK);
    expect(lessons.length).toBe(1);

    const out = splice(nativePrompt(WORKTREE_TASK), renderLessonBlock(lessons));
    expect(out).toContain('--- RECALLED LESSONS ---');
    expect(out).toContain(LESSON_CLAMP_LINE);
    expect(out.indexOf('--- RECALLED LESSONS ---')).toBeLessThan(out.lastIndexOf(NATIVE_TASK_ANCHOR));
    // Task must still be the final segment.
    expect(out.trimEnd().endsWith(WORKTREE_TASK)).toBe(true);
  });

  it('leaves the prompt byte-identical when nothing clears the relevance floor', () => {
    const root = seed();
    const lessons = selectLessons(root, 'impl-1', OFF_DOMAIN_TASK);
    expect(lessons).toEqual([]);

    const base = nativePrompt(OFF_DOMAIN_TASK);
    expect(splice(base, renderLessonBlock(lessons))).toBe(base);
    expect(base).not.toContain('RECALLED LESSONS');
  });

  it('carries the anti-anchoring FORBIDDEN clause on consensus dispatches', () => {
    const root = seed();
    const lessons = selectLessons(root, 'impl-1', WORKTREE_TASK);
    const out = splice(nativePrompt(WORKTREE_TASK), renderLessonBlock(lessons, { consensus: true }));
    expect(out).toContain(LESSON_CONSENSUS_FORBIDDEN_CLAUSE);
    expect(out).toContain('must NEVER produce an AGREE');
  });

  it('appends when the Task: anchor is absent (defensive fallback)', () => {
    const root = seed();
    const block = renderLessonBlock(selectLessons(root, 'impl-1', WORKTREE_TASK));
    const out = splice('PROMPT WITHOUT ANCHOR', block);
    expect(out.startsWith('PROMPT WITHOUT ANCHOR')).toBe(true);
    expect(out).toContain('--- RECALLED LESSONS ---');
  });
});
