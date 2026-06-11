/**
 * Layer 2 of the sandbox boundary stack (issue #90): install the PreToolUse
 * hook that denies absolute-path writes from worktree-isolated agents.
 *
 * Idempotent — safe to re-run on every `gossip_setup` call (merge/replace).
 * Never throws; returns `{installed: false, reason}` on any failure so setup
 * stays unblocked.
 *
 * Also exports `installDisciplineHooks` for the orchestrator-discipline v1
 * hook bundle (SessionStart bootstrap, PreToolUse signals validator,
 * PostToolUse collect reminder). These write into `.claude/settings.local.json`
 * (personal discipline hooks, not project-shared security controls).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, renameSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';

export interface HookInstallResult {
  installed: boolean;
  /**
   * Distinguishes fresh registration from an idempotent no-op.
   * Only present when `installed: true`.
   *   - `"registered"` — hook entry was written to settings.json for the first time.
   *   - `"already-registered"` — the exact command was already present; no write needed.
   */
  action?: 'registered' | 'already-registered';
  reason?: string;
}

const HOOK_FILENAME = 'worktree-sandbox.sh';
const HOOK_COMMAND = '$CLAUDE_PROJECT_DIR/.claude/hooks/worktree-sandbox.sh';
const HOOKED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
const HOOK_MATCHER = HOOKED_TOOLS.join('|');

/**
 * Resolve the bundled hook asset. We try multiple candidate paths because
 * esbuild bundles this module into dist-mcp/mcp-server.js, changing
 * `__dirname` relative to the source layout.
 *
 * Candidates (in order):
 *   1. <__dirname>/assets/hooks/worktree-sandbox.sh
 *      — published: build:mcp copies ./assets → dist-mcp/assets
 *   2. <__dirname>/../../../assets/hooks/worktree-sandbox.sh
 *      — dev (ts-node): __dirname = packages/orchestrator/src/
 *   3. <__dirname>/../assets/hooks/worktree-sandbox.sh
 *      — fallback for compiled-but-not-bundled layouts
 *   4. <cwd>/assets/hooks/worktree-sandbox.sh
 *      — last-resort dev fallback from monorepo root
 */
export function findBundledHook(): string | null {
  const candidates = [
    resolve(__dirname, 'assets', 'hooks', HOOK_FILENAME),
    resolve(__dirname, '..', '..', '..', 'assets', 'hooks', HOOK_FILENAME),
    resolve(__dirname, '..', 'assets', 'hooks', HOOK_FILENAME),
    resolve(process.cwd(), 'assets', 'hooks', HOOK_FILENAME),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Load `.claude/settings.json`.
 *
 * - File doesn't exist → return `{}`
 * - File exists, valid JSON object → return parsed object
 * - File exists but malformed JSON or not a plain object → THROW with a
 *   descriptive message so the caller can skip the write rather than
 *   silently replacing the user's file with `{}`.
 */
function loadSettings(settingsPath: string): Record<string, any> {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `settings.json at ${settingsPath} contains malformed JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `settings.json at ${settingsPath} is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    );
  }
  return parsed as Record<string, any>;
}

/** Merge the PreToolUse entry idempotently — skip if the exact command is already registered. */
function mergePreToolUseEntry(settings: Record<string, any>): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const hooks = settings.hooks as Record<string, any>;
  if (!Array.isArray(hooks.PreToolUse)) hooks.PreToolUse = [];
  const preToolUse = hooks.PreToolUse as any[];

  // Idempotency: if ANY PreToolUse entry already contains a hook with this exact
  // command, bail without mutating.
  const alreadyInstalled = preToolUse.some(entry => {
    const innerHooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return innerHooks.some(
      (h: any) => h && typeof h === 'object' && h.command === HOOK_COMMAND,
    );
  });
  if (alreadyInstalled) return false;

  preToolUse.push({
    matcher: HOOK_MATCHER,
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });
  return true;
}

/** Path to the orchestrator-role marker file relative to projectRoot. */
const ORCHESTRATOR_ROLE_MARKER = '.gossip/orchestrator-role';

/**
 * Write `.gossip/orchestrator-role` at `projectRoot` so the worktree-sandbox
 * hook can identify the orchestrator session without relying on a manually set
 * env variable (issue #176).
 *
 * Idempotent — no-ops if the file already exists. Returns the file path.
 * Never throws; the caller should handle errors gracefully.
 */
export function writeOrchestratorRoleMarker(projectRoot: string): string {
  const markerPath = join(projectRoot, ORCHESTRATOR_ROLE_MARKER);
  const markerDir = dirname(markerPath);
  mkdirSync(markerDir, { recursive: true });
  if (!existsSync(markerPath)) {
    writeFileSync(
      markerPath,
      '# Written by gossip_setup (issue #176).\n' +
      '# Presence of this file tells the worktree-sandbox hook that the\n' +
      '# project root is the orchestrator context, not a subagent worktree.\n' +
      '# Do not copy this file into worktree dirs.\n',
      'utf-8',
    );
  }
  return markerPath;
}

/**
 * Install the worktree sandbox hook at `<projectRoot>/.claude/hooks/` and
 * register it in `<projectRoot>/.claude/settings.json`.
 */
export function installWorktreeSandboxHook(projectRoot: string): HookInstallResult {
  try {
    const bundled = findBundledHook();
    if (!bundled) return { installed: false, reason: 'bundled hook asset not found' };

    // 1. Copy the hook script into the project and mark it executable.
    const targetDir = join(projectRoot, '.claude', 'hooks');
    const target = join(targetDir, HOOK_FILENAME);
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(bundled, target);
    chmodSync(target, 0o755);

    // 2. Merge the PreToolUse registration into settings.json.
    const settingsPath = join(projectRoot, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });

    let settings: Record<string, any>;
    try {
      settings = loadSettings(settingsPath);
    } catch (err) {
      process.stderr.write(
        `[gossipcat] settings.json at ${settingsPath} is malformed; skipping hook install. ` +
        `Fix the file or delete it and re-run gossip_setup.\n`,
      );
      return { installed: false, reason: (err as Error).message };
    }

    const mutated = mergePreToolUseEntry(settings);
    if (mutated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }

    return { installed: true, action: mutated ? 'registered' : 'already-registered' };
  } catch (err) {
    return { installed: false, reason: (err as Error).message };
  }
}

/**
 * Check whether the worktree-sandbox PreToolUse hook entry is registered in
 * `<projectRoot>/.claude/settings.json`. Used by gossip_status to emit a
 * visible warning when the hook script exists on disk but the settings entry
 * is missing (i.e. the hook was installed but the registration was lost, e.g.
 * via settings.json reset or manual edit).
 *
 * Returns `true` when the exact HOOK_COMMAND is registered, `false` otherwise.
 * Returns `false` (silently) on any IO or parse error — the status handler
 * must fail-open.
 */
export function isWorktreeSandboxHookRegistered(projectRoot: string): boolean {
  try {
    const settingsPath = join(projectRoot, '.claude', 'settings.json');
    let settings: Record<string, any>;
    try {
      settings = loadSettings(settingsPath);
    } catch {
      return false; // malformed → treat as not registered
    }
    const hooks = settings.hooks;
    if (!hooks || !Array.isArray(hooks.PreToolUse)) return false;
    for (const entry of hooks.PreToolUse) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      if (entry.hooks.some((h: any) => h && h.command === HOOK_COMMAND)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ── Discipline hooks (settings.local.json) ───────────────────────────────────

export interface DisciplineHookInstallResult {
  installed: string[];
  skipped: string[];
  reason?: string;
}

const DISCIPLINE_HOOK_DIR = 'discipline';

const DISCIPLINE_HOOKS = [
  {
    name: 'session-start-bootstrap',
    event: 'SessionStart' as const,
    matcher: '*',
    command: '$CLAUDE_PROJECT_DIR/.claude/hooks/discipline/session-start-bootstrap.sh',
    filename: 'session-start-bootstrap.sh',
  },
  {
    name: 'pretool-signals-validate',
    event: 'PreToolUse' as const,
    matcher: 'mcp__gossipcat__gossip_signals',
    command: '$CLAUDE_PROJECT_DIR/.claude/hooks/discipline/pretool-signals-validate.sh',
    filename: 'pretool-signals-validate.sh',
  },
  {
    name: 'posttool-collect-reminder',
    event: 'PostToolUse' as const,
    matcher: 'mcp__gossipcat__gossip_collect',
    command: '$CLAUDE_PROJECT_DIR/.claude/hooks/discipline/posttool-collect-reminder.sh',
    filename: 'posttool-collect-reminder.sh',
  },
] as const;

/**
 * Resolve a bundled discipline hook asset. Mirrors `findBundledHook` candidate
 * strategy so it works from both the esbuild bundle (dist-mcp/) and dev (ts-node).
 */
function findDisciplineHook(filename: string): string | null {
  const candidates = [
    resolve(__dirname, 'assets', 'hooks', DISCIPLINE_HOOK_DIR, filename),
    resolve(__dirname, '..', '..', '..', 'assets', 'hooks', DISCIPLINE_HOOK_DIR, filename),
    resolve(__dirname, '..', 'assets', 'hooks', DISCIPLINE_HOOK_DIR, filename),
    resolve(process.cwd(), 'assets', 'hooks', DISCIPLINE_HOOK_DIR, filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Load `.claude/settings.local.json`.
 *
 * - File doesn't exist → return `{}`
 * - File exists, valid JSON object → return parsed object
 * - File exists but malformed JSON or not a plain object → THROW so caller
 *   can skip the write rather than silently replacing user content.
 */
function loadLocalSettings(settingsPath: string): Record<string, any> {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `settings.local.json at ${settingsPath} contains malformed JSON: ${(err as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `settings.local.json at ${settingsPath} is not a JSON object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`,
    );
  }
  return parsed as Record<string, any>;
}

/**
 * Idempotently merge a hook entry for `hookEvent` with the given `matcher` and
 * `command` into `settings`. Returns `true` if the settings object was mutated,
 * `false` if the exact command was already registered (no-op).
 */
function mergeHookEntry(
  settings: Record<string, any>,
  hookEvent: string,
  matcher: string,
  command: string,
): boolean {
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  const hooks = settings.hooks as Record<string, any>;
  if (!Array.isArray(hooks[hookEvent])) hooks[hookEvent] = [];
  const eventHooks = hooks[hookEvent] as any[];

  // Idempotency: bail if any entry already contains this exact command.
  const alreadyInstalled = eventHooks.some(entry => {
    const innerHooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    return innerHooks.some(
      (h: any) => h && typeof h === 'object' && h.command === command,
    );
  });
  if (alreadyInstalled) return false;

  eventHooks.push({
    matcher,
    hooks: [{ type: 'command', command }],
  });
  return true;
}

// ── Bootstrap UserPromptSubmit hook (mtime-keyed sentinel) ──────────────────

/**
 * Result of `installBootstrapHook`.
 *
 *   action:
 *     - "installed"  — wrote a fresh entry (no existing UserPromptSubmit hook)
 *     - "upgraded"   — replaced an old `cat .gossip/bootstrap.md` command
 *     - "already-current" — `gossipcat hook --run` already registered
 *     - "skipped-user-custom" — user has a custom command we won't touch
 *     - "skipped-malformed" — settings.local.json is unparseable
 *     - "error"      — unexpected fs error
 */
export interface BootstrapHookInstallResult {
  action:
    | 'installed'
    | 'upgraded'
    | 'already-current'
    | 'skipped-user-custom'
    | 'skipped-malformed'
    | 'error';
  reason?: string;
}

/** Command we want every UserPromptSubmit hook to run, post-spec. */
export const BOOTSTRAP_HOOK_COMMAND = 'gossipcat hook --run';

/** Regex matching legacy `cat .gossip/bootstrap.md ...` hook commands. */
const LEGACY_BOOTSTRAP_CMD_RE = /cat\s+\.gossip\/bootstrap\.md/;

/**
 * Install or upgrade the UserPromptSubmit bootstrap hook in
 * `<projectRoot>/.claude/settings.local.json`.
 *
 * Rules:
 *   - No UserPromptSubmit entry yet → append one with `gossipcat hook --run`.
 *   - Existing entry matching the legacy `cat .gossip/bootstrap.md` form →
 *     rewrite the command in place.
 *   - Existing entry whose command is already `gossipcat hook --run` → no-op.
 *   - Existing entry with a user-custom command → leave alone, log a one-line
 *     stderr warning so the user knows the upgrade was deferred.
 *
 * Atomic: writes to a `.tmp.<pid>` sibling then renameSyncs. Preserves all
 * other settings keys (permissions, other hooks).
 */
export function installBootstrapHook(projectRoot: string): BootstrapHookInstallResult {
  try {
    const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
    mkdirSync(dirname(settingsPath), { recursive: true });

    let settings: Record<string, any>;
    try {
      settings = loadLocalSettings(settingsPath);
    } catch (err) {
      process.stderr.write(
        `[gossipcat] settings.local.json at ${settingsPath} is malformed; skipping bootstrap hook install. ` +
        `Fix the file or delete it and re-run gossip_setup.\n`,
      );
      return { action: 'skipped-malformed', reason: (err as Error).message };
    }

    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
    const hooks = settings.hooks as Record<string, any>;
    if (!Array.isArray(hooks.UserPromptSubmit)) hooks.UserPromptSubmit = [];
    const ups = hooks.UserPromptSubmit as any[];

    // Walk every UserPromptSubmit entry's inner hooks. Track first match
    // we can act on.
    let upgraded = false;
    let alreadyCurrent = false;
    let userCustomFound = false;

    // Walk every entry's inner hooks in reverse so we can splice duplicates
    // without skipping indices. When we find a second `gossipcat hook --run`
    // entry (or a legacy entry alongside a current one), DROP it instead of
    // rewriting — otherwise the file would contain two identical commands and
    // the hook would fire twice per prompt (HIGH n1 from consensus
    // d88f27db-c0454640).
    for (const entry of ups) {
      if (!entry || !Array.isArray(entry.hooks)) continue;
      for (let i = entry.hooks.length - 1; i >= 0; i--) {
        const h = entry.hooks[i];
        if (!h || typeof h !== 'object' || typeof h.command !== 'string') continue;
        if (h.command === BOOTSTRAP_HOOK_COMMAND) {
          if (alreadyCurrent) {
            entry.hooks.splice(i, 1);
            upgraded = true;
          } else {
            alreadyCurrent = true;
          }
        } else if (LEGACY_BOOTSTRAP_CMD_RE.test(h.command)) {
          if (alreadyCurrent) {
            entry.hooks.splice(i, 1);
          } else {
            h.command = BOOTSTRAP_HOOK_COMMAND;
            alreadyCurrent = true;
          }
          upgraded = true;
        } else {
          userCustomFound = true;
        }
      }
    }

    // Prune entries whose hooks[] became empty after splicing — don't leave
    // dangling matcher stubs behind.
    for (let i = ups.length - 1; i >= 0; i--) {
      const entry = ups[i];
      if (entry && Array.isArray(entry.hooks) && entry.hooks.length === 0) {
        ups.splice(i, 1);
      }
    }

    if (alreadyCurrent && !upgraded) {
      if (userCustomFound) {
        // Fix MEDIUM f3: emit the warning even when alreadyCurrent is also
        // true — previously the early return silenced it.
        process.stderr.write(
          `[gossipcat] UserPromptSubmit hook in ${settingsPath} also has a custom command alongside the gossipcat hook; leaving as-is.\n`,
        );
      }
      return { action: 'already-current' };
    }

    if (!alreadyCurrent && !upgraded) {
      if (userCustomFound) {
        process.stderr.write(
          `[gossipcat] UserPromptSubmit hook in ${settingsPath} has a custom command; leaving as-is. ` +
          `To enable bootstrap suppression, set command to "${BOOTSTRAP_HOOK_COMMAND}".\n`,
        );
        return { action: 'skipped-user-custom' };
      }
      // No matching hook at all — install fresh.
      ups.push({
        matcher: '',
        hooks: [{ type: 'command', command: BOOTSTRAP_HOOK_COMMAND }],
      });
    }

    // Atomic write via tmp + rename. Fix MEDIUM f1: if rename throws (e.g.
    // EXDEV across filesystems, EACCES), unlink the leftover .tmp.<pid> so
    // we don't litter the .claude/ dir on repeated failures.
    const tmp = settingsPath + '.tmp.' + process.pid;
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    try {
      renameSync(tmp, settingsPath);
    } catch (renameErr) {
      try { unlinkSync(tmp); } catch { /* best-effort */ }
      throw renameErr;
    }

    return { action: upgraded ? 'upgraded' : 'installed' };
  } catch (err) {
    return { action: 'error', reason: (err as Error).message };
  }
}

/**
 * Install the v1 orchestrator-discipline hook bundle into
 * `<projectRoot>/.claude/settings.local.json` (personal hooks, gitignored).
 *
 * Three hooks are registered:
 *   1. SessionStart → bootstrap reminder
 *   2. PreToolUse on gossip_signals → finding_id validator
 *   3. PostToolUse on gossip_collect → signal-recording reminder
 *
 * Idempotent — safe to call on every `gossip_setup`. Malformed settings.local.json
 * is treated as fatal (returns early with reason, never overwrites user content).
 */
export function installDisciplineHooks(projectRoot: string): DisciplineHookInstallResult {
  const installed: string[] = [];
  const skipped: string[] = [];

  try {
    // 1. Copy hook scripts into .claude/hooks/discipline/ and mark executable.
    const targetDir = join(projectRoot, '.claude', 'hooks', DISCIPLINE_HOOK_DIR);
    mkdirSync(targetDir, { recursive: true });

    for (const hook of DISCIPLINE_HOOKS) {
      const bundled = findDisciplineHook(hook.filename);
      if (!bundled) {
        skipped.push(hook.name);
        continue;
      }
      const target = join(targetDir, hook.filename);
      copyFileSync(bundled, target);
      chmodSync(target, 0o755);
    }

    // 2. Load settings.local.json — throw on malformed JSON so we never
    //    silently clobber user content.
    const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
    mkdirSync(dirname(settingsPath), { recursive: true });

    let settings: Record<string, any>;
    try {
      settings = loadLocalSettings(settingsPath);
    } catch (err) {
      process.stderr.write(
        `[gossipcat] settings.local.json at ${settingsPath} is malformed; skipping discipline hook install. ` +
        `Fix the file or delete it and re-run gossip_setup.\n`,
      );
      return { installed, skipped, reason: (err as Error).message };
    }

    // 3. Merge all three hook entries idempotently.
    let anyMutated = false;
    for (const hook of DISCIPLINE_HOOKS) {
      const bundled = findDisciplineHook(hook.filename);
      if (!bundled) continue; // already skipped above

      const mutated = mergeHookEntry(settings, hook.event, hook.matcher, hook.command);
      if (mutated) {
        installed.push(hook.name);
        anyMutated = true;
      } else {
        skipped.push(hook.name);
      }
    }

    // 4. Atomic write via tmp + rename to avoid partial writes. Fix MEDIUM f1:
    // unlink leftover .tmp.<pid> on rename failure.
    if (anyMutated) {
      const tmp = settingsPath + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
      try {
        renameSync(tmp, settingsPath);
      } catch (renameErr) {
        try { unlinkSync(tmp); } catch { /* best-effort */ }
        throw renameErr;
      }
    }

    return { installed, skipped };
  } catch (err) {
    return { installed, skipped, reason: (err as Error).message };
  }
}
