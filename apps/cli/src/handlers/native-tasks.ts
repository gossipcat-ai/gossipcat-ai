/**
 * Native task lifecycle — eviction, persistence, restore, relay handling.
 * All state accessed via the shared context object.
 */
import { ctx, NATIVE_TASK_TTL_MS, defaultImportanceScores } from '../mcp-context';

/** Active timeout watchers — keyed by task ID */
const timeoutWatchers: Map<string, ReturnType<typeof setTimeout>> = new Map();

/**
 * Spawn a timeout watcher for a native task.
 * INVARIANT: On timeout, writes timed_out to nativeResultMap. Does NOT delete from nativeTaskMap.
 * The collect polling loop depends on nativeTaskMap entries persisting until real relay or TTL eviction.
 */
export function spawnTimeoutWatcher(taskId: string, info: { agentId: string; task: string; startedAt: number; timeoutMs?: number }): void {
  const timeoutMs = info.timeoutMs ?? NATIVE_TASK_TTL_MS;
  const elapsed = Date.now() - info.startedAt;
  const remaining = Math.max(timeoutMs - elapsed, 0);

  const existing = timeoutWatchers.get(taskId);
  if (existing) clearTimeout(existing);

  if (remaining <= 0) {
    markTimedOut(taskId, info, timeoutMs);
    return;
  }

  const timer = setTimeout(() => {
    timeoutWatchers.delete(taskId);
    if (ctx.nativeTaskMap.has(taskId) && !ctx.nativeResultMap.has(taskId)) {
      markTimedOut(taskId, info, timeoutMs);
    }
  }, remaining);

  if (timer.unref) timer.unref();
  timeoutWatchers.set(taskId, timer);
}

function markTimedOut(taskId: string, info: { agentId: string; task: string; startedAt: number }, timeoutMs: number): void {
  ctx.nativeResultMap.set(taskId, {
    id: taskId,
    agentId: info.agentId,
    task: info.task,
    status: 'timed_out',
    error: `Timed out after ${timeoutMs}ms — agent may have crashed or forgotten gossip_relay. Re-dispatch with gossip_run to retry.`,
    startedAt: info.startedAt,
    completedAt: Date.now(),
  });
  persistNativeTaskMap();
  recordTimeoutSignal(taskId, info.agentId);
}

export function cancelTimeoutWatcher(taskId: string): void {
  const timer = timeoutWatchers.get(taskId);
  if (timer) {
    clearTimeout(timer);
    timeoutWatchers.delete(taskId);
  }
}

function recordTimeoutSignal(taskId: string, agentId: string): void {
  try {
    const { PerformanceWriter } = require('@gossip/orchestrator');
    const writer = new PerformanceWriter(process.cwd());
    writer.appendSignals([{
      type: 'consensus' as const,
      taskId,
      signal: 'disagreement' as const,
      agentId,
      evidence: 'Native agent timed out — no gossip_relay call received',
      timestamp: new Date().toISOString(),
    }]);
    process.stderr.write(`[gossipcat] Auto-recorded timeout signal for ${agentId} [${taskId}]\n`);
  } catch { /* best-effort */ }
}

/** Evict stale entries from nativeTaskMap and nativeResultMap */
export function evictStaleNativeTasks(): void {
  const now = Date.now();
  let changed = false;
  for (const [id, info] of [...ctx.nativeTaskMap]) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) { ctx.nativeTaskMap.delete(id); changed = true; }
  }
  for (const [id, info] of [...ctx.nativeResultMap]) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) { ctx.nativeResultMap.delete(id); changed = true; }
  }
  if (changed) persistNativeTaskMap();
}

/** Persist nativeTaskMap to disk so /mcp reconnects don't lose task IDs */
export function persistNativeTaskMap(): void {
  try {
    const projectRoot = ctx.mainAgent?.projectRoot;
    if (!projectRoot) return;
    const { writeFileSync: wf, mkdirSync: md } = require('fs');
    const { join: j } = require('path');
    const dir = j(projectRoot, '.gossip');
    md(dir, { recursive: true });
    // Strip full result/error text from results to keep file small — only persist metadata
    const slimResults: Record<string, any> = {};
    for (const [id, info] of ctx.nativeResultMap) {
      slimResults[id] = {
        id: info.id, agentId: info.agentId, task: info.task.slice(0, 5000), // cap on-disk only — full task stays in memory
        status: info.status, startedAt: info.startedAt, completedAt: info.completedAt, error: info.error,
      };
    }
    const data = {
      tasks: Object.fromEntries([...ctx.nativeTaskMap]),
      results: slimResults,
    };
    wf(j(dir, 'native-tasks.json'), JSON.stringify(data));
  } catch (err) {
    process.stderr.write(`[gossipcat] persistNativeTaskMap failed: ${(err as Error).message}\n`);
  }
}

/** Restore nativeTaskMap from disk (called on boot) */
export function restoreNativeTaskMap(projectRoot: string): void {
  try {
    const { existsSync: ex, readFileSync: rf } = require('fs');
    const { join: j } = require('path');
    const filePath = j(projectRoot, '.gossip', 'native-tasks.json');
    if (!ex(filePath)) return;
    const raw = JSON.parse(rf(filePath, 'utf-8'));
    const now = Date.now();
    if (raw.tasks) {
      for (const [id, info] of Object.entries(raw.tasks) as [string, any][]) {
        if (now - info.startedAt >= NATIVE_TASK_TTL_MS) continue;
        if (ctx.nativeTaskMap.has(id)) continue;
        if (ctx.nativeResultMap.has(id)) continue;

        ctx.nativeTaskMap.set(id, info);

        const timeoutMs = info.timeoutMs ?? NATIVE_TASK_TTL_MS;
        const elapsed = now - info.startedAt;

        if (elapsed >= timeoutMs) {
          ctx.nativeResultMap.set(id, {
            id, agentId: info.agentId, task: info.task,
            status: 'timed_out' as const,
            error: `Timed out after MCP reconnect — ${elapsed}ms elapsed, limit was ${timeoutMs}ms`,
            startedAt: info.startedAt, completedAt: now,
          });
          process.stderr.write(`[gossipcat] Restored task ${id} already expired — marked timed_out\n`);
        } else {
          spawnTimeoutWatcher(id, { agentId: info.agentId, task: info.task, startedAt: info.startedAt, timeoutMs });
          process.stderr.write(`[gossipcat] Restored task ${id} — re-armed timeout (${Math.round((timeoutMs - elapsed) / 1000)}s remaining)\n`);
        }
      }
    }
    if (raw.results) {
      for (const [id, info] of Object.entries(raw.results) as [string, any][]) {
        if (now - info.startedAt < NATIVE_TASK_TTL_MS && !ctx.nativeResultMap.has(id)) {
          ctx.nativeResultMap.set(id, info);
        }
      }
    }
  } catch { /* best-effort — corrupt file is fine, just start fresh */ }
}

/** Handle native agent relay — feed Agent tool results back into pipeline */
export async function handleNativeRelay(task_id: string, result: string, error?: string) {
  await ctx.boot(); // [H3 fix] ensure mainAgent/pipeline are available

  // Cancel timeout watcher if still running
  cancelTimeoutWatcher(task_id);

  // Late relay wins: check nativeTaskMap first, then fall back to timed_out result
  let taskInfo = ctx.nativeTaskMap.get(task_id);
  if (!taskInfo) {
    const timedOutResult = ctx.nativeResultMap.get(task_id);
    if (timedOutResult && timedOutResult.status === 'timed_out') {
      taskInfo = { agentId: timedOutResult.agentId, task: timedOutResult.task, startedAt: timedOutResult.startedAt };
      process.stderr.write(`[gossipcat] Late relay for ${task_id} — overwriting timed_out result with real data\n`);
      // Retract the timeout signal — agent completed successfully, don't penalize
      try {
        const { PerformanceWriter } = require('@gossip/orchestrator');
        const writer = new PerformanceWriter(process.cwd());
        writer.appendSignals([{
          type: 'consensus' as const,
          signal: 'signal_retracted' as const,
          agentId: taskInfo.agentId,
          taskId: task_id,
          evidence: 'Late relay arrived — agent completed successfully after timeout',
          timestamp: new Date().toISOString(),
        }]);
        process.stderr.write(`[gossipcat] Retracted timeout signal for ${taskInfo.agentId} [${task_id}]\n`);
      } catch { /* best-effort */ }
    } else {
      return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_dispatch or gossip_run?` }] };
    }
  }

  // Move to result map BEFORE running pipeline — prevents data loss if pipeline crashes
  const elapsed = Date.now() - taskInfo.startedAt;
  ctx.nativeTaskMap.delete(task_id);
  ctx.nativeResultMap.set(task_id, {
    id: task_id, agentId: taskInfo.agentId, task: taskInfo.task,
    status: error ? 'failed' : 'completed',
    result: error ? undefined : (result ? result.slice(0, 50000) : result), // intentional 50k cap — memory protection
    error: error || undefined,
    startedAt: taskInfo.startedAt, completedAt: Date.now(),
  });
  persistNativeTaskMap();
  evictStaleNativeTasks();

  // Run the same post-collect pipeline as custom agents:
  // 1. Memory write  2. Knowledge extraction  3. Gossip  4. Compaction
  const agentId = taskInfo.agentId;
  const agentMeta = (() => {
    try {
      const a = ctx.mainAgent.getAgentList().find((a: any) => a.id === agentId);
      return { skills: a?.skills || [], preset: a?.preset || '' };
    } catch { return { skills: [] as string[], preset: '' }; }
  })();

  // 0. Record in TaskGraph (makes native tasks visible to CLI + Supabase sync)
  try { ctx.mainAgent.recordNativeTaskCompleted(task_id, result, error || undefined, elapsed); } catch { /* best-effort */ }

  // 0b. Record plan step result so subsequent steps get chain context
  if (taskInfo.planId && taskInfo.step && !error) {
    try { ctx.mainAgent.recordPlanStepResult(taskInfo.planId, taskInfo.step, result); } catch { /* best-effort */ }
  }

  if (!error) {
    // 1. Write task entry to memory
    try {
      const { MemoryWriter, MemoryCompactor } = await import('@gossip/orchestrator');
      const memWriter = new MemoryWriter(process.cwd());
      // Wire LLM for cognitive summaries — same as relay agents get
      try { if (ctx.mainAgent.getLLM()) memWriter.setSummaryLlm(ctx.mainAgent.getLLM()); } catch {}
      const scores = defaultImportanceScores();
      await memWriter.writeTaskEntry(agentId, {
        taskId: task_id,
        task: taskInfo.task,
        skills: agentMeta.skills,
        scores,
      });

      // 2. Extract knowledge from result (files, tech, decisions)
      if (result) {
        await memWriter.writeKnowledgeFromResult(agentId, {
          taskId: task_id, task: taskInfo.task, result,
        });
      }

      memWriter.rebuildIndex(agentId);

      // 3. Compact memory if needed
      const compactor = new MemoryCompactor(process.cwd());
      compactor.compactIfNeeded(agentId);
    } catch (err) {
      process.stderr.write(`[gossipcat] Memory write failed for ${agentId}: ${(err as Error).message}\n`);
    }
  }

  // 4. Publish gossip so other running agents can see this result
  if (!error) {
    await ctx.mainAgent.publishNativeGossip(agentId, result.slice(0, 50000)).catch(() => {}); // intentional 50k cap — memory protection
  }

  // Result already stored in nativeResultMap at top of handler (crash-safe)

  const status = error ? `failed (${elapsed}ms): ${error}` : `completed (${elapsed}ms)`;
  return { content: [{ type: 'text' as const, text: `Result relayed for ${agentId} [${task_id}]: ${status}\n\nThe result is now available for gossip_collect and consensus cross-review.` }] };
}
