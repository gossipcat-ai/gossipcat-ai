#!/usr/bin/env node
/**
 * Gossipcat MCP Server — thin adapter over MainAgent/DispatchPipeline
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';

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
**Parallel:** \`gossip_dispatch_parallel(tasks) → gossip_collect(task_ids)\`
**Plan → Execute:** \`gossip_plan(task) → gossip_dispatch_parallel(plan) → gossip_collect(ids)\`

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

**Single agent is fine for:** quick lookups, simple implementations, running tests.

## Consensus Workflow — The Complete Flow

### Step 1: Dispatch
\`\`\`
gossip_dispatch_consensus(tasks: [
  { agent_id: "<reviewer>", task: "Review X for security" },
  { agent_id: "<researcher>", task: "Review X for architecture" },
  { agent_id: "<tester>", task: "Review X for test coverage" },
])
\`\`\`

### Step 2: Execute native agents, then relay results
\`gossip_relay_result(task_id: "<id>", result: "<agent output>")\`

### Step 3: Collect with cross-review
\`gossip_collect_consensus(task_ids, timeout_ms: 300000)\`
Returns: CONFIRMED, DISPUTED, UNIQUE, UNVERIFIED, NEW tagged findings.

### Step 4: Verify and record signals IMMEDIATELY
For EACH finding, read the actual code. Record signals AS YOU VERIFY:
\`\`\`
gossip_record_signals(signals: [
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

## Native Agent Relay Rule

When dispatching native agents: gossip_dispatch → Agent() → gossip_relay_result. Never skip the relay call.

## Permissions

Auto-allow writes: \`{ "permissions": { "allow": ["Edit", "Write", "Bash(npm *)"] } }\`
`;
}

// Preset-aware importance scores — reviewers value accuracy, implementers value relevance
function presetScores(preset: string): { relevance: number; accuracy: number; uniqueness: number } {
  switch (preset) {
    case 'reviewer':   return { relevance: 3, accuracy: 5, uniqueness: 4 };
    case 'tester':     return { relevance: 3, accuracy: 4, uniqueness: 4 };
    case 'researcher': return { relevance: 4, accuracy: 3, uniqueness: 5 };
    case 'implementer': return { relevance: 5, accuracy: 3, uniqueness: 2 };
    default:           return { relevance: 3, accuracy: 3, uniqueness: 3 };
  }
}

// Native agent task tracking — results fed back via gossip_relay_result
const nativeTaskMap: Map<string, { agentId: string; task: string; startedAt: number; planId?: string; step?: number }> = new Map();
const nativeAgentConfigs: Map<string, { model: string; instructions: string; description: string }> = new Map();
// Collected native results — so gossip_collect can return them alongside relay results
const nativeResultMap: Map<string, {
  id: string; agentId: string; task: string;
  status: 'completed' | 'failed';
  result?: string; error?: string;
  startedAt: number; completedAt: number;
}> = new Map();

const NATIVE_TASK_TTL_MS = 30 * 60 * 1000; // 30 min

/** Evict stale entries from nativeTaskMap and nativeResultMap */
function evictStaleNativeTasks(): void {
  const now = Date.now();
  for (const [id, info] of nativeTaskMap) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) nativeTaskMap.delete(id);
  }
  for (const [id, info] of nativeResultMap) {
    if (now - info.startedAt > NATIVE_TASK_TTL_MS) nativeResultMap.delete(id);
  }
}

// Lazy state — populated during boot()
let booted = false;
let bootPromise: Promise<void> | null = null;
let relay: any = null;
let toolServer: any = null;
let workers: Map<string, any> = new Map();
let mainAgent: any = null;
let keychain: any = null;
let skillGenerator: any = null;

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
  keychain = new m.Keychain();

  relay = new m.RelayServer({
    port: 0,
    dashboard: {
      projectRoot: process.cwd(),
      agentConfigs: agentConfigs,
    },
  });
  await relay.start();

  if (relay.dashboardUrl) {
    process.stderr.write(`[gossipcat] Dashboard: ${relay.dashboardUrl} (key: ${relay.dashboardKeyPrefix}...)\n`);
  }

  // Create performance writer for ATI signal collection
  const perfWriter = new m.PerformanceWriter(process.cwd());

  toolServer = new m.ToolServer({ relayUrl: relay.url, projectRoot: process.cwd(), perfWriter });
  await toolServer.start();

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
      nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.preset || '' });
      process.stderr.write(`[gossipcat] ${ac.id}: native agent (${modelTier}, dispatched via Agent tool)\n`);
      continue;
    }
    const key = await keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined);
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const instructionsPath = join(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf-8') : undefined;
    const worker = new m.WorkerAgent(ac.id, llm, relay.url, m.ALL_TOOLS, instructions);
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
    workers.set(ac.id, worker);
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
      nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description });
      process.stderr.write(`[gossipcat] Registered native agent: ${sa.id} (${modelTier}) — dispatched via Agent tool\n`);
    }
  }

  // Try main agent key first, fall back to any available provider key
  let mainProvider = config.main_agent.provider;
  let mainModel = config.main_agent.model;
  let mainKey = await keychain.getKey(config.main_agent.provider);
  if (!mainKey) {
    for (const ac of agentConfigs) {
      const key = await keychain.getKey(ac.provider);
      if (key) {
        mainProvider = ac.provider;
        mainModel = ac.model;
        mainKey = key;
        process.stderr.write(`[gossipcat] Main agent key unavailable, using ${ac.provider}/${ac.model} for orchestration\n`);
        break;
      }
    }
  }
  const supaKey = await keychain.getKey('supabase');
  const supaTeamSalt = await keychain.getKey('supabase-team-salt');
  mainAgent = new m.MainAgent({
    provider: mainProvider,
    model: mainModel,
    apiKey: mainKey ?? undefined,
    relayUrl: relay.url,
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
    keyProvider: async (provider: string) => keychain.getKey(provider),
    toolServer: toolServer ? {
      assignScope: (agentId: string, scope: string) => toolServer.assignScope(agentId, scope),
      assignRoot: (agentId: string, root: string) => toolServer.assignRoot(agentId, root),
      releaseAgent: (agentId: string) => toolServer.releaseAgent(agentId),
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
  mainAgent.setWorkers(workers);
  await mainAgent.start();

  // Wire adaptive team intelligence (overlap detection + lens generation)
  try {
    const { OverlapDetector, LensGenerator } = await import('@gossip/orchestrator');
    
    // Default to the main agent's model
    let utilityLlm = m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined);
    let utilityModelId = `${mainProvider}/${mainModel}`;

    if (config.utility_model) {
      const utilityKey = await keychain.getKey(config.utility_model.provider);
      if (utilityKey) {
        // If a utility model is configured AND its key exists, override the default
        utilityLlm = m.createProvider(config.utility_model.provider, config.utility_model.model, utilityKey);
        utilityModelId = `${config.utility_model.provider}/${config.utility_model.model}`;
      } else {
        // If configured but key is missing, just warn. The fallback is already set.
        process.stderr.write(`[gossipcat] Utility model key for "${config.utility_model.provider}" not found, falling back to main agent model for lens generation.\n`);
      }
    }
    
    mainAgent.setOverlapDetector(new OverlapDetector());
    mainAgent.setLensGenerator(new LensGenerator(utilityLlm));
    mainAgent.setSummaryLlm(utilityLlm);
    process.stderr.write(`[gossipcat] Adaptive team intelligence ready (utility: ${utilityModelId})\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Adaptive team intelligence failed: ${(err as Error).message}\n`);
  }

  // Wire Consensus Judge (uses dedicated LLM call, not a worker)
  try {
    const { ConsensusJudge } = await import('@gossip/orchestrator');
    const judgeLlm = m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined);
    const judge = new ConsensusJudge(judgeLlm, process.cwd());
    mainAgent.setConsensusJudge(judge);
    process.stderr.write(`[gossipcat] Consensus Judge ready (${mainProvider}/${mainModel})\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Consensus Judge failed to initialize: ${(err as Error).message}\n`);
  }


  // Create skill generator for gossip_develop_skill tool
  try {
    const { CompetencyProfiler: CP, SkillGenerator: SG } = await import('@gossip/orchestrator');
    const skillProfiler = new CP(process.cwd());
    skillGenerator = new SG(
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
    mainAgent.setSkillIndex(skillIndex);
    process.stderr.write(`[gossipcat] Skill index loaded (${skillIndex.getAgentIds().length} agents)\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] Skill index failed: ${(err as Error).message}\n`);
  }

  // Create gossip publisher and wire into pipeline
  try {
    const { GossipAgent: GossipAgentPub } = await import('@gossip/client');
    const publisherAgent = new GossipAgentPub({
      agentId: 'gossip-publisher',
      relayUrl: relay.url,
      reconnect: true,
    });
    await publisherAgent.connect();

    const { GossipPublisher: GossipPub } = await import('@gossip/orchestrator');
    const gossipPublisher = new GossipPub(
      m.createProvider(config.main_agent.provider, config.main_agent.model, mainKey ?? undefined),
      { publishToChannel: (channel: string, data: unknown) => publisherAgent.sendChannel(channel, data as Record<string, unknown>) }
    );
    mainAgent.setGossipPublisher(gossipPublisher);
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
  process.stderr.write(`[gossipcat] Booted: relay :${relay.port}, ${workers.size} workers\n`);
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
      mainAgent.registerAgent(ac);
      // [H2 fix] Populate nativeAgentConfigs for config-defined native agents
      if (ac.native && !nativeAgentConfigs.has(ac.id)) {
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
        nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.preset || '' });
      }
    }

    // Also register Claude Code subagents discovered from .claude/agents/
    const existingIds = new Set([...agentConfigs.map((a: any) => a.id), ...workers.keys(), ...nativeAgentConfigs.keys()]);
    const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
    if (claudeSubagents.length > 0) {
      const claudeConfigs = claudeSubagentsToConfigs(claudeSubagents);
      for (let i = 0; i < claudeSubagents.length; i++) {
        const sa = claudeSubagents[i];
        const ac = claudeConfigs[i];
        mainAgent.registerAgent(ac);
        // [H2 fix] Populate nativeAgentConfigs for hot-reloaded subagents
        const modelTier = sa.model.includes('opus') ? 'opus' : sa.model.includes('haiku') ? 'haiku' : 'sonnet';
        nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description });
      }
    }

    // Sync only non-native workers (native agents use Agent tool, not relay)
    const added = await mainAgent.syncWorkers((provider: string) => keychain.getKey(provider));
    if (added > 0) {
      const allConfigs = [...agentConfigs, ...claudeSubagentsToConfigs(claudeSubagents)];
      for (const ac of allConfigs) {
        if (!ac.native && !workers.has(ac.id)) {
          const w = mainAgent.getWorker(ac.id);
          if (w) workers.set(ac.id, w);
        }
      }
      process.stderr.write(`[gossipcat] Synced: ${workers.size} relay workers + ${nativeAgentConfigs.size} native agents\n`);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] syncWorkers failed: ${(err as Error).message}\n`);
  }
}

// ── Create MCP Server ─────────────────────────────────────────────────────
const server = new McpServer({
  name: 'gossipcat',
  version: '0.1.0',
});

// ── High-level tool ───────────────────────────────────────────────────────
server.tool(
  'gossip_orchestrate',
  'Submit a task to the Gossip Mesh orchestrator for multi-agent execution',
  { task: z.string().describe('The task to execute') },
  async ({ task }) => {
    await boot();
    try {
      const response = await mainAgent.handleMessage(task, { mode: 'decompose' });
      const suffix = response.agents?.length ? `\n\n[Agents: ${response.agents.join(', ')}]` : '';
      return { content: [{ type: 'text' as const, text: response.text + suffix }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }] };
    }
  }
);

// ── Plan: decompose with write-mode classification ────────────────────────
server.tool(
  'gossip_plan',
  'Plan a task with write-mode suggestions. Decomposes into sub-tasks, assigns agents, and classifies each as read or write with suggested write mode. Returns dispatch-ready JSON for approval before execution. Use this before gossip_dispatch_parallel for implementation tasks.',
  {
    task: z.string().describe('Task description (e.g. "fix the scope validation bug in packages/tools/")'),
    strategy: z.enum(['parallel', 'sequential', 'single']).optional()
      .describe('Override decomposition strategy. Omit to let the orchestrator decide.'),
  },
  async ({ task, strategy }) => {
    await boot();
    await syncWorkersViaKeychain();

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
      const mainKey = await keychain.getKey(config.main_agent.provider);
      if (mainKey) {
        llm = createProvider(config.main_agent.provider, config.main_agent.model, mainKey);
      } else {
        // Fallback: use the first agent that has a working key
        for (const ac of agentConfigs) {
          const key = await keychain.getKey(ac.provider);
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
      mainAgent.registerPlan(planState);

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
        // Parallel: output gossip_dispatch_parallel payload
        dispatchBlock = `PLAN_JSON (pass to gossip_dispatch_parallel):\n${JSON.stringify(planJson)}`;
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
  'Send a task to a specific agent. Returns task ID for collecting results. For implementation tasks that modify files, use gossip_plan first to get a write-mode-aware dispatch plan, or pass write_mode explicitly. Without write_mode, agents can only read files. Skills are auto-injected — pass file paths in the task, not contents.',
  {
    agent_id: z.string().describe('Agent ID (e.g. "gemini-reviewer")'),
    task: z.string().describe('Task description. Reference file paths — the agent will read them via Tool Server.'),
    write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional().describe('Write mode: "sequential" (queued), "scoped" (directory-locked), "worktree" (git worktree isolation)'),
    scope: z.string().optional().describe('Directory scope for "scoped" write mode (e.g. "packages/relay/")'),
    timeout_ms: z.number().optional().describe('Write task timeout in ms. Default 300000.'),
    plan_id: z.string().optional().describe('Plan ID from gossip_plan. Enables chain context from prior steps.'),
    step: z.number().optional().describe('Step number in the plan (1-indexed).'),
  },
  async ({ agent_id, task, write_mode, scope, timeout_ms, plan_id, step }) => {
    await boot();
    await syncWorkersViaKeychain();

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
    const nativeConfig = nativeAgentConfigs.get(agent_id);
    if (nativeConfig) {
      evictStaleNativeTasks();
      const taskId = randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), planId: plan_id, step });

      // Fix: register in TaskGraph so native tasks are visible to CLI/sync
      try { mainAgent.recordNativeTask(taskId, agent_id, task); } catch { /* best-effort */ }

      // Inject chain context from prior plan steps (same as relay agents get)
      let chainContext = '';
      if (plan_id && step && step > 1) {
        chainContext = mainAgent.getChainContext(plan_id, step);
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
        `gossip_relay_result(task_id: "${taskId}", result: "<agent output>")\n\n` +
        `⚠️ You MUST call gossip_relay_result for every native dispatch. Without it, the result is lost — no memory, no gossip, no consensus. Never skip this step.`
      }] };
    }

    try {
      const { taskId } = mainAgent.dispatch(agent_id, task, dispatchOptions as any);
      const modeLabel = write_mode ? ` [${write_mode}${scope ? `:${scope}` : ''}]` : '';
      return { content: [{ type: 'text' as const, text: `Dispatched to ${agent_id}${modeLabel}. Task ID: ${taskId}` }] };
    } catch (err: any) {
      process.stderr.write(`[gossipcat] dispatch failed: ${err.message}\n`);
      return { content: [{ type: 'text' as const, text: err.message }] };
    }
  }
);

// ── Low-level: parallel dispatch ──────────────────────────────────────────
server.tool(
  'gossip_dispatch_parallel',
  'Fan out tasks to multiple agents simultaneously. Use consensus: true to enable cross-review when collecting. For tasks involving file modifications, use gossip_plan first to get a pre-built task array with write modes, then pass it here.',
  {
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
      write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional(),
      scope: z.string().optional(),
    })).describe('Array of { agent_id, task, write_mode?, scope? }'),
    consensus: z.boolean().default(false).describe('Enable consensus summary format in agent output. Pass consensus: true to gossip_collect later.'),
  },
  async ({ tasks: taskDefs, consensus }) => {
    await boot();
    await syncWorkersViaKeychain();

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
      if (nativeAgentConfigs.has(def.agent_id)) {
        nativeTasks.push(def);
      } else {
        relayTasks.push(def);
      }
    }

    const lines: string[] = [];

    // Dispatch relay tasks normally
    if (relayTasks.length > 0) {
      const { taskIds, errors } = await mainAgent.dispatchParallel(
        relayTasks.map((d: any) => ({
          agentId: d.agent_id,
          task: d.task,
          options: d.write_mode ? { writeMode: d.write_mode, scope: d.scope } : undefined,
        })),
        consensus ? { consensus: true } : undefined,
      );
      for (const tid of taskIds) {
        const t = mainAgent.getTask(tid);
        lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
      }
      if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
    }

    // Create native dispatch instructions for Claude Code Agent tool
    const nativeInstructions: string[] = [];
    for (const def of nativeTasks) {
      const nativeConfig = nativeAgentConfigs.get(def.agent_id)!;
      const taskId = randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now() });
      try { mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }

      const agentPrompt = nativeConfig.instructions
        ? `${nativeConfig.instructions}\n\n---\n\nTask: ${def.task}`
        : def.task;

      lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
      nativeInstructions.push(
        `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}${def.write_mode === 'worktree' ? ', isolation: "worktree"' : ''}, run_in_background: true)` +
        `\n  → then: gossip_relay_result(task_id: "${taskId}", result: "<output>")`
      );
    }

    let msg = `Dispatched ${taskDefs.length} tasks:\n${lines.join('\n')}`;
    if (consensus) msg += '\n\n📋 Consensus mode enabled.';
    if (nativeInstructions.length > 0) {
      msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls in parallel, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
      msg += `\n\n⚠️ You MUST call gossip_relay_result for EVERY native agent after it completes. Without it, results are lost — no memory, no gossip, no consensus.`;
    }
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

// ── Low-level: collect results ────────────────────────────────────────────
server.tool(
  'gossip_collect',
  'Collect results from dispatched tasks. Waits for completion by default. Use consensus: true for cross-review round.',
  {
    task_ids: z.array(z.string()).default([]).describe('Task IDs to collect. Empty array for all.'),
    timeout_ms: z.number().default(120000).describe('Max wait time in ms.'),
    consensus: z.boolean().default(false).describe('Enable cross-review consensus. Agents review each others findings.'),
  },
  async ({ task_ids, timeout_ms, consensus }) => {
    await boot();

    const requestedIds = task_ids.length > 0 ? task_ids : undefined;
    // Split requested IDs into relay vs native
    const relayIds = requestedIds?.filter(id => !nativeResultMap.has(id) && !nativeTaskMap.has(id));
    const nativeIds = requestedIds?.filter(id => nativeResultMap.has(id) || nativeTaskMap.has(id));

    // Step 1: Collect relay results (WITHOUT consensus — we run it after merging natives)
    let relayResults: any[] = [];
    try {
      const idsForRelay = relayIds && relayIds.length > 0 ? relayIds : (!requestedIds ? undefined : []);
      if (!idsForRelay || idsForRelay.length > 0) {
        const collected = await mainAgent.collect(idsForRelay, timeout_ms);
        relayResults = collected.results || [];
      }
    } catch (err) {
      process.stderr.write(`[gossipcat] collect failed: ${(err as Error).message}\n`);
    }

    // Step 2: Wait for pending native tasks (poll until they arrive or timeout)
    const pendingNativeIds = (nativeIds || []).filter(id => nativeTaskMap.has(id) && !nativeResultMap.has(id));
    if (!requestedIds) {
      // Also wait for any unspecified pending native tasks
      for (const [id] of nativeTaskMap) {
        if (!nativeResultMap.has(id) && !pendingNativeIds.includes(id)) {
          pendingNativeIds.push(id);
        }
      }
    }

    if (pendingNativeIds.length > 0 && !consensus) {
      process.stderr.write(`[gossipcat] ${pendingNativeIds.length} native agent(s) still running — results will show as 'running'. Use consensus: true to wait.\n`);
    }

    if (pendingNativeIds.length > 0 && consensus) {
      const POLL_INTERVAL = 2000;
      const nativeTimeout = Math.min(timeout_ms, 120000); // cap native wait at 2min
      const deadline = Date.now() + nativeTimeout;
      process.stderr.write(`[gossipcat] Waiting for ${pendingNativeIds.length} native agent(s) before consensus...\n`);

      while (Date.now() < deadline) {
        const stillPending = pendingNativeIds.filter(id => !nativeResultMap.has(id) && nativeTaskMap.has(id));
        if (stillPending.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }

      const arrived = pendingNativeIds.filter(id => nativeResultMap.has(id)).length;
      const timedOut = pendingNativeIds.length - arrived;
      if (timedOut > 0) {
        process.stderr.write(`[gossipcat] ${timedOut} native agent(s) timed out, proceeding with ${arrived} arrived\n`);
      } else {
        process.stderr.write(`[gossipcat] All ${arrived} native agent(s) arrived\n`);
      }
    }

    // Step 3: Merge relay + native results
    const allResults = [...relayResults];
    const collectNativeIds = nativeIds || (!requestedIds ? [...nativeResultMap.keys(), ...nativeTaskMap.keys()].filter((id, i, arr) => arr.indexOf(id) === i) : []);
    for (const id of collectNativeIds) {
      const nr = nativeResultMap.get(id);
      if (nr) {
        allResults.push(nr);
        nativeResultMap.delete(id); // consumed
      } else if (nativeTaskMap.has(id)) {
        allResults.push({ id, agentId: nativeTaskMap.get(id)!.agentId, task: nativeTaskMap.get(id)!.task, status: 'running' as const });
      }
    }

    if (allResults.length === 0) {
      return { content: [{ type: 'text' as const, text: requestedIds ? 'No matching tasks.' : 'No pending tasks.' }] };
    }

    // Step 4: Run consensus on merged results (relay + native together)
    let consensusReport: any = undefined;
    if (consensus && allResults.filter((r: any) => r.status === 'completed').length >= 2) {
      consensusReport = await mainAgent.runConsensus(allResults);
    }

    // Step 5: Format output
    const resultTexts = allResults.map((t: any) => {
      const dur = t.completedAt && t.startedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
      const modeTag = t.writeMode ? ` [${t.writeMode}${t.scope ? `:${t.scope}` : ''}]` : '';
      const nativeTag = nativeAgentConfigs.has(t.agentId) ? ' (native)' : '';
      let text: string;
      if (t.status === 'completed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}):\n${t.result}`;
      else if (t.status === 'failed') text = `[${t.id}] ${t.agentId}${nativeTag}${modeTag} (${dur}): ERROR: ${t.error}`;
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

    try {
      const { SkillGapTracker } = await import('@gossip/orchestrator');
      const tracker = new SkillGapTracker(process.cwd());
      const thresholds = tracker.checkThresholds();
      if (thresholds.count > 0) {
        output += `\n\n🔧 ${thresholds.count} skill(s) ready to build. Call gossip_build_skills() to generate them.`;
      }
    } catch { /* best-effort */ }

    // Auto skill gap suggestions: detect agents weak in categories where peers are strong
    try {
      const suggestions = mainAgent.getSkillGapSuggestions();
      if (suggestions.length > 0) {
        output += `\n\n📊 Skill gap detected:\n${suggestions.map(s => `  - ${s}`).join('\n')}`;
      }
    } catch { /* best-effort */ }

    // Session save reminder after enough activity
    try {
      const gossipCount = mainAgent.getSessionGossip().length;
      const consensusCount = mainAgent.getSessionConsensusHistory().length;
      if (gossipCount >= 5 || consensusCount >= 1) {
        output += `\n\n💡 Active session (${gossipCount} tasks, ${consensusCount} consensus runs). Call gossip_session_save() before ending to preserve what you've learned.`;
      }
    } catch { /* best-effort */ }

    return { content: [{ type: 'text' as const, text: output }] };
  }
);

// ── Consensus: dispatch with summary instruction ─────────────────────────
server.tool(
  'gossip_dispatch_consensus',
  'Dispatch tasks to multiple agents with consensus summary instruction injected. Agents will include a ## Consensus Summary section in their output. Returns task IDs — call gossip_collect_consensus to collect results with cross-review.',
  {
    tasks: z.array(z.object({
      agent_id: z.string(),
      task: z.string(),
    })).describe('Array of { agent_id, task } — all agents review the same or related work'),
  },
  async ({ tasks: taskDefs }) => {
    await boot();
    await syncWorkersViaKeychain();

    for (const def of taskDefs) {
      if (!/^[a-zA-Z0-9_-]+$/.test(def.agent_id)) {
        return { content: [{ type: 'text' as const, text: `Invalid agent ID format: "${def.agent_id}"` }] };
      }
    }

    // Split native vs custom tasks (same pattern as gossip_dispatch_parallel)
    const nativeTasks: Array<{ agent_id: string; task: string }> = [];
    const relayTasks: Array<{ agent_id: string; task: string }> = [];
    for (const def of taskDefs) {
      if (nativeAgentConfigs.has(def.agent_id)) {
        nativeTasks.push(def);
      } else {
        relayTasks.push(def);
      }
    }

    const lines: string[] = [];
    const allTaskIds: string[] = [];

    // Dispatch relay tasks with consensus
    if (relayTasks.length > 0) {
      const { taskIds, errors } = await mainAgent.dispatchParallel(
        relayTasks.map((d: any) => ({ agentId: d.agent_id, task: d.task })),
        { consensus: true },
      );
      for (const tid of taskIds) {
        const t = mainAgent.getTask(tid);
        lines.push(`  ${tid} → ${t?.agentId || 'unknown'} (relay)`);
        allTaskIds.push(tid);
      }
      if (errors.length) lines.push(`Relay errors: ${errors.join(', ')}`);
    }

    // Native tasks — inject consensus instruction into the prompt
    const consensusInstruction = '\n\n## Required Output Format\nInclude a "## Consensus Summary" section at the end with:\n- Key findings (bulleted)\n- Confidence level (high/medium/low) for each\n- Areas of uncertainty';
    const nativeInstructions: string[] = [];
    for (const def of nativeTasks) {
      const nativeConfig = nativeAgentConfigs.get(def.agent_id)!;
      const taskId = randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: def.agent_id, task: def.task, startedAt: Date.now() });
      try { mainAgent.recordNativeTask(taskId, def.agent_id, def.task); } catch { /* best-effort */ }
      allTaskIds.push(taskId);

      const agentPrompt = (nativeConfig.instructions || '') + consensusInstruction + `\n\n---\n\nTask: ${def.task}`;
      lines.push(`  ${taskId} → ${def.agent_id} (native — dispatch via Agent tool)`);
      nativeInstructions.push(
        `Agent(model: "${nativeConfig.model}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)` +
        `\n  → then: gossip_relay_result(task_id: "${taskId}", result: "<output>")`
      );
    }

    let msg = `Dispatched ${taskDefs.length} tasks with consensus:\n${lines.join('\n')}`;
    msg += '\n\nAgents will include ## Consensus Summary in output.';
    msg += `\nCall gossip_collect_consensus with task IDs: [${allTaskIds.map(id => `"${id}"`).join(', ')}]`;
    if (nativeInstructions.length > 0) {
      msg += `\n\nNATIVE_DISPATCH: Execute these ${nativeInstructions.length} Agent calls, then relay ALL results:\n\n${nativeInstructions.join('\n\n')}`;
      msg += `\n\n⚠️ You MUST call gossip_relay_result for EVERY native agent after it completes. Without it, results are lost — no memory, no consensus cross-review.`;
    }
    return { content: [{ type: 'text' as const, text: msg }] };
  }
);

// ── Consensus: collect with cross-review ─────────────────────────────────
server.tool(
  'gossip_collect_consensus',
  'Collect results and run consensus cross-review. Each agent reviews peer findings, producing agree/disagree/new judgments. Returns agent results + tagged consensus report (CONFIRMED/DISPUTED/UNIQUE/NEW). Writes signals to agent-performance.jsonl.',
  {
    task_ids: z.array(z.string()).describe('Task IDs from gossip_dispatch_consensus'),
    timeout_ms: z.number().default(300000).describe('Max wait time in ms. Default 300000 (5min).'),
  },
  async ({ task_ids, timeout_ms }) => {
    await boot();

    // Split relay vs native task IDs
    const relayIds = task_ids.filter(id => !nativeResultMap.has(id) && !nativeTaskMap.has(id));
    const nativeIds = task_ids.filter(id => nativeResultMap.has(id) || nativeTaskMap.has(id));

    // Step 1: Collect relay results WITHOUT consensus
    let relayResults: any[] = [];
    try {
      if (relayIds.length > 0) {
        const collected = await mainAgent.collect(relayIds, timeout_ms);
        relayResults = collected.results || [];
      }
    } catch (err) {
      process.stderr.write(`[gossipcat] consensus collect failed: ${(err as Error).message}\n`);
    }

    // Step 2: Wait for pending native tasks before consensus
    const pendingNativeIds = nativeIds.filter(id => nativeTaskMap.has(id) && !nativeResultMap.has(id));
    if (pendingNativeIds.length > 0) {
      const POLL_INTERVAL = 2000;
      const nativeTimeout = Math.min(timeout_ms, 120000);
      const deadline = Date.now() + nativeTimeout;
      process.stderr.write(`[gossipcat] Waiting for ${pendingNativeIds.length} native agent(s) before consensus...\n`);

      while (Date.now() < deadline) {
        const stillPending = pendingNativeIds.filter(id => !nativeResultMap.has(id) && nativeTaskMap.has(id));
        if (stillPending.length === 0) break;
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }

      const arrived = pendingNativeIds.filter(id => nativeResultMap.has(id)).length;
      const timedOut = pendingNativeIds.length - arrived;
      if (timedOut > 0) {
        process.stderr.write(`[gossipcat] ${timedOut} native agent(s) timed out, proceeding with ${arrived} arrived\n`);
      } else {
        process.stderr.write(`[gossipcat] All ${arrived} native agent(s) arrived\n`);
      }
    }

    // Step 3: Merge relay + native results
    const allResults = [...relayResults];
    for (const id of nativeIds) {
      const nr = nativeResultMap.get(id);
      if (nr) {
        allResults.push(nr);
        nativeResultMap.delete(id);
      } else if (nativeTaskMap.has(id)) {
        allResults.push({ id, agentId: nativeTaskMap.get(id)!.agentId, task: nativeTaskMap.get(id)!.task, status: 'running' as const });
      }
    }

    if (allResults.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matching tasks. Native agents may still be running — call gossip_relay_result first.' }] };
    }

    // Step 4: Run full consensus pipeline (engine + judge + signals + cross-agent learning)
    let consensusReport: any = undefined;
    const completedResults = allResults.filter((t: any) => t.status === 'completed' && t.result);
    if (completedResults.length >= 2) {
      consensusReport = await mainAgent.runConsensus(allResults);
    }

    // Step 5: Format output
    const resultTexts = allResults.map((t: any) => {
      const dur = t.completedAt && t.startedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
      const nativeTag = nativeAgentConfigs.has(t.agentId) ? ' (native)' : '';
      if (t.status === 'completed') return `[${t.id}] ${t.agentId}${nativeTag} (${dur}):\n${t.result}`;
      if (t.status === 'failed') return `[${t.id}] ${t.agentId}${nativeTag} (${dur}): ERROR: ${t.error}`;
      return `[${t.id}] ${t.agentId}${nativeTag}: still running...`;
    });

    let output = resultTexts.join('\n\n---\n\n');

    if (consensusReport?.summary) {
      output += '\n\n' + consensusReport.summary;
    } else if (completedResults.length >= 2) {
      // No automated cross-review — Claude Code will synthesize
      output += '\n\n---\n\nCross-reference the findings above. Identify: CONFIRMED (both agents agree), DISPUTED (they disagree), UNIQUE (only one found it), and any NEW insights from comparing their perspectives.';
    } else {
      output += '\n\n⚠️ Need ≥2 successful agents for consensus.';
    }

    // Auto skill gap suggestions
    try {
      const suggestions = mainAgent.getSkillGapSuggestions();
      if (suggestions.length > 0) {
        output += `\n\n📊 Skill gap detected:\n${suggestions.map(s => `  - ${s}`).join('\n')}`;
      }
    } catch { /* best-effort */ }

    return { content: [{ type: 'text' as const, text: output }] };
  }
);

// ── Info: list agents ─────────────────────────────────────────────────────
server.tool(
  'gossip_agents',
  'List all available agents: gossipcat workers AND Claude Code subagents (.claude/agents/) connected to the relay. All agents support gossip_dispatch and consensus.',
  {},
  async () => {
    const { findConfigPath, loadConfig, configToAgentConfigs, loadClaudeSubagents } = await import('./config');
    const sections: string[] = [];

    // Gossipcat agents from config
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
      sections.push(`Orchestrator: ${config.main_agent.model} (${config.main_agent.provider})`);
    }

    // Claude Code subagents loaded into relay
    const claudeSubagents = loadClaudeSubagents(process.cwd(), existingIds);
    for (const sa of claudeSubagents) {
      gossipAgents.push(`  - ${sa.id}: ${sa.provider}/${sa.model} (claude-subagent) — ${sa.description.slice(0, 60)}`);
    }

    if (gossipAgents.length > 0) {
      sections.push(`\nAgents on relay (${gossipAgents.length}):\n${gossipAgents.join('\n')}`);
    } else {
      sections.push('\nNo agents configured. Run gossip_setup or add .claude/agents/*.md files.');
    }

    // Show runtime worker status if booted
    if (booted && workers.size > 0) {
      sections.push(`\nRelay workers online: ${workers.size} — [${Array.from(workers.keys()).join(', ')}]`);
    }

    return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
  }
);

// ── Info: status ──────────────────────────────────────────────────────────
server.tool(
  'gossip_status',
  'Check Gossip Mesh system status, host environment, available agents, and dashboard URL/key',
  {},
  async () => {
    const { loadClaudeSubagents } = await import('./config');
    const claudeCount = loadClaudeSubagents(process.cwd()).length;
    const lines = [
      'Gossip Mesh Status:',
      `  Host: ${env.host}${env.supportsNativeAgents ? ' (native agents supported)' : ''}`,
      `  Native agent dir: ${env.nativeAgentDir || 'n/a'}`,
      `  Relay: ${relay ? `running :${relay.port}` : 'not started'}`,
      `  Tool Server: ${toolServer ? 'running' : 'not started'}`,
      `  Workers: ${workers.size} (${Array.from(workers.keys()).join(', ') || 'none'})`,
      `  Claude subagents found: ${claudeCount}`,
    ];
    if (relay?.dashboardUrl) {
      lines.push(`  Dashboard: ${relay.dashboardUrl} (key: ${relay.dashboardKeyPrefix}...)`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  }
);

// ── Tool: update agent instructions (supports batch) ─────────────────────
server.tool(
  'gossip_update_instructions',
  'Update one or more worker agents\' instructions. Accepts a single agent_id or an array of agent_ids for batch updates.',
  {
    agent_ids: z.union([z.string(), z.array(z.string())]).describe('Single agent ID or array of agent IDs to update'),
    instruction_update: z.string().describe('New instructions content (max 5000 chars)'),
    mode: z.enum(['append', 'replace']).describe('"append" to add to existing, "replace" to overwrite'),
  },
  async ({ agent_ids, instruction_update, mode }) => {
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

    const ids = Array.isArray(agent_ids) ? agent_ids : [agent_ids];
    const results: string[] = [];
    const { writeFileSync: writeFS, mkdirSync: mkdirFS } = require('fs');
    const { join: joinPath } = require('path');

    for (const agent_id of ids) {
      if (!/^[a-zA-Z0-9_-]+$/.test(agent_id)) {
        results.push(`${agent_id}: invalid ID format`);
        continue;
      }

      const worker = mainAgent.getWorker(agent_id);
      if (!worker) {
        results.push(`${agent_id}: not found`);
        continue;
      }

      // Backup before replace
      if (mode === 'replace') {
        const agentDir = joinPath(process.cwd(), '.gossip', 'agents', agent_id);
        mkdirFS(agentDir, { recursive: true });
        writeFS(joinPath(agentDir, 'instructions-backup.md'), worker.getInstructions());
      }

      if (mode === 'replace') {
        worker.setInstructions(instruction_update);
      } else {
        worker.setInstructions(worker.getInstructions() + '\n\n' + instruction_update);
      }

      // Persist
      const agentDir = joinPath(process.cwd(), '.gossip', 'agents', agent_id);
      mkdirFS(agentDir, { recursive: true });
      writeFS(joinPath(agentDir, 'instructions.md'), worker.getInstructions());
      results.push(`${agent_id}: updated (${mode})`);
    }

    return { content: [{ type: 'text' as const, text: results.join('\n') }] };
  }
);

// ── Tool: bootstrap — generate team context prompt ────────────────────────
server.tool(
  'gossip_bootstrap',
  'Generate team context prompt with live agent state. Refreshes .gossip/bootstrap.md.',
  {},
  async () => {
    const { BootstrapGenerator } = await import('@gossip/orchestrator');
    const generator = new BootstrapGenerator(process.cwd());
    const result = generator.generate();
    const { writeFileSync, mkdirSync } = require('fs');
    const { join } = require('path');
    mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
    writeFileSync(join(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
    return { content: [{ type: 'text' as const, text: result.prompt }] };
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
    mode: z.enum(['merge', 'replace']).default('merge')
      .describe('"merge" (default) keeps existing agents and adds/updates the ones specified. "replace" overwrites entire config.'),
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
  async ({ main_provider, main_model, mode, agents }) => {
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
  'gossip_relay_result',
  'Feed a native agent result back into the gossipcat relay. Call this after a Claude Code Agent() completes a task dispatched via gossip_dispatch for a native agent. Enables consensus cross-review and gossip for native agents.',
  {
    task_id: z.string().describe('Task ID returned by gossip_dispatch'),
    result: z.string().describe('The agent output/result text'),
    error: z.string().optional().describe('Error message if the agent failed'),
  },
  async ({ task_id, result, error }) => {
    await boot(); // [H3 fix] ensure mainAgent/pipeline are available

    const taskInfo = nativeTaskMap.get(task_id);
    if (!taskInfo) {
      return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_dispatch?` }] };
    }

    nativeTaskMap.delete(task_id);
    const elapsed = Date.now() - taskInfo.startedAt;
    evictStaleNativeTasks();

    // Run the same post-collect pipeline as custom agents:
    // 1. Memory write  2. Knowledge extraction  3. Gossip  4. Compaction
    const agentId = taskInfo.agentId;
    const agentMeta = (() => {
      try {
        const a = mainAgent.getAgentList().find((a: any) => a.id === agentId);
        return { skills: a?.skills || [], preset: a?.preset || '' };
      } catch { return { skills: [] as string[], preset: '' }; }
    })();

    // 0. Record in TaskGraph (makes native tasks visible to CLI + Supabase sync)
    try { mainAgent.recordNativeTaskCompleted(task_id, result, error || undefined); } catch { /* best-effort */ }

    // 0b. Record plan step result so subsequent steps get chain context
    if (taskInfo.planId && taskInfo.step && !error) {
      try { mainAgent.recordPlanStepResult(taskInfo.planId, taskInfo.step, result); } catch { /* best-effort */ }
    }

    if (!error) {
      // 1. Write task entry to memory
      try {
        const { MemoryWriter, MemoryCompactor } = await import('@gossip/orchestrator');
        const memWriter = new MemoryWriter(process.cwd());
        // Wire LLM for cognitive summaries — same as relay agents get
        try { if (mainAgent.getLLM()) memWriter.setSummaryLlm(mainAgent.getLLM()); } catch {}
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
      await mainAgent.publishNativeGossip(agentId, result.slice(0, 50000)).catch(() => {});
    }

    // 5. Store in collected results map so gossip_collect can find it
    const cappedResult = result ? result.slice(0, 50000) : result;
    nativeResultMap.set(task_id, {
      id: task_id,
      agentId,
      task: taskInfo.task,
      status: error ? 'failed' : 'completed',
      result: error ? undefined : cappedResult,
      error: error || undefined,
      startedAt: taskInfo.startedAt,
      completedAt: Date.now(),
    });

    const status = error ? `failed (${elapsed}ms): ${error}` : `completed (${elapsed}ms)`;
    return { content: [{ type: 'text' as const, text: `Result relayed for ${agentId} [${task_id}]: ${status}\n\nThe result is now available for gossip_collect and consensus cross-review.` }] };
  }
);

// ── gossip_run — single-call dispatch (reduces friction) ─────────────────
server.tool(
  'gossip_run',
  'Run a task on a single agent and return the result. For relay agents (Gemini), this is a single call — dispatches, waits, returns. For native agents (Sonnet/Haiku), returns dispatch instructions with gossip_run_complete callback.',
  {
    agent_id: z.string().describe('Agent to run the task on'),
    task: z.string().describe('Task description. Reference file paths — the agent will read them.'),
    write_mode: z.enum(['sequential', 'scoped', 'worktree']).optional().describe('Write mode for implementation tasks'),
    scope: z.string().optional().describe('Directory scope for scoped write mode'),
  },
  async ({ agent_id, task, write_mode, scope }) => {
    await boot();
    const isNative = nativeAgentConfigs.has(agent_id);
    const options: any = {};
    if (write_mode) options.writeMode = write_mode;
    if (scope) options.scope = scope;

    if (isNative) {
      // Native agent — record task and return instructions for host
      evictStaleNativeTasks();
      const taskId = require('crypto').randomUUID().slice(0, 8);
      nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now() });
      try { mainAgent.recordNativeTask(taskId, agent_id, task); } catch { /* best-effort */ }
      const config = nativeAgentConfigs.get(agent_id)!;
      const agentConfig = mainAgent.getAgentList?.()?.find((a: any) => a.id === agent_id);
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
        ? `SCOPE RESTRICTION: Only modify files within ${scope}. Do not edit files outside this directory.\\n\\n`
        : '';

      return {
        content: [{ type: 'text' as const, text:
          `Dispatched to ${agent_id} (native). Task ID: ${taskId}\n\n` +
          `NATIVE_DISPATCH:\n\n` +
          `Agent(model: "${config.model}", prompt: "${scopePrefix}${presetPrompt}\\n\\n---\\n\\nTask: ${task.slice(0, 200)}...")\n` +
          `  → then: gossip_run_complete(task_id: "${taskId}", result: "<output>")\n`
        }],
      };
    }

    // Relay worker — dispatch and collect in one call
    try {
      const { taskId } = mainAgent.dispatch(agent_id, task, options);
      const collectResult = await mainAgent.collect([taskId], 120000);
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

// ── gossip_run_complete — native agent callback ──────────────────────────
server.tool(
  'gossip_run_complete',
  'Complete a native agent task dispatched via gossip_run. Relays the result to the mesh, writes memory, and emits signals. Call this after the Agent() tool returns.',
  {
    task_id: z.string().describe('Task ID from gossip_run response'),
    result: z.string().describe('The agent output/result text'),
    error: z.string().optional().describe('Error message if the agent failed'),
  },
  async ({ task_id, result, error }) => {
    await boot();

    const taskInfo = nativeTaskMap.get(task_id);
    if (!taskInfo) {
      return { content: [{ type: 'text' as const, text: `Unknown task ID: ${task_id}. Was it dispatched via gossip_run?` }] };
    }

    // Reuse the same post-collect pipeline as gossip_relay_result
    nativeTaskMap.delete(task_id);
    const elapsed = Date.now() - taskInfo.startedAt;
    evictStaleNativeTasks();

    const agentId = taskInfo.agentId;
    const agentMeta = (() => {
      try {
        const a = mainAgent.getAgentList().find((a: any) => a.id === agentId);
        return { skills: a?.skills || [], preset: a?.preset || '' };
      } catch { return { skills: [] as string[], preset: '' }; }
    })();

    try { mainAgent.recordNativeTaskCompleted(task_id, result, error || undefined); } catch { /* best-effort */ }

    if (taskInfo.planId && taskInfo.step && !error) {
      try { mainAgent.recordPlanStepResult(taskInfo.planId, taskInfo.step, result); } catch { /* best-effort */ }
    }

    if (!error) {
      try {
        const { MemoryWriter, MemoryCompactor } = await import('@gossip/orchestrator');
        const memWriter = new MemoryWriter(process.cwd());
        // Wire LLM for cognitive summaries — same as relay agents get
        try { if (mainAgent.getLLM()) memWriter.setSummaryLlm(mainAgent.getLLM()); } catch {}
        const scores = presetScores(agentMeta.preset);
        await memWriter.writeTaskEntry(agentId, {
          taskId: task_id, task: taskInfo.task, skills: agentMeta.skills,
          scores,
        });
        if (result) {
          await memWriter.writeKnowledgeFromResult(agentId, {
            taskId: task_id, task: taskInfo.task, result,
          });
        }
        memWriter.rebuildIndex(agentId);
        const compactor = new MemoryCompactor(process.cwd());
        compactor.compactIfNeeded(agentId);
      } catch (err) {
        process.stderr.write(`[gossipcat] Memory write failed for ${agentId}: ${(err as Error).message}\n`);
      }
    }

    if (!error) {
      await mainAgent.publishNativeGossip(agentId, result.slice(0, 50000)).catch(() => {});
    }

    const cappedResult = result ? result.slice(0, 50000) : result;
    nativeResultMap.set(task_id, {
      id: task_id, agentId, task: taskInfo.task,
      status: error ? 'failed' : 'completed',
      result: error ? undefined : cappedResult, error: error || undefined,
      startedAt: taskInfo.startedAt, completedAt: Date.now(),
    });

    const status = error ? `failed (${elapsed}ms): ${error}` : `completed (${elapsed}ms)`;
    return { content: [{ type: 'text' as const, text: `✅ Result relayed for ${agentId} [${task_id}]: ${status}` }] };
  }
);

// ── Record consensus signals from Claude Code synthesis ───────────────────
server.tool(
  'gossip_record_signals',
  'Record consensus performance signals after cross-referencing agent findings. Call IMMEDIATELY when you verify a finding against code — don\'t batch or defer. If you read the code and the finding is wrong, record hallucination_caught right away. If confirmed, record unique_confirmed/agreement right away. Maps signals to agent performance scores that improve future dispatch decisions.',
  {
    signals: z.array(z.object({
      signal: z.enum(['agreement', 'disagreement', 'unique_confirmed', 'unique_unconfirmed', 'new_finding', 'hallucination_caught'])
        .describe('Signal type: agreement (both agree), disagreement (one wrong), unique_confirmed (only one found it + verified), unique_unconfirmed (only one found it, unverified), new_finding (discovered during cross-review), hallucination_caught (fabricated finding)'),
      agent_id: z.string().describe('Agent being evaluated'),
      counterpart_id: z.string().optional().describe('The other agent involved (e.g., who won the disagreement)'),
      finding: z.string().describe('Brief description of the finding'),
      evidence: z.string().optional().describe('Supporting evidence or reasoning'),
    })).describe('Array of consensus signals from your cross-referencing of agent results'),
  },
  async ({ signals }) => {
    await boot();

    if (signals.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No signals to record.' }] };
    }

    try {
      const { PerformanceWriter } = await import('@gossip/orchestrator');
      const writer = new PerformanceWriter(process.cwd());
      const timestamp = new Date().toISOString();

      const formatted = signals.map(s => ({
        type: 'consensus' as const,
        taskId: '',
        signal: s.signal,
        agentId: s.agent_id,
        counterpartId: s.counterpart_id,
        evidence: s.evidence || s.finding,
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

      return { content: [{ type: 'text' as const, text: `Recorded ${signals.length} consensus signals:\n${summary}\n\nThese will influence future agent selection via dispatch weighting.` }] };
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
        return { content: [{ type: 'text' as const, text: 'No performance data yet. Run gossip_dispatch_consensus + gossip_record_signals to generate signals.' }] };
      }

      const lines = Array.from(scores.values())
        .sort((a, b) => b.reliability - a.reliability)
        .map(s => {
          const w = reader.getDispatchWeight(s.agentId);
          const nativeTag = nativeAgentConfigs.has(s.agentId) ? ' (native)' : '';
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

// ── Log implementation findings (observer-only, no scoring) ──────────────
server.tool(
  'gossip_log_finding',
  'Log implementation quality findings against agents (batch). Observer-only — does NOT affect dispatch scores. Use after reviewing code written by implementer agents. Supports multiple findings in one call.',
  {
    findings: z.array(z.object({
      implementer_id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).describe('Agent ID that wrote the code'),
      reviewer_id: z.string().min(1).describe('Agent ID that found the issue (or "user")'),
      finding: z.string().min(1).max(2000).describe('Description of the bug or quality issue'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).describe('Bug severity'),
      category: z.enum(['logic_error', 'security', 'performance', 'type_safety', 'missing_tests', 'style', 'other'])
        .describe('Finding category'),
      file: z.string().optional().describe('File path'),
      line: z.number().optional().describe('Line number'),
      task_id: z.string().optional().describe('Task ID from implementation dispatch'),
    })).describe('Array of findings to log'),
  },
  async ({ findings }) => {
    if (findings.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No findings to log.' }] };
    }

    const { appendFileSync, mkdirSync, existsSync } = require('fs');
    const { join } = require('path');
    const root = process.cwd();
    const dir = join(root, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const filePath = join(dir, 'implementation-findings.jsonl');
    const timestamp = new Date().toISOString();

    const data = findings.map(f => JSON.stringify({
      timestamp,
      implementerId: f.implementer_id,
      reviewerId: f.reviewer_id,
      finding: f.finding,
      severity: f.severity,
      category: f.category,
      file: f.file || null,
      line: f.line ?? null,
      taskId: f.task_id || null,
    })).join('\n') + '\n';

    appendFileSync(filePath, data);

    // Summary by implementer
    const byAgent = new Map<string, { total: number; bySeverity: Record<string, number> }>();
    for (const f of findings) {
      const entry = byAgent.get(f.implementer_id) || { total: 0, bySeverity: {} };
      entry.total++;
      entry.bySeverity[f.severity] = (entry.bySeverity[f.severity] || 0) + 1;
      byAgent.set(f.implementer_id, entry);
    }

    const summary = Array.from(byAgent.entries())
      .map(([id, { total, bySeverity }]) => {
        const sev = Object.entries(bySeverity).map(([k, v]) => `${k}:${v}`).join(', ');
        return `  ${id}: ${total} findings (${sev})`;
      }).join('\n');

    return { content: [{ type: 'text' as const, text:
      `Logged ${findings.length} findings:\n${summary}\n\n` +
      `⚠️ Observer-only — does not affect dispatch scores.`
    }] };
  }
);

// ── View implementation findings ──────────────────────────────────────────
server.tool(
  'gossip_findings',
  'View implementation quality findings per agent. Shows bug counts by severity and category. Observer-only data from gossip_log_finding.',
  {
    agent_id: z.string().optional().describe('Filter by implementer agent ID. Omit to see all.'),
  },
  async ({ agent_id }) => {
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const filePath = join(process.cwd(), '.gossip', 'implementation-findings.jsonl');

    if (!existsSync(filePath)) {
      return { content: [{ type: 'text' as const, text: 'No implementation findings yet. Use gossip_log_finding to record findings after code reviews.' }] };
    }

    const entries: any[] = [];
    try {
      const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const l of lines) {
        try { entries.push(JSON.parse(l)); } catch {}
      }
    } catch {}

    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No implementation findings recorded.' }] };
    }

    // Group by implementer
    const byAgent = new Map<string, any[]>();
    for (const e of entries) {
      if (agent_id && e.implementerId !== agent_id) continue;
      const arr = byAgent.get(e.implementerId) || [];
      arr.push(e);
      byAgent.set(e.implementerId, arr);
    }

    if (byAgent.size === 0) {
      return { content: [{ type: 'text' as const, text: agent_id ? `No findings for ${agent_id}.` : 'No findings recorded.' }] };
    }

    const sections: string[] = [];
    for (const [id, findings] of byAgent) {
      const bySeverity: Record<string, number> = {};
      const byCategory: Record<string, number> = {};
      for (const f of findings) {
        bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
        byCategory[f.category] = (byCategory[f.category] || 0) + 1;
      }
      const nativeTag = nativeAgentConfigs.has(id) ? ' (native)' : '';
      sections.push(
        `${id}${nativeTag}: ${findings.length} findings\n` +
        `  Severity: ${Object.entries(bySeverity).map(([k, v]) => `${k}=${v}`).join(', ')}\n` +
        `  Category: ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(', ')}\n` +
        `  Recent: ${findings.slice(-3).map(f => `${f.severity} ${f.category}: ${(f.finding || 'N/A').slice(0, 60)}`).join('\n          ')}`
      );
    }

    return { content: [{ type: 'text' as const, text:
      `Implementation Findings (observer-only):\n\n${sections.join('\n\n')}\n\n` +
      `Total: ${Array.from(byAgent.values()).reduce((s, arr) => s + arr.length, 0)} findings across ${byAgent.size} agent(s). Data does NOT affect dispatch scores.`
    }] };
  }
);

// ── Build skill files from gap suggestions ────────────────────────────────
server.tool(
  'gossip_build_skills',
  'Build skill files from agent suggestions that hit threshold (3+ suggestions, 2+ agents). Call without skills to discover pending gaps. Call with skills array to save generated content.',
  {
    skill_names: z.array(z.string()).optional()
      .describe('Filter to specific skills. Omit to get all pending.'),
    skills: z.array(z.object({
      name: z.string().describe('Skill name (kebab-case)'),
      content: z.string().describe('Full .md content with frontmatter'),
    })).optional().describe('Generated skill files to save. Omit for discovery mode.'),
  },
  async ({ skill_names, skills }) => {
    await boot();

    const { SkillGapTracker, parseSkillFrontmatter, normalizeSkillName } = await import('@gossip/orchestrator');
    const tracker = new SkillGapTracker(process.cwd());

    // Save mode — write generated skill files
    if (skills && skills.length > 0) {
      const { writeFileSync, mkdirSync, existsSync, readFileSync } = require('fs');
      const { join } = require('path');
      const dir = join(process.cwd(), '.gossip', 'skills');
      mkdirSync(dir, { recursive: true });

      const results: string[] = [];
      for (const skill of skills) {
        const name = normalizeSkillName(skill.name);
        const filePath = join(dir, `${name}.md`);

        // Overwrite protection
        if (existsSync(filePath)) {
          const existing = readFileSync(filePath, 'utf-8');
          const fm = parseSkillFrontmatter(existing);
          if (fm) {
            if (fm.generated_by === 'manual') {
              results.push(`⚠️ Skipped ${name}: manually created file (generated_by: manual)`);
              continue;
            }
            if (fm.status === 'active') {
              results.push(`⚠️ Skipped ${name}: already active`);
              continue;
            }
            if (fm.status === 'disabled') {
              results.push(`⚠️ Skipped ${name}: disabled by user`);
              continue;
            }
          }
          // No frontmatter = old skeleton template, safe to overwrite
        }

        writeFileSync(filePath, skill.content);
        tracker.recordResolution(name);
        results.push(`✅ Created .gossip/skills/${name}.md`);
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
    text += `Then call gossip_build_skills(skills: [{name: "...", content: "..."}]) to save.`;

    return { content: [{ type: 'text' as const, text }] };
  }
);

// ── Generate agent-specific skill from ATI competency data ──────────────
server.tool(
  'gossip_develop_skill',
  'Generate a superpowers-quality skill file for an agent to improve performance in a specific review category. Uses ATI profiler data + reference templates.',
  {
    agent_id: z.string().describe('Agent to develop skill for (e.g., "gemini-reviewer")'),
    category: z.string().describe('Category to improve. One of: trust_boundaries, injection_vectors, input_validation, concurrency, resource_exhaustion, type_safety, error_handling, data_integrity'),
  },
  async ({ agent_id, category }) => {
    await boot();

    if (!skillGenerator) {
      return { content: [{ type: 'text' as const, text: 'Skill generator not available. Check boot logs.' }] };
    }

    try {
      const result = await skillGenerator.generate(agent_id, category);

      // Register skill on agent config so loadSkills picks it up
      if (mainAgent) {
        const registry = (mainAgent as any).registry;
        const config = registry?.get(agent_id);
        if (config && !config.skills.includes(category)) {
          config.skills.push(category);
        }
      }

      const preview = result.content.length > 1000
        ? result.content.slice(0, 1000) + '\n\n... (truncated)'
        : result.content;

      return {
        content: [{ type: 'text' as const, text: `✅ Skill generated and saved:\n\nPath: ${result.path}\n\n${preview}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `❌ Skill generation failed: ${(err as Error).message}` }],
      };
    }
  },
);

// ── Skill Index: per-agent skill slot management ─────────────────────────
server.tool(
  'gossip_skill_index',
  'Show the per-agent skill index. Each agent has skill "slots" that can be enabled/disabled. Like smart contract storage slots — deterministic addressing, O(1) lookup.',
  {},
  async () => {
    await boot();
    const index = mainAgent.getSkillIndex();
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
);

server.tool(
  'gossip_skill_bind',
  'Bind a skill to an agent (creates or updates the slot). Can also enable/disable existing slots. Skills are shared — one skill file, many agents.',
  {
    agent_id: z.string().describe('Agent to bind skill to'),
    skill: z.string().describe('Skill name (e.g. "security-audit", "typescript")'),
    enabled: z.boolean().default(true).describe('Set to false to disable the slot without removing it'),
  },
  async ({ agent_id, skill, enabled }) => {
    await boot();
    const index = mainAgent.getSkillIndex();
    if (!index) return { content: [{ type: 'text' as const, text: 'Skill index not initialized.' }] };

    const existing = index.getSlot(agent_id, skill);
    const slot = index.bind(agent_id, skill, { enabled });

    const action = existing
      ? (existing.enabled !== enabled ? (enabled ? 'enabled' : 'disabled') : 'updated')
      : 'bound';

    return { content: [{ type: 'text' as const, text: `Skill "${slot.skill}" ${action} for ${agent_id} (v${slot.version}, ${slot.enabled ? 'enabled' : 'disabled'})` }] };
  }
);

server.tool(
  'gossip_skill_unbind',
  'Remove a skill slot from an agent entirely. Use gossip_skill_bind with enabled: false to disable without removing.',
  {
    agent_id: z.string().describe('Agent to unbind skill from'),
    skill: z.string().describe('Skill name to remove'),
  },
  async ({ agent_id, skill }) => {
    await boot();
    const index = mainAgent.getSkillIndex();
    if (!index) return { content: [{ type: 'text' as const, text: 'Skill index not initialized.' }] };

    const removed = index.unbind(agent_id, skill);
    return { content: [{ type: 'text' as const, text: removed
      ? `Skill "${skill}" unbound from ${agent_id}`
      : `No slot found for "${skill}" on ${agent_id}`
    }] };
  }
);

// ── Tool: list available gossipcat tools ──────────────────────────────────
// ── Session Memory: save session context for next session ────────────────
server.tool(
  'gossip_session_save',
  'Save a cognitive session summary to project memory. The next session will load this context via gossip_bootstrap(). Call before ending your session to preserve what was learned.',
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
      const memGossip = mainAgent.getSessionGossip();
      if (memGossip.length > 0) {
        gossipText = memGossip.map((g: any) => `- ${g.agentId}: ${g.taskSummary}`).join('\n');
      }
    }

    // 2. Consensus history
    const consensusHistory = mainAgent.getSessionConsensusHistory();
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
      const since = mainAgent.getSessionStartTime().toISOString();
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

    // 5. Write session summary
    const { MemoryWriter } = await import('@gossip/orchestrator');
    const writer = new MemoryWriter(process.cwd());
    try { if (mainAgent.getLLM()) writer.setSummaryLlm(mainAgent.getLLM()); } catch {}

    const summary = await writer.writeSessionSummary({
      gossip: gossipText, consensus: consensusText,
      performance: performanceText, gitLog, notes,
    });

    // 6. Clear consumed gossip
    try {
      const { writeFileSync: wf } = require('fs');
      const { join: j } = require('path');
      wf(j(process.cwd(), '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl'), '');
    } catch {}

    let output = `Session saved to .gossip/agents/_project/memory/\n\n${summary}`;
    output += '\n\n---\nNext session: gossip_bootstrap() will load this context automatically.';
    return { content: [{ type: 'text' as const, text: output }] };
  }
);

server.tool(
  'gossip_tools',
  'List all available gossipcat MCP tools with descriptions. Call after /mcp reconnect to discover new tools.',
  {},
  async () => {
    const tools = [
      { name: 'gossip_plan', desc: 'Plan a task with write-mode suggestions. Returns dispatch-ready JSON for approval before execution.' },
      { name: 'gossip_dispatch', desc: 'Send task to a specific agent (skills auto-injected)' },
      { name: 'gossip_dispatch_parallel', desc: 'Fan out tasks to multiple agents simultaneously' },
      { name: 'gossip_collect', desc: 'Collect results from dispatched tasks' },
      { name: 'gossip_dispatch_consensus', desc: 'Dispatch with consensus summary instruction. Returns task IDs.' },
      { name: 'gossip_collect_consensus', desc: 'Collect + cross-review. Returns tagged CONFIRMED/DISPUTED/UNIQUE/NEW report.' },
      { name: 'gossip_orchestrate', desc: 'Submit task for multi-agent execution via MainAgent' },
      { name: 'gossip_agents', desc: 'List configured agents with provider, model, role, skills' },
      { name: 'gossip_status', desc: 'Check relay, tool-server, workers, and dashboard URL/key' },
      { name: 'gossip_update_instructions', desc: 'Update agent instructions (single or batch). Modes: append/replace' },
      { name: 'gossip_run', desc: 'Single-call dispatch — run a task on one agent and get the result (1 call for relay, 2 for native)' },
      { name: 'gossip_run_complete', desc: 'Complete a native agent gossip_run — relays result + signals in one call' },
      { name: 'gossip_relay_result', desc: 'Feed native Agent tool result back into relay for consensus' },
      { name: 'gossip_record_signals', desc: 'Record CONFIRMED/DISPUTED/UNIQUE/NEW signals after cross-referencing' },
      { name: 'gossip_scores', desc: 'View agent performance scores and dispatch weights' },
      { name: 'gossip_log_finding', desc: 'Log implementation quality finding (observer-only, no scoring)' },
      { name: 'gossip_findings', desc: 'View implementation findings per agent' },
      { name: 'gossip_build_skills', desc: 'Build skill files from agent gap suggestions' },
      { name: 'gossip_develop_skill', desc: 'Generate agent-specific skill from ATI competency data' },
      { name: 'gossip_session_save', desc: 'Save cognitive session summary for next session context' },
      { name: 'gossip_skill_index', desc: 'Show per-agent skill slots (enabled/disabled/version)' },
      { name: 'gossip_skill_bind', desc: 'Bind/enable/disable a skill slot on an agent' },
      { name: 'gossip_skill_unbind', desc: 'Remove a skill slot from an agent' },
      { name: 'gossip_tools', desc: 'List available tools (this command)' },
      { name: 'gossip_bootstrap', desc: 'Generate team context prompt with live agent state' },
      { name: 'gossip_setup', desc: 'Create or update team configuration' },
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
