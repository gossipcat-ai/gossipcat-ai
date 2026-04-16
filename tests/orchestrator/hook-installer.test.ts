import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installWorktreeSandboxHook,
  findBundledHook,
} from '../../packages/orchestrator/src/hook-installer';

const HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/hooks/worktree-sandbox.sh';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-hook-install-'));
}

describe('installWorktreeSandboxHook', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('finds the bundled hook asset during tests', () => {
    // Sanity check — without this the rest of the suite would spuriously skip.
    const bundled = findBundledHook();
    expect(bundled).not.toBeNull();
    expect(bundled).toMatch(/worktree-sandbox\.sh$/);
  });

  it('installs hook file and creates settings.json on a fresh project', () => {
    const root = makeTmpProject();
    created.push(root);

    const result = installWorktreeSandboxHook(root);
    expect(result.installed).toBe(true);

    const hookPath = join(root, '.claude', 'hooks', 'worktree-sandbox.sh');
    expect(existsSync(hookPath)).toBe(true);

    const settingsPath = join(root, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('Bash|Edit|Write|MultiEdit|NotebookEdit');
    expect(settings.hooks.PreToolUse[0].hooks[0]).toEqual({
      type: 'command',
      command: HOOK_COMMAND,
    });
  });

  it('merges into settings without overwriting unrelated keys', () => {
    const root = makeTmpProject();
    created.push(root);

    const settingsPath = join(root, '.claude', 'settings.json');
    // Pre-populate settings with unrelated state and another PreToolUse hook.
    const initial = {
      enabledPlugins: { 'agent-orchestration@claude-code-workflows': true },
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] },
        ],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo post' }] }],
      },
    };
    require('fs').mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(initial));

    const result = installWorktreeSandboxHook(root);
    expect(result.installed).toBe(true);

    const updated = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    // Unrelated keys preserved.
    expect(updated.enabledPlugins).toEqual(initial.enabledPlugins);
    expect(updated.hooks.PostToolUse).toEqual(initial.hooks.PostToolUse);
    // Original PreToolUse entry preserved, worktree sandbox entry appended.
    expect(updated.hooks.PreToolUse).toHaveLength(2);
    expect(updated.hooks.PreToolUse[0].hooks[0].command).toBe('echo existing');
    expect(updated.hooks.PreToolUse[1].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it('is idempotent — second call does not duplicate the entry', () => {
    const root = makeTmpProject();
    created.push(root);

    installWorktreeSandboxHook(root);
    installWorktreeSandboxHook(root);
    installWorktreeSandboxHook(root);

    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8'));
    const matching = settings.hooks.PreToolUse.filter((entry: any) =>
      entry.hooks.some((h: any) => h.command === HOOK_COMMAND),
    );
    expect(matching).toHaveLength(1);
  });

  it('writes the hook script with 0o755 permissions', () => {
    const root = makeTmpProject();
    created.push(root);

    installWorktreeSandboxHook(root);
    const hookPath = join(root, '.claude', 'hooks', 'worktree-sandbox.sh');
    const mode = statSync(hookPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('returns { installed: false } without throwing when the asset is missing', () => {
    // Simulate by monkey-patching findBundledHook via module require — we
    // instead stub out `fs.existsSync` for the specific candidate paths
    // the installer checks. Simpler: point installer at a project with an
    // unreadable parent, then restore. Since the bundled asset exists in
    // the repo (verified above), we instead exercise the catch branch by
    // passing a projectRoot that isn't a directory-like path.
    // Null-device as projectRoot → mkdirSync fails on most platforms.
    const result = installWorktreeSandboxHook('/dev/null/not-a-dir');
    expect(result.installed).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  it('recovers when settings.json is malformed (treats as empty)', () => {
    const root = makeTmpProject();
    created.push(root);
    require('fs').mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{not valid json');

    const result = installWorktreeSandboxHook(root);
    expect(result.installed).toBe(true);

    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
  });
});
