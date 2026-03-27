import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class GitTools {
  constructor(private cwd: string) {}

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: this.cwd });
      return stdout.trim();
    } catch (err: unknown) {
      const error = err as Error & { stderr?: string };
      const msg = error.stderr ? error.stderr.trim() : error.message;
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
        const { stdout } = await execFileAsync(
          'git', ['diff', '--no-index', '/dev/null', file],
          { cwd: this.cwd },
        ).catch((err: unknown) => {
          const e = err as Error & { stdout?: string };
          return { stdout: e.stdout || '' };
        });
        if (stdout) diffs.push(stdout.trim());
      } catch (err) {
        // skip files that can't be diffed (binary, symlinks, etc.)
      }
    }
    return diffs.join('\n');
  }

  async gitLog(args?: { count?: number }): Promise<string> {
    return this.git('log', '--oneline', `-${args?.count || 20}`);
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
