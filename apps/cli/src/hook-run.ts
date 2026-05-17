/**
 * `gossipcat hook --run` — UserPromptSubmit hook body.
 *
 * Replaces the unconditional `cat .gossip/bootstrap.md` hook from prior
 * `gossip_setup` versions. Emits the full bootstrap on the first prompt of a
 * Claude Code session AND whenever bootstrap.md regenerates mid-session
 * (via `/mcp` reconnect or `gossip_status()` calls). Suppresses to a single
 * one-liner otherwise.
 *
 * Sentinel design (mtime-keyed, NOT PPID-keyed):
 *   - Path: `<tmpdir>/.gossipcat-bootstrap-<ppid>`
 *   - Contents: string form of bootstrap.md's `mtimeMs`
 *   - PPID in the filename only prevents collisions between parallel Claude
 *     Code sessions; correctness comes from comparing the stored mtime to the
 *     current file's mtime. See docs/specs/2026-05-07-bootstrap-hook-trim.md.
 *
 * Fail-open contract: ANY thrown error → fall through to printing the full
 * bootstrap. This subcommand runs on EVERY user prompt; a crash would block
 * the user's input.
 */
import { existsSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const NO_BOOTSTRAP_HINT =
  '[gossipcat] No bootstrap yet. Load tools first: ToolSearch(query: "select:mcp__gossipcat__gossip_status") then call gossip_status()';
const SUPPRESSED_LINE =
  '[gossipcat: bootstrap already loaded — call gossip_status() if you need a refresh]';

export interface HookRunOptions {
  /** Override `process.cwd()` for tests. */
  cwd?: string;
  /** Override the sentinel file path for tests. */
  sentinelPath?: string;
  /** Override stdout for tests. Defaults to `process.stdout.write`. */
  write?: (chunk: string) => void;
}

/**
 * Execute the hook body. Always exits cleanly (no throws) — callers can
 * rely on this from the CLI entrypoint without a try/catch.
 */
export function runHook(opts: HookRunOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const bootstrapPath = join(cwd, '.gossip', 'bootstrap.md');

  // Outer try/catch enforces the fail-open contract. Any unexpected error
  // (permission denied on /tmp, OOM on read, etc.) falls through to a
  // best-effort full-bootstrap print so the user's prompt is never blocked.
  try {
    if (!existsSync(bootstrapPath)) {
      write(NO_BOOTSTRAP_HINT + '\n');
      return;
    }

    let currentMtime: string | null = null;
    try {
      currentMtime = String(statSync(bootstrapPath).mtimeMs);
    } catch {
      // statSync threw (race with delete, perm change, etc.) — fail open
      // by printing the full bootstrap if we can read it.
      currentMtime = null;
    }

    const sentinelPath = opts.sentinelPath ?? defaultSentinelPath();

    if (currentMtime !== null && sentinelPath && existsSync(sentinelPath)) {
      let stored: string | null = null;
      try {
        stored = readFileSync(sentinelPath, 'utf-8').trim();
      } catch {
        stored = null;
      }
      if (stored !== null && stored === currentMtime) {
        write(SUPPRESSED_LINE + '\n');
        return;
      }
    }

    // First fire of session, OR bootstrap regenerated since last fire, OR
    // statSync failed (fail-open). Print full content.
    let content: string;
    try {
      content = readFileSync(bootstrapPath, 'utf-8');
    } catch {
      // Bootstrap unreadable for some reason — fall back to hint and bail.
      write(NO_BOOTSTRAP_HINT + '\n');
      return;
    }
    write(content);
    if (!content.endsWith('\n')) write('\n');

    // Update sentinel best-effort (any failure is silent).
    if (currentMtime !== null && sentinelPath) {
      try {
        writeFileSync(sentinelPath, currentMtime, 'utf-8');
      } catch {
        // best-effort
      }
    }
  } catch {
    // Outermost fail-open: try to spit out the bootstrap so the orchestrator
    // still has the rules; if even that fails, emit the no-bootstrap hint.
    try {
      const content = readFileSync(bootstrapPath, 'utf-8');
      write(content);
      if (!content.endsWith('\n')) write('\n');
    } catch {
      try { write(NO_BOOTSTRAP_HINT + '\n'); } catch { /* truly silent */ }
    }
  }
}

/**
 * Default sentinel path. PPID in the filename keeps parallel Claude Code
 * sessions from colliding; mtime stored INSIDE the file is what enforces
 * correctness.
 */
export function defaultSentinelPath(): string {
  return join(tmpdir(), `.gossipcat-bootstrap-${process.ppid}`);
}
