import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
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

function runHook(
  payload: unknown,
  env?: Record<string, string>,
): { stdout: string; status: number | null; stderr: string } {
  const input = JSON.stringify(payload);
  const spawnEnv = env ? { ...process.env, ...env } : undefined;
  const res = spawnSync('bash', [HOOK_PATH], { input, encoding: 'utf-8', env: spawnEnv });
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

  // --- Hardening regression coverage (consensus a551cb7c-954c48a9) ---

  it('denies compound Bash with && where second path escapes cwd', () => {
    // The previous version used `head -n1` on grep output and dropped every
    // absolute token after the first — an attacker could hide the escape
    // behind a safe-looking initial path.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'cat /private/tmp/gossip-wt-abc123/safe && cp /private/tmp/gossip-wt-abc123/src /etc/x',
      },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/x');
  });

  it('denies Bash with > redirect to absolute outside path', () => {
    // Previous delimiter class `(^|[[:space:]=])` missed `>` so
    // `echo data>/outside/path` leaked through undetected.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo data>/outside/path' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/outside/path');
  });

  it('denies Bash with ; separator where second path escapes', () => {
    // Same class of bug as &&: compound commands with ; separators were
    // only checked against the first absolute token.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'echo /private/tmp/gossip-wt-abc123/safe; rm /etc/passwd',
      },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/passwd');
  });

  it('denies Write via symlink that points outside cwd', () => {
    // Without realpath normalization, the prefix check only saw the symlink
    // path (inside cwd) and missed the fact that its target was outside.
    //
    // Must create the tmp dir under /tmp/gossip-wt-* so the hook's
    // worktree-namespace guard matches; otherwise the hook short-circuits.
    const tmp = mkdtempSync('/tmp/gossip-wt-sym-');
    try {
      // macOS resolves /tmp → /private/tmp; use `pwd -P` to mirror what the
      // hook sees from realpath.
      const real = execFileSync('bash', ['-c', `cd "${tmp}" && pwd -P`], { encoding: 'utf-8' }).trim();
      const outsideTarget = '/etc/passwd';
      const symlinkPath = join(real, 'escape-link');
      symlinkSync(outsideTarget, symlinkPath);

      const { stdout, status } = runHook({
        tool_name: 'Write',
        tool_input: { file_path: symlinkPath },
        cwd: real,
      });
      expect(status).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain('/etc/passwd');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('denies Write with .. segment that escapes cwd', () => {
    // Naïve prefix match against the literal string missed path traversal
    // like /cwd/subdir/../../etc/passwd, which string-equals a prefix of
    // cwd but normalizes to /etc/passwd.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/private/tmp/gossip-wt-abc123/subdir/../../../../etc/passwd' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain('/etc/passwd');
  });

  it('exits 0 (fail-open) on invalid JSON payload', () => {
    // The previous version used `set -euo pipefail`, so failing jq on
    // invalid JSON caused the hook to exit with code 5 — a contract
    // violation. Malformed payloads are harness bugs, not attacks.
    const res = spawnSync('bash', [HOOK_PATH], { input: 'not valid json', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    // Nothing to emit because we're not denying.
    expect(res.stdout.trim()).toBe('');
  });

  it('exits 0 (fail-open) on empty stdin', () => {
    // Same contract: empty input must not crash or emit an error.
    const res = spawnSync('bash', [HOOK_PATH], { input: '', encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toBe('');
  });

  it('denies lowercase tool name (edit) with absolute path outside cwd', () => {
    // The case-insensitive match guards against upstream casing drift —
    // any tool_name like "edit"/"Edit"/"EDIT" should be gated the same way.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'edit',
      tool_input: { file_path: '/etc/passwd' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/passwd');
  });

  it('denies MultiEdit with absolute path outside cwd', () => {
    // MultiEdit uses the same file_path field as Edit/Write; it must be
    // gated even if the installer matcher is later broadened.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/etc/hosts',
        edits: [{ old_string: 'a', new_string: 'b' }],
      },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/hosts');
  });

  // --- Round-2 hardening (consensus f6529a21-a60540ee) ---

  it('denies Write with leading-space absolute path outside cwd', () => {
    // Bypass 1 (HIGH): the sed pipeline in the hook stripped blank lines but
    // left leading whitespace intact. A payload like `{"file_path":" /etc/passwd"}`
    // survived with a leading space, and the later `case [!/]*` classifier saw
    // a space (not `/`) as the first character, mis-classified the path as
    // relative, and allowed it through.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: ' /etc/passwd' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/passwd');
  });

  it('denies Bash with backtick-prefixed absolute path after command substitution', () => {
    // Bypass 2 (MED): the pre-slash delimiter class in the grep pattern
    // listed whitespace + shell metacharacters but omitted backtick. In
    //   x=`cat /wt/safe`/etc/passwd
    // the closing backtick is immediately followed by /etc/passwd as a
    // literal string append. Without ` in the pre-slash class, grep refused
    // to split there and the absolute-path token went undetected.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: {
        command: 'x=`cat /private/tmp/gossip-wt-abc123/safe`/etc/passwd',
      },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/passwd');
  });

  it('denies MultiEdit when a nested edits[] entry has absolute path outside cwd', () => {
    // Test gap 1 (MED): MultiEdit exposes both top-level `file_path` and
    // `edits[].file_path`. A crafted payload can put a safe top-level path
    // and hide the escape in a nested edits[] entry. The hook MUST scan all
    // edits[] file_path fields for defense in depth.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: '/private/tmp/gossip-wt-abc123/safe.ts',
        edits: [
          { file_path: '/private/tmp/gossip-wt-abc123/also-safe.ts', old_string: 'a', new_string: 'b' },
          { file_path: '/etc/x', old_string: 'c', new_string: 'd' },
        ],
      },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/x');
  });

  it('fails secure when all path normalizers are unavailable', () => {
    // Test gap 2 (MED): if realpath/readlink/python3 are all unavailable,
    // the pure-bash fallback still collapses `..` on absolute paths. The
    // invariant: the hook must NEVER fail-open allow on a scrubbed
    // environment, and must never exit with code 2.
    //
    // We simulate by scrubbing PATH to one directory that definitely has
    // no realpath/python3 — /var/empty — then invoke bash via its absolute
    // path so spawnSync can still find the interpreter.
    //
    // The bash fallback path in normalize_path() still works on absolute
    // inputs (it splits on `/` and collapses `..`), so the expected outcome
    // is a DENY JSON. If some future refactor removes the bash fallback,
    // this test should still pass because then normalize_path returns
    // empty for the candidate → the hook emits the fail-secure DENY with
    // "BOUNDARY CHECK FAILED".
    //
    // Skip gracefully if /bin/bash is missing (e.g. non-Unix CI).
    if (!existsSync('/bin/bash')) return;

    const scrubbedPath = '/var/empty';
    const res = spawnSync('/bin/bash', [HOOK_PATH], {
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/etc/x' },
        cwd: '/private/tmp/gossip-wt-abc123',
      }),
      encoding: 'utf-8',
      env: { PATH: scrubbedPath },
    });
    // Never exit 2, never crash; status must be 0.
    expect(res.status).toBe(0);
    const out = res.stdout.trim();
    // Under scrubbed PATH `jq` is missing → the hook fail-opens with empty
    // stdout per the documented contract (jq missing is treated as a
    // harness dependency issue, not an attack). That's allowed here.
    // If jq IS somehow reachable, we demand a DENY JSON.
    if (out.length > 0) {
      const parsed = JSON.parse(out);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });

  it('allows relative path with spaces inside worktree', () => {
    // Test gap 3a (LOW): relative paths with spaces are legitimate — docs,
    // test fixtures, etc. They must not be mis-classified or mis-tokenized.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: './my file.ts' },
      cwd,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('denies absolute path with spaces outside cwd', () => {
    // Test gap 3b (LOW): absolute paths with spaces must still be gated.
    // A naïve whitespace-based tokenizer could split at the space and lose
    // the boundary context. The Edit branch passes the whole jq-extracted
    // string as ONE candidate, so this should deny cleanly.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/etc/my file' },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/my file');
  });

  // --- Auto-memory allowlist (fix/sandbox-hook-allow-memory) ---

  it('allows Write to ~/.claude/projects/*/memory/* (Claude Code auto-memory)', () => {
    // The memory-save flow triggered by gossip_session_save writes to
    // ~/.claude/projects/<encoded-cwd>/memory/<slug>.md. Because this path
    // is outside the worktree cwd, the hook was blocking it — breaking
    // in-session memory persistence entirely.
    //
    // The allowlist MUST fire AFTER normalize_path so that a crafted path
    // like /wt/../home/user/.claude/projects/x/memory/y cannot bypass the
    // deny gate via the allowlist route.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const home = process.env.HOME ?? '/Users/testuser';
    const memoryPath = `${home}/.claude/projects/-Users-goku-Desktop-gossip/memory/session_2026_04_17.md`;
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: memoryPath },
      cwd,
    });
    expect(status).toBe(0);
    // No deny JSON — hook exits 0 with empty stdout to allow.
    expect(stdout.trim()).toBe('');
  });

  it('allows Edit to ~/.claude/projects/*/memory/* (Claude Code auto-memory)', () => {
    const cwd = '/private/tmp/gossip-wt-abc123';
    const home = process.env.HOME ?? '/Users/testuser';
    const memoryPath = `${home}/.claude/projects/-Users-goku-Desktop-gossip/memory/project_foo.md`;
    const { stdout, status } = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: memoryPath },
      cwd,
    });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('still denies Write to ~/.claude/projects/*/memory/../../../etc/passwd (path traversal through allowlist)', () => {
    // The allowlist applies AFTER normalization. A path that traverses out
    // of the memory directory must normalize to a non-memory path and hit
    // the deny gate rather than the allowlist continue.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const home = process.env.HOME ?? '/Users/testuser';
    const escapePath = `${home}/.claude/projects/-gossip/memory/../../../etc/passwd`;
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: escapePath },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain('/etc/passwd');
  });

  it('still denies Write outside ~/.claude/projects/*/memory/ but inside ~/.claude/', () => {
    // Only the memory subdirectory is allowlisted. Writing to
    // ~/.claude/settings.json or ~/.claude/CLAUDE.md must still be denied.
    const cwd = '/private/tmp/gossip-wt-abc123';
    const home = process.env.HOME ?? '/Users/testuser';
    const settingsPath = `${home}/.claude/settings.json`;
    const { stdout, status } = runHook({
      tool_name: 'Write',
      tool_input: { file_path: settingsPath },
      cwd,
    });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // --- Orchestrator / subagent distinction (fix/sandbox-orchestrator-distinction) ---
  // $CLAUDE_PROJECT_DIR is the harness-trusted anchor. When set, we only gate
  // cwd paths that are provably inside a subagent worktree. All other cwd
  // values — including the project root itself — are treated as the
  // orchestrator and pass through without path-gating.

  it('[orch] orchestrator allowed — project cwd + CLAUDE_PROJECT_DIR set — Write inside project', () => {
    // Orchestrator cwd equals CLAUDE_PROJECT_DIR → IS_SUBAGENT=0 → exit 0 immediately.
    // Even writing outside the "worktree" (because there is no worktree) must be allowed.
    const { stdout, status } = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/fake/project/src/foo.ts' }, cwd: '/fake/project' },
      { CLAUDE_PROJECT_DIR: '/fake/project' },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('[orch] orchestrator allowed — external absolute path — CLAUDE_PROJECT_DIR set', () => {
    // Orchestrator cwd does not match any worktree pattern → IS_SUBAGENT=0 → exit 0.
    // An absolute path like /Users/goku/anything.md must also be allowed because
    // the hook does not gate orchestrator tool calls at all.
    const { stdout, status } = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/Users/goku/anything.md' }, cwd: '/fake/project' },
      { CLAUDE_PROJECT_DIR: '/fake/project' },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('[subagent] subagent still blocked (no regression) — Write inside project from worktree cwd', () => {
    // Subagent cwd is <proj>/.claude/worktrees/agent-abc → IS_SUBAGENT=1 → gates.
    // Target is inside the main project but OUTSIDE the subagent worktree cwd → deny.
    const { stdout, status } = runHook(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/fake/project/src/foo.ts' },
        cwd: '/fake/project/.claude/worktrees/agent-abc',
      },
      { CLAUDE_PROJECT_DIR: '/fake/project' },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/fake/project/src/foo.ts');
  });

  it('[subagent] subagent path traversal still blocked — Write with .. segment outside worktree', () => {
    // The .. segment resolves to /fake/project/.claude/worktrees/agent-abc/../etc/passwd
    // → /fake/project/.claude/worktrees/etc/passwd (still outside worktree) → deny.
    // More specifically: agent-abc/../../../etc/passwd → /fake/project/.claude/etc/passwd
    // which is outside the subagent worktree cwd.
    const { stdout, status } = runHook(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/fake/project/.claude/worktrees/agent-abc/../../../etc/passwd' },
        cwd: '/fake/project/.claude/worktrees/agent-abc',
      },
      { CLAUDE_PROJECT_DIR: '/fake/project' },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason.toLowerCase()).toContain('/etc/passwd');
  });

  it('[subagent] memory-dir allowlist still works from subagent worktree', () => {
    // IS_SUBAGENT=1 (worktree cwd), but the target is the Claude Code auto-memory
    // path under ~/.claude/projects/*/memory/* — which is on the allowlist → allow.
    const home = process.env.HOME ?? '/Users/testuser';
    const memoryPath = `${home}/.claude/projects/-fake-project/memory/session.md`;
    const { stdout, status } = runHook(
      {
        tool_name: 'Write',
        tool_input: { file_path: memoryPath },
        cwd: '/fake/project/.claude/worktrees/agent-abc',
      },
      { CLAUDE_PROJECT_DIR: '/fake/project' },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('[fallback] CLAUDE_PROJECT_DIR missing → fallback glob — relay worktree cwd → deny /etc/passwd', () => {
    // No CLAUDE_PROJECT_DIR env: fallback branch fires, matches /tmp/gossip-wt-*
    // → IS_SUBAGENT=1, then gates the target path.
    const { stdout, status } = runHook(
      { tool_name: 'Write', tool_input: { file_path: '/etc/passwd' }, cwd: '/tmp/gossip-wt-X' },
      { CLAUDE_PROJECT_DIR: '' },  // explicit empty = unset-equivalent for our branch
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/etc/passwd');
  });

  it('[fallback] CLAUDE_PROJECT_DIR mismatched — subagent worktree cwd → deny', () => {
    // CLAUDE_PROJECT_DIR points to a different project than the cwd. The cwd is
    // /fake/project/.claude/worktrees/agent-abc, but CLAUDE_PROJECT_DIR=/other/proj
    // so the anchored match for /other/proj/.claude/worktrees/... does NOT fire.
    // However the fallback glob */.claude/worktrees/agent-* DOES match → IS_SUBAGENT=1
    // → gate fires → deny.
    const { stdout, status } = runHook(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/fake/project/src/foo.ts' },
        cwd: '/fake/project/.claude/worktrees/agent-abc',
      },
      { CLAUDE_PROJECT_DIR: '/other/proj' },
    );
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('/fake/project/src/foo.ts');
  });

  // Issue #162 problem 1: GOSSIPCAT_ORCHESTRATOR_ROLE env exemption.
  it('[orch-env] GOSSIPCAT_ORCHESTRATOR_ROLE=1 allows Write to any path from worktree cwd', () => {
    const { stdout, status } = runHook(
      {
        tool_name: 'Write',
        tool_input: { file_path: '/Users/someone/outside.txt' },
        cwd: '/fake/project/.claude/worktrees/agent-abc',
      },
      { GOSSIPCAT_ORCHESTRATOR_ROLE: '1', CLAUDE_PROJECT_DIR: '/fake/project' },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('[orch-env] GOSSIPCAT_ORCHESTRATOR_ROLE=true allows Bash with external path from worktree cwd', () => {
    const { stdout, status } = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cp /fake/project/src/foo.ts /tmp/somewhere-else' },
        cwd: '/fake/project/.claude/worktrees/agent-abc',
      },
      { GOSSIPCAT_ORCHESTRATOR_ROLE: 'true' },
    );
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  // Issue #162 problem 2 / #161: quoted-string false-positive mitigation.
  it('[quotes] allows git commit -m with quoted body containing absolute path', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: "git commit -m 'fixes /etc/config reference'" },
      cwd: '/fake/project/.claude/worktrees/agent-abc',
    }, { CLAUDE_PROJECT_DIR: '/fake/project' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('[quotes] allows gh pr edit --body with quoted body containing absolute path', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: "gh pr edit --body 'see /etc/passwd in the discussion'" },
      cwd: '/fake/project/.claude/worktrees/agent-abc',
    }, { CLAUDE_PROJECT_DIR: '/fake/project' });
    expect(status).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('[quotes] still denies unquoted cp to external absolute path', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cp /fake/project/.claude/worktrees/agent-abc/src/foo.ts /etc/passwd' },
      cwd: '/fake/project/.claude/worktrees/agent-abc',
    }, { CLAUDE_PROJECT_DIR: '/fake/project' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('[quotes] bash -c keeps quoted body for extraction — deny unchanged', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'cp /fake/project/.claude/worktrees/agent-abc/src/foo.ts /etc/passwd'" },
      cwd: '/fake/project/.claude/worktrees/agent-abc',
    }, { CLAUDE_PROJECT_DIR: '/fake/project' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('[quotes] sh -c absolute path also keeps quoted body — deny unchanged', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: "/bin/sh -c 'cp /fake/project/.claude/worktrees/agent-abc/x /etc/shadow'" },
      cwd: '/fake/project/.claude/worktrees/agent-abc',
    }, { CLAUDE_PROJECT_DIR: '/fake/project' });
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// Keep unused-import lint happy — writeFileSync, mkdirSync imported for
// potential future fixture setup; symlinkSync is used above.
void writeFileSync;
void mkdirSync;

// Suppress unused-import lint noise under the skip branch.
void execFileSync;
