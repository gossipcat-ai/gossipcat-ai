/**
 * Tests for the scope axis on skill frontmatter — finding c8977bda-37564212:f3.
 *
 * The scope axis is a third loading mode distinct from `mode: permanent` and
 * `mode: contextual`. A skill with `scope: [review, research]` frontmatter
 * loads on EVERY dispatch whose task_type is in the scope list — no keyword
 * matching, no contextual budget consumed.
 *
 * Contract assertions:
 *   (a) scope=['review'] loads on review tasks regardless of task keywords.
 *   (b) scope=['review'] does NOT load on implement or research tasks.
 *   (c) scoped skills do NOT count against MAX_CONTEXTUAL_SKILLS budget.
 *   (d) scoped skills appear in loadedScoped[] and loaded[] but NOT in
 *       activatedContextual[] (separate axis).
 *   (e) scope-mismatch is recorded as 'scope-type-mismatch' in dropped[].
 *   (f) multi-type scope ['review', 'research'] activates for both types.
 *   (g) mode:permanent contract unchanged: still always-loads.
 *   (h) When dispatchTaskType is undefined, scope-declared skills load
 *       unconditionally (backwards-compat parity with task_type filter).
 *   (i) scope parsing: single value, bracket list, invalid token silently dropped.
 */
import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { parseSkillFrontmatter } from '../../packages/orchestrator/src/skill-parser';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Skill loader — scope axis (cross-cutting task-type-aware always-load)', () => {
  let tmpDir: string;
  let index: SkillIndex;

  /**
   * Write a skill file to the agent's local skills directory and bind it in
   * the index.
   */
  function writeSkill(
    name: string,
    frontmatterLines: string[],
    body = `## ${name}\nBody.`,
  ): void {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills');
    const content = ['---', `name: ${name}`, `description: ${name} skill`, 'status: active', ...frontmatterLines, '---', '', body, ''].join('\n');
    writeFileSync(join(skillsDir, `${name}.md`), content);
    // Bind with source:auto, mode:contextual — the scope axis should take
    // precedence over the slot mode so any legacy slot value is irrelevant.
    index.bind('test-agent', name, { source: 'auto', mode: 'contextual' });
  }

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-scope-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, '.gossip', 'skills'), { recursive: true });
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── (a) scope=['review'] loads on review tasks regardless of keywords ────
  it('(a) scope=[review] activates on review dispatch even when task has no matching keywords', () => {
    // No keywords field — would fail contextual keyword gate. scope bypasses it.
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);

    // Task deliberately has no citation-related keywords
    const result = loadSkills('test-agent', [], tmpDir, index, 'Audit the auth handler for injection bugs', [], 'review');

    expect(result.loaded).toContain('citation-integrity');
    expect(result.loadedScoped).toContain('citation-integrity');
    expect(result.dropped.find(d => d.skill === 'citation-integrity')).toBeUndefined();
  });

  // ─── (b) scope=['review'] does NOT load on implement or research tasks ────
  it('(b) scope=[review] is dropped as scope-type-mismatch on implement dispatch', () => {
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);

    const result = loadSkills('test-agent', [], tmpDir, index, 'Implement the auth handler', [], 'implement');

    expect(result.loaded).not.toContain('citation-integrity');
    expect(result.loadedScoped).not.toContain('citation-integrity');
    const drop = result.dropped.find(d => d.skill === 'citation-integrity');
    expect(drop).toBeDefined();
    expect(drop?.reason).toBe('scope-type-mismatch');
    expect(drop?.hits).toBe(0);
  });

  it('(b) scope=[review] is dropped as scope-type-mismatch on research dispatch', () => {
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);

    const result = loadSkills('test-agent', [], tmpDir, index, 'Analyze the auth handler', [], 'research');

    expect(result.loaded).not.toContain('citation-integrity');
    const drop = result.dropped.find(d => d.skill === 'citation-integrity');
    expect(drop?.reason).toBe('scope-type-mismatch');
  });

  // ─── (c) scoped skills do NOT count against contextual budget ─────────────
  it('(c) scope skill does not consume contextual budget slots', () => {
    // Fill contextual budget with 3 keyword-matching skills (MAX_CONTEXTUAL_SKILLS=3)
    for (const name of ['ctx-a', 'ctx-b', 'ctx-c']) {
      writeSkill(name, ['mode: contextual', 'keywords: [review, code, auth]']);
    }
    // Add a scope-review skill — should load REGARDLESS of the 3-slot budget
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);

    const task = 'Review the auth code';
    const result = loadSkills('test-agent', [], tmpDir, index, task, [], 'review');

    // Contextual budget is consumed by ctx-a/b/c
    expect(result.activatedContextual.length).toBe(3);
    // scope skill loads on top of the budget
    expect(result.loadedScoped).toContain('citation-integrity');
    expect(result.loaded).toContain('citation-integrity');
    // Scoped skill is not in activatedContextual
    expect(result.activatedContextual).not.toContain('citation-integrity');
    // Budget-exceeded drop exists for any overflow contextual, but NOT for the scoped skill
    expect(result.dropped.find(d => d.skill === 'citation-integrity')).toBeUndefined();
  });

  // ─── (d) loadedScoped vs activatedContextual separation ──────────────────
  it('(d) scoped skills appear in loaded[] and loadedScoped[] but NOT in activatedContextual[]', () => {
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);
    writeSkill('ctx-skill', ['mode: contextual', 'keywords: [auth]']);

    const result = loadSkills('test-agent', [], tmpDir, index, 'Review the auth handler', [], 'review');

    // Both loaded
    expect(result.loaded).toContain('citation-integrity');
    expect(result.loaded).toContain('ctx-skill');
    // Scoped in loadedScoped only
    expect(result.loadedScoped).toContain('citation-integrity');
    expect(result.loadedScoped).not.toContain('ctx-skill');
    // Contextual in activatedContextual only
    expect(result.activatedContextual).toContain('ctx-skill');
    expect(result.activatedContextual).not.toContain('citation-integrity');
  });

  // ─── (e) scope-mismatch distinct from task-type-mismatch ─────────────────
  it('(e) scope-mismatch reason is scope-type-mismatch (not task-type-mismatch)', () => {
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);
    // Also add a task_type-only skill for contrast
    writeSkill('review-only', ['task_type: review', 'keywords: [auth]']);

    const result = loadSkills('test-agent', [], tmpDir, index, 'Implement auth', [], 'implement');

    const scopeDrop = result.dropped.find(d => d.skill === 'citation-integrity');
    expect(scopeDrop?.reason).toBe('scope-type-mismatch');

    const taskTypeDrop = result.dropped.find(d => d.skill === 'review-only');
    expect(taskTypeDrop?.reason).toBe('task-type-mismatch');
  });

  // ─── (f) multi-type scope ─────────────────────────────────────────────────
  it('(f) scope=[review, research] activates for both review and research but not implement', () => {
    writeSkill('cross-cutting', ['scope: [review, research]', 'keywords: []']);

    const forReview = loadSkills('test-agent', [], tmpDir, index, 'any task text', [], 'review');
    const forResearch = loadSkills('test-agent', [], tmpDir, index, 'any task text', [], 'research');
    const forImpl = loadSkills('test-agent', [], tmpDir, index, 'any task text', [], 'implement');

    expect(forReview.loadedScoped).toContain('cross-cutting');
    expect(forResearch.loadedScoped).toContain('cross-cutting');
    expect(forImpl.loadedScoped).not.toContain('cross-cutting');
    expect(forImpl.dropped.find(d => d.skill === 'cross-cutting')?.reason).toBe('scope-type-mismatch');
  });

  // ─── (g) mode:permanent still always-loads (backward compat preserved) ───
  it('(g) mode:permanent skills are unaffected by the scope axis — still always load', () => {
    // Use the project skills directory so we can control mode through the index
    const projectSkillsDir = join(tmpDir, '.gossip', 'skills');
    writeFileSync(join(projectSkillsDir, 'always-skill.md'), [
      '---',
      'name: always-skill',
      'description: permanent skill',
      'keywords: []',
      'mode: permanent',
      'status: active',
      '---',
      '## Always',
      'Always active.',
    ].join('\n'));
    index.bind('test-agent', 'always-skill', { source: 'config', mode: 'permanent' });

    // Load with implement task — no keywords, no scope — must still appear
    const result = loadSkills('test-agent', [], tmpDir, index, 'Build the new feature', [], 'implement');

    expect(result.loaded).toContain('always-skill');
    expect(result.activatedContextual).not.toContain('always-skill');
    expect(result.loadedScoped).not.toContain('always-skill');
  });

  // ─── (h) dispatchTaskType=undefined → scope skills load unconditionally ──
  it('(h) when dispatchTaskType is undefined, scope-declared skills load unconditionally (backwards compat)', () => {
    writeSkill('citation-integrity', ['scope: [review]', 'keywords: []']);

    // No 7th arg → filter skipped entirely
    const result = loadSkills('test-agent', [], tmpDir, index, 'Implement auth');

    expect(result.loaded).toContain('citation-integrity');
    expect(result.loadedScoped).toContain('citation-integrity');
    expect(result.dropped.find(d => d.skill === 'citation-integrity')).toBeUndefined();
  });
});

describe('parseSkillFrontmatter — scope field parsing', () => {
  // ─── (i) scope parsing edge cases ────────────────────────────────────────
  it('parses scope as bracket list', () => {
    const fm = parseSkillFrontmatter([
      '---',
      'name: test-skill',
      'description: test',
      'status: active',
      'scope: [review, research]',
      '---',
      'body',
    ].join('\n'));
    expect(fm?.scope).toEqual(['review', 'research']);
  });

  it('parses scope as single bare value', () => {
    const fm = parseSkillFrontmatter([
      '---',
      'name: test-skill',
      'description: test',
      'status: active',
      'scope: review',
      '---',
      'body',
    ].join('\n'));
    expect(fm?.scope).toEqual(['review']);
  });

  it('silently drops invalid scope tokens, keeps valid ones', () => {
    const fm = parseSkillFrontmatter([
      '---',
      'name: test-skill',
      'description: test',
      'status: active',
      'scope: [review, foobar, implement]',
      '---',
      'body',
    ].join('\n'));
    // 'foobar' dropped, 'review' and 'implement' kept
    expect(fm?.scope).toEqual(['review', 'implement']);
  });

  it('returns undefined scope when field is absent', () => {
    const fm = parseSkillFrontmatter([
      '---',
      'name: test-skill',
      'description: test',
      'status: active',
      '---',
      'body',
    ].join('\n'));
    expect(fm?.scope).toBeUndefined();
  });

  it('returns undefined scope when all tokens are invalid', () => {
    const fm = parseSkillFrontmatter([
      '---',
      'name: test-skill',
      'description: test',
      'status: active',
      'scope: [foobar, baz]',
      '---',
      'body',
    ].join('\n'));
    // All invalid → treated as absent
    expect(fm?.scope).toBeUndefined();
  });

  it('emit-structured-claims default skill now declares scope=[review, research]', () => {
    // Regression guard: verifies the migration of emit-structured-claims.md
    // from mode:permanent to scope:[review,research] landed correctly.
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    const content = readFileSync(
      resolve(__dirname, '../../packages/orchestrator/src/default-skills/emit-structured-claims.md'),
      'utf-8',
    );
    const fm = parseSkillFrontmatter(content);
    expect(fm?.scope).toEqual(expect.arrayContaining(['review', 'research']));
    // mode:permanent should NOT be set — the skill uses scope axis now
    expect(fm?.mode).toBeUndefined();
  });
});
