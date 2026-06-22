import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const opts = { cwd, env: { ...process.env } };
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

export class WorktreeManager {
  constructor(private projectRoot: string) {}

  async create(taskId: string): Promise<{ path: string; branch: string }> {
    const branch = `gossip-${taskId}`;
    const wtPath = await mkdtemp(join(tmpdir(), 'gossip-wt-'));

    await execGit(['branch', branch, 'HEAD'], this.projectRoot);
    try {
      await execGit(['worktree', 'add', wtPath, branch], this.projectRoot);
    } catch (err) {
      try { await execGit(['branch', '-D', branch], this.projectRoot); } catch {}
      throw err;
    }

    return { path: wtPath, branch };
  }

  async merge(taskId: string): Promise<{ merged: boolean; conflicts?: string[] }> {
    const branch = `gossip-${taskId}`;

    const log = await execGit(['log', `HEAD..${branch}`, '--oneline'], this.projectRoot);
    if (!log.stdout.trim()) return { merged: true };

    try {
      await execGit(['merge', branch, '--no-edit'], this.projectRoot);
      return { merged: true };
    } catch {
      await execGit(['merge', '--abort'], this.projectRoot);
      const diff = await execGit(['diff', '--name-only', `HEAD...${branch}`], this.projectRoot);
      const files = diff.stdout.trim();
      return { merged: false, conflicts: files ? files.split('\n') : [] };
    }
  }

  async cleanup(taskId: string, wtPath: string): Promise<void> {
    const branch = `gossip-${taskId}`;
    try { await execGit(['worktree', 'remove', wtPath, '--force'], this.projectRoot); } catch { /* already removed */ }
    try { await execGit(['branch', '-D', branch], this.projectRoot); } catch { /* branch in use */ }
  }

  async pruneOrphans(): Promise<void> {
    try {
      const result = await execGit(['worktree', 'list', '--porcelain'], this.projectRoot);
      const orphans = result.stdout.split('\n\n')
        .filter(block => block.includes('gossip-wt-'))
        .map(block => block.match(/worktree (.+)/)?.[1])
        .filter(Boolean);
      for (const wtPath of orphans) {
        try { await execGit(['worktree', 'remove', wtPath!, '--force'], this.projectRoot); } catch {}
      }
      await execGit(['worktree', 'prune'], this.projectRoot);
      const branchResult = await execGit(['branch', '--list', 'gossip-*'], this.projectRoot);
      const branches = branchResult.stdout.trim().split('\n').map(b => b.trim().replace(/^\*\s*/, '')).filter(Boolean);
      for (const b of branches) {
        try { await execGit(['branch', '-D', b], this.projectRoot); } catch {}
      }
    } catch { /* git not available or no worktrees */ }
  }
}
