/**
 * Handler for gossip_relay_cross_review — accepts native agent cross-review
 * results and triggers consensus synthesis when all agents have responded.
 */
import { ctx } from '../mcp-context';

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
    const snapshot = { allResults: current.allResults, relayCrossReviewEntries: current.relayCrossReviewEntries, relayCrossReviewSkipped: current.relayCrossReviewSkipped, nativeCrossReviewEntries: [...current.nativeCrossReviewEntries], resolutionRoots: current.resolutionRoots };
    ctx.pendingConsensusRounds.delete(consensusId);
    persistPendingConsensus();
    process.stderr.write(`[gossipcat] ⏰ Consensus ${consensusId} timed out. Missing: ${missingAgents.join(', ')}. Synthesizing with available entries.\n`);

    // Record timeout signals for missing agents
    try {
      const { PerformanceWriter } = await import('@gossip/orchestrator');
      const writer = new PerformanceWriter(process.cwd());
      const now = new Date().toISOString();
      writer.appendSignals(missingAgents.map(agentId => ({
        type: 'consensus' as const,
        signal: 'unique_unconfirmed' as const,
        agentId,
        taskId: `timeout-${consensusId}`,
        evidence: 'Cross-review timed out — agent did not respond within deadline',
        timestamp: now,
      })));
    } catch { /* best-effort */ }

    // Synthesize with what we have
    try {
      const { ConsensusEngine } = await import('@gossip/orchestrator');
      const timeoutLlm = ctx.mainAgent.getLlm();
      if (!timeoutLlm) {
        process.stderr.write(`[gossipcat] ⚠️  Timeout synthesis skipped: no LLM configured\n`);
        return;
      }
      const engine = new ConsensusEngine({
        llm: timeoutLlm,
        registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
        projectRoot: process.cwd(),
        resolutionRoots: snapshot.resolutionRoots,
      });

      const allEntries = [...snapshot.relayCrossReviewEntries, ...snapshot.nativeCrossReviewEntries];
      const report = await engine.synthesizeWithCrossReview(snapshot.allResults, allEntries, consensusId, snapshot.relayCrossReviewSkipped);

      // Persist report
      try {
        const { writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const reportsDir = join(process.cwd(), '.gossip', 'consensus-reports');
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
        }, null, 2));
      } catch { /* best-effort */ }

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
    const { ConsensusEngine } = await import('@gossip/orchestrator');
    const parseLlm = ctx.mainAgent.getLlm();
    // parseCrossReviewResponse doesn't call LLM, but ConsensusEngine requires one in config
    const engine = new ConsensusEngine({
      llm: parseLlm || ({ generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }) } as any),
      registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
      projectRoot: process.cwd(),
      resolutionRoots: round.resolutionRoots,
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
  };
  ctx.pendingConsensusRounds.delete(consensus_id);
  persistPendingConsensus();
  process.stderr.write(`[gossipcat] 🔮 All native cross-reviews received. Synthesizing consensus for ${consensus_id}...\n`);

  try {
    const { ConsensusEngine, PerformanceWriter } = await import('@gossip/orchestrator');
    const mainLlm = ctx.mainAgent.getLlm();
    if (!mainLlm) {
      return { content: [{ type: 'text' as const, text: 'Error: No LLM configured for consensus synthesis. Check gossip_setup.' }] };
    }
    const engine = new ConsensusEngine({
      llm: mainLlm,
      registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
      projectRoot: process.cwd(),
      resolutionRoots: synthSnapshot.resolutionRoots,
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
      }, null, 2));
    } catch { /* best-effort */ }

    // Write performance signals
    try {
      const writer = new PerformanceWriter(process.cwd());
      if (report.signals.length > 0) {
        writer.appendSignals(report.signals);
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
        nativeCrossReviewEntries: round.nativeCrossReviewEntries,
        deadline: round.deadline,
        createdAt: round.createdAt,
        // Only persist prompts for agents that are still pending — completed ones are done
        nativePrompts: (round.nativePrompts || []).filter(p => round.pendingNativeAgents.has(p.agentId)),
        // #126 PR-B: carry validated resolution roots across reconnects.
        resolutionRoots: round.resolutionRoots ? [...round.resolutionRoots] : undefined,
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
        nativeCrossReviewEntries: data.nativeCrossReviewEntries || [],
        deadline: data.deadline,
        createdAt: data.createdAt,
        nativePrompts: data.nativePrompts || [],
        resolutionRoots: Array.isArray(data.resolutionRoots) && data.resolutionRoots.length > 0
          ? data.resolutionRoots
          : undefined,
      });

      // Re-arm timeout watcher
      startConsensusTimeout(id);
      process.stderr.write(`[gossipcat] Restored consensus round ${id} — ${data.pendingNativeAgents?.length ?? 0} agents pending\n`);
    }

    // Clean up file after restore
    unlinkSync(filePath);
  } catch { /* best-effort — corrupt file is fine */ }
}
