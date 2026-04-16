/**
 * Layer 2 of the sandbox boundary stack (issue #90): install the PreToolUse
 * hook that denies absolute-path writes from worktree-isolated agents.
 *
 * Idempotent — safe to re-run on every `gossip_setup` call (merge/replace).
 * Never throws; returns `{installed: false, reason}` on any failure so setup
 * stays unblocked.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { join, resolve, dirname } from 'path';

export interface HookInstallResult {
  installed: boolean;
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

/** Load `.claude/settings.json`, returning `{}` if missing or malformed. */
function loadSettings(settingsPath: string): Record<string, any> {
  if (!existsSync(settingsPath)) return {};
  try {
    const raw = readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
    const settings = loadSettings(settingsPath);
    const mutated = mergePreToolUseEntry(settings);
    if (mutated) {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    }

    return { installed: true };
  } catch (err) {
    return { installed: false, reason: (err as Error).message };
  }
}
