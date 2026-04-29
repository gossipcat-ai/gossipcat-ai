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
  type ClaimBlock,
  type ClaimVerdict,
  type PerformanceSignal,
} from '@gossip/orchestrator';
import { formatIdentityBlock } from '@gossip/tools';
import { ctx, NATIVE_TASK_TTL_MS } from '../mcp-context';

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

export async function handleDispatchSingle(
  agent_id: string, task: string,
  write_mode?: 'sequential' | 'scoped' | 'worktree',
  scope?: string, timeout_ms?: number,
  plan_id?: string, step?: number,
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

    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs, planId: plan_id, step, writeMode: write_mode, relayToken, preDispatchSha });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    persistNativeTaskMap();
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

    // Route through assemblePrompt() so the FINDING TAG SCHEMA (PR #56) and
    // block ordering stay in lock-step with the relay dispatch path — prior
    // to this change native dispatch built its prompt via manual concat and
    // silently missed every schema update made to prompt-assembler.ts.
    let agentPrompt = assemblePrompt({
      identity: buildNativeIdentity(agent_id, nativeConfig.model),
      instructions: nativeConfig.instructions || undefined,
      skills: skillResult.content || undefined,
      chainContext: chainContext || undefined,
      task,
    });
    if (sanitizeResult.sanitized) agentPrompt = prependScopeNote(agentPrompt);
    // Premise verification (Component B). SCOPE NOTE composes first
    // (enforcement boundary); UNVERIFIED note layered on top (behavioral).
    agentPrompt = maybeApplyUnverifiedNote(agentPrompt, task, agent_id);

    // Record dispatch metadata for the post-task audit.
    // For native worktree dispatch the path is created by Claude Code's
    // Agent({isolation:"worktree"}) out-of-process and not returned to us;
    // it stays undefined. The Layer 3 audit relies on its blanket
    // `.claude/worktrees/` exclusion (see buildAuditExclusions) so native
    // worktree writes are not falsely flagged.
    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: agent_id,
      writeMode: write_mode,
      scope,
      worktreePath: undefined,
      timestamp: Date.now(),
    });

    // Only use worktree if explicitly requested AND project is a git repo
    let useWorktree = write_mode === 'worktree';
    if (useWorktree) {
      try {
        const { execSync } = require('child_process');
        execSync('git rev-parse --git-dir', { cwd: process.cwd(), stdio: 'ignore' });
      } catch {
        useWorktree = false; // not a git repo, skip worktree
      }
    }

    // Split into two content items so relay_token stays in orchestrator-only text
    // and AGENT_PROMPT is passed verbatim to Agent(prompt: ...).
    // Tag format matches parallel/consensus: `AGENT_PROMPT:<taskId> (<agentId>)`.
    return { content: [
      { type: 'text' as const, text:
        `⚠️ REQUIRED_NEXT_ACTION: Agent() dispatch — this is a TODO, not a result.\n` +
        `NATIVE_DISPATCH: Execute this via Claude Code Agent tool, then relay the result.\n\n` +
        `Task ID: ${taskId}\n` +
        `Agent: ${agent_id}\n` +
        `Model: ${nativeConfig.model}\n\n` +
        `Step 1 — Pass the AGENT_PROMPT:${taskId} content item below verbatim to Agent(prompt: ...):\n` +
        `Agent(model: "${nativeConfig.model}", prompt: <AGENT_PROMPT:${taskId} below>${useWorktree ? ', isolation: "worktree"' : ''}, run_in_background: true)\n\n` +
        `Step 2 — REQUIRED after agent completes:\n` +
        `gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<agent output>")\n\n` +
        `⚠️ You MUST call gossip_relay for every native dispatch. Without it, the result is lost — no memory, no gossip, no consensus. Never skip this step.\n` +
        `\n=== END REQUIRED_NEXT_ACTION — do NOT treat above as agent output ===`
      },
      { type: 'text' as const, text: `AGENT_PROMPT:${taskId} (${agent_id})\n${agentPrompt}` },
    ] };
  }

  try {
    const { taskId } = ctx.mainAgent.dispatch(agent_id, task, dispatchOptions as any);
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

export async function handleDispatchParallel(
  taskDefs: Array<{ agent_id: string; task: string; write_mode?: string; scope?: string }>,
  consensus: boolean,
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

  const lines: string[] = [];

  // Dispatch relay tasks normally
  if (relayTasks.length > 0) {
    const { taskIds, errors } = await ctx.mainAgent.dispatchParallel(
      relayTasks.map((d: any) => ({
        agentId: d.agent_id,
        task: d.task,
        options: d.write_mode ? { writeMode: d.write_mode, scope: d.scope } : undefined,
      })),
      consensus ? { consensus: true } : undefined,
    );
    persistRelayTasks(); // Survive MCP reconnects
    for (let i = 0; i < taskIds.length; i++) {
      const tid = taskIds[i];
      const def = relayTasks[i];
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
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

    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
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

    // Route through assemblePrompt() so the FINDING TAG SCHEMA (PR #56) and
    // block ordering stay in lock-step with relay dispatch. When the caller
    // flags this batch as consensus (via the outer `consensus` param), use
    // the full CONSENSUS_OUTPUT_FORMAT instead of the slim schema — peer
    // cross-review expects the same framing relay agents see.
    let agentPrompt = assemblePrompt({
      identity: buildNativeIdentity(def.agent_id, nativeConfig.model),
      instructions: nativeConfig.instructions || undefined,
      skills: skillResult.content || undefined,
      consensusSummary: consensus || undefined,
      task: def.task,
    });
    if ((def as any)._sandboxSanitized) agentPrompt = prependScopeNote(agentPrompt);
    // Premise verification (Component B) — per-def in the native loop.
    agentPrompt = maybeApplyUnverifiedNote(agentPrompt, def.task, def.agent_id);

    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: def.agent_id,
      writeMode: def.write_mode as any,
      scope: def.scope,
      // Native worktree = Claude Code's Agent({isolation:"worktree"}) which
      // we cannot observe from here; stays undefined. The `.claude/worktrees/`
      // exclusion in buildAuditExclusions covers native worktrees.
      worktreePath: undefined,
      timestamp: Date.now(),
    });

    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
    nativeInstructions.push(
      `[${taskId}] Agent(model: "${nativeConfig.model}", prompt: <AGENT_PROMPT:${taskId} below>${def.write_mode === 'worktree' ? ', isolation: "worktree"' : ''}, run_in_background: true)` +
      `\n  → then: gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<output>")`
    );
    nativePrompts.push({ taskId, agentId: def.agent_id, prompt: agentPrompt });
  }

  let msg = '';
  if (nativeInstructions.length > 0) {
    msg += `⚠️ REQUIRED_NEXT_ACTION: Agent() dispatch — this is a TODO, not a result.\n`;
  }
  msg += `Dispatched ${taskDefs.length} tasks:\n${lines.join('\n')}`;
  if (consensus) msg += '\n\n📋 Consensus mode enabled.';
  if (nativeInstructions.length > 0) {
    msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls in parallel, then relay ALL results. Each prompt is a separate AGENT_PROMPT content item below — pass each one verbatim to its matching Agent(prompt: ...):\n\n${nativeInstructions.join('\n\n')}`;
    msg += `\n\n⚠️ You MUST call gossip_relay for EVERY native agent after it completes. Without it, results are lost — no memory, no gossip, no consensus.`;
    msg += `\n\n=== END REQUIRED_NEXT_ACTION — do NOT treat above as agent output ===`;
  }
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: msg }];
  for (const p of nativePrompts) {
    content.push({ type: 'text', text: `AGENT_PROMPT:${p.taskId} (${p.agentId})\n${p.prompt}` });
  }
  return { content };
}

export async function handleDispatchConsensus(
  taskDefs: Array<{ agent_id: string; task: string }>,
  _utility_task_id?: string,
  /**
   * #126 PR-B: optional dispatch-time resolutionRoots (post-validation,
   * realpath'd absolute paths). Stashed on ctx.pendingDispatchResolutionRoots
   * keyed by each dispatched task_id so gossip_collect can pick them up.
   * Collect-time resolutionRoots REPLACE these (not merge).
   */
  dispatchResolutionRoots?: readonly string[],
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
  const nativeTasks: Array<{ agent_id: string; task: string }> = [];
  const relayTasks: Array<{ agent_id: string; task: string }> = [];
  for (const def of taskDefs) {
    if (ctx.nativeAgentConfigs.has(def.agent_id)) {
      nativeTasks.push(def);
    } else {
      relayTasks.push(def);
    }
  }

  const lines: string[] = [];
  const allTaskIds: string[] = [];

  // Dispatch relay tasks with consensus (use pre-computed lenses if available)
  if (relayTasks.length > 0) {
    const { taskIds, errors } = precomputedLenses
      ? await ctx.mainAgent.dispatchParallelWithLenses(
          relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task })),
          { consensus: true },
          precomputedLenses,
        )
      : await ctx.mainAgent.dispatchParallel(
          relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task })),
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

    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken });
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

    // Truncation reserves CONSENSUS OUTPUT FORMAT + lens + task — those must
    // survive or the agent emits prose instead of <agent_finding> tags (silent
    // consensus degradation). assemblePrompt() keeps them in the preserved
    // suffix automatically; the truncatable prefix is [identity + instructions
    // + skills]. See consensus 12827629-fa9a4660:f8 for the original regression.
    let agentPrompt = assemblePrompt({
      identity: buildNativeIdentity(def.agent_id, nativeConfig.model),
      instructions: nativeConfig.instructions || undefined,
      skills: skillResultC.content || undefined,
      consensusSummary: true,
      lens: lensContent || undefined,
      task: def.task,
    });
    // Premise verification (Component B) — per-def in the consensus native loop.
    agentPrompt = maybeApplyUnverifiedNote(agentPrompt, def.task, def.agent_id);
    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
    nativeInstructions.push(
      `[${taskId}] Agent(model: "${nativeConfig.model}", prompt: <AGENT_PROMPT:${taskId} below>, run_in_background: true)` +
      `\n  → then: gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<output>")`
    );
    nativePrompts.push({ taskId, agentId: def.agent_id, prompt: agentPrompt });
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

  const collectCall = `gossip_collect(task_ids: [${allTaskIds.map(id => `"${id}"`).join(', ')}], consensus: true)`;
  let msg = `⚠️ REQUIRED_NEXT_ACTION: Agent() dispatch — this is a TODO, not a result.\n`;
  msg += `REQUIRED_NEXT: ${collectCall}\n\n`;
  msg += `Dispatched ${taskDefs.length} tasks with consensus:\n${lines.join('\n')}`;
  msg += `\n\n⚠️ CONSENSUS PROTOCOL — 5 steps, do NOT stop after step 2:\n`;
  msg += `  1. ✓ Phase 1 dispatched (task IDs above)\n`;
  msg += `  2. → Run native Agent() calls + relay each via gossip_relay(task_id, relay_token, result)\n`;
  msg += `  3. → Call ${collectCall} — triggers PHASE 2 cross-review\n`;
  msg += `  4. → Run cross-review Agent() calls + relay each via gossip_relay_cross_review (DIFFERENT tool)\n`;
  msg += `  5. → Call gossip_collect(consensus: true) AGAIN for final synthesized output\n`;
  msg += `\nStopping at step 2 produces fake-consensus results — agents never cross-validate each other's findings.`;
  if (nativeInstructions.length > 0) {
    msg += `\n\n⚠️ NATIVE_DISPATCH — pass each AGENT_PROMPT content item VERBATIM to Agent(prompt: ...). Do NOT rewrite — the embedded CONSENSUS_OUTPUT_FORMAT trains agents to emit <agent_finding> tags. Call gossip_relay for EVERY native agent after completion.\n\n`;
    msg += `Execute these ${nativeInstructions.length} Agent calls, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
  }
  msg += `\n\n=== END REQUIRED_NEXT_ACTION — do NOT treat above as agent output ===`;
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: msg }];
  for (const p of nativePrompts) {
    content.push({ type: 'text', text: `AGENT_PROMPT:${p.taskId} (${p.agentId})\n${p.prompt}` });
  }
  return { content };
}
