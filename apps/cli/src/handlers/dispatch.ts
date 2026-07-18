/**
 * Dispatch handler functions — single, parallel, and consensus modes.
 * All state accessed via the shared context object.
 */
import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  assemblePrompt,
  loadSkills,
  parseClaimBlock,
  verifyClaims,
  emitConsensusSignals,
  sanitizeForLog,
  hashPath,
  type ClaimBlock,
  type ClaimVerdict,
  type PerformanceSignal,
  type RoundWarning,
} from '@gossip/orchestrator';
import { formatIdentityBlock } from '@gossip/tools';
import {
  buildNativeDispatchSingleResponse,
  detectNativeHost,
  formatNativeAgentCall,
  formatNativePromptInstruction,
  nativeDispatchConsensusFooter,
  nativeDispatchParallelHeader,
  nativeDispatchViaLabel,
  nativeToolName,
  nativeWorktreeBanner,
} from '../native-host-bridge';
import { ctx, NATIVE_TASK_TTL_MS, MAX_PENDING_DISPATCH_WARNINGS } from '../mcp-context';
import { runDispatchPreconditionGuard } from './orchestrator-precondition-runner';

/**
 * Stash dispatch-time fail-loud warnings (spec §3.2 boundary #1) under every
 * minted task_id so gossip_collect can drain them into the collect-built
 * RoundContext. No-op when there are no warnings. The same warnings array is
 * stored under each id (collect dedups by draining once); frozen so a later
 * mutation can't retroactively change a stashed entry.
 */
function stashDispatchWarnings(taskIds: readonly string[], warnings?: readonly RoundWarning[]): void {
  if (!warnings || warnings.length === 0 || taskIds.length === 0) return;
  const frozen = Object.freeze(warnings.map(w => Object.freeze({ ...w })));
  for (const tid of taskIds) {
    // Bounded eviction: evict the eldest entry (first by Map insertion order)
    // when the cap is reached, so uncollected tasks don't grow the map without
    // bound for the server lifetime.
    if (ctx.pendingDispatchWarnings.size >= MAX_PENDING_DISPATCH_WARNINGS) {
      const eldest = ctx.pendingDispatchWarnings.keys().next().value;
      if (eldest !== undefined) ctx.pendingDispatchWarnings.delete(eldest);
    }
    ctx.pendingDispatchWarnings.set(tid, frozen);
    // Spec §3.2 / f11 follow-up: persist a marker on the native task entry (when
    // one exists) so a reconnect that wipes the in-memory stash above leaves a
    // durable breadcrumb. Collect emits `dispatch_warnings_lost` when the marker
    // is set but the stash entry is gone. Set unconditionally where the entry
    // already exists; the single-native path (entry created after stash) marks
    // at creation via markDispatchWarningsStashedIfNeeded.
    const native = ctx.nativeTaskMap.get(tid);
    if (native) native.dispatchWarningsStashed = true;
  }
}

/**
 * Set the persisted `dispatchWarningsStashed` marker on a native task entry when
 * dispatch-time warnings were stashed under its task_id but the entry was created
 * AFTER the stash call (single-native dispatch path). Spec §3.2 / f11 follow-up.
 */
function markDispatchWarningsStashedIfNeeded(taskId: string): void {
  if (!ctx.pendingDispatchWarnings.has(taskId)) return;
  const native = ctx.nativeTaskMap.get(taskId);
  if (native) native.dispatchWarningsStashed = true;
}

/**
 * f11 follow-up (consensus dfe05be2-73794442:f11): the in-memory
 * `pendingDispatchWarnings` stash is reconnect-volatile. For each collected
 * task whose native entry (task map OR result map) carries the persisted
 * `dispatchWarningsStashed` marker but has NO live stash entry, the warnings
 * were lost — either by /mcp reconnect or by bounded stash eviction (cap=200,
 * eldest-evict). Returns one `dispatch_warnings_lost` RoundWarning per
 * affected task so the LOSS is fail-loud rather than silently unobservable.
 * Pure over (taskMap, resultMap, stash) — unit-testable in isolation.
 */
export function detectLostDispatchWarnings(
  taskIds: readonly string[],
  nativeTaskMap: Map<string, { dispatchWarningsStashed?: boolean }>,
  stash: Map<string, unknown>,
  nativeResultMap?: Map<string, { dispatchWarningsStashed?: boolean }>,
): RoundWarning[] {
  const out: RoundWarning[] = [];
  for (const tid of taskIds) {
    if (stash.has(tid)) continue; // live stash — no loss
    const marker =
      nativeTaskMap.get(tid)?.dispatchWarningsStashed === true ||
      nativeResultMap?.get(tid)?.dispatchWarningsStashed === true;
    if (marker) {
      out.push({
        code: 'dispatch_warnings_lost',
        message: `dispatch-time warnings for task ${tid} were lost before collect (server reconnect or stash eviction) — rejected-root reasons unavailable`,
      });
    }
  }
  return out;
}

/** Build the identity block for a native subagent dispatch. */
function buildNativeIdentity(agentId: string, model: string): string {
  return formatIdentityBlock({
    agent_id: agentId,
    runtime: 'native',
    provider: 'anthropic',
    model,
  });
}
import { evictStaleNativeTasks, persistNativeTaskMap, spawnTimeoutWatcher } from './native-tasks';
import { writeDispatchPrompt } from './dispatch-prompt-storage';
import {
  computeSkillFingerprint,
  getCachedPrompt,
  setCachedPrompt,
  splitAssembledPrompt,
  writeCachedSkillsSection,
  type PromptCacheKey,
  type TaskKind,
} from './dispatch-prompt-cache';
import { existsSync } from 'fs';

/**
 * Strict opt-in elision marker (spec §1 iron rule).
 * Server elides AGENT_PROMPT content items only when this exact string is
 * received. Default unchanged ('inline' or undefined). New tool-schema enum
 * additions must intentionally widen the check.
 */
export type PromptFormat = 'inline' | 'elided';

/**
 * Check whether `cwd` is inside a git repository.
 *
 * Used by all three dispatch paths (single, parallel, consensus) to gate
 * worktree isolation: if the project is not a git repo, we silently downgrade
 * `write_mode === 'worktree'` to a non-worktree dispatch and emit a visible
 * warning so the operator knows isolation was not engaged.
 *
 * Exported for unit tests.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    const { execSync } = require('child_process');
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stamp concurrency taint at dispatch time.
 *
 * If ANY existing entry in the map has `writeMode === 'worktree'`, mutate all
 * those entries' `concurrentWorktreeTaint` to `true` AND return `true` so the
 * new entry also gets tainted. Otherwise return `false` (no sibling, no taint).
 *
 * Mutation is in-place — Map values are object refs, fine to mutate.
 *
 * Exported for unit tests in tests/cli/dispatch-concurrency-taint.test.ts.
 */
export function stampConcurrencyTaint(
  map: Map<string, { writeMode?: string; concurrentWorktreeTaint?: boolean }>,
): boolean {
  const existingWorktreeTasks = [...map.values()].filter(t => t.writeMode === 'worktree');
  if (existingWorktreeTasks.length === 0) return false;
  for (const entry of existingWorktreeTasks) {
    entry.concurrentWorktreeTaint = true;
  }
  return true;
}

/**
 * [issue #434] A native parallel task carries branch-race write-intent if it
 * will `git checkout -b` + commit in the SHARED process.cwd(): either an
 * explicit `write_mode: 'sequential'`, or an implementer (by the load-bearing
 * `-implementer` suffix, invariant #10) with no explicit write_mode. Two+ such
 * tasks dispatched concurrently clobber the shared `.git/HEAD`.
 * `worktree` (own .git) and `scoped` (no agent git) are safe and excluded.
 * Read-only reviewers omit write_mode and don't end in `-implementer`, so they
 * return false — parallel review/consensus dispatch is unaffected.
 */
export function isParallelHeadRaceWriteIntent(
  t: { agent_id: string; write_mode?: string },
): boolean {
  return (
    t.write_mode === 'sequential' ||
    (t.write_mode === undefined && t.agent_id.endsWith('-implementer'))
  );
}

/**
 * Common helper used at all three native dispatch sites. When `promptFormat`
 * is 'elided':
 *   - writes `agentPrompt` to .gossip/dispatch-prompts/<taskId>.txt
 *   - returns {elided:true, promptPath, marker} — caller emits the marker in
 *     Item 1 and OMITS Item 2 entirely (spec §"Item 2 ABSENT under elision").
 *
 * When 'inline' (default) or undefined: returns {elided:false}, caller emits
 * the existing two-item content split. Behavior is byte-identical to the
 * pre-elision dispatch path.
 */
export function elidePromptIfRequested(
  projectRoot: string,
  taskId: string,
  agentPrompt: string,
  promptFormat: PromptFormat | undefined,
  warmCached: boolean = false,
  // string instead of union: parallel/consensus pass through def.write_mode
  // which is typed as `string` upstream. The actual gate is `=== 'worktree'`
  // so any other value is treated as "no header" — fail-safe.
  writeMode?: string,
): { elided: true; promptPath: string; marker: string; bytes: number } | { elided: false } {
  if (promptFormat !== 'elided') return { elided: false };
  // Spec 2026-05-22 worktree-isolation-prompt-hardening Change 3: when the
  // dispatch is in worktree mode, prepend a structural header to the on-disk
  // prompt body. The header survives even if the orchestrator paraphrases the
  // Item 1 banner, anchoring the isolation contract in the prompt file itself.
  const body = writeMode === 'worktree'
    ? `// GOSSIP_ISOLATION: worktree\n` +
      `// This task was dispatched with write_mode: "worktree".\n` +
      `// The orchestrator MUST invoke Agent() with isolation: "worktree".\n` +
      `// Do not paraphrase this requirement.\n\n` +
      agentPrompt
    : agentPrompt;
  const bytes = Buffer.byteLength(body, 'utf8');
  const promptPath = writeDispatchPrompt(projectRoot, taskId, body);
  const warmSuffix = warmCached ? ' — warm-cached (skills) + live task' : '';
  const marker = `[skills section elided: see ${promptPath}, ${bytes} bytes${warmSuffix} — READ this file and pass its CONTENTS verbatim as the Agent(prompt: ...) value. Do NOT pass the path string.]`;
  return { elided: true, promptPath, marker, bytes };
}

/**
 * Phase-2 warm-cache lookup. Returns the spliced un-annotated body on hit
 * (skills-section from cache + live Task: tail), or null on miss. The caller
 * applies annotations on top (scope/unverified) and then runs the usual
 * elidePromptIfRequested writer — so the on-disk per-dispatch file matches
 * the cold-path file byte-for-byte except for the cached skills prefix.
 *
 * IRON RULE #6 (CRITICAL): the cache stores the skills-section ONLY. The live
 * `Task:` block from the current dispatch is spliced in at hit time.
 * Caching the full body with a stale Task corrupts the RL feedback loop —
 * see consensus 335e8be5-336648b5:f11.
 */
export function tryWarmCacheHit(
  liveTaskBlock: string,
  cacheKey: PromptCacheKey,
  promptFormat: PromptFormat | undefined,
): string | null {
  if (promptFormat !== 'elided') return null;
  if (!liveTaskBlock) return null;
  const cached = getCachedPrompt(cacheKey);
  if (!cached) return null;
  if (cached.skillFingerprint !== cacheKey.skillFingerprint) return null;
  if (!existsSync(cached.skillsSectionPath)) return null;
  try {
    const skillsSection = require('fs').readFileSync(cached.skillsSectionPath, 'utf8');
    return skillsSection + liveTaskBlock;
  } catch {
    return null;
  }
}

/**
 * Phase-2 cache cold-path store. Call after assemblePrompt on a miss. Splits
 * the assembled body at the LAST `\n\nTask:` boundary, persists the prefix to
 * a content-addressed skills-section file, and inserts a cache entry keyed by
 * the supplied PromptCacheKey. No-op if liveTaskBlock could not be extracted
 * (assembler invariant violated — skip caching defensively).
 */
export function cacheColdPathStore(
  projectRoot: string,
  assembledBody: string,
  cacheKey: PromptCacheKey,
): void {
  const { skillsSection, taskBlock } = splitAssembledPrompt(assembledBody);
  if (!taskBlock) return; // boundary missing — refuse to cache.
  try {
    const skillsSectionPath = writeCachedSkillsSection(projectRoot, cacheKey.skillFingerprint, skillsSection);
    setCachedPrompt(cacheKey, {
      skillsSectionPath,
      skillsSectionBytes: Buffer.byteLength(skillsSection, 'utf8'),
      createdAtMs: Date.now(),
      skillFingerprint: cacheKey.skillFingerprint,
    });
  } catch (err) {
    process.stderr.write(`[gossipcat] dispatch-prompt-cache cold-store failed: ${(err as Error).message}\n`);
  }
}
import { persistRelayTasks } from './relay-tasks';
import {
  prependScopeNote,
  prependUnverifiedNote,
  maybeAnnotateUnverifiedClaims,
  recordDispatchMetadata,
  relativizeProjectPaths,
  readSandboxMode,
  rotateIfNeeded,
  shouldSanitize,
  MAX_PREMISE_VERIFICATION_BYTES,
} from '../sandbox';

/**
 * Apply the premise-verification annotation to a native dispatch prompt.
 * Pure regex check at the MCP boundary — no sub-agent dispatch (load-bearing
 * per spec §"Invariants preserved"). Spec §"Component B".
 */
function maybeApplyUnverifiedNote(
  agentPrompt: string,
  task: string,
  agentId: string,
): string {
  const annotation = maybeAnnotateUnverifiedClaims(task);
  if (!annotation.annotated) return agentPrompt;
  process.stderr.write(
    `[gossipcat] ⚠️ unverified-claim detected for ${agentId}: matched "${annotation.matchedText}" (pattern #${annotation.matchedPattern})\n`,
  );
  return prependUnverifiedNote(agentPrompt, annotation.reason || annotation.matchedText || '');
}

// ──────────────────────────────────────────────────────────────────────────
// Stage 2 premise-verification — structured claim-block wire-up.
//
// Spec: docs/specs/2026-04-22-premise-verification-stage-2.md
//   §"Verifier" (invariants), §"Wire-up" (flow), §"Rotation" (jsonl),
//   §"Signal integration" (signal emission on falsified).
//
// Flow per native dispatch:
//   1. Extract fenced ```premise-claims block from task body — skip if absent.
//   2. parseClaimBlock(rawJson) — fail-soft; bad JSON → schema-lint prefix only.
//   3. verifyClaims(block, projectRoot) — in-process rg, 500ms wallclock cap,
//      no sub-agent dispatch (load-bearing invariant).
//   4. Falsified verdicts → ⚠ PREMISE-MISMATCH prefix on task.
//   5. Log JSONL row to .gossip/premise-verification.jsonl with single-slot
//      rotation at MAX_PREMISE_VERIFICATION_BYTES (mirrors boundary-escapes).
//   6. Each falsified claim → one hallucination_caught:premise_mismatch signal
//      carrying the claim's modality for the Stage 2 scaled multiplier.
//
// Warn-not-block: dispatch always proceeds regardless of outcome.
// Relay-path: skipped — mirrors Stage 1; deferred to Stage 2a per spec
// §Open questions #2.
// ──────────────────────────────────────────────────────────────────────────

const PREMISE_CLAIMS_FENCE_RE = /```premise-claims\s*\n([\s\S]*?)\n```/;
const PREMISE_VERIFICATION_LOG = '.gossip/premise-verification.jsonl';

function extractPremiseClaimsBlock(task: string): string | null {
  if (!task) return null;
  const m = PREMISE_CLAIMS_FENCE_RE.exec(task);
  return m ? m[1] : null;
}

interface PremiseVerificationResult {
  /** Task body with ⚠ PREMISE-MISMATCH / schema-lint prefix applied (if any). */
  annotatedTask: string;
  /** Per-falsified-claim signals ready for emitConsensusSignals. */
  signals: PerformanceSignal[];
  /** Whether verification actually ran (a claim block existed + parsed). */
  ran: boolean;
  /** Aggregate counts for the JSONL log row. */
  counts: {
    claims_total: number;
    claims_verified: number;
    claims_falsified: number;
    claims_unverifiable: number;
    timeout_fraction: number;
  };
}

function summarizeVerdicts(verdicts: ClaimVerdict[]): PremiseVerificationResult['counts'] {
  let verified = 0;
  let falsified = 0;
  let unverifiable = 0;
  let timeouts = 0;
  for (const v of verdicts) {
    if (v.status === 'verified') verified++;
    else if (v.status === 'falsified') falsified++;
    else {
      unverifiable++;
      if (v.reason === 'timeout') timeouts++;
    }
  }
  return {
    claims_total: verdicts.length,
    claims_verified: verified,
    claims_falsified: falsified,
    claims_unverifiable: unverifiable,
    timeout_fraction: verdicts.length > 0 ? timeouts / verdicts.length : 0,
  };
}

function formatFalsifiedNote(
  block: ClaimBlock,
  verdicts: ClaimVerdict[],
): string {
  const lines: string[] = ['⚠ PREMISE-MISMATCH — one or more structured claims were falsified by grep:'];
  for (const v of verdicts) {
    if (v.status !== 'falsified') continue;
    const claim = block.claims[v.claim_index];
    const type = claim?.type ?? 'unknown';
    lines.push(
      `  • claim[${v.claim_index}] (${type}): expected ${JSON.stringify(v.expected)}, observed ${JSON.stringify(v.observed)} [modality=${v.modality}]`,
    );
  }
  lines.push('');
  lines.push('Re-verify the cited code before writing any patch. See spec §"Signal integration" — a hallucination_caught:premise_mismatch signal has been recorded.');
  return lines.join('\n');
}

function writePremiseVerificationLog(
  projectRoot: string,
  taskId: string,
  result: PremiseVerificationResult,
  opts: { had_stage1_annotation: boolean; skill_bound: string | null; schema_lint?: string },
): void {
  try {
    const logPath = join(projectRoot, PREMISE_VERIFICATION_LOG);
    // Rotation BEFORE append (same precedent as boundary-escapes.jsonl, PR #135).
    rotateIfNeeded(logPath, MAX_PREMISE_VERIFICATION_BYTES);
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    const row: Record<string, unknown> = {
      ts: new Date().toISOString(),
      consensus_id: null,
      task_id: taskId,
      claims_total: result.counts.claims_total,
      claims_verified: result.counts.claims_verified,
      claims_falsified: result.counts.claims_falsified,
      claims_unverifiable: result.counts.claims_unverifiable,
      timeout_fraction: result.counts.timeout_fraction,
      had_stage1_annotation: opts.had_stage1_annotation,
      skill_bound: opts.skill_bound,
    };
    if (opts.schema_lint) row.schema_lint = opts.schema_lint;
    appendFileSync(logPath, JSON.stringify(row) + '\n');
  } catch {
    /* best-effort; dispatch must never fail on logging */
  }
}

/**
 * Parse + verify any ```premise-claims block in a native dispatch task.
 *
 * Safe to call on any task string — returns a no-op result when no block is
 * present. Never throws; dispatch must never fail on verification.
 *
 * Caller is responsible for:
 *   - Gating on native-path only (skip for relay dispatches — spec §Wire-up #6).
 *   - Passing `annotatedTask` into `assemblePrompt` (not the raw task).
 *   - Calling `emitConsensusSignals(projectRoot, signals)` once per dispatch.
 *   - Calling `writePremiseVerificationLog(...)` for the JSONL row.
 */
async function maybeVerifyPremiseClaims(
  task: string,
  projectRoot: string,
  taskId: string,
  agentId: string,
): Promise<PremiseVerificationResult> {
  const empty: PremiseVerificationResult = {
    annotatedTask: task,
    signals: [],
    ran: false,
    counts: {
      claims_total: 0,
      claims_verified: 0,
      claims_falsified: 0,
      claims_unverifiable: 0,
      timeout_fraction: 0,
    },
  };
  const rawJson = extractPremiseClaimsBlock(task);
  if (!rawJson) return empty;

  const { block, errors } = parseClaimBlock(rawJson);
  if (!block) {
    // Malformed JSON / shape — prepend schema-lint warning, prose path runs.
    process.stderr.write(
      `[gossipcat] ⚠ premise-claims schema violation for ${agentId}: ${errors.map(e => sanitizeForLog(e.message)).slice(0, 3).join('; ')}\n`,
    );
    const note =
      '⚠ premise-claims block failed schema validation — treating task as prose-only. ' +
      `Errors: ${errors.map(e => sanitizeForLog(e.message)).slice(0, 3).join('; ')}`;
    writePremiseVerificationLog(projectRoot, taskId, empty, {
      had_stage1_annotation: maybeAnnotateUnverifiedClaims(task).annotated,
      skill_bound: null,
      schema_lint: 'parse_failed',
    });
    return {
      ...empty,
      annotatedTask: `${note}\n\n${task}`,
    };
  }

  let verdicts: ClaimVerdict[] = [];
  try {
    verdicts = await verifyClaims(block, projectRoot);
  } catch (err) {
    process.stderr.write(
      `[gossipcat] ⚠ verifyClaims threw for ${agentId}: ${sanitizeForLog((err as Error).message ?? String(err))}\n`,
    );
    return empty;
  }

  const counts = summarizeVerdicts(verdicts);
  const falsified = verdicts.filter(v => v.status === 'falsified') as Extract<
    ClaimVerdict,
    { status: 'falsified' }
  >[];

  // Build hallucination_caught signals — one per falsified claim.
  const signals: PerformanceSignal[] = falsified.map(v => ({
    type: 'consensus',
    taskId,
    signal: 'hallucination_caught',
    agentId,
    outcome: 'premise_mismatch',
    modality: v.modality,
    evidence: `premise-claim[${v.claim_index}] falsified: expected ${JSON.stringify(
      v.expected,
    )}, observed ${JSON.stringify(v.observed)}`,
    timestamp: new Date().toISOString(),
  }));

  const annotatedTask = falsified.length > 0
    ? `${formatFalsifiedNote(block, verdicts)}\n\n${task}`
    : task;

  const result: PremiseVerificationResult = {
    annotatedTask,
    signals,
    ran: true,
    counts,
  };

  // Record schema-lint warnings from the parser (e.g. missing_modality) so
  // retrospective audit can see silent downgrades. Errors is additive — a
  // non-null block may still carry per-claim errors.
  const schemaLint = errors.length > 0 ? sanitizeForLog(errors[0].message) : undefined;
  writePremiseVerificationLog(projectRoot, taskId, result, {
    had_stage1_annotation: maybeAnnotateUnverifiedClaims(task).annotated,
    skill_bound: null,
    schema_lint: schemaLint,
  });

  return result;
}

function agentPreset(agentId: string): string | undefined {
  try {
    return ctx.mainAgent.getAgentList?.().find((a: any) => a.id === agentId)?.preset;
  } catch {
    return undefined;
  }
}

/** Sanitize a task string and return the rewritten text. Honors sandboxEnforcement=off. */
function maybeSanitizeTask(
  task: string,
  writeMode: 'sequential' | 'scoped' | 'worktree' | undefined,
  agentId: string,
): { task: string; sanitized: boolean; replacements: number } {
  const projectRoot = process.cwd();
  const mode = readSandboxMode(projectRoot);
  if (mode === 'off') return { task, sanitized: false, replacements: 0 };
  if (!shouldSanitize(writeMode, agentPreset(agentId))) {
    return { task, sanitized: false, replacements: 0 };
  }
  const { sanitized, replacements } = relativizeProjectPaths(task, projectRoot);
  if (replacements > 0) {
    process.stderr.write(
      `[gossipcat] 🧹 sanitized ${replacements} project path(s) in task for ${agentId}\n`,
    );
  }
  return { task: sanitized, sanitized: true, replacements };
}

// Quota-based fallback routing for relay agents
const QUOTA_FALLBACK_MAP: Record<string, string> = {
  'gemini-reviewer':    'sonnet-reviewer',
  'gemini-tester':      'haiku-researcher',
  'gemini-implementer': 'sonnet-implementer',
};

// Provider lookup: derives provider name from agent ID prefix (e.g. "gemini-*" → "google")
const AGENT_PROVIDER_MAP: Record<string, string> = {
  gemini: 'google',
};

function readQuotaState(): Record<string, { exhaustedUntil?: number }> {
  try {
    const raw = readFileSync(join(process.cwd(), '.gossip', 'quota-state.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isProviderExhausted(provider: string, quotaState: Record<string, { exhaustedUntil?: number }>): boolean {
  const entry = quotaState[provider];
  return !!(entry?.exhaustedUntil && entry.exhaustedUntil > Date.now());
}

function reroutableAgent(agentId: string): string {
  const fallback = QUOTA_FALLBACK_MAP[agentId];
  if (!fallback) return agentId;

  // Determine provider from agent ID prefix
  const prefix = agentId.split('-')[0];
  const provider = AGENT_PROVIDER_MAP[prefix];
  if (!provider) return agentId;

  const quotaState = readQuotaState();
  if (isProviderExhausted(provider, quotaState)) {
    process.stderr.write(`[gossipcat] ⚠️  quota fallback: ${agentId} → ${fallback}\n`);
    return fallback;
  }
  return agentId;
}

/**
 * Finding #6 (relay-image consensus round): a NATIVE agent dispatch cannot
 * deliver images — gossipcat has no native multimodal wiring; native subagents
 * run through the host Agent() tool, which this handler cannot feed pixels.
 * Callers surface this exact notice in the dispatch response instead of dropping
 * the `images` field silently, so the operator knows the pixels never landed.
 */
function nativeImageDropNotice(agentId: string, count: number): string {
  return `images are relay-only; native agent ${agentId} did not receive ${count} image(s)`;
}

export async function handleDispatchSingle(
  agent_id: string, task: string,
  write_mode?: 'sequential' | 'scoped' | 'worktree',
  scope?: string, timeout_ms?: number,
  plan_id?: string, step?: number,
  /**
   * Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md (Path 1).
   * Validated worktree paths to scope relay-agent tool calls. Forwarded to
   * dispatch-pipeline only when the resolved agent is a relay agent —
   * native agents have a separate flow above (out-of-process Agent tool).
   */
  resolutionRoots?: readonly string[],
  /**
   * Spec docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md.
   * Strict opt-in. When 'elided', the AGENT_PROMPT content item is omitted
   * and the prompt body is written to .gossip/dispatch-prompts/<taskId>.txt;
   * Item 1 instructs the orchestrator to Read the file and forward verbatim.
   * Default 'inline' preserves byte-for-byte the pre-PR behavior.
   */
  prompt_format?: PromptFormat,
  /**
   * Spec §3.2 boundary #1: dispatch-time fail-loud warnings. Stashed under the
   * minted task_id so a later gossip_collect on this single task drains them.
   * A solo dispatch rarely feeds a consensus round, so the operator-facing
   * visibility for single comes from the dispatch-response warning block; the
   * stash is best-effort for the collect path.
   */
  dispatchWarnings?: readonly RoundWarning[],
  /**
   * Local absolute image file paths (PNG/JPEG) to attach to the dispatch for
   * vision-capable relay providers. Forwarded to dispatch-pipeline via
   * DispatchOptions.images; the worker reads + base64-encodes + guards them
   * (max 4, ≤4 MB each, magic-byte sniff). When omitted, the worker
   * auto-detects up to 4 absolute PNG/JPEG paths from the task text.
   *
   * The NATIVE (Agent-tool) dispatch path does NOT deliver images — there is no
   * native multimodal wiring in gossipcat; native subagents run through the host
   * Agent() tool, which this handler cannot feed pixels. Rather than drop the
   * field silently, the native branches emit an explicit "images are relay-only"
   * notice in the dispatch response (see nativeImageDropNotice).
   */
  images?: readonly string[],
) {
  await ctx.boot();
  await ctx.syncWorkersViaKeychain();

  if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
    return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${agent_id}"` }] };
  }

  // Quota fallback: reroute exhausted relay agents to native equivalents
  agent_id = reroutableAgent(agent_id);

  // Sandbox mitigation 1: sanitize project paths in the task prompt
  const sanitizeResult = maybeSanitizeTask(task, write_mode, agent_id);
  task = sanitizeResult.task;

  const options: Record<string, unknown> = {};
  if (write_mode) {
    options.writeMode = write_mode as 'sequential' | 'scoped' | 'worktree';
    if (scope) options.scope = scope;
    if (timeout_ms) options.timeoutMs = timeout_ms;
  }
  if (plan_id) {
    if (!step) {
      return { content: [{ type: 'text' as const, text: 'plan_id requires step (1-indexed step number in the plan).' }] };
    }
    options.planId = plan_id;
    options.step = step;
  }
  // Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md — forward
  // validated resolutionRoots into dispatch-pipeline so relay agents get
  // toolServer.assignRoot before executeTask iteration. Ignored by native
  // dispatch path above (native agents don't go through pipeline.dispatch).
  if (resolutionRoots && resolutionRoots.length > 0) {
    options.resolutionRoots = resolutionRoots;
  }
  // Image attachments for vision-capable relay providers. Threaded via
  // DispatchOptions.images; the relay worker reads + guards them. Ignored by the
  // native dispatch branch below (native agents don't go through pipeline.dispatch).
  if (images && images.length > 0) {
    options.images = [...images];
  }
  const dispatchOptions = Object.keys(options).length > 0 ? options : undefined;

  // Native agent bridge: return Agent tool instructions instead of relay dispatch
  const nativeConfig = ctx.nativeAgentConfigs.get(agent_id);
  if (nativeConfig) {
    // Scope validation for native single dispatch (same as relay path in dispatch-pipeline.ts)
    if (write_mode === 'scoped') {
      if (!scope) {
        return { content: [{ type: 'text' as const, text: 'Error: scoped write mode requires a scope path' }] };
      }
      const overlap = ctx.mainAgent.scopeTracker.hasOverlap(scope);
      if (overlap.overlaps) {
        return { content: [{ type: 'text' as const, text: `Error: Scope "${scope}" conflicts with running task ${overlap.conflictTaskId} at "${overlap.conflictScope}"` }] };
      }
    }

    evictStaleNativeTasks();
    const taskId = randomUUID().slice(0, 8);
    const relayToken = randomUUID().slice(0, 12);
    const timeoutMs = timeout_ms ?? NATIVE_TASK_TTL_MS;
    // Spec §3.2 boundary #1: stash dispatch-time warnings under this task_id.
    stashDispatchWarnings([taskId], dispatchWarnings);

    // Unit 2 orchestrator signal pipeline: pre-dispatch precondition guard.
    // Best-effort — never blocks/fails a dispatch. Emits operational pipeline
    // signals (dispatched_stale_base, referenced_unreadable_path) against
    // agentId:'orchestrator' and surfaces human-readable warnings to stderr.
    runDispatchPreconditionGuard({
      projectRoot: process.cwd(),
      taskId,
      resolutionRoots,
      taskText: task,
      writeMode: write_mode,
    }).then(({ warnings: precondWarnings }) => {
      for (const w of precondWarnings) {
        process.stderr.write(`[gossipcat] ⚠️ precondition: ${w}\n`);
      }
    }).catch(() => { /* best-effort */ });

    // Stage 2 premise-verification — parse + verify any ```premise-claims
    // block in the task. Runs BEFORE assemblePrompt so the PREMISE-MISMATCH
    // prefix travels inline with the task payload, yielding final ordering
    // SCOPE > UNVERIFIED > PREMISE-MISMATCH (Stage 1 UNVERIFIED sentinel is
    // prepended later by maybeApplyUnverifiedNote). Warn-not-block: dispatch
    // always proceeds.
    const premiseResult = await maybeVerifyPremiseClaims(task, process.cwd(), taskId, agent_id);
    task = premiseResult.annotatedTask;
    if (premiseResult.signals.length > 0) {
      emitConsensusSignals(process.cwd(), premiseResult.signals);
    }

    // Ref-allowlist Phase 1: snapshot origin/master before agent runs so the
    // relay path can detect a direct push to master (no PR-merge entry).
    // Runs for ALL write-mode dispatches; null on git failure (offline/no remote).
    let preDispatchSha: string | null = null;
    if (write_mode) {
      const { capturePreDispatchSha } = require('./ref-allowlist-detection');
      preDispatchSha = capturePreDispatchSha();
    }

    // Option B isolation-failure detector — snapshot parent-checkout state for
    // worktree-mode native dispatches so handleNativeRelay can detect writes
    // that leaked outside the Agent(isolation:"worktree") sandbox.
    // Spec: docs/specs/2026-05-20-native-worktree-isolation-fix.md
    let isolationSnapshot: { head: string | null; dirty: string[]; takenAt: string } | undefined;
    if (write_mode === 'worktree') {
      try {
        const { captureIsolationSnapshot } = require('./worktree-isolation-detection');
        isolationSnapshot = captureIsolationSnapshot(process.cwd());
      } catch { /* best-effort — snapshot failure must not block dispatch */ }
    }

    const concurrentWorktreeTaint = write_mode === 'worktree'
      ? stampConcurrencyTaint(ctx.nativeTaskMap) || undefined
      : undefined;
    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs, planId: plan_id, step, writeMode: write_mode, relayToken, preDispatchSha, isolationSnapshot, concurrentWorktreeTaint });
    // Entry created AFTER stashDispatchWarnings([taskId]) above — mark it now so
    // the persisted breadcrumb survives a reconnect (spec §3.2 / f11 follow-up).
    markDispatchWarningsStashedIfNeeded(taskId);
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    // promptPath is filled in below after elision (if requested).
    process.stderr.write(`[gossipcat] → dispatch → ${agent_id} (${nativeConfig.model}) [${taskId}]\n`);

    // Register scope so subsequent dispatches see it
    if (write_mode === 'scoped' && scope) {
      ctx.mainAgent.scopeTracker.register(scope, taskId);
    }

    // Fix: register in TaskGraph so native tasks are visible to CLI/sync
    try { ctx.mainAgent.recordNativeTask(taskId, agent_id, task); } catch { /* best-effort */ }

    // Inject chain context from prior plan steps (same as relay agents get)
    let chainContext = '';
    if (plan_id && step && step > 1) {
      chainContext = ctx.mainAgent.getChainContext(plan_id, step);
    }

    let singleSkillIndex: ReturnType<typeof ctx.mainAgent.getSkillIndex> | undefined;
    try { singleSkillIndex = ctx.mainAgent.getSkillIndex() ?? undefined; } catch { /* best-effort */ }
    const skillResult = loadSkills(
      agent_id,
      nativeConfig.skills,
      process.cwd(),
      singleSkillIndex,
      task,
    );

    // Phase 2 warm-cache: compute fingerprint from realpath'd skill paths.
    // Cache key disambiguates by taskKind so consensus / parallel / single
    // never collide. IRON RULE #6: cache holds SKILLS-SECTION only — the live
    // Task: tail is built fresh and spliced.
    const singleCacheKey: PromptCacheKey = {
      agentId: agent_id,
      skillFingerprint: computeSkillFingerprint(skillResult.paths || []),
      taskKind: 'single' as TaskKind,
    };
    // splitAssembledPrompt cuts at "\n\nTask:" (the structural anchor), so the
    // cached skillsSection already ends with the "\n\n---" separator that
    // precedes Task: in assemblePrompt's output. liveTaskTail must NOT
    // re-include "\n\n---\n\n" or the warm body grows a duplicate separator
    // per dispatch (caught by dispatch-prompt-cache.test.ts splice integrity).
    const singleLiveTaskTail = `\n\nTask: ${task}`;

    let agentPrompt: string;
    let singleWarm = false;
    const singleWarmBody = tryWarmCacheHit(singleLiveTaskTail, singleCacheKey, prompt_format);
    if (singleWarmBody) {
      agentPrompt = singleWarmBody;
      singleWarm = true;
    } else {
      // Cold path — full assemblePrompt as Phase 1.
      agentPrompt = assemblePrompt({
        identity: buildNativeIdentity(agent_id, nativeConfig.model),
        instructions: nativeConfig.instructions || undefined,
        skills: skillResult.content || undefined,
        chainContext: chainContext || undefined,
        task,
      });
      // Store the pre-annotation assembled body in the cache. Annotations
      // (scope/unverified) are head-prepended and task-dependent, so caching
      // them risks leaking T1's notes to T2 on warm hit. Cache the assembler
      // output; re-apply annotations per dispatch.
      if (prompt_format === 'elided') {
        cacheColdPathStore(process.cwd(), agentPrompt, singleCacheKey);
      }
    }
    if (sanitizeResult.sanitized) agentPrompt = prependScopeNote(agentPrompt);
    // Premise verification (Component B). SCOPE NOTE composes first
    // (enforcement boundary); UNVERIFIED note layered on top (behavioral).
    agentPrompt = maybeApplyUnverifiedNote(agentPrompt, task, agent_id);

    // Only use worktree if explicitly requested AND project is a git repo
    let useWorktree = write_mode === 'worktree';
    let gitDowngradeReason: string | undefined;
    if (useWorktree && !isGitRepo(process.cwd())) {
      useWorktree = false;
      gitDowngradeReason = 'not a git repository — worktree isolation unavailable';
    }

    // When we downgraded, record the effective mode back onto the nativeTaskMap
    // entry (set above at L633, before this point) so the relay-receipt isolation
    // checker can avoid false-positive alerts.
    if (!useWorktree && write_mode === 'worktree') {
      const info = ctx.nativeTaskMap.get(taskId);
      if (info) info.effectiveWriteMode = 'sequential';
    }

    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: agent_id,
      writeMode: write_mode,
      effectiveWriteMode: useWorktree ? 'worktree' : (write_mode === 'worktree' ? 'sequential' : write_mode as any),
      scope,
      worktreePath: undefined,
      timestamp: Date.now(),
    });

    // Spec §1 iron rule: strict opt-in elision. When prompt_format='elided',
    // write the prompt body to disk and emit a marker in Item 1; OMIT Item 2.
    // When undefined/'inline': behavior is byte-identical to pre-PR dispatch.
    // Pre-merge consensus 2026-05-22: pass EFFECTIVE worktree mode (post
    // git-repo downgrade at L685-692), not raw write_mode. Otherwise a non-git
    // dispatch with write_mode='worktree' produces a contradictory packet:
    // on-disk header demands isolation while the banner+Agent() call omit it.
    const elision = elidePromptIfRequested(
      process.cwd(), taskId, agentPrompt, prompt_format, singleWarm,
      useWorktree ? 'worktree' : undefined,
    );
    if (elision.elided) {
      const info = ctx.nativeTaskMap.get(taskId);
      if (info) info.promptPath = elision.promptPath;
    }
    // Persist after elision so promptPath is durable across /mcp reconnect.
    persistNativeTaskMap();

    const host = detectNativeHost();
    const promptRef = elision.elided ? '<file contents>' : `<AGENT_PROMPT:${taskId} below>`;
    const agentCall = formatNativeAgentCall({
      agentId: agent_id,
      model: nativeConfig.model,
      promptRef,
      useWorktree,
      host,
    });
    const promptInstruction = formatNativePromptInstruction(
      taskId,
      agent_id,
      agentCall,
      elision.elided,
      elision.elided ? elision.marker : undefined,
      host,
    );

    // Split into two content items so relay_token stays in orchestrator-only text
    // and AGENT_PROMPT is passed verbatim to the host native tool.
    // Tag format matches parallel/consensus: `AGENT_PROMPT:<taskId> (<agentId>)`.
    // Finding #6: native path can't deliver images — surface an explicit notice
    // rather than silently dropping the `images` field.
    const nativeImgNotice = (images && images.length > 0)
      ? `\n\n⚠️ ${nativeImageDropNotice(agent_id, images.length)}`
      : '';
    return { content: [
      { type: 'text' as const, text: buildNativeDispatchSingleResponse({
        taskId,
        agentId: agent_id,
        model: nativeConfig.model,
        relayToken,
        agentCall,
        promptInstruction,
        useWorktree,
        gitDowngradeReason,
        host,
      }) + nativeImgNotice },
      // Item 2 ABSENT under elision (spec §2 iron rule — no placeholder, no
      // skeleton). Orchestrator MUST Read elision.promptPath cited in Item 1.
      ...(elision.elided ? [] : [{ type: 'text' as const, text: `AGENT_PROMPT:${taskId} (${agent_id})\n${agentPrompt}` }]),
    ] };
  }

  try {
    const { taskId, finalResultPromise } = ctx.mainAgent.dispatch(agent_id, task, dispatchOptions as any);
    // #522 SEV-1: a worker provider error (e.g. OpenAI 401) rejects this
    // background promise. Without a catch it becomes an unhandledRejection and
    // crash-loops the MCP server. Swallow it here — task errors still surface to
    // the caller via gossip_collect / gossip_progress (the parallel/consensus
    // path already does the same at dispatch-pipeline.ts ~747).
    finalResultPromise?.catch(() => {});
    // For relay worktree dispatch the path is filled in by the async
    // runTask() inside dispatch-pipeline after WorktreeManager.create().
    // Record undefined here; the callback side (gossip_run completion or
    // collect path) updates the metadata via updateDispatchMetadata once
    // getTask exposes `worktreeInfo.path`.
    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: agent_id,
      writeMode: write_mode,
      scope,
      worktreePath: undefined,
      timestamp: Date.now(),
    });
    persistRelayTasks(); // Survive MCP reconnects
    const modeLabel = write_mode ? ` [${write_mode}${scope ? `:${scope}` : ''}]` : '';
    return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}${modeLabel}. Task ID: ${taskId}` }] };
  } catch (err: any) {
    process.stderr.write(`[gossipcat] ❌ dispatch failed: ${err.message}\n`);
    return { content: [{ type: 'text' as const, text: err.message }] };
  }
}

/**
 * Issue #392: shared dispatch-time worktree auto-discovery helper.
 * Used by both handleDispatchConsensus and handleDispatchParallel(consensus:true).
 *
 * Layer 1 — when caller passed no resolutionRoots and
 * `consensus.autoDiscoverWorktrees=true`, run discoverGitWorktrees and emit a
 * hashed-paths warning so operators know which worktrees exist. Auto-promotion
 * to effectiveRoots is DISABLED per consensus c6b8580d-595e48d2 + issue #402:
 * promoting discovered worktrees blindly routed cross-reviewers to the wrong
 * branch. Operators must pass explicit resolutionRoots to gossip_dispatch.
 * Explicit caller-passed roots ALWAYS win — when dispatchResolutionRoots is
 * non-empty this function returns it unchanged without running discovery.
 *
 * Layer 2 — when the flag is OFF but worktrees exist on disk and
 * resolutionRoots is empty, push a non-fatal warning into the returned
 * warnings array so fresh installs discover the flag.
 *
 * Discovery failure is isolated: the try/catch logs to stderr and returns
 * the caller's original (empty) roots so dispatch proceeds via the existing
 * master-HEAD fallback path.
 */
async function resolveDispatchResolutionRoots(
  dispatchResolutionRoots: readonly string[] | undefined,
): Promise<{ effectiveRoots: readonly string[] | undefined; warnings: string[] }> {
  // Explicit-roots-win: skip discovery entirely when caller passed roots.
  if (dispatchResolutionRoots && dispatchResolutionRoots.length > 0) {
    return { effectiveRoots: dispatchResolutionRoots, warnings: [] };
  }
  let effectiveRoots: readonly string[] | undefined = dispatchResolutionRoots;
  const warnings: string[] = [];
  try {
    const { discoverGitWorktrees } = await import('@gossip/orchestrator');
    const { findConfigPath, loadConfig } = await import('../config');
    const cfgPath = findConfigPath(process.cwd());
    const cfg = cfgPath ? loadConfig(cfgPath) : null;
    if (cfg?.consensus?.autoDiscoverWorktrees) {
      // F1 — exclude process.cwd() so the main worktree (which `git worktree
      // list` always returns) does not leak into effectiveRoots.
      const { discovered, rejected } = await discoverGitWorktrees(process.cwd(), [process.cwd()]);
      if (discovered.length > 0 || rejected.length > 0) {
        process.stderr.write(
          `[dispatch] auto-discovery: +${discovered.length} discovered, ${rejected.length} rejected\n`,
        );
      }
      if (discovered.length > 0) {
        // Per consensus c6b8580d-595e48d2 + issue #402: auto-promotion was the
        // bug. autoDiscoverWorktrees is discovery+warning only. Operators must
        // pass explicit resolutionRoots to route cross-reviewers.
        const hashedPaths = discovered.map(d => hashPath(d));
        warnings.push(
          `autoDiscoverWorktrees: ${discovered.length} sibling worktree(s) discovered ` +
          `but auto-promotion is disabled. Pass resolutionRoots to gossip_dispatch ` +
          `to pin cross-reviewers to a specific worktree. Discovered (hashed): ${hashedPaths.join(', ')}`,
        );
      } else if (rejected.length > 0) {
        // F4 — surface "all candidates rejected" through the operator-visible
        // warnings channel instead of stderr-only.
        warnings.push(
          `autoDiscoverWorktrees: ${rejected.length} candidate(s) failed validation; cross-review will use projectRoot only. See stderr for rejection reasons.`,
        );
      }
    } else {
      // Layer 2 soft-warning probe — silent unless worktrees actually exist.
      const { discovered } = await discoverGitWorktrees(process.cwd(), [process.cwd()]);
      if (discovered.length > 0) {
        warnings.push(
          `consensus.autoDiscoverWorktrees is OFF but ${discovered.length} worktree(s) exist; cross-reviewers will resolve citations against project root. Enable consensus.autoDiscoverWorktrees in gossip.config or pass resolutionRoots to dispatch.`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(`[dispatch] auto-discovery failed: ${(err as Error).message ?? String(err)}\n`);
  }
  return { effectiveRoots, warnings };
}

export async function handleDispatchParallel(
  taskDefs: Array<{ agent_id: string; task: string; write_mode?: string; scope?: string; images?: string[] }>,
  consensus: boolean,
  /**
   * Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md (Path 1).
   * Forwarded to every dispatched relay task in this batch.
   */
  resolutionRoots?: readonly string[],
  /**
   * Spec docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md.
   * Applied per-native-task: when 'elided', each per-task AGENT_PROMPT item
   * is replaced by an Item-1 marker citing the on-disk path. Default 'inline'.
   */
  prompt_format?: PromptFormat,
  /**
   * Spec §3.2 boundary #1: dispatch-time fail-loud warnings (e.g. rejected
   * resolutionRoots). Stashed under every minted task_id so gossip_collect can
   * drain them into the collect-built RoundContext → report.warnings.
   */
  dispatchWarnings?: readonly RoundWarning[],
) {
  await ctx.boot();
  await ctx.syncWorkersViaKeychain();

  // Validate all agent IDs before dispatching
  for (const def of taskDefs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
      return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
    }
  }

  // Quota fallback: reroute exhausted relay agents to native equivalents
  taskDefs = taskDefs.map(def => ({ ...def, agent_id: reroutableAgent(def.agent_id) }));

  // Sandbox mitigation 1: sanitize each task's project paths
  taskDefs = taskDefs.map(def => {
    const s = maybeSanitizeTask(def.task, def.write_mode as any, def.agent_id);
    return { ...def, task: s.task, _sandboxSanitized: s.sanitized } as any;
  });

  // Issue #392: dispatch-time worktree auto-discovery for parallel+consensus mode.
  // Only runs when consensus=true — non-consensus parallel dispatch doesn't do
  // cross-review so worktree resolution is irrelevant. Mirrors the same helper
  // call in handleDispatchConsensus (extracted to resolveDispatchResolutionRoots).
  let parallelDispatchWarnings: string[] = [];
  let effectiveResolutionRoots: readonly string[] | undefined = resolutionRoots;
  if (consensus) {
    const discovered = await resolveDispatchResolutionRoots(resolutionRoots);
    effectiveResolutionRoots = discovered.effectiveRoots;
    parallelDispatchWarnings = discovered.warnings;
  }

  // [C2 fix] Split native vs custom tasks — native agents have no relay worker
  const nativeTasks: Array<{ agent_id: string; task: string; write_mode?: string; scope?: string }> = [];
  const relayTasks: Array<{ agent_id: string; task: string; write_mode?: string; scope?: string }> = [];
  for (const def of taskDefs) {
    if (ctx.nativeAgentConfigs.has(def.agent_id)) {
      nativeTasks.push(def);
    } else {
      relayTasks.push(def);
    }
  }

  // Finding #6: native agents can't receive images (no native multimodal path).
  // Surface an explicit notice per native task that carried images instead of
  // dropping the field silently.
  for (const def of taskDefs) {
    if (ctx.nativeAgentConfigs.has(def.agent_id) && def.images && def.images.length > 0) {
      parallelDispatchWarnings.push(nativeImageDropNotice(def.agent_id, def.images.length));
    }
  }

  // [issue #434 / consensus 974a1bb2-de854fb4] HARD pre-dispatch guard.
  // Two+ native write-intent tasks in mode:'parallel' run concurrently in the
  // SAME process.cwd(), so their `git checkout -b` calls clobber the shared
  // .git/HEAD and commits land on the wrong branch. A warning is useless here
  // because it ships in the same response packet as the execute-now directive,
  // so we block before any native task is emitted/spawned. worktree isolates
  // (own .git), scoped does no agent git — both safe and excluded.
  const writeIntentNative = nativeTasks.filter(isParallelHeadRaceWriteIntent);
  if (writeIntentNative.length >= 2) {
    return { content: [{ type: 'text' as const, text:
      `Error: ${writeIntentNative.length} native implementer tasks dispatched in mode:'parallel' without write_mode:'worktree'. ` +
      `They run concurrently in the same process.cwd() and share .git/HEAD, so their branch checkouts will clobber each other and commits will land on the wrong branch. ` +
      `Pass write_mode:'worktree' per task (or 'scoped' with a scope path) so each task gets an isolated working tree. ` +
      `See issue #434 and HANDBOOK invariant #13.` }] };
  }

  const lines: string[] = [];
  // Accumulates all dispatched task IDs (relay + native) for stashing
  // effectiveResolutionRoots on ctx.pendingDispatchResolutionRoots below,
  // mirroring the handleDispatchConsensus pattern at lines 1050-1055.
  const allParallelTaskIds: string[] = [];

  // Dispatch relay tasks normally
  if (relayTasks.length > 0) {
    const { taskIds, errors } = await ctx.mainAgent.dispatchParallel(
      relayTasks.map((d: any) => {
        // Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md — merge
        // resolutionRoots into per-task options. write_mode-only tasks get a
        // fresh options object; tasks with neither still get options if roots
        // are present.
        const opts: Record<string, unknown> = {};
        if (d.write_mode) {
          opts.writeMode = d.write_mode;
          if (d.scope) opts.scope = d.scope;
        }
        if (effectiveResolutionRoots && effectiveResolutionRoots.length > 0) {
          opts.resolutionRoots = effectiveResolutionRoots;
        }
        // Per-task image attachments for vision-capable relay providers.
        if (d.images && d.images.length > 0) {
          opts.images = [...d.images];
        }
        return {
          agentId: d.agent_id,
          task: d.task,
          options: Object.keys(opts).length > 0 ? opts : undefined,
        };
      }),
      consensus ? { consensus: true } : undefined,
    );
    persistRelayTasks(); // Survive MCP reconnects
    for (let i = 0; i < taskIds.length; i++) {
      const tid = taskIds[i];
      const def = relayTasks[i];
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
      allParallelTaskIds.push(tid);
      if (def) {
        // Relay worktree path is async (created during pipeline runTask());
        // record undefined here and fill via updateDispatchMetadata later.
        recordDispatchMetadata(process.cwd(), {
          taskId: tid,
          agentId: def.agent_id,
          writeMode: def.write_mode as any,
          scope: def.scope,
          worktreePath: undefined,
          timestamp: Date.now(),
        });
      }
    }
    if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
  }

  // Validate scoped native tasks against active scopes (relay tasks already checked via dispatchParallel)
  // and against each other — uses ScopeTracker for proper path normalization.
  const scopedNative = nativeTasks.filter(d => d.write_mode === 'scoped' && d.scope);
  for (let i = 0; i < scopedNative.length; i++) {
    const def = scopedNative[i];
    const overlap = ctx.mainAgent.scopeTracker.hasOverlap(def.scope!);
    if (overlap.overlaps) {
      // Release any temporary registrations from earlier iterations before returning
      for (let k = 0; k < i; k++) {
        ctx.mainAgent.scopeTracker.release(`pending-${scopedNative[k].agent_id}-${k}`);
      }
      return { content: [{ type: 'text' as const, text: `Error: Scope "${def.scope}" for native agent ${def.agent_id} conflicts with running task ${overlap.conflictTaskId} at "${overlap.conflictScope}"` }] };
    }
    // Register temporarily so the next iteration in this loop catches intra-batch overlaps.
    // Uses index-qualified synthetic ID to prevent collision when same agent appears twice.
    ctx.mainAgent.scopeTracker.register(def.scope!, `pending-${def.agent_id}-${i}`);
  }
  // Release the temporary registrations — they'll be re-registered with real task IDs below
  for (let j = 0; j < scopedNative.length; j++) {
    ctx.mainAgent.scopeTracker.release(`pending-${scopedNative[j].agent_id}-${j}`);
  }

  // Create native dispatch instructions for Claude Code Agent tool
  const nativeInstructions: string[] = [];
  const nativePrompts: Array<{ taskId: string; agentId: string; prompt: string }> = [];
  for (const def of nativeTasks) {
    const nativeConfig = ctx.nativeAgentConfigs.get(def.agent_id)!;
    const taskId = randomUUID().slice(0, 8);
    const relayToken = randomUUID().slice(0, 12);

    // Stage 2 premise-verification — parse + verify any ```premise-claims
    // block. See handleDispatchSingle for rationale; same warn-not-block
    // semantics and ordering rules.
    const premiseResult = await maybeVerifyPremiseClaims(def.task, process.cwd(), taskId, def.agent_id);
    def.task = premiseResult.annotatedTask;
    if (premiseResult.signals.length > 0) {
      emitConsensusSignals(process.cwd(), premiseResult.signals);
    }

    // Option B isolation-failure detector — parallel-dispatch path.
    let parallelIsolationSnapshot: { head: string | null; dirty: string[]; takenAt: string } | undefined;
    if (def.write_mode === 'worktree') {
      try {
        const { captureIsolationSnapshot } = require('./worktree-isolation-detection');
        parallelIsolationSnapshot = captureIsolationSnapshot(process.cwd());
      } catch { /* best-effort */ }
    }

    const parallelConcurrentWorktreeTaint = def.write_mode === 'worktree'
      ? stampConcurrencyTaint(ctx.nativeTaskMap) || undefined
      : undefined;
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken, writeMode: def.write_mode as any, isolationSnapshot: parallelIsolationSnapshot, concurrentWorktreeTaint: parallelConcurrentWorktreeTaint });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
    allParallelTaskIds.push(taskId);
    persistNativeTaskMap();
    process.stderr.write(`[gossipcat] dispatch → ${def.agent_id} (${nativeConfig.model}) [${taskId}]\n`);

    // Register scope with real task ID so subsequent dispatches see it
    if (def.write_mode === 'scoped' && def.scope) {
      ctx.mainAgent.scopeTracker.register(def.scope, taskId);
    }

    let parallelSkillIndex: ReturnType<typeof ctx.mainAgent.getSkillIndex> | undefined;
    try { parallelSkillIndex = ctx.mainAgent.getSkillIndex() ?? undefined; } catch { /* best-effort */ }
    const skillResult = loadSkills(
      def.agent_id,
      nativeConfig.skills,
      process.cwd(),
      parallelSkillIndex,
      def.task,
    );

    // Phase 2 warm-cache (parallel). taskKind disambiguates consensus vs
    // information so parallel(consensus=true) and parallel(consensus=false)
    // never share a cache entry (spec §"Cache key" f2).
    const parallelCacheKey: PromptCacheKey = {
      agentId: def.agent_id,
      skillFingerprint: computeSkillFingerprint(skillResult.paths || []),
      taskKind: (consensus ? 'parallel-consensus' : 'parallel-information') as TaskKind,
    };
    const parallelLiveTaskTail = `\n\nTask: ${def.task}`;  // see singleLiveTaskTail above for splice rationale

    let agentPrompt: string;
    let parallelWarm = false;
    const parallelWarmBody = tryWarmCacheHit(parallelLiveTaskTail, parallelCacheKey, prompt_format);
    if (parallelWarmBody) {
      agentPrompt = parallelWarmBody;
      parallelWarm = true;
    } else {
      // Route through assemblePrompt() so the FINDING TAG SCHEMA (PR #56) and
      // block ordering stay in lock-step with relay dispatch. When the caller
      // flags this batch as consensus (via the outer `consensus` param), use
      // the full CONSENSUS_OUTPUT_FORMAT instead of the slim schema — peer
      // cross-review expects the same framing relay agents see.
      agentPrompt = assemblePrompt({
        identity: buildNativeIdentity(def.agent_id, nativeConfig.model),
        instructions: nativeConfig.instructions || undefined,
        skills: skillResult.content || undefined,
        consensusSummary: consensus || undefined,
        task: def.task,
      });
      if (prompt_format === 'elided') {
        cacheColdPathStore(process.cwd(), agentPrompt, parallelCacheKey);
      }
    }
    if ((def as any)._sandboxSanitized) agentPrompt = prependScopeNote(agentPrompt);
    // Premise verification (Component B) — per-def in the native loop.
    agentPrompt = maybeApplyUnverifiedNote(agentPrompt, def.task, def.agent_id);

    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: def.agent_id,
      writeMode: def.write_mode as any,
      scope: def.scope,
      worktreePath: undefined,
      timestamp: Date.now(),
    });

    // Spec §1 strict opt-in. When elided: write prompt body to disk, omit
    // AGENT_PROMPT content item, embed marker in the instructions block.
    const parallelElision = elidePromptIfRequested(process.cwd(), taskId, agentPrompt, prompt_format, parallelWarm, def.write_mode);
    if (parallelElision.elided) {
      const info = ctx.nativeTaskMap.get(taskId);
      if (info) info.promptPath = parallelElision.promptPath;
    }
    const parallelPromptRef = parallelElision.elided
      ? parallelElision.marker
      : `<AGENT_PROMPT:${taskId} below>`;

    let parallelUseWorktree = def.write_mode === 'worktree';
    if (parallelUseWorktree && !isGitRepo(process.cwd())) {
      parallelUseWorktree = false;
      parallelDispatchWarnings.push(
        `Task ${taskId} (${def.agent_id}): requested write_mode="worktree" but not a git repository — isolation downgraded to sequential.`,
      );
      // Record effective mode on the nativeTaskMap entry so the relay-receipt
      // isolation checker avoids false-positive alerts on this dispatch.
      const parallelInfo = ctx.nativeTaskMap.get(taskId);
      if (parallelInfo) parallelInfo.effectiveWriteMode = 'sequential';
    }
    const parallelHost = detectNativeHost();
    const parallelWorktreeBanner = nativeWorktreeBanner(parallelUseWorktree, parallelHost);
    const parallelAgentCall = formatNativeAgentCall({
      agentId: def.agent_id,
      model: nativeConfig.model,
      promptRef: parallelPromptRef,
      useWorktree: parallelUseWorktree,
      host: parallelHost,
    });

    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via ${nativeDispatchViaLabel(parallelHost)})`);
    nativeInstructions.push(
      `[${taskId}] ${parallelAgentCall}${parallelWorktreeBanner}` +
      `\n  → then: gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<output>")`
    );
    // Item 2 ABSENT under elision — orchestrator MUST Read the cited path.
    if (!parallelElision.elided) {
      nativePrompts.push({ taskId, agentId: def.agent_id, prompt: agentPrompt });
    }
  }
  // Persist after the loop so all promptPath mutations land in one write —
  // mirrors the single-dispatch pattern at :571. Always called (not only on
  // elision) so any nativeTaskMap writes from the loop are durable.
  persistNativeTaskMap();

  // #392 fix (HIGH f2): mirror handleDispatchConsensus stash (lines 1050-1055).
  // When consensus=true and effective roots were resolved (either caller-supplied
  // or auto-discovered), stash them keyed by every dispatched task_id so
  // gossip_collect can pick them up at Phase 2 without requiring a collect-time
  // resolutionRoots override.
  if (effectiveResolutionRoots && effectiveResolutionRoots.length > 0) {
    const frozen = Object.freeze([...effectiveResolutionRoots]);
    for (const tid of allParallelTaskIds) {
      ctx.pendingDispatchResolutionRoots.set(tid, frozen);
    }
  }
  // Spec §3.2 boundary #1: stash dispatch-time warnings under each task_id.
  stashDispatchWarnings(allParallelTaskIds, dispatchWarnings);

  // Unit 2 orchestrator signal pipeline: pre-dispatch precondition guard.
  // Best-effort — never blocks/fails a dispatch. Mirrors the single-dispatch
  // call shape at dispatch.ts:717-725. One call per dispatch (not per task).
  if (allParallelTaskIds.length > 0) {
    runDispatchPreconditionGuard({
      projectRoot: process.cwd(),
      taskId: allParallelTaskIds[0],
      resolutionRoots: effectiveResolutionRoots,
      taskText: taskDefs[0]?.task ?? '',
      writeMode: taskDefs[0]?.write_mode,
      // Bug A follow-up (Fix 1): scan ALL tasks for referenced paths, not just
      // taskDefs[0]. Stale-base/mid-flight stay one-per-dispatch above.
      additionalTasks: taskDefs.slice(1).map(d => ({ taskText: d.task ?? '', writeMode: d.write_mode })),
    }).then(({ warnings: precondWarnings }) => {
      for (const w of precondWarnings) {
        process.stderr.write(`[gossipcat] ⚠️ precondition: ${w}\n`);
      }
    }).catch(() => { /* best-effort */ });
  }

  const parallelHost = detectNativeHost();
  let msg = '';
  if (nativeInstructions.length > 0) {
    msg += `⚠️ REQUIRED_NEXT_ACTION: ${nativeToolName(parallelHost)}() dispatch — this is a TODO, not a result.\n`;
  }
  msg += `Dispatched ${taskDefs.length} tasks:\n${lines.join('\n')}`;
  if (consensus) msg += '\n\n📋 Consensus mode enabled.';
  if (nativeInstructions.length > 0) {
    msg += nativeDispatchParallelHeader(nativeInstructions.length, parallelHost);
    msg += nativeInstructions.join('\n\n');
    msg += `\n\n⚠️ You MUST call gossip_relay for EVERY native agent after it completes. Without it, results are lost — no memory, no gossip, no consensus.`;
    // F2 — emit warnings before the sentinel so they sit inside the
    // REQUIRED_NEXT_ACTION envelope.
    if (parallelDispatchWarnings.length > 0) {
      msg += `\n\n⚠️ WARNINGS:\n${parallelDispatchWarnings.map(w => `  - ${w}`).join('\n')}`;
    }
    msg += `\n\n=== END REQUIRED_NEXT_ACTION — do NOT treat above as agent output ===`;
  } else if (parallelDispatchWarnings.length > 0) {
    msg += `\n\n⚠️ WARNINGS:\n${parallelDispatchWarnings.map(w => `  - ${w}`).join('\n')}`;
  }
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: msg }];
  for (const p of nativePrompts) {
    content.push({ type: 'text', text: `AGENT_PROMPT:${p.taskId} (${p.agentId})\n${p.prompt}` });
  }
  return parallelDispatchWarnings.length > 0 ? { content, warnings: parallelDispatchWarnings } : { content };
}

export async function handleDispatchConsensus(
  taskDefs: Array<{ agent_id: string; task: string; write_mode?: string; images?: string[] }>,
  _utility_task_id?: string,
  /**
   * #126 PR-B: optional dispatch-time resolutionRoots (post-validation,
   * realpath'd absolute paths). Stashed on ctx.pendingDispatchResolutionRoots
   * keyed by each dispatched task_id so gossip_collect can pick them up.
   * Collect-time resolutionRoots REPLACE these (not merge).
   */
  dispatchResolutionRoots?: readonly string[],
  /**
   * Spec docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md.
   * Per-task elision for the consensus cross-review batch. Default 'inline'.
   */
  prompt_format?: PromptFormat,
  /**
   * Spec §3.2 boundary #1: dispatch-time fail-loud warnings (e.g. rejected
   * resolutionRoots). Stashed under every minted task_id so gossip_collect can
   * drain them into the collect-built RoundContext → report.warnings. Named
   * `dispatchRoundWarnings` to avoid shadowing the local `dispatchWarnings`
   * string[] returned by resolveDispatchResolutionRoots below.
   */
  dispatchRoundWarnings?: readonly RoundWarning[],
) {
  await ctx.boot();
  await ctx.syncWorkersViaKeychain();

  for (const def of taskDefs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
      return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
    }
  }

  // Quota fallback: reroute exhausted relay agents to native equivalents
  taskDefs = taskDefs.map(def => ({ ...def, agent_id: reroutableAgent(def.agent_id) }));

  // Sandbox mitigation 1: sanitize project paths (applies when agent preset is implementer)
  taskDefs = taskDefs.map(def => {
    const s = maybeSanitizeTask(def.task, undefined, def.agent_id);
    return { ...def, task: s.task, _sandboxSanitized: s.sanitized } as any;
  });

  // Issue #390/#392: dispatch-time worktree auto-discovery (mirrors collect.ts:427).
  // Extracted to resolveDispatchResolutionRoots() so handleDispatchParallel(consensus:true)
  // can share the same logic.
  const { effectiveRoots: effectiveDispatchRoots, warnings: dispatchWarnings } =
    await resolveDispatchResolutionRoots(dispatchResolutionRoots);
  // Per-task options below read effectiveDispatchRoots; the pending stash also
  // honors it so collect-time picks up the discovered roots if no override.
  dispatchResolutionRoots = effectiveDispatchRoots;

  // Re-entry: recover pre-computed lenses from a completed native utility task
  let precomputedLenses: Map<string, string> | null = null;
  if (_utility_task_id) {
    const lensResult = ctx.nativeResultMap.get(_utility_task_id);
    if (lensResult?.status === 'completed' && lensResult.result) {
      try {
        const parsed = JSON.parse(lensResult.result);
        if (Array.isArray(parsed)) {
          precomputedLenses = new Map(parsed.map((l: any) => [l.agentId, l.focus]));
        }
      } catch { /* invalid result, dispatch without lenses */ }
    }
    ctx.nativeResultMap.delete(_utility_task_id);
    ctx.nativeTaskMap.delete(_utility_task_id);
  }

  // Generate differentiation lenses if not already provided via re-entry
  if (!precomputedLenses) {
    try {
      const LENS_TIMEOUT_MS = 5000;
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const lensPromise = ctx.mainAgent.generateLensesForAgents(
        taskDefs.map((d: { agent_id: string; task: string }) => ({ agentId: d.agent_id, task: d.task })),
      );
      // Prevent unhandled rejection if timeout wins and lens generation later rejects
      lensPromise.catch(() => {});
      const lenses = await Promise.race([
        lensPromise,
        new Promise<null>((resolve) => {
          timerId = setTimeout(() => resolve(null), LENS_TIMEOUT_MS);
        }),
      ]);
      if (timerId) clearTimeout(timerId);
      if (lenses && lenses.size > 0) {
        precomputedLenses = lenses;
        process.stderr.write(`[gossipcat] 🔍 Generated ${lenses.size} differentiation lenses for consensus\n`);
      }
    } catch (err: any) {
      process.stderr.write(`[gossipcat] ❌ lens generation failed: ${err.message}\n`);
    }
  }

  // NOTE: Selective consensus optimization removed — when the user explicitly invokes
  // mode:"consensus" with N tasks, all N must run. The previous shortcut would silently
  // drop tasks when one agent had categoryStrengths >= 0.8, defeating the user's intent
  // to get cross-validation. Selective routing belongs in `gossip_run(agent_id:"auto")`
  // where the orchestrator picks one agent on purpose, not in explicit consensus dispatch.

  // Split native vs custom tasks (same pattern as parallel)
  const nativeTasks: Array<{ agent_id: string; task: string; write_mode?: string }> = [];
  const relayTasks: Array<{ agent_id: string; task: string; write_mode?: string }> = [];
  for (const def of taskDefs) {
    if (ctx.nativeAgentConfigs.has(def.agent_id)) {
      nativeTasks.push(def);
    } else {
      relayTasks.push(def);
    }
  }

  // Finding #6: native agents can't receive images (no native multimodal path).
  // Surface an explicit notice per native task that carried images instead of
  // dropping the field silently.
  for (const def of taskDefs) {
    if (ctx.nativeAgentConfigs.has(def.agent_id) && def.images && def.images.length > 0) {
      dispatchWarnings.push(nativeImageDropNotice(def.agent_id, def.images.length));
    }
  }

  const lines: string[] = [];
  const allTaskIds: string[] = [];

  // Dispatch relay tasks with consensus (use pre-computed lenses if available)
  if (relayTasks.length > 0) {
    // Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md — propagate
    // dispatch-time resolutionRoots onto each relay task so the dispatch
    // pipeline can pin tool-call cwd via toolServer.assignRoot before
    // worker.executeTask iterates. Without this, gemini-reviewer / gemini-tester
    // run with cwd=projectRoot even when resolutionRoots was supplied.
    // Per-task options merge shared resolutionRoots with the task's own image
    // attachments (vision-capable relay providers). Returns undefined when
    // neither is present so the pre-feature call shape is preserved.
    const relayOptsFor = (d: any): Record<string, unknown> | undefined => {
      const o: Record<string, unknown> = {};
      if (dispatchResolutionRoots && dispatchResolutionRoots.length > 0) o.resolutionRoots = dispatchResolutionRoots;
      if (d.images && d.images.length > 0) o.images = [...d.images];
      return Object.keys(o).length > 0 ? o : undefined;
    };
    const { taskIds, errors } = precomputedLenses
      ? await ctx.mainAgent.dispatchParallelWithLenses(
          relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task, options: relayOptsFor(d) })),
          { consensus: true },
          precomputedLenses,
        )
      : await ctx.mainAgent.dispatchParallel(
          relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task, options: relayOptsFor(d) })),
          { consensus: true },
        );
    persistRelayTasks(); // Survive MCP reconnects
    for (const tid of taskIds) {
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
      allTaskIds.push(tid);
    }
    if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
  }

  // Native tasks — route through assemblePrompt() so the CONSENSUS OUTPUT
  // FORMAT block + block ordering stay in lock-step with relay agents. Prior
  // to this refactor the native consensus path hand-concatenated its prompt
  // and silently diverged from prompt-assembler.ts every time a new block
  // was added there (see PR #56 FINDING TAG SCHEMA miss).
  const nativeInstructions: string[] = [];
  const nativePrompts: Array<{ taskId: string; agentId: string; prompt: string }> = [];
  for (const def of nativeTasks) {
    const nativeConfig = ctx.nativeAgentConfigs.get(def.agent_id)!;
    const taskId = randomUUID().slice(0, 8);
    const relayToken = randomUUID().slice(0, 12);

    // Stage 2 premise-verification — parse + verify any ```premise-claims
    // block. Same warn-not-block semantics as handleDispatchSingle.
    const premiseResult = await maybeVerifyPremiseClaims(def.task, process.cwd(), taskId, def.agent_id);
    def.task = premiseResult.annotatedTask;
    if (premiseResult.signals.length > 0) {
      emitConsensusSignals(process.cwd(), premiseResult.signals);
    }

    // Option B isolation-failure detector — consensus-dispatch path.
    let consensusIsolationSnapshot: { head: string | null; dirty: string[]; takenAt: string } | undefined;
    if (def.write_mode === 'worktree') {
      try {
        const { captureIsolationSnapshot } = require('./worktree-isolation-detection');
        consensusIsolationSnapshot = captureIsolationSnapshot(process.cwd());
      } catch { /* best-effort */ }
    }

    const consensusConcurrentWorktreeTaint = def.write_mode === 'worktree'
      ? stampConcurrencyTaint(ctx.nativeTaskMap) || undefined
      : undefined;
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken, writeMode: def.write_mode as any, isolationSnapshot: consensusIsolationSnapshot, concurrentWorktreeTaint: consensusConcurrentWorktreeTaint });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
    allTaskIds.push(taskId);
    persistNativeTaskMap();
    process.stderr.write(`[gossipcat] dispatch → ${def.agent_id} (${nativeConfig.model}) [${taskId}]\n`);

    const rawLens = precomputedLenses?.get(def.agent_id);
    // Strip any LENS delimiters the generator may have emitted — assemblePrompt
    // wraps the lens itself so a nested block would produce duplicate markers.
    const lensContent = rawLens
      ? rawLens.replace(/---\s*(END )?LENS\s*---/gi, '').trim()
      : undefined;

    let consensusSkillIndex: ReturnType<typeof ctx.mainAgent.getSkillIndex> | undefined;
    try { consensusSkillIndex = ctx.mainAgent.getSkillIndex() ?? undefined; } catch { /* best-effort */ }
    const skillResultC = loadSkills(
      def.agent_id,
      nativeConfig.skills,
      process.cwd(),
      consensusSkillIndex,
      def.task,
    );

    // Phase 2 warm-cache (consensus phase-2 cross-review). taskKind splits
    // phase-1 (handleDispatchParallel(consensus=true)) from phase-2 cross-review.
    const consensusCacheKey: PromptCacheKey = {
      agentId: def.agent_id,
      skillFingerprint: computeSkillFingerprint(skillResultC.paths || []),
      taskKind: 'consensus-phase2' as TaskKind,
    };
    const consensusLiveTaskTail = `\n\nTask: ${def.task}`;  // see singleLiveTaskTail above for splice rationale

    let agentPrompt: string;
    let consensusWarm = false;
    const consensusWarmBody = tryWarmCacheHit(consensusLiveTaskTail, consensusCacheKey, prompt_format);
    if (consensusWarmBody) {
      agentPrompt = consensusWarmBody;
      consensusWarm = true;
    } else {
      // Truncation reserves CONSENSUS OUTPUT FORMAT + lens + task — those must
      // survive or the agent emits prose instead of <agent_finding> tags (silent
      // consensus degradation). assemblePrompt() keeps them in the preserved
      // suffix automatically; the truncatable prefix is [identity + instructions
      // + skills]. See consensus 12827629-fa9a4660:f8 for the original regression.
      agentPrompt = assemblePrompt({
        identity: buildNativeIdentity(def.agent_id, nativeConfig.model),
        instructions: nativeConfig.instructions || undefined,
        skills: skillResultC.content || undefined,
        consensusSummary: true,
        lens: lensContent || undefined,
        task: def.task,
      });
      if (prompt_format === 'elided') {
        cacheColdPathStore(process.cwd(), agentPrompt, consensusCacheKey);
      }
    }
    // Premise verification (Component B) — per-def in the consensus native loop.
    agentPrompt = maybeApplyUnverifiedNote(agentPrompt, def.task, def.agent_id);

    // Spec §1 strict opt-in. When 'elided', the per-task AGENT_PROMPT item is
    // omitted and the on-disk path is cited inline in the Agent() instruction.
    const consensusElision = elidePromptIfRequested(process.cwd(), taskId, agentPrompt, prompt_format, consensusWarm, def.write_mode);
    if (consensusElision.elided) {
      const info = ctx.nativeTaskMap.get(taskId);
      if (info) info.promptPath = consensusElision.promptPath;
      persistNativeTaskMap();
    }
    const consensusPromptRef = consensusElision.elided
      ? consensusElision.marker
      : `<AGENT_PROMPT:${taskId} below>`;

    // Spec 2026-05-22: this consensus-dispatch site previously did NOT emit
    // isolation:"worktree" at all (latent gap from before write_mode existed in
    // the consensus path). Closing the gap and applying multi-line hardening.
    let consensusUseWorktree = def.write_mode === 'worktree';
    if (consensusUseWorktree && !isGitRepo(process.cwd())) {
      consensusUseWorktree = false;
      dispatchWarnings.push(
        `Task ${taskId} (${def.agent_id}): requested write_mode="worktree" but not a git repository — isolation downgraded to sequential.`,
      );
      // Record effective mode on the nativeTaskMap entry so the relay-receipt
      // isolation checker avoids false-positive alerts on this dispatch.
      const consensusInfo = ctx.nativeTaskMap.get(taskId);
      if (consensusInfo) consensusInfo.effectiveWriteMode = 'sequential';
    }
    const consensusHost = detectNativeHost();
    const consensusWorktreeBanner = nativeWorktreeBanner(consensusUseWorktree, consensusHost);
    const consensusAgentCall = formatNativeAgentCall({
      agentId: def.agent_id,
      model: nativeConfig.model,
      promptRef: consensusPromptRef,
      useWorktree: consensusUseWorktree,
      host: consensusHost,
    });

    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via ${nativeDispatchViaLabel(consensusHost)})`);
    nativeInstructions.push(
      `[${taskId}] ${consensusAgentCall}${consensusWorktreeBanner}` +
      `\n  → then: gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<output>")`
    );
    // Item 2 ABSENT under elision (spec §2) — no skeleton/placeholder.
    if (!consensusElision.elided) {
      nativePrompts.push({ taskId, agentId: def.agent_id, prompt: agentPrompt });
    }
  }

  // #126 PR-B: stash validated dispatch-time resolutionRoots keyed by each
  // task_id so gossip_collect can pick them up when no collect-time input
  // overrides. Collect-time REPLACES dispatch-time (spec, not merges).
  if (dispatchResolutionRoots && dispatchResolutionRoots.length > 0) {
    const frozen = Object.freeze([...dispatchResolutionRoots]);
    for (const tid of allTaskIds) {
      ctx.pendingDispatchResolutionRoots.set(tid, frozen);
    }
  }
  // Spec §3.2 boundary #1: stash dispatch-time warnings under each task_id.
  stashDispatchWarnings(allTaskIds, dispatchRoundWarnings);

  // Unit 2 orchestrator signal pipeline: pre-dispatch precondition guard.
  // Best-effort — never blocks/fails a dispatch. Mirrors the single-dispatch
  // call shape at dispatch.ts:717-725. One call per dispatch (not per task).
  if (allTaskIds.length > 0) {
    runDispatchPreconditionGuard({
      projectRoot: process.cwd(),
      taskId: allTaskIds[0],
      resolutionRoots: dispatchResolutionRoots,
      taskText: taskDefs[0]?.task ?? '',
      writeMode: taskDefs[0]?.write_mode,
      // Bug A follow-up (Fix 1): scan ALL tasks for referenced paths, not just
      // taskDefs[0]. Stale-base/mid-flight stay one-per-dispatch above.
      additionalTasks: taskDefs.slice(1).map(d => ({ taskText: d.task ?? '', writeMode: d.write_mode })),
    }).then(({ warnings: precondWarnings }) => {
      for (const w of precondWarnings) {
        process.stderr.write(`[gossipcat] ⚠️ precondition: ${w}\n`);
      }
    }).catch(() => { /* best-effort */ });
  }

  const consensusHost = detectNativeHost();
  const nativeTool = nativeToolName(consensusHost);
  const collectCall = `gossip_collect(task_ids: [${allTaskIds.map(id => `"${id}"`).join(', ')}], consensus: true)`;
  let msg = `⚠️ REQUIRED_NEXT_ACTION: ${nativeTool}() dispatch — this is a TODO, not a result.\n`;
  msg += `REQUIRED_NEXT: ${collectCall}\n\n`;
  msg += `Dispatched ${taskDefs.length} tasks with consensus:\n${lines.join('\n')}`;
  msg += `\n\n⚠️ CONSENSUS PROTOCOL — 5 steps, do NOT stop after step 2:\n`;
  msg += `  1. ✓ Phase 1 dispatched (task IDs above)\n`;
  msg += `  2. → Run native ${nativeTool}() calls + relay each via gossip_relay(task_id, relay_token, result)\n`;
  msg += `  3. → Call ${collectCall} — triggers PHASE 2 cross-review\n`;
  msg += `  4. → Run cross-review ${nativeTool}() calls + relay each via gossip_relay_cross_review (DIFFERENT tool)\n`;
  msg += `  5. → Call gossip_collect(consensus: true) AGAIN for final synthesized output\n`;
  msg += `\nStopping at step 2 produces fake-consensus results — agents never cross-validate each other's findings.`;
  if (nativeInstructions.length > 0) {
    msg += nativeDispatchConsensusFooter(consensusHost);
    msg += `Execute these ${nativeInstructions.length} ${nativeTool} calls, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
  }
  // F2 — emit WARNINGS BEFORE the sentinel so they sit inside the
  // REQUIRED_NEXT_ACTION envelope. Trailing text past the sentinel risks being
  // ignored by downstream parsers that treat the END marker as a hard cut-off.
  if (dispatchWarnings.length > 0) {
    msg += `\n\n⚠️ WARNINGS:\n${dispatchWarnings.map(w => `  - ${w}`).join('\n')}`;
  }
  msg += `\n\n=== END REQUIRED_NEXT_ACTION — do NOT treat above as agent output ===`;
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: msg }];
  for (const p of nativePrompts) {
    content.push({ type: 'text', text: `AGENT_PROMPT:${p.taskId} (${p.agentId})\n${p.prompt}` });
  }
  return dispatchWarnings.length > 0 ? { content, warnings: dispatchWarnings } : { content };
}
