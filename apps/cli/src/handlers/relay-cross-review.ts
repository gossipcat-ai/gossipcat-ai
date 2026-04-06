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
    const snapshot = { allResults: current.allResults, relayCrossReviewEntries: current.relayCrossReviewEntries, nativeCrossReviewEntries: [...current.nativeCrossReviewEntries] };
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
      });

      const allEntries = [...snapshot.relayCrossReviewEntries, ...snapshot.nativeCrossReviewEntries];
      const report = await engine.synthesizeWithCrossReview(snapshot.allResults, allEntries, consensusId);

      // Persist report
      try {
        const { writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const reportsDir = join(process.cwd(), '.gossip', 'consensus-reports');
        mkdirSync(reportsDir, { recursive: true });
        writeFileSync(join(reportsDir, `${consensusId}.json`), JSON.stringify({
          id: consensusId,
          timestamp: new Date().toISOString(),
          agentCount: report.agentCount,
          rounds: report.rounds,
          confirmed: report.confirmed || [],
          disputed: report.disputed || [],
          unverified: report.unverified || [],
          unique: report.unique || [],
          insights: report.insights || [],
          newFindings: report.newFindings || [],
          timedOut: missingAgents,
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
  try {
    const { ConsensusEngine } = await import('@gossip/orchestrator');
    const parseLlm = ctx.mainAgent.getLlm();
    // parseCrossReviewResponse doesn't call LLM, but ConsensusEngine requires one in config
    const engine = new ConsensusEngine({
      llm: parseLlm || ({ generate: async () => ({ text: '', usage: { inputTokens: 0, outputTokens: 0 } }) } as any),
      registryGet: (id: string) => ctx.mainAgent.getAgentConfig(id),
      projectRoot: process.cwd(),
    });
    const entries = engine.parseCrossReviewResponse(agent_id, result, 50);
    // Filter to round members only — prevents fabricated peerAgentId targeting agents outside the round
    const validPeerIds = new Set(round.allResults.map((r: any) => r.agentId));
    const filtered = entries.filter(e => e.peerAgentId !== agent_id && validPeerIds.has(e.peerAgentId));
    round.nativeCrossReviewEntries.push(...filtered);
  } catch (err) {
    process.stderr.write(`[gossipcat] Failed to parse cross-review from ${agent_id}: ${(err as Error).message}\n`);
  }

  // Persist after each arrival so /mcp reconnect doesn't lose partial cross-reviews
  persistPendingConsensus();

  // Check if all native agents have responded
  if (round.pendingNativeAgents.size > 0) {
    // Extend deadline — each arriving result proves the orchestrator is actively relaying.
    // Without this, the 5-minute timer (started at gossip_collect return) expires before
    // the orchestrator can dispatch Agent() calls and relay all results back.
    const EXTENSION_MS = 300_000; // 5 more minutes from each arrival
    const MAX_TOTAL_MS = 1_800_000; // 30 minutes absolute cap from round creation
    const maxDeadline = round.createdAt + MAX_TOTAL_MS;
    round.deadline = Math.min(Date.now() + EXTENSION_MS, maxDeadline);
    return {
      content: [{
        type: 'text' as const,
        text: `Cross-review from ${agent_id} received. Waiting for ${round.pendingNativeAgents.size} more agent(s): ${[...round.pendingNativeAgents].join(', ')}`,
      }],
    };
  }

  // All agents responded — synthesize
  // Snapshot and delete BEFORE async synthesis to prevent double-synthesis race with timeout
  const synthSnapshot = {
    allResults: round.allResults,
    relayCrossReviewEntries: round.relayCrossReviewEntries,
    nativeCrossReviewEntries: [...round.nativeCrossReviewEntries],
    consensusId: round.consensusId,
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
    });

    const allCrossReviewEntries = [
      ...synthSnapshot.relayCrossReviewEntries,
      ...synthSnapshot.nativeCrossReviewEntries,
    ];

    const report = await engine.synthesizeWithCrossReview(
      synthSnapshot.allResults,
      allCrossReviewEntries,
      synthSnapshot.consensusId,
    );

    // Persist report for dashboard
    try {
      const { writeFileSync, mkdirSync } = require('fs');
      const { join } = require('path');
      const reportsDir = join(process.cwd(), '.gossip', 'consensus-reports');
      mkdirSync(reportsDir, { recursive: true });
      const reportPath = join(reportsDir, `${consensus_id}.json`);
      writeFileSync(reportPath, JSON.stringify({
        id: consensus_id,
        timestamp: new Date().toISOString(),
        agentCount: report.agentCount,
        rounds: report.rounds,
        confirmed: report.confirmed || [],
        disputed: report.disputed || [],
        unverified: report.unverified || [],
        unique: report.unique || [],
        insights: report.insights || [],
        newFindings: report.newFindings || [],
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
        pendingNativeAgents: [...round.pendingNativeAgents],
        nativeCrossReviewEntries: round.nativeCrossReviewEntries,
        deadline: round.deadline,
        createdAt: round.createdAt,
        // Only persist prompts for agents that are still pending — completed ones are done
        nativePrompts: (round.nativePrompts || []).filter(p => round.pendingNativeAgents.has(p.agentId)),
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
        pendingNativeAgents: new Set(data.pendingNativeAgents || []),
        nativeCrossReviewEntries: data.nativeCrossReviewEntries || [],
        deadline: data.deadline,
        createdAt: data.createdAt,
        nativePrompts: data.nativePrompts || [],
      });

      // Re-arm timeout watcher
      startConsensusTimeout(id);
      process.stderr.write(`[gossipcat] Restored consensus round ${id} — ${data.pendingNativeAgents?.length ?? 0} agents pending\n`);
    }

    // Clean up file after restore
    unlinkSync(filePath);
  } catch { /* best-effort — corrupt file is fine */ }
}
