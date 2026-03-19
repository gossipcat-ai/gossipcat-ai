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

  async gitDiff(args?: { staged?: boolean }): Promise<string> {
    return args?.staged ? this.git('diff', '--staged') : this.git('diff');
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
