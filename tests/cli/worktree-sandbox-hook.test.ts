import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

/**
 * Shell out to the actual bash hook script and feed it synthetic PreToolUse
 * payloads. These tests verify the gating logic:
 *   - relative paths always allowed
 *   - absolute paths inside worktree cwd allowed
 *   - absolute paths outside worktree cwd denied
 *   - non-worktree cwd → pass-through allow
 *   - Bash commands with absolute path tokens scanned
 */

const HOOK_PATH = resolve(__dirname, '..', '..', 'assets', 'hooks', 'worktree-sandbox.sh');

function hasJq(): boolean {
  const probe = spawnSync('which', ['jq'], { encoding: 'utf-8' });
  return probe.status === 0 && !!probe.stdout.trim();
}

function runHook(payload: unknown): { stdout: string; status: number | null; stderr: string } {
  const input = JSON.stringify(payload);
  const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf-8' });
  return { stdout: res.stdout, status: res.status, stderr: res.stderr };
}

const runIfJq = hasJq() ? describe : describe.skip;

runIfJq('worktree-sandbox.sh', () => {
  it('the hook script exists on disk', () => {
    expect(existsSync(HOOK_PATH)).toBe(true);
  });

  it('allows relative paths in a worktree cwd', () => {
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: './src/foo.ts' },
      cwd,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('denies absolute paths outside the worktree cwd', () => {
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/Users/someone/secrets.txt' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/Users/someone/secrets.txt');
  });

  it('allows absolute paths INSIDE the worktree cwd', () => {
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: '/private/tmp/gossip-wt-abc123/src/foo.ts' },
      cwd,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('passes through when cwd is not a gossipcat worktree', () => {
    const cwd = '/Users/me/projects/other';
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd' },
      cwd,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('gates .claude/worktrees/agent-* namespace (native subagent worktrees)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gossip-hook-ns-'));
    try {
      // Synthesize a cwd that matches the native-subagent pattern.
      const cwd = `${tmp}/.claude/worktrees/agent-xyz`;
      const { stdout, status } = runHook({
        tool_name: 'Write',
        tool_input: { file_path: '/etc/hosts' },
        cwd,
      });
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('scans Bash commands for absolute path tokens and denies when outside cwd', () => {
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cat /etc/passwd' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/passwd');
  });

  it('allows Bash commands without absolute path tokens', () => {
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'npm test -- hook-installer' },
      cwd,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('never exits with code 2 — always 0 for deny-via-JSON', () => {
    const cwd = '/tmp/gossip-wt-abc123';
    const results = [
      runHook({ tool_name: 'Write', tool_input: { file_path: '/etc/passwd' }, cwd }),
      runHook({ tool_name: 'Edit', tool_input: { file_path: './x' }, cwd }),
      runHook({ tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd }),
    ];
    for (const r of results) expect(r.status).toBe(0);
  });

  it('deny output is valid JSON', () => {
    const cwd = '/tmp/gossip-wt-xyz';
    const { stdout } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/root/.ssh/id_rsa' },
      cwd,
    });
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

// Suppress unused-import lint noise under the skip branch.
void execFileSync;
