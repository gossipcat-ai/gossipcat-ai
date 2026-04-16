import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  constructor(private projectRoot: string) {}

  async create(taskId: string): Promise<{ path: string; branch: string }> {
    const branch = `gossip-${taskId}`;
    const wtPath = await mkdtemp(join(tmpdir(), 'gossip-wt-'));

    await execFileAsync('git', ['branch', branch, 'HEAD'], { cwd: this.projectRoot });
    try {
      await execFileAsync('git', ['worktree', 'add', wtPath, branch], { cwd: this.projectRoot });
    } catch (err) {
      try { await execFileAsync('git', ['branch', '-D', branch], { cwd: this.projectRoot }); } catch {}
      throw err;
    }

    return { path: wtPath, branch };
  }

  async merge(taskId: string): Promise<{ merged: boolean; conflicts?: string[] }> {
    const branch = `gossip-${taskId}`;

    const log = await execFileAsync('git', ['log', `HEAD..${branch}`, '--oneline'], { cwd: this.projectRoot });
    if (!log.stdout.trim()) return { merged: true };

    try {
      await execFileAsync('git', ['merge', branch, '--no-edit'], { cwd: this.projectRoot });
      return { merged: true };
    } catch {
      await execFileAsync('git', ['merge', '--abort'], { cwd: this.projectRoot });
      const diff = await execFileAsync('git', ['diff', '--name-only', `HEAD...${branch}`], { cwd: this.projectRoot });
      const files = diff.stdout.trim();
      return { merged: false, conflicts: files ? files.split('\n') : [] };
    }
  }

  async cleanup(taskId: string, wtPath: string): Promise<void> {
    const branch = `gossip-${taskId}`;
    try { await execFileAsync('git', ['worktree', 'remove', wtPath, '--force'], { cwd: this.projectRoot }); } catch { /* already removed */ }
    try { await execFileAsync('git', ['branch', '-D', branch], { cwd: this.projectRoot }); } catch { /* branch in use */ }
  }

  async pruneOrphans(): Promise<void> {
    try {
      const result = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: this.projectRoot });
      const orphans = result.stdout.split('\n\n')
        .filter(block => block.includes('gossip-wt-'))
        .map(block => block.match(/worktree (.+)/)?.[1])
        .filter(Boolean);
      for (const wtPath of orphans) {
        try { await execFileAsync('git', ['worktree', 'remove', wtPath!, '--force'], { cwd: this.projectRoot }); } catch {}
      }
      await execFileAsync('git', ['worktree', 'prune'], { cwd: this.projectRoot });
      const branchResult = await execFileAsync('git', ['branch', '--list', 'gossip-*'], { cwd: this.projectRoot });
      const branches = branchResult.stdout.trim().split('\n').map(b => b.trim().replace(/^\*\s*/, '')).filter(Boolean);
      for (const b of branches) {
        try { await execFileAsync('git', ['branch', '-D', b], { cwd: this.projectRoot }); } catch {}
      }
    } catch { /* git not available or no worktrees */ }
  }
}
