/**
 * Utility-task guard: post-dispatch git-status check.
 *
 * Native utility sub-agents (skill_develop, session_summary, verify_memory,
 * gossip_plan) are supposed to produce TEXT OUTPUT ONLY. They run with full
 * tool access however, and prompt-injection from quoted code/findings has
 * historically caused them to silently mutate the working tree.
 *
 * Documented incident: Math.min revert at cross-reviewer-selection.ts:155
 * during session 2026-04-22 — a session-summary sub-agent re-read its own
 * input prose as instructions and undid an in-flight fix.
 *
 * This guard captures `git status --porcelain` before dispatch, captures it
 * again after gossip_relay completes, and logs any delta to stderr. It does
 * NOT throw — the utility task already produced output by then; the goal is
 * visibility so the orchestrator and operator notice the drift.
 */

import { execSync } from 'node:child_process';

/**
 * Capture `git status --porcelain` for the current cwd. Returns the raw
 * porcelain output (may be empty string when working tree is clean). Returns
 * empty string on any error (git missing, not a repo, etc.) — guard is
 * best-effort and must never break utility dispatch.
 */
export function captureGitStatus(): string {
  try {
    const out = execSync('git status --porcelain', {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out;
  } catch {
    return '';
  }
}

/**
 * Diff two porcelain snapshots; if any new or removed line appears, write a
 * single warning record to stderr identifying the utility task that caused
 * it. Never throws.
 *
 * Diff is line-set based: a line present in `after` but not `before` (or
 * vice-versa) is reported. This catches:
 *   - new untracked files (?? path)
 *   - modified tracked files ( M path)
 *   - newly staged changes (M  path)
 *   - removed files
 */
export function checkUnexpectedChanges(
  before: string,
  after: string,
  taskType: string,
  taskId: string,
): void {
  try {
    if (before === after) return;
    const beforeSet = new Set(
      before.split('\n').map((l) => l).filter((l) => l.length > 0),
    );
    const afterSet = new Set(
      after.split('\n').map((l) => l).filter((l) => l.length > 0),
    );
    const added: string[] = [];
    const removed: string[] = [];
    for (const line of afterSet) if (!beforeSet.has(line)) added.push(line);
    for (const line of beforeSet) if (!afterSet.has(line)) removed.push(line);
    if (added.length === 0 && removed.length === 0) return;

    const diffLines: string[] = [];
    for (const a of added) diffLines.push(`+ ${a}`);
    for (const r of removed) diffLines.push(`- ${r}`);
    const diff = diffLines.join('\n');
    process.stderr.write(
      `[gossipcat] WARNING: utility task ${taskType}/${taskId} modified unexpected files:\n${diff}\n`,
    );
  } catch {
    // Never throw from a guard.
  }
}
