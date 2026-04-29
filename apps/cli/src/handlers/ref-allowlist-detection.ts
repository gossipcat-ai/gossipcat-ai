/**
 * Ref-allowlist enforcement — Phase 1 (detection-only).
 *
 * Spec: docs/specs/2026-04-29-ref-allowlist-enforcement.md §"Phase 1 Minimum Viable"
 *
 * Captures origin/master SHA at dispatch time. On relay completion, checks
 * whether origin/master moved without a corresponding PR-merge commit.
 * On violation: appends to .gossip/process-violations.jsonl, records a
 * boundary_escape signal with category process_discipline, and prints a
 * prominent stderr message. No auto-revert — operator must confirm.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

const PROCESS_VIOLATIONS_FILE = '.gossip/process-violations.jsonl';

/**
 * Capture origin/master SHA before dispatching a task.
 * Returns null on git failure (offline, no remote, no repo) — never blocks dispatch.
 */
export function capturePreDispatchSha(): string | null {
  try {
    const sha = execFileSync('git', ['rev-parse', 'origin/master'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return sha || null;
  } catch {
    process.stderr.write('[gossipcat] ref-allowlist: could not read origin/master SHA (offline or no remote) — skipping pre-dispatch snapshot\n');
    return null;
  }
}

/**
 * Get commits between two SHAs that look like PR merges
 * (git log --merges --grep="(#[0-9]").
 */
function getPrMergeCommits(preSha: string, postSha: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['log', `${preSha}..${postSha}`, '--merges', `--grep=(#[0-9]`, '--format=%H %s'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Get all commits between two SHAs (for violation audit trail).
 */
function getCommitRange(preSha: string, postSha: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['log', `${preSha}..${postSha}`, '--format=%H %s'],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function appendViolationRecord(record: {
  taskId: string;
  agentId: string;
  preSha: string;
  postSha: string;
  detectedAt: string;
  commits: string[];
}): void {
  try {
    const projectRoot = process.cwd();
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    const logPath = join(projectRoot, PROCESS_VIOLATIONS_FILE);
    appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[gossipcat] ref-allowlist: failed to append violation record: ${(err as Error).message}\n`);
  }
}

/**
 * Check whether origin/master moved during a task without a PR-merge entry.
 * Emits boundary_escape signal + appends to process-violations.jsonl on violation.
 * Call this at relay-completion time for any task that had a preDispatchSha captured.
 */
export function checkRefAllowlistViolation(
  taskId: string,
  agentId: string,
  preSha: string,
): void {
  let postSha: string;
  try {
    postSha = execFileSync('git', ['rev-parse', 'origin/master'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    // Can't read post-SHA — skip detection, don't false-positive
    return;
  }

  if (!postSha || postSha === preSha) return; // No change — clean

  // SHA changed — check for PR-merge commits in the delta
  const mergeCommits = getPrMergeCommits(preSha, postSha);
  if (mergeCommits.length > 0) return; // Legitimate PR merge — no violation

  // Violation: origin/master moved with no PR-merge entry
  const allCommits = getCommitRange(preSha, postSha);
  const detectedAt = new Date().toISOString();

  appendViolationRecord({ taskId, agentId, preSha, postSha, detectedAt, commits: allCommits });

  // Record boundary_escape signal with category process_discipline
  try {
    const { emitConsensusSignals } = require('@gossip/orchestrator');
    emitConsensusSignals(process.cwd(), [
      {
        type: 'consensus' as const,
        signal: 'boundary_escape' as const,
        agentId,
        taskId,
        findingId: `proc:${taskId}:master_push`,
        category: 'process_discipline',
        severity: 'high',
        evidence: `origin/master moved from ${preSha} to ${postSha} during task ${taskId} without a PR-merge entry — direct push detected. Commits: ${allCommits.slice(0, 5).join('; ')}`,
        timestamp: detectedAt,
      },
    ]);
  } catch (err) {
    process.stderr.write(`[gossipcat] ref-allowlist: failed to emit boundary_escape signal: ${(err as Error).message}\n`);
  }

  process.stderr.write(
    `\nREF-ALLOWLIST VIOLATION: ${taskId} agent=${agentId} origin/master moved ${preSha.slice(0, 8)}→${postSha.slice(0, 8)} with no PR merge.\n` +
      `Operator confirmation required for revert or retroactive PR.\n` +
      `Full audit trail at .gossip/process-violations.jsonl\n\n`,
  );
}
