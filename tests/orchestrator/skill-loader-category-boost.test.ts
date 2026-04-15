import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { extractCategories } from '../../packages/orchestrator/src/category-extractor';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Tests for Design 1.5 hybrid category boost.
 * Consensus: f2ff0fac-fb384daa:f14.
 *
 * Contract:
 *   - categoryBoost = 0.5 (fractional) preserves integer-tie semantics.
 *   - Boost applied BEFORE MIN_KEYWORD_HITS threshold gate.
 *   - Multi-category: if skill.category is in taskCategories[], boost applies.
 *   - Zero-category (empty array): no boost.
 *   - Threshold rescue (0 raw hits + boost = 0.5) still fails MIN_KEYWORD_HITS=1.
 */
describe('Skill loader — category boost (Design 1.5 hybrid)', () => {
  let tmpDir: string;
  let index: SkillIndex;

  /**
   * Small helper — write a contextual skill file with a known category and
   * a keyword that will or will not match the task under test.
   */
  function writeSkill(name: string, category: string, keywords: string[]): void {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills');
    writeFileSync(
      join(skillsDir, `${name}.md`),
      `---
name: ${name}
description: ${name} skill
keywords: [${keywords.join(', ')}]
category: ${category}
mode: contextual
status: active
---

## ${name} body
Content for ${name}.
`,
    );
    index.bind('test-agent', name, { source: 'auto', mode: 'contextual' });
  }

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-cat-boost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, '.gossip', 'skills'), { recursive: true });
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Test 1: zero-category task ───────────────────────────────────────────
  it('zero-category task: loadSkills behaves identically to no-boost baseline', () => {
    writeSkill('trust-boundaries-probe', 'trust_boundaries', ['authentication']);
    writeSkill('concurrency-probe', 'concurrency', ['authentication']);

    // Task with no category-triggering vocabulary but one keyword match per skill.
    const task = 'please review the authentication code';
    const categories = extractCategories(task);
    // Sanity: task triggers at least one category (authentication → trust_boundaries)
    // To exercise the zero-category path, pass an explicitly empty array.
    const withCats = loadSkills('test-agent', [], tmpDir, index, task, categories);
    const withoutCats = loadSkills('test-agent', [], tmpDir, index, task, []);

    // Without categories passed in, both skills should have raw hits=1, no boost.
    expect(withoutCats.activatedContextual.sort()).toEqual(['concurrency-probe', 'trust-boundaries-probe']);

    // With categories (authentication → trust_boundaries only), trust-boundaries
    // gets boosted 1.0 → 1.5, concurrency stays at 1.0. Both still activate.
    expect(withCats.activatedContextual).toContain('trust-boundaries-probe');
    expect(withCats.activatedContextual).toContain('concurrency-probe');

    // The zero-category case (empty array) must not reorder when hits tie:
    // deterministic alpha tiebreaker → concurrency-probe before trust-boundaries-probe.
    expect(withoutCats.activatedContextual).toEqual(['concurrency-probe', 'trust-boundaries-probe']);
  });

  // ─── Test 2: multi-category pin ───────────────────────────────────────────
  it('multi-category pin: both matched categories receive boost and outrank non-matches', () => {
    // Task triggers BOTH trust_boundaries (authenticat/credential) AND
    // injection_vectors (inject/sanitiz).
    writeSkill('trust-probe', 'trust_boundaries', ['zzz-unused-kw']);
    writeSkill('inject-probe', 'injection_vectors', ['zzz-unused-kw']);
    writeSkill('concurrency-probe', 'concurrency', ['review']);

    const task = 'review the authentication handler for sql injection and sanitization';
    const categories = extractCategories(task);
    expect(categories).toContain('trust_boundaries');
    expect(categories).toContain('injection_vectors');

    loadSkills('test-agent', [], tmpDir, index, task, categories);

    // concurrency-probe has 1 raw hit ('review'), effective = 1.0.
    // trust-probe + inject-probe have 0 raw hits + 0.5 boost each = 0.5 → DROPPED
    // (negative threshold-rescue test is #4; here both categories match but no
    // raw hits means neither can rescue). So we need keyword hits too.
    // Rewire: give trust+inject ONE matching keyword each.
    rmSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true, force: true });
    mkdirSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    index = new SkillIndex(tmpDir);
    writeSkill('trust-probe', 'trust_boundaries', ['handler']);
    writeSkill('inject-probe', 'injection_vectors', ['sanitization']);
    writeSkill('concurrency-probe', 'concurrency', ['review']);

    const result2 = loadSkills('test-agent', [], tmpDir, index, task, categories);
    // trust-probe:     1 raw hit (handler)       + 0.5 boost = 1.5
    // inject-probe:    1 raw hit (sanitization)  + 0.5 boost = 1.5
    // concurrency-probe: 1 raw hit (review)      + 0.0 boost = 1.0
    // Budget = 3, so all three load but ordering should put the boosted pair
    // ahead of concurrency-probe.
    expect(result2.activatedContextual.length).toBe(3);
    const concurrencyIdx = result2.activatedContextual.indexOf('concurrency-probe');
    const trustIdx = result2.activatedContextual.indexOf('trust-probe');
    const injectIdx = result2.activatedContextual.indexOf('inject-probe');
    expect(trustIdx).toBeLessThan(concurrencyIdx);
    expect(injectIdx).toBeLessThan(concurrencyIdx);
  });

  // ─── Test 3: citation_grounding round-trip ───────────────────────────────
  it('citation_grounding: new CATEGORY_PATTERNS entry detects fabrication vocab and boosts matched skill', () => {
    // New category must be recognized by extractCategories.
    const task = 'verify the citation in foo.ts:42 — does not exist';
    const categories = extractCategories(task);
    expect(categories).toContain('citation_grounding');

    // A citation_grounding skill with one matching keyword should get boost.
    writeSkill('citation-probe', 'citation_grounding', ['verify']);
    // Control: a concurrency skill that also has 'verify' in keywords — same
    // raw hit count, but no category match → no boost.
    writeSkill('concurrency-control', 'concurrency', ['verify']);

    const result = loadSkills('test-agent', [], tmpDir, index, task, categories);

    // citation-probe:      1 raw hit (verify) + 0.5 boost = 1.5
    // concurrency-control: 1 raw hit (verify) + 0.0 boost = 1.0
    expect(result.activatedContextual).toContain('citation-probe');
    expect(result.activatedContextual).toContain('concurrency-control');
    const citationIdx = result.activatedContextual.indexOf('citation-probe');
    const concurrencyIdx = result.activatedContextual.indexOf('concurrency-control');
    expect(citationIdx).toBeLessThan(concurrencyIdx);
  });

  // ─── Test 4: threshold-rescue (negative) ──────────────────────────────────
  it('threshold-rescue negative: category-matched skill with 0 raw hits does NOT pass threshold', () => {
    // Skill in a matched category, but task contains zero of its keywords.
    writeSkill('trust-nomatch', 'trust_boundaries', ['zzz-unused-never-appears']);

    const task = 'review the authentication handler';
    const categories = extractCategories(task);
    expect(categories).toContain('trust_boundaries');

    const result = loadSkills('test-agent', [], tmpDir, index, task, categories);

    // 0 raw hits + 0.5 boost = 0.5 effective, below MIN_KEYWORD_HITS=1.
    // Must be dropped with below-keyword-threshold reason.
    expect(result.activatedContextual).not.toContain('trust-nomatch');
    const drop = result.dropped.find(d => d.skill === 'trust-nomatch');
    expect(drop).toBeDefined();
    expect(drop?.reason).toBe('below-keyword-threshold');
    // hits recorded as raw (0), not effective (0.5) — operators need to see
    // that the skill had zero keyword matches.
    expect(drop?.hits).toBe(0);
  });

  // ─── Test 5: budget pressure ──────────────────────────────────────────────
  it('budget pressure: rank-4 category-match does NOT displace rank-3 non-match when effective hits are lower', () => {
    // Three strong non-category skills (2 raw hits each = 2.0 effective).
    writeSkill('strong-a', 'error_handling', ['review', 'code']);
    writeSkill('strong-b', 'data_integrity', ['review', 'code']);
    writeSkill('strong-c', 'concurrency', ['review', 'code']);
    // One category-matched weaker skill (1 raw hit + 0.5 boost = 1.5 effective).
    writeSkill('weak-category', 'trust_boundaries', ['authentication']);

    const task = 'review the authentication code';
    const categories = extractCategories(task);
    expect(categories).toContain('trust_boundaries');

    const result = loadSkills('test-agent', [], tmpDir, index, task, categories);

    // Budget is MAX_CONTEXTUAL_SKILLS=3. The three strong skills (2.0) outrank
    // the weak category-match (1.5), so weak-category is evicted.
    expect(result.activatedContextual.length).toBe(3);
    expect(result.activatedContextual).not.toContain('weak-category');
    const drop = result.dropped.find(d => d.skill === 'weak-category');
    expect(drop).toBeDefined();
    expect(drop?.reason).toBe('budget-exceeded');
  });

  // ─── Test 6: tie ordering ─────────────────────────────────────────────────
  it('tie ordering: two skills with identical effective hits sort deterministically (alpha tiebreaker)', () => {
    // Both skills: 1 raw hit + 0.5 boost = 1.5 effective (tied).
    writeSkill('bravo-probe', 'trust_boundaries', ['authentication']);
    writeSkill('alpha-probe', 'trust_boundaries', ['authentication']);

    const task = 'review authentication flow';
    const categories = extractCategories(task);

    // Run twice to confirm determinism.
    const r1 = loadSkills('test-agent', [], tmpDir, index, task, categories);
    const r2 = loadSkills('test-agent', [], tmpDir, index, task, categories);

    expect(r1.activatedContextual).toEqual(r2.activatedContextual);
    // Alpha tiebreaker: 'alpha-probe' before 'bravo-probe'.
    const alphaIdx = r1.activatedContextual.indexOf('alpha-probe');
    const bravoIdx = r1.activatedContextual.indexOf('bravo-probe');
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(bravoIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).toBeLessThan(bravoIdx);
  });
});
