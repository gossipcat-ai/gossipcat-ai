// tests/cli/dispatch-lesson-injection.test.ts
//
// Issue #669 / PR #671 rework — the native dispatch paths inject the RECALLED
// LESSONS block at ASSEMBLY time (`assemblePrompt({ retrievedLessons })` on a
// cold miss, `composeWarmBody` on a warm hit) rather than string-splicing it
// into a finished prompt at `lastIndexOf('\n\n---\n\nTask: ')`.
//
// Two defects are regression-tested here:
//   1. a brief that QUOTES a prior prompt carries the splice anchor as CONTENT,
//      so the old splice landed the block inside the quoted material;
//   2. the old splice ran after `assemblePrompt` had enforced
//      MAX_ASSEMBLED_PROMPT_CHARS, so the native paths bypassed the 30K cap
//      while the relay path (retrievedLessons, priority 3) was protected.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assemblePrompt, MAX_ASSEMBLED_PROMPT_CHARS } from '../../packages/orchestrator/src/prompt-assembler';
import { MemoryWriter } from '../../packages/orchestrator/src/memory-writer';
import { splitAssembledPrompt } from '../../apps/cli/src/handlers/dispatch-prompt-cache';
import { composeWarmBody } from '../../apps/cli/src/handlers/dispatch';
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

/** The old, removed implementation — kept so the regression is demonstrable. */
function legacySplice(prompt: string, block: string): string {
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

/** Mirror of the native cold path: assemble, with and without lessons. */
const nativeParts = (task: string) => ({
  identity: '## Identity\nagent_id: impl-1',
  skills: 'SKILLS BODY',
  task,
});

describe('native dispatch lesson injection (issue #669)', () => {
  it('places the block before the Task: tail via retrievedLessons', () => {
    const root = seed();
    const lessons = selectLessons(root, 'impl-1', WORKTREE_TASK);
    expect(lessons.length).toBe(1);

    const out = assemblePrompt({
      ...nativeParts(WORKTREE_TASK),
      retrievedLessons: renderLessonBlock(lessons),
    });
    expect(out).toContain('--- RECALLED LESSONS ---');
    expect(out).toContain(LESSON_CLAMP_LINE);
    expect(out.indexOf('--- RECALLED LESSONS ---')).toBeLessThan(out.lastIndexOf(NATIVE_TASK_ANCHOR));
    expect(out.trimEnd().endsWith(WORKTREE_TASK)).toBe(true);
  });

  it('leaves the prompt byte-identical when nothing clears the relevance floor', () => {
    const root = seed();
    const lessons = selectLessons(root, 'impl-1', OFF_DOMAIN_TASK);
    expect(lessons).toEqual([]);

    const base = assemblePrompt(nativeParts(OFF_DOMAIN_TASK));
    const block = renderLessonBlock(lessons);
    expect(block).toBe('');
    expect(assemblePrompt({ ...nativeParts(OFF_DOMAIN_TASK), retrievedLessons: block || undefined })).toBe(base);
    expect(base).not.toContain('RECALLED LESSONS');
  });

  it('carries the anti-anchoring FORBIDDEN clause on consensus dispatches', () => {
    const root = seed();
    const lessons = selectLessons(root, 'impl-1', WORKTREE_TASK);
    const out = assemblePrompt({
      ...nativeParts(WORKTREE_TASK),
      retrievedLessons: renderLessonBlock(lessons, { consensus: true }),
    });
    expect(out).toContain(LESSON_CONSENSUS_FORBIDDEN_CLAUSE);
    expect(out).toContain('must NEVER produce an AGREE');
  });

  // ── Blocker 4a: the splice anchor is CONTENT, not structure ──────────────
  it('does not land the block inside a brief that QUOTES the splice anchor', () => {
    const root = seed();
    // A review brief that reproduces a prior dispatch prompt verbatim — the
    // quoted text carries the same `\n\n---\n\nTask: ` bytes the old splice
    // searched for with lastIndexOf.
    const quotingTask =
      'Review the prompt we sent last round for anchor fragility. It read:\n\n---\n\nTask: '
      + 'Rebuild the dist-mcp bundle inside a git worktree and confirm the binary suites pass.\n\n'
      + 'Explain why the mcp-server-sdk entrypoint zod resolution collapses.';
    const lessons = selectLessons(root, 'impl-1', quotingTask);
    expect(lessons.length).toBeGreaterThan(0);
    const block = renderLessonBlock(lessons);

    const assembled = assemblePrompt({ ...nativeParts(quotingTask), retrievedLessons: block });
    // The block sits before the REAL task segment, which is the one the
    // assembler emitted — i.e. before the first `Task:` of the quoted brief.
    const blockAt = assembled.indexOf('--- RECALLED LESSONS ---');
    const realTaskAt = assembled.indexOf(`Task: ${quotingTask}`);
    expect(blockAt).toBeGreaterThan(-1);
    expect(blockAt).toBeLessThan(realTaskAt);

    // Proof of the defect: the removed lastIndexOf splice puts the block INSIDE
    // the quoted material, after the real task segment has already begun.
    const legacy = legacySplice(assemblePrompt(nativeParts(quotingTask)), block);
    expect(legacy.indexOf('--- RECALLED LESSONS ---')).toBeGreaterThan(
      legacy.indexOf(`Task: ${quotingTask.slice(0, 40)}`),
    );
  });

  // ── Blocker 4b: the 30K cap ─────────────────────────────────────────────
  it('respects MAX_ASSEMBLED_PROMPT_CHARS on the cold path', () => {
    const root = seed();
    const bigTask = `${WORKTREE_TASK} ${'context filler '.repeat(2000)}`;
    const block = renderLessonBlock(selectLessons(root, 'impl-1', bigTask));
    expect(block).not.toBe('');

    const out = assemblePrompt({
      identity: '## Identity\nagent_id: impl-1',
      skills: 'S'.repeat(40_000),
      memory: 'M'.repeat(20_000),
      task: bigTask,
      retrievedLessons: block,
    });
    expect(out.length).toBeLessThanOrEqual(MAX_ASSEMBLED_PROMPT_CHARS + bigTask.length);

    // Proof of the defect: the removed post-assembly splice added the block on
    // top of an already-capped body, so the native paths overshot by exactly
    // the block length while the relay path did not.
    const capped = assemblePrompt({
      identity: '## Identity\nagent_id: impl-1',
      skills: 'S'.repeat(40_000),
      memory: 'M'.repeat(20_000),
      task: bigTask,
    });
    expect(legacySplice(capped, block).length).toBe(capped.length + block.length + 2);
  });

  it('drops the block on a warm hit that would exceed the cap', () => {
    const tail = '\n\nTask: do the thing';
    const block = '--- RECALLED LESSONS ---\nbody\n--- END RECALLED LESSONS ---';
    // The cached skills-section was sized by assemblePrompt against a DIFFERENT
    // task, so its priority-drop pass cannot account for this dispatch.
    const tight = 'S'.repeat(MAX_ASSEMBLED_PROMPT_CHARS - 50) + '\n\n---';
    expect(composeWarmBody(tight, tail, block)).toBe(tight + tail);
    // …and it is kept when there is room.
    const roomy = 'S'.repeat(1000) + '\n\n---';
    expect(composeWarmBody(roomy, tail, block)).toContain('--- RECALLED LESSONS ---');
  });

  // ── Warm/cold parity ────────────────────────────────────────────────────
  it('composes a warm body byte-identical to the cold assembly', () => {
    const root = seed();
    const block = renderLessonBlock(selectLessons(root, 'impl-1', WORKTREE_TASK));
    expect(block).not.toBe('');

    const cold = assemblePrompt({ ...nativeParts(WORKTREE_TASK), retrievedLessons: block });
    // The cache stores the LESSON-FREE assembly, split at `\n\nTask:`.
    const { skillsSection, taskBlock } = splitAssembledPrompt(
      assemblePrompt(nativeParts(WORKTREE_TASK)),
      `\n\nTask: ${WORKTREE_TASK}`,
    );
    expect(taskBlock).not.toBe('');
    expect(composeWarmBody(skillsSection, taskBlock, block)).toBe(cold);
    // …and without lessons the warm body is unchanged.
    expect(composeWarmBody(skillsSection, taskBlock)).toBe(assemblePrompt(nativeParts(WORKTREE_TASK)));
  });
});
