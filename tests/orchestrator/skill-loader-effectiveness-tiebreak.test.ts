import { loadSkills } from '../../packages/orchestrator/src/skill-loader';
import { SkillIndex } from '../../packages/orchestrator/src/skill-index';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Issue #675 precondition 2 — the MAX_CONTEXTUAL_SKILLS budget must be
 * effectiveness-aware.
 *
 * Contract:
 *   - PRIMARY key is unchanged: effective hit count, descending.
 *   - Ties on hits are broken by frontmatter `effectiveness`, descending.
 *   - Absent/malformed `effectiveness` ranks as 0.0, so it loses to a positive
 *     peer and beats a negative one.
 *   - Name localeCompare remains the FINAL tiebreaker when hits AND
 *     effectiveness are equal.
 *
 * The measured regression this pins: on a 1-1-1 hit tie, `input-validation`
 * (+0.416) was evicted in favour of `concurrency` (0.0 at the time) purely by
 * alphabetical order.
 */
describe('Skill loader — effectiveness-aware contextual budget (#675 P2)', () => {
  let tmpDir: string;
  let index: SkillIndex;

  /**
   * Write a contextual skill whose keywords all match the shared probe task.
   * `effectiveness` is omitted from the frontmatter entirely when undefined,
   * which is the shape of a hand-authored or never-evaluated skill file.
   */
  function writeSkill(
    name: string,
    keywords: string[],
    effectiveness?: number | string,
  ): void {
    const skillsDir = join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills');
    const effLine = effectiveness === undefined ? '' : `effectiveness: ${effectiveness}\n`;
    writeFileSync(
      join(skillsDir, `${name}.md`),
      `---
name: ${name}
description: ${name} skill
keywords: [${keywords.join(', ')}]
mode: contextual
status: active
${effLine}---

## ${name} body
Content for ${name}.
`,
    );
    index.bind('test-agent', name, { source: 'auto', mode: 'contextual' });
  }

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-eff-tiebreak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(tmpDir, '.gossip', 'agents', 'test-agent', 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, '.gossip', 'skills'), { recursive: true });
    index = new SkillIndex(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── 1: equal hits, tie broken by effectiveness ───────────────────────────
  it('equal hits: higher effectiveness wins the last budget slot over an alphabetically earlier skill', () => {
    // Four candidates, 1 raw hit each, budget is 3. Alphabetically the loser
    // would be `zulu-probe`; by effectiveness the loser must be `alpha-probe`.
    writeSkill('alpha-probe', ['refactor'], -0.192);
    writeSkill('bravo-probe', ['refactor'], 0.416);
    writeSkill('charlie-probe', ['refactor'], 0.582);
    writeSkill('zulu-probe', ['refactor'], 0.455);

    const result = loadSkills('test-agent', [], tmpDir, index, 'please refactor this module', []);

    // Ranked purely by effectiveness because all four tie at 1.0 hits.
    expect(result.activatedContextual).toEqual(['charlie-probe', 'zulu-probe', 'bravo-probe']);
    const drop = result.dropped.find(d => d.skill === 'alpha-probe');
    expect(drop?.reason).toBe('budget-exceeded');
  });

  // ─── 2: missing effectiveness treated as 0 ────────────────────────────────
  it('missing effectiveness ranks as 0.0 and loses a tie to a positive-effectiveness skill', () => {
    // `alpha-unmeasured` has no effectiveness line at all and would win the
    // alphabetical tiebreaker; the measured +0.416 skill must outrank it.
    writeSkill('alpha-unmeasured', ['refactor']);
    writeSkill('zulu-measured', ['refactor'], 0.416);
    // A third candidate keeps the budget from hiding the ordering.
    writeSkill('mike-negative', ['refactor'], -0.192);

    const result = loadSkills('test-agent', [], tmpDir, index, 'please refactor this module', []);

    // Unmeasured (0.0) sits between the positive and the negative skill.
    expect(result.activatedContextual).toEqual(['zulu-measured', 'alpha-unmeasured', 'mike-negative']);
  });

  it('malformed effectiveness ranks as 0.0 rather than poisoning the comparator', () => {
    // `Number('high')` is NaN; an NaN sort key would make ordering
    // non-deterministic, so the parser must coerce it to absent.
    writeSkill('alpha-malformed', ['refactor'], 'high');
    writeSkill('zulu-measured', ['refactor'], 0.416);

    const result = loadSkills('test-agent', [], tmpDir, index, 'please refactor this module', []);

    expect(result.activatedContextual).toEqual(['zulu-measured', 'alpha-malformed']);
  });

  // ─── 3: alphabetical fallback preserved ───────────────────────────────────
  it('equal hits AND equal effectiveness: alphabetical order is still the final tiebreaker', () => {
    writeSkill('zulu-probe', ['refactor'], 0.416);
    writeSkill('alpha-probe', ['refactor'], 0.416);

    const r1 = loadSkills('test-agent', [], tmpDir, index, 'please refactor this module', []);
    const r2 = loadSkills('test-agent', [], tmpDir, index, 'please refactor this module', []);

    expect(r1.activatedContextual).toEqual(['alpha-probe', 'zulu-probe']);
    expect(r2.activatedContextual).toEqual(r1.activatedContextual);
  });

  it('two unmeasured skills fall back to alphabetical order (both rank 0.0)', () => {
    writeSkill('zulu-probe', ['refactor']);
    writeSkill('alpha-probe', ['refactor']);

    const result = loadSkills('test-agent', [], tmpDir, index, 'please refactor this module', []);

    expect(result.activatedContextual).toEqual(['alpha-probe', 'zulu-probe']);
  });

  // ─── 4: primary hit ordering unchanged ────────────────────────────────────
  it('hit count remains the primary key: a 2-hit skill outranks a 1-hit skill with far better effectiveness', () => {
    writeSkill('alpha-twohit', ['refactor', 'migration'], -0.192);
    writeSkill('zulu-onehit', ['refactor'], 0.582);

    const result = loadSkills(
      'test-agent',
      [],
      tmpDir,
      index,
      'please refactor this module during the migration',
      [],
    );

    expect(result.activatedContextual).toEqual(['alpha-twohit', 'zulu-onehit']);
  });

  it('hit count remains the primary key under budget pressure: the 1-hit high-effectiveness skill is still evicted', () => {
    writeSkill('two-a', ['refactor', 'migration'], 0);
    writeSkill('two-b', ['refactor', 'migration'], 0);
    writeSkill('two-c', ['refactor', 'migration'], 0);
    writeSkill('one-best', ['refactor'], 0.9);

    const result = loadSkills(
      'test-agent',
      [],
      tmpDir,
      index,
      'please refactor this module during the migration',
      [],
    );

    expect(result.activatedContextual).toEqual(['two-a', 'two-b', 'two-c']);
    const drop = result.dropped.find(d => d.skill === 'one-best');
    expect(drop?.reason).toBe('budget-exceeded');
  });
});
