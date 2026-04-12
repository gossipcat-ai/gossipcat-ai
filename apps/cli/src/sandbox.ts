/**
 * Sandbox enforcement — prompt sanitization + post-task boundary audit.
 *
 * Claude Code's Agent isolation:"worktree" and gossipcat's write_mode:"scoped"
 * are ADVISORY only at the harness layer: Edit/Write tools accept absolute
 * paths and silently bypass containment. Until that ships, gossipcat adds its
 * own soft enforcement via two mitigations:
 *
 *   1. relativizeProjectPaths — rewrite absolute project paths in the task
 *      prompt to relative paths, so agents don't learn the absolute prefix.
 *   2. auditDispatchBoundary — after a task relays its result, run
 *      `git status --porcelain` and flag any modified files outside the
 *      declared scope/worktree boundary.
 *
 * Both are best-effort. A determined agent can still invoke shell tools or
 * reconstruct paths. The durable fix is a Claude Code harness change.
 */
import { execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { isAbsolute, join, normalize, relative, sep } from 'path';

export type SandboxMode = 'off' | 'warn' | 'block';

export type DispatchWriteMode = 'sequential' | 'scoped' | 'worktree' | undefined;

export interface DispatchMetadata {
  taskId: string;
  agentId: string;
  writeMode?: DispatchWriteMode;
  scope?: string;
  worktreePath?: string;
  timestamp: number;
  /** Pre-task git status snapshot. Used to distinguish agent-created files
   * from pre-existing untracked files during boundary audit. */
  preTaskFiles?: string[];
}

const METADATA_FILE = 'dispatch-metadata.jsonl';
const BOUNDARY_ESCAPE_FILE = 'boundary-escapes.jsonl';

// Paths that agents legitimately write outside their declared boundary.
// These are infrastructure artifacts, not application code — false-positive
// disagreements from these paths penalize agents unfairly.
// Prefix-matched against relative paths from projectRoot.
const BOUNDARY_ALLOWLIST = [
  '.claude/worktrees/',       // worktree agents: git worktree config lives in main repo
  '.claude/settings.local.json', // scoped/worktree agents: permission adjustments
];

function isBoundaryAllowed(filePath: string): boolean {
  const f = filePath.replace(/^\.\//, '');
  return BOUNDARY_ALLOWLIST.some(prefix => f === prefix || f.startsWith(prefix));
}

// System directories that should NEVER be rewritten, even if nested under
// something that looks like a project path. The check is prefix-based on the
// canonical absolute path.
const SYSTEM_PREFIXES = [
  '/usr',
  '/bin',
  '/sbin',
  '/tmp',
  '/var',
  '/etc',
  '/opt',
  '/home',
  '/Users', // filtered further: only system users outside projectRoot
  '/private/tmp',
  '/private/var',
  '/private/etc',
];

function isSystemPath(absPath: string): boolean {
  return SYSTEM_PREFIXES.some(prefix => absPath === prefix || absPath.startsWith(prefix + '/'));
}

/**
 * Rewrite absolute project paths in `task` to relative paths.
 *
 * - `${projectRoot}/x/y` → `./x/y`
 * - bare `${projectRoot}` → `.`
 * - system paths (`/usr`, `/tmp`, …) preserved
 * - paths that look like project paths but live in `/Users/...` outside
 *   projectRoot are preserved
 *
 * Pure function. Returns the rewritten string and the count of replacements.
 */
export function relativizeProjectPaths(
  task: string,
  projectRoot: string,
): { sanitized: string; replacements: number } {
  if (!task || !projectRoot) return { sanitized: task, replacements: 0 };

  // Normalize projectRoot: strip trailing slash, resolve symlinks not required —
  // we match against the literal prefix as passed in.
  const root = projectRoot.replace(/\/+$/, '');
  if (!root || root === '/') return { sanitized: task, replacements: 0 };

  // Build a regex that matches the project root as a literal prefix, then
  // either end-of-token or a path separator.
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match: projectRoot, optionally followed by /subpath (non-greedy to nearest
  // whitespace, quote, backtick, or end)
  const pattern = new RegExp(`${escaped}(/[^\\s'"\`)>\\]]*)?`, 'g');

  let replacements = 0;
  const sanitized = task.replace(pattern, (match, subpath) => {
    // If this match is actually a system path (e.g. projectRoot happens to
    // equal "/" or something weird), skip. Normally impossible since root !== '/'.
    if (isSystemPath(match) && !match.startsWith(root + '/') && match !== root) {
      return match;
    }
    replacements++;
    if (!subpath) return '.';
    // Preserve leading slash as "./"
    return '.' + subpath;
  });

  return { sanitized, replacements };
}

/** Should sandbox mitigations apply to a dispatch with the given write_mode + agent preset? */
export function shouldSanitize(
  writeMode: DispatchWriteMode,
  agentPreset: string | undefined,
): boolean {
  if (writeMode === 'scoped' || writeMode === 'worktree') return true;
  if (!writeMode && agentPreset && agentPreset.toLowerCase().includes('implementer')) return true;
  return false;
}

const SCOPE_NOTE =
  'SCOPE NOTE: This task has been sanitized. All project paths are relative to the workspace root. Use relative paths (./x) — do NOT reconstruct absolute paths.\n\n';

/** Prepend the SCOPE NOTE to a prompt. Idempotent — won't double-prepend. */
export function prependScopeNote(prompt: string): string {
  if (prompt.startsWith('SCOPE NOTE:')) return prompt;
  return SCOPE_NOTE + prompt;
}

/** Read sandboxEnforcement from .gossip/config.json. Defaults to "warn". */
export function readSandboxMode(projectRoot: string): SandboxMode {
  try {
    const p = join(projectRoot, '.gossip', 'config.json');
    if (!existsSync(p)) return 'warn';
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const mode = raw?.sandboxEnforcement;
    if (mode === 'off' || mode === 'warn' || mode === 'block') return mode;
    return 'warn';
  } catch {
    return 'warn';
  }
}

/** Append a dispatch metadata record to .gossip/dispatch-metadata.jsonl.
 * Captures a pre-task git status snapshot when writeMode is scoped/worktree
 * so the boundary audit can subtract pre-existing untracked files from the
 * violation set. */
export function recordDispatchMetadata(projectRoot: string, meta: DispatchMetadata): void {
  try {
    const dir = join(projectRoot, '.gossip');
    mkdirSync(dir, { recursive: true });
    const snapshotted = { ...meta };
    if (meta.writeMode === 'scoped' || meta.writeMode === 'worktree') {
      try {
        const porcelain = execSync('git status --porcelain', {
          cwd: projectRoot,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        snapshotted.preTaskFiles = parseGitStatus(porcelain);
      } catch { /* git unavailable — audit will treat all files as new */ }
    }
    appendFileSync(join(dir, METADATA_FILE), JSON.stringify(snapshotted) + '\n');
  } catch {
    /* best-effort */
  }
}

/** Look up dispatch metadata by task ID. Returns most recent match, or null. */
export function lookupDispatchMetadata(
  projectRoot: string,
  taskId: string,
): DispatchMetadata | null {
  try {
    const p = join(projectRoot, '.gossip', METADATA_FILE);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]) as DispatchMetadata;
        if (entry.taskId === taskId) return entry;
      } catch {
        /* skip corrupt line */
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse `git status --porcelain` output into a list of modified file paths (relative to repo root). */
export function parseGitStatus(porcelain: string): string[] {
  const files: string[] = [];
  for (const rawLine of porcelain.split('\n')) {
    if (!rawLine) continue;
    // Porcelain format: XY <path> (or XY <old> -> <new> for renames)
    // First two chars are status codes, then a space, then the path.
    if (rawLine.length < 4) continue;
    let rest = rawLine.slice(3);
    // Rename: take the destination path
    const arrow = rest.indexOf(' -> ');
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    // Strip surrounding quotes (git quotes paths with special chars)
    if (rest.startsWith('"') && rest.endsWith('"')) {
      rest = rest.slice(1, -1);
    }
    if (rest) files.push(rest);
  }
  return files;
}

/** Normalize a scope path to a canonical relative prefix (no leading ./, no trailing /). */
function normalizeScope(scope: string, projectRoot: string): string {
  let s = scope.trim();
  if (!s) return '';
  if (isAbsolute(s)) {
    s = relative(projectRoot, s);
  } else if (s.startsWith('./')) {
    s = s.slice(2);
  }
  s = normalize(s).replace(/\/+$/, '');
  if (s === '.' || s === '') return '';
  return s;
}

/**
 * Check whether `filePath` (relative to projectRoot) falls inside `scope`.
 * Empty scope matches everything.
 */
export function isInsideScope(filePath: string, scope: string): boolean {
  if (!scope) return true;
  const f = normalize(filePath).replace(/^\.\//, '');
  const s = scope.replace(/^\.\//, '').replace(/\/+$/, '');
  if (f === s) return true;
  return f.startsWith(s + '/') || f.startsWith(s + sep);
}

export interface AuditViolation {
  taskId: string;
  agentId: string;
  mode: DispatchWriteMode;
  scope?: string;
  violatingPaths: string[];
}

export interface AuditResult {
  violations: string[];
  skipped?: string; // reason for skip
}

/**
 * Detect boundary escapes given dispatch metadata and git porcelain output.
 * Pure function — no I/O. Used by auditDispatchBoundary and unit tests.
 */
export function detectBoundaryEscapes(
  meta: DispatchMetadata,
  modifiedFiles: string[],
  projectRoot: string,
): string[] {
  const mode = meta.writeMode;
  if (!mode || mode === 'sequential') return [];

  if (mode === 'scoped') {
    const scope = normalizeScope(meta.scope || '', projectRoot);
    if (!scope) return []; // no scope declared → cannot evaluate
    return modifiedFiles.filter(f => !isInsideScope(f, scope) && !isBoundaryAllowed(f));
  }

  if (mode === 'worktree') {
    // Main repo should have NO modifications — all writes should have gone to
    // the isolated worktree. Every modified file in the main repo is a violation,
    // EXCEPT infrastructure paths that legitimately live in the main repo.
    return modifiedFiles.filter(f => !isBoundaryAllowed(f));
  }

  return [];
}

/**
 * Post-task audit. Runs git status in projectRoot and flags files outside the
 * declared boundary. Records signals, appends to boundary-escapes.jsonl, and
 * returns the violation list for the caller to decide block vs warn.
 *
 * Graceful: if git fails or metadata is missing, returns skipped + no violations.
 */
export function auditDispatchBoundary(
  projectRoot: string,
  taskId: string,
): AuditResult {
  const mode = readSandboxMode(projectRoot);
  if (mode === 'off') return { violations: [], skipped: 'sandboxEnforcement=off' };

  const meta = lookupDispatchMetadata(projectRoot, taskId);
  if (!meta) return { violations: [], skipped: 'no dispatch metadata' };

  if (!meta.writeMode || meta.writeMode === 'sequential') {
    return { violations: [], skipped: 'not a sandboxed write mode' };
  }

  let porcelain: string;
  try {
    porcelain = execSync('git status --porcelain', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { violations: [], skipped: 'git status failed (not a repo or git unavailable)' };
  }

  const postTaskFiles = parseGitStatus(porcelain);
  // Subtract pre-task snapshot so pre-existing untracked files don't count
  // as agent violations. Falls back to post-task set if no snapshot (missing
  // metadata or old records written before this field existed).
  const preTaskSet = new Set(meta.preTaskFiles ?? []);
  const modifiedFiles = postTaskFiles.filter(f => !preTaskSet.has(f));
  const violations = detectBoundaryEscapes(meta, modifiedFiles, projectRoot);

  if (violations.length > 0) {
    recordBoundaryEscape(projectRoot, meta, violations, mode);
  }

  return { violations };
}

function recordBoundaryEscape(
  projectRoot: string,
  meta: DispatchMetadata,
  violations: string[],
  mode: SandboxMode,
): void {
  // 1. stderr warning
  process.stderr.write(
    `[gossipcat] ⚠ BOUNDARY ESCAPE: ${meta.agentId} task ${meta.taskId} wrote outside ${meta.writeMode}:\n` +
      violations.map(v => `    ${v}`).join('\n') +
      '\n',
  );

  // 2. Append boundary-escape signal via PerformanceWriter
  try {
    const { PerformanceWriter } = require('@gossip/orchestrator');
    const writer = new PerformanceWriter(projectRoot);
    writer.appendSignals([
      {
        type: 'consensus' as const,
        taskId: meta.taskId,
        signal: 'disagreement' as const,
        agentId: meta.agentId,
        category: 'trust_boundaries',
        evidence:
          `Boundary escape: ${meta.writeMode} task wrote outside declared boundary. ` +
          `Violating paths: ${violations.slice(0, 10).join(', ')}`,
        timestamp: new Date().toISOString(),
      },
    ]);
  } catch {
    /* best-effort */
  }

  // 3. Append to boundary-escapes.jsonl
  try {
    const dir = join(projectRoot, '.gossip');
    mkdirSync(dir, { recursive: true });
    const line = {
      timestamp: new Date().toISOString(),
      taskId: meta.taskId,
      agentId: meta.agentId,
      mode: meta.writeMode,
      scope: meta.scope,
      violatingPaths: violations,
      action: mode, // "warn" or "block"
    };
    appendFileSync(join(dir, BOUNDARY_ESCAPE_FILE), JSON.stringify(line) + '\n');
  } catch {
    /* best-effort */
  }
}

// Internal helpers exported for tests
export const __test__ = {
  normalizeScope,
  isSystemPath,
  isBoundaryAllowed,
  SYSTEM_PREFIXES,
  BOUNDARY_ALLOWLIST,
};
