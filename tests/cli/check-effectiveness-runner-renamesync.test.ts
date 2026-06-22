/**
 * Regression: writeHealthAtomic must not crash the runner or leave .tmp / partial
 * artifacts when fs.renameSync fails (EPERM, EXDEV, etc).
 *
 * The runner writes a small health JSON via tmp-then-rename. If renameSync
 * throws, the runner must:
 *   - swallow the error (no uncaught throw out of runCheckEffectivenessForAllSkills)
 *   - log the failure to stderr
 *   - leave NO partial JSON at the final path
 * Spec: consensus 97636615-f9f54441 (Option B follow-up).
 */
import { mkdirSync, existsSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PerformanceReader, SkillEngine } from '@gossip/orchestrator';
import { runCheckEffectivenessForAllSkills } from '../../apps/cli/src/handlers/check-effectiveness-runner';

function makeTmp(label: string): string {
  return join(tmpdir(), `gossip-renamesync-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

const stubLlm = {
  generate: async () => { throw new Error('LLM should not be called'); },
} as any;

describe('runCheckEffectivenessForAllSkills — renameSync failure handling', () => {
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

  it('does not crash, logs to stderr, leaves no .tmp / partial json when renameSync fails', async () => {
    // Force a real renameSync failure: pre-create the FINAL path as a non-empty
    // DIRECTORY. POSIX rename() onto an existing non-empty directory fails with
    // ENOTEMPTY/EISDIR/EEXIST depending on platform — exercising the same
    // failure path as EPERM/EXDEV without mocking fs (fs.renameSync is non-
    // configurable in Node 20+ so jest.spyOn cannot redefine it).
    const gossipDir = join(projectRoot, '.gossip');
    const finalPath = join(gossipDir, 'skill-runner-health.json');
    mkdirSync(finalPath, { recursive: true });
    // Add a child file so the dir is non-empty — rename onto it MUST fail.
    writeFileSync(join(finalPath, 'sentinel'), 'x');

    const perfReader = new PerformanceReader(projectRoot);
    const engine = new SkillEngine(stubLlm, perfReader, projectRoot);

    // Runner walks zero agents (clean tmp tree). No skills evaluated, but the
    // health write at the tail is still attempted — and that's where rename fails.
    await expect(runCheckEffectivenessForAllSkills({
      skillEngine: engine,
      registryGet: (_id: string) => undefined,
      projectRoot,
    })).resolves.toBeUndefined();

    // Final path was pre-seeded as a directory (the failure trigger). The
    // CRITICAL assertions are: (a) no partial JSON file replaced our sentinel,
    // (b) no .tmp leftover, (c) runner did not crash. (a) is implicit — if
    // rename had silently succeeded, the directory would be gone.
    expect(existsSync(join(finalPath, 'sentinel'))).toBe(true);

    // No .tmp leftover at the final path location — writeHealthAtomic now
    // cleans its tmp on rename failure.
    expect(existsSync(finalPath + '.tmp')).toBe(false);

    // Defensive: scan .gossip for any stray .tmp files.
    if (existsSync(gossipDir)) {
      const stray = readdirSync(gossipDir).filter((f) => f.endsWith('.tmp'));
      expect(stray).toEqual([]);
    }

    // Stderr error logged.
    const allStderr = stderrLines.join('');
    expect(allStderr).toMatch(/health write failed/);
  });
});
