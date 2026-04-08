/**
 * Dispatch handler functions — single, parallel, and consensus modes.
 * All state accessed via the shared context object.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CONSENSUS_OUTPUT_FORMAT, loadSkills } from '@gossip/orchestrator';
import { ctx, NATIVE_TASK_TTL_MS } from '../mcp-context';
import { evictStaleNativeTasks, persistNativeTaskMap, spawnTimeoutWatcher } from './native-tasks';
import { persistRelayTasks } from './relay-tasks';
import {
  prependScopeNote,
  recordDispatchMetadata,
  relativizeProjectPaths,
  readSandboxMode,
  shouldSanitize,
} from '../sandbox';

function agentPreset(agentId: string): string | undefined {
  try {
    return ctx.mainAgent.getAgentList?.().find((a: any) => a.id === agentId)?.preset;
  } catch {
    return undefined;
  }
}

/** Sanitize a task string and return the rewritten text. Honors sandboxEnforcement=off. */
function maybeSanitizeTask(
  task: string,
  writeMode: 'sequential' | 'scoped' | 'worktree' | undefined,
  agentId: string,
): { task: string; sanitized: boolean; replacements: number } {
  const projectRoot = process.cwd();
  const mode = readSandboxMode(projectRoot);
  if (mode === 'off') return { task, sanitized: false, replacements: 0 };
  if (!shouldSanitize(writeMode, agentPreset(agentId))) {
    return { task, sanitized: false, replacements: 0 };
  }
  const { sanitized, replacements } = relativizeProjectPaths(task, projectRoot);
  if (replacements > 0) {
    process.stderr.write(
      `[gossipcat] 🧹 sanitized ${replacements} project path(s) in task for ${agentId}\n`,
    );
  }
  return { task: sanitized, sanitized: true, replacements };
}

// Quota-based fallback routing for relay agents
const QUOTA_FALLBACK_MAP: Record<string, string> = {
  'gemini-reviewer':    'sonnet-reviewer',
  'gemini-tester':      'haiku-researcher',
  'gemini-implementer': 'sonnet-implementer',
};

// Provider lookup: derives provider name from agent ID prefix (e.g. "gemini-*" → "google")
const AGENT_PROVIDER_MAP: Record<string, string> = {
  gemini: 'google',
};

function readQuotaState(): Record<string, { exhaustedUntil?: number }> {
  try {
    const raw = readFileSync(join(process.cwd(), '.gossip', 'quota-state.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isProviderExhausted(provider: string, quotaState: Record<string, { exhaustedUntil?: number }>): boolean {
  const entry = quotaState[provider];
  return !!(entry?.exhaustedUntil && entry.exhaustedUntil > Date.now());
}

function reroutableAgent(agentId: string): string {
  const fallback = QUOTA_FALLBACK_MAP[agentId];
  if (!fallback) return agentId;

  // Determine provider from agent ID prefix
  const prefix = agentId.split('-')[0];
  const provider = AGENT_PROVIDER_MAP[prefix];
  if (!provider) return agentId;

  const quotaState = readQuotaState();
  if (isProviderExhausted(provider, quotaState)) {
    process.stderr.write(`[gossipcat] ⚠️  quota fallback: ${agentId} → ${fallback}\n`);
    return fallback;
  }
  return agentId;
}

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

  // Quota fallback: reroute exhausted relay agents to native equivalents
  agent_id = reroutableAgent(agent_id);

  // Sandbox mitigation 1: sanitize project paths in the task prompt
  const sanitizeResult = maybeSanitizeTask(task, write_mode, agent_id);
  task = sanitizeResult.task;

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
    const relayToken = randomUUID().slice(0, 12);
    const timeoutMs = timeout_ms ?? NATIVE_TASK_TTL_MS;
    ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs, planId: plan_id, step, writeMode: write_mode, relayToken });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    persistNativeTaskMap();
    process.stderr.write(`[gossipcat] → dispatch → ${agent_id} (${nativeConfig.model}) [${taskId}]\n`);

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

    const skillResult = loadSkills(
      agent_id,
      nativeConfig.skills,
      process.cwd(),
      ctx.mainAgent.getSkillIndex() ?? undefined,
      task,
    );

    let agentPrompt = [
      nativeConfig.instructions || '',
      skillResult.content,
      chainContext ? `\n${chainContext}\n` : '',
      `\n---\n\nTask: ${task}`,
    ].filter(Boolean).join('').trim();
    const MAX_AGENT_PROMPT_CHARS = 30_000;
    if (agentPrompt.length > MAX_AGENT_PROMPT_CHARS) {
      agentPrompt = agentPrompt.slice(0, MAX_AGENT_PROMPT_CHARS) + '\n\n[Context truncated to fit budget]';
    }
    if (sanitizeResult.sanitized) agentPrompt = prependScopeNote(agentPrompt);

    // Record dispatch metadata for the post-task audit
    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: agent_id,
      writeMode: write_mode,
      scope,
      timestamp: Date.now(),
    });

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
      `gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<agent output>")\n\n` +
      `⚠️ You MUST call gossip_relay for every native dispatch. Without it, the result is lost — no memory, no gossip, no consensus. Never skip this step.`
    }] };
  }

  try {
    const { taskId } = ctx.mainAgent.dispatch(agent_id, task, dispatchOptions as any);
    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: agent_id,
      writeMode: write_mode,
      scope,
      timestamp: Date.now(),
    });
    persistRelayTasks(); // Survive MCP reconnects
    const modeLabel = write_mode ? ` [${write_mode}${scope ? `:${scope}` : ''}]` : '';
    return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}${modeLabel}. Task ID: ${taskId}` }] };
  } catch (err: any) {
    process.stderr.write(`[gossipcat] ❌ dispatch failed: ${err.message}\n`);
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

  // Quota fallback: reroute exhausted relay agents to native equivalents
  taskDefs = taskDefs.map(def => ({ ...def, agent_id: reroutableAgent(def.agent_id) }));

  // Sandbox mitigation 1: sanitize each task's project paths
  taskDefs = taskDefs.map(def => {
    const s = maybeSanitizeTask(def.task, def.write_mode as any, def.agent_id);
    return { ...def, task: s.task, _sandboxSanitized: s.sanitized } as any;
  });

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
    for (let i = 0; i < taskIds.length; i++) {
      const tid = taskIds[i];
      const def = relayTasks[i];
      const t = ctx.mainAgent.getTask(tid);
      lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
      if (def) {
        recordDispatchMetadata(process.cwd(), {
          taskId: tid,
          agentId: def.agent_id,
          writeMode: def.write_mode as any,
          scope: def.scope,
          timestamp: Date.now(),
        });
      }
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
    const relayToken = randomUUID().slice(0, 12);
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
    persistNativeTaskMap();
    process.stderr.write(`[gossipcat] dispatch → ${def.agent_id} (${nativeConfig.model}) [${taskId}]\n`);

    // Register scope with real task ID so subsequent dispatches see it
    if (def.write_mode === 'scoped' && def.scope) {
      ctx.mainAgent.scopeTracker.register(def.scope, taskId);
    }

    const skillResultP = loadSkills(
      def.agent_id,
      nativeConfig.skills,
      process.cwd(),
      ctx.mainAgent.getSkillIndex() ?? undefined,
      def.task,
    );

    let agentPrompt = [
      nativeConfig.instructions || '',
      skillResultP.content,
      `\n---\n\nTask: ${def.task}`,
    ].filter(Boolean).join('').trim();
    const MAX_AGENT_PROMPT_CHARS = 30_000;
    if (agentPrompt.length > MAX_AGENT_PROMPT_CHARS) {
      agentPrompt = agentPrompt.slice(0, MAX_AGENT_PROMPT_CHARS) + '\n\n[Context truncated to fit budget]';
    }
    if ((def as any)._sandboxSanitized) agentPrompt = prependScopeNote(agentPrompt);

    recordDispatchMetadata(process.cwd(), {
      taskId,
      agentId: def.agent_id,
      writeMode: def.write_mode as any,
      scope: def.scope,
      timestamp: Date.now(),
    });

    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
    nativeInstructions.push(
      `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}${def.write_mode === 'worktree' ? ', isolation: "worktree"' : ''}, run_in_background: true)` +
      `\n  → then: gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<output>")`
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

  // Quota fallback: reroute exhausted relay agents to native equivalents
  taskDefs = taskDefs.map(def => ({ ...def, agent_id: reroutableAgent(def.agent_id) }));

  // Sandbox mitigation 1: sanitize project paths (applies when agent preset is implementer)
  taskDefs = taskDefs.map(def => {
    const s = maybeSanitizeTask(def.task, undefined, def.agent_id);
    return { ...def, task: s.task, _sandboxSanitized: s.sanitized } as any;
  });

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

  // Generate differentiation lenses if not already provided via re-entry
  if (!precomputedLenses) {
    try {
      const LENS_TIMEOUT_MS = 5000;
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const lensPromise = ctx.mainAgent.generateLensesForAgents(
        taskDefs.map((d: { agent_id: string; task: string }) => ({ agentId: d.agent_id, task: d.task })),
      );
      // Prevent unhandled rejection if timeout wins and lens generation later rejects
      lensPromise.catch(() => {});
      const lenses = await Promise.race([
        lensPromise,
        new Promise<null>((resolve) => {
          timerId = setTimeout(() => resolve(null), LENS_TIMEOUT_MS);
        }),
      ]);
      if (timerId) clearTimeout(timerId);
      if (lenses && lenses.size > 0) {
        precomputedLenses = lenses;
        process.stderr.write(`[gossipcat] 🔍 Generated ${lenses.size} differentiation lenses for consensus\n`);
      }
    } catch (err: any) {
      process.stderr.write(`[gossipcat] ❌ lens generation failed: ${err.message}\n`);
    }
  }

  // NOTE: Selective consensus optimization removed — when the user explicitly invokes
  // mode:"consensus" with N tasks, all N must run. The previous shortcut would silently
  // drop tasks when one agent had categoryStrengths >= 0.8, defeating the user's intent
  // to get cross-validation. Selective routing belongs in `gossip_run(agent_id:"auto")`
  // where the orchestrator picks one agent on purpose, not in explicit consensus dispatch.

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
    const relayToken = randomUUID().slice(0, 12);
    ctx.nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    try { ctx.mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
    allTaskIds.push(taskId);
    persistNativeTaskMap();
    process.stderr.write(`[gossipcat] dispatch → ${def.agent_id} (${nativeConfig.model}) [${taskId}]\n`);

    const rawLens = precomputedLenses?.get(def.agent_id);
    const lensSection = rawLens
      ? `\n\n--- LENS ---\n${rawLens.replace(/---\s*(END )?LENS\s*---/gi, '')}\n--- END LENS ---`
      : '';

    const skillResultC = loadSkills(
      def.agent_id,
      nativeConfig.skills,
      process.cwd(),
      ctx.mainAgent.getSkillIndex() ?? undefined,
      def.task,
    );

    // Truncation reserves CONSENSUS_OUTPUT_FORMAT + lens + task — those must survive
    // or the agent will emit prose instead of <agent_finding> tags (silent consensus
    // round degradation). Per bench review finding 12827629-fa9a4660:f8, the old
    // behavior concatenated everything THEN truncated, which could sever the format
    // block entirely when skill content was large. Now we apply the cap only to the
    // [instructions + skills] prefix and always append consensusInstruction + lens +
    // task at full length afterward.
    const MAX_AGENT_PROMPT_CHARS = 30_000;
    const suffix = consensusInstruction + lensSection + `\n\n---\n\nTask: ${def.task}`;
    const prefixBudget = Math.max(0, MAX_AGENT_PROMPT_CHARS - suffix.length);
    let prefix = [
      nativeConfig.instructions || '',
      skillResultC.content,
    ].filter(Boolean).join('');
    if (prefix.length > prefixBudget) {
      prefix = prefix.slice(0, prefixBudget) + '\n\n[Context truncated to fit budget]';
    }
    let agentPrompt = prefix + suffix;
    lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
    nativeInstructions.push(
      `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)` +
      `\n  → then: gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<output>")`
    );
  }

  let msg = `Dispatched ${taskDefs.length} tasks with consensus:\n${lines.join('\n')}`;
  msg += '\n\nAgents will include ## Consensus Summary in output.';
  msg += `\n\n⚠️ CONSENSUS PROTOCOL — 5 steps, do NOT stop after step 2:\n`;
  msg += `  1. ✓ Phase 1 dispatched (task IDs above)\n`;
  msg += `  2. → Run native Agent() calls + relay each via gossip_relay(task_id, relay_token, result)\n`;
  msg += `  3. → Call gossip_collect(task_ids: [${allTaskIds.map(id => `"${id}"`).join(', ')}], consensus: true) — this triggers PHASE 2 cross-review dispatches\n`;
  msg += `  4. → Run the cross-review Agent() calls + relay each via gossip_relay_cross_review(consensus_id, agent_id, result) — DIFFERENT tool than gossip_relay\n`;
  msg += `  5. → Call gossip_collect(consensus: true) AGAIN to get the final synthesized consensus output\n`;
  msg += `\nStopping at step 2 produces fake-consensus results — agents never cross-validate each other's findings.`;
  if (nativeInstructions.length > 0) {
    msg += `\n\n⚠️ NATIVE_DISPATCH — PASS EACH PROMPT VERBATIM TO Agent(prompt: ...).\n`;
    msg += `Do NOT condense, summarize, or rewrite the prompts below. The CONSENSUS_OUTPUT_FORMAT block embedded in each prompt is what trains the agent to emit <agent_finding> tags. If you write your own shorter prompt, the agent will emit prose, the consensus parser will fall back to bullet extraction, finding IDs will not roundtrip to peer cross-review, and the dashboard will show degraded results.\n\n`;
    msg += `Execute these ${nativeInstructions.length} Agent calls, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
    msg += `\n\n⚠️ You MUST call gossip_relay for EVERY native agent after it completes. Without it, results are lost — no memory, no consensus cross-review.`;
  }
  return { content: [{ type: 'text' as const, text: msg }] };
}
