/**
 * v3 migration and skill-loader quarantine tests for the drift detector.
 *
 * Spec: docs/specs/2026-05-13-passed-skill-drift-detection.md steps 3 + 7.
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  SkillEngine,
  PerformanceReader,
  type ILLMProvider,
} from '@gossip/orchestrator';
import { loadSkills } from '../../packages/orchestrator/src/skill-loader';

function mockLLM(): ILLMProvider {
  return { generate: jest.fn().mockResolvedValue({ text: '' }) };
}

function writeSignals(dir: string, signals: object[]): void {
  const data = signals.map((s) => JSON.stringify(s)).join('\n') + '\n';
  writeFileSync(join(dir, '.gossip', 'agent-performance.jsonl'), data);
}

// Frontmatter for a v2 `passed` skill (migration_count=2, no drift fields).
function v2PassedSkill(boundAt: string): string {
  return `---
name: injection-audit
description: test
keywords: [injection]
category: injection_vectors
status: passed
mode: contextual
bound_at: "${boundAt}"
baseline_accuracy_correct: 70
baseline_accuracy_hallucinated: 30
migration_count: 2
version: 1
---

# Injection Audit

## Iron Law

Trace inputs.

## When This Skill Activates

- injection

## Methodology

1. Map
2. Trace
3. Verify

## Anti-Patterns

| Thought | Reality |
|---------|---------|
| ok | bad |

## Quality Gate

- [ ] cite
`;
}

describe('v3 migration — passed-skill drift backfill', () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), 'gossip-drift-mig-' + Date.now() + Math.random().toString(36).slice(2, 6));
    mkdirSync(join(testDir, '.gossip', 'agents', 'agent-a', 'skills'), { recursive: true });
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  function skillPath(): string {
    return join(testDir, '.gossip', 'agents', 'agent-a', 'skills', 'injection-vectors.md');
  }

  it('backfills passed_at + passed_baseline_rate + passed_backfilled when ≥80 signals reachable', async () => {
    // Seed 90 confirmed signals → baseline_rate = 80/90 ≈ 0.889
    const signals: object[] = [];
    for (let i = 0; i < 80; i++) {
      signals.push({
        type: 'consensus',
        signal: 'category_confirmed',
        agentId: 'agent-a',
        category: 'injection_vectors',
        taskId: `t${i}`,
        timestamp: new Date(Date.now() - (90 - i) * 86400_000).toISOString(),
      });
    }
    for (let i = 0; i < 10; i++) {
      signals.push({
        type: 'consensus',
        signal: 'hallucination_caught',
        agentId: 'agent-a',
        category: 'injection_vectors',
        taskId: `h${i}`,
        timestamp: new Date(Date.now() - (90 - i) * 86400_000).toISOString(),
      });
    }
    writeSignals(testDir, signals);

    const boundAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    writeFileSync(skillPath(), v2PassedSkill(boundAt));

    const engine = new SkillEngine(mockLLM(), new PerformanceReader(testDir), testDir);
    await engine.checkEffectiveness('agent-a', 'injection_vectors');

    const after = readFileSync(skillPath(), 'utf-8');
    expect(after).toMatch(/migration_count:\s*3/);
    expect(after).toMatch(/passed_at:/);
    expect(after).toMatch(/passed_baseline_rate:/);
    expect(after).toMatch(/passed_backfilled:\s*true/);
  });

  it('omits passed_baseline_rate when fewer than MIN_EVIDENCE reachable signals (PAUSED)', async () => {
    // Fresh-install case: no signals at all.
    writeSignals(testDir, []);

    const boundAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    writeFileSync(skillPath(), v2PassedSkill(boundAt));

    const engine = new SkillEngine(mockLLM(), new PerformanceReader(testDir), testDir);
    await engine.checkEffectiveness('agent-a', 'injection_vectors');

    const after = readFileSync(skillPath(), 'utf-8');
    expect(after).toMatch(/migration_count:\s*3/);
    expect(after).toMatch(/passed_at:/);
    expect(after).toMatch(/passed_backfilled:\s*true/);
    expect(after).not.toMatch(/passed_baseline_rate:/);
  });

  it('is idempotent: second run does not re-mutate frontmatter (migration_count >= 3 guard)', async () => {
    writeSignals(testDir, []);
    const boundAt = new Date(Date.now() - 5 * 86400_000).toISOString();
    writeFileSync(skillPath(), v2PassedSkill(boundAt));

    const engine = new SkillEngine(mockLLM(), new PerformanceReader(testDir), testDir);
    await engine.checkEffectiveness('agent-a', 'injection_vectors');
    const afterFirst = readFileSync(skillPath(), 'utf-8');

    await engine.checkEffectiveness('agent-a', 'injection_vectors');
    const afterSecond = readFileSync(skillPath(), 'utf-8');

    // Body should be byte-identical — no second migration mutation.
    // (version may bump on writeback. The migration-count guard prevents
    // the v3 step body from re-running.)
    expect(afterSecond.match(/migration_count:\s*3/)).not.toBeNull();
    // Same passed_at across both runs — would change if v3 fired twice.
    const passedAt1 = afterFirst.match(/passed_at:\s*([^\n]+)/)?.[1];
    const passedAt2 = afterSecond.match(/passed_at:\s*([^\n]+)/)?.[1];
    expect(passedAt2).toBe(passedAt1);
  });
});

describe('skill-loader quarantine — drift-demoted skills', () => {
  let testDir: string;
  beforeEach(() => {
    testDir = join(tmpdir(), 'gossip-drift-loader-' + Date.now() + Math.random().toString(36).slice(2, 6));
    mkdirSync(join(testDir, '.gossip', 'agents', 'agent-a', 'skills'), { recursive: true });
  });
  afterEach(() => rmSync(testDir, { recursive: true, force: true }));

  function writeSkill(name: string, frontmatter: string): void {
    const content = `---
name: ${name}
description: t
keywords: [injection]
status: inconclusive
${frontmatter}
---

# ${name}
`;
    writeFileSync(join(testDir, '.gossip', 'agents', 'agent-a', 'skills', `${name}.md`), content);
  }

  it('quarantines drift-demoted (regressed_from_passed_at set)', () => {
    writeSkill('injection-vectors', 'regressed_from_passed_at: "2026-05-01T00:00:00Z"');

    const result = loadSkills('agent-a', ['injection-vectors'], testDir);
    expect(result.loaded).not.toContain('injection-vectors');
    const drop = result.dropped.find((d) => d.skill === 'injection-vectors');
    expect(drop?.reason).toBe('status-drift-demoted');
  });

  it('does NOT quarantine organic inconclusive (no regressed_from_passed_at)', () => {
    writeSkill('injection-vectors', 'mode: contextual');

    const result = loadSkills('agent-a', ['injection-vectors'], testDir, undefined, 'injection sql sanitize');
    // The skill loads normally — its inconclusive status doesn't block injection.
    // Either loaded (if keyword threshold met) or dropped for a non-status reason.
    const drop = result.dropped.find((d) => d.skill === 'injection-vectors');
    expect(drop?.reason).not.toBe('status-drift-demoted');
    expect(drop?.reason).not.toBe('status-failed');
    expect(drop?.reason).not.toBe('status-silent');
  });
});
