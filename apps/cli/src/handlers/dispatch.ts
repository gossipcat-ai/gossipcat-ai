/**
 * Dispatch handler functions — single, parallel, and consensus modes.
 * All state accessed via the shared context object.
 */
import { randomUUID } from 'crypto';
import { ctx, generateTaskId, NATIVE_TASK_TTL_MS } from '../mcp-context';
import { evictStaleNativeTasks, persistNativeTaskMap, spawnTimeoutWatcher } from './native-tasks';

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
    evictStaleNativeTasks();
    const taskId = randomUUID().slice(0, 8);
    const timeoutMs = timeout_ms ?? NATIVE_TASK_TTL_MS;
    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs, planId: plan_id, step });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    persistNativeTaskMap();

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
  const nativeTasks: Array<{ agent_id: string; task: string; write_mode?: string }> = [];
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
    for (const tid of taskIds) {
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
    }
    if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
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
) {
  await ctx.boot();
  await ctx.syncWorkersViaKeychain();

  for (const def of taskDefs) {
    if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
      return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
    }
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

  // Dispatch relay tasks with consensus
  if (relayTasks.length > 0) {
    const { taskIds, errors } = await ctx.mainAgent.dispatchParallel(
      relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task })),
      { consensus: true },
    );
    for (const tid of taskIds) {
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
      allTaskIds.push(tid);
    }
    if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
  }

  // Native tasks — inject consensus output format into the prompt (same as relay agents via prompt-assembler)
  const consensusInstruction = `\n\n--- CONSENSUS OUTPUT FORMAT ---
End your response with a section titled "## Consensus Summary".

SOURCE FILES:
- Always cite original source files, NOT compiled/bundled build output (dist/, build/, out/, *.min.js)
- Build artifacts have different line numbers than source — citing them causes false verification failures

CITATION RULES:
- Use <cite> tags to reference code: <cite tag="file">auth.ts:38</cite> or <cite tag="fn">functionName</cite>
- Claims without <cite> tags receive LOW confidence and will likely be marked UNVERIFIED
- Do NOT fabricate file paths or line numbers — broken citations are worse than no citation

FINDING FORMAT:
Wrap each finding in an <agent_finding> tag. Do NOT use bullet points for findings.

<agent_finding type="finding" severity="high">
Missing Secure cookie flag <cite tag="file">routes.ts:126</cite>
</agent_finding>

<agent_finding type="suggestion">
Consider changing SameSite=Lax to SameSite=Strict
</agent_finding>

<agent_finding type="insight">
Session tokens use 256-bit entropy — sufficient for production
</agent_finding>

Types: finding (factual issue, verifiable), suggestion (recommendation), insight (observation/context)
Severity (for findings only): critical, high, medium, low
Do NOT include confirmations or "looks good" statements — only issues and observations.
--- END CONSENSUS OUTPUT FORMAT ---`;
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
