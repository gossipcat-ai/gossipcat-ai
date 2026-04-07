#!/usr/bin/env node
/**
 * Gossipcat MCP Server — thin adapter over MainAgent/DispatchPipeline
 *
 * IMPORTANT: stderr is redirected to a log file. Claude Code interprets MCP
 * stderr output as server errors, causing "N MCP servers failed" warnings.
 * All process.stderr.write calls throughout the codebase go to .gossip/mcp.log.
 */
import { createWriteStream, mkdirSync } from 'fs';
import { join } from 'path';

// Redirect stderr to log file BEFORE any other imports
const gossipDir = join(process.cwd(), '.gossip');
try { mkdirSync(gossipDir, { recursive: true }); } catch {}
const logStream = createWriteStream(join(gossipDir, 'mcp.log'), { flags: 'a' });
const origStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = ((chunk: any, ...args: any[]) => {
  // Route ALL stderr to log file — Claude Code interprets any MCP stderr as server errors
  return logStream.write(chunk, ...args as any);
}) as any;

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID, randomBytes, timingSafeEqual } from 'crypto';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http';

// ── Extracted modules ────────────────────────────────────────────────────
import { ctx, defaultImportanceScores, NATIVE_TASK_TTL_MS } from './mcp-context';
import { evictStaleNativeTasks, persistNativeTaskMap, restoreNativeTaskMap, handleNativeRelay, spawnTimeoutWatcher } from './handlers/native-tasks';
import { handleDispatchSingle, handleDispatchParallel, handleDispatchConsensus } from './handlers/dispatch';
import { handleCollect } from './handlers/collect';
import { restorePendingConsensus } from './handlers/relay-cross-review';
import { persistRelayTasks, restoreRelayTasksAsFailed } from './handlers/relay-tasks';

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

You are the **orchestrator**. Your role is to dispatch tasks to agents, verify results, and record signals — not to implement code directly. Before writing implementation code, call \`gossip_run(agent_id: "auto", task: "...")\` to dispatch to the best agent. Exceptions: user says \`(direct)\`, or the change is docs/CSS/tests/log-strings only, or under 10 lines with no shared-state side effects.

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

### Step 5: Verify ALL UNVERIFIED findings.
UNVERIFIED does not mean "skip." It means the cross-reviewer couldn't check it — YOU can.
For each UNVERIFIED finding: grep/read the cited code or identifiers, then record the signal.
Do NOT present raw consensus results with unverified findings to the user.

### Step 6: Fix confirmed issues (only after all signals recorded).

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
// Stash gathered session data between utility dispatch and re-entry (keyed by task ID)
const _pendingSessionData = new Map<string, { gossip: string; consensus: string; performance: string; gitLog: string; notes?: string }>();

// Cache modules after first import
let _modules: any = null;

function lookupFindingSeverity(findingId: string, projectRoot: string): string | null {
  const { existsSync, readdirSync, readFileSync } = require('fs');
  const { join } = require('path');
  const reportsDir = join(projectRoot, '.gossip', 'consensus-reports');
  if (!existsSync(reportsDir)) return null;
  try {
    const files = readdirSync(reportsDir).filter((f: string) => f.endsWith('.json'));
    for (const file of files) {
      const report = JSON.parse(readFileSync(join(reportsDir, file), 'utf-8'));
      for (const bucket of ['confirmed', 'disputed', 'unverified', 'unique']) {
        for (const finding of (report[bucket] || [])) {
          if (finding.id === findingId && finding.severity) {
            return finding.severity;
          }
        }
      }
    }
  } catch { /* report not found */ }
  return null;
}

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

/** Re-read next-session.md and regenerate bootstrap.md without restarting relay/workers. */
async function refreshBootstrap() {
  try {
    const { BootstrapGenerator } = await import('@gossip/orchestrator');
    const generator = new BootstrapGenerator(process.cwd());
    const result = generator.generate();
    const { writeFileSync: wf, mkdirSync: md } = require('fs');
    const { join: j } = require('path');
    md(j(process.cwd(), '.gossip'), { recursive: true });
    wf(j(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
    // Update in-memory MainAgent so relay agents get fresh context too
    if (ctx.mainAgent) {
      ctx.mainAgent.setBootstrapPrompt(result.prompt);
    }
    // Restore task state that may have changed since initial boot (order matches doBoot)
    restoreNativeTaskMap(process.cwd());
    restoreRelayTasksAsFailed(process.cwd());
    process.stderr.write(`[gossipcat] 🔄 Bootstrap refreshed on reconnect (${result.agentCount} agents)\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Bootstrap refresh failed: ${(err as Error).message}\n`);
  }
}

async function doBoot() {
  const m = await getModules();

  const configPath = m.findConfigPath();
  if (!configPath) throw new Error('No gossip.agents.json found. Run gossipcat setup first.');

  const config = m.loadConfig(configPath);
  const agentConfigs = m.configToAgentConfigs(config);
  ctx.keychain = new m.Keychain();

  // Kill any orphaned relay process from a previous crash before binding the port.
  // We write our own PID after binding, so the file always points to the gossipcat process.
  const { existsSync: pidExists, readFileSync: readPid, writeFileSync: writePid, unlinkSync: delPid } = require('fs');
  const pidFile = join(process.cwd(), '.gossip', 'relay.pid');
  if (pidExists(pidFile)) {
    const oldPid = parseInt(readPid(pidFile, 'utf-8').trim(), 10);
    if (!isNaN(oldPid) && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // throws ESRCH if not running
        process.kill(oldPid);    // SIGTERM
        await new Promise(r => setTimeout(r, 250)); // wait for port release
      } catch { /* already dead — proceed */ }
    }
  }

  // Generate a per-process relay key so only co-launched agents can connect.
  const relayApiKey = randomBytes(32).toString('hex');

  ctx.relay = new m.RelayServer({
    port: 24420,
    apiKey: relayApiKey,
    dashboard: {
      projectRoot: process.cwd(),
      agentConfigs: agentConfigs,
    },
  });
  await ctx.relay.start();

  // Start HTTP MCP transport for remote clients
  startHttpMcpTransport();

  // Write PID so the next boot can clean up if we crash without releasing the port.
  try { writePid(pidFile, String(process.pid)); } catch { /* best-effort */ }

  // Clean up PID file on graceful exit so the next boot doesn't try to kill a dead process.
  const cleanupPid = () => { try { delPid(pidFile); } catch { /* ignore */ } };
  process.once('exit', cleanupPid);
  process.once('SIGTERM', () => { cleanupPid(); process.exit(0); });
  process.once('SIGINT',  () => { cleanupPid(); process.exit(0); });

  if (ctx.relay.dashboardUrl) {
    process.stderr.write(`[gossipcat] 🌐 Dashboard: ${ctx.relay.dashboardUrl} (key: ${ctx.relay.dashboardKey})\n`);
  }

  // Create performance writer for ATI signal collection
  const perfWriter = new m.PerformanceWriter(process.cwd());

  ctx.toolServer = new m.ToolServer({
    relayUrl: ctx.relay.url,
    projectRoot: process.cwd(),
    perfWriter,
    apiKey: relayApiKey,
    allowedCallers: agentConfigs.map(a => a.id),
  });
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
      ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.role || ac.preset || '' });
      process.stderr.write(`[gossipcat] 🤖 ${ac.id}: native agent (${modelTier})\n`);
      continue;
    }
    const key = await ctx.keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined, undefined, (ac as any).base_url);
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const instructionsPath = join(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf-8') : undefined;
    const enableWebSearch = ac.preset === 'researcher' || (ac.skills ?? []).includes('research');
    const worker = new m.WorkerAgent(ac.id, llm, ctx.relay.url, m.ALL_TOOLS, instructions, enableWebSearch, relayApiKey);
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
      process.stderr.write(`[gossipcat] 🤖 Registered native agent: ${sa.id} (${modelTier})\n`);
    }
  }

  // Try main agent key first, fall back to any available provider key, then "none"
  let mainProvider = config.main_agent.provider;
  let mainModel = config.main_agent.model;
  let mainKey: string | null = null;
  if (mainProvider === 'none') {
    // Explicit "none" — skip key lookup, use NullProvider
    process.stderr.write(`[gossipcat] ⚠️  Orchestrator LLM disabled (provider: none) — features degrade to profile-based\n`);
  } else {
    mainKey = await ctx.keychain.getKey(config.main_agent.provider);
    if (!mainKey) {
      for (const ac of agentConfigs) {
        const key = await ctx.keychain.getKey(ac.provider);
        if (key) {
          mainProvider = ac.provider;
          mainModel = ac.model;
          mainKey = key;
          process.stderr.write(`[gossipcat] ⚠️  Main agent key unavailable, using ${ac.provider}/${ac.model} for orchestration\n`);
          break;
        }
      }
    }
    if (!mainKey) {
      mainProvider = 'none';
      config.main_agent.provider = 'none';
      process.stderr.write(`[gossipcat] ❌ No API keys available — orchestrator LLM disabled, features degrade to profile-based\n`);
    }
  }
  ctx.mainProvider = mainProvider;
  const supaKey = await ctx.keychain.getKey('supabase');
  const supaTeamSalt = await ctx.keychain.getKey('supabase-team-salt');
  ctx.mainAgent = new m.MainAgent({
    provider: mainProvider,
    model: mainModel,
    apiKey: mainKey ?? undefined,
    relayUrl: ctx.relay.url,
    relayApiKey,
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
  restoreRelayTasksAsFailed(process.cwd());
  restorePendingConsensus(process.cwd());

  // Wire adaptive team intelligence (overlap detection + lens generation)
  try {
    const { OverlapDetector, LensGenerator, DispatchDifferentiator } = await import('@gossip/orchestrator');

    // In Claude Code MCP mode the orchestrator IS Claude Code — default to native utility
    // so ATI (lens gen, summarization, overlap detection) uses the orchestrator directly
    // instead of a separate API-key LLM. Can be overridden via config.utility_model.
    const autoNative = env.host === 'claude-code' && !config.utility_model;
    let utilityLlm = m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined);
    let utilityModelId = `${mainProvider}/${mainModel}`;

    if (autoNative) {
      ctx.nativeUtilityConfig = { model: 'sonnet' };
      utilityModelId = 'native/orchestrator';
    } else if (config.utility_model?.provider === 'native') {
      // Native utility: calls go through Agent() dispatch + gossip_relay, not direct LLM
      ctx.nativeUtilityConfig = { model: config.utility_model.model };
      utilityModelId = `native/${config.utility_model.model}`;
      // Don't override utilityLlm — native path branches at call sites, not at provider level
    } else if (config.utility_model) {
      const utilityKey = await ctx.keychain.getKey(config.utility_model.provider);
      if (utilityKey) {
        // If a utility model is configured AND its key exists, override the default
        utilityLlm = m.createProvider(config.utility_model.provider, config.utility_model.model, utilityKey);
        utilityModelId = `${config.utility_model.provider}/${config.utility_model.model}`;
      } else {
        // If configured but key is missing, just warn. The fallback is already set.
        process.stderr.write(`[gossipcat] ⚠️  Utility model key for "${config.utility_model.provider}" not found, falling back to main agent model for lens generation.\n`);
      }
    }

    ctx.mainAgent.setOverlapDetector(new OverlapDetector());
    ctx.mainAgent.setLensGenerator(new LensGenerator(utilityLlm));
    ctx.mainAgent.setDispatchDifferentiator(new DispatchDifferentiator());
    ctx.mainAgent.setSummaryLlm(utilityLlm);
    process.stderr.write(`[gossipcat] 🧠 Adaptive team intelligence ready (utility: ${utilityModelId})\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Adaptive team intelligence failed: ${(err as Error).message}\n`);
  }

  // Create skill generator for gossip_skills develop action
  try {
    const { PerformanceReader: PR, SkillGenerator: SG } = await import('@gossip/orchestrator');
    const skillPerfReader = new PR(process.cwd());
    ctx.skillGenerator = new SG(
      m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined),
      skillPerfReader,
      process.cwd(),
    );
    process.stderr.write('[gossipcat] ✨ Skill generator ready\n');
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Skill generator failed: ${(err as Error).message}\n`);
  }

  // Initialize per-agent skill index
  try {
    const { SkillIndex: SI } = await import('@gossip/orchestrator');
    const skillIndex = new SI(process.cwd());
    if (!skillIndex.exists()) {
      // First time: seed from config.skills[] arrays
      skillIndex.seedFromConfigs(agentConfigs.map((ac: any) => ({ id: ac.id, skills: ac.skills || [] })));
      process.stderr.write(`[gossipcat] 📚 Skill index created (seeded from ${agentConfigs.length} agent configs)\n`);
    }
    ctx.mainAgent.setSkillIndex(skillIndex);
    process.stderr.write(`[gossipcat] 📚 Skill index loaded (${skillIndex.getAgentIds().length} agents)\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Skill index failed: ${(err as Error).message}\n`);
  }

  // Create gossip publisher and wire into pipeline
  try {
    const { GossipAgent: GossipAgentPub } = await import('@gossip/client');
    const publisherAgent = new GossipAgentPub({
      agentId: 'gossip-publisher',
      relayUrl: ctx.relay.url,
      apiKey: relayApiKey,
      reconnect: true,
    });
    await publisherAgent.connect();

    const { GossipPublisher: GossipPub } = await import('@gossip/orchestrator');
    const gossipPublisher = new GossipPub(
      m.createProvider(config.main_agent.provider, config.main_agent.model, mainKey ?? undefined),
      { publishToChannel: (channel: string, data: unknown) => publisherAgent.sendChannel(channel, data as Record<string, unknown>) }
    );
    ctx.mainAgent.setGossipPublisher(gossipPublisher);
    process.stderr.write(`[gossipcat] 📡 Gossip publisher ready\n`);
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Gossip publisher failed: ${(err as Error).message}\n`);
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
      process.stderr.write(`[gossipcat] 🔄 Bootstrap refreshed (${result.agentCount} agents, session context loaded)\n`);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Bootstrap refresh failed: ${(err as Error).message}\n`);
  }

  booted = true;
  ctx.booted = true;
  process.stderr.write(`[gossipcat] 🚀 Booted: relay :${ctx.relay.port}, ${ctx.workers.size} workers\n`);
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
        ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.role || ac.preset || '' });
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
      process.stderr.write(`[gossipcat] 🔄 Synced: ${ctx.workers.size} relay workers + ${ctx.nativeAgentConfigs.size} native agents\n`);
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ syncWorkers failed: ${(err as Error).message}\n`);
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
            llm = createProvider(ac.provider, ac.model, key, undefined, (ac as any).base_url);
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
    _utility_task_id: z.string().optional().describe('Internal: utility task ID for re-entry after native lens generation'),
  },
  async ({ mode, agent_id, task, tasks, write_mode, scope, timeout_ms, plan_id, step, _utility_task_id }) => {
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
        return handleDispatchConsensus(tasks, _utility_task_id);
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

// ── Low-level: feed native cross-review results ────────────────────────────
server.tool(
  'gossip_relay_cross_review',
  'Feed native agent cross-review result back into a pending consensus round. Called after dispatching Agent() for cross-review.',
  {
    consensus_id: z.string().describe('The consensus_id from the gossip_collect response'),
    agent_id: z.string().describe('The agent that performed the cross-review'),
    result: z.string().describe('The agent cross-review output (JSON array of agree/disagree/unverified/new entries)'),
  },
  async ({ consensus_id, agent_id, result }) => {
    const { handleRelayCrossReview } = await import('./handlers/relay-cross-review');
    return handleRelayCrossReview(consensus_id, agent_id, result);
  },
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
    const banner = [
      '┌──────────────────────────────',
      '   /\\_/\\   gossipcat v0.1.0',
      '  ( o.o )  multi-agent mesh',
      '   > ^ <',
      '  /|   |\\',
      ' (_|   |_)',
    ];
    const lines = [
      ...banner,
      '',
      'Status:',
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

    // Quota health
    try {
      const { readFileSync } = await import('fs');
      const quotaPath = join(process.cwd(), '.gossip', 'quota-state.json');
      const quotaRaw = readFileSync(quotaPath, 'utf8');
      const quotaState: Record<string, { exhaustedUntil?: number }> = JSON.parse(quotaRaw);
      for (const [provider, state] of Object.entries(quotaState)) {
        const now = Date.now();
        if (state.exhaustedUntil && state.exhaustedUntil > now) {
          const cooldownSec = Math.ceil((state.exhaustedUntil - now) / 1000);
          lines.push(`  Quota: ${provider} — EXHAUSTED (${cooldownSec}s cooldown)`);
        } else {
          lines.push(`  Quota: ${provider} — OK`);
        }
      }
    } catch { /* quota-state.json not present — skip */ }

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
      // In Claude Code MCP mode, the orchestrator is Claude Code itself — don't show the
      // internal tool LLM as "Orchestrator" or "Internal LLM", it's an implementation detail.
      if (env.host !== 'claude-code') {
        agentSections.push(`Orchestrator LLM: ${config.main_agent.model} (${config.main_agent.provider})`);
      }
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

    // Onboarding hint — shown when agents are configured so new users know what to say
    const hasAgents = gossipAgents.length > 0;
    if (hasAgents) {
      agentSections.push([
        '',
        '─────────────────────────────────',
        'Try saying:',
        '  "I want to build X — set up a team for that"',
        '  "Review my recent changes"',
        '  "Do a consensus review on the auth module"',
        '  "Security audit the payment handler"',
        '  "Research how X works before I touch it"',
        '  "Show me agent scores"',
        '─────────────────────────────────',
      ].join('\n'));
    } else {
      agentSections.push([
        '',
        '─────────────────────────────────',
        'No agents yet. Try:',
        '  "I want to build a REST API — set up a team for that"',
        '  "Set up a gossipcat team with a Gemini reviewer and a Sonnet implementer"',
        '',
        'Gossipcat will propose the right agents for your project.',
        '─────────────────────────────────',
      ].join('\n'));
    }

    // Session context — regenerate from next-session.md and inject into response so the
    // orchestrator receives fresh session priorities without reading files manually.
    let sessionContextSection = '';
    try {
      const { BootstrapGenerator } = await import('@gossip/orchestrator');
      const generator = new BootstrapGenerator(process.cwd());
      const result = generator.generate();
      // Persist fresh bootstrap for other consumers (relay agents, CLI chat)
      const { writeFileSync: wf, mkdirSync: md } = require('fs');
      const { join: j } = require('path');
      md(j(process.cwd(), '.gossip'), { recursive: true });
      wf(j(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
      // Extract key sections from the bootstrap to orient the orchestrator at session start.
      // CLAUDE.md covers role/rules; bootstrap covers team state, dispatch guidance, and tools.
      const sectionPattern = (name: string) =>
        new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |\\n$|$)`);

      const roleMatch = result.prompt.match(sectionPattern('Your Role'));
      if (roleMatch) {
        sessionContextSection = `\n─────────────────────────────────\n## Your Role\n${roleMatch[1].trim()}`;
      }
      const sessionMatch = result.prompt.match(sectionPattern('Session Context'));
      if (sessionMatch) {
        sessionContextSection += `\n─────────────────────────────────\n## Session Context\n${sessionMatch[1].trim()}`;
      }
      const dispatchMatch = result.prompt.match(sectionPattern('Dispatch Rules'));
      if (dispatchMatch) {
        sessionContextSection += `\n─────────────────────────────────\n## Dispatch Rules\n${dispatchMatch[1].trim()}`;
      }
      const toolsMatch = result.prompt.match(sectionPattern('Tools'));
      if (toolsMatch) {
        sessionContextSection += `\n─────────────────────────────────\n## Tools\n${toolsMatch[1].trim()}`;
      }
    } catch { /* best-effort — missing session context is not fatal */ }

    return { content: [{ type: 'text' as const, text: lines.join('\n') + '\n\n' + agentSections.join('\n') + sessionContextSection }] };
  }
);

// ── Tool: update — check or apply gossipcat updates ──────────────────────
server.tool(
  'gossip_update',
  'Check for or apply gossipcat updates. Detects install method (global npm, local dep, git clone) and fetches the latest version from the npm registry.',
  {
    check_only: z.boolean().default(false).describe('Only check version, do not update'),
    confirm: z.boolean().default(false).describe('Set true to actually apply the update'),
  },
  async ({ check_only, confirm }) => {
    const { handleGossipUpdate } = await import('./handlers/gossip-update');
    return handleGossipUpdate({ check_only, confirm });
  },
);

// ── Tool: setup — create or update team config ────────────────────────────
server.tool(
  'gossip_setup',
  `Create or update gossipcat team. Default mode is "merge" — adds/updates specified agents while keeping existing ones. Use "replace" to overwrite entire config. Detects host environment (${env.host}) and supports both native Claude Code subagents (.claude/agents/*.md) and custom provider agents (Anthropic, OpenAI, Google Gemini).`,
  {
    main_provider: z.enum(['anthropic', 'openai', 'openclaw', 'google', 'none']).default('google')
      .describe('Provider for the orchestrator LLM. Use "none" when no API key is available — features degrade gracefully to profile-based.'),
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
      provider: z.enum(['anthropic', 'openai', 'openclaw', 'google', 'local']).optional()
        .describe('For custom agents: LLM provider'),
      custom_model: z.string().optional()
        .describe('For custom agents: model ID (e.g. gemini-2.5-pro, gpt-4o, claude-sonnet-4-6)'),
      base_url: z.string().optional()
        .refine(url => {
          if (!url) return true;
          try {
            const { protocol } = new URL(url);
            return protocol === 'http:' || protocol === 'https:';
          } catch { return false; }
        }, { message: 'base_url must be a valid http or https URL' })
        .describe('Custom base URL for OpenAI-compatible gateways. For openai: defaults to https://api.openai.com/v1. For openclaw: defaults to http://127.0.0.1:18789/v1.'),
      // Shared fields
      role: z.string().optional()
        .describe('Agent role — freeform, e.g. "ui-architect", "security-auditor", "reviewer"'),
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

    // Load existing agents up front — needed inside the loop to detect native→custom conflicts
    let existingAgents: Record<string, any> = {};
    if (mode === 'merge') {
      try {
        const { readFileSync } = require('fs');
        const existing = JSON.parse(readFileSync(join(root, '.gossip', 'config.json'), 'utf-8'));
        existingAgents = existing.agents || {};
      } catch { /* no existing config — start fresh */ }
    }

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

        const desc = agent.description || (agent as any).role || `general agent`;
        const body = agent.instructions || `You are a ${(agent as any).role || 'skilled developer'} agent. Complete assigned tasks using available tools. Be concise and focused.`;
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
          role: (agent as any).role || (agent as any).preset,
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
          role: (agent as any).role || (agent as any).preset,
          skills: agent.skills || ['general'],
          ...(agent.base_url ? { base_url: agent.base_url } : {}),
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
    agent_started_at: z.number().optional().describe('Timestamp (ms) when Agent() was launched. Used to measure actual agent execution time vs dispatch overhead.'),
    relay_token: z.string().optional().describe('One-time token issued at dispatch time. Required for native agent relays — prevents task-ID spoofing.'),
  },
  async ({ task_id, result, error, agent_started_at, relay_token }) => handleNativeRelay(task_id, result, error, agent_started_at, relay_token)
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
      try {
        await syncWorkersViaKeychain();

        // When orchestrator LLM is disabled (provider: "none") and host is Claude Code,
        // delegate classification to the main orchestrator (Claude Code itself)
        const isNullLlm = ctx.mainProvider === 'none';

        if (isNullLlm && env.host === 'claude-code') {
          const agents = ctx.mainAgent.getAgentList?.() ?? [];
          const agentSummary = agents.map((a: any) =>
            `- ${a.id} (${a.provider}/${a.model}) [${a.skills?.join(', ') || 'no skills'}]`
          ).join('\n');
          return { content: [{ type: 'text' as const, text:
            `Auto-dispatch: no orchestrator LLM — you classify.\n\n` +
            `**Task:** ${task}\n\n` +
            `**Available agents:**\n${agentSummary}\n\n` +
            `Pick the best agent and call:\n` +
            `  gossip_run(agent_id: "<chosen-agent>", task: "<task>")\n\n` +
            `For multi-agent tasks, call gossip_plan(task: "<task>") instead.`
          }] };
        }

        const classification = await ctx.mainAgent.classifyTaskComplexity(task);

        if (classification.complexity === 'multi') {
          // Multi-agent: return instructions to call gossip_plan for decomposition
          return { content: [{ type: 'text' as const, text:
            `Auto-dispatch: classified as multi-agent task.\n\n` +
            `This task needs decomposition. Call:\n` +
            `  gossip_plan(task: <full task description>)\n\n` +
            `Then review the plan and dispatch with gossip_dispatch(mode: "parallel", tasks: <plan tasks>).`
          }] };
        }

        // Single-agent: LLM picked the best agent, fall back to first available
        const selectedId = classification.agentId
          || ctx.mainAgent.getAgentList?.()[0]?.id;

        if (!selectedId) {
          return { content: [{ type: 'text' as const, text: 'No agents available. Run gossip_setup first.' }] };
        }

        // Validate agent ID format before dispatch
        if (!/^[a-zA-Z0-9_-]+$/.test(selectedId)) {
          return { content: [{ type: 'text' as const, text: `Auto-dispatch: invalid agent ID "${selectedId}". Run gossip_status() to see available agents.` }] };
        }

        // Log whether this was LLM-selected or fallback
        const source = classification.agentId ? 'LLM-selected' : 'fallback';
        process.stderr.write(`[gossipcat] 🎯 Auto-dispatch: single-agent → ${selectedId} (${source})\n`);
        agent_id = selectedId;
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Auto-dispatch failed: ${(err as Error).message}. Try gossip_run with a specific agent_id instead.` }] };
      }
    }

    const isNative = ctx.nativeAgentConfigs.has(agent_id);
    const options: any = {};
    if (write_mode) options.writeMode = write_mode;
    if (scope) options.scope = scope;

    if (isNative) {
      // Native agent — validate scope, record task, return instructions for host
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
      const taskId = require('crypto').randomUUID().slice(0, 8);
      const relayToken = require('crypto').randomUUID().slice(0, 12);
      ctx.nativeTaskMap.set(taskId, { agentId: agent_id, task, startedAt: Date.now(), timeoutMs: NATIVE_TASK_TTL_MS, relayToken });
      spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
      persistNativeTaskMap();
      try { ctx.mainAgent.recordNativeTask(taskId, agent_id, task); } catch { /* best-effort */ }

      // Register scope so subsequent dispatches see it
      if (write_mode === 'scoped' && scope) {
        ctx.mainAgent.scopeTracker.register(scope, taskId);
      }
      const config = ctx.nativeAgentConfigs.get(agent_id)!;

      // Use agent's .claude/agents/<id>.md instructions as the system prompt
      const basePrompt = config.instructions
        || `You are a skilled ${config.description || 'agent'}. Complete the task thoroughly.`;

      // Inject scope restriction for scoped write mode
      const scopePrefix = (write_mode === 'scoped' && scope)
        ? `SCOPE RESTRICTION: Only modify files within ${scope}. Do not edit files outside this directory.\n\n`
        : '';

      const agentPrompt = `${scopePrefix}${basePrompt}\n\n---\n\nTask: ${task}`;
      // config.model is already the short tier ('sonnet', 'opus', 'haiku') from boot
      const modelShort = config.model || 'sonnet';

      return {
        content: [{ type: 'text' as const, text:
          `Dispatched to ${agent_id} (native). Task ID: ${taskId}\n\n` +
          `⚠️ EXECUTE NOW — launch this Agent and relay the result:\n\n` +
          `1. Agent(model: "${modelShort}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)\n` +
          `2. When agent completes → gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<full agent output>")\n\n` +
          `Do BOTH steps in your next response. Do not wait for user input between them.`
        }],
      };
    }

    // Relay worker — dispatch and collect in one call
    // Sync workers lazily: if this agent isn't connected yet (e.g. added after boot), spin it up now
    if (!ctx.workers.has(agent_id)) {
      await syncWorkersViaKeychain();
    }
    planExecutionDepth++;
    try {
      const { taskId } = ctx.mainAgent.dispatch(agent_id, task, options);
      persistRelayTasks(); // Survive MCP reconnects — mirrors dispatch.ts pattern
      const collectResult = await ctx.mainAgent.collect([taskId], 300000);
      persistRelayTasks(); // Clear completed task from relay-tasks.json
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
    } finally {
      planExecutionDepth--;
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
      signal: z.enum(['agreement', 'disagreement', 'unique_confirmed', 'unique_unconfirmed', 'new_finding', 'hallucination_caught', 'impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected'])
        .describe('Signal type: agreement (both agree), disagreement (one wrong), unique_confirmed (only one found it + verified), unique_unconfirmed (only one found it, unverified), new_finding (discovered during cross-review), hallucination_caught (fabricated finding), impl_test_pass/fail (write-mode task outcome), impl_peer_approved/rejected (peer code review verdict)'),
      agent_id: z.string().describe('Agent being evaluated'),
      counterpart_id: z.string().optional().describe('The other agent involved (e.g., who won the disagreement)'),
      finding: z.string().describe('Brief description of the finding'),
      finding_id: z.string().optional().describe('Consensus finding ID — links this signal to a specific finding in a consensus report. Enables dashboard to resolve UNVERIFIED findings.'),
      severity: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Finding severity for impact scoring. If omitted, defaults to medium.'),
      category: z.string().optional().describe('Finding category for ATI competency profiles (e.g., concurrency, trust_boundaries, injection_vectors, resource_exhaustion, type_safety, error_handling, data_integrity, input_validation)'),
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
      const COUNTERPART_REQUIRED = new Set(['agreement', 'disagreement', 'impl_peer_approved', 'impl_peer_rejected']);

      // Validate: punitive signals require evidence
      for (const s of signals) {
        if (PUNITIVE_SIGNALS.has(s.signal) && (!s.evidence || s.evidence.trim().length === 0)) {
          return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require non-empty evidence for audit trail. Agent: ${s.agent_id}` }] };
        }
        if (COUNTERPART_REQUIRED.has(s.signal) && (!s.counterpart_id || s.counterpart_id.trim().length === 0)) {
          return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require counterpart_id. Agent: ${s.agent_id}` }] };
        }
      }

      const IMPL_SIGNALS = new Set(['impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected']);
      const formatted = signals.map((s, i) => ({
        type: (IMPL_SIGNALS.has(s.signal) ? 'impl' : 'consensus') as 'impl' | 'consensus',
        taskId: task_id || `manual-${timestamp.replace(/[:.]/g, '')}-${i}`,
        signal: s.signal,
        agentId: s.agent_id,
        counterpartId: s.counterpart_id,
        findingId: s.finding_id,
        severity: s.severity,
        category: s.category,
        source: 'manual' as const,
        evidence: ((s.evidence || s.finding) ?? '').slice(0, MAX_EVIDENCE_LENGTH),
        timestamp,
      }));

      writer.appendSignals(formatted);

      // Auto-convert hallucination signals into skill gap suggestions
      const hallucinationSignals = formatted.filter(s => s.signal === 'hallucination_caught');
      if (hallucinationSignals.length > 0) {
        try {
          const { SkillGapTracker, DEFAULT_KEYWORDS } = await import('@gossip/orchestrator');
          const gapTracker = new SkillGapTracker(process.cwd());
          for (const s of hallucinationSignals) {
            const text = `${s.evidence || ''} ${s.agentId || ''}`.toLowerCase();
            let bestCategory = '';
            let bestHits = 0;
            for (const [category, keywords] of Object.entries(DEFAULT_KEYWORDS)) {
              const hits = keywords.filter(kw => text.includes(kw)).length;
              if (hits > bestHits) { bestHits = hits; bestCategory = category; }
            }
            if (bestCategory && bestHits >= 1) {
              gapTracker.appendSuggestion({
                type: 'suggestion',
                skill: bestCategory.replace(/_/g, '-'),
                reason: `Auto: hallucination_caught — ${(s.evidence || '').slice(0, 120)}`,
                agent: s.agentId,
                task_context: s.taskId,
                timestamp: new Date().toISOString(),
              });
            }
          }
        } catch { /* best-effort */ }
      }

      // Detect severity miscalibration: auto-record when orchestrator overrides agent's severity
      for (const s of formatted) {
        if (!s.severity || !s.findingId) continue;
        const originalSeverity = lookupFindingSeverity(s.findingId, process.cwd());
        if (originalSeverity && originalSeverity !== s.severity) {
          try {
            writer.appendSignal({
              type: 'consensus',
              signal: 'severity_miscalibrated',
              taskId: s.taskId,
              agentId: s.agentId,
              evidence: `Agent claimed ${originalSeverity}, orchestrator confirmed ${s.severity}`,
              severity: s.severity,
              claimedSeverity: originalSeverity,
              category: 'severity_calibration',
              timestamp: new Date().toISOString(),
            } as any);
          } catch { /* best-effort */ }
        }
      }

      // Resolve findings in implementation-findings.jsonl when signal has finding_id
      const RESOLUTION_SIGNALS = new Set(['agreement', 'unique_confirmed']);
      const findingsWithId = signals.filter(s => s.finding_id && RESOLUTION_SIGNALS.has(s.signal));
      if (findingsWithId.length > 0) {
        try {
          const { readFileSync: rfs, writeFileSync: wfs, existsSync: exs } = require('fs');
          const { join: jp } = require('path');
          const findingsPath = jp(process.cwd(), '.gossip', 'implementation-findings.jsonl');
          if (exs(findingsPath)) {
            const lines = rfs(findingsPath, 'utf-8').trim().split('\n').filter(Boolean);
            const resolveIds = new Set(findingsWithId.map(s => s.finding_id));
            let resolvedCount = 0;
            const resolved = lines.map(line => {
              try {
                const entry = JSON.parse(line);
                // Match on taskId (which stores f.id from consensus findings) — check both unverified and unique tags
                if (entry.taskId && resolveIds.has(entry.taskId) && (entry.tag === 'unverified' || entry.tag === 'unique')) {
                  entry.tag = 'confirmed';
                  entry.status = 'resolved';
                  entry.resolvedAt = new Date().toISOString();
                  resolvedCount++;
                  return JSON.stringify(entry);
                }
                return line;
              } catch { return line; }
            });
            if (resolvedCount > 0) {
              const tmpPath = findingsPath + '.tmp.' + Date.now();
              wfs(tmpPath, resolved.join('\n') + '\n');
              require('fs').renameSync(tmpPath, findingsPath);
              process.stderr.write(`[gossipcat] Resolved ${resolvedCount} finding(s) in implementation-findings.jsonl\n`);
            }
          }
        } catch { /* best-effort */ }

        // Also resolve in consensus report files
        // Finding IDs are scoped: "reportId:fN" (new) or "fN" (legacy)
        // Scoped IDs only match within the correct report; legacy IDs match any report
        try {
          const { readdirSync: rds, readFileSync: rfs2, writeFileSync: wfs2, existsSync: exs2 } = require('fs');
          const { join: jp2 } = require('path');
          const reportsDir = jp2(process.cwd(), '.gossip', 'consensus-reports');
          if (exs2(reportsDir)) {
            // Group finding_ids by report prefix (scoped) vs unscoped (legacy)
            const scopedByReport = new Map<string, Set<string>>();
            const unscopedIds = new Set<string>();
            for (const s of findingsWithId) {
              const fid = s.finding_id as string;
              if (fid.includes(':')) {
                const [reportPrefix, localId] = fid.split(':', 2);
                if (!scopedByReport.has(reportPrefix)) scopedByReport.set(reportPrefix, new Set());
                scopedByReport.get(reportPrefix)!.add(fid);
              } else {
                unscopedIds.add(fid);
              }
            }

            for (const file of rds(reportsDir).filter((f: string) => f.endsWith('.json'))) {
              try {
                const reportPath = jp2(reportsDir, file);
                const report = JSON.parse(rfs2(reportPath, 'utf-8'));
                // Determine which IDs apply to this report
                const reportId = report.id || '';
                const idsForThisReport = new Set<string>();
                // Add scoped IDs that target this report
                const reportPrefix = reportId.split('-')[0]; // first 8 chars
                if (scopedByReport.has(reportPrefix)) {
                  for (const id of scopedByReport.get(reportPrefix)!) idsForThisReport.add(id);
                }
                if (scopedByReport.has(reportId)) {
                  for (const id of scopedByReport.get(reportId)!) idsForThisReport.add(id);
                }
                // Legacy unscoped IDs match any report (backwards compat)
                for (const id of unscopedIds) idsForThisReport.add(id);

                if (idsForThisReport.size === 0) continue;

                let changed = false;
                if (report.unverified) {
                  const remaining: any[] = [];
                  for (const f of report.unverified) {
                    if (f.id && (idsForThisReport.has(f.id) || unscopedIds.has(f.id))) {
                      f.tag = 'confirmed';
                      // Record orchestrator verification — the orchestrator manually confirmed this
                      f.confirmedBy = f.confirmedBy || [];
                      if (!f.confirmedBy.includes('orchestrator')) {
                        f.confirmedBy.push('orchestrator');
                      }
                      report.confirmed = report.confirmed || [];
                      report.confirmed.push(f);
                      changed = true;
                    } else {
                      remaining.push(f);
                    }
                  }
                  if (changed) report.unverified = remaining;
                }
                if (changed) {
                  const tmpPath = reportPath + '.tmp.' + Date.now();
                  wfs2(tmpPath, JSON.stringify(report, null, 2));
                  require('fs').renameSync(tmpPath, reportPath);
                  process.stderr.write(`[gossipcat] Resolved finding(s) in consensus report ${file}\n`);
                }
              } catch { /* skip malformed report */ }
            }
          }
        } catch { /* best-effort */ }
      }

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

      // Load skill gap data for per-agent suggestions
      let gapTracker: any = null;
      try {
        const { SkillGapTracker } = await import('@gossip/orchestrator');
        gapTracker = new SkillGapTracker(process.cwd());
      } catch { /* no gap tracker */ }

      const lines = Array.from(scores.values())
        .sort((a, b) => b.reliability - a.reliability)
        .map(s => {
          const w = reader.getDispatchWeight(s.agentId);
          const nativeTag = ctx.nativeAgentConfigs.has(s.agentId) ? ' (native)' : '';
          let line = `  ${s.agentId}${nativeTag}:\n` +
            `    accuracy=${s.accuracy.toFixed(2)} uniqueness=${s.uniqueness.toFixed(2)} reliability=${s.reliability.toFixed(2)}\n` +
            `    signals=${s.totalSignals} agree=${s.agreements} disagree=${s.disagreements} unique=${s.uniqueFindings} hallucinate=${s.hallucinations}\n` +
            `    dispatch weight=${w.toFixed(2)}${s.totalSignals < 3 ? ' (neutral — <3 signals)' : ''}`;

          const impl = reader.getImplScore(s.agentId);
          if (impl) {
            const iw = reader.getImplDispatchWeight(s.agentId);
            line += `\n    impl: passRate=${impl.passRate.toFixed(2)} peerApproval=${impl.peerApproval.toFixed(2)} reliability=${impl.reliability.toFixed(2)} implWeight=${iw.toFixed(2)}`;
          }

          // Show category strengths/weaknesses from ATI competency profiles
          const cats = (s as any).categoryStrengths;
          if (cats && Object.keys(cats).length > 0) {
            const sorted = Object.entries(cats).sort((a: any, b: any) => b[1] - a[1]);
            const strong = sorted.filter(([, v]) => (v as number) >= 0.6).map(([k, v]) => `${k}(${(v as number).toFixed(1)})`);
            const weak = sorted.filter(([, v]) => (v as number) < 0.3 && (v as number) !== 0).map(([k, v]) => `${k}(${(v as number).toFixed(1)})`);
            if (strong.length > 0) line += `\n    strengths: ${strong.slice(0, 4).join(', ')}`;
            if (weak.length > 0) {
              const weakestCategory = weak[0].split('(')[0];
              line += `\n    ⚠ weak: ${weak.slice(0, 3).join(', ')}`;
              line += `\n    → gossip_skills(action: "develop", agent_id: "${s.agentId}", category: "${weakestCategory}")`;
            }
          }
          return line;
        });

      // Append pending skill thresholds
      let pendingLine = '';
      if (gapTracker) {
        try {
          const { pending } = gapTracker.checkThresholds();
          if (pending.length > 0) {
            pendingLine = `\n\nPending skill builds (≥3 suggestions, ≥2 agents): ${pending.join(', ')}`;
            pendingLine += `\n→ gossip_skills(action: "build") to generate`;
          }
        } catch { /* best-effort */ }
      }

      return { content: [{ type: 'text' as const, text: `Agent Performance Scores (${scores.size} agents):\n\n${lines.join('\n\n')}${pendingLine}` }] };
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

      // Validate backing file exists before creating a phantom binding
      const { resolveSkillExists } = await import('@gossip/orchestrator');
      if (!resolveSkillExists(agent_id, skill, process.cwd())) {
        return { content: [{ type: 'text' as const, text: `Error: No skill file found for "${skill}". Create the file first in .gossip/agents/${agent_id}/skills/, .gossip/skills/, or default-skills/.` }] };
      }

      const existing = index.getSlot(agent_id, skill);
      const slot = index.bind(agent_id, skill, { enabled });

      const bindAction = existing
        ? (existing.enabled !== enabled ? (enabled ? 'enabled' : 'disabled') : 'updated')
        : 'bound';

      process.stderr.write(`[gossipcat] Skill "${slot.skill}" ${bindAction} for ${agent_id} (v${slot.version})\n`);
      return { content: [{ type: 'text' as const, text: `Skill "${slot.skill}" ${bindAction} for ${agent_id} (v${slot.version}, ${slot.enabled ? 'enabled' : 'disabled'})` }] };
    }

    // ── unbind ──
    if (action === 'unbind') {
      if (!agent_id) return { content: [{ type: 'text' as const, text: 'Error: agent_id is required for unbind.' }] };
      if (!skill) return { content: [{ type: 'text' as const, text: 'Error: skill is required for unbind.' }] };
      const index = ctx.mainAgent.getSkillIndex();
      if (!index) return { content: [{ type: 'text' as const, text: 'Skill index not initialized.' }] };

      const removed = index.unbind(agent_id, skill);
      if (removed) process.stderr.write(`[gossipcat] Skill "${skill}" unbound from ${agent_id}\n`);
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
        const { normalizeSkillName: nsn } = await import('@gossip/orchestrator');
        const skillName = nsn(category);

        // Auto-bind to skill index so it's injected on next dispatch
        if (ctx.mainAgent) {
          const skillIndex = ctx.mainAgent.getSkillIndex();
          if (skillIndex) {
            skillIndex.bind(agent_id, skillName, { source: 'auto', mode: 'permanent' });
          }

          // Also register on agent config for backwards compat
          const registry = (ctx.mainAgent as any).registry;
          const config = registry?.get(agent_id);
          const normalizedCategory = nsn(category);
          if (config && !config.skills.includes(normalizedCategory)) {
            config.skills.push(normalizedCategory);
          }
          // Suppress future skill gap alerts for this agent+category
          const pipeline = (ctx.mainAgent as any).pipeline;
          if (pipeline?.suppressSkillGapAlert) {
            pipeline.suppressSkillGapAlert(agent_id, category);
          }
        }

        const preview = result.content.length > 1000
          ? result.content.slice(0, 1000) + '\n\n... (truncated)'
          : result.content;

        process.stderr.write(`[gossipcat] Skill developed: "${skillName}" for ${agent_id} (category: ${category})\n`);
        return {
          content: [{ type: 'text' as const, text: `Skill generated and saved:\n\nPath: ${result.path}\n\nAuto-bound "${skillName}" to ${agent_id} in skill index.\n\n${preview}` }],
        };
      } catch (err) {
        process.stderr.write(`[gossipcat] Skill develop failed for ${agent_id}/${category}: ${(err as Error).message}\n`);
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
    _utility_task_id: z.string().optional().describe('Internal: utility task ID for re-entry after native session summary'),
  },
  async ({ notes, _utility_task_id }) => {
    await boot();

    // Re-entry fast path: retrieve stashed data, skip re-gathering
    if (_utility_task_id) {
      const stashed = _pendingSessionData.get(_utility_task_id);
      _pendingSessionData.delete(_utility_task_id);
      const summaryData = stashed ?? { gossip: '', consensus: '', performance: '', gitLog: '', notes };

      const utilityResult = ctx.nativeResultMap.get(_utility_task_id);
      const { MemoryWriter } = await import('@gossip/orchestrator');
      const writer = new MemoryWriter(process.cwd());
      try { if (ctx.mainAgent.getLLM()) writer.setSummaryLlm(ctx.mainAgent.getLLM()); } catch {}

      let summary: string;
      if (utilityResult?.status === 'completed' && utilityResult.result) {
        try {
          summary = await writer.writeSessionSummaryFromRaw({ ...summaryData, raw: utilityResult.result });
        } catch (err) {
          process.stderr.write(`[gossipcat] Native session summary post-processing failed: ${(err as Error).message}\n`);
          summary = await writer.writeSessionSummary(summaryData);
        }
      } else {
        process.stderr.write(`[gossipcat] Native session summary utility ${_utility_task_id} failed/timed out, falling back to LLM\n`);
        summary = await writer.writeSessionSummary(summaryData);
      }
      ctx.nativeResultMap.delete(_utility_task_id);
      ctx.nativeTaskMap.delete(_utility_task_id);

      // Auto-resolve findings that appear in recent commits (same as normal path)
      if (summaryData.gitLog) {
        try {
          const { readFileSync: rf, writeFileSync: wf } = require('fs');
          const { join: j } = require('path');
          const findingsPath = j(process.cwd(), '.gossip', 'implementation-findings.jsonl');
          const lines = rf(findingsPath, 'utf-8').trim().split('\n').filter(Boolean);
          let changed = false;
          const updated = lines.map((line: string) => {
            try {
              const f = JSON.parse(line);
              const fileBase = f.file?.split('/').pop() || '';
              const findingWords = (f.finding || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 5).slice(0, 3);
              const gitLogLower = summaryData.gitLog.toLowerCase();
              if (f.status === 'open' && fileBase && fileBase.length > 2 && summaryData.gitLog.includes(fileBase) && findingWords.some((w: string) => gitLogLower.includes(w))) {
                f.status = 'resolved'; f.resolvedAt = new Date().toISOString(); changed = true;
              }
              return JSON.stringify(f);
            } catch { return line; }
          });
          if (changed) wf(findingsPath, updated.join('\n') + '\n');
        } catch { /* best-effort */ }
      }

      // Append open findings to next-session.md
      try {
        const { existsSync: ex, readFileSync: rf, appendFileSync: af } = require('fs');
        const { join: j } = require('path');
        const findingsPath = j(process.cwd(), '.gossip', 'implementation-findings.jsonl');
        if (ex(findingsPath)) {
          const lines = rf(findingsPath, 'utf-8').trim().split('\n').filter(Boolean);
          const findings = lines.map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const open = findings.filter((f: any) => f.status === 'open');
          if (open.length > 0) {
            let findingsTable = '\n\n## Open Findings\n\n| Finding | Agent | Confidence | Status |\n|---------|-------|------------|--------|\n';
            for (const f of open.slice(0, 20)) {
              findingsTable += `| ${(f.finding || '').slice(0, 120)} | ${f.originalAgentId || f.reviewerId || 'unknown'} | ${f.confidence ?? '?'} | open |\n`;
            }
            af(j(process.cwd(), '.gossip', 'next-session.md'), findingsTable);
          }
        }
      } catch { /* best-effort */ }

      // Regenerate bootstrap so next gossip_status gets fresh context
      try {
        const { BootstrapGenerator } = await import('@gossip/orchestrator');
        const gen = new BootstrapGenerator(process.cwd());
        const result = gen.generate();
        const { writeFileSync: wf2, mkdirSync: md2 } = require('fs');
        const { join: j2 } = require('path');
        md2(j2(process.cwd(), '.gossip'), { recursive: true });
        wf2(j2(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
      } catch { /* best-effort */ }

      // Clear consumed gossip
      try {
        const { writeFileSync: wf } = require('fs');
        const { join: j } = require('path');
        wf(j(process.cwd(), '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl'), '');
      } catch { /* best-effort */ }

      return { content: [{ type: 'text' as const, text: `Session saved.\n\n${summary}` }] };
    }

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
            const fileBase = f.file?.split('/').pop() || '';
            // Require both filename AND a content keyword from the finding to match git log
            // Bare filename matching alone produces false positives (e.g., index.ts matches every session)
            const findingWords = (f.finding || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 5).slice(0, 3);
            const gitLogLower = gitLog.toLowerCase();
            const fileMatch = fileBase && fileBase.length > 2 && gitLog.includes(fileBase);
            const contentMatch = findingWords.length > 0 && findingWords.some((w: string) => gitLogLower.includes(w));
            if (f.status === 'open' && fileMatch && contentMatch) {
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

    const summaryData = {
      gossip: gossipText, consensus: consensusText,
      performance: performanceText, gitLog, notes,
    };

    let summary: string;

    // Native utility branch: dispatch Agent() for session summary instead of calling LLM directly
    if (ctx.nativeUtilityConfig && !_utility_task_id) {
      const { system, user } = writer.getSessionSummaryPrompt(summaryData);
      const taskId = randomUUID().slice(0, 8);
      // Stash gathered data so re-entry doesn't need to re-gather
      _pendingSessionData.set(taskId, summaryData);
      const UTILITY_TTL_MS = 120_000;
      ctx.nativeTaskMap.set(taskId, {
        agentId: '_utility',
        task: 'session_summary',
        startedAt: Date.now(),
        timeoutMs: UTILITY_TTL_MS,
        utilityType: 'session_summary',
      });
      spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);

      const agentPrompt = `${system}\n\n---\n\n${user}`;
      const modelShort = ctx.nativeUtilityConfig.model;
      return {
        content: [{ type: 'text' as const, text:
          `Session data gathered. Dispatching native utility for summary.\n\n` +
          `⚠️ EXECUTE NOW — launch this Agent and re-call gossip_session_save:\n\n` +
          `1. Agent(model: "${modelShort}", prompt: ${JSON.stringify(agentPrompt)}, run_in_background: true)\n` +
          `2. When agent completes → gossip_relay(task_id: "${taskId}", result: "<full agent output>")\n` +
          `3. Then re-call: gossip_session_save(notes: ${JSON.stringify(notes || '')}, _utility_task_id: "${taskId}")\n\n` +
          `Do ALL steps in order. Do not wait for user input between them.`
        }],
      };
    }

    // Normal path (no re-entry): call LLM directly
    summary = await writer.writeSessionSummary(summaryData);

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
      process.stderr.write('[gossipcat] 🔄 Bootstrap regenerated with new session context\n');
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
  'gossip_remember',
  'Search an agent\'s archived knowledge files.',
  {
    agent_id: z.string().describe('Agent ID to search knowledge for'),
    query: z.string().max(500).describe('Search query (max 500 chars)'),
    max_results: z.number().optional().default(3).describe('Max results (default 3, max 10)'),
  },
  async ({ agent_id, query, max_results }) => {
    await boot();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agent_id)) {
      return { content: [{ type: 'text' as const, text: 'Error: agent_id must match /^[a-zA-Z0-9_-]{1,64}$/' }] };
    }
    const { MemorySearcher } = await import('@gossip/orchestrator');
    const searcher = new MemorySearcher(process.cwd());
    const results = searcher.search(agent_id, query, max_results);
    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No knowledge found for agent "${agent_id}" matching query: "${query}"` }] };
    }
    const lines: string[] = [`Knowledge search results for agent "${agent_id}" (query: "${query}"):\n`];
    for (const r of results) {
      lines.push(`## ${r.name} (score: ${r.score.toFixed(2)})`);
      lines.push(`Source: ${r.source}`);
      if (r.description) lines.push(`Description: ${r.description}`);
      if (r.snippets.length > 0) {
        lines.push('Snippets:');
        for (const s of r.snippets) lines.push(`  - ${s}`);
      }
      lines.push('');
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
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
      { name: 'gossip_update', desc: 'Check for or apply gossipcat updates from npm. check_only:true to just see version diff.' },
      { name: 'gossip_setup', desc: 'Create or update team. mode:"merge", "replace", or "update_instructions".' },
      { name: 'gossip_session_save', desc: 'Save cognitive session summary for next session context. Call before ending session.' },
      // Power-user (5)
      { name: 'gossip_plan', desc: 'Plan a task with write-mode suggestions. Returns dispatch-ready JSON for approval.' },
      { name: 'gossip_scores', desc: 'View agent performance scores and dispatch weights.' },
      { name: 'gossip_skills', desc: 'Manage skills. action: list, bind, unbind, build, develop.' },
      { name: 'gossip_remember', desc: 'Search an agent\'s archived knowledge files by keyword query.' },
      { name: 'gossip_tools', desc: 'List available tools (this command).' },
      { name: 'gossip_progress', desc: 'Show active task progress and consensus phase. No params.' },
    ];
    const list = tools.map(t => `- ${t.name}: ${t.desc}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Gossipcat Tools (${tools.length}):\n\n${list}` }] };
  }
);

server.tool(
  'gossip_progress',
  'Show progress of active tasks and consensus rounds. Call during long-running operations to see what agents are doing.',
  {},
  async () => {
    await boot();
    const health = ctx.mainAgent.getActiveTasksHealth();
    const coordinator = ctx.mainAgent.getConsensusCoordinator();
    const phase = coordinator?.getCurrentPhase() ?? 'idle';

    const activeTasks = health.map(t => ({
      taskId: t.id,
      agentId: t.agentId,
      elapsedMs: t.elapsedMs,
      toolCalls: t.toolCalls,
      status: t.isLikelyStuck ? 'likely_stuck' : 'running',
    }));

    // Include native agent tasks (dispatched via Agent(), tracked in nativeTaskMap)
    const now = Date.now();
    for (const [taskId, info] of [...ctx.nativeTaskMap]) {
      if (ctx.nativeResultMap.has(taskId)) continue; // already completed or timed_out
      const stuckThreshold = info.timeoutMs ? Math.min(info.timeoutMs * 0.5, 300_000) : 180_000;
      activeTasks.push({
        taskId,
        agentId: info.agentId,
        elapsedMs: now - info.startedAt,
        toolCalls: 0,
        status: (now - info.startedAt > stuckThreshold) ? 'likely_stuck' : 'running',
      });
    }

    const consensus = phase !== 'idle' ? {
      phase,
      tasksComplete: activeTasks.filter(t => t.status !== 'likely_stuck').length,
      tasksTotal: activeTasks.length,
      elapsedMs: activeTasks.length > 0 ? Math.max(...activeTasks.map(t => t.elapsedMs)) : 0,
    } : null;

    // Recently completed native tasks (last 10 minutes)
    const recentCutoff = now - 600_000;
    const recentlyCompleted: Array<{ taskId: string; agentId: string; durationMs: number; status: string; completedAgoMs: number }> = [];
    for (const [taskId, info] of [...ctx.nativeResultMap]) {
      if (!info.completedAt || info.completedAt < recentCutoff) continue;
      recentlyCompleted.push({
        taskId,
        agentId: info.agentId,
        durationMs: info.completedAt - (info.startedAt || info.completedAt),
        status: info.status,
        completedAgoMs: now - info.completedAt,
      });
    }
    recentlyCompleted.sort((a, b) => a.completedAgoMs - b.completedAgoMs);

    // Reconnect recovery: if a consensus round was restored with pending native agents,
    // re-surface the EXECUTE NOW block so the orchestrator can dispatch the remaining agents.
    const recoveryBlocks: string[] = [];
    for (const [cid, round] of ctx.pendingConsensusRounds) {
      if (round.pendingNativeAgents.size === 0 || !round.nativePrompts?.length) continue;
      const pendingPrompts = round.nativePrompts.filter(p => round.pendingNativeAgents.has(p.agentId));
      if (pendingPrompts.length === 0) continue;

      const lines: string[] = [];
      lines.push(`⚠️ EXECUTE NOW — consensus round ${cid} is waiting for cross-review from ${pendingPrompts.length} agent(s).`);
      lines.push(`consensus_id: ${cid}\n`);
      lines.push(`For each agent below, dispatch Agent() then call gossip_relay_cross_review:\n`);
      for (const p of pendingPrompts) {
        const nativeConfig = ctx.nativeAgentConfigs.get(p.agentId);
        const model = nativeConfig?.model || 'sonnet';
        lines.push(`--- AGENT: ${p.agentId} (model: ${model}) ---`);
        lines.push(`Step 1: Agent(model: "${model}", prompt: <see PROMPTS section below>, run_in_background: true)`);
        lines.push(`Step 2: gossip_relay_cross_review(consensus_id: "${cid}", agent_id: "${p.agentId}", result: "<output>")\n`);
      }
      lines.push(`⚠️ You MUST execute ALL cross-review Agent() calls and relay results BEFORE continuing.\n`);
      for (const p of pendingPrompts) {
        const nativeConfig = ctx.nativeAgentConfigs.get(p.agentId);
        const model = nativeConfig?.model || 'sonnet';
        lines.push(`\n--- PROMPT FOR ${p.agentId} (model: ${model}) ---`);
        lines.push(`---SYSTEM---\n${p.system}\n---USER---\n${p.user}\n---END---`);
      }
      recoveryBlocks.push(lines.join('\n'));
    }

    if (recoveryBlocks.length > 0) {
      return { content: [{ type: 'text' as const, text: recoveryBlocks.join('\n\n===\n\n') }] };
    }

    const result = { activeTasks, recentlyCompleted, consensus };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── HTTP MCP Transport (for remote clients) ───────────────────────────────
// One StreamableHTTPServerTransport per session, reusing the same McpServer.
// Port: GOSSIPCAT_HTTP_PORT (default 24421)
// Auth: GOSSIPCAT_HTTP_TOKEN (required for remote access — mandatory when binding 0.0.0.0)
// Bind: defaults to 127.0.0.1; set GOSSIPCAT_HTTP_BIND=0.0.0.0 with a token to expose remotely
// Sessions: idle sessions evicted after 30 minutes

const HTTP_SESSION_TTL_MS = 30 * 60 * 1000;
const httpMcpSessions = new Map<string, { transport: StreamableHTTPServerTransport; timer: ReturnType<typeof setTimeout> }>();

function touchSession(sid: string): void {
  const entry = httpMcpSessions.get(sid);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    const e = httpMcpSessions.get(sid);
    if (e) { e.transport.close().catch(() => {}); httpMcpSessions.delete(sid); }
    process.stderr.write(`[gossipcat] HTTP MCP session evicted (idle): ${sid}\n`);
  }, HTTP_SESSION_TTL_MS);
}

function startHttpMcpTransport(): void {
  const port = parseInt(process.env.GOSSIPCAT_HTTP_PORT ?? '24421', 10);
  const token = process.env.GOSSIPCAT_HTTP_TOKEN ?? '';
  const bindHost = (process.env.GOSSIPCAT_HTTP_BIND === '0.0.0.0' && token) ? '0.0.0.0' : '127.0.0.1';

  const tokenBuf = token ? Buffer.from(token) : null;

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Only handle /mcp
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404);
      res.end();
      return;
    }

    // Bearer token auth — always required when token is configured; timing-safe comparison
    if (tokenBuf) {
      const auth = req.headers['authorization'] ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const providedBuf = Buffer.from(provided);
      const valid = providedBuf.length === tokenBuf.length &&
        timingSafeEqual(providedBuf, tokenBuf);
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Collect body for POST requests
    let body: unknown;
    if (req.method === 'POST') {
      const raw = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', reject);
      });
      try { body = JSON.parse(raw); } catch { /* let transport handle invalid JSON */ }
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // DELETE — client terminating a session
    if (req.method === 'DELETE' && sessionId) {
      const entry = httpMcpSessions.get(sessionId);
      if (entry) {
        clearTimeout(entry.timer);
        await entry.transport.close();
        httpMcpSessions.delete(sessionId);
      }
      res.writeHead(200); res.end();
      return;
    }

    // GET (SSE reconnect) or POST with existing session
    if (sessionId && httpMcpSessions.has(sessionId)) {
      touchSession(sessionId);
      await httpMcpSessions.get(sessionId)!.transport.handleRequest(req, res, body);
      return;
    }

    // New session (POST with initialize request)
    if (req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          const timer = setTimeout(() => {
            const e = httpMcpSessions.get(sid);
            if (e) { e.transport.close().catch(() => {}); httpMcpSessions.delete(sid); }
            process.stderr.write(`[gossipcat] HTTP MCP session evicted (idle): ${sid}\n`);
          }, HTTP_SESSION_TTL_MS);
          httpMcpSessions.set(sid, { transport, timer });
          process.stderr.write(`[gossipcat] HTTP MCP session opened: ${sid}\n`);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          const entry = httpMcpSessions.get(sid);
          if (entry) { clearTimeout(entry.timer); httpMcpSessions.delete(sid); }
          process.stderr.write(`[gossipcat] HTTP MCP session closed: ${sid}\n`);
        }
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
  });

  httpServer.listen(port, bindHost, () => {
    const authNote = token ? ' (token protected)' : ' (no auth — set GOSSIPCAT_HTTP_TOKEN to secure)';
    const bindNote = bindHost === '0.0.0.0' ? ' [remote]' : ' [localhost only]';
    process.stderr.write(`[gossipcat] HTTP MCP listening on :${port}/mcp${authNote}${bindNote}\n`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[gossipcat] HTTP MCP port ${port} in use — skipping HTTP transport\n`);
    } else {
      process.stderr.write(`[gossipcat] HTTP MCP server error: ${err.message}\n`);
    }
  });
}

// ── Start ─────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Eager boot — start relay, workers, and ATI profiler immediately on connect
  if (booted) {
    // Reconnect — relay/workers already running, just refresh bootstrap context
    refreshBootstrap().catch(() => {});
  } else {
    boot().catch(err => process.stderr.write(`[gossipcat] Boot failed: ${err.message}\n`));
  }
}

main().catch(err => { process.stderr.write(`[gossipcat] Fatal: ${err.message}\n`); process.exit(1); });
