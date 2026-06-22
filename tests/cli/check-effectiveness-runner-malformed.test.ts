/**
 * Regression: a malformed skill file (e.g. unterminated YAML quote) must NOT
 * stop the runner from processing other skills. The runner swallows per-skill
 * errors and logs them — one bad file should not poison the whole pass.
 *
 * Spec: consensus 97636615-f9f54441 (Option B follow-up).
 */
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCheckEffectivenessForAllSkills } from '../../apps/cli/src/handlers/check-effectiveness-runner';

function makeTmp(label: string): string {
  return join(tmpdir(), `gossip-malformed-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('runCheckEffectivenessForAllSkills — malformed skill file isolation', () => {
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

  it('keeps walking siblings when one skill file is malformed; engine called for the good skill, throw is logged', async () => {
    const agentId = 'test-agent';
    const skillsDir = join(projectRoot, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillsDir, { recursive: true });

    // Good skill — valid frontmatter.
    writeFileSync(
      join(skillsDir, 'good-skill.md'),
      '---\n' +
      'status: pending\n' +
      'version: 1\n' +
      'baseline_accuracy_correct: 0\n' +
      'baseline_accuracy_hallucinated: 0\n' +
      'bound_at: 2026-01-01T00:00:00.000Z\n' +
      'migration_count: 0\n' +
      '---\n# good\n',
    );

    // Bad skill — unterminated quote on the status field. checkEffectiveness
    // should throw on this file when it tries to parse frontmatter.
    writeFileSync(
      join(skillsDir, 'bad-skill.md'),
      '---\n' +
      'status: "pending\n' +     // <-- unterminated quote, malformed YAML
      'version: 1\n' +
      '---\n# bad\n',
    );

    const calledFor: string[] = [];
    const fakeSkillEngine: any = {
      checkEffectiveness: jest.fn(async (_agentId: string, category: string) => {
        calledFor.push(category);
        if (category === 'bad-skill') {
          throw new Error('YAML parse failure: unterminated string');
        }
        return { status: 'pending', shouldUpdate: false };
      }),
    };

    await expect(runCheckEffectivenessForAllSkills({
      skillEngine: fakeSkillEngine,
      registryGet: (_id: string) => ({ role: 'reviewer' }),
      projectRoot,
    })).resolves.toBeUndefined();

    // Both files were attempted (the runner doesn't pre-parse the YAML — it
    // hands the work to the engine). The good one returns a verdict, the bad
    // one throws and that throw is caught + logged.
    expect(calledFor).toEqual(expect.arrayContaining(['good-skill', 'bad-skill']));
    expect(fakeSkillEngine.checkEffectiveness).toHaveBeenCalledTimes(2);

    const allStderr = stderrLines.join('');
    // Per-skill error path logs `<agentId>/<category> threw: <message>`.
    expect(allStderr).toMatch(/test-agent\/bad-skill threw: /);
    // Done line still emitted — the loop didn't bail early.
    expect(allStderr).toMatch(/checkEffectiveness: done in \d+ms/);
  });
});
