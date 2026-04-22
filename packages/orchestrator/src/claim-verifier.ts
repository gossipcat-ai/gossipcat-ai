/**
 * Premise verification — Stage 2 verifier (PR A).
 *
 * In-process claim verification: `fs.readFileSync` + `child_process.spawn('rg', …)`.
 * NO Agent(), NO LLM — same no-sub-agent discipline as Stage 1.
 *
 * Spec: `docs/specs/2026-04-22-premise-verification-stage-2.md` §Verifier.
 *
 * Invariants
 *  - ≤ 16 `rg` invocations per block (cap beyond that surfaces as
 *    `unverifiable_by_grep:claim_cap_exceeded`).
 *  - Shared per-block deadline budget of 500ms total across ALL spawns
 *    (not per-call). Once budget is exhausted, remaining claims short-
 *    circuit to `unverifiable_by_grep:timeout` without spawning.
 *  - `rg --count-matches` — counts every match, NOT lines. Per-file counts
 *    are summed when scope is a directory.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { resolve, sep } from 'path';
import type {
  AbsenceOfSymbolClaim,
  CallsiteCountClaim,
  Claim,
  ClaimBlock,
  ClaimVerdict,
  CountRelationClaim,
  FileLineClaim,
  Modality,
  PresenceOfSymbolClaim,
  Relation,
} from './claim-types';

export const MAX_CLAIMS_PER_BLOCK = 16;
export const PER_BLOCK_DEADLINE_MS = 500;

/**
 * Containment helper: resolve `input` against `projectRoot` and ensure the final
 * path stays inside `projectRoot`. Protects against two attack vectors:
 *
 *  1. Absolute paths — `path.resolve(root, '/etc/shadow')` returns `/etc/shadow`
 *     because an absolute second arg discards the first.
 *  2. `../..` escape — `path.resolve(root, '../../etc')` escapes above root.
 *  3. Symlink escape — an in-tree symlink that points outside the tree is
 *     detected via `fs.realpathSync`.
 *
 * Returns the resolved absolute path on success, or `null` on containment
 * violation. Callers must map `null` to `missing_path` / `file_not_found`
 * WITHOUT leaking the attempted input in the reason field.
 */
function containWithinProject(projectRoot: string, input: string): string | null {
  let resolved: string;
  try {
    resolved = resolve(projectRoot, input);
  } catch {
    return null;
  }
  // If the path exists on disk, collapse symlinks to detect escape via link.
  // If it doesn't exist yet (caller will then emit file_not_found), fall back
  // to the lexical resolve.
  let finalPath = resolved;
  try {
    if (existsSync(resolved)) {
      finalPath = realpathSync(resolved);
    }
  } catch {
    // realpath failure — treat as containment failure, safer than permitting.
    return null;
  }
  // Also collapse symlinks inside the root itself (e.g. macOS /var -> /private/var)
  // so the prefix comparison works.
  let rootReal = projectRoot;
  try {
    if (existsSync(projectRoot)) {
      rootReal = realpathSync(projectRoot);
    }
  } catch {
    // If we can't resolve root, bail — nothing is safe.
    return null;
  }
  if (finalPath === rootReal) return finalPath;
  if (finalPath.startsWith(rootReal + sep)) return finalPath;
  return null;
}

interface RgResult {
  /** Sum of per-file match counts. 0 if no hits. */
  total: number;
  /** `timeout` when spawn was killed by wallclock; `error` on other fs/spawn errors. */
  error?: 'timeout' | 'error' | 'missing_path';
}

function getModality(claim: Claim): Modality {
  // `modality` is required on every Claim by schema; parseClaimBlock
  // fills 'asserted' when missing with a lint warning.
  return (claim as { modality: Modality }).modality;
}

/**
 * Run `rg --count-matches -- <symbol> <scope>` inside `projectRoot` with the
 * remaining wallclock budget. Parses the `<path>:<count>` per-line output and
 * sums across files.
 *
 * Returns { total: 0 } on "no matches" (rg exit code 1).
 * Returns { total: 0, error: 'timeout' } when killed by the timeout.
 * Returns { total: 0, error: 'missing_path' } if scope doesn't exist on disk.
 */
function runRg(
  symbol: string,
  scope: string,
  projectRoot: string,
  remainingMs: number,
): Promise<RgResult> {
  return new Promise((resolvePromise) => {
    if (remainingMs <= 0) {
      resolvePromise({ total: 0, error: 'timeout' });
      return;
    }
    const scopePath = containWithinProject(projectRoot, scope);
    if (scopePath === null || !existsSync(scopePath)) {
      resolvePromise({ total: 0, error: 'missing_path' });
      return;
    }

    const proc = spawn(
      'rg',
      ['--count-matches', '--no-messages', '--', symbol, scopePath],
      { cwd: projectRoot, timeout: remainingMs },
    );

    let stdout = '';
    let timedOut = false;
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.on('error', () => {
      resolvePromise({ total: 0, error: 'error' });
    });
    // spawn's `timeout` option kills with SIGTERM and sets signal === 'SIGTERM'
    proc.on('close', (_code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        timedOut = true;
      }
      if (timedOut) {
        resolvePromise({ total: 0, error: 'timeout' });
        return;
      }
      // Parse output: each line is "<path>:<count>". Sum counts.
      let total = 0;
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        // Last `:` separates count from path (path may contain ':' on Windows-ish,
        // but rg normalizes on POSIX).
        const lastColon = line.lastIndexOf(':');
        if (lastColon < 0) continue;
        const n = Number(line.slice(lastColon + 1));
        if (Number.isFinite(n)) total += n;
      }
      resolvePromise({ total });
    });
  });
}

function evaluateRelation(lhs: number, rel: Relation, rhs: number): boolean {
  switch (rel) {
    case '>': return lhs > rhs;
    case '<': return lhs < rhs;
    case '=': return lhs === rhs;
    case '≥': return lhs >= rhs;
    case '≤': return lhs <= rhs;
  }
}

async function verifyCallsiteCount(
  claim: CallsiteCountClaim,
  idx: number,
  projectRoot: string,
  remainingMs: () => number,
): Promise<ClaimVerdict> {
  const modality = getModality(claim);

  // vague without range_hint → unverifiable by design (spec §Modality field).
  if (modality === 'vague' && !claim.range_hint) {
    // Still perform observation for logging? Per spec: "performs the observation,
    // records observed count, returns unverifiable_by_grep:no_range_hint."
    const r = await runRg(claim.symbol, claim.scope, projectRoot, remainingMs());
    if (r.error === 'timeout') {
      return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'timeout' };
    }
    return {
      claim_index: idx,
      status: 'unverifiable_by_grep',
      reason: `no_range_hint (observed=${r.total})`,
    };
  }

  const r = await runRg(claim.symbol, claim.scope, projectRoot, remainingMs());
  if (r.error === 'timeout') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'timeout' };
  }
  if (r.error === 'missing_path') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'scope_not_found' };
  }
  if (r.error === 'error') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'rg_error' };
  }

  // vague + range_hint: check observed in [min, max]
  if (modality === 'vague' && claim.range_hint) {
    const { min, max } = claim.range_hint;
    const inRange = r.total >= min && r.total <= max;
    const passed = claim.negated === true ? !inRange : inRange;
    if (passed) return { claim_index: idx, status: 'verified' };
    return {
      claim_index: idx,
      status: 'falsified',
      observed: r.total,
      expected: claim.negated ? `NOT in [${min}, ${max}]` : `[${min}, ${max}]`,
      modality,
    };
  }

  const equals = r.total === claim.expected;
  const passed = claim.negated === true ? !equals : equals;
  if (passed) return { claim_index: idx, status: 'verified' };
  return {
    claim_index: idx,
    status: 'falsified',
    observed: r.total,
    expected: claim.negated ? `≠ ${claim.expected}` : claim.expected,
    modality,
  };
}

async function verifyFileLine(
  claim: FileLineClaim,
  idx: number,
  projectRoot: string,
): Promise<ClaimVerdict> {
  const modality = getModality(claim);
  const filePath = containWithinProject(projectRoot, claim.path);

  if (filePath === null || !existsSync(filePath)) {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'file_not_found' };
  }
  let st;
  try {
    st = statSync(filePath);
  } catch {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'stat_failed' };
  }
  if (!st.isFile()) {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'not_a_file' };
  }

  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'read_failed' };
  }
  const lines = text.split('\n');
  // Spec lines are 1-indexed. Check ±2 around target.
  const target = claim.line;
  if (target < 1 || target > lines.length) {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'line_out_of_range' };
  }
  const lo = Math.max(1, target - 2);
  const hi = Math.min(lines.length, target + 2);
  let found = false;
  for (let i = lo; i <= hi; i++) {
    if (lines[i - 1].includes(claim.expected_symbol)) {
      found = true;
      break;
    }
  }
  const passed = claim.negated === true ? !found : found;
  if (passed) return { claim_index: idx, status: 'verified' };
  return {
    claim_index: idx,
    status: 'falsified',
    observed: found ? 'present' : 'absent',
    expected: claim.negated ? 'absent' : 'present',
    modality,
  };
}

async function verifyAbsence(
  claim: AbsenceOfSymbolClaim,
  idx: number,
  projectRoot: string,
  remainingMs: () => number,
): Promise<ClaimVerdict> {
  const modality = getModality(claim);
  const r = await runRg(claim.symbol, claim.scope, projectRoot, remainingMs());
  if (r.error === 'timeout') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'timeout' };
  }
  if (r.error === 'missing_path') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'scope_not_found' };
  }
  if (r.error === 'error') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'rg_error' };
  }
  if (r.total === 0) return { claim_index: idx, status: 'verified' };
  return {
    claim_index: idx,
    status: 'falsified',
    observed: r.total,
    expected: 0,
    modality,
  };
}

async function verifyPresence(
  claim: PresenceOfSymbolClaim,
  idx: number,
  projectRoot: string,
  remainingMs: () => number,
): Promise<ClaimVerdict> {
  const modality = getModality(claim);
  const r = await runRg(claim.symbol, claim.scope, projectRoot, remainingMs());
  if (r.error === 'timeout') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'timeout' };
  }
  if (r.error === 'missing_path') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'scope_not_found' };
  }
  if (r.error === 'error') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'rg_error' };
  }
  const present = r.total >= 1;
  const passed = claim.negated === true ? !present : present;
  if (passed) return { claim_index: idx, status: 'verified' };
  return {
    claim_index: idx,
    status: 'falsified',
    observed: r.total,
    expected: claim.negated ? '= 0' : '≥ 1',
    modality,
  };
}

async function verifyCountRelation(
  claim: CountRelationClaim,
  idx: number,
  projectRoot: string,
  remainingMs: () => number,
): Promise<ClaimVerdict> {
  const modality = getModality(claim);
  const r = await runRg(claim.symbol, claim.scope, projectRoot, remainingMs());
  if (r.error === 'timeout') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'timeout' };
  }
  if (r.error === 'missing_path') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'scope_not_found' };
  }
  if (r.error === 'error') {
    return { claim_index: idx, status: 'unverifiable_by_grep', reason: 'rg_error' };
  }
  const truth = evaluateRelation(r.total, claim.relation, claim.value);
  const passed = claim.negated === true ? !truth : truth;
  if (passed) return { claim_index: idx, status: 'verified' };
  return {
    claim_index: idx,
    status: 'falsified',
    observed: r.total,
    expected: `${claim.negated ? 'NOT ' : ''}${claim.relation} ${claim.value}`,
    modality,
  };
}

/**
 * Verify every claim in a block, respecting a shared 500ms deadline budget.
 * Claims beyond {@link MAX_CLAIMS_PER_BLOCK} are surfaced as
 * `unverifiable_by_grep:claim_cap_exceeded`.
 */
export async function verifyClaims(
  block: ClaimBlock,
  projectRoot: string,
): Promise<ClaimVerdict[]> {
  const deadline = Date.now() + PER_BLOCK_DEADLINE_MS;
  const remaining = (): number => Math.max(0, deadline - Date.now());

  const verdicts: ClaimVerdict[] = [];
  for (let i = 0; i < block.claims.length; i++) {
    const claim = block.claims[i];

    if (i >= MAX_CLAIMS_PER_BLOCK) {
      verdicts.push({
        claim_index: i,
        status: 'unverifiable_by_grep',
        reason: 'claim_cap_exceeded',
      });
      continue;
    }

    // Short-circuit when budget is gone. For `file_line` no spawn is needed,
    // but preserving budget discipline is load-bearing per spec — once the
    // verifier exceeds its wallclock, further claims are marked timeout
    // regardless of claim type to keep behavior predictable.
    if (remaining() <= 0) {
      verdicts.push({
        claim_index: i,
        status: 'unverifiable_by_grep',
        reason: 'timeout',
      });
      continue;
    }

    try {
      switch (claim.type) {
        case 'callsite_count':
          verdicts.push(await verifyCallsiteCount(claim, i, projectRoot, remaining));
          break;
        case 'file_line':
          verdicts.push(await verifyFileLine(claim, i, projectRoot));
          break;
        case 'absence_of_symbol':
          verdicts.push(await verifyAbsence(claim, i, projectRoot, remaining));
          break;
        case 'presence_of_symbol':
          verdicts.push(await verifyPresence(claim, i, projectRoot, remaining));
          break;
        case 'count_relation':
          verdicts.push(await verifyCountRelation(claim, i, projectRoot, remaining));
          break;
        default:
          verdicts.push({
            claim_index: i,
            status: 'unverifiable_by_grep',
            reason: `unknown_type`,
          });
      }
    } catch (e) {
      verdicts.push({
        claim_index: i,
        status: 'unverifiable_by_grep',
        reason: `verifier_error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return verdicts;
}
