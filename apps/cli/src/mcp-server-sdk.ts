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
import { ctx, NATIVE_TASK_TTL_MS } from './mcp-context';
import { getGossipcatVersion } from './version';
import { evictStaleNativeTasks, persistNativeTaskMap, restoreNativeTaskMap, handleNativeRelay, spawnTimeoutWatcher } from './handlers/native-tasks';
import { handleDispatchSingle, handleDispatchParallel, handleDispatchConsensus } from './handlers/dispatch';
import { handleCollect } from './handlers/collect';
import { restorePendingConsensus } from './handlers/relay-cross-review';
import { persistRelayTasks, restoreRelayTasksAsFailed } from './handlers/relay-tasks';
import { pickStickyPort, writeStickyPort, RELAY_STICKY_FILE, HTTP_MCP_STICKY_FILE } from './stickyPort';

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
// Stash skill develop prompt metadata between native-utility dispatch and re-entry (keyed by task ID)
const _pendingSkillData = new Map<string, { agentId: string; category: string; skillName: string; skillPath: string; baseline_accuracy_correct: number; baseline_accuracy_hallucinated: number; bound_at: string }>();

// Re-entry stash for gossip_verify_memory native-utility dispatch. Keyed by
// the utility task id; cleared on re-entry. Without this we'd need to re-read
// the file and re-validate inputs on the second call.
const _pendingVerifyData = new Map<string, { memory_path: string; absPath: string; claim: string }>();

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
    formatIdentityBlock: (await import('@gossip/tools')).formatIdentityBlock,
    MainAgent: (await import('@gossip/orchestrator')).MainAgent,
    WorkerAgent: (await import('@gossip/orchestrator')).WorkerAgent,
    createProvider: (await import('@gossip/orchestrator')).createProvider,
    PerformanceWriter: (await import('@gossip/orchestrator')).PerformanceWriter,
    SkillEngine: (await import('@gossip/orchestrator')).SkillEngine,
    MemorySearcher: (await import('@gossip/orchestrator')).MemorySearcher,
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

  // Degraded-mode boot: if no config file exists (fresh install, first run),
  // we still boot the relay + dashboard so the user can see the UI and run
  // gossip_setup from inside Claude Code. Previously this threw and the error
  // was silently swallowed by the stderr→logfile redirect, leaving users with
  // a "nothing works" experience on first install. Fix: synthesize a minimal
  // empty config and let the existing `mainProvider === 'none'` degraded path
  // handle the missing orchestrator LLM.
  const configPath = m.findConfigPath();
  let config: any;
  if (configPath) {
    config = m.loadConfig(configPath);
  } else {
    process.stderr.write('[gossipcat] ⚠️  No gossip.agents.json found — booting in degraded mode (dashboard + relay only). Run gossip_setup inside Claude Code to create your agent team.\n');
    config = {
      main_agent: { provider: 'none', model: 'none' },
      utility_model: { provider: 'none', model: 'none' },
      agents: {},
    };
  }
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

  // Port selection: env → sticky file (.gossip/relay.port) → OS-assigned.
  // GOSSIPCAT_PORT still wins unconditionally. When unset we try to re-bind the
  // last port this project used so dashboard URLs stay stable across reboots,
  // then fall back to port 0 if it's busy — multiple Claude Code instances can
  // still run gossipcat in parallel on the same machine. The actual bound port
  // is logged to stderr, written to .gossip/relay.port, and exposed via
  // gossip_status() + the MCP `instructions` field after boot.
  const relayPick = await pickStickyPort('GOSSIPCAT_PORT', RELAY_STICKY_FILE);
  const relayPort = relayPick.port;
  ctx.relayPortSource = relayPick.source;

  ctx.relay = new m.RelayServer({
    port: relayPort,
    apiKey: relayApiKey,
    dashboard: {
      projectRoot: process.cwd(),
      agentConfigs: agentConfigs,
    },
  });
  await ctx.relay.start();

  // Persist the actual bound port for next boot's sticky lookup.
  if (typeof ctx.relay.port === 'number' && ctx.relay.port > 0) {
    writeStickyPort(RELAY_STICKY_FILE, ctx.relay.port);
  }

  // Start HTTP MCP transport for remote clients
  await startHttpMcpTransport();

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

  // Inject MemorySearcher so relay workers can call memory_query without
  // requiring packages/tools to import @gossip/orchestrator (would create a
  // circular dependency). Both gossip_remember and memory_query now hit the
  // same backend instance.
  const memorySearcher = new m.MemorySearcher(process.cwd());

  // Build an identity registry from agentConfigs so the self_identity tool
  // can return runtime/provider/model for the calling agent. Native subagents
  // (Claude Code Agent()) don't go through ToolServer, so this registry only
  // serves relay workers — but we record both runtimes here for symmetry with
  // the dispatch-time prompt injection.
  const identityRegistry = new Map<string, { agent_id: string; runtime: 'native' | 'relay'; provider: string; model: string }>();
  for (const a of agentConfigs as Array<{ id: string; provider: string; model: string; native?: boolean }>) {
    identityRegistry.set(a.id, {
      agent_id: a.id,
      runtime: a.native ? 'native' : 'relay',
      provider: a.provider,
      model: a.model,
    });
  }
  const agentLookup = (id: string) => identityRegistry.get(id);

  ctx.toolServer = new m.ToolServer({
    relayUrl: ctx.relay.url,
    projectRoot: process.cwd(),
    perfWriter,
    apiKey: relayApiKey,
    allowedCallers: agentConfigs.map((a: { id: string }) => a.id),
    memorySearcher,
    agentLookup,
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
      ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.role || ac.preset || '', skills: ac.skills || [] });
      process.stderr.write(`[gossipcat] 🤖 ${ac.id}: native agent (${modelTier})\n`);
      continue;
    }
    const key = await ctx.keychain.getKey(ac.provider);
    const llm = m.createProvider(ac.provider, ac.model, key ?? undefined, undefined, (ac as any).base_url);
    const { existsSync, readFileSync } = require('fs');
    const { join } = require('path');
    const instructionsPath = join(process.cwd(), '.gossip', 'agents', ac.id, 'instructions.md');
    const baseInstructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, 'utf-8') : '';
    // Prepend identity block so the agent knows its own agentId/runtime/model
    // without needing to call self_identity. self_identity remains available
    // for re-checks after context summarization.
    const identity = identityRegistry.get(ac.id);
    const identityBlock = identity ? m.formatIdentityBlock(identity) + '\n' : '';
    const instructions = (identityBlock + baseInstructions).trim() || undefined;
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
      ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description, skills: ac.skills || [] });
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
      // On Claude Code hosts with native subagents available, "none" is the
      // expected zero-config state — the host classifies via natural language
      // through isNullLlm path. Don't misrepresent this as an error.
      if (env.host === 'claude-code') {
        process.stderr.write(`[gossipcat] ✅ Native Claude Code orchestration enabled (no API LLM needed — host classifies via natural language)\n`);
      } else {
        process.stderr.write(`[gossipcat] ❌ No API keys available — orchestrator LLM disabled, features degrade to profile-based\n`);
      }
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

  // Create skill engine for gossip_skills develop action
  try {
    const { PerformanceReader: PR, SkillEngine: SE } = await import('@gossip/orchestrator');
    const skillPerfReader = new PR(process.cwd());
    ctx.skillEngine = new SE(
      m.createProvider(mainProvider as any, mainModel, mainKey ?? undefined),
      skillPerfReader,
      process.cwd(),
    );
    process.stderr.write('[gossipcat] ✨ Skill engine ready\n');
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ Skill engine failed: ${(err as Error).message}\n`);
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

    // Auto-seed global permanent default skills into every agent's slot list.
    // Runs on EVERY boot (not just first-init via seedFromConfigs) so these
    // skills reach existing installs with a previously-seeded index too.
    //
    // Initially I tried to scan the default-skills directory and filter by
    // mode:permanent frontmatter, but the existing default skill files
    // (code-review.md, security-audit.md, etc.) don't have frontmatter at
    // all — they work today only because they're explicitly listed in each
    // agent's .gossip/config.json skills array. So the scan approach would
    // find zero permanent defaults and no-op. Instead we hardcode the list
    // of "global permanent defaults" — skills that should reach every agent
    // regardless of their config, because they teach about cross-cutting
    // tools like gossip_remember.
    //
    // ensureBoundWithMode is idempotent: existing slots are untouched, new
    // slots added. The "no overlap between permanent and contextual"
    // invariant the user raised is enforced by construction: once a slot is
    // bound, its mode is authoritative for that agent and won't be clobbered.
    const GLOBAL_PERMANENT_DEFAULTS = ['memory-retrieval'];
    try {
      const allAgentIds = agentConfigs.map((ac: any) => ac.id).filter((id: any) => typeof id === 'string' && id.length > 0);
      if (allAgentIds.length > 0) {
        skillIndex.ensureBoundWithMode(GLOBAL_PERMANENT_DEFAULTS, allAgentIds, 'permanent');
        process.stderr.write(`[gossipcat] 📚 Global permanent defaults seeded: ${GLOBAL_PERMANENT_DEFAULTS.join(', ')} → ${allAgentIds.length} agents\n`);
      }
    } catch (seedErr) {
      process.stderr.write(`[gossipcat] ⚠️  Global permanent skill auto-seed failed: ${(seedErr as Error).message}\n`);
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

  // First-run materialization: copy bundled rules to .gossip/rules.md if missing.
  // Done after relay starts but before bootstrap is regenerated, so the bootstrap
  // pulls the freshly materialized rules into its output.
  try {
    const { ensureRulesFile } = await import('@gossip/orchestrator');
    const rulesResult = ensureRulesFile(process.cwd());
    if (rulesResult.created) {
      process.stderr.write(
        '[gossipcat] Created .gossip/rules.md from bundled defaults — edit this file to customize project rules\n'
      );
    }
  } catch (err) {
    process.stderr.write(`[gossipcat] ❌ ensureRulesFile failed: ${(err as Error).message}\n`);
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

  // Surface any active quota cooldown at boot so the orchestrator sees it
  // without having to call gossip_status. Without this, a server that boots
  // mid-cooldown silently routes dispatches through the fallback map and
  // nothing indicates why — looks like random flakiness. See
  // project_quota_watcher.md.
  try {
    const { readFileSync: rfs } = require('fs');
    const { join: jn } = require('path');
    const quotaPath = jn(process.cwd(), '.gossip', 'quota-state.json');
    const quotaState: Record<string, { exhaustedUntil?: number; reason?: string }> = JSON.parse(rfs(quotaPath, 'utf8'));
    const now = Date.now();
    for (const [provider, state] of Object.entries(quotaState)) {
      if (state.exhaustedUntil && state.exhaustedUntil > now) {
        const cooldownSec = Math.ceil((state.exhaustedUntil - now) / 1000);
        process.stderr.write(`[gossipcat] ⏳ quota cooldown active: ${provider} — ${cooldownSec}s remaining (${state.reason ?? 'quota'}). Dispatches will fall back to native agents.\n`);
      }
    }
  } catch { /* quota-state.json not present or invalid — skip */ }
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
        ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions, description: ac.role || ac.preset || '', skills: ac.skills || [] });
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
        ctx.nativeAgentConfigs.set(ac.id, { model: modelTier, instructions: sa.instructions, description: sa.description, skills: ac.skills || [] });
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
const server = new McpServer(
  {
    name: 'gossipcat',
    version: getGossipcatVersion(),
  },
  {
    instructions:
      'gossipcat — multi-agent orchestration. ALWAYS call gossip_status() first when starting work in this project. The gossip_status response loads the orchestrator role, dispatch rules, consensus workflow, native agent relay rule, sandbox enforcement, and other operating rules from .gossip/rules.md. These rules are not in this instruction text — they live in the gossip_status output to keep the instruction surface small and to allow per-project customization.',
  }
);

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
      `  Relay: ${ctx.relay ? `running :${ctx.relay.port}${ctx.relayPortSource === 'sticky' ? ' (sticky)' : ''}` : 'not started'}`,
      `  Tool Server: ${ctx.toolServer ? 'running' : 'not started'}`,
      `  Workers: ${ctx.workers.size} (${Array.from(ctx.workers.keys()).join(', ') || 'none'})`,
      `  Claude subagents found: ${claudeSubagentsList.length}`,
    ];
    if (ctx.relay?.dashboardUrl) {
      lines.push(`  Dashboard: ${ctx.relay.dashboardUrl}${ctx.relayPortSource === 'sticky' ? ' (sticky)' : ''} (key: ${ctx.relay.dashboardKey})`);
    }
    if (ctx.httpMcpPort) {
      lines.push(`  HTTP MCP: :${ctx.httpMcpPort}/mcp${ctx.httpMcpPortSource === 'sticky' ? ' (sticky)' : ''}`);
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

    // Signals pending — recent consensus rounds with no manually-recorded signals.
    // Surfaces the back-search gap (per consensus 4c88bcd3, haiku:f17) so the
    // orchestrator can SEE which rounds it skipped without having to remember.
    // Mirrors the existing gossip_status reconnect-recovery pattern for
    // pendingConsensusRounds re-surfacing.
    try {
      const { readFileSync, readdirSync, statSync } = await import('fs');
      const reportsDir = join(process.cwd(), '.gossip', 'consensus-reports');
      const perfPath = join(process.cwd(), '.gossip', 'agent-performance.jsonl');

      // Window: rounds completed within the last 24h are still actionable.
      const WINDOW_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const recentReports: Array<{ id: string; mtimeMs: number }> = [];
      try {
        for (const fname of readdirSync(reportsDir)) {
          if (!fname.endsWith('.json')) continue;
          const fpath = join(reportsDir, fname);
          const st = statSync(fpath);
          if (now - st.mtimeMs > WINDOW_MS) continue;
          recentReports.push({ id: fname.replace(/\.json$/, ''), mtimeMs: st.mtimeMs });
        }
      } catch { /* reports dir missing — no rounds yet */ }

      if (recentReports.length > 0) {
        // Build set of consensusIds that have at least one manually-recorded signal.
        const covered = new Set<string>();
        try {
          const perfRaw = readFileSync(perfPath, 'utf8');
          for (const line of perfRaw.split('\n')) {
            if (!line) continue;
            try {
              const sig = JSON.parse(line);
              if (sig.source !== 'manual') continue;
              const fid: string | undefined = sig.findingId;
              if (typeof fid === 'string' && fid.includes(':')) {
                // findingId is "<consensusId>:<agentId>:fN" (modern) or
                // "<consensusId>:fN" (legacy). consensusId is itself a single
                // token of the form "<8hex>-<8hex>" — the dash is NOT a colon
                // separator. Take the first colon-segment in both shapes.
                covered.add(fid.split(':')[0]);
              }
            } catch { /* skip malformed line */ }
          }
        } catch { /* no perf log yet — every round is pending */ }

        const pending = recentReports.filter(r => !covered.has(r.id));
        if (pending.length > 0) {
          // Sort newest first, show up to 3 with relative ages
          pending.sort((a, b) => b.mtimeMs - a.mtimeMs);
          const displayed = pending.slice(0, 3);
          const ageStr = (ms: number) => {
            const sec = Math.floor((now - ms) / 1000);
            if (sec < 60) return `${sec}s ago`;
            if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
            return `${Math.floor(sec / 3600)}h ago`;
          };
          lines.push(`  ⚠️ Signals pending: ${pending.length} consensus round${pending.length === 1 ? '' : 's'} with no recorded signals — back-search will be incomplete`);
          for (const p of displayed) {
            lines.push(`     - ${p.id} (${ageStr(p.mtimeMs)}) → call gossip_signals(action: "record")`);
          }
          if (pending.length > displayed.length) {
            lines.push(`     - … and ${pending.length - displayed.length} more`);
          }
        }
      }
    } catch { /* best-effort — never block status on this */ }

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

    // Project handbook — load docs/HANDBOOK.md if present so every new session
    // inherits the operator wisdom (architectural invariants, caveats, lessons,
    // hallucination patterns to watch for). This is how earned wisdom transfers
    // across sessions and installations without living only in chat history.
    let handbookSection = '';
    try {
      const { readFileSync: rfHB, statSync: stHB } = require('fs');
      const { join: jHB } = require('path');
      const handbookPath = jHB(process.cwd(), 'docs', 'HANDBOOK.md');
      const stat = stHB(handbookPath);
      // Cap at 24KB of handbook content so the status response doesn't balloon
      // beyond the context window on very large handbooks. If capped, append a
      // pointer so the orchestrator knows to read the full file manually.
      const HANDBOOK_CAP_BYTES = 24 * 1024;
      let body = rfHB(handbookPath, 'utf-8');
      const truncated = body.length > HANDBOOK_CAP_BYTES;
      if (truncated) {
        body = body.slice(0, HANDBOOK_CAP_BYTES);
      }
      handbookSection =
        '\n─────────────────────────────────\n' +
        '## Project Handbook (auto-loaded from docs/HANDBOOK.md)\n\n' +
        body.trim() +
        (truncated
          ? `\n\n[handbook truncated at ${HANDBOOK_CAP_BYTES / 1024}KB — full file at docs/HANDBOOK.md, ${stat.size} bytes total]`
          : '');
    } catch { /* no handbook present — skip silently, this is optional infrastructure */ }

    return { content: [{ type: 'text' as const, text: lines.join('\n') + '\n\n' + agentSections.join('\n') + sessionContextSection + handbookSection }] };
  }
);

// ── Tool: guide — human-facing handbook reader ──────────────────────────
// This is the human-visible counterpart to the LLM-facing handbook auto-load
// in gossip_status(). Users call this explicitly when they want to READ the
// handbook; gossip_status injects it invisibly for orchestrator context.
// Different audiences, different delivery mechanisms — same source artifact.
server.tool(
  'gossip_guide',
  'Show the gossipcat handbook for humans — architectural invariants, operator playbook, caveats, hallucination patterns, glossary. Call this when you want to READ the docs, not when you need LLM context. The LLM-facing auto-load lives in gossip_status().',
  {},
  async () => {
    try {
      const { readFileSync: rfG, existsSync: exG } = require('fs');
      const { join: jG, dirname: dG } = require('path');
      // Prefer the current project's customized handbook
      const projectHandbook = jG(process.cwd(), 'docs', 'HANDBOOK.md');
      if (exG(projectHandbook)) {
        const body = rfG(projectHandbook, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: `# Gossipcat Handbook (from ${projectHandbook})\n\n${body}`,
          }],
        };
      }
      // Fallback to the bundled default handbook shipped with gossipcat
      // (resolved relative to the running MCP bundle)
      const bundleRoot = dG(require.resolve('../../dist-mcp/mcp-server.js').replace(/\/dist-mcp\/mcp-server\.js$/, '/dist-mcp/mcp-server.js'));
      const defaultHandbook = jG(bundleRoot, '..', 'docs', 'HANDBOOK.md');
      if (exG(defaultHandbook)) {
        const body = rfG(defaultHandbook, 'utf-8');
        return {
          content: [{
            type: 'text' as const,
            text: `# Gossipcat Handbook (bundled default — your project has no docs/HANDBOOK.md yet)\n\n${body}`,
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: 'No handbook found. Expected at docs/HANDBOOK.md in the current project or bundled with gossipcat. If you are inside a gossipcat project, run `gossip_setup` first.',
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error reading handbook: ${(err as Error).message}`,
        }],
      };
    }
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
        // mcp__gossipcat__gossip_remember exposes the agent-archive search to native
        // subagents so they can recall past learnings on demand instead of needing
        // everything pre-injected via the prompt. Added 2026-04-08 — earlier sessions
        // shipped the MCP tool but no agent could call it, see
        // memory/project_remember_tool_unreachable.md for the full back-story.
        const tools = ['Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'mcp__gossipcat__gossip_remember'];
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

    // Refresh dashboard's cached agent configs so the Team page reflects the
    // new team without requiring /mcp reconnect. The boot-time snapshot at
    // :365 still wins on initial boot — this is a post-setup override for
    // the common "boot before setup" fresh-install flow. Only fires on create
    // modes (merge/replace); update_instructions returns earlier at :1504.
    try {
      const m = await getModules();
      const freshConfig = m.loadConfig(join(root, '.gossip', 'config.json'));
      const freshAgentConfigs = m.configToAgentConfigs(freshConfig);
      ctx.relay?.setAgentConfigs(freshAgentConfigs);
    } catch (e) {
      process.stderr.write(`[gossipcat] gossip_setup: failed to refresh dashboard agent configs: ${e}\n`);
    }

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

    // Sandbox mitigation 1: sanitize project paths in the task prompt
    let _runSanitized = false;
    try {
      const { relativizeProjectPaths, readSandboxMode, shouldSanitize } = require('./sandbox');
      if (readSandboxMode(process.cwd()) !== 'off') {
        const preset = (() => {
          try { return ctx.mainAgent.getAgentList?.().find((a: any) => a.id === agent_id)?.preset; } catch { return undefined; }
        })();
        if (shouldSanitize(write_mode, preset)) {
          const { sanitized, replacements } = relativizeProjectPaths(task, process.cwd());
          if (replacements > 0) {
            process.stderr.write(`[gossipcat] 🧹 sanitized ${replacements} project path(s) in task for ${agent_id}\n`);
          }
          task = sanitized;
          _runSanitized = true;
        }
      }
    } catch { /* best-effort */ }

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

      let agentPrompt = `${scopePrefix}${basePrompt}\n\n---\n\nTask: ${task}`;
      if (_runSanitized) {
        try {
          const { prependScopeNote } = require('./sandbox');
          agentPrompt = prependScopeNote(agentPrompt);
        } catch { /* best-effort */ }
      }
      // Record dispatch metadata for post-task audit
      try {
        const { recordDispatchMetadata } = require('./sandbox');
        recordDispatchMetadata(process.cwd(), {
          taskId, agentId: agent_id, writeMode: write_mode, scope, timestamp: Date.now(),
        });
      } catch { /* best-effort */ }
      // config.model is already the short tier ('sonnet', 'opus', 'haiku') from boot
      const modelShort = config.model || 'sonnet';

      return {
        content: [
          { type: 'text' as const, text:
            `Dispatched to ${agent_id} (native). Task ID: ${taskId}\n\n` +
            `⚠️ EXECUTE NOW — launch this Agent and relay the result:\n\n` +
            `1. Agent(model: "${modelShort}", prompt: <AGENT_PROMPT:${taskId} below>, run_in_background: true) — pass the AGENT_PROMPT:${taskId} content item verbatim\n` +
            `2. When agent completes → gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<full agent output>")\n\n` +
            `Do BOTH steps in your next response. Do not wait for user input between them.`
          },
          { type: 'text' as const, text: `AGENT_PROMPT:${taskId} (${agent_id})\n${agentPrompt}` },
        ],
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
      try {
        const { recordDispatchMetadata } = require('./sandbox');
        recordDispatchMetadata(process.cwd(), {
          taskId, agentId: agent_id, writeMode: write_mode, scope, timestamp: Date.now(),
        });
      } catch { /* best-effort */ }
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
    action: z.enum(['record', 'retract', 'bulk_from_consensus']).default('record').describe('Action: "record" to add signals, "retract" to undo a previous signal, "bulk_from_consensus" to auto-record signals for all findings in a consensus report'),
    consensus_id: z.string().optional().describe('Consensus report ID (8-8 hex format, e.g. "5e8a7194-73e240da"). Required for action: "bulk_from_consensus".'),
    // record params
    task_id: z.string().optional().describe('Task ID to link signals to. For record: optional (synthetic ID if omitted). For retract: required.'),
    task_start_time: z.string().optional().describe('ISO-8601 timestamp of the underlying task/consensus round. Used as the per-batch fallback timestamp so bulk-recording from a backlog preserves true chronology. Falls back to wall-clock if omitted.'),
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
      timestamp: z.string().optional().describe('ISO-8601 timestamp of when this specific finding occurred. Highest precedence; overrides task_start_time. Use for per-finding chronology when known.'),
    })).optional().describe('Array of consensus signals (required for action: "record")'),
    // retract params
    agent_id: z.string().optional().describe('Agent whose signal to retract (required for action: "retract")'),
    reason: z.string().optional().describe('Why this signal is being retracted (required for action: "retract")'),
  },
  async ({ action, task_id, task_start_time, signals, agent_id, reason, consensus_id }) => {
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

    if (action === 'bulk_from_consensus') {
      if (!consensus_id || consensus_id.trim().length === 0) {
        return { content: [{ type: 'text' as const, text: 'Error: consensus_id is required for bulk_from_consensus.' }] };
      }
      try {
        const { readFileSync } = await import('fs');
        const { join } = await import('path');
        const reportPath = join(process.cwd(), '.gossip', 'consensus-reports', `${consensus_id}.json`);
        let report: any;
        try {
          report = JSON.parse(readFileSync(reportPath, 'utf-8'));
        } catch {
          return { content: [{ type: 'text' as const, text: `Error: consensus report not found: ${consensus_id}` }] };
        }

        // Load existing finding IDs for dedup
        const existingFindingIds = new Set<string>();
        try {
          const perfPath = join(process.cwd(), '.gossip', 'agent-performance.jsonl');
          const lines = readFileSync(perfPath, 'utf-8').split('\n').filter(Boolean);
          for (const line of lines) {
            try { const rec = JSON.parse(line); if (rec.findingId) existingFindingIds.add(rec.findingId); } catch { /* skip */ }
          }
        } catch { /* file may not exist yet */ }

        const { PerformanceWriter } = await import('@gossip/orchestrator');
        const writer = new PerformanceWriter(process.cwd());
        const batchTs = report.timestamp || new Date().toISOString();
        const batchTaskId = task_id || `bulk-${consensus_id}`;

        type PS = import('@gossip/orchestrator').PerformanceSignal;
        const toRecord: PS[] = [];
        const dupes: string[] = [];
        let agreementCount = 0, disagreementCount = 0, uniqueCount = 0;

        const addSignal = (signalType: string, f: any) => {
          const fid = f.id as string | undefined;
          if (fid && existingFindingIds.has(fid)) { dupes.push(fid); return; }
          toRecord.push({
            type: 'consensus',
            signal: signalType as any,
            agentId: f.originalAgentId,
            taskId: batchTaskId,
            findingId: fid,
            severity: f.severity,
            source: 'manual',
            evidence: (f.finding || '').slice(0, 2000),
            timestamp: batchTs,
          } as Extract<PS, { type: 'consensus' }>);
        };

        for (const f of report.confirmed ?? []) { addSignal('agreement', f); agreementCount++; }
        for (const f of report.disputed ?? []) { addSignal('disagreement', f); disagreementCount++; }
        for (const f of report.unique ?? []) { addSignal('unique_unconfirmed', f); uniqueCount++; }

        if (toRecord.length > 0) writer.appendSignals(toRecord);

        const skipped = dupes.length;
        let receipt = `Recorded ${agreementCount} agreement, ${disagreementCount} disagreement, ${uniqueCount} unique signals from ${consensus_id}. ${skipped} duplicate(s) skipped.`;
        if (dupes.length > 0) receipt += `\nSkipped finding_ids: ${dupes.join(', ')}`;
        return { content: [{ type: 'text' as const, text: receipt }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `bulk_from_consensus failed: ${(err as Error).message}` }] };
      }
    }

    // action === 'record'
    if (!signals || signals.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No signals to record. Provide a signals array.' }] };
    }

    try {
      const { PerformanceWriter } = await import('@gossip/orchestrator');
      const writer = new PerformanceWriter(process.cwd());
      const wallClockMs = Date.now();
      const wallClock = new Date(wallClockMs).toISOString();
      // Sanity window for caller-provided timestamps: 30 days back, 1 hour forward.
      // Anything outside this is rejected to prevent score manipulation via spoofed
      // timestamps (parking the tail far in the future, or burying negatives in the past).
      const MIN_TS_MS = wallClockMs - 30 * 24 * 60 * 60 * 1000;
      const MAX_TS_MS = wallClockMs + 60 * 60 * 1000;
      const validateTimestamp = (ts: string | undefined, label: string): string | null => {
        if (!ts) return null;
        const parsed = new Date(ts).getTime();
        if (!Number.isFinite(parsed)) return `Error: ${label} is not a valid ISO-8601 date: ${ts}`;
        if (parsed < MIN_TS_MS) return `Error: ${label} is more than 30 days in the past (${ts}). Rejecting to prevent score manipulation.`;
        if (parsed > MAX_TS_MS) return `Error: ${label} is more than 1 hour in the future (${ts}). Rejecting to prevent score manipulation.`;
        return null;
      };
      const tstErr = validateTimestamp(task_start_time, 'task_start_time');
      if (tstErr) return { content: [{ type: 'text' as const, text: tstErr }] };
      const batchFallback = task_start_time || wallClock;
      const MAX_EVIDENCE_LENGTH = 2000;
      const PUNITIVE_SIGNALS = new Set(['hallucination_caught', 'disagreement']);
      const COUNTERPART_REQUIRED = new Set(['agreement', 'disagreement', 'impl_peer_approved', 'impl_peer_rejected']);

      // Validate: punitive signals require evidence; per-signal timestamps must be in range
      for (const s of signals) {
        if (PUNITIVE_SIGNALS.has(s.signal) && (!s.evidence || s.evidence.trim().length === 0)) {
          return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require non-empty evidence for audit trail. Agent: ${s.agent_id}` }] };
        }
        if (COUNTERPART_REQUIRED.has(s.signal) && (!s.counterpart_id || s.counterpart_id.trim().length === 0)) {
          return { content: [{ type: 'text' as const, text: `Error: ${s.signal} signals require counterpart_id. Agent: ${s.agent_id}` }] };
        }
        const sigTsErr = validateTimestamp(s.timestamp, `signal[${s.agent_id}].timestamp`);
        if (sigTsErr) return { content: [{ type: 'text' as const, text: sigTsErr }] };
      }

      const IMPL_SIGNALS = new Set(['impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected']);

      // Auto-derive category from finding+evidence text when the caller omitted it.
      // Without this, null-category signals are invisible to getCountersSince() — every
      // bound skill stays pending forever because post-bind counters only match exact
      // category strings. Uses the same DEFAULT_KEYWORDS table the skill-gap tracker
      // uses below, so category assignment is consistent across both pipelines.
      const { DEFAULT_KEYWORDS: DK } = await import('@gossip/orchestrator');
      const inferCategory = (s: { finding?: string; evidence?: string; agent_id?: string }): string | undefined => {
        const text = `${s.finding || ''} ${s.evidence || ''}`.toLowerCase();
        if (!text.trim()) return undefined;
        let bestCategory = '';
        let bestHits = 0;
        for (const [category, keywords] of Object.entries(DK)) {
          const hits = keywords.filter(kw => text.includes(kw)).length;
          if (hits > bestHits) { bestHits = hits; bestCategory = category; }
        }
        return bestHits >= 1 ? bestCategory : undefined;
      };

      type PS = import('@gossip/orchestrator').PerformanceSignal;
      // Per-signal timestamp resolution (highest → lowest precedence):
      //   1. s.timestamp — caller-provided per-finding precision
      //   2. task_start_time — caller-provided per-batch precision
      //   3. wallClock + i ms — fallback, +i offset keeps batch order deterministic
      const resolveTs = (s: { timestamp?: string }, i: number): string => {
        if (s.timestamp) return s.timestamp;
        if (task_start_time) return new Date(new Date(task_start_time).getTime() + i).toISOString();
        return new Date(wallClockMs + i).toISOString();
      };
      const formatted: PS[] = signals.map((s, i): PS => {
        const ts = resolveTs(s, i);
        const taskId = task_id || `manual-${batchFallback.replace(/[:.]/g, '')}-${i}`;
        const evidence = ((s.evidence || s.finding) ?? '').slice(0, MAX_EVIDENCE_LENGTH);
        if (IMPL_SIGNALS.has(s.signal)) {
          return {
            type: 'impl',
            signal: s.signal as 'impl_test_pass' | 'impl_test_fail' | 'impl_peer_approved' | 'impl_peer_rejected',
            agentId: s.agent_id,
            taskId,
            source: 'manual',
            evidence,
            timestamp: ts,
          };
        }
        return {
          type: 'consensus',
          signal: s.signal as Exclude<typeof s.signal, 'impl_test_pass' | 'impl_test_fail' | 'impl_peer_approved' | 'impl_peer_rejected'>,
          agentId: s.agent_id,
          taskId,
          counterpartId: s.counterpart_id,
          findingId: s.finding_id,
          severity: s.severity,
          category: s.category ?? inferCategory(s),
          source: 'manual',
          evidence,
          timestamp: ts,
        };
      });

      // Dedup gate: reject signals whose finding_id already exists in the performance file.
      // Prevents duplicate scoring when a future session re-verifies stale UNVERIFIED findings.
      const existingFindingIds = new Set<string>();
      try {
        const { readFileSync } = await import('fs');
        const perfPath = require('path').join(process.cwd(), '.gossip', 'agent-performance.jsonl');
        const lines = readFileSync(perfPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line);
            if (rec.findingId) existingFindingIds.add(rec.findingId);
          } catch { /* skip malformed lines */ }
        }
      } catch { /* file may not exist yet */ }

      const dupes: string[] = [];
      const deduped = formatted.filter(s => {
        if (s.type === 'consensus' && s.findingId && existingFindingIds.has(s.findingId)) {
          dupes.push(`${s.findingId} (${s.agentId}/${s.signal})`);
          return false;
        }
        return true;
      });

      if (deduped.length > 0) writer.appendSignals(deduped);

      // Auto-convert hallucination signals into skill gap suggestions.
      // Reuses the category derived above (formatted[i].category) so the suggestion
      // pipeline and the signal pipeline always agree on which category fired.
      type ConsensusPS = Extract<PS, { type: 'consensus' }>;
      const hallucinationSignals = deduped.filter(
        (s): s is ConsensusPS => s.type === 'consensus' && s.signal === 'hallucination_caught',
      );
      if (hallucinationSignals.length > 0) {
        try {
          const { SkillGapTracker } = await import('@gossip/orchestrator');
          const gapTracker = new SkillGapTracker(process.cwd());
          for (const s of hallucinationSignals) {
            if (!s.category) continue;
            gapTracker.appendSuggestion({
              type: 'suggestion',
              skill: s.category.replace(/_/g, '-'),
              reason: `Auto: hallucination_caught — ${(s.evidence || '').slice(0, 120)}`,
              agent: s.agentId,
              task_context: s.taskId,
              timestamp: new Date().toISOString(),
            });
          }
        } catch { /* best-effort */ }
      }

      // Detect severity miscalibration: auto-record when orchestrator overrides agent's severity
      for (const s of deduped) {
        if (s.type !== 'consensus') continue;
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
            const resolved = (lines as string[]).map((line: string) => {
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
                const [reportPrefix] = fid.split(':', 2);
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

                // Match signal finding_id against BOTH formats:
                //   (a) the report-global id: `consensusId:fGlobalN` (f.id)
                //   (b) the author-scoped id: `consensusId:agentId:fPerAgentN`
                //       synthesized from f.authorFindingId + reportId
                const matchesFinding = (f: any): boolean => {
                  if (!f) return false;
                  if (f.id && (idsForThisReport.has(f.id) || unscopedIds.has(f.id))) return true;
                  if (f.authorFindingId) {
                    const scoped = `${reportId}:${f.authorFindingId}`;
                    if (idsForThisReport.has(scoped) || unscopedIds.has(scoped)) return true;
                  }
                  return false;
                };

                let changed = false;
                if (report.unverified) {
                  const remaining: any[] = [];
                  for (const f of report.unverified) {
                    if (matchesFinding(f)) {
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

      // Summary by agent — impl_* signals reward/penalize the implementer's track record,
      // and must be classified explicitly. Anything not matched falls into "neg" as a
      // conservative default.
      const POSITIVE_SIGNALS = new Set([
        'agreement',
        'unique_confirmed',
        'new_finding',
        'impl_test_pass',
        'impl_peer_approved',
      ]);
      const byAgent = new Map<string, { pos: number; neg: number }>();
      for (const s of deduped) {
        const entry = byAgent.get(s.agentId) || { pos: 0, neg: 0 };
        if (POSITIVE_SIGNALS.has(s.signal)) entry.pos++;
        else entry.neg++;
        byAgent.set(s.agentId, entry);
      }

      const summary = Array.from(byAgent.entries())
        .map(([id, { pos, neg }]) => `  ${id}: +${pos} / -${neg}`)
        .join('\n');

      const taskIdList = deduped.map(f => `  ${f.agentId}: ${f.taskId}`).join('\n');
      let baseReceipt = `Recorded ${deduped.length} consensus signals:\n${summary}\n\nTask IDs (for retraction):\n${taskIdList}\n\nThese will influence future agent selection via dispatch weighting.`;
      if (dupes.length > 0) {
        baseReceipt += `\n\n⚠️ ${dupes.length} duplicate signal(s) skipped (finding_id already recorded):\n  ${dupes.join('\n  ')}`;
      }

      // Post-write check: nudge orchestrator toward skill development when this batch
      // moved an agent into a weak state. Best-effort, never blocks the receipt.
      try {
        const { PerformanceReader, SkillGapTracker } = await import('@gossip/orchestrator');
        const reader = new PerformanceReader(process.cwd());
        const scores = reader.getScores();
        const batchAgentIds = Array.from(new Set(deduped.map(f => f.agentId)));
        const triggers: string[] = [];

        for (const agentId of batchAgentIds) {
          const score: any = scores.get(agentId);
          if (!score) continue;

          // Match the sparse-data gate used by categoryAccuracy (performance-reader.ts:528):
          // a category needs ≥5 classified signals (correct + hallucinated) before its
          // strength is eligible to trigger a weak flag. Without this gate the trigger
          // fires on agents whose only accumulated strength is one decayed agreement,
          // even when they have 10+ unique_confirmed findings in the category.
          const MIN_CATEGORY_N_FOR_TRIGGER = 5;
          const cats = score.categoryStrengths;
          const correctCounts = (score.categoryCorrect || {}) as Record<string, number>;
          const hallucinatedCounts = (score.categoryHallucinated || {}) as Record<string, number>;
          let weakestCategory: string | null = null;
          let weakestValue = Infinity;
          if (cats && typeof cats === 'object') {
            for (const [k, v] of Object.entries(cats)) {
              const val = v as number;
              const n = (correctCounts[k] ?? 0) + (hallucinatedCounts[k] ?? 0);
              if (n < MIN_CATEGORY_N_FOR_TRIGGER) continue;
              if (val < 0.3 && val < weakestValue) {
                weakestValue = val;
                weakestCategory = k;
              }
            }
          }

          if (weakestCategory) {
            triggers.push(
              `⚠ ${agentId} is now weak in ${weakestCategory} (${weakestValue.toFixed(2)}) — recommended:\n` +
              `  → gossip_skills(action: "develop", agent_id: "${agentId}", category: "${weakestCategory}")`
            );
          } else if ((score.hallucinations || 0) >= 3) {
            triggers.push(
              `⚠ ${agentId} has 3+ hallucinations but no category profile yet:\n` +
              `  → gossip_scores() to view full profile and category breakdown`
            );
          }

          try {
            const w = reader.getDispatchWeight(agentId);
            if (typeof w === 'number' && w < 0.5) {
              triggers.push(
                `⚠ ${agentId} dispatch weight dropped to ${w.toFixed(2)} (circuit_breaker_risk):\n` +
                `  → gossip_scores() to review before next dispatch`
              );
            }
          } catch { /* best-effort */ }
        }

        try {
          const gapTracker = new SkillGapTracker(process.cwd());
          const { pending } = gapTracker.checkThresholds();
          if (pending && pending.length > 0) {
            triggers.push(
              `⚠ Pending skill builds reached threshold (≥3 suggestions, ≥2 agents):\n` +
              `  → gossip_skills(action: "build")  // builds: ${pending.join(', ')}`
            );
          }
        } catch { /* best-effort */ }

        if (triggers.length > 0) {
          baseReceipt += `\n\n─── Skill development triggers ───\n` + triggers.join('\n\n');
        }
      } catch { /* best-effort, non-blocking */ }

      return { content: [{ type: 'text' as const, text: baseReceipt }] };
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
    // NOTE: no z.default() here — combining .default().optional() on a boolean
    // produces a malformed JSON schema emitted to MCP clients, which then
    // mis-serialize sibling complex fields (notably `skills: [...]`) as strings,
    // breaking `gossip_skills(action: "build", skills: [...])`. Apply the default
    // in the handler instead. See project_gossip_skills_build_wrapper_bug.md.
    enabled: z.boolean().optional().describe('For bind: set to false to disable the slot without removing it. Defaults to true.'),
    // develop params
    category: z.string().optional().describe('Category to improve (required for develop). One of: trust_boundaries, injection_vectors, input_validation, concurrency, resource_exhaustion, type_safety, error_handling, data_integrity'),
    // build params
    skill_names: z.array(z.string()).optional().describe('For build: filter to specific skills. Omit to get all pending.'),
    skills: z.array(z.object({
      name: z.string().describe('Skill name (kebab-case)'),
      content: z.string().describe('Full .md content with frontmatter'),
    })).optional().describe('For build: generated skill files to save. Omit for discovery mode.'),
    // Internal: re-entry param for native-utility dispatch path (develop action only)
    _utility_task_id: z.string().optional().describe('Internal: utility task ID for re-entry after native skill generation'),
  },
  async ({ action, agent_id, skill, enabled, category, skill_names, skills, _utility_task_id }) => {
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
      const enabledResolved = enabled ?? true;
      const slot = index.bind(agent_id, skill, { enabled: enabledResolved });

      const bindAction = existing
        ? (existing.enabled !== enabledResolved ? (enabledResolved ? 'enabled' : 'disabled') : 'updated')
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

      if (!ctx.skillEngine) {
        return { content: [{ type: 'text' as const, text: 'Skill engine not available. Check boot logs.' }] };
      }

      // ── Re-entry fast path (native utility returned) ──
      if (_utility_task_id) {
        const stashedMeta = _pendingSkillData.get(_utility_task_id);
        _pendingSkillData.delete(_utility_task_id);
        const utilityResult = ctx.nativeResultMap.get(_utility_task_id);
        ctx.nativeResultMap.delete(_utility_task_id);
        ctx.nativeTaskMap.delete(_utility_task_id);

        if (utilityResult?.status === 'completed' && utilityResult.result && stashedMeta) {
          try {
            const result = ctx.skillEngine.saveFromRaw(agent_id, category, utilityResult.result, stashedMeta);
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
              const agentConfig = registry?.get(agent_id);
              const normalizedCategory = nsn(category);
              if (agentConfig && !agentConfig.skills.includes(normalizedCategory)) {
                agentConfig.skills.push(normalizedCategory);
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

            process.stderr.write(`[gossipcat] Skill developed (native): "${skillName}" for ${agent_id} (category: ${category})\n`);
            return {
              content: [{ type: 'text' as const, text: `Skill generated and saved:\n\nPath: ${result.path}\n\nAuto-bound "${skillName}" to ${agent_id} in skill index.\n\n${preview}` }],
            };
          } catch (err) {
            process.stderr.write(`[gossipcat] Skill develop native post-processing failed: ${(err as Error).message}\n`);
            return {
              content: [{ type: 'text' as const, text: `Skill generation failed: ${(err as Error).message}` }],
            };
          }
        } else {
          process.stderr.write(`[gossipcat] Skill develop utility ${_utility_task_id} failed/missing, falling back to direct LLM\n`);
          // Fall through to direct path below
        }
      }

      // ── Fresh call: native utility branch ──
      if (ctx.nativeUtilityConfig && !_utility_task_id) {
        try {
          const { system, user, skillName, skillPath, baseline_accuracy_correct, baseline_accuracy_hallucinated, bound_at } =
            await ctx.skillEngine.buildPrompt(agent_id, category);
          const taskId = randomUUID().slice(0, 8);
          _pendingSkillData.set(taskId, { agentId: agent_id, category, skillName, skillPath, baseline_accuracy_correct, baseline_accuracy_hallucinated, bound_at });
          ctx.nativeTaskMap.set(taskId, {
            agentId: '_utility',
            task: `skill_develop:${category}`,
            startedAt: Date.now(),
            timeoutMs: 120_000,
            utilityType: 'skill_develop',
          });
          spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);

          const modelShort = ctx.nativeUtilityConfig.model;
          return {
            content: [
              { type: 'text' as const, text:
                `Skill prompt built. Dispatching native utility for generation.\n\n` +
                `⚠️ EXECUTE NOW — launch this Agent and re-call gossip_skills:\n\n` +
                `1. Agent(model: "${modelShort}", prompt: <AGENT_PROMPT:${taskId} below>, run_in_background: true) — pass the AGENT_PROMPT:${taskId} content item verbatim\n` +
                `2. When agent completes → gossip_relay(task_id: "${taskId}", result: "<full agent output>")\n` +
                `3. Then re-call: gossip_skills(action: "develop", agent_id: "${agent_id}", category: "${category}", _utility_task_id: "${taskId}")\n\n` +
                `Do ALL steps in order. Do not wait for user input between them.`
              },
              { type: 'text' as const, text: `AGENT_PROMPT:${taskId} (_utility)\n${system}\n\n---\n\n${user}` },
            ],
          };
        } catch (err) {
          process.stderr.write(`[gossipcat] Skill develop native prompt build failed: ${(err as Error).message}, falling back to direct LLM\n`);
          // Fall through to direct path below
        }
      }

      // ── Direct path (no native utility config, or fallback) ──
      try {
        const result = await ctx.skillEngine.generate(agent_id, category);
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
    force: z.boolean().optional().describe('Bypass the refuse-gate for pending native tasks / consensus rounds. Audited to .gossip/forced-saves.jsonl.'),
    _utility_task_id: z.string().optional().describe('Internal: utility task ID for re-entry after native session summary'),
  },
  async ({ notes, force, _utility_task_id }) => {
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

    // Refuse-gate: block session_save while native tasks or consensus rounds are still in flight.
    // Saving now would freeze a snapshot that omits results still landing, and next-session.md would
    // misrepresent what shipped. `force: true` bypasses and is audited to .gossip/forced-saves.jsonl.
    {
      const pendingNative: string[] = [];
      for (const [taskId, info] of ctx.nativeTaskMap) {
        if (!ctx.nativeResultMap.has(taskId)) pendingNative.push(`${taskId} (${info.agentId})`);
      }
      const pendingConsensus: string[] = [];
      const now = Date.now();
      for (const [cid, round] of ctx.pendingConsensusRounds) {
        // Skip rounds past their deadline — timer was lost or never fired (e.g. restart without
        // re-arm). Without this, a stale round permanently blocks session_save.
        if (round.deadline && now > round.deadline) continue;
        if (round.pendingNativeAgents && round.pendingNativeAgents.size > 0) {
          pendingConsensus.push(`${cid} (${round.pendingNativeAgents.size} agents)`);
        }
      }
      if ((pendingNative.length > 0 || pendingConsensus.length > 0) && !force) {
        const lines: string[] = ['⛔ session_save refused — work still in flight.\n'];
        if (pendingNative.length > 0) {
          lines.push(`Pending native tasks (${pendingNative.length}):`);
          for (const t of pendingNative.slice(0, 10)) lines.push(`  - ${t}`);
          lines.push('');
        }
        if (pendingConsensus.length > 0) {
          lines.push(`Pending consensus rounds (${pendingConsensus.length}):`);
          for (const c of pendingConsensus.slice(0, 10)) lines.push(`  - ${c}`);
          lines.push('');
        }
        lines.push('Relay the results via gossip_relay / gossip_relay_cross_review, then re-call gossip_session_save.');
        lines.push('To override (snapshot is intentional / tasks are abandoned): gossip_session_save(force: true).');
        return { content: [{ type: 'text' as const, text: lines.join('\n') }], isError: true };
      }
      if (force && (pendingNative.length > 0 || pendingConsensus.length > 0)) {
        try {
          const { appendFileSync: af, mkdirSync: md } = require('fs');
          const { join: j } = require('path');
          md(j(process.cwd(), '.gossip'), { recursive: true });
          af(j(process.cwd(), '.gossip', 'forced-saves.jsonl'),
            JSON.stringify({ at: new Date().toISOString(), pendingNative, pendingConsensus, notes: notes || null }) + '\n');
        } catch { /* best-effort audit */ }
      }
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
        content: [
          { type: 'text' as const, text:
            `Session data gathered. Dispatching native utility for summary.\n\n` +
            `⚠️ EXECUTE NOW — launch this Agent and re-call gossip_session_save:\n\n` +
            `1. Agent(model: "${modelShort}", prompt: <AGENT_PROMPT:${taskId} below>, run_in_background: true) — pass the AGENT_PROMPT:${taskId} content item verbatim\n` +
            `2. When agent completes → gossip_relay(task_id: "${taskId}", result: "<full agent output>")\n` +
            `3. Then re-call: gossip_session_save(notes: ${JSON.stringify(notes || '')}, _utility_task_id: "${taskId}")\n\n` +
            `Do ALL steps in order. Do not wait for user input between them.`
          },
          { type: 'text' as const, text: `AGENT_PROMPT:${taskId} (_utility)\n${agentPrompt}` },
        ],
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
  'gossip_verify_memory',
  'On-demand staleness check for a memory file claim. Reads the memory file, dispatches a native haiku-researcher utility to verify the claim against current code, and returns a structured verdict (FRESH | STALE | CONTRADICTED | INCONCLUSIVE) with file:line evidence. Call before acting on any backlog item from memory. Spec: docs/specs/2026-04-08-gossip-verify-memory.md',
  {
    memory_path: z.string().describe('Path to memory file (relative to cwd or absolute). Absolute paths must resolve inside cwd or under ~/.claude/projects/.'),
    claim: z.string().describe('The specific memory assertion to verify against current code.'),
    _utility_task_id: z.string().optional().describe('Internal: utility task ID for re-entry after native haiku dispatch'),
  },
  async ({ memory_path, claim, _utility_task_id }) => {
    await boot();
    const { validateInputs, buildPrompt, parseVerdict } = await import('./handlers/verify-memory.js');
    const checked_at = new Date().toISOString();

    const renderResult = (r: { verdict: string; evidence: string; rewrite_suggestion?: string }) => {
      const payload: Record<string, unknown> = {
        verdict: r.verdict,
        evidence: r.evidence,
        checked_at,
      };
      if (r.rewrite_suggestion) payload.rewrite_suggestion = r.rewrite_suggestion;
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    };

    // Re-entry: relayed haiku result has landed in nativeResultMap.
    if (_utility_task_id) {
      // F5 hardening: only consume nativeResultMap/nativeTaskMap entries that
      // we actually own (i.e., the stash has a verify_memory record). Without
      // this check a crafted _utility_task_id could silently delete a live
      // consensus task result before the consensus collector reads it.
      const stashed = _pendingVerifyData.get(_utility_task_id);
      if (!stashed) {
        return renderResult({
          verdict: 'INCONCLUSIVE',
          evidence: `unknown _utility_task_id: ${_utility_task_id} (not a verify_memory dispatch)`,
        });
      }
      _pendingVerifyData.delete(_utility_task_id);
      const utilityResult = ctx.nativeResultMap.get(_utility_task_id);
      ctx.nativeResultMap.delete(_utility_task_id);
      ctx.nativeTaskMap.delete(_utility_task_id);

      if (!utilityResult || utilityResult.status !== 'completed' || !utilityResult.result) {
        const reason = utilityResult?.error || utilityResult?.status || 'no result';
        return renderResult({
          verdict: 'INCONCLUSIVE',
          evidence: `dispatch failed: ${reason}${stashed ? ` (memory_path: ${stashed.memory_path})` : ''}`,
        });
      }

      const parsed = parseVerdict(utilityResult.result);
      return renderResult(parsed);
    }

    // First call: validate, read, build prompt, return AGENT_PROMPT instructions.
    const validation = validateInputs(memory_path, claim, { cwd: process.cwd() });
    if (!validation.ok) {
      return renderResult({ verdict: 'INCONCLUSIVE', evidence: validation.evidence });
    }

    // No native utility configured: bail out as INCONCLUSIVE so the orchestrator
    // can fall back to manual audit. We do not fabricate verdicts.
    if (!ctx.nativeUtilityConfig) {
      return renderResult({
        verdict: 'INCONCLUSIVE',
        evidence: 'native utility provider not configured; cannot dispatch haiku verifier. Set utility_model in config.json or fall back to manual Read/Grep audit.',
      });
    }

    const prompt = buildPrompt(validation.absPath, validation.body, claim, process.cwd());
    const taskId = randomUUID().slice(0, 8);
    // F1 hardening: issue a one-time relay_token so handleNativeRelay enforces
    // the token check on the verify_memory dispatch. Without this, any caller
    // who guesses the 8-hex taskId in the <120s window can inject a fabricated
    // verdict via gossip_relay before the real haiku output lands.
    const relayToken = randomUUID().slice(0, 12);
    _pendingVerifyData.set(taskId, { memory_path, absPath: validation.absPath, claim });
    const UTILITY_TTL_MS = 120_000;
    ctx.nativeTaskMap.set(taskId, {
      agentId: '_utility',
      task: 'verify_memory',
      startedAt: Date.now(),
      timeoutMs: UTILITY_TTL_MS,
      utilityType: 'verify_memory',
      relayToken,
    });
    spawnTimeoutWatcher(taskId, ctx.nativeTaskMap.get(taskId)!);
    // F3 hardening: spawnTimeoutWatcher only writes a timed_out record into
    // ctx.nativeResultMap; it does not know about _pendingVerifyData. Schedule
    // an independent eviction with a small grace window so the stash never
    // outlives a never-re-entered dispatch.
    const STASH_TTL_MS = UTILITY_TTL_MS + 30_000;
    setTimeout(() => {
      _pendingVerifyData.delete(taskId);
    }, STASH_TTL_MS).unref();

    const modelShort = ctx.nativeUtilityConfig.model;
    return {
      content: [
        { type: 'text' as const, text:
          `Verify-memory dispatch ready. Memory: ${validation.absPath}\n\n` +
          `⚠️ EXECUTE NOW — launch this Agent and re-call gossip_verify_memory:\n\n` +
          `1. Agent(model: "${modelShort}", prompt: <AGENT_PROMPT:${taskId} below>, run_in_background: true) — pass the AGENT_PROMPT:${taskId} content item verbatim\n` +
          `2. When agent completes → gossip_relay(task_id: "${taskId}", relay_token: "${relayToken}", result: "<full agent output>")\n` +
          `3. Then re-call: gossip_verify_memory(memory_path: ${JSON.stringify(memory_path)}, claim: ${JSON.stringify(claim)}, _utility_task_id: "${taskId}")\n\n` +
          `Do ALL steps in order. Do not wait for user input between them.`
        },
        { type: 'text' as const, text: `AGENT_PROMPT:${taskId} (_utility)\n${prompt}` },
      ],
    };
  }
);

server.tool(
  'gossip_format',
  'Return the canonical CONSENSUS_OUTPUT_FORMAT block. Use this when you need to write an ad-hoc Agent() prompt for a native subagent that should produce findings the consensus engine can parse. Paste the returned string into your prompt verbatim — the format trains the agent to emit <agent_finding> tags instead of prose.',
  {},
  async () => {
    const { CONSENSUS_OUTPUT_FORMAT } = await import('@gossip/orchestrator');
    return { content: [{ type: 'text' as const, text: `--- CONSENSUS OUTPUT FORMAT ---\n${CONSENSUS_OUTPUT_FORMAT}\n--- END CONSENSUS OUTPUT FORMAT ---\n\nPaste this entire block into any Agent() prompt that should produce parseable findings. Do not condense or summarize — the verbatim format with examples is what makes the agent comply.` }] };
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
      { name: 'gossip_verify_memory', desc: 'On-demand staleness check for a memory file claim. Returns FRESH | STALE | CONTRADICTED | INCONCLUSIVE with file:line evidence.' },
      { name: 'gossip_tools', desc: 'List available tools (this command).' },
      { name: 'gossip_guide', desc: 'Show the gossipcat handbook for humans — invariants, operator playbook, caveats, hallucination patterns, glossary. Read the docs, not LLM context.' },
      { name: 'gossip_progress', desc: 'Show active task progress and consensus phase. No params.' },
      { name: 'gossip_format', desc: 'Return the CONSENSUS_OUTPUT_FORMAT block to paste into ad-hoc Agent() prompts so native subagents emit parseable <agent_finding> tags.' },
      { name: 'gossip_bug_feedback', desc: 'File a GitHub issue on the gossipcat repo from an in-session bug report. Dedupes against open issues.' },
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
      const stuckThreshold = info.timeoutMs ? Math.min(info.timeoutMs * 0.5, 600_000) : 600_000;
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

    // Recently completed tasks (last 10 minutes) — UNION of native and relay tracks.
    // Native: ctx.nativeResultMap. Relay: pipeline.getRecentlyCompletedTasks().
    // Without the relay branch, completed relay tasks vanish from gossip_progress
    // (they're filtered out of getActiveTasksHealth's running-only list AND not
    // tracked in nativeResultMap). This was the relay-task invisibility bug.
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
    for (const t of ctx.mainAgent.getRecentlyCompletedTasks(600_000)) {
      // Skip if already added via nativeResultMap (shouldn't happen, but defensive)
      if (recentlyCompleted.some(r => r.taskId === t.id)) continue;
      recentlyCompleted.push({
        taskId: t.id,
        agentId: t.agentId,
        durationMs: t.durationMs,
        status: t.status,
        completedAgoMs: t.completedAgoMs,
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

// ── Tool: gossip_bug_feedback — file a GitHub issue from an in-session bug report ───
server.tool(
  'gossip_bug_feedback',
  'File a GitHub issue on the gossipcat repo from an in-session bug report. Dedupes against open issues. Requires authenticated gh CLI.',
  {
    description: z.string().min(1).describe('Bug description — what went wrong, what you expected, what happened instead'),
    task_id: z.string().optional().describe('Optional task ID to attach for context'),
  },
  async ({ description, task_id }) => {
    const { execFile: execFileCb } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFile = promisify(execFileCb);

    // 1. Dedup check — search open issues for the first 50 chars of description.
    // On any failure other than successful "no matches", ABORT rather than silently
    // bypassing dedup: a transient gh auth/network error must not let duplicate
    // issues slip through.
    try {
      const searchResult = await execFile('gh', [
        'issue', 'list',
        '--repo', 'ataberk-xyz/gossipcat',
        '--state', 'open',
        '--search', description.slice(0, 50),
        '--json', 'number,title,url',
        '--limit', '5',
      ]);
      const stdout = searchResult.stdout.trim();
      if (!stdout) {
        return { content: [{ type: 'text' as const, text: 'Dedup check returned empty stdout from gh — aborting to avoid filing a duplicate. Re-run once gh is healthy.' }] };
      }
      const issues: Array<{ number: number; title: string; url: string }> = JSON.parse(stdout);
      if (issues.length > 0) {
        const match = issues[0];
        return { content: [{ type: 'text' as const, text: `Deduped from: ${match.title}\n${match.url}` }] };
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { content: [{ type: 'text' as const, text: 'gh CLI not installed or not authenticated — install gh and run `gh auth login`' }] };
      }
      // Any other failure (auth expired, network error, non-JSON stdout): abort.
      // Do NOT fall through to create — that would bypass the dedup contract.
      return { content: [{ type: 'text' as const, text: `Dedup check failed (${err.message ?? 'unknown error'}). Not filing to avoid duplicates. Run \`gh auth status\` and retry.` }] };
    }

    // 2. Gather context (each wrapped in try/catch, swallow errors)
    // Use the shared helper — reads gossipcat's own package.json, not the
    // calling project's (which is what the old process.cwd() path returned).
    const { getGossipcatVersion } = await import('./version');
    const version = getGossipcatVersion();

    let gitHead = 'unknown';
    try {
      const result = await execFile('git', ['rev-parse', '--short', 'HEAD']);
      gitHead = result.stdout.trim();
    } catch { /* swallow */ }

    // 3. Build issue body
    // NOTE: .gossip/mcp.log content is intentionally NOT embedded — it can contain
    // tool arguments, relay tokens, or worker stdout with sensitive strings, and
    // the issue body is public. If a reporter wants log excerpts, they should
    // quote the specific lines in the description field (which they wrote themselves).
    const body = `## Description
${description}

## Context
- gossipcat version: ${version}
- git HEAD: ${gitHead}
- task_id: ${task_id ?? 'n/a'}

---
Filed via gossip_bug_feedback`;

    // 4. Build title
    const title = '[bug] ' + description.replace(/\s+/g, ' ').slice(0, 70);

    // 5. Create the issue
    try {
      const createResult = await execFile('gh', [
        'issue', 'create',
        '--repo', 'ataberk-xyz/gossipcat',
        '--title', title,
        '--body', body,
      ]);
      const lines = createResult.stdout.split('\n').filter(l => l.trim());
      const url = lines[lines.length - 1] ?? createResult.stdout.trim();
      return { content: [{ type: 'text' as const, text: `Created: ${url}` }] };
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { content: [{ type: 'text' as const, text: 'gh CLI not installed or not authenticated — install gh and run `gh auth login`' }] };
      }
      return { content: [{ type: 'text' as const, text: `Failed to create issue: ${err.message}\n${err.stderr ?? ''}` }] };
    }
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

async function startHttpMcpTransport(): Promise<void> {
  // Port selection: GOSSIPCAT_HTTP_PORT env wins, then .gossip/http-mcp.port
  // sticky file, then OS-assigned (0). Previously this hardcoded 24421 which
  // collided across parallel Claude Code instances on the same machine —
  // matches the fix already applied to the relay port.
  const httpPick = await pickStickyPort('GOSSIPCAT_HTTP_PORT', HTTP_MCP_STICKY_FILE);
  // OS-assigned port when no env var or sticky file — matches relay port behavior.
  // Sticky file makes it stable across reconnects; no need for a hardcoded default.
  const port = httpPick.port;
  ctx.httpMcpPortSource = httpPick.source;
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
      // Each new HTTP session is effectively a reconnect from a fresh client —
      // its tool calls should see the latest next-session.md and any signal
      // state that changed since the last session. The stdio main() path does
      // this at line 3136 but the HTTP path was missing it, leaving reconnected
      // clients on stale bootstrap context until something else refreshed it.
      // See project_bootstrap_stale_on_reconnect.md.
      if (booted) {
        refreshBootstrap().catch(() => {});
      }
      await transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
  });

  httpServer.listen(port, bindHost, () => {
    const addr = httpServer.address();
    const bound = typeof addr === 'object' && addr ? addr.port : port;
    ctx.httpMcpPort = bound;
    if (bound > 0) writeStickyPort(HTTP_MCP_STICKY_FILE, bound);
    const authNote = token ? ' (token protected)' : ' (no auth — set GOSSIPCAT_HTTP_TOKEN to secure)';
    const bindNote = bindHost === '0.0.0.0' ? ' [remote]' : ' [localhost only]';
    process.stderr.write(`[gossipcat] HTTP MCP listening on :${bound}/mcp${authNote}${bindNote}\n`);
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
