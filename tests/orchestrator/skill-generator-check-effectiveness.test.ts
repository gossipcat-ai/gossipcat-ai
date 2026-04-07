import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillGenerator } from '../../packages/orchestrator/src/skill-generator';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import type { AgentScore } from '../../packages/orchestrator/src/performance-reader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubLLM(): ILLMProvider {
  return {
    generate: vi.fn().mockResolvedValue({ text: '' }),
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
    score: 0,
    totalSignals: 0,
    correctSignals: 0,
    hallucinationCount: 0,
    categoryStrengths: {},
    categoryAccuracy: {},
    categoryCorrect,
    categoryHallucinated,
  };
  vi.spyOn(reader, 'getScores').mockReturnValue(new Map([[agentId, score]]));
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
    const value = line.slice(colon + 1).trim();
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillGenerator.checkEffectiveness()', () => {
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
      baseline_correct: 50,
      baseline_hallucinated: 50,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 0,
    });

    const contentBefore = readFileSync(skillPath, 'utf-8');

    // Live counters: baseline + 20 correct, +20 hallucinated (delta = 40 < 120)
    const perfReader = makeStubPerfReader(tmpDir, agentId, { [category]: 70 }, { [category]: 70 });
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

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
      baseline_correct: 75,
      baseline_hallucinated: 25,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 0,
    });

    // Post-bind: 102 correct + 18 hallucinated = 120 signals at 85% (+10pp)
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 75 + 102 },
      { [category]: 25 + 18 },
    );
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

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
      baseline_correct: 50,
      baseline_hallucinated: 50,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 0,
    });

    // Post-bind: exactly 60 correct + 60 hallucinated = 120 signals at 50% (no change)
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 110 },
      { [category]: 110 },
    );
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(verdict.status).toBe('inconclusive');
    expect(verdict.shouldUpdate).toBe(true);

    const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
    const skillPath = join(skillDir, 'trust-boundaries.md');
    const fm = readFrontmatter(skillPath);
    expect(fm.status).toBe('inconclusive');
    expect(Number(fm.inconclusive_correct)).toBe(110);
    expect(Number(fm.inconclusive_hallucinated)).toBe(110);
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
      baseline_correct: 50,
      baseline_hallucinated: 50,
      status: 'flagged_for_manual_review',
      bound_at: new Date().toISOString(),
      migration_count: 0,
    });

    const contentBefore = readFileSync(skillPath, 'utf-8');

    // Large deltas that would otherwise trigger a re-verdict
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 500 },
      { [category]: 100 },
    );
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

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
      baseline_correct: 50,
      baseline_hallucinated: 50,
      status: 'pending',
      bound_at: new Date().toISOString(),
      migration_count: 0,
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
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

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
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

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
      `---\nname: my-skill\ncategory: trust_boundaries\nkeywords: [auth, session]\nbaseline_correct: 75\nbaseline_hallucinated: 25\nstatus: pending\nbound_at: ${new Date().toISOString()}\nmigration_count: 0\n---\n\n## Body\n\nSome content.\n`,
    );

    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [category]: 75 + 102 },
      { [category]: 25 + 18 },
    );
    const gen = new SkillGenerator(makeStubLLM(), perfReader, tmpDir);

    await gen.checkEffectiveness(agentId, category);

    const fm = readFrontmatter(skillPath);
    expect(fm.name).toBe('my-skill');
    expect(fm.category).toBe('trust_boundaries');
    expect(fm.keywords).toBe('[auth, session]');
  });
});
