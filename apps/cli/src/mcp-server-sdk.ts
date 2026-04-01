#!/usr/bin/env node
/**
 * Gossipcat MCP Server — thin adapter over MainAgent/DispatchPipeline
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';

// ── Extracted modules ────────────────────────────────────────────────────
import { ctx, presetScores, NATIVE_TASK_TTL_MS } from './mcp-context';
import { evictStaleNativeTasks, persistNativeTaskMap, restoreNativeTaskMap, handleNativeRelay, spawnTimeoutWatcher } from './handlers/native-tasks';
import { handleDispatchSingle, handleDispatchParallel, handleDispatchConsensus } from './handlers/dispatch';
import { handleCollect } from './handlers/collect';

// ── Environment detection ────────────────────────────────────────────────

type HostEnvironment = 'claude-code' | 'cursor' | 'vscode' | 'windsurf' | 'unknown';

interface EnvironmentInfo {
  host: HostEnvironment;
  supportsNativeAgents: boolean;
  nativeAgentDir: string | null;
  rulesDir: string;       // where to write instruction rules
  rulesFile: string;      // the file the host reads at session start
}

function detectEnvironment(): EnvironmentInfo {
  // Claude Code sets CLAUDECODE=1 and CLAUDE_CODE_ENTRYPOINT
  if (process.env.CLAUDECODE === '1' || process.env.CLAUDE_CODE_ENTRYPOINT) {
    return { host: 'claude-code', supportsNativeAgents: true, nativeAgentDir: '.claude/agents', rulesDir: '.claude/rules', rulesFile: '.claude/rules/gossipcat.md' };
  }
  // Cursor uses .cursor/rules/ or .cursorrules
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_SESSION_ID || process.env.CURSOR) {
    return { host: 'cursor', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.cursor/rules', rulesFile: '.cursor/rules/gossipcat.mdc' };
  }
  // Windsurf uses .windsurfrules
  if (process.env.WINDSURF || process.env.WINDSURF_SESSION_ID) {
    return { host: 'windsurf', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.', rulesFile: '.windsurfrules' };
  }
  // VS Code MCP extension
  if (process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode') {
    return { host: 'vscode', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.github', rulesFile: '.github/copilot-instructions.md' };
  }
  // Fallback: write CLAUDE.md (most common MCP host)
  return { host: 'unknown', supportsNativeAgents: false, nativeAgentDir: null, rulesDir: '.', rulesFile: 'GOSSIPCAT.md' };
}

const env = detectEnvironment();

// Generate the rules file content for the orchestrator
function generateRulesContent(agentList: string): string {
  return `# Gossipcat — Multi-Agent Orchestration

This project uses gossipcat for multi-agent orchestration via MCP.

## Team Setup
When the user asks to set up agents, review code with multiple agents, or build with a team, use the gossipcat MCP tools.

### Creating agents
Use \`gossip_setup\` with an agents array. Each agent can be:
- **type: "native"** — Creates a Claude Code subagent (.claude/agents/*.md) that ALSO connects to the gossipcat relay. Works both as a native Agent() and via gossip_dispatch(). Supports consensus cross-review.
- **type: "custom"** — Any provider (anthropic, openai, google, local). Only accessible via gossip_dispatch().

**Native agent requirements:** Native agents need TWO files to work fully:
1. \`.gossip/config.json\` entry — with explicit \`skills\` array and \`"native": true\`
2. \`.claude/agents/<id>.md\` — with frontmatter (name, model, description, tools) and prompt

\`gossip_setup\` creates both automatically. Mid-session agent changes require \`/mcp\` reconnect.

### Dispatching work

**Single-agent tasks** (default):
\`\`\`
gossip_run(agent_id: "<id>", task: "Implement X")
\`\`\`
\`gossip_run\` is the preferred dispatch. Do NOT use raw Agent() for gossipcat tasks.

**Write modes:** \`gossip_run(agent_id, task, write_mode: "scoped", scope: "./src")\`
**Parallel:** \`gossip_dispatch(mode:"parallel", tasks) → gossip_collect(task_ids)\`
**Plan → Execute:** \`gossip_plan(task) → gossip_dispatch(mode:"parallel", tasks) → gossip_collect(ids)\`

## Available Agents
${agentList}

## When to Use Multi-Agent vs Single Agent

**Use consensus (3+ agents) for:**
| Task | Why | Split Strategy |
|------|-----|----------------|
| Security review | Different agents catch different vuln classes | Split by package/concern |
| Code review | Cross-validation catches what single reviewers miss | Split by concern |
| Bug investigation | Competing hypotheses tested in parallel | One hypothesis per agent |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension |
| Pre-ship verification | Catch regressions before merge | Split by area changed |

**Single agent is fine for:** quick lookups, running tests, file reads.

## Consensus Workflow — The Complete Flow

### Step 1: Dispatch
\`\`\`
gossip_dispatch(mode: "consensus", tasks: [
  { agent_id: "<reviewer>", task: "Review X for security" },
  { agent_id: "<researcher>", task: "Review X for architecture" },
  { agent_id: "<tester>", task: "Review X for test coverage" },
])
\`\`\`

### Step 2: Execute native agents, then relay results
\`gossip_relay(task_id: "<id>", result: "<agent output>")\`

### Step 3: Collect with cross-review
\`gossip_collect(task_ids, consensus: true, timeout_ms: 300000)\`
Returns: CONFIRMED, DISPUTED, UNIQUE, UNVERIFIED, NEW tagged findings.

### Step 4: Verify and record signals IMMEDIATELY
For EACH finding, read the actual code. Record signals AS YOU VERIFY:
\`\`\`
gossip_signals(signals: [
  { signal: "unique_confirmed", agent_id: "reviewer", finding: "XSS in template" },
  { signal: "hallucination_caught", agent_id: "reviewer", finding: "Claimed X but code shows Y" },
  { signal: "agreement", agent_id: "reviewer", counterpart_id: "researcher", finding: "Both found it" },
])
\`\`\`
**CRITICAL:** Record \`hallucination_caught\` IMMEDIATELY when a finding is wrong. Don't batch — record inline as you verify. This keeps agent scores accurate.

### Step 5: Fix confirmed issues (only after all signals recorded).

## Performance Signals & Agent Scores

Call \`gossip_scores()\` to see: accuracy (0-1), uniqueness (0-1), dispatchWeight (0.5-1.5).
- High-accuracy agents → solo tasks, primary reviewers
- High-uniqueness, low-accuracy → always use in consensus, never solo
- Check scores periodically to track improvement

## Memory System

Memory persists across sessions automatically:
- \`.gossip/agents/<id>/memory/knowledge/*.md\` — cognitive summaries
- \`.gossip/agents/_project/memory/knowledge/\` — shared cross-agent context
- \`.gossip/next-session.md\` — session continuity priorities

**Call \`gossip_session_save()\` before ending your session.** Without it, the next session starts cold.

## Dashboard

Use \`gossip_status()\` for URL and key. Tabs: Overview, Agents, Consensus, Skills, Memory.

## Subagent Override (IMPORTANT)

When ANY skill or workflow (including subagent-driven-development, executing-plans, or
any custom skill) instructs you to dispatch work via the Agent() tool, use \`gossip_run\`
instead. This ensures tasks appear in the dashboard, agent memory is written, and
performance signals are recorded.

**Flow:** \`gossip_run(agent_id, task)\` → returns Agent() instructions for native agents →
execute the Agent() → \`gossip_relay(task_id, result)\` to close the loop.

**Exception:** \`gossip_dispatch(mode:"consensus")\` already handles its own native Agent() calls —
don't double-wrap those.

**Why:** Raw Agent() bypasses the gossipcat pipeline. Tasks won't appear in the activity
feed, no memory is written, no signals recorded. The agent effectively works off-grid.

## Native Agent Relay Rule

When dispatching native agents: gossip_dispatch → Agent() → gossip_relay. Never skip the relay call.

## Implementation Tasks — Auto-Dispatch

Check Tier 1/2 triggers first (see .claude/rules/gossipcat.md). If no match, call
gossip_run(agent_id: "auto", task: "<description>") BEFORE writing any code.

Exceptions: (direct) in user message, Tier 3 changes (docs, CSS, tests), or already
executing inside a dispatched plan step.

gossip_run auto classifies single vs multi and routes appropriately:
- Single: selects best-fit agent by dispatch weight, dispatches directly
- Multi: calls gossip_plan for decomposition, presents for approval, then dispatches

## Permissions

Auto-allow writes: \`{ "permissions": { "allow": ["Edit", "Write", "Bash(npm *)"] } }\`
`;
}

// ── Lazy state — populated during boot() ─────────────────────────────────
let booted = false;
let bootPromise: Promise<void> | null = null;

// Re-entrant guard: prevents gossip_plan from being called inside a plan step
let planExecutionDepth = 0;

// Cache modules after first import
let _modules: any = null;

async function getModules() {
  if (_modules) return _modules;
  _modules = {
    RelayServer: (await import('@gossip/relay')).RelayServer,
    ToolServer: (await import('@gossip/tools')).ToolServer,
    ALL_TOOLS: (await import('@gossip/tools')).ALL_TOOLS,
    MainAgent: (await import('@gossip/orchestrator')).MainAgent,
    WorkerAgent: (await import('@gossip/orchestrator')).WorkerAgent,
    createProvider: (await import('@gossip/orchestrator')).createProvider,
    PerformanceWriter: (await import('@gossip/orchestrator')).PerformanceWriter,
    SkillGenerator: (await import('@gossip/orchestrator')).SkillGenerator,
    ...(await import('./config')),
    Keychain: (await import('./keychain')).Keychain,
  };
  return _modules;
}

async function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = doBoot().catch((err) => {
    bootPromise = null; // Reset so next call retries instead of permanently failing
    throw err;
  });
  return bootPromise;
}

async function doBoot() {
  const m = await getModules();

  const configPath = m.findConfigPath();
  if (!configPath) throw new Error('No gossip.agents.json found. Run gossipcat setup first.');

  const config = m.loadConfig(configPath);
  const agentConfigs = m.configToAgentConfigs(config);
  ctx.keychain = new m.Keychain();

  ctx.relay = new m.RelayServer({
    port: 24420,
    dashboard: {
      projectRoot: process.cwd(),
      agentConfigs: agentConfigs,
    },
  });
  await ctx.relay.start();

  if (ctx.relay.dashboardUrl) {
    process.stderr.write(`[gossipcat] Dashboard: ${ctx.relay.dashboardUrl} (key: ${ctx.relay.dashboardKey})\n`);
  }

  // Create performance writer for ATI signal collection
  const perfWriter = new m.PerformanceWriter(process.cwd());

  ctx.toolServer = new m.ToolServer({ relayUrl: ctx.relay.url, projectRoot: process.cwd(), perfWriter });
  await ctx.toolServer.start();

  // Create workers before MainAgent to avoid duplicate relay connections.
  // Native agents skip worker creation — they're dispatched via Claude Code's Agent tool.
  for (const ac of agentConfigs) {
    if (ac.native) {
      // Load instructions for native agent dispatch
      const { existsSync: ex, readFileSync: rf } = require('fs');
      const { join: j } = require('path');
      const claudeAgentPath = j(process.cwd(), '.claude', 'agents', `${ac.id}.md`);
      const instrPath = j(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
      let instructions = '';
      if (ex(claudeAgentPath)) {
        instructions = rf(claudeAgentPath, 'utf-8').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
      } else if (ex(instrPath)) {
        instructions = rf(instrPath, 'utf-8');
      }
      const modelTier = ac.model.includes('opus') ? 'opus' : ac.model.includes('haiku') ? 'haiku' : 'sonnet';
      ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.preset || '' });
      process.stderr.write(`[gossipcat] ${ac.id}: native agent (${modelTier}, dispatched via Agent tool)\n`);
      continue;
    }
    const key = await ctx.keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const instructionsPath = join(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf-8') : undefined;
    const worker = new m.WorkerAgent(ac.id, llm, ctx.relay.url, m.ALL_TOOLS, instructions);
    // Wire meta signal emission for ATI profiling
    worker.setOnTaskComplete?.((event: { agentId: string; taskId: string; toolCalls: number; durationMs: number }) => {
      try {
        const now = new Date().toISOString();
        perfWriter.appendSignal({ type: 'meta', signal: 'task_completed', agentId: event.agentId, taskId: event.taskId, value: event.durationMs, timestamp: now } as any);
        if (event.toolCalls > 0) {
          perfWriter.appendSignal({ type: 'meta', signal: 'task_tool_turns', agentId: event.agentId, taskId: event.taskId, value: event.toolCalls, timestamp: now } as any);
        }
      } catch { /* ATI signal emission is best-effort */ }
    });
    await worker.start();
    ctx.workers.set(ac.id, worker);
  }

  // Register Claude Code subagents from .claude/agents/*.md (native = no relay worker needed)
  const { loadClaudeSubagents, claudeSubagentsToConfigs } = await import('./config');
  const existingIds = new Set<string>(agentConfigs.map((a: any) => a.id));
  const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
  if (claudeSubagents.length > 0) {
    const claudeConfigs = claudeSubagentsToConfigs(claudeSubagents);
    for (let i = 0; i < claudeSubagents.length; i++) {
      const sa = claudeSubagents[i];
      const ac = claudeConfigs[i];
      agentConfigs.push(ac);
      // Map model tier for Agent tool dispatch
      const modelTier = sa.model.includes('opus') ? 'opus' : sa.model.includes('haiku') ? 'haiku' : 'sonnet';
      ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description });
      process.stderr.write(`[gossipcat] Registered native agent: ${sa.id} (${modelTier}) — dispatched via Agent tool\n`);
    }
  }

  // Try main agent key first, fall back to any available provider key
  let mainProvider = config.main_agent.provider;
  let mainModel = config.main_agent.model;
  let mainKey = await ctx.keychain.getKey(config.main_agent.provider);
  if (!mainKey) {
    for (const ac of agentConfigs) {
      const key = await ctx.keychain.getKey(ac.provider);
      if (key) {
        mainProvider = ac.provider;
        mainModel = ac.model;
        mainKey = key;
        process.stderr.write(`[gossipcat] Main agent key unavailable, using ${ac.provider}/${ac.model} for orchestration\n`);
        break;
      }
    }
  }
  const supaKey = await ctx.keychain.getKey('supabase');
  const supaTeamSalt = await ctx.keychain.getKey('supabase-team-salt');
  ctx.mainAgent = new m.MainAgent({
    provider: mainProvider,
    model: mainModel,
    apiKey: mainKey ?? undefined,
    relayUrl: ctx.relay.url,
    agents: agentConfigs,
    projectRoot: process.cwd(),
    bootstrapPrompt: (() => {
      try {
        const { existsSync: e, readFileSync: r } = require('fs');
        const { join: j } = require('path');
        const bp = j(process.cwd(), '.gossip', 'bootstrap.md');
        return e(bp) ? r(bp, 'utf-8') : '';
      } catch { return ''; }
    })(),
    keyProvider: async (provider: string) => ctx.keychain.getKey(provider),
    toolServer: ctx.toolServer ? {
      assignScope: (agentId: string, scope: string) => ctx.toolServer.assignScope(agentId, scope),
      assignRoot: (agentId: string, root: string) => ctx.toolServer.assignRoot(agentId, root),
      releaseAgent: (agentId: string) => ctx.toolServer.releaseAgent(agentId),
    } : null,
    syncFactory: () => {
      try {
        const { existsSync: exists, readFileSync: readF } = require('fs');
        const { join: joinP } = require('path');
        const configPath = joinP(process.cwd(), '.gossip', 'supabase.json');
        if (!exists(configPath) || !supaKey) return null;
        const supaConfig = JSON.parse(readF(configPath, 'utf-8'));
        const { getUserId, getProjectId, getTeamUserId, getGitEmail } = require('./identity');
        const { TaskGraph: TG, TaskGraphSync: TGS } = require('@gossip/orchestrator');

        let userId: string;
        let displayName: string | null = null;
        if (supaConfig.mode === 'team') {
          const email = getGitEmail();
          if (!supaTeamSalt || !email) {
            process.stderr.write(`[gossipcat] Team sync disabled: ${!supaTeamSalt ? 'missing teamSalt in keychain' : 'no git email configured'}. Run: gossipcat sync --setup\n`);
            return null;
          }
          userId = getTeamUserId(email, supaTeamSalt);
          displayName = supaConfig.displayName || email;
        } else {
          userId = getUserId(process.cwd());
        }

        return new TGS(new TG(process.cwd()), supaConfig.url, supaKey, userId, getProjectId(process.cwd()), process.cwd(), displayName);
      } catch { return null; }
    },
  });
  // Pass existing workers so MainAgent doesn't create duplicates
  ctx.mainAgent.setWorkers(ctx.workers);
  await ctx.mainAgent.start();

  // Restore native task tracking from disk (survives /mcp reconnects)
  restoreNativeTaskMap(process.cwd());

  // Wire adaptive team intelligence (overlap detection + lens generation)
  try {
    const { OverlapDetector, LensGenerator } = await import('@gossip/orchestrator');

    // Default to the main agent's model
    let utilityLlm = m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined);
    let utilityModelId = `${mainProvider}/${mainModel}`;

    if (config.utility_model) {
      const utilityKey = await ctx.keychain.getKey(config.utility_model.provider);
      if (utilityKey) {
        // If a utility model is configured AND its key exists, override the default
        utilityLlm = m.createProvider(config.utility_model.provider, config.utility_model.model, utilityKey);
        utilityModelId = `${config.utility_model.provider}/${config.utility_model.model}`;
      } else {
        // If configured but key is missing, just warn. The fallback is already set.
        process.stderr.write(`[gossipcat] Utility model key for "${config.utility_model.provider}" not found, falling back to main agent model for lens generation.\n`);
      }
    }

    ctx.mainAgent.setOverlapDetector(new OverlapDetector());
    ctx.mainAgent.setLensGenerator(new LensGenerator(utilityLlm));
    ctx.mainAgent.setSummaryLlm(utilityLlm);
    process.stderr.write(`[gossipcat] Adaptive team intelligence ready (utility: ${utilityModelId})\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Adaptive team intelligence failed: ${(err as Error).message}\n`);
  }

  // Wire Consensus Judge (uses dedicated LLM call, not a worker)
  try {
    const { ConsensusJudge } = await import('@gossip/orchestrator');
    const judgeLlm = m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined);
    const judge = new ConsensusJudge(judgeLlm, process.cwd());
    ctx.mainAgent.setConsensusJudge(judge);
    process.stderr.write(`[gossipcat] Consensus Judge ready (${mainProvider}/${mainModel})\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Consensus Judge failed to initialize: ${(err as Error).message}\n`);
  }

  // Create skill generator for gossip_skills develop action
  try {
    const { CompetencyProfiler: CP, SkillGenerator: SG } = await import('@gossip/orchestrator');
    const skillProfiler = new CP(process.cwd());
    ctx.skillGenerator = new SG(
      m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined),
      skillProfiler,
      process.cwd(),
    );
    process.stderr.write('[gossipcat] Skill generator ready\n');
  } catch (err) {
    process.stderr.write(`[gossipcat] Skill generator failed: ${(err as Error).message}\n`);
  }

  // Initialize per-agent skill index
  try {
    const { SkillIndex: SI } = await import('@gossip/orchestrator');
    const skillIndex = new SI(process.cwd());
    if (!skillIndex.exists()) {
      // First time: seed from config.skills[] arrays
      skillIndex.seedFromConfigs(agentConfigs.map((ac: any) => ({ id: ac.id, skills: ac.skills || [] })));
      process.stderr.write(`[gossipcat] Skill index created (seeded from ${agentConfigs.length} agent configs)\n`);
    }
    ctx.mainAgent.setSkillIndex(skillIndex);
    process.stderr.write(`[gossipcat] Skill index loaded (${skillIndex.getAgentIds().length} agents)\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Skill index failed: ${(err as Error).message}\n`);
  }

  // Create gossip publisher and wire into pipeline
  try {
    const { GossipAgent: GossipAgentPub } = await import('@gossip/client');
    const publisherAgent = new GossipAgentPub({
      agentId: 'gossip-publisher',
      relayUrl: ctx.relay.url,
      reconnect: true,
    });
    await publisherAgent.connect();

    const { GossipPublisher: GossipPub } = await import('@gossip/orchestrator');
    const gossipPublisher = new GossipPub(
      m.createProvider(config.main_agent.provider, config.main_agent.model, mainKey ?? undefined),
      { publishToChannel: (channel: string, data: unknown) => publisherAgent.sendChannel(channel, data as Record<string, unknown>) }
    );
    ctx.mainAgent.setGossipPublisher(gossipPublisher);
    process.stderr.write(`[gossipcat] Gossip publisher ready\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Gossip publisher failed: ${(err as Error).message}\n`);
  }

  // Auto-regenerate bootstrap.md on boot so session context is always fresh
  try {
    const { BootstrapGenerator } = await import('@gossip/orchestrator');
    const generator = new BootstrapGenerator(process.cwd());
    const result = generator.generate();
    const { writeFileSync: wf, mkdirSync: md } = require('fs');
    const { join: j } = require('path');
    md(j(process.cwd(), '.gossip'), { recursive: true });
    wf(j(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
    if (result.tier === 'full') {
      process.stderr.write(`[gossipcat] Bootstrap refreshed (${result.agentCount} agents, session context loaded)\n`);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] Bootstrap refresh failed: ${(err as Error).message}\n`);
  }

  booted = true;
  ctx.booted = true;
  process.stderr.write(`[gossipcat] Booted: relay :${ctx.relay.port}, ${ctx.workers.size} workers\n`);
}

/**
 * Hot-reload: re-read gossip.agents.json and spawn any new workers.
 * Serialized — concurrent calls wait for the first to finish.
 */
let syncPromise: Promise<void> | null = null;
async function syncWorkersViaKeychain() {
  if (!booted) return;
  if (syncPromise) return syncPromise;
  syncPromise = doSyncWorkers().finally(() => { syncPromise = null; });
  return syncPromise;
}
async function doSyncWorkers() {
  try {
    const m = await getModules();
    const { loadClaudeSubagents, claudeSubagentsToConfigs } = await import('./config');

    const configPath = m.findConfigPath();
    if (!configPath) return;

    const config = m.loadConfig(configPath);
    const agentConfigs = m.configToAgentConfigs(config);

    // Register any new agent configs (including native flag)
    for (const ac of agentConfigs) {
      ctx.mainAgent.registerAgent(ac);
      // [H2 fix] Populate nativeAgentConfigs for config-defined native agents
      if (ac.native && !ctx.nativeAgentConfigs.has(ac.id)) {
        const { existsSync: ex, readFileSync: rf } = require('fs');
        const { join: j } = require('path');
        const claudeAgentPath = j(process.cwd(), '.claude', 'agents', `${ac.id}.md`);
        const instrPath = j(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
        let instructions = '';
        if (ex(claudeAgentPath)) {
          instructions = rf(claudeAgentPath, 'utf-8').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
        } else if (ex(instrPath)) {
          instructions = rf(instrPath, 'utf-8');
        }
        const modelTier = ac.model.includes('opus') ? 'opus' : ac.model.includes('haiku') ? 'haiku' : 'sonnet';
        ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.preset || '' });
      }
    }

    // Also register Claude Code subagents discovered from .claude/agents/
    const existingIds = new Set([...agentConfigs.map((a: any) => a.id), ...ctx.workers.keys(), ...ctx.nativeAgentConfigs.keys()]);
    const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
    if (claudeSubagents.length > 0) {
      const claudeConfigs = claudeSubagentsToConfigs(claudeSubagents);
      for (let i = 0; i < claudeSubagents.length; i++) {
        const sa = claudeSubagents[i];
        const ac = claudeConfigs[i];
        ctx.mainAgent.registerAgent(ac);
        // [H2 fix] Populate nativeAgentConfigs for hot-reloaded subagents
        const modelTier = sa.model.includes('opus') ? 'opus' : sa.model.includes('haiku') ? 'haiku' : 'sonnet';
        ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description });
      }
    }

    // Sync only non-native workers (native agents use Agent tool, not relay)
    const added = await ctx.mainAgent.syncWorkers((provider: string) => ctx.keychain.getKey(provider));
    if (added > 0) {
      const allConfigs = [...agentConfigs, ...claudeSubagentsToConfigs(claudeSubagents)];
      for (const ac of allConfigs) {
        if (!ac.native && !ctx.workers.has(ac.id)) {
          const w = ctx.mainAgent.getWorker(ac.id);
          if (w) ctx.workers.set(ac.id, w);
        }
      }
      process.stderr.write(`[gossipcat] Synced: ${ctx.workers.size} relay workers + ${ctx.nativeAgentConfigs.size} native agents\n`);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] syncWorkers failed: ${(err as Error).message}\n`);
  }
}

// Wire context functions so handlers can call boot/sync
ctx.boot = boot;
ctx.syncWorkersViaKeychain = syncWorkersViaKeychain;
ctx.getModules = getModules;

// ── Create MCP Server ─────────────────────────────────────────────────────
const server = new McpServer({
  name: 'gossipcat',
  version: '0.1.0',
});

// ── Plan: decompose with write-mode classification ────────────────────────
server.tool(
  'gossip_plan',
  'Plan a task with write-mode suggestions. Decomposes into sub-tasks, assigns agents, and classifies each as read or write with suggested write mode. Returns dispatch-ready JSON for approval before execution. Use this before gossip_dispatch(mode:"parallel") for implementation tasks.',
  {
    task: z.string().describe('Task description (e.g. "fix the scope validation bug in packages/tools/")'),
    strategy: z.enum(['parallel', 'sequential', 'single']).optional()
      .describe('Override decomposition strategy. Omit to let the orchestrator decide.'),
  },
  async ({ task, strategy }) => {
    await boot();
    await syncWorkersViaKeychain();

    // Re-entrant guard: if already inside a plan execution, don't re-decompose
    if (planExecutionDepth > 0) {
      return { content: [{ type: 'text' as const, text:
        'Skipped: already inside a plan step. Execute the task directly instead of re-planning.' }] };
    }

    try {
      const { TaskDispatcher, AgentRegistry } = await import('@gossip/orchestrator');

      const { findConfigPath, loadConfig, configToAgentConfigs } = await import('./config');
      const configPath = findConfigPath();
      if (!configPath) return { content: [{ type: 'text' as const, text: 'No config found. Run gossip_setup first.' }] };

      const config = loadConfig(configPath);
      const agentConfigs = configToAgentConfigs(config);
      const registry = new AgentRegistry();
      for (const ac of agentConfigs) registry.register(ac);

      const { createProvider } = await import('@gossip/orchestrator');

      // Try main agent first, fall back to any agent with a working key
      let llm: any;
      const mainKey = await ctx.keychain.getKey(config.main_agent.provider);
      if (mainKey) {
        llm = createProvider(config.main_agent.provider, config.main_agent.model, mainKey);
      } else {
        // Fallback: use the first agent that has a working key
        for (const ac of agentConfigs) {
          const key = await ctx.keychain.getKey(ac.provider);
          if (key) {
            llm = createProvider(ac.provider, ac.model, key);
            process.stderr.write(`[gossipcat] gossip_plan: main agent key unavailable, using ${ac.provider}/${ac.model} for planning\n`);
            break;
          }
        }
        if (!llm) return { content: [{ type: 'text' as const, text: 'No API keys available. Run gossipcat setup to configure keys.' }] };
      }

      const dispatcher = new TaskDispatcher(llm, registry);

      // 1. Decompose
      const plan = await dispatcher.decompose(task);
      if (strategy) plan.strategy = strategy;

      // 2. Assign agents
      dispatcher.assignAgents(plan);

      // 3. Classify write modes
      const planned = await dispatcher.classifyWriteModes(plan);

      // 4. Build response
      const taskLines = planned.map((t: any, i: number) => {
        const tag = t.access === 'write' ? '[WRITE]' : '[READ]';
        let line = `  ${i + 1}. ${tag} ${t.agentId || 'unassigned'} → "${t.task}"`;
        if (t.writeMode) {
          line += `\n     write_mode: ${t.writeMode}`;
          if (t.scope) line += ` | scope: ${t.scope}`;
        }
        return line;
      }).join('\n');

      const assignedTasks = planned.filter((t: any) => t.agentId);
      const unassignedTasks = planned.filter((t: any) => !t.agentId);

      // Store plan state for chain threading
      const planId = randomUUID().slice(0, 8);
      const planState = {
        id: planId,
        task,
        strategy: plan.strategy,
        steps: assignedTasks.map((t: any, i: number) => ({
          step: i + 1,
          agentId: t.agentId,
          task: t.task,
          writeMode: t.writeMode,
          scope: t.scope,
        })),
        createdAt: Date.now(),
      };
      ctx.mainAgent.registerPlan(planState);

      const planJson = {
        strategy: plan.strategy,
        tasks: assignedTasks.map((t: any, i: number) => {
          const entry: Record<string, any> = { agent_id: t.agentId, task: t.task };
          if (t.writeMode) entry.write_mode = t.writeMode;
          if (t.scope) entry.scope = t.scope;
          entry.plan_id = planId;
          entry.step = i + 1;
          return entry;
        }),
      };

      let warnings = '';
      if (plan.warnings?.length) {
        warnings = `\nWarnings:\n${plan.warnings.map((w: string) => `  - ${w}`).join('\n')}\n`;
      }
      if (unassignedTasks.length) {
        warnings += `\nUnassigned (excluded from PLAN_JSON — no matching agent):\n${unassignedTasks.map((t: any) => `  - "${t.task}"`).join('\n')}\n`;
      }

      // Format dispatch instructions based on strategy
      let dispatchBlock: string;
      if (plan.strategy === 'sequential' || plan.strategy === 'single') {
        // Sequential: output individual gossip_dispatch calls
        const steps = planJson.tasks.map((t: Record<string, any>, i: number) => {
          const args = [`agent_id: "${t.agent_id}"`, `task: "${t.task}"`];
          if (t.write_mode) args.push(`write_mode: "${t.write_mode}"`);
          if (t.scope) args.push(`scope: "${t.scope}"`);
          args.push(`plan_id: "${planId}"`, `step: ${i + 1}`);
          return `Step ${i + 1}: gossip_dispatch(${args.join(', ')})\n         then: gossip_collect()`;
        });
        dispatchBlock = `Execute sequentially:\n${steps.join('\n\n')}`;
      } else {
        // Parallel: output gossip_dispatch payload
        dispatchBlock = `PLAN_JSON (pass to gossip_dispatch with mode:"parallel"):\n${JSON.stringify(planJson)}`;
      }

      const text = `Plan: "${task}"\nPlan ID: ${planId}\n\nStrategy: ${plan.strategy}\n\nTasks:\n${taskLines}\n${warnings}\n---\n${dispatchBlock}`;

      return { content: [{ type: 'text' as const, text }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Plan error: ${err.message}` }] };
    }
  }
);

// ── Low-level: dispatch to specific agent ─────────────────────────────────
server.tool(
  'gossip_dispatch',
  'Dispatch tasks to agents. mode:"single" (default) sends to one agent. mode:"parallel" fans out to multiple agents. mode:"consensus" dispatches with cross-review instructions. Returns task IDs for collecting results.',
  {
    mode: z.enum(['single', 'parallel', 'consensus']).default('single').describe('Dispatch mode: "single" (one agent), "parallel" (fan-out), "consensus" (cross-review)'),
    agent_id: z.string().optional().describe('Agent ID — required for mode:"single"'),
    task: z.string().optional().describe('Task description — required for mode:"single"'),
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
      write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
      scope: z.string().optional(),
    })).optional().describe('Task array — required for mode:"parallel" and mode:"consensus"'),
    write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional().describe('Write mode for single dispatch'),
    scope: z.string().optional().describe('Directory scope for "scoped" write mode'),
    timeout_ms: z.number().optional().describe('Write task timeout in ms. Default 300000.'),
    plan_id: z.string().optional().describe('Plan ID from gossip_plan. Enables chain context from prior steps.'),
    step: z.number().optional().describe('Step number in the plan (1-indexed).'),
  },
  async ({ mode, agent_id, task, tasks, write_mode, scope, timeout_ms, plan_id, step }) => {
    // Track plan execution depth for re-entrant guard
    planExecutionDepth++;
    try {
      if (mode === 'single') {
        if (!agent_id || !task) {
          return { content: [{ type: 'text' as const, text: 'Error: mode:"single" requires agent_id and task.' }] };
        }
        return handleDispatchSingle(agent_id, task, write_mode, scope, timeout_ms, plan_id, step);
      }
      if (mode === 'parallel') {
        if (!tasks || tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'Error: mode:"parallel" requires a non-empty tasks array.' }] };
        }
        return handleDispatchParallel(tasks, false);
      }
      if (mode === 'consensus') {
        if (!tasks || tasks.length === 0) {
          return { content: [{ type: 'text' as const, text: 'Error: mode:"consensus" requires a non-empty tasks array.' }] };
        }
        return handleDispatchConsensus(tasks);
      }
      return { content: [{ type: 'text' as const, text: `Unknown mode: ${mode}` }] };
    } finally {
      planExecutionDepth--;
    }
  }
);

// ── Low-level: collect results ────────────────────────────────────────────
server.tool(
  'gossip_collect',
  'Collect results from dispatched tasks. Waits for completion by default. Use consensus: true for cross-review round.',
  {
    task_ids: z.array(z.string()).default([]).describe('Task IDs to collect. Empty array for all.'),
    timeout_ms: z.number().default(300000).describe('Max wait time in ms. Default 5 minutes.'),
    consensus: z.boolean().default(false).describe('Enable cross-review consensus. Agents review each others findings.'),
  },
  async ({ task_ids, timeout_ms, consensus }) => handleCollect(task_ids, timeout_ms, consensus)
);

// ── Info: status + agents (merged) ────────────────────────────────────────
server.tool(
  'gossip_status',
  'Check Gossip Mesh system status, host environment, available agents, dashboard URL/key, and agent list with provider/model/skills.',
  {},
  async () => {
    const { findConfigPath, loadConfig, configToAgentConfigs, loadClaudeSubagents } = await import('./config');

    // System status
    const claudeSubagentsList = loadClaudeSubagents(process.cwd());
    const lines = [
      'Gossip Mesh Status:',
      `  Host: ${env.host}${env.supportsNativeAgents ? ' (native agents supported)' : ''}`,
      `  Native agent dir: ${env.nativeAgentDir || 'n/a'}`,
      `  Relay: ${ctx.relay ? `running :${ctx.relay.port}` : 'not started'}`,
      `  Tool Server: ${ctx.toolServer ? 'running' : 'not started'}`,
      `  Workers: ${ctx.workers.size} (${Array.from(ctx.workers.keys()).join(', ') || 'none'})`,
      `  Claude subagents found: ${claudeSubagentsList.length}`,
    ];
    if (ctx.relay?.dashboardUrl) {
      lines.push(`  Dashboard: ${ctx.relay.dashboardUrl} (key: ${ctx.relay.dashboardKey})`);
    }

    // Agent list (formerly gossip_agents)
    const agentSections: string[] = [];
    const configPath = findConfigPath();
    const gossipAgents: string[] = [];
    const existingIds = new Set<string>();
    if (configPath) {
      const config = loadConfig(configPath);
      const agents = configToAgentConfigs(config);
      for (const a of agents) {
        existingIds.add(a.id);
        gossipAgents.push(`  - ${a.id}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`);
      }
      agentSections.push(`Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})`);
    }

    // Claude Code subagents loaded into relay
    const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
    for (const sa of claudeSubagents) {
      gossipAgents.push(`  - ${sa.id}: ${sa.provider}/${sa.model} (claude-subagent) — ${sa.description.slice(0, 60)}`);
    }

    if (gossipAgents.length > 0) {
      agentSections.push(`\nAgents on relay (${gossipAgents.length}):\n${gossipAgents.join('\n')}`);
    } else {
      agentSections.push('\nNo agents configured. Run gossip_setup or add .claude/agents/*.md files.');
    }

    // Show runtime worker status if booted
    if (booted && ctx.workers.size > 0) {
      agentSections.push(`\nRelay workers online: ${ctx.workers.size} — [${Array.from(ctx.workers.keys()).join(', ')}]`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') + '\n\n' + agentSections.join('\n') }] };
  }
);

// ── Tool: setup — create or update team config ────────────────────────────
server.tool(
  'gossip_setup',
  `Create or update gossipcat team. Default mode is "merge" — adds/updates specified agents while keeping existing ones. Use "replace" to overwrite entire config. Detects host environment (${env.host}) and supports both native Claude Code subagents (.claude/agents/*.md) and custom provider agents (Anthropic, OpenAI, Google Gemini).`,
  {
    main_provider: z.enum(['anthropic', 'openai', 'google']).default('google')
      .describe('Provider for the orchestrator LLM'),
    main_model: z.string().default('gemini-2.5-pro')
      .describe('Model ID for orchestrator (e.g. gemini-2.5-pro, claude-sonnet-4-6, gpt-4o)'),
    mode: z.enum(['merge', 'replace', 'update_instructions']).default('merge')
      .describe('"merge" (default) keeps existing agents and adds/updates the ones specified. "replace" overwrites entire config. "update_instructions" updates agent instructions without touching the config.'),
    instruction_agent_ids: z.union([z.string(), z.array(z.string())]).optional().describe('Agent IDs for instruction update'),
    instruction_update: z.string().optional().describe('Instruction text to append/replace'),
    instruction_mode: z.enum(['append', 'replace']).optional().describe('How to apply instruction update'),
    agents: z.array(z.object({
      id: z.string().describe('Agent ID (lowercase, hyphens). e.g. "claude-reviewer", "gemini-impl"'),
      type: z.enum(['native', 'custom']).describe(
        '"native" = Claude Code subagent (.claude/agents/*.md), uses Anthropic API on the relay. ' +
        '"custom" = any provider (anthropic/openai/google/local)'
      ),
      // Native agent fields
      model: z.enum(['opus', 'sonnet', 'haiku']).optional()
        .describe('For native agents: Claude model tier'),
      description: z.string().optional()
        .describe('For native agents: one-line description for the .claude/agents/*.md frontmatter'),
      instructions: z.string().optional()
        .describe('For native agents: full instructions (markdown body of .claude/agents/*.md)'),
      // Custom agent fields
      provider: z.enum(['anthropic', 'openai', 'google', 'local']).optional()
        .describe('For custom agents: LLM provider'),
      custom_model: z.string().optional()
        .describe('For custom agents: model ID (e.g. gemini-2.5-pro, gpt-4o, claude-sonnet-4-6)'),
      // Shared fields
      preset: z.enum(['implementer', 'reviewer', 'researcher', 'tester']).optional()
        .describe('Agent role preset'),
      skills: z.array(z.string()).optional()
        .describe('Skill tags (e.g. ["typescript", "code_review"])'),
    })).describe('Array of agents to create'),
  },
  async ({ main_provider, main_model, mode, agents, instruction_agent_ids, instruction_update, instruction_mode }) => {
    if (mode === 'update_instructions') {
      if (!instruction_agent_ids || !instruction_update) {
        return { content: [{ type: 'text' as const, text: 'Error: update_instructions mode requires instruction_agent_ids and instruction_update' }] };
      }

      await boot();

      // Size limit
      if (instruction_update.length > 5000) {
        return { content: [{ type: 'text' as const, text: 'Instruction update exceeds 5000 char limit.' }] };
      }

      // Block shell commands and code execution patterns (case-insensitive, whitespace-flexible)
      const blockedPatterns = [
        /rm\s+(-\w*[rf]|--force|--recursive)/i,
        /curl\s/i, /wget\s/i,
        /\beval\s*\(/i, /\bexec\s*\(/i, /\bspawn\s*\(/i,
        /\bimport\s*\(/i, /\brequire\s*\(/i,
        /process\.(env|exit|kill)/i,
        /child_process/i,
      ];
      if (blockedPatterns.some(p => p.test(instruction_update))) {
        return { content: [{ type: 'text' as const, text: 'Instruction update contains blocked content.' }] };
      }

      const ids = Array.isArray(instruction_agent_ids) ? instruction_agent_ids : [instruction_agent_ids];
      const applyMode = instruction_mode || 'append';
      const results: string[] = [];
      const { writeFileSync: writeFS, mkdirSync: mkdirFS } = require('fs');
      const { join: joinPath } = require('path');

      for (const agent_id of ids) {
        if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
          results.push(`${agent_id}: invalid ID format`);
          continue;
        }

        const worker = ctx.mainAgent.getWorker(agent_id);
        if (!worker) {
          results.push(`${agent_id}: not found`);
          continue;
        }

        // Backup before replace
        if (applyMode === 'replace') {
          const agentDir = joinPath(process.cwd(), '.gossip', 'agents', agent_id);
          mkdirFS(agentDir, { recursive: true });
          writeFS(joinPath(agentDir, 'instructions-backup.md'), worker.getInstructions());
        }

        if (applyMode === 'replace') {
          worker.setInstructions(instruction_update);
        } else {
          worker.setInstructions(worker.getInstructions() + '\n\n' + instruction_update);
        }

        // Persist
        const agentDir = joinPath(process.cwd(), '.gossip', 'agents', agent_id);
        mkdirFS(agentDir, { recursive: true });
        writeFS(joinPath(agentDir, 'instructions.md'), worker.getInstructions());
        results.push(`${agent_id}: updated (${applyMode})`);
      }

      return { content: [{ type: 'text' as const, text: results.join('\n') }] };
    }

    const { writeFileSync, mkdirSync, existsSync } = require('fs');
    const { join } = require('path');
    const root = process.cwd();

    const CLAUDE_MODEL_MAP: Record<string, { provider: string; model: string }> = {
      opus:   { provider: 'anthropic', model: 'claude-opus-4-6' },
      sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      haiku:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
    };

    const configAgents: Record<string, any> = {};
    const nativeCreated: string[] = [];
    const customCreated: string[] = [];
    const errors: string[] = [];

    const RESERVED_IDS = new Set(['_project', '__proto__', 'constructor', 'prototype']);
    for (const agent of agents) {
      if (RESERVED_IDS.has(agent.id)) {
        errors.push(`${agent.id}: reserved ID, cannot be used for agents`);
        continue;
      }
      if (agent.type === 'native') {
        // Create .claude/agents/<id>.md
        const modelTier = agent.model || 'sonnet';
        const mapped = CLAUDE_MODEL_MAP[modelTier];
        if (!mapped) {
          errors.push(`${agent.id}: unknown model tier "${modelTier}"`);
          continue;
        }

        const desc = agent.description || `${agent.preset || 'general'} agent`;
        const body = agent.instructions || `You are a ${agent.preset || 'skilled developer'} agent. Complete assigned tasks using available tools. Be concise and focused.`;
        const tools = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write'];
        const md = [
          '---',
          `name: ${agent.id}`,
          `model: ${modelTier}`,
          `description: ${desc}`,
          `tools:`,
          ...tools.map(t => `  - ${t}`),
          '---',
          '',
          body,
        ].join('\n');

        const agentsDir = join(root, '.claude', 'agents');
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(join(agentsDir, `${agent.id}.md`), md, 'utf-8');
        nativeCreated.push(agent.id);

        // Register in gossipcat config — marked native so dispatch uses Agent tool bridge
        configAgents[agent.id] = {
          provider: mapped.provider,
          model: mapped.model,
          preset: agent.preset || 'implementer',
          skills: agent.skills || ['general'],
          native: true,
        };
      } else {
        // Custom provider agent → gossipcat config only
        if (!agent.provider) {
          errors.push(`${agent.id}: custom agent requires "provider" field`);
          continue;
        }
        if (!agent.custom_model) {
          errors.push(`${agent.id}: custom agent requires "custom_model" field`);
          continue;
        }
        // Prevent split-brain: warn if this ID was previously a native agent
        const nativeFile = join(root, '.claude', 'agents', `${agent.id}.md`);
        const wasNative = existingAgents[agent.id]?.native || existsSync(nativeFile);
        if (wasNative) {
          errors.push(`${agent.id}: cannot re-register native agent as custom — .claude/agents/${agent.id}.md exists. Remove the file first or keep it as native.`);
          continue;
        }
        configAgents[agent.id] = {
          provider: agent.provider,
          model: agent.custom_model,
          preset: agent.preset || 'implementer',
          skills: agent.skills || ['general'],
        };
        customCreated.push(agent.id);

        // Write instructions if provided
        if (agent.instructions) {
          const instrDir = join(root, '.gossip', 'agents', agent.id);
          mkdirSync(instrDir, { recursive: true });
          writeFileSync(join(instrDir, 'instructions.md'), agent.instructions, 'utf-8');
        }
      }
    }

    // Write gossipcat config — merge with existing or replace
    let existingAgents: Record<string, any> = {};
    if (mode === 'merge') {
      try {
        const { readFileSync } = require('fs');
        const existing = JSON.parse(readFileSync(join(root, '.gossip', 'config.json'), 'utf-8'));
        existingAgents = existing.agents || {};
      } catch { /* no existing config — start fresh */ }
    }

    const config = {
      main_agent: { provider: main_provider, model: main_model },
      agents: { ...existingAgents, ...configAgents },
    };

    try {
      const { validateConfig } = await import('./config');
      validateConfig(config);
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Invalid config: ${(err as Error).message}` }] };
    }

    mkdirSync(join(root, '.gossip'), { recursive: true });
    writeFileSync(join(root, '.gossip', 'config.json'), JSON.stringify(config, null, 2));

    // Generate host-appropriate rules file so the IDE knows about the team
    const agentList = Object.entries(config.agents)
      .map(([id, a]: [string, any]) => `- ${id}: ${a.provider}/${a.model} (${a.preset || 'custom'})${a.native ? ' — native' : ''}`)
      .join('\n');
    const rulesDir = join(root, env.rulesDir);
    const rulesFile = join(root, env.rulesFile);
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(rulesFile, generateRulesContent(agentList));

    // Summary
    const lines: string[] = [`Host: ${env.host}`, ''];
    if (nativeCreated.length > 0) {
      lines.push(`Native agents created (${nativeCreated.length}):`);
      lines.push(...nativeCreated.map(id => `  ✓ .claude/agents/${id}.md → also on gossipcat relay`));
    }
    if (customCreated.length > 0) {
      lines.push(`Custom agents created (${customCreated.length}):`);
      lines.push(...customCreated.map(id => `  ✓ ${id} → ${configAgents[id].provider}/${configAgents[id].model}`));
    }
    if (errors.length > 0) {
      lines.push(`\nErrors (${errors.length}):`);
      lines.push(...errors.map(e => `  ✗ ${e}`));
    }
    const preservedIds = Object.keys(existingAgents).filter(id => !configAgents[id]);
    if (preservedIds.length > 0) {
      lines.push(`Preserved from existing config (${preservedIds.length}):`);
      lines.push(...preservedIds.map(id => `  • ${id} → ${existingAgents[id].provider}/${existingAgents[id].model}`));
    }
    lines.push(`\nMode: ${mode} | Config: .gossip/config.json (${Object.keys(config.agents).length} agents total)`);
    lines.push(`Rules: ${env.rulesFile} (${env.host} will read this on next session)`);
    lines.push('Agents will connect to relay on first gossip_dispatch() call.');
    if (nativeCreated.length > 0) {
      lines.push(`\nTip: Native agents may prompt for file write permissions. To auto-allow, add to .claude/settings.local.json:`);
      lines.push(`  { "permissions": { "allow": ["Edit", "Write"] } }`);
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ── Native agent bridge: feed Agent tool results back into relay ──────────
server.tool(
  'gossip_relay',
  'Feed a native agent result back into the gossipcat relay. Call this after a Claude Code Agent() completes a task dispatched via gossip_dispatch or gossip_run. Enables consensus cross-review and gossip for native agents.',
  {
    task_id: z.string().describe('Task ID returned by gossip_dispatch or gossip_run'),
    result: z.string().describe('The agent output/result text'),
    error: z.string().optional().describe('Error message if the agent failed'),
  },
  async ({ task_id, result, error }) => handleNativeRelay(task_id, result, error)
);

// ── gossip_run — single-call dispatch (reduces friction) ─────────────────
server.tool(
  'gossip_run',
  'Run a task on a single agent and return the result. For relay agents (Gemini), this is a single call — dispatches, waits, returns. For native agents (Sonnet/Haiku), returns dispatch instructions with gossip_relay callback. Use agent_id:"auto" to let the orchestrator decompose and assign agents automatically.',
  {
    agent_id: z.string().describe('Agent to run the task on, or "auto" for orchestrator-driven decomposition'),
    task: z.string().describe('Task description. Reference file paths — the agent will read them.'),
    write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional().describe('Write mode for implementation tasks'),
    scope: z.string().optional().describe('Directory scope for scoped write mode'),
  },
  async ({ agent_id, task, write_mode, scope }) => {
    await boot();

    // Auto mode: fast classify → route to single agent or full plan
    if (agent_id === 'auto') {
      const complexity = await ctx.mainAgent.classifyTaskComplexity(task);

      if (complexity === 'multi') {
        // Multi-agent: return instructions to call gossip_plan for decomposition
        return { content: [{ type: 'text' as const, text:
          `Auto-dispatch: classified as multi-agent task.\n\n` +
          `This task needs decomposition. Call:\n` +
          `  gossip_plan(task: <full task description>)\n\n` +
          `Then review the plan and dispatch with gossip_dispatch(mode: "parallel", tasks: <plan tasks>).`
        }] };
      }

      // Single-agent: find best match and fall through to normal dispatch
      const { AgentRegistry } = await import('@gossip/orchestrator');
      const { findConfigPath, loadConfig, configToAgentConfigs } = await import('./config');
      const configPath = findConfigPath();
      if (!configPath) return { content: [{ type: 'text' as const, text: 'No config found. Run gossip_setup first.' }] };

      const config = loadConfig(configPath);
      const agentConfigs = configToAgentConfigs(config);
      const registry = new AgentRegistry();
      for (const ac of agentConfigs) registry.register(ac);

      const implSkills = ['implementation', 'typescript'];
      const bestAgent = registry.findBestMatch(implSkills);
      const selectedId = bestAgent?.id || agentConfigs[0]?.id;

      if (!selectedId) {
        return { content: [{ type: 'text' as const, text: 'No agents available. Run gossip_setup first.' }] };
      }

      // Fall through to the normal dispatch below with the selected agent
      process.stderr.write(`[gossipcat] Auto-dispatch: single-agent → ${selectedId}\n`);
      agent_id = selectedId;
    }

    const isNative = ctx.nativeAgentConfigs.has(agent_id);
    const options: any = {};
    if (write_mode) options.writeMode = write_mode;
    if (scope) options.scope = scope;

    if (isNative) {
      // Native agent — record task and return instructions for host
      evictStaleNativeTasks();
      const taskId = require('crypto').randomUUID().slice(0, 8);
      ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS });
      spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
      persistNativeTaskMap();
      try { ctx.mainAgent.recordNativeTask(taskId, agent_id, task); } catch { /* best-effort */ }
      const config = ctx.nativeAgentConfigs.get(agent_id)!;
      const agentConfig = ctx.mainAgent.getAgentList?.()?.find((a: any) => a.id === agent_id);
      const preset = agentConfig?.preset || config.description || '';
      const presetPrompts: Record<string, string> = {
        reviewer: 'You are a senior code reviewer. Focus on logic errors, security vulnerabilities, TypeScript type safety, and performance. Cite file:line for every finding.',
        researcher: 'You are a research agent. Explore codebases, trace execution paths, answer architecture questions. Be concise — bullet points over paragraphs. Cite file paths.',
        implementer: 'You are an implementation agent. Write clean, tested code. Follow existing patterns. Commit your work.',
        tester: 'You are a testing agent. Write thorough tests, find edge cases, verify behavior. Run tests and report results.',
      };
      const presetPrompt = presetPrompts[preset] || `You are a ${preset} agent.`;

      // Inject scope restriction for scoped write mode
      const scopePrefix = (write_mode === 'scoped' && scope)
        ? `SCOPE RESTRICTION: Only modify files within ${scope}. Do not edit files outside this directory.\n\n`
        : '';

      const agentPrompt = `${scopePrefix}${presetPrompt}\n\n---\n\nTask: ${task}`;
      const modelMap: Record<string, string> = { 'claude-sonnet-4-6': 'sonnet', 'claude-opus-4-6': 'opus', 'claude-haiku-4-5': 'haiku' };
      const modelShort = modelMap[config.model] || 'sonnet';

      return {
        content: [{ type: 'text' as const, text:
          `Dispatched to ${agent_id} (native). Task ID: ${taskId}\n\n` +
          `⚠️ EXECUTE NOW — launch this Agent and relay the result:\n\n` +
          `1. Agent(model: "${modelShort}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)\n` +
          `2. When agent completes → gossip_relay(task_id: "${taskId}", result: "<full agent output>")\n\n` +
          `Do BOTH steps in your next response. Do not wait for user input between them.`
        }],
      };
    }

    // Relay worker — dispatch and collect in one call
    try {
      const { taskId } = ctx.mainAgent.dispatch(agent_id, task, options);
      const collectResult = await ctx.mainAgent.collect([taskId], 300000);
      const entry = collectResult.results[0];

      if (!entry) {
        return { content: [{ type: 'text' as const, text: `Task ${taskId} returned no result.` }] };
      }

      const elapsed = (entry.completedAt || Date.now()) - (entry.startedAt || Date.now());
      const output = entry.status === 'completed'
        ? entry.result || '[No response from agent]'
        : `Error: ${entry.error || 'Task failed'}`;

      return {
        content: [{ type: 'text' as const, text: `[${taskId}] ${agent_id} (${elapsed}ms):\n${output}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `gossip_run failed: ${(err as Error).message}` }],
      };
    }
  }
);

// gossip_run_complete removed — merged into gossip_relay

// ── Record consensus signals from Claude Code synthesis ───────────────────
server.tool(
  'gossip_signals',
  'Record or retract consensus performance signals. Use action "record" (default) to record signals after cross-referencing agent findings — call IMMEDIATELY when you verify. Use action "retract" to undo a previously recorded signal.',
  {
    action: z.enum(['record', 'retract']).default('record').describe('Action: "record" to add signals, "retract" to undo a previous signal'),
    // record params
    task_id: z.string().optional().describe('Task ID to link signals to. For record: optional (synthetic ID if omitted). For retract: required.'),
    signals: z.array(z.object({
      signal: z.enum(['agreement', 'disagreement', 'unique_confirmed', 'unique_unconfirmed', 'new_finding', 'hallucination_caught'])
        .describe('Signal type: agreement (both agree), disagreement (one wrong), unique_confirmed (only one found it + verified), unique_unconfirmed (only one found it, unverified), new_finding (discovered during cross-review), hallucination_caught (fabricated finding)'),
      agent_id: z.string().describe('Agent being evaluated'),
      counterpart_id: z.string().optional().describe('The other agent involved (e.g., who won the disagreement)'),
      finding: z.string().describe('Brief description of the finding'),
      evidence: z.string().optional().describe('Supporting evidence or reasoning'),
    })).optional().describe('Array of consensus signals (required for action: "record")'),
    // retract params
    agent_id: z.string().optional().describe('Agent whose signal to retract (required for action: "retract")'),
    reason: z.string().optional().describe('Why this signal is being retracted (required for action: "retract")'),
  },
  async ({ action, task_id, signals, agent_id, reason }) => {
    await boot();

    if (action === 'retract') {
      // Validate retract params
      if (!agent_id || agent_id.trim().length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: agent_id is required for retraction.' }] };
      }
      if (!task_id || task_id.trim().length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: task_id is required for retraction. Use the task ID from the original signal.' }] };
      }
      if (!reason || reason.trim().length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: reason is required for retraction.' }] };
      }
      try {
        const { PerformanceWriter } = await import('@gossip/orchestrator');
        const writer = new PerformanceWriter(process.cwd());
        writer.appendSignals([{
          type: 'consensus' as const,
          taskId: task_id,
          signal: 'signal_retracted',
          agentId: agent_id,
          evidence: `Retracted: ${reason}`,
          timestamp: new Date().toISOString(),
        }]);
        return { content: [{ type: 'text' as const, text: `Retracted signal for ${agent_id} on task ${task_id}.\nReason: ${reason}\n\nThe original signal remains in the audit log but will be excluded from scoring.` }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Failed to retract: ${(err as Error).message}` }] };
      }
    }

    // action === 'record'
    if (!signals || signals.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No signals to record. Provide a signals array.' }] };
    }

    try {
      const { PerformanceWriter } = await import('@gossip/orchestrator');
      const writer = new PerformanceWriter(process.cwd());
      const timestamp = new Date().toISOString();
      const MAX_EVIDENCE_LENGTH = 2000;
      const PUNITIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement']);
      const COUNTERPART_REQUIRED = new Set(['agreement', 'disagreement']);

      // Validate: punitive signals require evidence
      for (const s of signals) {
        if (PUNITIVE_SIGNALS.has(s.signal) && (!s.evidence || s.evidence.trim().length === 0)) {
          return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require non-empty evidence for audit trail. Agent: ${s.agent_id}` }] };
        }
        if (COUNTERPART_REQUIRED.has(s.signal) && (!s.counterpart_id || s.counterpart_id.trim().length === 0)) {
          return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require counterpart_id. Agent: ${s.agent_id}` }] };
        }
      }

      const formatted = signals.map((s, i) => ({
        type: 'consensus' as const,
        taskId: task_id || `manual-${timestamp.replace(/[:.]/g, '')}-${i}`,
        signal: s.signal,
        agentId: s.agent_id,
        counterpartId: s.counterpart_id,
        evidence: ((s.evidence || s.finding) ?? '').slice(0, MAX_EVIDENCE_LENGTH),
        timestamp,
      }));

      writer.appendSignals(formatted);

      // Summary by agent
      const byAgent = new Map<string, { pos: number; neg: number }>();
      for (const s of signals) {
        const entry = byAgent.get(s.agent_id) || { pos: 0, neg: 0 };
        if (['agreement', 'unique_confirmed', 'new_finding'].includes(s.signal)) entry.pos++;
        else entry.neg++;
        byAgent.set(s.agent_id, entry);
      }

      const summary = Array.from(byAgent.entries())
        .map(([id, { pos, neg }]) => `  ${id}: +${pos} / -${neg}`)
        .join('\n');

      const taskIdList = formatted.map(f => `  ${f.agentId}: ${f.taskId}`).join('\n');
      return { content: [{ type: 'text' as const, text: `Recorded ${signals.length} consensus signals:\n${summary}\n\nTask IDs (for retraction):\n${taskIdList}\n\nThese will influence future agent selection via dispatch weighting.` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to record signals: ${(err as Error).message}` }] };
    }
  }
);

// ── Tool: view agent performance scores ───────────────────────────────────
server.tool(
  'gossip_scores',
  'View agent performance scores from consensus signals. Shows accuracy, uniqueness, reliability, and dispatch weight for each agent. Use to understand which agents are performing well and which need improvement.',
  {},
  async () => {
    await boot();
    try {
      const { PerformanceReader } = await import('@gossip/orchestrator');
      const reader = new PerformanceReader(process.cwd());
      const scores = reader.getScores();

      if (scores.size === 0) {
        return { content: [{ type: 'text' as const, text: 'No performance data yet. Run gossip_dispatch(mode:"consensus") + gossip_signals to generate signals.' }] };
      }

      const lines = Array.from(scores.values())
        .sort((a, b) => b.reliability - a.reliability)
        .map(s => {
          const w = reader.getDispatchWeight(s.agentId);
          const nativeTag = ctx.nativeAgentConfigs.has(s.agentId) ? ' (native)' : '';
          return `  ${s.agentId}${nativeTag}:\n` +
            `    accuracy=${s.accuracy.toFixed(2)} uniqueness=${s.uniqueness.toFixed(2)} reliability=${s.reliability.toFixed(2)}\n` +
            `    signals=${s.totalSignals} agree=${s.agreements} disagree=${s.disagreements} unique=${s.uniqueFindings} hallucinate=${s.hallucinations}\n` +
            `    dispatch weight=${w.toFixed(2)}${s.totalSignals < 3 ? ' (neutral — <3 signals)' : ''}`;
        });

      return { content: [{ type: 'text' as const, text: `Agent Performance Scores (${scores.size} agents):\n\n${lines.join('\n\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error reading scores: ${(err as Error).message}` }] };
    }
  }
);

// ── Unified skill management ─────────────────────────────────────────────
server.tool(
  'gossip_skills',
  'Manage agent skills. Actions: list (show skill index), bind (attach skill to agent), unbind (remove skill from agent), build (create skills from gap suggestions), develop (generate skill from ATI competency data).',
  {
    action: z.enum(['list', 'bind', 'unbind', 'build', 'develop']).describe('Action to perform'),
    // bind/unbind/develop params
    agent_id: z.string().optional().describe('Agent ID (required for bind, unbind, develop)'),
    skill: z.string().optional().describe('Skill name (required for bind, unbind)'),
    enabled: z.boolean().default(true).optional().describe('For bind: set to false to disable the slot without removing it'),
    // develop params
    category: z.string().optional().describe('Category to improve (required for develop). One of: trust_boundaries, injection_vectors, input_validation, concurrency, resource_exhaustion, type_safety, error_handling, data_integrity'),
    // build params
    skill_names: z.array(z.string()).optional().describe('For build: filter to specific skills. Omit to get all pending.'),
    skills: z.array(z.object({
      name: z.string().describe('Skill name (kebab-case)'),
      content: z.string().describe('Full .md content with frontmatter'),
    })).optional().describe('For build: generated skill files to save. Omit for discovery mode.'),
  },
  async ({ action, agent_id, skill, enabled, category, skill_names, skills }) => {
    await boot();

    // ── list ──
    if (action === 'list') {
      const index = ctx.mainAgent.getSkillIndex();
      if (!index) return { content: [{ type: 'text' as const, text: 'Skill index not initialized.' }] };

      const data = index.getIndex();
      const agentIds = Object.keys(data);
      if (agentIds.length === 0) return { content: [{ type: 'text' as const, text: 'Skill index is empty. Skills will be indexed on next dispatch.' }] };

      const sections = agentIds.map((agentId: string) => {
        const slots = Object.values(data[agentId]);
        const lines = slots.map((s: any) =>
          `  [${s.enabled ? '✓' : '✗'}] ${s.skill} (v${s.version}, ${s.source})`
        );
        return `${agentId} (${slots.filter((s: any) => s.enabled).length}/${slots.length} enabled):\n${lines.join('\n')}`;
      });

      return { content: [{ type: 'text' as const, text: `Skill Index (${agentIds.length} agents):\n\n${sections.join('\n\n')}` }] };
    }

    // ── bind ──
    if (action === 'bind') {
      if (!agent_id) return { content: [{ type: 'text' as const, text: 'Error: agent_id is required for bind.' }] };
      if (!skill) return { content: [{ type: 'text' as const, text: 'Error: skill is required for bind.' }] };
      const index = ctx.mainAgent.getSkillIndex();
      if (!index) return { content: [{ type: 'text' as const, text: 'Skill index not initialized.' }] };

      const existing = index.getSlot(agent_id, skill);
      const slot = index.bind(agent_id, skill, { enabled });

      const bindAction = existing
        ? (existing.enabled !== enabled ? (enabled ? 'enabled' : 'disabled') : 'updated')
        : 'bound';

      return { content: [{ type: 'text' as const, text: `Skill "${slot.skill}" ${bindAction} for ${agent_id} (v${slot.version}, ${slot.enabled ? 'enabled' : 'disabled'})` }] };
    }

    // ── unbind ──
    if (action === 'unbind') {
      if (!agent_id) return { content: [{ type: 'text' as const, text: 'Error: agent_id is required for unbind.' }] };
      if (!skill) return { content: [{ type: 'text' as const, text: 'Error: skill is required for unbind.' }] };
      const index = ctx.mainAgent.getSkillIndex();
      if (!index) return { content: [{ type: 'text' as const, text: 'Skill index not initialized.' }] };

      const removed = index.unbind(agent_id, skill);
      return { content: [{ type: 'text' as const, text: removed
        ? `Skill "${skill}" unbound from ${agent_id}`
        : `No slot found for "${skill}" on ${agent_id}`
      }] };
    }

    // ── develop ──
    if (action === 'develop') {
      if (!agent_id) return { content: [{ type: 'text' as const, text: 'Error: agent_id is required for develop.' }] };
      if (!category) return { content: [{ type: 'text' as const, text: 'Error: category is required for develop.' }] };

      if (!ctx.skillGenerator) {
        return { content: [{ type: 'text' as const, text: 'Skill generator not available. Check boot logs.' }] };
      }

      try {
        const result = await ctx.skillGenerator.generate(agent_id, category);

        // Register skill on agent config so loadSkills picks it up
        if (ctx.mainAgent) {
          const registry = (ctx.mainAgent as any).registry;
          const config = registry?.get(agent_id);
          if (config && !config.skills.includes(category)) {
            config.skills.push(category);
          }
        }

        const preview = result.content.length > 1000
          ? result.content.slice(0, 1000) + '\n\n... (truncated)'
          : result.content;

        return {
          content: [{ type: 'text' as const, text: `Skill generated and saved:\n\nPath: ${result.path}\n\n${preview}` }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Skill generation failed: ${(err as Error).message}` }],
        };
      }
    }

    // ── build ──
    // action === 'build'
    const { SkillGapTracker, parseSkillFrontmatter, normalizeSkillName } = await import('@gossip/orchestrator');
    const tracker = new SkillGapTracker(process.cwd());

    // Save mode — write generated skill files
    if (skills && skills.length > 0) {
      const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
      const { join } = require('path');
      const dir = join(process.cwd(), '.gossip', 'skills');
      mkdirSync(dir, { recursive: true });

      const results: string[] = [];
      for (const sk of skills) {
        const name = normalizeSkillName(sk.name);
        const filePath = join(dir, `${name}.md`);

        // Overwrite protection
        if (existsSync(filePath)) {
          const existing = readFileSync(filePath, 'utf-8');
          const fm = parseSkillFrontmatter(existing);
          if (fm) {
            if (fm.generated_by === 'manual') {
              results.push(`Skipped ${name}: manually created file (generated_by: manual)`);
              continue;
            }
            if (fm.status === 'active') {
              results.push(`Skipped ${name}: already active`);
              continue;
            }
            if (fm.status === 'disabled') {
              results.push(`Skipped ${name}: disabled by user`);
              continue;
            }
          }
          // No frontmatter = old skeleton template, safe to overwrite
        }

        writeFileSync(filePath, sk.content);
        tracker.recordResolution(name);
        results.push(`Created .gossip/skills/${name}.md`);
      }

      return { content: [{ type: 'text' as const, text: results.join('\n') }] };
    }

    // Discovery mode — return pending gap data
    const thresholds = tracker.checkThresholds();
    if (thresholds.count === 0) {
      return { content: [{ type: 'text' as const, text: 'No skills at threshold. Agents need to call suggest_skill() more.' }] };
    }

    const targetSkills = skill_names
      ? skill_names.map(s => normalizeSkillName(s)).filter(s => thresholds.pending.includes(s))
      : thresholds.pending;

    if (targetSkills.length === 0) {
      return { content: [{ type: 'text' as const, text: `No matching skills at threshold. Pending: ${thresholds.pending.join(', ')}` }] };
    }

    const gapData = tracker.getGapData(targetSkills);
    let text = `Skills ready to build: ${gapData.length}\n\n`;

    for (const gap of gapData) {
      text += `### ${gap.skill}\n`;
      text += `Suggestions (${gap.suggestions.length} from ${gap.uniqueAgents.length} agents):\n`;
      for (const s of gap.suggestions) {
        text += `- ${s.agent}: "${s.reason}" (task: ${s.task_context.slice(0, 80)})\n`;
      }
      text += '\n';
    }

    text += `Generate each skill as a .md file with this frontmatter format:\n`;
    text += '```\n---\nname: skill-name\ndescription: What this skill does.\nkeywords: [keyword1, keyword2]\ngenerated_by: orchestrator\nsources: N suggestions from agent1, agent2\nstatus: active\n---\n```\n';
    text += `Body sections: Approach (numbered steps), Output (format), Don't (anti-patterns).\n\n`;
    text += `Then call gossip_skills(action: "build", skills: [{name: "...", content: "..."}]) to save.`;

    return { content: [{ type: 'text' as const, text }] };
  }
);

// ── Tool: list available gossipcat tools ──────────────────────────────────
// ── Session Memory: save session context for next session ────────────────
server.tool(
  'gossip_session_save',
  'Save a cognitive session summary to project memory. The next session will load this context automatically on MCP connect. Call before ending your session to preserve what was learned.',
  {
    notes: z.string().optional().describe('Optional freeform user context (e.g., "focusing on security hardening")'),
  },
  async ({ notes }) => {
    await boot();

    // 1. Gather session gossip from disk (crash-safe)
    let gossipText = '';
    try {
      const { existsSync: ex, readFileSync: rf } = require('fs');
      const { join: j } = require('path');
      const gossipPath = j(process.cwd(), '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl');
      if (ex(gossipPath)) {
        const lines = rf(gossipPath, 'utf-8').trim().split('\n').filter(Boolean);
        gossipText = lines.map((l: string) => {
          try { const e = JSON.parse(l); return `- ${e.agentId}: ${e.taskSummary}`; } catch { return ''; }
        }).filter(Boolean).join('\n');
      }
    } catch { /* no gossip */ }

    if (!gossipText) {
      const memGossip = ctx.mainAgent.getSessionGossip();
      if (memGossip.length > 0) {
        gossipText = memGossip.map((g: any) => `- ${g.agentId}: ${g.taskSummary}`).join('\n');
      }
    }

    // 2. Consensus history
    const consensusHistory = ctx.mainAgent.getSessionConsensusHistory();
    const consensusText = consensusHistory.length > 0
      ? consensusHistory.map((c: any) => `- ${c.timestamp.split('T')[0]}: ${c.confirmed} confirmed, ${c.disputed} disputed, ${c.unverified} unverified`).join('\n')
      : '';

    // 3. Agent performance
    let performanceText = '';
    try {
      const { PerformanceReader } = await import('@gossip/orchestrator');
      const reader = new PerformanceReader(process.cwd());
      const scores = reader.getScores();
      performanceText = Array.from(scores.entries()).map(([id, s]: [string, any]) =>
        `- ${id}: acc=${s.accuracy.toFixed(2)} uniq=${s.uniqueness.toFixed(2)} signals=${s.totalSignals}`
      ).join('\n');
    } catch { /* no perf data */ }

    // 4. Git log since session start (fall back to last 24h if session start is too recent)
    let gitLog = '';
    try {
      const { execSync } = require('child_process');
      const since = ctx.mainAgent.getSessionStartTime().toISOString();
      gitLog = execSync(
        `git log --oneline --max-count=50 --since="${since}"`,
        { cwd: process.cwd(), encoding: 'utf-8' }
      ).trim();
      // If empty (likely reconnect with wrong start time), fall back to last 24h
      if (!gitLog) {
        const yesterday = new Date(Date.now() - 86400000).toISOString();
        gitLog = execSync(
          `git log --oneline --max-count=50 --since="${yesterday}"`,
          { cwd: process.cwd(), encoding: 'utf-8' }
        ).trim();
      }
    } catch { /* no git */ }

    // 5a. Auto-resolve findings that appear in recent commits (best-effort)
    if (gitLog) {
      try {
        const { readFileSync: rf, writeFileSync: wf } = require('fs');
        const { join: j } = require('path');
        const findingsPath = j(process.cwd(), '.gossip', 'implementation-findings.jsonl');
        const lines = rf(findingsPath, 'utf-8').trim().split('\n').filter(Boolean);
        let changed = false;
        const updated = lines.map((line: string) => {
          try {
            const f = JSON.parse(line);
            if (f.status === 'open' && f.file && gitLog.includes(f.file.split('/').pop())) {
              f.status = 'resolved';
              f.resolvedAt = new Date().toISOString();
              changed = true;
            }
            return JSON.stringify(f);
          } catch { return line; }
        });
        if (changed) {
          wf(findingsPath, updated.join('\n') + '\n');
          process.stderr.write(`[gossipcat] Auto-resolved findings matching recent commits\n`);
        }
      } catch { /* best-effort */ }
    }

    // 5b. Read open findings for structured injection into next-session.md
    let findingsTable = '';
    try {
      const { existsSync: ex, readFileSync: rf } = require('fs');
      const { join: j } = require('path');
      const findingsPath = j(process.cwd(), '.gossip', 'implementation-findings.jsonl');
      if (ex(findingsPath)) {
        const lines = rf(findingsPath, 'utf-8').trim().split('\n').filter(Boolean);
        const findings = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const open = findings.filter((f: any) => f.status === 'open');

        if (open.length > 0) {
          findingsTable = '\n\n## Open Findings\n\n';
          findingsTable += '| Finding | Agent | Confidence | Status |\n';
          findingsTable += '|---------|-------|------------|--------|\n';
          for (const f of open.slice(0, 20)) {
            const agent = f.originalAgentId || f.reviewerId || 'unknown';
            const conf = f.confidence ?? '?';
            findingsTable += `| ${f.finding.slice(0, 120)} | ${agent} | ${conf} | open |\n`;
          }
          if (open.length > 20) {
            findingsTable += `| ... and ${open.length - 20} more | | | |\n`;
          }
        }
      }
    } catch { /* best-effort */ }

    // 5c. Write session summary
    const { MemoryWriter } = await import('@gossip/orchestrator');
    const writer = new MemoryWriter(process.cwd());
    try { if (ctx.mainAgent.getLLM()) writer.setSummaryLlm(ctx.mainAgent.getLLM()); } catch {}

    const summary = await writer.writeSessionSummary({
      gossip: gossipText, consensus: consensusText,
      performance: performanceText, gitLog, notes,
    });

    // 5d. Append open findings to next-session.md as structured data (outside LLM prose)
    if (findingsTable) {
      try {
        const { appendFileSync: af } = require('fs');
        const { join: j } = require('path');
        af(j(process.cwd(), '.gossip', 'next-session.md'), findingsTable);
      } catch { /* best-effort */ }
    }

    // 6. Clear consumed gossip
    try {
      const { writeFileSync: wf } = require('fs');
      const { join: j } = require('path');
      wf(j(process.cwd(), '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl'), '');
    } catch {}

    // 7. Regenerate bootstrap.md so next session/reconnect gets fresh context
    try {
      const { BootstrapGenerator } = await import('@gossip/orchestrator');
      const generator = new BootstrapGenerator(process.cwd());
      const result = generator.generate();
      const { writeFileSync: wf, mkdirSync: md } = require('fs');
      const { join: j } = require('path');
      md(j(process.cwd(), '.gossip'), { recursive: true });
      wf(j(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
      process.stderr.write('[gossipcat] Bootstrap regenerated with new session context\n');
    } catch { /* best-effort */ }

    let output = `Session saved to .gossip/agents/_project/memory/\n\n${summary}`;
    if (findingsTable) {
      output += findingsTable;
    }
    output += '\n\n---\nNext session: bootstrap context will load automatically on MCP connect.';
    return { content: [{ type: 'text' as const, text: output }] };
  }
);

server.tool(
  'gossip_tools',
  'List all available gossipcat MCP tools with descriptions. Call after /mcp reconnect to discover new tools.',
  {},
  async () => {
    const tools = [
      // Core (8)
      { name: 'gossip_run', desc: 'Run task on one agent. Use agent_id:"auto" for orchestrator decomposition. Supports write_mode and scope.' },
      { name: 'gossip_dispatch', desc: 'Dispatch tasks — mode:"single" (one agent), "parallel" (fan-out), "consensus" (cross-review).' },
      { name: 'gossip_collect', desc: 'Collect results from dispatched tasks. Use consensus:true with explicit task_ids for cross-review.' },
      { name: 'gossip_relay', desc: 'Feed native Agent() result back into gossipcat relay for consensus, memory, and gossip.' },
      { name: 'gossip_signals', desc: 'Record or retract consensus signals. action:"record" or "retract".' },
      { name: 'gossip_status', desc: 'Show system status, agent list, relay, workers, and dashboard URL/key.' },
      { name: 'gossip_setup', desc: 'Create or update team. mode:"merge", "replace", or "update_instructions".' },
      { name: 'gossip_session_save', desc: 'Save cognitive session summary for next session context. Call before ending session.' },
      // Power-user (4)
      { name: 'gossip_plan', desc: 'Plan a task with write-mode suggestions. Returns dispatch-ready JSON for approval.' },
      { name: 'gossip_scores', desc: 'View agent performance scores and dispatch weights.' },
      { name: 'gossip_skills', desc: 'Manage skills. action: list, bind, unbind, build, develop.' },
      { name: 'gossip_tools', desc: 'List available tools (this command).' },
    ];
    const list = tools.map(t => `- ${t.name}: ${t.desc}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Gossipcat Tools (${tools.length}):\n\n${list}` }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Eager boot — start relay, workers, and ATI profiler immediately on connect
  boot().catch(err => process.stderr.write(`[gossipcat] Boot failed: ${err.message}\n`));
}

main().catch(err => { process.stderr.write(`[gossipcat] Fatal: ${err.message}\n`); process.exit(1); });
