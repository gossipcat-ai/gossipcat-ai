/**
 * Integration test for the post-collect skill graduation runner.
 *
 * Seeds a tmp .gossip/agents/<id>/skills/<cat>.md (status:pending) plus an
 * agent-performance.jsonl with enough `agreement` signals to push the
 * verdict to `passed`. Calls runCheckEffectivenessForAllSkills directly
 * and asserts:
 *   - skill file flips to `status: passed`
 *   - .gossip/skill-runner-health.json is written with the expected shape
 *   - entry + exit log lines reach stderr
 *
 * Spec: consensus 4bd62d6c-46fd4e55.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceReader, SkillEngine } from '@gossip/orchestrator';
import { runCheckEffectivenessForAllSkills } from '../../apps/cli/src/handlers/check-effectiveness-runner';

function makeTmp(label: string): string {
  return join(tmpdir(), `gossip-skill-runner-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

// Minimal LLM provider — checkEffectiveness does not call generate when
// shouldUpdate fires off counter math, so a never-called stub is safe.
const stubLlm = {
  generate: async () => { throw new Error('LLM should not be called by checkEffectiveness'); },
} as any;

describe('runCheckEffectivenessForAllSkills — lifecycle integration', () => {
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
    stderrSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('flips a pending skill to passed, writes health file, logs entry+exit', async () => {
    const agentId = 'test-reviewer';
    const category = 'concurrency';

    // Seed skill file — status:pending, baselines that allow easy graduation.
    const skillsDir = join(projectRoot, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const boundAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    const skillBody = '# concurrency skill\n\nGuidance text.';
    writeFileSync(
      join(skillsDir, `${category}.md`),
      `---\n` +
      `status: pending\n` +
      `version: 1\n` +
      `baseline_accuracy_correct: 0\n` +
      `baseline_accuracy_hallucinated: 0\n` +
      `bound_at: ${boundAt}\n` +
      `migration_count: 0\n` +
      `---\n${skillBody}\n`,
    );

    // Seed signals: 80 `agreement` signals AFTER bound_at, all in the
    // concurrency category, so getCountersSince returns correct=80 hall=0.
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

    await runCheckEffectivenessForAllSkills({
      skillEngine: engine,
      registryGet: (_id: string) => ({ role: 'reviewer' }),
      projectRoot,
    });

    // Skill file should be re-written with status: passed
    const updated = readFileSync(join(skillsDir, `${category}.md`), 'utf8');
    expect(updated).toMatch(/status:\s*"?passed"?/);

    // Health file written + shape matches
    const healthPath = join(projectRoot, '.gossip', 'skill-runner-health.json');
    expect(existsSync(healthPath)).toBe(true);
    const health = JSON.parse(readFileSync(healthPath, 'utf8'));
    expect(typeof health.last_run_at).toBe('string');
    expect(typeof health.last_run_duration_ms).toBe('number');
    expect(health.skills_evaluated).toBe(1);
    expect(health.transitions).toEqual(expect.objectContaining({
      passed: expect.any(Number),
      failed: expect.any(Number),
      flagged_for_manual_review: expect.any(Number),
      inconclusive: expect.any(Number),
      pending: expect.any(Number),
    }));
    expect(health.transitions.passed).toBeGreaterThanOrEqual(1);
    expect(health.last_error).toBeNull();

    // Stderr entry + exit lines
    const allStderr = stderrLines.join('');
    expect(allStderr).toMatch(/checkEffectiveness: scanning across 1 agents/);
    expect(allStderr).toMatch(/checkEffectiveness: done in \d+ms \(skills: 1, transitions: \d+\)/);
  });

  it('writes health file even when no agents are present', async () => {
    const perfReader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(stubLlm, perfReader, projectRoot);

    await runCheckEffectivenessForAllSkills({
      skillEngine: engine,
      registryGet: (_id: string) => undefined,
      projectRoot,
    });

    const healthPath = join(projectRoot, '.gossip', 'skill-runner-health.json');
    expect(existsSync(healthPath)).toBe(true);
    const health = JSON.parse(readFileSync(healthPath, 'utf8'));
    expect(health.skills_evaluated).toBe(0);

    const allStderr = stderrLines.join('');
    expect(allStderr).toMatch(/scanning across 0 agents/);
  });
});
