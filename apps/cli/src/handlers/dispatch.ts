/**
 * Dispatch handler functions — single, parallel, and consensus modes.
 * All state accessed via the shared context object.
 */
import { randomUUID } from 'crypto';
import { CONSENSUS_OUTPUT_FORMAT } from '@gossip/orchestrator';
import { ctx, NATIVE_TASK_TTL_MS } from '../mcp-context';
import { evictStaleNativeTasks, persistNativeTaskMap, spawnTimeoutWatcher } from './native-tasks';
import { persistRelayTasks } from './relay-tasks';

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
    const timeoutMs = timeout_ms ?? NATIVE_TASK_TTL_MS;
    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs, planId: plan_id, step });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    persistNativeTaskMap();

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

    const agentPrompt = [
      nativeConfig.instructions || '',
      chainContext ? `\n${chainContext}\n` : '',
      `\n---\n\nTask: ${task}`,
    ].filter(Boolean).join('').trim();

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

    return { content: [{ type: 'text' as const, text:
      `NATIVE_DISPATCH: Execute this via Claude Code Agent tool, then relay the result.\n\n` +
      `Task ID: ${taskId}\n` +
      `Agent: ${agent_id}\n` +
      `Model: ${nativeConfig.model}\n\n` +
      `Step 1 — Run:\n` +
      `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}${useWorktree ? ', isolation: "worktree"' : ''}, run_in_background: true)\n\n` +
      `Step 2 — REQUIRED after agent completes:\n` +
      `gossip_relay(task_id: "${taskId}", result: "<agent output>")\n\n` +
      `⚠️ You MUST call gossip_relay for every native dispatch. Without it, the result is lost — no memory, no gossip, no consensus. Never skip this step.`
    }] };
  }

  try {
    const { taskId } = ctx.mainAgent.dispatch(agent_id, task, dispatchOptions as any);
    persistRelayTasks(); // Survive MCP reconnects
    const modeLabel = write_mode ? ` [${write_mode}${scope ? `:${scope}` : ''}]` : '';
    return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}${modeLabel}. Task ID: ${taskId}` }] };
  } catch (err: any) {
    process.stderr.write(`[gossipcat] dispatch failed: ${err.message}\n`);
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
    for (const tid of taskIds) {
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
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
  for (const def of nativeTasks) {
    const nativeConfig = ctx.nativeAgentConfigs.get(def.agent_id)!;
    const taskId = randomUUID().slice(0, 8);
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
    persistNativeTaskMap();

    // Register scope with real task ID so subsequent dispatches see it
    if (def.write_mode === 'scoped' && def.scope) {
      ctx.mainAgent.scopeTracker.register(def.scope, taskId);
    }

    const agentPrompt = nativeConfig.instructions
      ? `${nativeConfig.instructions}\n\n---\n\nTask: ${def.task}`
      : def.task;

    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
    nativeInstructions.push(
      `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}${def.write_mode === 'worktree' ? ', isolation: "worktree"' : ''}, run_in_background: true)` +
      `\n  → then: gossip_relay(task_id: "${taskId}", result: "<output>")`
    );
  }

  let msg = `Dispatched ${taskDefs.length} tasks:\n${lines.join('\n')}`;
  if (consensus) msg += '\n\n📋 Consensus mode enabled.';
  if (nativeInstructions.length > 0) {
    msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls in parallel, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
    msg += `\n\n⚠️ You MUST call gossip_relay for EVERY native agent after it completes. Without it, results are lost — no memory, no gossip, no consensus.`;
  }
  return { content: [{ type: 'text' as const, text: msg }] };
}

export async function handleDispatchConsensus(
  taskDefs: Array<{ agent_id: string; task: string }>,
  _utility_task_id?: string,
) {
  await ctx.boot();
  await ctx.syncWorkersViaKeychain();

  for (const def of taskDefs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
      return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
    }
  }

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

  // Native tasks — inject consensus output format into the prompt (same as relay agents via prompt-assembler)
  const consensusInstruction = `\n\n--- CONSENSUS OUTPUT FORMAT ---\n${CONSENSUS_OUTPUT_FORMAT}\n--- END CONSENSUS OUTPUT FORMAT ---`;
  const nativeInstructions: string[] = [];
  for (const def of nativeTasks) {
    const nativeConfig = ctx.nativeAgentConfigs.get(def.agent_id)!;
    const taskId = randomUUID().slice(0, 8);
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
    allTaskIds.push(taskId);
    persistNativeTaskMap();

    const agentPrompt = (nativeConfig.instructions || '') + consensusInstruction + `\n\n---\n\nTask: ${def.task}`;
    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
    nativeInstructions.push(
      `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)` +
      `\n  → then: gossip_relay(task_id: "${taskId}", result: "<output>")`
    );
  }

  let msg = `Dispatched ${taskDefs.length} tasks with consensus:\n${lines.join('\n')}`;
  msg += '\n\nAgents will include ## Consensus Summary in output.';
  msg += `\nCall gossip_collect with task IDs: [${allTaskIds.map(id => `"${id}"`).join(', ')}] and consensus: true`;
  if (nativeInstructions.length > 0) {
    msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
    msg += `\n\n⚠️ You MUST call gossip_relay for EVERY native agent after it completes. Without it, results are lost — no memory, no consensus cross-review.`;
  }
  return { content: [{ type: 'text' as const, text: msg }] };
}
