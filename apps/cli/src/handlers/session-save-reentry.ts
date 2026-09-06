/**
 * Convergence resolver for the `gossip_session_save` native-utility loop
 * (GH #745).
 *
 * The documented flow is:
 *
 *   1. `gossip_session_save()`                 → dispatch instruction + task_id
 *   2. run the Agent, then `gossip_relay(task_id, result)`
 *   3. `gossip_session_save(_utility_task_id: task_id)` → "Session saved."
 *
 * Step 3 is the ONLY thing that finalizes the save, and it is entirely
 * dependent on the caller echoing back an opaque id. When that id is dropped,
 * the handler used to fall straight through to the dispatch branch again:
 * the utility task was no longer pending (it had been relayed), so the
 * refuse-gate did not block, and both the stashed session data and the
 * relayed summarizer output were silently ignored. The result was an
 * unbounded dispatch→relay→dispatch loop that never reached "Session saved."
 *
 * This module gives the server its own memory of the in-flight save so
 * convergence no longer depends on the client. It is a pure function over the
 * three pieces of state the handler already keeps, so it can be unit-tested
 * without booting the MCP server.
 */

/** Minimal shape of a `ctx.nativeResultMap` entry that this resolver reads. */
export interface SessionSummaryResultLike {
  status?: string;
  result?: string;
  completedAt?: number;
}

export interface SessionSummaryReentry {
  /**
   * Task id of a session_summary utility that was dispatched, relayed
   * successfully, and never consumed by a re-entry call. The handler should
   * finalize with this instead of dispatching a fresh summarizer.
   */
  adoptTaskId?: string;
  /**
   * Task id of a session_summary utility that was dispatched but whose relay
   * has not landed yet. The handler should re-issue the instruction for THIS
   * id rather than minting a second summarizer for the same save.
   */
  inFlightTaskId?: string;
}

/**
 * Decide whether a `gossip_session_save` call that arrived WITHOUT
 * `_utility_task_id` can be reconciled against an earlier dispatch.
 *
 * @param pendingTaskIds  keys of `_pendingSessionData` — one per dispatched,
 *                        not-yet-finalized session_summary utility task.
 * @param getResult       lookup into `ctx.nativeResultMap`.
 * @param hasPendingTask  lookup into `ctx.nativeTaskMap` (task still awaiting relay).
 *
 * Adoption requires a genuinely completed relay carrying output: a
 * failed/timed-out summarizer is left alone so the existing re-dispatch
 * behaviour still applies to it. When several completed candidates exist the
 * most recently completed one wins.
 */
export function resolveSessionSummaryReentry(args: {
  pendingTaskIds: Iterable<string>;
  getResult: (id: string) => SessionSummaryResultLike | undefined;
  hasPendingTask: (id: string) => boolean;
}): SessionSummaryReentry {
  const { pendingTaskIds, getResult, hasPendingTask } = args;

  let adoptTaskId: string | undefined;
  let adoptCompletedAt = -Infinity;
  let inFlightTaskId: string | undefined;

  for (const id of pendingTaskIds) {
    const result = getResult(id);
    if (result?.status === 'completed' && result.result) {
      const completedAt = typeof result.completedAt === 'number' ? result.completedAt : 0;
      if (completedAt >= adoptCompletedAt) {
        adoptCompletedAt = completedAt;
        adoptTaskId = id;
      }
      continue;
    }
    // No result yet and the task is still armed → the relay is still coming.
    if (!result && hasPendingTask(id) && !inFlightTaskId) inFlightTaskId = id;
  }

  return {
    ...(adoptTaskId ? { adoptTaskId } : {}),
    ...(inFlightTaskId ? { inFlightTaskId } : {}),
  };
}
