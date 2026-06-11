/**
 * Handler for gossip_relay_cross_review — accepts native agent cross-review
 * results and triggers consensus synthesis when all agents have responded.
 */
import { ctx, RECENT_CONSENSUS_TASK_TTL_MS } from '../mcp-context';
import { seedRecentConsensusAgentIds } from './native-tasks';
import type {
  ConsensusEngine as ConsensusEngineType,
  ConsensusReport,
  CrossReviewEntry,
  ILLMProvider,
  RoundContext,
  TaskEntry,
} from '@gossip/orchestrator';

/**
 * The minimal slice of a pending-round snapshot the timeout-synthesis path
 * consumes. Mirrors the object the timeout watcher builds from the live round.
 */
export interface TimeoutSynthesisSnapshot {
  allResults: TaskEntry[];
  relayCrossReviewEntries: CrossReviewEntry[];
  relayCrossReviewSkipped?: Array<{ agentId: string; reason: string }>;
  nativeCrossReviewEntries: CrossReviewEntry[];
  resolutionRoots?: readonly string[];
  roundContext?: RoundContext;
}

/**
 * REAL timeout-synthesis core (spec §5 / consensus f8 follow-up). Extracted from
 * the `checkTimeout` closure so a test can drive the genuine outer→inner layers:
 * it constructs the SAME engine the timeout watcher does, resolves cross-review
 * prompt anchors against the round's roots, runs `synthesizeWithCrossReview`, and
 * persists the report. Returns the report PLUS the resolved prompts so the
 * boundary value (round.resolutionRoots reaching anchor CONTENT) is observable in
 * the final artifact — not just asserted on the engine config.
 *
 * The engine REQUIRES a RoundContext (PR-C). When the snapshot lacks an embedded
 * round (old pre-PR-A persisted record), one is reconstructed from the flat
 * resolutionRoots so the synthesis still pins anchors to the worktree.
 */
export async function synthesizeTimeoutRound(
  snapshot: TimeoutSynthesisSnapshot,
  consensusId: string,
  missingAgents: string[],
  llm: ILLMProvider,
  projectRoot: string = process.cwd(),
): Promise<{ report: ConsensusReport; prompts: Array<{ system: string; user: string }> }> {
  const { ConsensusEngine, makeRoundContext } = await import('@gossip/orchestrator');
  const round: RoundContext =
    snapshot.roundContext ?? makeRoundContext({ resolutionRoots: snapshot.resolutionRoots ?? [] });
  const engine: ConsensusEngineType = new ConsensusEngine({
    llm,
    registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
    projectRoot,
    // PR-C: the engine requires a round; forward the effective one so its
    // warnings drain into the timeout-synthesis report and its roots pin anchors.
    round,
  });

  const allEntries = [...snapshot.relayCrossReviewEntries, ...snapshot.nativeCrossReviewEntries];
  // Resolve anchors against the round's roots — the prompts carry the worktree
  // version of cited files as <anchor> CONTENT. Surfaced for the §5 seam test.
  const { prompts } = await engine.generateCrossReviewPrompts(snapshot.allResults);
  const report = await engine.synthesizeWithCrossReview(
    snapshot.allResults,
    allEntries,
    consensusId,
    snapshot.relayCrossReviewSkipped,
  );

  // Persist report
  try {
    const { writeFileSync, mkdirSync } = require('fs');
    const { join } = require('path');
    const reportsDir = join(projectRoot, '.gossip', 'consensus-reports');
    mkdirSync(reportsDir, { recursive: true });
    const topic = snapshot.allResults?.find((r: any) => r.task)?.task?.slice(0, 500) || '';
    writeFileSync(join(reportsDir, `${consensusId}.json`), JSON.stringify({
      id: consensusId,
      timestamp: new Date().toISOString(),
      topic,
      agentCount: report.agentCount,
      rounds: report.rounds,
      confirmed: report.confirmed || [],
      disputed: report.disputed || [],
      unverified: report.unverified || [],
      unique: report.unique || [],
      insights: report.insights || [],
      newFindings: report.newFindings || [],
      timedOut: missingAgents,
      ...(report.droppedFindingsByType ? { droppedFindingsByType: report.droppedFindingsByType } : {}),
      ...(report.authorDiagnostics ? { authorDiagnostics: report.authorDiagnostics } : {}),
      ...(report.warnings && report.warnings.length > 0 ? { warnings: report.warnings } : {}),
    }, null, 2));
  } catch { /* best-effort */ }

  return { report, prompts: prompts.map(p => ({ system: p.system, user: p.user })) };
}

/**
 * Start a timeout watcher for a pending consensus round.
 * On expiry: synthesize with whatever entries have arrived, record timeout signals.
 */
export function startConsensusTimeout(consensusId: string): void {
  const round = ctx.pendingConsensusRounds.get(consensusId);
  if (!round) return;

  const remainingMs = round.deadline - Date.now();
  if (remainingMs <= 0) return;

  const checkTimeout = async () => {
    const current = ctx.pendingConsensusRounds.get(consensusId);
    if (!current || current.pendingNativeAgents.size === 0) return;

    // If deadline was extended (e.g., by an arriving cross-review relay), reschedule
    const remaining = current.deadline - Date.now();
    if (remaining > 0) {
      setTimeout(checkTimeout, remaining);
      return;
    }

    const missingAgents = [...current.pendingNativeAgents];
    // Delete round BEFORE async work to prevent double-synthesis race with concurrent relay
    const snapshot = { allResults: current.allResults, relayCrossReviewEntries: current.relayCrossReviewEntries, relayCrossReviewSkipped: current.relayCrossReviewSkipped, nativeCrossReviewEntries: [...current.nativeCrossReviewEntries], resolutionRoots: current.resolutionRoots, roundContext: current.roundContext };
    // PR #270 v3 review (HIGH): seed the agent-id fallback BEFORE delete from
    // the EXHAUSTIVE participation set, not just the still-pending agents.
    // Covers two cases: (1) agents that never relayed (still in
    // pendingNativeAgents — also in participatingNativeAgents), and
    // (2) agents that relayed before the timeout but whose payload failed to
    // parse (removed from pendingNativeAgents at handler entry, but still in
    // participatingNativeAgents). Both deserve the late-relay warning.
    seedRecentConsensusAgentIds(Array.from(current.participatingNativeAgents), RECENT_CONSENSUS_TASK_TTL_MS);
    ctx.pendingConsensusRounds.delete(consensusId);
    persistPendingConsensus();
    process.stderr.write(`[gossipcat] ⏰ Consensus ${consensusId} timed out. Missing: ${missingAgents.join(', ')}. Synthesizing with available entries.\n`);

    // Record timeout signals for missing agents.
    // PR 4 Part A: operational unique_unconfirmed — the agent never returned a
    // cross-review so there is no finding-evaluation context to derive a
    // category from. Intentionally written without `category`; these stay
    // outside per-category accumulators by design. A dedicated task_timeout
    // stream covers routing in PR 5.
    try {
      const { emitConsensusSignals } = await import('@gossip/orchestrator');
      const now = new Date().toISOString();
      emitConsensusSignals(process.cwd(), missingAgents.map(agentId => ({
        type: 'consensus' as const,
        signal: 'unique_unconfirmed' as const,
        agentId,
        taskId: `timeout-${consensusId}`,
        evidence: 'Cross-review timed out — agent did not respond within deadline',
        timestamp: now,
      })));
    } catch { /* best-effort */ }

    // Synthesize with what we have — via the extracted, test-driven core.
    try {
      const timeoutLlm = ctx.mainAgent.getLlm();
      if (!timeoutLlm) {
        process.stderr.write(`[gossipcat] ⚠️  Timeout synthesis skipped: no LLM configured\n`);
        return;
      }
      const { report } = await synthesizeTimeoutRound(snapshot, consensusId, missingAgents, timeoutLlm);
      process.stderr.write(`[gossipcat] 🔮 Timeout synthesis complete: ${report.confirmed.length} confirmed, ${report.disputed.length} disputed\n`);
    } catch (err) {
      process.stderr.write(`[gossipcat] ❌ Timeout synthesis failed: ${(err as Error).message}\n`);
    }
  };
  setTimeout(checkTimeout, remainingMs);
}

export async function handleRelayCrossReview(
  consensus_id: string,
  agent_id: string,
  result: string,
) {
  const round = ctx.pendingConsensusRounds.get(consensus_id);
  if (!round) {
    return {
      content: [{
        type: 'text' as const,
        text: `Error: No pending consensus round with ID "${consensus_id}". It may have expired or already completed.`,
      }],
    };
  }

  if (!round.pendingNativeAgents.has(agent_id)) {
    return {
      content: [{
        type: 'text' as const,
        text: `Error: Agent "${agent_id}" is not a pending native reviewer for consensus ${consensus_id}. Pending: ${[...round.pendingNativeAgents].join(', ')}`,
      }],
    };
  }

  // Delete from pending set BEFORE any await — closes TOCTOU window where duplicate
  // MCP calls could both pass the has() check above and double-process entries
  round.pendingNativeAgents.delete(agent_id);
  process.stderr.write(`[gossipcat] 📨 Cross-review received from ${agent_id}. Remaining: ${round.pendingNativeAgents.size}\n`);

  // Parse the cross-review response (parseCrossReviewResponse is stateless, llm not used)
  let parsedCount = 0;
  let acceptedCount = 0;
  const rejectedPeerIds = new Set<string>();
  let parseError: string | null = null;
  try {
    const { ConsensusEngine, makeRoundContext } = await import('@gossip/orchestrator');
    const parseLlm = ctx.mainAgent.getLlm();
    // parseCrossReviewResponse doesn't call LLM, but ConsensusEngine requires one in config
    const engine = new ConsensusEngine({
      llm: parseLlm || ({ generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }) } as any),
      registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
      projectRoot: process.cwd(),
      // PR-C: the engine requires a round. Forward the embedded one; if an old
      // restored record lacks it, wrap the flat roots (parse-only path — the
      // round is just for boundary consistency).
      round: round.roundContext ?? makeRoundContext({ resolutionRoots: round.resolutionRoots ?? [] }),
    });
    const entries = engine.parseCrossReviewResponse(agent_id, result, 50);
    parsedCount = entries.length;
    // Filter to round members only — prevents fabricated peerAgentId targeting agents outside the round
    const validPeerIds = new Set(round.allResults.map((r: any) => r.agentId));
    const filtered = entries.filter(e => {
      // NEW findings have no peer — they are discoveries the submitter surfaces
      // after reading peer work. Skip the self-review/peer-validity check for
      // them (see GH #131: otherwise every NEW entry is rejected because agents
      // naturally emit findingId "<self>:n<N>", which flags as self-review).
      if (e.action === 'new') return true;
      const selfReview = e.peerAgentId === agent_id;
      const unknownPeer = !validPeerIds.has(e.peerAgentId);
      if (selfReview || unknownPeer) {
        if (e.peerAgentId) rejectedPeerIds.add(e.peerAgentId);
        return false;
      }
      return true;
    });
    // Rewrite NEW findingIds to the consensus-wide form
    // `<consensusId>:new:<agentId>:<counter>`. Counter is scoped to this
    // submission (restarts at 1 per handler call).
    let newCounter = 0;
    for (const e of filtered) {
      if (e.action === 'new') {
        e.findingId = `${round.consensusId}:new:${agent_id}:${++newCounter}`;
        // peerAgentId is meaningless for NEW — clear it so downstream code
        // doesn't accidentally resolve it as a peer reference.
        e.peerAgentId = '';
      }
    }
    acceptedCount = filtered.length;
    round.nativeCrossReviewEntries.push(...filtered);
    if (parsedCount > 0 && acceptedCount === 0) {
      process.stderr.write(
        `[gossipcat] ⚠️  Cross-review from ${agent_id}: all ${parsedCount} entries rejected. ` +
        `Bad peer IDs: [${[...rejectedPeerIds].join(', ')}]. ` +
        `Valid round members: [${[...validPeerIds].join(', ')}]. ` +
        `Expected findingId format "<peerAgentId>:f<N>".\n`
      );
    } else if (parsedCount > acceptedCount) {
      process.stderr.write(
        `[gossipcat] ⚠️  Cross-review from ${agent_id}: ${parsedCount - acceptedCount}/${parsedCount} entries rejected ` +
        `(bad peer IDs: [${[...rejectedPeerIds].join(', ')}]).\n`
      );
    }
  } catch (err) {
    parseError = (err as Error).message;
    process.stderr.write(`[gossipcat] Failed to parse cross-review from ${agent_id}: ${parseError}\n`);
  }

  // Persist after each arrival so /mcp reconnect doesn't lose partial cross-reviews
  persistPendingConsensus();

  // Build a diagnostic line so the orchestrator can see when entries were silently
  // dropped by the peer-ID filter — previously this was stderr-only, so malformed
  // findingIds like "cr:f1" / "sa:f1" would vanish without any visible signal.
  const validPeerList = [...new Set(round.allResults.map((r: any) => r.agentId))].join(', ');
  let diagnostic = '';
  if (parseError) {
    diagnostic = `\n⚠️  Parse error: ${parseError}`;
  } else if (parsedCount > 0 && acceptedCount === 0) {
    diagnostic =
      `\n⚠️  All ${parsedCount} entries were REJECTED. Bad peer IDs: [${[...rejectedPeerIds].join(', ')}]. ` +
      `Valid round members: [${validPeerList}]. ` +
      `Expected findingId format "<peerAgentId>:f<N>" using exact agent IDs from the round.`;
  } else if (parsedCount > acceptedCount) {
    diagnostic =
      `\n⚠️  ${parsedCount - acceptedCount}/${parsedCount} entries rejected (bad peer IDs: [${[...rejectedPeerIds].join(', ')}]). ` +
      `Valid round members: [${validPeerList}].`;
  } else if (parsedCount > 0) {
    diagnostic = `\n✅ ${acceptedCount}/${parsedCount} entries accepted.`;
  }

  // Check if all native agents have responded
  if (round.pendingNativeAgents.size > 0) {
    // Extend deadline — each arriving result proves the orchestrator is actively relaying.
    // Without this, the 5-minute timer (started at gossip_collect return) expires before
    // the orchestrator can dispatch Agent() calls and relay all results back.
    const EXTENSION_MS = 600_000; // 10 more minutes from each arrival — native cross-review can take 3-5 min
    const MAX_TOTAL_MS = 3_600_000; // 60 minutes absolute cap from round creation
    const maxDeadline = round.createdAt + MAX_TOTAL_MS;
    round.deadline = Math.min(Date.now() + EXTENSION_MS, maxDeadline);
    return {
      content: [{
        type: 'text' as const,
        text: `Cross-review from ${agent_id} received. Waiting for ${round.pendingNativeAgents.size} more agent(s): ${[...round.pendingNativeAgents].join(', ')}${diagnostic}`,
      }],
    };
  }

  // All agents responded — synthesize
  // Snapshot and delete BEFORE async synthesis to prevent double-synthesis race with timeout
  const synthSnapshot = {
    allResults: round.allResults,
    relayCrossReviewEntries: round.relayCrossReviewEntries,
    relayCrossReviewSkipped: round.relayCrossReviewSkipped,
    nativeCrossReviewEntries: [...round.nativeCrossReviewEntries],
    consensusId: round.consensusId,
    // #126 PR-B: carry resolutionRoots into final synthesis — without this,
    // feature-branch cites that survived Phase-2 would re-UNVERIFY at the
    // synthesis step because the engine re-runs projectRoot-only
    // validation (round-3 consensus e507e375-50c2420b:f10).
    resolutionRoots: round.resolutionRoots,
    roundContext: round.roundContext,
  };
  // PR #270 v3 review (HIGH): seed the agent-id fallback BEFORE delete from the
  // EXHAUSTIVE participation set, not the post-parse derivation. The previous
  // approach derived the set from `nativeCrossReviewEntries[].agentId ∪ agent_id`
  // (the final arriving agent), which silently dropped earlier-arriving agents
  // whose parseCrossReviewResponse threw or returned zero entries — they were
  // gone from pendingNativeAgents (deleted at handler entry, line 137) AND
  // absent from nativeCrossReviewEntries. `participatingNativeAgents` is
  // populated at round-creation and NEVER mutated, so it covers every native
  // cross-review agent regardless of parse outcome.
  seedRecentConsensusAgentIds(Array.from(round.participatingNativeAgents), RECENT_CONSENSUS_TASK_TTL_MS);
  ctx.pendingConsensusRounds.delete(consensus_id);
  persistPendingConsensus();
  process.stderr.write(`[gossipcat] 🔮 All native cross-reviews received. Synthesizing consensus for ${consensus_id}...\n`);

  try {
    const { ConsensusEngine, makeRoundContext } = await import('@gossip/orchestrator');
    const mainLlm = ctx.mainAgent.getLlm();
    if (!mainLlm) {
      return { content: [{ type: 'text' as const, text: 'Error: No LLM configured for consensus synthesis. Check gossip_setup.' }] };
    }
    const engine = new ConsensusEngine({
      llm: mainLlm,
      registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
      projectRoot: process.cwd(),
      // PR-C: the engine requires a round. Forward the embedded one so its
      // fail-loud warnings drain into the final-synthesis report; wrap the flat
      // roots when an old restored record lacks an embedded round.
      round: synthSnapshot.roundContext ?? makeRoundContext({ resolutionRoots: synthSnapshot.resolutionRoots ?? [] }),
    });

    const allCrossReviewEntries = [
      ...synthSnapshot.relayCrossReviewEntries,
      ...synthSnapshot.nativeCrossReviewEntries,
    ];

    const report = await engine.synthesizeWithCrossReview(
      synthSnapshot.allResults,
      allCrossReviewEntries,
      synthSnapshot.consensusId,
      synthSnapshot.relayCrossReviewSkipped,
    );

    // Persist report for dashboard
    try {
      const { writeFileSync, mkdirSync } = require('fs');
      const { join } = require('path');
      const reportsDir = join(process.cwd(), '.gossip', 'consensus-reports');
      mkdirSync(reportsDir, { recursive: true });
      const reportPath = join(reportsDir, `${consensus_id}.json`);
      const topic = synthSnapshot.allResults?.find((r: any) => r.task)?.task?.slice(0, 500) || '';
      writeFileSync(reportPath, JSON.stringify({
        id: consensus_id,
        timestamp: new Date().toISOString(),
        topic,
        agentCount: report.agentCount,
        rounds: report.rounds,
        confirmed: report.confirmed || [],
        disputed: report.disputed || [],
        unverified: report.unverified || [],
        unique: report.unique || [],
        insights: report.insights || [],
        newFindings: report.newFindings || [],
        ...(report.droppedFindingsByType ? { droppedFindingsByType: report.droppedFindingsByType } : {}),
        ...(report.authorDiagnostics ? { authorDiagnostics: report.authorDiagnostics } : {}),
        ...(report.warnings && report.warnings.length > 0 ? { warnings: report.warnings } : {}),
      }, null, 2));
    } catch { /* best-effort */ }

    // Write performance signals
    try {
      const { emitConsensusSignals } = await import('@gossip/orchestrator');
      if (report.signals.length > 0) {
        emitConsensusSignals(process.cwd(), report.signals);
      }
    } catch { /* best-effort */ }

    return {
      content: [{
        type: 'text' as const,
        text: report.summary || `Consensus complete: ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unverified.length} unverified, ${report.unique.length} unique.`,
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text' as const,
        text: `Error synthesizing consensus: ${(err as Error).message}`,
      }],
    };
  }
}

// ── Persistence — survive /mcp reconnect ───────────────────────────────

const CONSENSUS_FILE = 'pending-consensus.json';

/**
 * Reconstruct a RoundContext from a persisted pending-round record (spec §3.2
 * disk back-compat). Prefers the embedded `roundContext`; per field, falls back
 * to the old flat shape — `data.roundContext?.resolutionRoots ?? data.resolutionRoots`,
 * mirroring the participatingNativeAgents back-compat pattern. Returns undefined
 * only when NEITHER an embedded round nor flat roots are present (a pre-#126
 * record with no roots at all), so old flat-shape files restore with roots
 * intact.
 */
function restoreRoundContext(data: any): import('@gossip/orchestrator').RoundContext | undefined {
  const { makeRoundContext } = require('@gossip/orchestrator');
  const rc = data.roundContext;
  // Deep-shape hardening (spec §4, gemini f1): a hand-edited / partially-written
  // pending-consensus.json may carry malformed field shapes. Drop the malformed
  // pieces (fail-OPEN — the round still restores) but record a
  // `round_restore_malformed` warning per drop so the degradation is visible in
  // report.warnings rather than silently swallowed (fail-LOUD). NEVER throw.
  const restoreWarnings: import('@gossip/orchestrator').RoundWarning[] = [];
  const noteDrop = (what: string) =>
    restoreWarnings.push({ code: 'round_restore_malformed', message: `restore dropped malformed ${what}` });

  // Per-field fallback with `??` semantics (spec §3.2): an embedded
  // roundContext is AUTHORITATIVE — honor its resolutionRoots array even when
  // it is intentionally empty (`[]` = "resolve against project root"). Only
  // when there is NO embedded round do we read the old flat field. A
  // length-gated check would wrongly treat a new-format empty-roots record as
  // if it were old-flat-shape and resurrect a stale flat value.
  const rawRoots: unknown =
    (rc && Array.isArray(rc.resolutionRoots))
      ? rc.resolutionRoots
      : (Array.isArray(data.resolutionRoots) ? data.resolutionRoots : []);
  // resolutionRoots entries must be strings — drop non-string members.
  let roots: readonly string[] = [];
  if (Array.isArray(rawRoots)) {
    const clean = (rawRoots as unknown[]).filter((x): x is string => typeof x === 'string');
    if (clean.length !== rawRoots.length) noteDrop(`${rawRoots.length - clean.length} non-string resolutionRoots entr(y/ies)`);
    roots = clean;
  }

  // warnings entries must be objects with string code+message; agentId optional
  // string. Drop entries missing code/message or carrying non-string fields.
  let warnings: import('@gossip/orchestrator').RoundWarning[] = [];
  if (rc && Array.isArray(rc.warnings)) {
    let dropped = 0;
    for (const w of rc.warnings as unknown[]) {
      if (
        w && typeof w === 'object' &&
        typeof (w as any).code === 'string' &&
        typeof (w as any).message === 'string' &&
        ((w as any).agentId === undefined || typeof (w as any).agentId === 'string')
      ) {
        const entry: import('@gossip/orchestrator').RoundWarning = { code: (w as any).code, message: (w as any).message };
        if ((w as any).agentId !== undefined) entry.agentId = (w as any).agentId;
        warnings.push(entry);
      } else {
        dropped++;
      }
    }
    if (dropped > 0) noteDrop(`${dropped} warnings entr(y/ies) (missing code/message or non-string field)`);
  } else if (rc && rc.warnings !== undefined) {
    noteDrop('warnings field (not an array)');
  }

  const consensusId = rc && typeof rc.consensusId === 'string' ? rc.consensusId : undefined;
  // lenses must be a plain object whose values are all strings; drop the whole
  // map if it is non-object, or drop individual non-string values.
  let lenses: Record<string, string> | undefined;
  if (rc && rc.lenses !== undefined) {
    if (rc.lenses && typeof rc.lenses === 'object' && !Array.isArray(rc.lenses)) {
      const out: Record<string, string> = {};
      let droppedLens = 0;
      for (const [k, v] of Object.entries(rc.lenses as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
        else droppedLens++;
      }
      if (droppedLens > 0) noteDrop(`${droppedLens} non-string lens value(s)`);
      lenses = Object.keys(out).length > 0 ? out : undefined;
    } else {
      noteDrop('lenses field (not a plain object)');
    }
  }

  // Append the restore-drop warnings AFTER the restored ones so the degradation
  // shows up in report.warnings (spec §4 fail-loud).
  if (restoreWarnings.length > 0) warnings = [...warnings, ...restoreWarnings];

  // Nothing to carry — no embedded round and no flat roots: legacy rootless.
  // (A malformed-but-present rc still produces a round so its drop warnings
  // surface; only the truly-empty pre-PR-A record returns undefined.)
  if (!rc && roots.length === 0 && warnings.length === 0) return undefined;
  return makeRoundContext({
    ...(consensusId !== undefined ? { consensusId } : {}),
    resolutionRoots: roots,
    ...(lenses !== undefined ? { lenses } : {}),
    warnings,
  });
}

/** Persist pending consensus rounds to disk so /mcp reconnects don't lose them */
export function persistPendingConsensus(): void {
  try {
    const projectRoot = ctx.mainAgent?.projectRoot;
    if (!projectRoot) return;
    const { writeFileSync, mkdirSync } = require('fs');
    const { join } = require('path');
    const dir = join(projectRoot, '.gossip');
    mkdirSync(dir, { recursive: true });

    const rounds: Record<string, any> = {};
    for (const [id, round] of ctx.pendingConsensusRounds) {
      rounds[id] = {
        consensusId: round.consensusId,
        allResults: round.allResults.map((r: any) => ({
          id: r.id, agentId: r.agentId, task: r.task?.slice(0, 5000),
          status: r.status, result: r.result?.slice(0, 10000),
        })),
        relayCrossReviewEntries: round.relayCrossReviewEntries,
        relayCrossReviewSkipped: round.relayCrossReviewSkipped,
        pendingNativeAgents: [...round.pendingNativeAgents],
        participatingNativeAgents: [...round.participatingNativeAgents],
        nativeCrossReviewEntries: round.nativeCrossReviewEntries,
        deadline: round.deadline,
        createdAt: round.createdAt,
        // Only persist prompts for agents that are still pending — completed ones are done
        nativePrompts: (round.nativePrompts || []).filter(p => round.pendingNativeAgents.has(p.agentId)),
        // #126 PR-B: carry validated resolution roots across reconnects.
        resolutionRoots: round.resolutionRoots ? [...round.resolutionRoots] : undefined,
        // Spec §3.2: persist the embedded RoundContext (resolutionRoots +
        // warnings) so fail-loud state survives /mcp reconnect. The flat
        // resolutionRoots above is kept in parallel for old-reader back-compat.
        roundContext: round.roundContext
          ? {
              ...(round.roundContext.consensusId !== undefined ? { consensusId: round.roundContext.consensusId } : {}),
              resolutionRoots: [...round.roundContext.resolutionRoots],
              ...(round.roundContext.lenses !== undefined ? { lenses: round.roundContext.lenses } : {}),
              warnings: [...round.roundContext.warnings],
            }
          : undefined,
      };
    }
    writeFileSync(join(dir, CONSENSUS_FILE), JSON.stringify(rounds));
  } catch (err) {
    process.stderr.write(`[gossipcat] persistPendingConsensus failed: ${(err as Error).message}\n`);
  }
}

/** Restore pending consensus rounds from disk (called on boot) */
export function restorePendingConsensus(projectRoot: string): void {
  try {
    const { existsSync, readFileSync, unlinkSync } = require('fs');
    const { join } = require('path');
    const filePath = join(projectRoot, '.gossip', CONSENSUS_FILE);
    if (!existsSync(filePath)) return;

    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const now = Date.now();

    for (const [id, data] of Object.entries(raw) as [string, any][]) {
      // Skip expired rounds (deadline passed + 5 min grace period)
      if (now > data.deadline + 300_000) {
        process.stderr.write(`[gossipcat] Skipping expired consensus round ${id}\n`);
        continue;
      }
      if (ctx.pendingConsensusRounds.has(id)) continue;

      ctx.pendingConsensusRounds.set(id, {
        consensusId: data.consensusId,
        allResults: data.allResults,
        relayCrossReviewEntries: data.relayCrossReviewEntries || [],
        relayCrossReviewSkipped: data.relayCrossReviewSkipped,
        pendingNativeAgents: new Set(data.pendingNativeAgents || []),
        // Back-compat: pre-v3 persisted rounds lack participatingNativeAgents.
        // Fall back to pendingNativeAgents — for restored rounds the still-pending
        // set is the best available approximation of original participants.
        participatingNativeAgents: new Set(
          Array.isArray(data.participatingNativeAgents) && data.participatingNativeAgents.length > 0
            ? data.participatingNativeAgents
            : (data.pendingNativeAgents || []),
        ),
        nativeCrossReviewEntries: data.nativeCrossReviewEntries || [],
        deadline: data.deadline,
        createdAt: data.createdAt,
        nativePrompts: data.nativePrompts || [],
        resolutionRoots: Array.isArray(data.resolutionRoots) && data.resolutionRoots.length > 0
          ? data.resolutionRoots
          : undefined,
        // Spec §3.2 disk back-compat: prefer the embedded roundContext; fall
        // back per-field to the old flat shape (mirrors the
        // participatingNativeAgents back-compat pattern above). Old pre-PR-A
        // files lack `roundContext` entirely — reconstruct one from the flat
        // resolutionRoots so downstream phases still see a RoundContext.
        roundContext: restoreRoundContext(data),
      });

      // Re-arm timeout watcher
      startConsensusTimeout(id);
      process.stderr.write(`[gossipcat] Restored consensus round ${id} — ${data.pendingNativeAgents?.length ?? 0} agents pending\n`);
    }

    // Clean up file after restore
    unlinkSync(filePath);
  } catch { /* best-effort — corrupt file is fine */ }
}
