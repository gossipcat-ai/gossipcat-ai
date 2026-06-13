import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SkillEngine } from '../../packages/orchestrator/src/skill-engine';
import type { ILLMProvider } from '../../packages/orchestrator/src/llm-client';
import {
  PerformanceReader,
  type AgentScore,
  type CategoryCounters,
} from '../../packages/orchestrator/src/performance-reader';

// ---------------------------------------------------------------------------
// Integration test for the recovery-window anchor selection in skill-engine.ts
// (~:994-1004). The pure-function unit suite (recovery-detection.test.ts) feeds
// `recoveryDelta` in pre-computed and therefore CANNOT catch a regression in the
// engine's anchor selection — the exact gap flagged by consensus ed784c4e
// (sonnet-reviewer f6/f10). This drives `checkEffectiveness` through SkillEngine
// so the REAL anchor → getCountersSince(sinceMs) call is exercised.
//
// The K=2 α² guarantee depends entirely on the strike-2 window anchoring at
// `recovery_strike_at` (NOT `failed_at`), so the two windows are disjoint. We
// prove this by making getCountersSince return a CONFIRMING window only for the
// expected anchor — a transition is then possible iff the engine picked it.
// ---------------------------------------------------------------------------

function makeStubLLM(): ILLMProvider {
  return { generate: jest.fn().mockResolvedValue({ text: '' }) } as unknown as ILLMProvider;
}

/**
 * PerformanceReader whose getCountersSince is driven by a per-anchor function,
 * so the test controls exactly which `sinceMs` yields a confirming window. Also
 * records every sinceMs it was called with for direct assertions.
 */
function makeAnchorAwarePerfReader(
  projectRoot: string,
  agentId: string,
  countersForSinceMs: (sinceMs: number) => CategoryCounters,
): { reader: PerformanceReader; calls: number[] } {
  const reader = new PerformanceReader(projectRoot);
  const calls: number[] = [];
  const score: AgentScore = {
    agentId,
    accuracy: 0,
    uniqueness: 0,
    reliability: 0,
    impactScore: 0,
    totalSignals: 0,
    scoringSignals: 0,
    agreements: 0,
    disagreements: 0,
    uniqueFindings: 0,
    hallucinations: 0,
    weightedHallucinations: 0,
    consecutiveFailures: 0,
    circuitOpen: false,
    categoryStrengths: {},
    categoryAccuracy: {},
    categoryCorrect: {},
    categoryHallucinated: {},
    transport_failure_count: 0,
  };
  jest.spyOn(reader, 'getScores').mockReturnValue(new Map([[agentId, score]]));
  jest.spyOn(reader, 'getCountersSince').mockImplementation((_a, _cat, sinceMs) => {
    calls.push(sinceMs);
    return countersForSinceMs(sinceMs);
  });
  return { reader, calls };
}

function writeFailedSkill(
  tmpDir: string,
  agentId: string,
  category: string,
  fields: Record<string, string | number>,
): string {
  const skillDir = join(tmpDir, '.gossip', 'agents', agentId, 'skills');
  mkdirSync(skillDir, { recursive: true });
  const skillName = category.replace(/_/g, '-');
  const skillPath = join(skillDir, `${skillName}.md`);
  const fmLines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(skillPath, `---\n${fmLines}\n---\n\n## Body\n\nContent here.\n`);
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
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    result[key] = value;
  }
  return result;
}

const CONFIRMING: CategoryCounters = { correct: 80, hallucinated: 0 }; // p=1.0, 80 ≥ DRIFT_WINDOW_SIZE, Wilson lower bound ≫ 0.75
const EMPTY: CategoryCounters = { correct: 0, hallucinated: 0 }; // window not full

describe('SkillEngine recovery — anchor selection feeds getCountersSince', () => {
  let tmpDir: string;
  const agentId = 'agent-recover';
  const category = 'trust_boundaries';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skill-recovery-anchor-'));
  });

  it('strike-1 anchors the recovery window at failed_at (not bound_at)', async () => {
    const boundAt = new Date(Date.now() - 40 * 86400_000).toISOString();
    const failedAt = new Date(Date.now() - 10 * 86400_000).toISOString();
    const failedAtMs = new Date(failedAt).getTime();

    const skillPath = writeFailedSkill(tmpDir, agentId, category, {
      baseline_accuracy_correct: 40,
      baseline_accuracy_hallucinated: 40,
      status: 'failed',
      migration_count: 3,
      bound_at: boundAt,
      failed_at: failedAt,
    });

    // Confirming ONLY at failed_at. If the engine wrongly anchored at bound_at,
    // it would get EMPTY → no strike. A recorded strike proves it used failed_at.
    const { reader, calls } = makeAnchorAwarePerfReader(tmpDir, agentId, (sinceMs) =>
      sinceMs === failedAtMs ? CONFIRMING : EMPTY,
    );
    const gen = new SkillEngine(makeStubLLM(), reader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(calls).toContain(failedAtMs); // recovery window anchored at failed_at
    expect(verdict.status).toBe('failed'); // strike 1 — not yet recovered
    const fm = readFrontmatter(skillPath);
    expect(Number(fm.recovery_strikes)).toBe(1);
    expect(fm.recovery_strike_at).toBeTruthy();
    expect(isNaN(new Date(fm.recovery_strike_at).getTime())).toBe(false);
  });

  it('strike-2 anchors at recovery_strike_at (disjoint from failed_at) and recovers to pending', async () => {
    const boundAt = new Date(Date.now() - 50 * 86400_000).toISOString();
    const failedAt = new Date(Date.now() - 20 * 86400_000).toISOString();
    const recoveryStrikeAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    const failedAtMs = new Date(failedAt).getTime();
    const recoveryStrikeAtMs = new Date(recoveryStrikeAt).getTime();

    const skillPath = writeFailedSkill(tmpDir, agentId, category, {
      baseline_accuracy_correct: 40,
      baseline_accuracy_hallucinated: 40,
      status: 'failed',
      migration_count: 3,
      bound_at: boundAt,
      failed_at: failedAt,
      recovery_strikes: 1,
      recovery_strike_at: recoveryStrikeAt,
    });

    // Confirming ONLY at recovery_strike_at. A failed_at-anchored window returns
    // EMPTY → no transition. Reaching `pending` proves the strike-2 window used
    // the disjoint recovery_strike_at anchor (the K=2 α² guarantee).
    const { reader, calls } = makeAnchorAwarePerfReader(tmpDir, agentId, (sinceMs) =>
      sinceMs === recoveryStrikeAtMs ? CONFIRMING : EMPTY,
    );
    const gen = new SkillEngine(makeStubLLM(), reader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(calls).toContain(recoveryStrikeAtMs); // strike-2 window anchored here
    expect(calls).not.toContain(failedAtMs); // NOT re-using the strike-1 anchor
    expect(verdict.status).toBe('pending'); // K=2 confirmed → suppression lifted
    const fm = readFrontmatter(skillPath);
    expect(fm.status).toBe('pending');
    expect(fm.recovered_at).toBeTruthy();
    // recovery bookkeeping reset to 0 on the failed→pending transition
    // (check-effectiveness.ts sets recovery_strikes: 0, recovery_strike_at: undefined)
    expect(Number(fm.recovery_strikes ?? 0)).toBe(0);
    expect(fm.recovery_strike_at === undefined || fm.recovery_strike_at === '').toBe(true);
  });

  it('a failed skill with no failed_at stamps the clock and does NOT recover on the same pass', async () => {
    // Legacy failed snapshot (pre-feature): no failed_at anchor. Even a fully
    // confirming window must not recover — the clock starts this pass.
    const boundAt = new Date(Date.now() - 30 * 86400_000).toISOString();
    const skillPath = writeFailedSkill(tmpDir, agentId, category, {
      baseline_accuracy_correct: 40,
      baseline_accuracy_hallucinated: 40,
      status: 'failed',
      migration_count: 3,
      bound_at: boundAt,
      // NO failed_at
    });

    // Confirming for everything — proves the guard, not the window, blocks recovery.
    const { reader } = makeAnchorAwarePerfReader(tmpDir, agentId, () => CONFIRMING);
    const gen = new SkillEngine(makeStubLLM(), reader, tmpDir);

    const verdict = await gen.checkEffectiveness(agentId, category);

    expect(verdict.status).toBe('failed');
    const fm = readFrontmatter(skillPath);
    expect(fm.failed_at).toBeTruthy(); // clock started
    expect(isNaN(new Date(fm.failed_at).getTime())).toBe(false);
    // No premature strike on the clock-start pass
    expect(fm.recovery_strikes === undefined || fm.recovery_strikes === '' || Number(fm.recovery_strikes) === 0).toBe(true);
  });
});
