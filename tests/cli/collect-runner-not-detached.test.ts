/**
 * Regression test for consensus 4bd62d6c-46fd4e55 root cause A:
 *
 * The two-phase native-prompt path in handleCollect early-returns at the
 * "EXECUTE NOW" output. Before this fix, the post-collect skill graduation
 * runner was attached AFTER the early return — so production-common rounds
 * (any consensus with a native cross-reviewer) NEVER ran the runner. PR
 * #307's setImmediate fix was structurally bypassed for this path.
 *
 * The fix: scheduleSkillRunner is called from BOTH the early-return site
 * AND the post-consensus end of the handler. This test asserts:
 *
 *   1. scheduleSkillRunner registers a tracked lifecycle task (drain awaits it)
 *   2. scheduleSkillRunner is a no-op when skillEngine is missing
 *
 * If a future refactor accidentally drops the early-return scheduleSkillRunner
 * call, the runner will not be registered on the production-common path and
 * the regression returns. Pair this with a code-search assertion if
 * desired — but the structural shape of the fix (one helper called from
 * both sites) makes that drop highly visible in review.
 */
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { scheduleSkillRunner } from '../../apps/cli/src/handlers/collect';
import {
  drainLifecycleTasks,
  __resetLifecycleTasksForTests,
} from '../../apps/cli/src/lifecycle-tasks';

function makeTmp(label: string): string {
  return join(tmpdir(), `gossip-collect-runner-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('collect — runner not detached on early-return path', () => {
  let projectRoot: string;
  let cwdSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    __resetLifecycleTasksForTests();
    projectRoot = makeTmp('proj');
    mkdirSync(projectRoot, { recursive: true });
    // process.cwd() is read inside scheduleSkillRunner — pin it to our tmp.
    cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    stderrSpy.mockRestore();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('scheduleSkillRunner registers a tracked lifecycle task that drain awaits', async () => {
    let checkEffCallCount = 0;
    // Stub skill engine — checkEffectiveness gets called for every (agent,
    // category) pair, but with no .gossip/agents tree present the runner
    // walks zero agents. Instead we plant a fake agents tree so the runner
    // reaches the engine.
    const skillsDir = join(projectRoot, '.gossip', 'agents', 'fake-reviewer', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const { writeFileSync } = require('fs');
    writeFileSync(join(skillsDir, 'concurrency.md'), '---\nstatus: pending\n---\n');

    const fakeSkillEngine: any = {
      checkEffectiveness: async () => {
        checkEffCallCount++;
        // Yield once so the test's "before drain" assertion has a chance
        // to observe the in-flight state.
        await new Promise((res) => setTimeout(res, 30));
        return { status: 'pending', shouldUpdate: false };
      },
    };
    const fakeCtx: any = { skillEngine: fakeSkillEngine };
    const fakeMainAgent: any = { getAgentConfig: (_id: string) => ({ role: 'reviewer' }) };

    // Simulate the early-return path: schedule runner, then immediately
    // "return" without awaiting. Drain MUST still see the work.
    scheduleSkillRunner(fakeCtx, fakeMainAgent);

    // Before drain: runner has not yet finished — call count is 0 (microtask
    // boundary not flushed) OR positive but not done with the timeout.
    expect(checkEffCallCount).toBeLessThanOrEqual(1);

    await drainLifecycleTasks(2000);

    // After drain: runner reached the engine for our planted skill.
    expect(checkEffCallCount).toBe(1);
  });

  it('scheduleSkillRunner is a no-op when skillEngine is missing', async () => {
    expect(typeof scheduleSkillRunner).toBe('function');
    const fakeCtx: any = { skillEngine: undefined };
    const fakeMainAgent: any = { getAgentConfig: () => undefined };
    scheduleSkillRunner(fakeCtx, fakeMainAgent);
    const start = Date.now();
    await drainLifecycleTasks(2000);
    expect(Date.now() - start).toBeLessThan(80);
  });
});
