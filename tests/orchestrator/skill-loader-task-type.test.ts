/**
 * Tests for the task_type axis on skill frontmatter + the dispatch-side
 * inference helper. Backlog item #3, builds on commit be825b2 (reactive
 * activation tuning + observability + LRU).
 *
 * Contract:
 *   - `task_type: any` (default for unlabelled skills) activates for every dispatch.
 *   - Concrete task_type values ('review'|'implement'|'research') are hard-rejected
 *     on mismatch BEFORE the keyword-hit threshold and category-boost gates.
 *   - Invalid / malformed values coerce to 'any' silently (mirrors `mode`).
 *   - `inferTaskType(task, writeMode)` classifies a dispatch into one of the
 *     three concrete types; 'any' is a skill-side sentinel only.
 */
import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { parseSkillFrontmatter } from '../../packages/orchestrator/src/skill-parser';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { inferTaskType } from '../../packages/orchestrator/src/task-type-inference';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Skill loader — task_type axis filter', () => {
  let tmpDir: string;
  let index: SkillIndex;

  /** Write a contextual skill file with an optional task_type line. */
  function writeSkill(name: string, taskTypeLine: string | null, keywords: string[] = ['authenticate']): void {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills');
    const body = [
      '---',
      `name: ${name}`,
      `description: ${name} skill`,
      `keywords: [${keywords.join(', ')}]`,
      'category: trust_boundaries',
      'mode: contextual',
      'status: active',
      ...(taskTypeLine !== null ? [taskTypeLine] : []),
      '---',
      '',
      `## ${name}`,
      `Body for ${name}.`,
      '',
    ].join('\n');
    writeFileSync(join(skillsDir, `${name}.md`), body);
    index.bind('test-agent', name, { source: 'auto', mode: 'contextual' });
  }

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-task-type-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, '.gossip', 'skills'), { recursive: true });
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: Backwards compat — no task_type means 'any' ───────────────────
  it('skill without task_type frontmatter defaults to any and activates for all dispatches', () => {
    writeSkill('legacy-skill', null);
    const task = 'authenticate the user session';

    const forReview = loadSkills('test-agent', [], tmpDir, index, task, [], 'review');
    const forImpl = loadSkills('test-agent', [], tmpDir, index, task, [], 'implement');
    const forResearch = loadSkills('test-agent', [], tmpDir, index, task, [], 'research');

    expect(forReview.activatedContextual).toContain('legacy-skill');
    expect(forImpl.activatedContextual).toContain('legacy-skill');
    expect(forResearch.activatedContextual).toContain('legacy-skill');
    // No task-type-mismatch drops on any of the three
    for (const result of [forReview, forImpl, forResearch]) {
      expect(result.dropped.find(d => d.reason === 'task-type-mismatch')).toBeUndefined();
    }
  });

  // ─── Test 2: Hard reject on mismatch ───────────────────────────────────────
  it('skill task_type=review + dispatch=implement → dropped as task-type-mismatch', () => {
    writeSkill('review-only-skill', 'task_type: review');
    const task = 'authenticate the user session';

    const result = loadSkills('test-agent', [], tmpDir, index, task, [], 'implement');

    expect(result.loaded).not.toContain('review-only-skill');
    expect(result.activatedContextual).not.toContain('review-only-skill');
    const drop = result.dropped.find(d => d.skill === 'review-only-skill');
    expect(drop).toBeDefined();
    expect(drop?.reason).toBe('task-type-mismatch');
    expect(drop?.hits).toBe(0);
  });

  // ─── Test 3: Match case activates ──────────────────────────────────────────
  it('skill task_type=implement + dispatch=implement → activates normally', () => {
    writeSkill('impl-skill', 'task_type: implement');
    const task = 'authenticate the user session';

    const result = loadSkills('test-agent', [], tmpDir, index, task, [], 'implement');

    expect(result.activatedContextual).toContain('impl-skill');
    expect(result.dropped.find(d => d.skill === 'impl-skill')).toBeUndefined();
  });

  // ─── Test 4: Invalid value silently coerces to 'any' ───────────────────────
  it('skill task_type=foobar coerces to any (silent) and activates for every dispatch', () => {
    writeSkill('bad-task-type', 'task_type: foobar');
    const task = 'authenticate the user session';

    // Parser-side check: coerced to 'any'
    const parsed = parseSkillFrontmatter([
      '---',
      'name: bad-task-type',
      'description: test',
      'keywords: [authenticate]',
      'status: active',
      'task_type: foobar',
      '---',
      'body',
    ].join('\n'));
    expect(parsed?.task_type).toBe('any');

    // Loader-side check: activates on implement dispatch despite invalid value
    const result = loadSkills('test-agent', [], tmpDir, index, task, [], 'implement');
    expect(result.activatedContextual).toContain('bad-task-type');
    expect(result.dropped.find(d => d.skill === 'bad-task-type')).toBeUndefined();
  });

  // ─── Test 5: Filter runs BEFORE keyword-hit gate ───────────────────────────
  it('mismatch drops with hits=0 even when the skill has matching keywords', () => {
    // The skill would match the task (keyword 'authenticate' in both), so
    // without the task_type filter it would activate. With the filter, it
    // must be dropped as task-type-mismatch, NOT as below-keyword-threshold.
    writeSkill('review-only-match', 'task_type: review', ['authenticate']);
    const task = 'authenticate the user session';

    const result = loadSkills('test-agent', [], tmpDir, index, task, [], 'implement');
    const drop = result.dropped.find(d => d.skill === 'review-only-match');
    expect(drop?.reason).toBe('task-type-mismatch');
    // hits=0 is the contract — filter returns early, keyword counting never runs
    expect(drop?.hits).toBe(0);
  });

  // ─── Test 6: dispatchTaskType undefined = filter skipped ───────────────────
  it('omitting dispatchTaskType skips the filter entirely (backwards-compat)', () => {
    writeSkill('review-only-skill', 'task_type: review');
    const task = 'authenticate the user session';

    // No 7th arg → filter off; skill activates even though it is review-only
    const result = loadSkills('test-agent', [], tmpDir, index, task, []);
    expect(result.activatedContextual).toContain('review-only-skill');
  });
});

describe('inferTaskType — pure helper', () => {
  // ─── Test 7: write_mode wins ───────────────────────────────────────────────
  it('writeMode=scoped → implement (beats any verb)', () => {
    expect(inferTaskType('refactor the X handler', 'scoped')).toBe('implement');
    // Even a review verb loses to scoped
    expect(inferTaskType('review the X handler', 'scoped')).toBe('implement');
  });

  it('writeMode=worktree → implement', () => {
    expect(inferTaskType('add a new endpoint', 'worktree')).toBe('implement');
  });

  it('writeMode=sequential → falls through to verb inference (NOT implement)', () => {
    // 'sequential' is a native/relay flag, not an authoring mode, so it must
    // NOT force 'implement'. Verb inference takes over.
    expect(inferTaskType('review the auth flow', 'sequential')).toBe('review');
    expect(inferTaskType('analyze the consensus flow', 'sequential')).toBe('research');
  });

  // ─── Test 8: research verb ─────────────────────────────────────────────────
  it('first word is a research verb → research', () => {
    expect(inferTaskType('analyze the consensus flow')).toBe('research');
    expect(inferTaskType('Investigate why the dashboard loses state')).toBe('research');
    expect(inferTaskType('trace the dispatch pipeline')).toBe('research');
    expect(inferTaskType('summarize the skill engine')).toBe('research');
    expect(inferTaskType('research prior art for ATI v3')).toBe('research');
  });

  // ─── Test 9: review verb ───────────────────────────────────────────────────
  it('first word is a review verb → review', () => {
    expect(inferTaskType('audit the auth handler')).toBe('review');
    expect(inferTaskType('Verify the migration')).toBe('review');
    expect(inferTaskType('check the config file')).toBe('review');
    expect(inferTaskType('Review the PR')).toBe('review');
    expect(inferTaskType('explain the error')).toBe('review');
    expect(inferTaskType('document the API')).toBe('review');
    expect(inferTaskType('list all endpoints')).toBe('review');
  });

  // ─── Test 10: default for unknown verbs ────────────────────────────────────
  it('unknown opening verb defaults to review (safe default)', () => {
    expect(inferTaskType('add a new feature X')).toBe('review');
    expect(inferTaskType('fix the regression')).toBe('review');
    expect(inferTaskType('please help me debug this')).toBe('review');
    expect(inferTaskType('')).toBe('review');
  });

  // ─── Test 11: leading whitespace tolerated ─────────────────────────────────
  it('leading whitespace does not break verb matching', () => {
    expect(inferTaskType('   analyze the pipeline')).toBe('research');
    expect(inferTaskType('\n\taudit the handler')).toBe('review');
  });
});
