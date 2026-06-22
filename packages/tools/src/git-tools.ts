import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class GitTools {
  constructor(private cwd: string) {}

  private async execGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const opts = { cwd: this.cwd, env: { ...process.env } };
    try {
      return await execFileAsync('git', args, opts);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // libuv transient posix_spawn failure — retry once after 100ms
        await new Promise(r => setTimeout(r, 100));
        return await execFileAsync('git', args, opts);
      }
      throw err;
    }
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await this.execGit(args);
      return stdout.trim();
    } catch (err: unknown) {
      const error = err as (Error & { stderr?: string });
      let msg = 'Unknown error';
      if (error && typeof error.stderr === 'string') {
        msg = error.stderr.trim();
      } else if (error && typeof error.message === 'string') {
        msg = error.message;
      }
      throw new Error(`git ${args[0]} failed: ${msg}`);
    }
  }

  async gitStatus(): Promise<string> {
    return this.git('status', '--short');
  }

  async gitDiff(args?: { staged?: boolean; paths?: string[] }): Promise<string> {
    const flags = args?.staged ? ['diff', '--staged'] : ['diff'];
    if (args?.paths?.length) flags.push('--', ...args.paths);
    return this.git(...flags);
  }

  async gitUntrackedDiff(paths: string[]): Promise<string> {
    const diffs: string[] = [];
    // Get all untracked files under the given paths
    let untrackedFiles: string[] = [];
    try {
      const status = await this.git('status', '--porcelain', '--', ...paths);
      untrackedFiles = status.split('\n')
        .filter(line => line.startsWith('??'))
        .map(line => line.slice(3).trim());
    } catch { /* no untracked files */ }

    for (const file of untrackedFiles) {
      try {
        // git diff --no-index exits 1 when files differ — that's expected
        const { stdout } = await this.execGit(
          ['diff', '--no-index', '/dev/null', file],
        ).catch((err: unknown) => {
          const e = err as Partial<Error & { stdout: string; stderr: string }>;
          return { stdout: e.stdout || '', stderr: e.stderr || '' };
        });
        if (stdout) diffs.push(stdout.trim());
      } catch (err) {
        // skip files that can't be diffed (binary, symlinks, etc.)
      }
    }
    return diffs.join('\n');
  }

  async gitLog(args?: { count?: number; maxCount?: number; path?: string }): Promise<string> {
    const limit = args?.maxCount ?? args?.count ?? 20;
    const gitArgs = ['log', '--oneline', `-${limit}`];
    if (args?.path) gitArgs.push('--', args.path);
    return this.git(...gitArgs);
  }

  async gitCommit(args: { message: string; files?: string[] }): Promise<string> {
    if (args.files?.length) {
      await this.git('add', ...args.files);
    }
    return this.git('commit', '-m', args.message);
  }

  async gitBranch(args?: { name?: string }): Promise<string> {
    if (args?.name) {
      return this.git('checkout', '-b', args.name);
    }
    return this.git('branch', '--list');
  }
}
