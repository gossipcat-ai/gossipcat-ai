/**
 * Collect handler — polls for results, merges relay + native, runs consensus.
 * All state accessed via the shared context object.
 */
import { ctx } from '../mcp-context';

export async function handleCollect(
  task_ids: string[],
  timeout_ms: number,
  consensus: boolean,
) {
  await ctx.boot();

  // Consensus mode requires explicit task IDs
  if (consensus && (!task_ids || task_ids.length === 0)) {
    return { content: [{ type: 'text' as const, text: 'Error: consensus mode requires explicit task_ids. Pass the IDs returned by gossip_dispatch.' }] };
  }

  const requestedIds = task_ids.length > 0 ? task_ids : undefined;
  // Split requested IDs into relay vs native
  const relayIds = requestedIds?.filter(id => !ctx.nativeResultMap.has(id) && !ctx.nativeTaskMap.has(id));
  const nativeIds = requestedIds?.filter(id => ctx.nativeResultMap.has(id) || ctx.nativeTaskMap.has(id));

  // Step 1: Collect relay results (WITHOUT consensus — we run it after merging natives)
  let relayResults: any[] = [];
  try {
    const idsForRelay = relayIds && relayIds.length > 0 ? relayIds : (!requestedIds ? undefined : []);
    if (!idsForRelay || idsForRelay.length > 0) {
      const collected = await ctx.mainAgent.collect(idsForRelay, timeout_ms);
      relayResults = collected.results || [];
    }
  } catch (err) {
    const message = (err as Error).message;
    process.stderr.write(`[gossipcat] collect failed: ${message}\n`);
    const hasNativeTasks = (nativeIds && nativeIds.length > 0) || (!requestedIds && ctx.nativeTaskMap.size > 0);
    if (!hasNativeTasks) {
      return { content: [{ type: 'text' as const, text: `[ERROR] Failed to collect results: ${message}\n\nRelay may be down. Check gossip_status() for connection state.` }] };
    }
  }

  // Step 2: Wait for pending native tasks (poll until they arrive or timeout)
  const pendingNativeIds = (nativeIds || []).filter(id => ctx.nativeTaskMap.has(id) && !ctx.nativeResultMap.has(id));
  if (!requestedIds) {
    // Also wait for any unspecified pending native tasks
    for (const id of [...ctx.nativeTaskMap.keys()]) {
      if (!ctx.nativeResultMap.has(id) && !pendingNativeIds.includes(id)) {
        pendingNativeIds.push(id);
      }
    }
  }

  if (pendingNativeIds.length > 0 && !consensus) {
    process.stderr.write(`[gossipcat] ${pendingNativeIds.length} native agent(s) still running — results will show as 'running'. Use consensus: true to wait.\n`);
  }

  if (pendingNativeIds.length > 0 && consensus) {
    const POLL_INTERVAL = 2000;
    const HEARTBEAT_INTERVAL = 10000;
    const nativeTimeout = timeout_ms;
    const deadline = Date.now() + nativeTimeout;
    const waitStart = Date.now();
    let lastHeartbeat = 0;
    process.stderr.write(`[gossipcat] Waiting for ${pendingNativeIds.length} native agent(s) before consensus...\n`);

    while (Date.now() < deadline) {
      const stillPending = pendingNativeIds.filter(id => !ctx.nativeResultMap.has(id) && ctx.nativeTaskMap.has(id));
      if (stillPending.length === 0) break;

      // Heartbeat every 10 seconds with per-agent status
      const elapsed = Date.now() - waitStart;
      if (elapsed - lastHeartbeat >= HEARTBEAT_INTERVAL) {
        lastHeartbeat = elapsed;
        const doneCount = pendingNativeIds.length - stillPending.length;
        const agentStatus = pendingNativeIds.map(id => {
          const info = ctx.nativeTaskMap.get(id);
          const agentId = info?.agentId || id;
          if (ctx.nativeResultMap.has(id)) return `${agentId}: done`;
          const running = info ? Math.round((Date.now() - info.startedAt) / 1000) : 0;
          return `${agentId}: running ${running}s`;
        }).join(', ');
        process.stderr.write(`[gossipcat] Consensus: ${doneCount}/${pendingNativeIds.length} agents complete (${agentStatus})\n`);
      }

      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }

    const arrived = pendingNativeIds.filter(id => ctx.nativeResultMap.has(id)).length;
    const timedOutCount = pendingNativeIds.filter(id => {
      const r = ctx.nativeResultMap.get(id);
      return r?.status === 'timed_out';
    }).length;
    const stillPending = pendingNativeIds.length - arrived;
    if (stillPending > 0) {
      process.stderr.write(`[gossipcat] ${stillPending} native agent(s) didn't respond, ${timedOutCount} timed out, ${arrived - timedOutCount} arrived\n`);
    } else {
      process.stderr.write(`[gossipcat] All ${arrived} native agent(s) arrived${timedOutCount > 0 ? ` (${timedOutCount} via timeout)` : ''}\n`);
    }
  }

  // Step 3: Merge relay + native results
  const allResults = [...relayResults];
  const collectNativeIds = nativeIds || (!requestedIds ? [...ctx.nativeResultMap.keys(), ...ctx.nativeTaskMap.keys()].filter((id, i, arr) => arr.indexOf(id) === i) : []);
  for (const id of collectNativeIds) {
    const nr = ctx.nativeResultMap.get(id);
    if (nr) {
      allResults.push(nr);
      ctx.nativeResultMap.delete(id); // consumed
      ctx.nativeTaskMap.delete(id); // clean up — result has been delivered
    } else if (ctx.nativeTaskMap.has(id)) {
      allResults.push({ id, agentId: ctx.nativeTaskMap.get(id)!.agentId, task: ctx.nativeTaskMap.get(id)!.task, status: 'running' as const });
    }
  }

  if (allResults.length === 0) {
    return { content: [{ type: 'text' as const, text: requestedIds ? 'No matching tasks.' : 'No pending tasks.' }] };
  }

  // Step 3.5: Auto-signal on failed/timeout/empty results
  // Only flag truly empty responses (no content at all), not valid short answers
  try {
    const failedResults = allResults.filter((r: any) =>
      r.status === 'failed' ||
      r.status === 'timed_out' ||
      (r.status === 'completed' && (!r.result || r.result.trim().length === 0))
    );
    if (failedResults.length > 0) {
      const { PerformanceWriter } = await import('@gossip/orchestrator');
      const writer = new PerformanceWriter(process.cwd());
      const timestamp = new Date().toISOString();
      const autoSignals = failedResults.map((r: any) => ({
        type: 'consensus' as const,
        taskId: r.id || '',
        // Use disagreement for empty/timeout (reliability failure), hallucination only for actual errors
        signal: (r.status === 'failed' ? 'disagreement' : 'unique_unconfirmed') as const,
        agentId: r.agentId,
        evidence: r.status === 'failed' ? `Task failed: ${r.error || 'unknown error'}`
          : r.status === 'timed_out' ? 'Task timed out — no response'
          : 'Empty response — agent produced no output',
        timestamp,
      }));
      writer.appendSignals(autoSignals);
      process.stderr.write(`[gossipcat] Auto-recorded ${autoSignals.length} failure signal(s): ${autoSignals.map((s: any) => s.agentId).join(', ')}\n`);
    }
  } catch { /* best-effort */ }

  // Step 4: Run consensus on merged results (relay + native together)
  let consensusReport: any = undefined;
  // MIN_AGENTS_FOR_CONSENSUS = 2 (see @gossip/orchestrator/types)
  if (consensus && allResults.filter((r: any) => r.status === 'completed').length >= 2) {
    consensusReport = await ctx.mainAgent.runConsensus(allResults);
  }

  // Auto-persist confirmed findings to implementation-findings.jsonl
  let provisionalSignalCount = 0;
  if (consensusReport) {
    try {
      const { appendFileSync: af, mkdirSync: md } = require('fs');
      const { join: j } = require('path');
      const findingsPath = j(process.cwd(), '.gossip', 'implementation-findings.jsonl');
      md(j(process.cwd(), '.gossip'), { recursive: true });
      const timestamp = new Date().toISOString();

      const findingsToSave = [
        ...(consensusReport.confirmed || []),
        ...(consensusReport.unique || []).filter((f: any) => f.confidence >= 3),
      ];

      for (const f of findingsToSave) {
        const entry = {
          timestamp,
          taskId: f.id || null,
          originalAgentId: f.originalAgentId,
          confirmedBy: f.confirmedBy || [],
          finding: f.finding,
          tag: f.tag || 'confirmed',
          confidence: f.confidence || 0,
          status: 'open',
        };
        af(findingsPath, JSON.stringify(entry) + '\n');
      }

      if (findingsToSave.length > 0) {
        process.stderr.write(`[gossipcat] Auto-persisted ${findingsToSave.length} consensus findings to implementation-findings.jsonl\n`);
      }
    } catch { /* best-effort */ }

    // Auto-record provisional signals for consensus findings NOT already covered by engine signals
    try {
      const { PerformanceWriter } = await import('@gossip/orchestrator');
      const writer = new PerformanceWriter(process.cwd());
      const timestamp = new Date().toISOString();

      const tagToSignal: Record<string, string> = {
        confirmed: 'unique_confirmed',
        disputed: 'disagreement',
        unverified: 'unique_unconfirmed',
        unique: 'unique_unconfirmed',
      };

      // Build set of agents already signaled by the consensus engine
      const alreadySignaled = new Set<string>();
      for (const s of (consensusReport.signals || [])) {
        alreadySignaled.add(s.agentId);
      }

      const allFindings = [
        ...(consensusReport.confirmed || []),
        ...(consensusReport.disputed || []),
        ...(consensusReport.unverified || []),
        ...(consensusReport.unique || []),
      ];

      // Only record provisional signals for finding authors NOT already covered
      const provisionalSignals = allFindings
        .filter((f: any) => !alreadySignaled.has(f.originalAgentId))
        .map((f: any) => ({
          type: 'consensus' as const,
          taskId: f.id || '',
          signal: tagToSignal[f.tag] || 'unique_unconfirmed',
          agentId: f.originalAgentId,
          evidence: `[provisional] ${(f.finding || '').slice(0, 200)}`,
          timestamp,
        }));

      if (provisionalSignals.length > 0) {
        writer.appendSignals(provisionalSignals);
        provisionalSignalCount = provisionalSignals.length;
        process.stderr.write(`[gossipcat] Auto-recorded ${provisionalSignalCount} provisional signal(s). Retract incorrect ones with gossip_signals(action: "retract").\n`);
      }
    } catch { /* best-effort */ }
  }

  // Step 5: Format output
  const resultTexts = allResults.map((t: any) => {
    const dur = t.completedAt && t.startedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
    const modeTag = t.writeMode ? ` [${t.writeMode}${t.scope ? `:${t.scope}` : ''}]` : '';
    const nativeTag = ctx.nativeAgentConfigs.has(t.agentId) ? ' (native)' : '';
    let text: string;
    if (t.status === 'completed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}):\n${t.result}`;
    else if (t.status === 'failed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}): ERROR: ${t.error}\n  → Re-dispatch with gossip_run, or check agent logs in .gossip/agents/${t.agentId}/`;
    else if (t.status === 'timed_out') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (timed out): ${t.error}\n  → Re-dispatch with gossip_run to retry.`;
    else text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag}: still running...`;

    if (t.worktreeInfo) {
      text += `\n📁 Worktree: ${t.worktreeInfo.path} (branch: ${t.worktreeInfo.branch})`;
    }
    if (t.skillWarnings?.length) {
      text += `\n\n⚠️ Skill coverage gaps:\n${t.skillWarnings.map((w: string) => `  - ${w}`).join('\n')}`;
    }
    return text;
  });

  let output = resultTexts.join('\n\n---\n\n');

  if (consensusReport?.summary) {
    output += '\n\n' + consensusReport.summary;
  }

  if (provisionalSignalCount > 0) {
    output += `\n\n📊 ${provisionalSignalCount} provisional signals auto-recorded. Retract incorrect ones with gossip_signals(action: "retract", agent_id, reason).`;
  }

  if (!consensusReport?.summary && consensus) {
    const completedCount = allResults.filter((r: any) => r.status === 'completed' && r.result).length;
    if (completedCount >= 2) {
      // No automated cross-review — Claude Code will synthesize
      output += '\n\n---\n\nCross-reference the findings above. Identify: CONFIRMED (both agents agree), DISPUTED (they disagree), UNIQUE (only one found it), and any NEW insights from comparing their perspectives.';
    } else {
      output += '\n\n⚠️ Need ≥2 successful agents for consensus.';
    }
  }

  try {
    const { SkillGapTracker } = await import('@gossip/orchestrator');
    const tracker = new SkillGapTracker(process.cwd());
    const thresholds = tracker.checkThresholds();
    if (thresholds.count > 0) {
      output += `\n\n🔧 ${thresholds.count} skill(s) ready to build. Call gossip_skills(action: "build") to generate them.`;
    }
  } catch { /* best-effort */ }

  // Auto skill gap suggestions: detect agents weak in categories where peers are strong
  try {
    const suggestions = ctx.mainAgent.getSkillGapSuggestions();
    if (suggestions.length > 0) {
      output += `\n\n📊 Skill gap detected:\n${suggestions.map((s: string) => `  - ${s}`).join('\n')}`;
    }
  } catch { /* best-effort */ }

  // Session save reminder — only every 10th task completion to avoid nagging
  try {
    const taskCount = ctx.mainAgent.getSessionGossip().length;
    const consensusCount = ctx.mainAgent.getSessionConsensusHistory().length;
    if (taskCount > 0 && taskCount % 10 === 0) {
      output += `\n\n💡 Active session (${taskCount} tasks, ${consensusCount} consensus runs). Call gossip_session_save() before ending to preserve what you've learned.`;
    }
  } catch { /* best-effort */ }

  return { content: [{ type: 'text' as const, text: output }] };
}
