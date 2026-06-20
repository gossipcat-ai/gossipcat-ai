/**
 * Security test for findBundledHook — cwd fallback removal (issue #570).
 *
 * A planted ./assets/hooks/worktree-sandbox.sh in the current working directory
 * must NEVER be probed by findBundledHook(), even if it exists. The cwd
 * candidate is attacker-influenceable and was removed as a security fix.
 *
 * This test uses jest.spyOn on the `fs` module object (via require('fs')) to
 * record every path that findBundledHook() probes, then asserts the cwd-planted
 * path is never among the probed candidates — i.e. not just "not returned" but
 * "never checked".
 *
 * hook-installer.ts uses `import { existsSync } from 'fs'` — a named CJS
 * re-export. In Jest's node environment the named export and the module property
 * are the same reference on the module object, so spyOn(require('fs'),
 * 'existsSync') intercepts the call. We verify the spy actually intercepted by
 * asserting probedPaths.length > 0.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-cwd-security-'));
}

describe('findBundledHook — cwd fallback must not be used (security #570)', () => {
  const created: string[] = [];
  const originalCwd = process.cwd();

  afterEach(() => {
    // Always restore cwd before cleanup.
    process.chdir(originalCwd);
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('does NOT probe the cwd-planted hook path (existsSync never called with it)', () => {
    const tmp = makeTmpDir();
    created.push(tmp);

    // Plant an attacker-controlled hook at <tmp>/assets/hooks/worktree-sandbox.sh.
    const plantedDir = join(tmp, 'assets', 'hooks');
    mkdirSync(plantedDir, { recursive: true });
    writeFileSync(join(plantedDir, 'worktree-sandbox.sh'), '#!/bin/sh\necho "pwned"\n', { mode: 0o755 });

    // Change cwd to the attacker-controlled directory.
    process.chdir(tmp);

    // Spy on the fs module object's existsSync. In Jest's node environment,
    // named CJS imports share the same property on the module object, so this
    // intercepts calls from hook-installer.ts's `import { existsSync } from 'fs'`.
    const probedPaths: string[] = [];
    const fsModule = require('fs') as typeof import('fs');
    const realExistsSync = fsModule.existsSync.bind(fsModule);
    const spy = jest.spyOn(fsModule, 'existsSync').mockImplementation((p) => {
      probedPaths.push(String(p));
      return realExistsSync(p);
    });

    try {
      // Dynamically require to ensure it uses the spied-on fs module.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { findBundledHook } = require('../../packages/orchestrator/src/hook-installer');
      findBundledHook();
    } finally {
      spy.mockRestore();
    }

    const cwdPlantedPath = resolve(tmp, 'assets', 'hooks', 'worktree-sandbox.sh');

    // Verify the spy actually intercepted calls (must be > 0 probed paths).
    // If this assertion fails, the spy did not intercept — the test would be
    // vacuous and we must report BLOCKED.
    expect(probedPaths.length).toBeGreaterThan(0);

    // The cwd-planted path must NEVER have been probed.
    expect(probedPaths).not.toContain(cwdPlantedPath);
  });
});
