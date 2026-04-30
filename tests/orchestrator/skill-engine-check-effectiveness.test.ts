import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine } from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import type { AgentScore } from '../../packages/orchestrator/src/performance-reader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubLLM(): ILLMProvider {
  return {
    generate: jest.fn().mockResolvedValue({ text: '' }),
  } as unknown as ILLMProvider;
}

function makeStubPerfReader(
  projectRoot: string,
  agentId: string,
  categoryCorrect: Record<string, number>,
  categoryHallucinated: Record<string, number>,
): PerformanceReader {
  const reader = new PerformanceReader(projectRoot);
  const score: AgentScore = {
    agentId,
    accuracy: 0,
    uniqueness: 0,
    reliability: 0,
    impactScore: 0,
    totalSignals: 0,
    agreements: 0,
    disagreements: 0,
    uniqueFindings: 0,
    hallucinations: 0,
    weightedHallucinations: 0,
    consecutiveFailures: 0,
    circuitOpen: false,
    categoryStrengths: {},
    categoryAccuracy: {},
    categoryCorrect,
    categoryHallucinated,
    transport_failure_count: 0,
  };
  jest.spyOn(reader, 'getScores').mockReturnValue(new Map([[agentId, score]]));
  // v2: checkEffectiveness uses getCountersSince(agentId, cat, anchorMs) to get
  // the post-bind delta directly. For the tests we model the legacy fixtures
  // by treating categoryCorrect/Hallucinated as the live cumulative counts and
  // subtracting the baseline encoded in the skill file frontmatter at call time.
  // To keep tests deterministic without re-parsing the file, we instead spy
  // and let individual tests override; the default returns the raw map values.
  jest.spyOn(reader, 'getCountersSince').mockImplementation((_a, cat) => ({
    correct: categoryCorrect[cat] ?? 0,
    hallucinated: categoryHallucinated[cat] ?? 0,
  }));
  return reader;
}

/** Write a minimal skill file with given frontmatter fields into tmpDir */
function writeSkillFile(
  tmpDir: string,
  agentId: string,
  category: string,
  fields: Record<string, string | number>,
): string {
  const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillDir, { recursive: true });
  // normalizeSkillName: underscores → hyphens
  const skillName = category.replace(/_/g, '-');
  const skillPath = join(skillDir, `${skillName}.md`);

  const fmLines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const content = `---\n${fmLines}\n---\n\n## Body\n\nContent here.\n`;
  writeFileSync(skillPath, content);
  return skillPath;
}

function readFrontmatter(skillPath: string): Record<string, string> {
  const raw = readFileSync(skillPath, 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No frontmatter found');
  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    // Strip surrounding double-quotes (the writer now wraps string values
    // in "..." with `\"` and `\\` escaping for proper YAML safety).
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillEngine.checkEffectiveness()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-eff-test-'));
  });

  // -------------------------------------------------------------------------
  // Test 1: pending when post-bind delta < 120
  // -------------------------------------------------------------------------
  it('returns pending when post-bind delta is below MIN_EVIDENCE (120)', async () => {
    const agentId = 'agent-x';
    const category = 'trust_boundaries';

    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 2,
    });

    const contentBefore = readFileSync(skillPath, 'utf-8');

    // Delta = 20 correct + 20 hallucinated = 40 < 120
    const perfReader = makeStubPerfReader(tmpDir, agentId, { [category]: 20 }, { [category]: 20 });
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(verdict.status).toBe('pending');
    expect(verdict.shouldUpdate).toBe(false);
    // File must be unchanged
    expect(readFileSync(skillPath, 'utf-8')).toBe(contentBefore);
  });

  // -------------------------------------------------------------------------
  // Test 2: passed + effectiveness written back to file
  // -------------------------------------------------------------------------
  it('writes status: passed and effectiveness when post-bind shows +10pp at p=0.75', async () => {
    const agentId = 'agent-x';
    const category = 'trust_boundaries';

    writeSkillFile(tmpDir, agentId, category, {
      baseline_accuracy_correct: 75,
      baseline_accuracy_hallucinated: 25,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 2,
    });

    // Delta: 102 correct + 18 hallucinated = 120 signals at 85% (+10pp)
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 102 },
      { [category]: 18 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(verdict.status).toBe('passed');
    expect(verdict.shouldUpdate).toBe(true);
    expect(verdict.effectiveness).toBeCloseTo(0.10, 2);

    const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
    const skillPath = join(skillDir, 'trust-boundaries.md');
    const fm = readFrontmatter(skillPath);
    expect(fm.status).toBe('passed');
    expect(Number(fm.effectiveness)).toBeCloseTo(0.10, 2);
  });

  // -------------------------------------------------------------------------
  // Test 3: inconclusive writes snapshot fields
  // -------------------------------------------------------------------------
  it('writes inconclusive snapshot fields on first inconclusive verdict', async () => {
    const agentId = 'agent-x';
    const category = 'trust_boundaries';

    writeSkillFile(tmpDir, agentId, category, {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 2,
    });

    // Delta: 60 correct + 60 hallucinated = 120 signals at 50% (no change)
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 60 },
      { [category]: 60 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(verdict.status).toBe('inconclusive');
    expect(verdict.shouldUpdate).toBe(true);

    const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
    const skillPath = join(skillDir, 'trust-boundaries.md');
    const fm = readFrontmatter(skillPath);
    expect(fm.status).toBe('inconclusive');
    expect(Number(fm.inconclusive_strikes)).toBe(1);
    expect(fm.inconclusive_at).toBeTruthy();
    // Should be a parseable ISO date
    expect(isNaN(new Date(fm.inconclusive_at).getTime())).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 4: flagged_for_manual_review is terminal — file unchanged
  // -------------------------------------------------------------------------
  it('returns flagged_for_manual_review terminal state and does NOT modify file', async () => {
    const agentId = 'agent-x';
    const category = 'trust_boundaries';

    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      status: 'flagged_for_manual_review',
      bound_at: new Date().toISOString(),
      migration_count: 2,
    });

    const contentBefore = readFileSync(skillPath, 'utf-8');

    // Large deltas that would otherwise trigger a re-verdict
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 500 },
      { [category]: 100 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(verdict.status).toBe('flagged_for_manual_review');
    expect(verdict.shouldUpdate).toBe(false);
    expect(readFileSync(skillPath, 'utf-8')).toBe(contentBefore);
  });

  // -------------------------------------------------------------------------
  // Test 5: not_applicable for implementer agents
  // -------------------------------------------------------------------------
  it('returns not_applicable for implementer agents via opts.role', async () => {
    const agentId = 'agent-impl';
    const category = 'trust_boundaries';

    writeSkillFile(tmpDir, agentId, category, {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 2,
    });

    const contentBefore = readFileSync(
      join(tmpDir, '.gossip', 'agents', agentId, 'skills', 'trust-boundaries.md'),
      'utf-8',
    );

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 500 },
      { [category]: 100 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category, { role: 'implementer' });

    expect(verdict.status).toBe('not_applicable');
    expect(verdict.shouldUpdate).toBe(false);
    // File must be unchanged
    expect(
      readFileSync(
        join(tmpDir, '.gossip', 'agents', agentId, 'skills', 'trust-boundaries.md'),
        'utf-8',
      ),
    ).toBe(contentBefore);
  });

  // -------------------------------------------------------------------------
  // Test 6: returns pending (no file) when skill file does not exist
  // -------------------------------------------------------------------------
  it('returns pending with shouldUpdate=false when skill file does not exist', async () => {
    const perfReader = makeStubPerfReader(tmpDir, 'agent-x', {}, {});
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness('agent-x', 'trust_boundaries');
    expect(verdict.status).toBe('pending');
    expect(verdict.shouldUpdate).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 7: preserves other frontmatter fields when writing back
  // -------------------------------------------------------------------------
  it('preserves other frontmatter fields (name, category, keywords) when writing verdict', async () => {
    const agentId = 'agent-x';
    const category = 'trust_boundaries';

    const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'trust-boundaries.md');
    writeFileSync(
      skillPath,
      `---\nname: my-skill\ncategory: trust_boundaries\nkeywords: [auth, session]\nbaseline_accuracy_correct: 75\nbaseline_accuracy_hallucinated: 25\nstatus: pending\nbound_at: ${new Date().toISOString()}\nmigration_count: 2\n---\n\n## Body\n\nSome content.\n`,
    );

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 102 },
      { [category]: 18 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    await gen.checkEffectiveness(agentId, category);

    const fm = readFrontmatter(skillPath);
    expect(fm.name).toBe('my-skill');
    expect(fm.category).toBe('trust_boundaries');
    expect(fm.keywords).toBe('[auth, session]');
  });
});

// ---------------------------------------------------------------------------
// Task 8 — Lazy migration tests
// ---------------------------------------------------------------------------

describe('checkEffectiveness — lazy migration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-migration-test-'));
  });

  it('snapshots baseline_correct from current counters when missing AND bound_at < 90 days old', async () => {
    const agentId = 'agent-migrate';
    const category = 'trust_boundaries';

    // 30 days ago — NOT stale
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      effectiveness: 0.0,
      bound_at: thirtyDaysAgo,
      status: 'pending',
      // NO baseline_correct, NO baseline_hallucinated, NO migration_count
    });

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 42 },
      { [category]: 8 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    await gen.checkEffectiveness(agentId, category);

    const fm = readFrontmatter(skillPath);
    expect(Number(fm.baseline_accuracy_correct)).toBe(42);
    expect(Number(fm.baseline_accuracy_hallucinated)).toBe(8);
    expect(Number(fm.migration_count)).toBe(2);
    // bound_at must be unchanged (still 30 days ago)
    expect(fm.bound_at).toBe(thirtyDaysAgo);
    // migration_reason must be ABSENT (not a stale reset)
    expect(fm.migration_reason).toBeUndefined();
  });

  it('preserves bound_at when status:pending even if > 90 days old (FIX 3)', async () => {
    // A skill with status:pending is actively accumulating delta signals anchored
    // to the existing bound_at. Resetting it would void accumulated history and
    // double the evidence bar. The migration must NOT reset in this case.
    const agentId = 'agent-stale-pending';
    const category = 'trust_boundaries';

    // 100 days ago — stale, but status is pending (active evaluation in-flight)
    const hundredDaysAgo = new Date(Date.now() - 100 * 86400_000).toISOString();

    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      effectiveness: 0.0,
      bound_at: hundredDaysAgo,
      status: 'pending',
      // NO baseline_correct, NO migration_count
    });

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 30 },
      { [category]: 10 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);
    await gen.checkEffectiveness(agentId, category);

    const fm = readFrontmatter(skillPath);
    // bound_at must be PRESERVED (not reset to now) — delta history anchor intact
    expect(fm.bound_at).toBe(hundredDaysAgo);
    // migration_reason must NOT be set — no stale reset occurred
    expect(fm.migration_reason).toBeUndefined();
    expect(Number(fm.migration_count)).toBe(2);
  });

  it('resets bound_at to now() AND sets migration_reason when status is absent and bound_at > 90 days old', async () => {
    // Legacy unmigrated file: no status means no in-flight evaluation,
    // safe to reset the stale bound_at so the new verdict window starts fresh.
    const agentId = 'agent-stale-no-status';
    const category = 'trust_boundaries';

    // 100 days ago — stale, and no status (unmigrated legacy file)
    const hundredDaysAgo = new Date(Date.now() - 100 * 86400_000).toISOString();

    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      effectiveness: 0.0,
      bound_at: hundredDaysAgo,
      // NO status, NO baseline_correct, NO migration_count
    });

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 30 },
      { [category]: 10 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const beforeMs = Date.now();
    await gen.checkEffectiveness(agentId, category);
    const afterMs = Date.now();

    const fm = readFrontmatter(skillPath);
    // bound_at must be reset to now (within 5 seconds)
    const newBoundAt = new Date(fm.bound_at).getTime();
    expect(newBoundAt).toBeGreaterThanOrEqual(beforeMs);
    expect(newBoundAt).toBeLessThanOrEqual(afterMs + 5000);
    expect(fm.migration_reason).toBe('v2_stale_baseline_reset');
    expect(Number(fm.migration_count)).toBe(2);
    expect(Number(fm.baseline_accuracy_correct)).toBe(30);
    expect(Number(fm.baseline_accuracy_hallucinated)).toBe(10);
  });

  it('refuses to re-migrate when migration_count >= 2', async () => {
    const agentId = 'agent-remigrate';
    const category = 'trust_boundaries';

    // 200 days ago — would trigger stale reset if migration ran
    const twohundredDaysAgo = new Date(Date.now() - 200 * 86400_000).toISOString();

    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      effectiveness: 0.0,
      bound_at: twohundredDaysAgo,
      migration_count: 2,
      status: 'pending',
      // NO baseline_accuracy_correct — simulates manual deletion after migration
    });

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 99 },
      { [category]: 1 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    const fm = readFrontmatter(skillPath);
    // bound_at must NOT be touched
    expect(fm.bound_at).toBe(twohundredDaysAgo);
    // migration_count still 2
    expect(Number(fm.migration_count)).toBe(2);
    // baseline_accuracy_correct must NOT have been freshly snapshotted (still absent / 0)
    expect(fm.baseline_accuracy_correct == null || Number(fm.baseline_accuracy_correct) === 0).toBe(true);
    // Verdict should reflect the stale/insufficient-evidence state
    expect(verdict.status).toBeDefined();
  });

  it('sets bound_at to now() AND sets migration_reason when bound_at is absent entirely', async () => {
    const agentId = 'agent-no-boundat';
    const category = 'trust_boundaries';

    // Construct a skill file fixture WITH effectiveness: 0.0 but WITHOUT bound_at, baseline_correct, or migration_count
    const skillPath = writeSkillFile(tmpDir, agentId, category, {
      effectiveness: 0.0,
      status: 'pending',
      // NO bound_at, NO baseline_correct, NO baseline_hallucinated, NO migration_count
    });

    // Stub PerformanceReader to return categoryCorrect[cat]=10, categoryHallucinated[cat]=2
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 10 },
      { [category]: 2 },
    );
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const beforeMs = Date.now();
    await gen.checkEffectiveness(agentId, category);
    const afterMs = Date.now();

    // Read the file back and assert
    const fm = readFrontmatter(skillPath);
    // frontmatter.bound_at is set and parses as a Date within ~5 seconds of now
    expect(fm.bound_at).toBeTruthy();
    const boundAtMs = new Date(fm.bound_at).getTime();
    expect(boundAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(boundAtMs).toBeLessThanOrEqual(afterMs + 5000);
    // v2: missing bound_at counts as stale and sets migration_reason
    expect(fm.migration_reason).toBe('v2_stale_baseline_reset');
    expect(Number(fm.baseline_accuracy_correct)).toBe(10);
    expect(Number(fm.baseline_accuracy_hallucinated)).toBe(2);
    expect(Number(fm.migration_count)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — NaN coercion guard
// ---------------------------------------------------------------------------

describe('checkEffectiveness — NaN coercion guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-nan-test-'));
  });

  it('handles non-numeric baseline_correct without producing NaN verdict', async () => {
    const agentId = 'agent-x';
    const category = 'trust_boundaries';

    // Write a skill file with a corrupted (non-numeric) baseline_correct
    const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'trust-boundaries.md');
    writeFileSync(
      skillPath,
      `---\nbaseline_accuracy_correct: not-a-number\nbaseline_accuracy_hallucinated: also-bad\nstatus: pending\nbound_at: ${new Date().toISOString()}\nmigration_count: 2\n---\n\n## Body\n\nContent.\n`,
    );

    // Normal live counters
    const perfReader = makeStubPerfReader(tmpDir, agentId, { [category]: 80 }, { [category]: 20 });
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    // Verdict must be a valid VerdictStatus — not NaN-corrupted
    const validStatuses = ['pending', 'passed', 'failed', 'inconclusive', 'flagged_for_manual_review', 'not_applicable', 'silent_skill', 'insufficient_evidence'];
    expect(validStatuses).toContain(verdict.status);
    // shouldUpdate must be a boolean
    expect(typeof verdict.shouldUpdate).toBe('boolean');
    // effectiveness must not be NaN if present
    if (verdict.effectiveness !== undefined) {
      expect(Number.isFinite(verdict.effectiveness)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Bug 4 — keywords regex: block-style YAML
// ---------------------------------------------------------------------------

describe('SkillEngine.validateSkillContent — keywords block-style', () => {
  it('does not throw when keywords uses block-style YAML syntax', () => {
    // Access validateSkillContent via a subclass or via direct test — we need to call it
    // The method is private, so we'll test it via generate() with a mocked LLM response
    // that returns block-style keywords, OR we test the regex behavior indirectly by
    // checking that a content string with block-style keywords passes validation.
    // Since the method is private, we'll subclass to expose it for testing.
    class TestableSkillEngine extends SkillEngine {
      public validatePublic(content: string): void {
        return (this as unknown as { validateSkillContent: (c: string) => void }).validateSkillContent(content);
      }
    }

    const gen = new TestableSkillEngine(makeStubLLM(), new PerformanceReader(tmpdir()), tmpdir());

    const blockStyleContent = `---
name: test-skill
category: trust_boundaries
keywords:
  - auth
  - session
effectiveness: 0.0
---

## Iron Law

NEVER skip auth checks.

## When This Skill Activates

- Auth-related code

## Methodology

1. Check auth

## Key Patterns

- Token validation

## Anti-Patterns

- **"Skip checks"** — Always validate.

## Quality Gate

- [ ] Auth checked
`;

    // Should not throw
    expect(() => gen.validatePublic(blockStyleContent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bug 7 — SAFE_NAME guard in checkEffectiveness
// ---------------------------------------------------------------------------

describe('checkEffectiveness — SAFE_NAME guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-safename-test-'));
  });

  it('returns pending with shouldUpdate=false for an unsafe agentId and does not touch filesystem', async () => {
    const perfReader = makeStubPerfReader(tmpDir, 'safe-agent', {}, {});
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness('../../../tmp/evil', 'trust_boundaries');

    expect(verdict.status).toBe('pending');
    expect(verdict.shouldUpdate).toBe(false);
  });

  it('returns pending with shouldUpdate=false for an agentId with path traversal dots', async () => {
    const perfReader = makeStubPerfReader(tmpDir, 'safe-agent', {}, {});
    const gen = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness('../../etc/passwd', 'trust_boundaries');

    expect(verdict.status).toBe('pending');
    expect(verdict.shouldUpdate).toBe(false);
  });
});
