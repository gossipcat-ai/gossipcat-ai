/**
 * Integration test: runCheckEffectivenessForAllSkills helper
 *
 * Tests the standalone runner extracted from collect.ts. The runner walks
 * .gossip/agents/<agentId>/skills/*.md and calls checkEffectiveness on each
 * (agentId, category) pair. collect.ts calls it AFTER signals are written.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine } from '../../packages/orchestrator/src/skill-engine';
import { PerformanceReader } from '../../packages/orchestrator/src/performance-reader';
import type { AgentScore } from '../../packages/orchestrator/src/performance-reader';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import { runCheckEffectivenessForAllSkills } from '../../apps/cli/src/handlers/check-effectiveness-runner';

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
  };
  jest.spyOn(reader, 'getScores').mockReturnValue(new Map([[agentId, score]]));
  jest.spyOn(reader, 'getCountersSince').mockImplementation((_a, cat) => ({
    correct: categoryCorrect[cat] ?? 0,
    hallucinated: categoryHallucinated[cat] ?? 0,
  }));
  return reader;
}

/** Write a skill file with given frontmatter into the temp dir */
function writeSkillFile(
  tmpDir: string,
  agentId: string,
  category: string,
  fields: Record<string, string | number>,
): string {
  const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillDir, { recursive: true });
  // normalizeSkillName maps underscores → hyphens
  const skillName = category.replace(/_/g, '-');
  const skillPath = join(skillDir, `${skillName}.md`);
  const fmLines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(skillPath, `---\n${fmLines}\n---\n\n## Body\n\nContent here.\n`);
  return skillPath;
}

/** Read frontmatter from a skill file */
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
    // Strip surrounding double-quotes (the writer wraps string values
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

describe('collect → checkEffectiveness wiring (runCheckEffectivenessForAllSkills)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'collect-eff-test-'));
  });

  it('calls checkEffectiveness for every (agent, category) pair with a skill file and updates status to passed when delta qualifies', async () => {
    const agentId = 'agent-x';
    // The runner passes the filename stem (already hyphenated by normalizeSkillName) as category.
    // PerformanceReader counters must use the same key that checkEffectiveness looks up.
    const categoryNormalized = 'injection-vectors'; // filename stem = normalizeSkillName result

    // Write skill file with baseline snapshot that will yield a "passed" verdict.
    // post-bind delta: correct=170-50=120, hallucinated=70-50=20 → accuracy=120/140≈0.857
    // baseline accuracy=50/100=0.50, delta=0.357 (+35.7pp >> Z_CRITICAL) → passed
    const skillPath = writeSkillFile(tmpDir, agentId, categoryNormalized, {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      bound_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(), // 8 days ago
      status: 'pending',
      migration_count: 2,
    });

    // Stub PerformanceReader getCountersSince to return delta directly
    const perfReader = makeStubPerfReader(
      tmpDir,
      agentId,
      { [categoryNormalized]: 120 },
      { [categoryNormalized]: 20 },
    );

    const skillEngine = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    await runCheckEffectivenessForAllSkills({
      skillEngine,
      registryGet: (_id: string) => ({ role: 'reviewer' }),
      projectRoot: tmpDir,
    });

    const fm = readFrontmatter(skillPath);
    expect(fm.status).toBe('passed');
  });

  it('skips agents with role=implementer', async () => {
    const agentId = 'agent-impl';
    const category = 'injection-vectors';

    writeSkillFile(tmpDir, agentId, category, {
      baseline_accuracy_correct: 50,
      baseline_accuracy_hallucinated: 50,
      bound_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'pending',
      migration_count: 2,
    });

    const perfReader = makeStubPerfReader(tmpDir, agentId, { [category]: 170 }, { [category]: 70 });
    const skillEngine = new SkillEngine(makeStubLLM(), perfReader, tmpDir);
    const spy = jest.spyOn(skillEngine, 'checkEffectiveness');

    await runCheckEffectivenessForAllSkills({
      skillEngine,
      registryGet: (_id: string) => ({ role: 'implementer' }),
      projectRoot: tmpDir,
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('handles agents with no skills dir gracefully', async () => {
    // Create agent dir WITHOUT a skills/ subdirectory
    const agentDir = join(tmpDir, '.gossip', 'agents', 'agent-noskildir');
    mkdirSync(agentDir, { recursive: true });

    const perfReader = new PerformanceReader(tmpDir);
    const skillEngine = new SkillEngine(makeStubLLM(), perfReader, tmpDir);
    const spy = jest.spyOn(skillEngine, 'checkEffectiveness');

    await expect(
      runCheckEffectivenessForAllSkills({
        skillEngine,
        registryGet: () => ({ role: 'reviewer' }),
        projectRoot: tmpDir,
      }),
    ).resolves.toBeUndefined();

    expect(spy).not.toHaveBeenCalled();
  });

  it('returns immediately when .gossip/agents does not exist', async () => {
    const perfReader = new PerformanceReader(tmpDir);
    const skillEngine = new SkillEngine(makeStubLLM(), perfReader, tmpDir);
    const spy = jest.spyOn(skillEngine, 'checkEffectiveness');

    await expect(
      runCheckEffectivenessForAllSkills({
        skillEngine,
        registryGet: () => ({ role: 'reviewer' }),
        projectRoot: tmpDir,
      }),
    ).resolves.toBeUndefined();

    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows per-skill errors and continues to remaining skills', async () => {
    const agentId = 'agent-err';
    const category1 = 'trust-boundaries';
    const category2 = 'injection-vectors';

    // Write two skill files
    const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, `${category1}.md`), `---\nstatus: pending\n---\n\n## Body\n`);
    writeFileSync(join(skillDir, `${category2}.md`), `---\nstatus: pending\n---\n\n## Body\n`);

    const perfReader = new PerformanceReader(tmpDir);
    const skillEngine = new SkillEngine(makeStubLLM(), perfReader, tmpDir);

    let callCount = 0;
    jest.spyOn(skillEngine, 'checkEffectiveness').mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('simulated error on first skill');
      return { status: 'pending', shouldUpdate: false };
    });

    // Should NOT throw — error for first skill is swallowed, second skill still runs
    await expect(
      runCheckEffectivenessForAllSkills({
        skillEngine,
        registryGet: () => ({ role: 'reviewer' }),
        projectRoot: tmpDir,
      }),
    ).resolves.toBeUndefined();

    expect(callCount).toBe(2);
  });

  it('processes multiple agents independently', async () => {
    for (const agentId of ['agent-a', 'agent-b']) {
      writeSkillFile(tmpDir, agentId, 'error-handling', {
        baseline_accuracy_correct: 10,
        baseline_accuracy_hallucinated: 10,
        bound_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'pending',
        migration_count: 2,
      });
    }

    const perfA = makeStubPerfReader(tmpDir, 'agent-a', { 'error-handling': 50 }, { 'error-handling': 10 });
    const perfB = makeStubPerfReader(tmpDir, 'agent-b', { 'error-handling': 50 }, { 'error-handling': 10 });

    // Use a shared reader that covers both agents
    const combinedReader = new PerformanceReader(tmpDir);
    jest.spyOn(combinedReader, 'getScores').mockReturnValue(
      new Map([
        ['agent-a', (perfA.getScores() as Map<string, AgentScore>).get('agent-a')!],
        ['agent-b', (perfB.getScores() as Map<string, AgentScore>).get('agent-b')!],
      ]),
    );

    const skillEngine = new SkillEngine(makeStubLLM(), combinedReader, tmpDir);
    const spy = jest.spyOn(skillEngine, 'checkEffectiveness');

    await runCheckEffectivenessForAllSkills({
      skillEngine,
      registryGet: () => ({ role: 'reviewer' }),
      projectRoot: tmpDir,
    });

    // Called once per (agent, category) pair = 2 calls
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith('agent-a', 'error-handling', { role: 'reviewer' });
    expect(spy).toHaveBeenCalledWith('agent-b', 'error-handling', { role: 'reviewer' });
  });
});
