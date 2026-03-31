/**
 * Native task lifecycle — eviction, persistence, restore, relay handling.
 * All state accessed via the shared context object.
 */
import { ctx, NATIVE_TASK_TTL_MS, presetScores } from '../mcp-context';

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
  } catch { /* best-effort */ }
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
        if (now - info.startedAt < NATIVE_TASK_TTL_MS && !ctx.nativeTaskMap.has(id)) {
          ctx.nativeTaskMap.set(id, info);
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

  const taskInfo = ctx.nativeTaskMap.get(task_id);
  if (!taskInfo) {
    return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_dispatch or gossip_run?` }] };
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
  try { ctx.mainAgent.recordNativeTaskCompleted(task_id, result, error || undefined); } catch { /* best-effort */ }

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
      const scores = presetScores(agentMeta.preset);
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
