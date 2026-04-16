/**
 * Sandbox enforcement — prompt sanitization + post-task boundary audit.
 *
 * Claude Code's Agent isolation:"worktree" and gossipcat's write_mode:"scoped"
 * are ADVISORY only at the harness layer: Edit/Write tools accept absolute
 * paths and silently bypass containment. Until that ships, gossipcat adds its
 * own soft enforcement via three layers:
 *
 *   Layer 1. relativizeProjectPaths — rewrite absolute project paths in the
 *      task prompt to relative paths, so agents don't learn the absolute prefix.
 *   Layer 2. PreToolUse hook (assets/hooks/worktree-sandbox.sh) — deny
 *      absolute-path writes by worktree agents at harness time. Catches
 *      literal absolute paths.
 *   Layer 3. auditFilesystemSinceSentinel — POSIX `find -newer` audit that
 *      runs after dispatch. Catches bypasses Layer 2 cannot see: shell-quoted
 *      paths, tilde expansion (~/x), env-var derived paths ($HOME/y). Scans
 *      the real filesystem for any file touched during the dispatch window.
 *   Also: auditDispatchBoundary — `git status --porcelain` audit that flags
 *      modified tracked/untracked files outside the declared scope.
 *
 * All are best-effort. A determined agent can still invoke shell tools or
 * reconstruct paths. The durable fix is a Claude Code harness change.
 */
import { execFileSync, execSync } from 'child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'path';

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
  /** Absolute path to the per-task sentinel file stamped at dispatch time.
   * Its mtime is the `-newer` anchor for the Layer 3 filesystem audit. */
  sentinelPath?: string;
}

const METADATA_FILE = 'dispatch-metadata.jsonl';
const BOUNDARY_ESCAPE_FILE = 'boundary-escapes.jsonl';
const SENTINEL_DIR = 'sentinels';

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
  'SCOPE NOTE: SANDBOXED WRITE BOUNDARY.\n' +
  'This task runs in an isolated worktree. You MUST use only relative paths (./package/file.ts).\n' +
  'Any write outside the worktree — absolute paths (/Users/...), parent-escape (../), or cd-into-parent\n' +
  '— is a BOUNDARY ESCAPE. Detected post-task, recorded as a `disagreement` signal under\n' +
  '`trust_boundaries`, logged to .gossip/boundary-escapes.jsonl, and PENALIZES YOUR ACCURACY SCORE.\n' +
  '\n' +
  'Rules:\n' +
  '- Tools: use Edit/Write/Read/Glob/Grep with relative paths only.\n' +
  '- Never run `cd`, `realpath`, `pwd -P`, or any shell command that emits an absolute path.\n' +
  '- Never reconstruct a path you see in task context back to absolute form — treat such paths as\n' +
  '  opaque relative references even if they look absolute.\n' +
  '- Project root is `./`. Nothing else.\n' +
  '\n';

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
 * violation set. Also stamps a per-task sentinel file whose mtime serves as
 * the `-newer` anchor for the Layer 3 filesystem audit (see
 * auditFilesystemSinceSentinel). */
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

      // Stamp a per-task sentinel. Concurrent dispatches race if they share a
      // single sentinel, so every task gets its own file keyed by taskId.
      try {
        const sentinelPath = stampTaskSentinel(projectRoot, meta.taskId);
        if (sentinelPath) snapshotted.sentinelPath = sentinelPath;
      } catch { /* best-effort — audit fail-opens if sentinel missing */ }
    }
    appendFileSync(join(dir, METADATA_FILE), JSON.stringify(snapshotted) + '\n');
  } catch {
    /* best-effort */
  }
}

/**
 * Merge a partial patch into the LAST matching dispatch metadata record for
 * the given task ID. Use this when information learned AFTER dispatch (e.g.
 * the worktree path returned by WorktreeManager.create() or by Claude Code's
 * Agent({isolation:"worktree"}) invocation) must be written back so the
 * post-dispatch Layer 3 audit can exclude the task's own worktree.
 *
 * Best-effort: silently returns false on any I/O or parse failure. Rewrites
 * the entire JSONL file; callers should not rely on exact line ordering.
 */
export function updateDispatchMetadata(
  projectRoot: string,
  taskId: string,
  patch: Partial<DispatchMetadata>,
): boolean {
  try {
    const p = join(projectRoot, '.gossip', METADATA_FILE);
    if (!existsSync(p)) return false;
    const raw = readFileSync(p, 'utf-8');
    const lines = raw.split('\n');
    let patched = false;
    // Iterate from the tail so the LAST matching record wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as DispatchMetadata;
        if (entry.taskId === taskId) {
          const merged = { ...entry, ...patch };
          lines[i] = JSON.stringify(merged);
          patched = true;
          break;
        }
      } catch {
        /* skip corrupt line */
      }
    }
    if (!patched) return false;
    writeFileSync(p, lines.join('\n'));
    return true;
  } catch {
    return false;
  }
}

/** Create (or refresh) a per-task sentinel file. mtime = dispatch start.
 * Returns the absolute path or null on failure. Pure helper — no logging. */
export function stampTaskSentinel(projectRoot: string, taskId: string): string | null {
  if (!taskId) return null;
  try {
    const dir = join(projectRoot, '.gossip', SENTINEL_DIR);
    mkdirSync(dir, { recursive: true });
    // Sanitize taskId to a filesystem-safe slug. Task IDs are already
    // [a-zA-Z0-9_-] per dispatch validation, but belt-and-suspenders.
    const slug = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const path = join(dir, `${slug}.sentinel`);
    // Open O_CREAT|O_WRONLY to create empty, then utimes to stamp NOW with
    // millisecond precision. `find -newer` on most POSIX systems uses whole
    // seconds, but on platforms that support mtim we get better resolution.
    const fd = openSync(path, 'w');
    closeSync(fd);
    // Backdate 2s so files written in the same second as the stamp are included by find -newer (strictly-greater semantics + 1s filesystem granularity).
    const stampTime = new Date(Date.now() - 2000);
    utimesSync(path, stampTime, stampTime);
    return path;
  } catch {
    return null;
  }
}

/** Remove a per-task sentinel. Idempotent — missing file is fine. */
export function cleanupTaskSentinel(sentinelPath: string | undefined): void {
  if (!sentinelPath) return;
  try {
    unlinkSync(sentinelPath);
  } catch {
    /* idempotent — file may have been cleaned already */
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
    const scopes = (meta.scope || '').split(',').map(s => normalizeScope(s, projectRoot)).filter(Boolean);
    if (scopes.length === 0) return []; // no scope declared → cannot evaluate
    return modifiedFiles.filter(f => !scopes.some(s => isInsideScope(f, s)) && !isBoundaryAllowed(f));
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

// ──────────────────────────────────────────────────────────────────────────
// Layer 3: post-dispatch `find -newer` filesystem audit
//
// Layer 2 (PreToolUse hook) gates literal-string path arguments. It cannot see
// tilde expansion, env-var derived paths, or shell-quoted paths — those are
// resolved by the shell or Node after the hook has already returned allow.
// Layer 3 closes that gap by scanning the filesystem after the agent finishes
// for any file modified during the dispatch window.
//
// Scope roots (what we scan):
//   - $HOME          — catches ~/x and $HOME/x bypasses
//   - tmpdir()       — catches /tmp/x bypasses (also covers /private/tmp on
//                      macOS because tmpdir() returns /var/folders/..., but
//                      we add /tmp and /private/tmp explicitly for macOS's
//                      shell-default $TMPDIR habit)
//
// Exclusions (not a bypass — legitimate write targets):
//   - The current task's own worktree (meta.worktreePath), if set. For
//     relay dispatch via WorktreeManager this is /tmp/gossip-wt-<hash>;
//     we also generate the /private/tmp/... twin on macOS.
//   - Native Claude Code worktrees live under <projectRoot>/.claude/worktrees/
//     — covered by the blanket .claude exclusion, so meta.worktreePath can
//     stay undefined for native dispatch without false positives.
//   - .gossip/ — sentinel dir, metadata JSONL, etc.
//   - Peer worktrees are INTENTIONALLY NOT excluded. They are separate
//     isolation zones; writes to a peer's worktree are cross-contamination
//     bypasses, not legitimate traffic.
// ──────────────────────────────────────────────────────────────────────────

export interface Layer3AuditResult {
  violations: string[];
  skipped?: string;
}

interface Layer3AuditOptions {
  /** Extra cwd the agent ran in. When set, files under it are excluded
   * from the audit (they are legitimate writes to the worktree). */
  worktreePath?: string;
  /** Agent's scope when writeMode=scoped — treated as a permitted write root. */
  scope?: string;
  /** Override the scan roots (tests). Defaults to `defaultScanRoots(writeMode,
   * projectRoot)`. */
  scanRoots?: string[];
  /** Override `process.platform` (tests). */
  platform?: NodeJS.Platform;
  /** Override the find binary (tests). */
  findBinary?: string;
  /** Swallow child_process errors — defaults to true. Tests can flip this. */
  logFailures?: boolean;
  /** Dispatch write mode. Drives the default scan-root shape: scoped mode
   * narrows to projectRoot only (Tool Server's shell_exec is read-only-git
   * for scoped agents, so $HOME scan has zero true-positive capacity);
   * worktree/sequential/undefined keep the broad scan (relay shell_exec
   * can escape). */
  writeMode?: DispatchWriteMode;
}

/** Canonicalize a path for comparison — resolve symlinks when the file exists
 * and always strip a trailing separator. Never throws. */
function canonicalize(p: string): string {
  try {
    // `realpathSync` would resolve symlinks, but it throws on non-existent
    // paths. We prefer `resolve` (normalizes + absolutizes without touching
    // the filesystem) so this function is total. Symlink mismatch between
    // /tmp and /private/tmp on macOS is handled by including both in the
    // scan/exclusion lists.
    return resolve(p).replace(/\/+$/, '') || '/';
  } catch {
    return p.replace(/\/+$/, '') || '/';
  }
}

/** Compute the default scan roots. Exposed for tests.
 *
 * Mode-aware shape:
 *   - scoped:    projectRoot only. Tool Server's shell_exec is read-only-git
 *                for scoped agents; they cannot write outside scope via any
 *                primitive. Scanning $HOME has zero true-positive capacity
 *                (live-fire 2026-04-16: 1064 violations per dispatch were
 *                100% orchestrator/OS noise).
 *   - worktree / sequential / undefined: broad scan ($HOME + tmpdir + /tmp
 *                + /private/tmp). Relay shell_exec can escape $HOME and
 *                tmpdir, so bypasses under these roots ARE reachable.
 */
export function defaultScanRoots(
  writeMode: DispatchWriteMode,
  projectRoot: string,
): string[] {
  const out = new Set<string>();
  if (writeMode === 'scoped') {
    // Scoped agents cannot write outside scope via any Tool Server primitive
    // (shell_exec is read-only-git for scoped mode). Scanning $HOME has zero
    // true-positive capacity.
    try { out.add(canonicalize(projectRoot)); } catch { /* ignore */ }
    return Array.from(out);
  }
  // Worktree / sequential: broad scan — relay shell_exec can escape $HOME/tmpdir.
  try { out.add(canonicalize(homedir())); } catch { /* ignore */ }
  try { out.add(canonicalize(tmpdir())); } catch { /* ignore */ }
  // macOS's shell-level TMPDIR often points into /var/folders/..., but
  // `/tmp` and `/private/tmp` are the classic bypass drops. Include both
  // defensively — find will silently skip missing roots.
  out.add('/tmp');
  out.add('/private/tmp');
  return Array.from(out);
}

/**
 * Emit both /tmp and /private/tmp variants of a path so `find -not -path`
 * matches whichever form `find` surfaces on macOS (where /tmp is a symlink
 * to /private/tmp and the kernel reports the resolved form for files opened
 * via either). Lexical-only — never touches the filesystem.
 */
export function expandTmpVariants(path: string): string[] {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/tmp' || p.startsWith('/tmp/')) {
    return [p, '/private' + p];
  }
  if (p === '/private/tmp' || p.startsWith('/private/tmp/')) {
    return [p, p.replace(/^\/private/, '')];
  }
  return [p];
}

/** Build the exclusion list for the Layer 3 audit. The current task's own
 * worktree is excluded; peer worktrees stay in scope (they are separate
 * isolation zones — cross-contamination IS a bypass). For /tmp paths both
 * /tmp and /private/tmp variants are emitted so macOS realpath quirks don't
 * produce false positives. */
export function buildAuditExclusions(
  projectRoot: string,
  ownWorktree: string | undefined,
  scope?: string,
): string[] {
  const excl = new Set<string>();
  const root = canonicalize(projectRoot);
  for (const v of expandTmpVariants(`${root}/.gossip`)) excl.add(v);
  for (const v of expandTmpVariants(`${root}/.claude`)) excl.add(v);
  // Orchestrator git activity runs inside collect() BEFORE the audit.
  // worktreeManager.merge() + cleanup() (dispatch-pipeline.ts) touches
  // .git/refs, .git/logs, .git/index, .git/objects — all newer than the
  // sentinel, none agent-attributable. Exclude the project's .git entirely.
  for (const v of expandTmpVariants(`${root}/.git`)) excl.add(v);
  // User-level OS/app churn dirs. These are unreachable through the Tool
  // Server sandbox or Layer 2 hook, so violations under them are pure noise
  // (Chrome cookies, Spotify cache, Claude Code session logs, npm cache, etc.).
  // Real agent writes anywhere else in $HOME are still caught.
  // `.claude` (not just `.claude/projects`) — Claude Code harness spawns new
  // subtrees per release (e.g. `.claude/plugins/`, `.claude/caches/`), and
  // any path under $HOME/.claude is orchestrator churn.
  try {
    const home = canonicalize(homedir());
    for (const sub of ['Library', '.cache', '.npm', '.claude']) {
      for (const v of expandTmpVariants(`${home}/${sub}`)) excl.add(v);
    }
  } catch { /* homedir() failure — best-effort, never block audit */ }
  // OS-level tmpdir churn. macOS darwin user temp dirs (com.apple.*,
  // itunescloudd, TemporaryItems) fill up during a dispatch regardless of
  // agent activity. Exclude the well-known prefixes; any other file under
  // tmpdir is still flagged.
  try {
    const tmp = canonicalize(tmpdir());
    for (const pat of ['com.apple.*', 'itunescloudd', 'TemporaryItems', 'node-compile-cache']) {
      for (const v of expandTmpVariants(`${tmp}/${pat}`)) excl.add(v);
    }
  } catch { /* tmpdir() failure — best-effort */ }
  if (ownWorktree) {
    const wt = canonicalize(ownWorktree);
    for (const v of expandTmpVariants(wt)) excl.add(v);
  }
  if (scope) {
    // In scoped mode, the agent's own writes inside its scope are permitted.
    // The `scope` path is relative to projectRoot.
    const s = canonicalize(join(projectRoot, scope));
    for (const v of expandTmpVariants(s)) excl.add(v);
  }
  return Array.from(excl);
}

/**
 * Build `find` argv using `-prune` to skip excluded directories entirely
 * rather than `-not -path` which only filters output AFTER descending. On
 * macOS, descending into $HOME/Library/* triggers TCC "Operation not
 * permitted" errors even though the files there are irrelevant; `-prune`
 * sidesteps that noise.
 *
 * Shape when exclusions is non-empty:
 *   <root> ( -path ex1 -o -path ex2 ... ) -prune -o -type f -newer <sentinel> -print
 *
 * Shape when exclusions is empty:
 *   <root> -type f -newer <sentinel> -print
 *
 * `(` and `)` are separate argv entries — execFileSync takes them literally
 * (no shell). With `-prune`, the directory path alone is enough; trailing
 * `/*` globs are neither needed nor correct.
 *
 * Exported for targeted arg-shape testing.
 */
export function buildFindPruneArgs(
  scanRoot: string,
  exclusions: string[],
  sentinel: string,
): string[] {
  const args: string[] = [scanRoot];
  if (exclusions.length > 0) {
    args.push('(');
    for (let i = 0; i < exclusions.length; i++) {
      if (i > 0) args.push('-o');
      args.push('-path', exclusions[i]);
    }
    args.push(')', '-prune', '-o');
  }
  args.push('-type', 'f', '-newer', sentinel, '-print');
  return args;
}

/**
 * Post-dispatch `find -newer <sentinel>` audit. Walks scan roots and records
 * any file modified after the sentinel's mtime that is NOT inside the
 * current task's worktree or a gossipcat infrastructure directory.
 *
 * Contract:
 *   - Windows: skipped (POSIX-only primitive). Logged, not failed.
 *   - `find` error: logged, empty result returned. MUST NOT propagate.
 *   - Sentinel missing: skipped with reason. Audit fail-opens.
 *   - Any violations: appended to .gossip/boundary-escapes.jsonl with
 *     source='layer3-audit', one line per violating path.
 */
export function auditFilesystemSinceSentinel(
  projectRoot: string,
  meta: DispatchMetadata,
  options: Layer3AuditOptions = {},
): Layer3AuditResult {
  const platform = options.platform ?? process.platform;
  const logFailures = options.logFailures ?? true;

  if (platform === 'win32') {
    if (logFailures) {
      process.stderr.write(
        `[gossipcat] Layer 3 audit skipped (win32: find -newer is POSIX-only)\n`,
      );
    }
    return { violations: [], skipped: 'win32' };
  }

  const sentinel = meta.sentinelPath;
  if (!sentinel || !existsSync(sentinel)) {
    return { violations: [], skipped: 'sentinel missing' };
  }

  // Sanity check: sentinel must be newer than the epoch. `find -newer` on
  // a broken sentinel would return everything.
  let sentinelMtimeMs = 0;
  try { sentinelMtimeMs = statSync(sentinel).mtimeMs; } catch { /* ignore */ }
  if (sentinelMtimeMs === 0) {
    return { violations: [], skipped: 'sentinel stat failed' };
  }

  const scanRoots = options.scanRoots ?? defaultScanRoots(
    options.writeMode ?? meta.writeMode,
    projectRoot,
  );
  const exclusions = buildAuditExclusions(projectRoot, meta.worktreePath, options.scope);
  const findBin = options.findBinary ?? 'find';

  const violations: string[] = [];

  for (const root of scanRoots) {
    if (!existsSync(root)) continue;
    const canonRoot = canonicalize(root);

    // Always exclude the sentinel dir itself (stamping it bumps its own
    // mtime and would otherwise self-match if tmpdir == .gossip path).
    // buildAuditExclusions already emits /tmp + /private/tmp twins for its
    // inputs; do the same for the sentinel dir so both forms are covered.
    const sentinelDir = canonicalize(join(projectRoot, '.gossip', SENTINEL_DIR));
    const allExcl = [...exclusions, ...expandTmpVariants(sentinelDir)];
    const args = buildFindPruneArgs(canonRoot, allExcl, sentinel);

    try {
      // Use execFileSync (no shell) so exclusions are passed as literal args.
      // Set a hard timeout to prevent a stuck find from blocking relay.
      const out = execFileSync(findBin, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      for (const line of out.split('\n')) {
        const p = line.trim();
        if (!p) continue;
        violations.push(p);
      }
    } catch (err) {
      // find exits non-zero on ANY permission error (macOS TCC is the common
      // case — Library/Group Containers etc). But stdout still contains the
      // files it COULD see. Parse that before fail-opening, otherwise every
      // real violation on macOS gets silently dropped.
      const e = err as { stdout?: Buffer | string; message?: string };
      const partial = typeof e.stdout === 'string'
        ? e.stdout
        : (e.stdout?.toString?.('utf-8') ?? '');
      for (const line of partial.split('\n')) {
        const p = line.trim();
        if (p) violations.push(p);
      }
      if (logFailures) {
        const msg = e.message || String(err);
        const parsedCount = partial ? partial.split('\n').filter(Boolean).length : 0;
        process.stderr.write(
          `[gossipcat] Layer 3 audit: find partial failure under '${canonRoot}' (stdout parsed, ${parsedCount} entries): ${msg}\n`,
        );
      }
      continue;
    }
  }

  if (violations.length > 0) {
    recordLayer3Violations(projectRoot, meta, violations);
    if (logFailures) {
      process.stderr.write(
        `[gossipcat] ⚠ Layer 3 BOUNDARY ESCAPE: ${meta.agentId} task ${meta.taskId} touched ${violations.length} path(s) outside worktree:\n` +
          violations.slice(0, 20).map(v => `    ${v}`).join('\n') +
          '\n',
      );
    }
  }

  return { violations };
}

/** Append one entry per violating path to boundary-escapes.jsonl. Shape
 * mirrors Layer 2's `recordBoundaryEscape`: `violatingPaths` is a
 * 1-element array per line (Layer 3 does NOT aggregate across paths so the
 * audit trail stays path-granular, but the field type matches Layer 2 so
 * downstream readers can parse either source with one shape). */
function recordLayer3Violations(
  projectRoot: string,
  meta: DispatchMetadata,
  violations: string[],
): void {
  try {
    const dir = join(projectRoot, '.gossip');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const lines = violations.map(path =>
      JSON.stringify({
        timestamp: ts,
        taskId: meta.taskId,
        agentId: meta.agentId,
        violatingPaths: [path],
        source: 'layer3-audit',
      }),
    );
    appendFileSync(join(dir, BOUNDARY_ESCAPE_FILE), lines.join('\n') + '\n');
  } catch {
    /* best-effort */
  }
}

/**
 * Run the full Layer 3 audit flow for a task: look up metadata, run
 * `find -newer` audit, format the violation message, clean the sentinel.
 *
 * Returns:
 *   - `blockError`: populated when enforcement is "block" and violations
 *     were detected. Callers should mark the task as failed and surface
 *     this error to consensus/memory.
 *   - `warnPrefix`: populated when enforcement is "warn" and violations
 *     were detected. Callers should prepend this to the task output so the
 *     violation shows up in the result.
 *
 * Idempotent with respect to sentinel cleanup — always runs regardless of
 * outcome. Fail-open: any internal error (including missing metadata, dead
 * sentinel, or `find` crash) is logged and swallowed. The caller never

 * sees a thrown error.
 */
export function runLayer3Audit(
  projectRoot: string,
  taskId: string,
): { blockError: string | null; warnPrefix: string } {
  let blockError: string | null = null;
  let warnPrefix = '';
  try {
    const enforcement = readSandboxMode(projectRoot);
    if (enforcement === 'off') return { blockError, warnPrefix };
    const meta = lookupDispatchMetadata(projectRoot, taskId);
    if (!meta) return { blockError, warnPrefix };
    if (meta.writeMode !== 'scoped' && meta.writeMode !== 'worktree') {
      return { blockError, warnPrefix };
    }
    try {
      const l3 = auditFilesystemSinceSentinel(projectRoot, meta, {
        writeMode: meta.writeMode,
        scope: meta.scope,
      });
      if (l3.violations && l3.violations.length > 0) {
        const list = l3.violations.slice(0, 20).join(', ');
        if (enforcement === 'block') {
          blockError = `LAYER 3 BOUNDARY ESCAPE — task touched ${l3.violations.length} path(s) outside worktree. First: ${list}`;
        } else {
          warnPrefix = `⚠ LAYER 3 BOUNDARY ESCAPE (warn): ${l3.violations.length} path(s) touched outside worktree — ${list}\n\n`;
        }
      }
    } catch (l3Err) {
      process.stderr.write(`[gossipcat] Layer 3 audit failed: ${(l3Err as Error).message}\n`);
    } finally {
      // Idempotent sentinel cleanup: always remove regardless of outcome.
      cleanupTaskSentinel(meta.sentinelPath);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] runLayer3Audit failed: ${(err as Error).message}\n`);
  }
  return { blockError, warnPrefix };
}

// Internal helpers exported for tests
export const __test__ = {
  normalizeScope,
  isSystemPath,
  isBoundaryAllowed,
  canonicalize,
  expandTmpVariants,
  SYSTEM_PREFIXES,
  BOUNDARY_ALLOWLIST,
  SENTINEL_DIR,
};
