import { execFile } from 'node:child_process';
import { basename } from 'path';
import { activeTasksHandler } from './api-active-tasks';

export interface SessionResponse {
  gitBranch: string | null;
  projectName: string;
  activeTasks: number;
}

/**
 * Resolves the current git branch for `cwd` safely.
 *
 * Safety properties:
 * - Uses execFile (not exec/shell) with a fixed args array — no user input reaches argv.
 * - Hard timeout of 1 500 ms; any spawn error / timeout / non-zero exit → null.
 * - Returns null for detached HEAD ("HEAD"), empty stdout, or any error.
 * - Never throws; callers always receive a resolved Promise.
 */
function resolveGitBranch(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, timeout: 1500 },
      (err, stdout) => {
        if (done) return;
        done = true;
        if (err) { resolve(null); return; }
        const branch = stdout.trim();
        if (!branch || branch === 'HEAD') { resolve(null); return; }
        resolve(branch);
      },
    );
    // Belt-and-suspenders: if the child object itself fails to spawn the callback
    // fires with an error, but guard against unexpected missing-callback paths.
    child.on('error', () => {
      if (!done) { done = true; resolve(null); }
    });
  });
}

export async function sessionHandler(projectRoot: string): Promise<SessionResponse> {
  const [gitBranch, activeTasks] = await Promise.all([
    resolveGitBranch(projectRoot).catch(() => null),
    activeTasksHandler(projectRoot).then((r) => r.tasks.length).catch(() => 0),
  ]);

  return {
    gitBranch,
    projectName: basename(projectRoot),
    activeTasks,
  };
}
