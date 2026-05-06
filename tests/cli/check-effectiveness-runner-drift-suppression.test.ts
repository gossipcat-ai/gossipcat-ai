/**
 * Drift-suppression integration test for the post-collect skill graduation runner.
 *
 * Reproduces the bug from consensus c491f76c-14e545b1:
 *   skill-engine.checkEffectiveness writes the verdict via writeSkillFileFromParts,
 *   which returns ok:false on version drift. The runner used to log a
 *   transition + increment skill-runner-health.json counters even when the
 *   updated frontmatter never reached disk — phantom transitions that lie to
 *   operators while skill-loader.ts keeps reading stale on-disk status.
 *
 * Fix: skill-engine attaches `verdict.persisted = false` on drift abort; the
 * runner wraps both the stderr log and the transition counter in a single
 * `verdict.persisted !== false` guard.
 *
 * Harness mirrors tests/cli/check-effectiveness-runner-lifecycle.test.ts and the
 * deterministic-race pattern in tests/orchestrator/skill-engine-concurrency.test.ts.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceReader, SkillEngine } from '@gossip/orchestrator';
import { __setSkillEngineTestHook } from '../../packages/orchestrator/src/skill-engine';
import { runCheckEffectivenessForAllSkills } from '../../apps/cli/src/handlers/check-effectiveness-runner';

function makeTmp(label: string): string {
  return join(tmpdir(), `gossip-drift-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

const stubLlm = {
  generate: async () => { throw new Error('LLM should not be called by checkEffectiveness'); },
} as any;

describe('runCheckEffectivenessForAllSkills — drift suppression', () => {
  let projectRoot: string;
  let stderrSpy: jest.SpyInstance;
  let stderrLines: string[];

  beforeEach(() => {
    projectRoot = makeTmp('proj');
    mkdirSync(projectRoot, { recursive: true });
    stderrLines = [];
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      stderrLines.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    __setSkillEngineTestHook(null);
    stderrSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('suppresses phantom transition + log line when verdict writeback aborts on drift', async () => {
    const agentId = 'test-reviewer';
    const category = 'concurrency';

    // Seed skill file at version 1, status:pending, baselines that allow
    // graduation under the seeded signal volume.
    const skillsDir = join(projectRoot, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const boundAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const skillPath = join(skillsDir, `${category}.md`);
    const skillBody = '# concurrency skill\n\nGuidance text.';
    writeFileSync(
      skillPath,
      `---\n` +
      `status: pending\n` +
      `version: 1\n` +
      `baseline_accuracy_correct: 0\n` +
      `baseline_accuracy_hallucinated: 0\n` +
      `bound_at: ${boundAt}\n` +
      `migration_count: 0\n` +
      `---\n${skillBody}\n`,
    );

    // Seed enough agreement signals to drive verdict.shouldUpdate=true /
    // verdict.status='passed'. Mirrors the lifecycle harness.
    const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    const sigLines: string[] = [];
    const now = Date.now();
    for (let i = 0; i < 80; i++) {
      sigLines.push(JSON.stringify({
        type: 'consensus',
        signal: 'agreement',
        agentId,
        category,
        taskId: `t-${i}`,
        timestamp: new Date(now - (80 - i) * 1000).toISOString(),
      }));
    }
    writeFileSync(perfPath, sigLines.join('\n') + '\n');

    const perfReader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(stubLlm, perfReader, projectRoot);

    // Install hook BEFORE runner invocation. Hook fires inside writer A
    // (verdict writeback) after the drift check passes but before the atomic
    // rename — sibling writer B bumps disk to v5, forcing A's post-hook
    // re-read to abort. The runner must observe verdict.persisted=false and
    // suppress both the stderr log line AND the transitions.passed++.
    __setSkillEngineTestHook(() => {
      const current = readFileSync(skillPath, 'utf-8');
      // Bump version 1 → 5 to simulate a sibling writeback (any value > expected
      // disk version of 1 triggers the post-hook drift abort).
      const patched = current.replace(/version:\s*1\b/, 'version: 5');
      writeFileSync(skillPath, patched);
    });

    await runCheckEffectivenessForAllSkills({
      skillEngine: engine,
      registryGet: (_id: string) => ({ role: 'reviewer' }),
      projectRoot,
    });

    // Drift abort surfaced on stderr (proof the abort path was taken).
    const allStderr = stderrLines.join('');
    expect(allStderr).toMatch(/verdict writeback aborted/);

    // CRITICAL: the runner-level "passed" log must NOT have fired. This is
    // the phantom-log line the fix suppresses. Match the runner-specific
    // prefix to avoid colliding with the skill-engine drift log above.
    expect(allStderr).not.toMatch(
      new RegExp(`\\[gossipcat\\] checkEffectiveness ${agentId}/${category}: passed`),
    );

    // CRITICAL: transitions.passed must remain 0 — no phantom transition.
    const healthPath = join(projectRoot, '.gossip', 'skill-runner-health.json');
    expect(existsSync(healthPath)).toBe(true);
    const health = JSON.parse(readFileSync(healthPath, 'utf8'));
    expect(health.transitions.passed).toBe(0);

    // Disk file must still reflect sibling B's v5, NOT a clobbering v2 from A.
    const finalRaw = readFileSync(skillPath, 'utf-8');
    expect(finalRaw).toMatch(/version:\s*5/);
  });
});
