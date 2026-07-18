/**
 * Relay task persistence — survives MCP reconnects and process restarts.
 *
 * Relay tasks (dispatched to Gemini workers via WebSocket) are tracked in
 * DispatchPipeline's in-memory Map. If the MCP server restarts, that state
 * is lost. This module mirrors the native-tasks.ts pattern: persist on
 * dispatch, restore as timed_out on boot.
 *
 * Key difference from native tasks: relay tasks hold live AsyncGenerator +
 * Promise handles tied to WebSocket connections. These CANNOT be restored.
 * On boot, relay tasks are marked timed_out with a re-dispatch hint.
 */
import { ctx, NATIVE_TASK_TTL_MS } from '../mcp-context';

export interface RelayTaskRecord {
  id: string;
  agentId: string;
  task: string;
  startedAt: number;
  timeoutMs: number;
  /**
   * Spec docs/specs/2026-04-29-relay-worker-resolution-roots.md — persisted
   * for reconnect symmetry. Note: relay tasks cannot resume after MCP
   * restart (websocket streams are non-restorable; they are marked
   * timed_out below). The field exists so an operator running
   * `gossip_run` to re-dispatch sees the original worktree binding in
   * audit logs / dashboard, and so post-Path-1 follow-ups that gain
   * resume capability inherit the field without a schema change.
   */
  resolutionRoots?: string[];
  /**
   * Local image file paths attached to this dispatch (DispatchOptions.images).
   * Persisted for reconnect/audit symmetry with resolutionRoots — relay tasks
   * do not resume after MCP restart, but the binding stays visible in the
   * dashboard / re-dispatch hint.
   */
  images?: string[];
}

const RELAY_TASK_FILE = 'relay-tasks.json';

/** Persist all in-flight relay task IDs to disk. Called after dispatch and collect. */
export function persistRelayTasks(): void {
  try {
    const { writeFileSync: wf, renameSync: rn, mkdirSync: md } = require('fs');
    const { join: j } = require('path');
    const projectRoot = process.cwd();
    const dir = j(projectRoot, '.gossip');
    md(dir, { recursive: true });

    // Read pipeline tasks via public API — only persist running relay tasks
    if (!ctx.mainAgent?.getRelayTaskRecords) return;
    const allTasks = ctx.mainAgent.getRelayTaskRecords();

    const records: RelayTaskRecord[] = [];
    for (const task of allTasks) {
      // Skip tasks that already have results in nativeResultMap (already handled)
      if (ctx.nativeResultMap.has(task.id)) continue;
      if (ctx.nativeTaskMap.has(task.id)) continue; // native tasks have their own persistence
      records.push({
        id: task.id,
        agentId: task.agentId,
        task: task.task.slice(0, 5000),
        startedAt: task.startedAt,
        timeoutMs: task.timeoutMs,
        // Persist the dispatched resolutionRoots so post-reconnect audit /
        // dashboard rendering can show the worktree binding even after the
        // websocket-bound runtime task is marked timed_out.
        ...(task.resolutionRoots && task.resolutionRoots.length > 0
          ? { resolutionRoots: [...task.resolutionRoots] }
          : {}),
        ...(task.images && task.images.length > 0
          ? { images: [...task.images] }
          : {}),
      });
    }

    // Atomic write: a torn relay-tasks.json (process killed mid-write) makes
    // every subsequent boot re-fail at JSON.parse. Write a sibling tmp file in
    // the same dir, then rename — rename is atomic within a filesystem, so a
    // reader never observes a partial file. Mirrors auth.ts:159-165.
    const dest = j(dir, RELAY_TASK_FILE);
    const tmp = `${dest}.${process.pid}.tmp`;
    wf(tmp, JSON.stringify({ tasks: records }));
    rn(tmp, dest);
  } catch { /* best-effort */ }
}

/**
 * On boot after crash/reconnect: read relay-tasks.json and mark all entries
 * as timed_out. We cannot re-attach to WebSocket streams, so the only
 * recovery is to inform the user and suggest re-dispatch.
 *
 * Restored tasks are injected into nativeResultMap + nativeTaskMap so the
 * existing collect/display path handles them — no changes needed in collect.ts.
 */
export function restoreRelayTasksAsFailed(projectRoot: string): void {
  try {
    const { existsSync: ex, readFileSync: rf, unlinkSync: rm } = require('fs');
    const { join: j } = require('path');
    const filePath = j(projectRoot, '.gossip', RELAY_TASK_FILE);
    if (!ex(filePath)) return;

    let raw: { tasks?: RelayTaskRecord[] };
    try {
      raw = JSON.parse(rf(filePath, 'utf-8'));
    } catch (parseErr) {
      // Corrupt / torn file. The outer catch would swallow this and leave the
      // bad file in place, so it re-throws on every boot. Unlink it (best-effort)
      // so the next boot starts clean.
      try { rm(filePath); } catch { /* ignore */ }
      process.stderr.write(`[gossipcat] Discarded corrupt relay-tasks.json: ${(parseErr as Error).message}\n`);
      return;
    }
    const records: RelayTaskRecord[] = raw.tasks || [];
    const now = Date.now();
    let restored = 0;

    for (const r of records) {
      // Skip if beyond TTL
      if (now - r.startedAt >= NATIVE_TASK_TTL_MS) continue;
      // Skip if already tracked
      if (ctx.nativeResultMap.has(r.id) || ctx.nativeTaskMap.has(r.id)) continue;

      // Inject into nativeTaskMap so collect.ts ID-splitting routes correctly
      ctx.nativeTaskMap.set(r.id, {
        agentId: r.agentId,
        task: r.task,
        startedAt: r.startedAt,
        timeoutMs: r.timeoutMs,
      });

      // Immediately mark as timed_out — we can't resume WebSocket streams
      ctx.nativeResultMap.set(r.id, {
        id: r.id,
        agentId: r.agentId,
        task: r.task,
        status: 'timed_out',
        error: `Relay task lost — MCP server restarted during execution. Re-dispatch with gossip_run to retry.`,
        startedAt: r.startedAt,
        completedAt: now,
      });

      restored++;
      process.stderr.write(`[gossipcat] Relay task ${r.id} (${r.agentId}) restored as timed_out\n`);
    }

    // Consume the file — next boot starts clean
    rm(filePath);

    if (restored > 0) {
      process.stderr.write(`[gossipcat] Restored ${restored} relay task(s) as timed_out\n`);
    }
  } catch { /* corrupt file — start fresh */ }
}
