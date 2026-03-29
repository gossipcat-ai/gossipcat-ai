import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';

export interface BootstrapResult {
  prompt: string;
  tier: 'no-config' | 'no-memory' | 'full';
  agentCount: number;
}

interface AgentSummary {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  taskCount: number;
  lastActive?: string;
  topics?: string;
}

const log = (msg: string) => process.stderr.write(`[gossipcat] ${msg}\n`);

export class BootstrapGenerator {
  constructor(private projectRoot: string) {}

  generate(): BootstrapResult {
    this.migrateConfig();

    const config = this.loadConfig();
    if (!config) {
      return { prompt: this.renderTier1(), tier: 'no-config', agentCount: 0 };
    }

    const agents = this.readAgentSummaries(config);
    const hasMemory = agents.some(a => a.taskCount > 0);

    return {
      prompt: this.renderTeamPrompt(agents),
      tier: hasMemory ? 'full' : 'no-memory',
      agentCount: agents.length,
    };
  }

  private migrateConfig(): void {
    const oldPath = resolve(this.projectRoot, 'gossip.agents.json');
    const newPath = resolve(this.projectRoot, '.gossip', 'config.json');

    if (!existsSync(newPath) && existsSync(oldPath)) {
      mkdirSync(resolve(this.projectRoot, '.gossip'), { recursive: true });
      copyFileSync(oldPath, newPath);
      log('Migrated config to .gossip/config.json — gossip.agents.json is now ignored.');
    }
  }

  private loadConfig(): Record<string, unknown> | null {
    const paths = [
      resolve(this.projectRoot, '.gossip', 'config.json'),
      resolve(this.projectRoot, 'gossip.agents.json'),
    ];

    for (const p of paths) {
      if (existsSync(p)) {
        try { return JSON.parse(readFileSync(p, 'utf-8')); }
        catch { log('Config parse error, falling back to setup mode'); return null; }
      }
    }
    return null;
  }

  private readAgentSummaries(config: Record<string, unknown>): AgentSummary[] {
    const agents: AgentSummary[] = [];
    const agentsConfig = (config.agents ?? {}) as Record<string, Record<string, unknown>>;

    for (const [id, ac] of Object.entries(agentsConfig)) {
      const summary: AgentSummary = {
        id,
        provider: ac.provider as string,
        model: ac.model as string,
        preset: ac.preset as string | undefined,
        skills: (ac.skills as string[]) || [],
        taskCount: 0,
      };

      // Read task history
      const tasksPath = join(this.projectRoot, '.gossip', 'agents', id, 'memory', 'tasks.jsonl');
      if (existsSync(tasksPath)) {
        const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
        let count = 0;
        let lastTs = '';
        for (const line of lines) {
          try {
            const e = JSON.parse(line) as { timestamp?: string };
            count++;
            if (e.timestamp && e.timestamp > lastTs) lastTs = e.timestamp;
          } catch { /* skip malformed */ }
        }
        summary.taskCount = count;
        if (lastTs) summary.lastActive = lastTs.split('T')[0];
      }

      // Read memory summary (capped at 500 chars)
      const memPath = join(this.projectRoot, '.gossip', 'agents', id, 'memory', 'MEMORY.md');
      if (existsSync(memPath)) {
        const content = readFileSync(memPath, 'utf-8').slice(0, 500);
        // Extract topic keywords from knowledge section link lines
        const knowledgeLines = content.match(/- \[([^\]]+)\]/g);
        if (knowledgeLines?.length) {
          summary.topics = knowledgeLines
            .map(l => l.replace(/- \[([^\]]+)\].*/, '$1'))
            .join(', ');
        }
      }

      agents.push(summary);
    }
    return agents;
  }

  private renderTier1(): string {
    // Detect host environment for setup guidance
    const isClaude = process.env.CLAUDECODE === '1' || !!process.env.CLAUDE_CODE_ENTRYPOINT;
    const isCursor = !!process.env.CURSOR_TRACE_ID || !!process.env.CURSOR_SESSION_ID;
    const host = isClaude ? 'Claude Code' : isCursor ? 'Cursor' : 'your IDE';

    return `# Gossipcat — Multi-Agent Orchestration

Gossipcat is not configured yet. Set up a multi-agent team for this project.

**Host:** ${host}${isClaude ? ' (native agents supported)' : ''}

## Quick Setup

Call \`gossip_setup\` with your team. Each agent can be:
- **type: "native"** — Creates a ${isClaude ? 'Claude Code subagent (.claude/agents/*.md) ' : ''}that also connects to the gossipcat relay. Supports consensus cross-review.${isClaude ? ' Works both as a native Agent() and via gossip_dispatch().' : ''}
- **type: "custom"** — Any provider (anthropic, openai, google, local). Only accessible via gossip_dispatch().

### Example: Mixed team (native + custom)
\`\`\`
gossip_setup({
  main_provider: "google",
  main_model: "gemini-2.5-flash",
  agents: [
    { id: "claude-reviewer", type: "native", model: "sonnet", preset: "reviewer", skills: ["code_review", "security"], description: "Code reviewer" },
    { id: "gemini-impl", type: "custom", provider: "google", custom_model: "gemini-2.5-pro", preset: "implementer", skills: ["typescript", "react"] }
  ]
})
\`\`\`

### Example: All native (Anthropic API only)
\`\`\`
gossip_setup({
  main_provider: "anthropic",
  main_model: "claude-sonnet-4-6",
  agents: [
    { id: "reviewer", type: "native", model: "sonnet", preset: "reviewer", skills: ["code_review"] },
    { id: "researcher", type: "native", model: "haiku", preset: "researcher", skills: ["research"] }
  ]
})
\`\`\`

### Example: All custom (multi-provider)
\`\`\`
gossip_setup({
  main_provider: "google",
  main_model: "gemini-2.5-pro",
  agents: [
    { id: "gemini-reviewer", type: "custom", provider: "google", custom_model: "gemini-2.5-pro", preset: "reviewer", skills: ["code_review"] },
    { id: "gpt-researcher", type: "custom", provider: "openai", custom_model: "gpt-4o", preset: "researcher", skills: ["research"] }
  ]
})
\`\`\`

Available presets: reviewer, researcher, implementer, tester
Available native models: opus, sonnet, haiku

## Permissions for Native Agents

Native agents run via Claude Code's Agent tool and may prompt for file write permissions.
To auto-allow writes, add to \`.claude/settings.local.json\`:
\`\`\`json
{ "permissions": { "allow": ["Edit", "Write", "Bash(npm *)"] } }
\`\`\``;
  }

  private renderTeamPrompt(agents: AgentSummary[]): string {
    const teamSection = agents.map(a => {
      let line = `- **${a.id}**: ${a.provider}/${a.model}${a.preset ? ` (${a.preset})` : ''}\n  Skills: ${a.skills.join(', ')}`;
      if (a.taskCount > 0) {
        line += `\n  Recent: ${a.taskCount} tasks${a.lastActive ? `, last active ${a.lastActive}` : ''}`;
        if (a.topics) line += `\n  Topics: ${a.topics}`;
      } else {
        line += '\n  No task history yet';
      }
      return line;
    }).join('\n\n');

    const sessionContext = this.readProjectMemory();
    const nextSessionNotes = this.readNextSessionNotes();
    const sessionParts = [sessionContext, nextSessionNotes].filter(Boolean);
    const sessionSection = sessionParts.length > 0 ? `\n## Session Context\n\n${sessionParts.join('\n\n---\n\n')}\n` : '';

    return `# Gossipcat — Multi-Agent Orchestration

## Your Team

${teamSection}
${sessionSection}
## Tools

| Tool | Description |
|------|-------------|
| \`gossip_dispatch(agent_id, task)\` | Send task to one agent. Returns task ID. |
| \`gossip_dispatch_parallel(tasks)\` | Fan out to multiple agents simultaneously. |
| \`gossip_collect(task_ids?, timeout_ms?)\` | Collect results. Waits for completion. |
| \`gossip_dispatch_consensus(tasks)\` | Dispatch with consensus summary instruction. Returns task IDs. |
| \`gossip_collect_consensus(task_ids, timeout_ms?)\` | Collect + cross-review. Returns tagged consensus report. |
| \`gossip_run(agent_id, task)\` | Single-agent dispatch. Relay: returns result. Native: returns Agent() instructions + callback. |
| \`gossip_run_complete(task_id, result)\` | Complete a native agent gossip_run — relays result, writes memory, emits signals. |
| \`gossip_relay_result(task_id, result)\` | Feed native Agent() result back into relay for consensus. |
| \`gossip_bootstrap()\` | Refresh this prompt with latest team state. |
| \`gossip_setup(main_provider, main_model, agents)\` | Create team with native + custom agents. |
| \`gossip_orchestrate(task)\` | Auto-decompose task via MainAgent. |
| \`gossip_agents()\` | List current agents. |
| \`gossip_status()\` | Check system status. |
| \`gossip_update_instructions(agent_ids, instruction_update, mode)\` | Update agent instructions at runtime. |
| \`gossip_tools()\` | List all available tools. |
| \`gossip_plan(task)\` | Plan task with write-mode suggestions. Returns dispatch-ready JSON. |

## Dispatch Rules

### Use parallel multi-agent dispatch for:
| Task Type | Why | Split Strategy |
|-----------|-----|----------------|
| Security review | Different agents catch different vulnerability classes | Split by package |
| Code review | Cross-validation finds bugs single reviewers miss | Split by concern (logic, style, perf) |
| Bug investigation | Competing hypotheses tested in parallel | One agent per hypothesis |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension |

### Single agent is fine for:
- Quick lookups, simple implementations, running tests, file reads

### Pattern:
\`\`\`
gossip_dispatch_parallel(tasks: [
  { agent_id: "<reviewer>", task: "Review X for <concern>" },
  { agent_id: "<tester>", task: "Review Y for <concern>" }
])
\`\`\`
Then collect and synthesize results.

## Consensus Mode

When multiple agents review the same work, use **consensus review** for structured cross-review:

\`\`\`
gossip_dispatch_consensus(tasks: [
  { agent_id: "gemini-reviewer", task: "Security review X" },
  { agent_id: "gemini-tester", task: "Security review X" },
])
// then:
gossip_collect_consensus(task_ids, 300000)
\`\`\`

**What happens:** Dispatches all agents, waits for results, then runs a cross-review round where each agent reviews peer findings. Results are tagged:
- **CONFIRMED** — multiple agents agree (high confidence, act on these)
- **DISPUTED** — agents disagree (review the evidence)
- **UNIQUE** — only one agent found this (verify before acting)
- **NEW** — discovered during cross-review (highest-value findings)

**When to use consensus:**
- Pre-ship security reviews
- Architecture decisions
- Bug diagnosis with competing hypotheses
- Spec reviews

**Cost:** ~12% overhead (cross-review uses summaries, not full codebase).

## Write Modes

Agents can modify files when dispatched with a write mode:
- \`sequential\` — one write task at a time (safe default for implementation)
- \`scoped\` — parallel writes locked to non-overlapping directories
- \`worktree\` — fully isolated git branch per task

**Workflow for implementation tasks:**
1. Call \`gossip_plan(task)\` to get a decomposed plan with write-mode suggestions
2. Review the plan — adjust write modes or agents if needed
3. Call \`gossip_dispatch_parallel\` with the plan's task array to execute

For read-only tasks (reviews, analysis), use \`gossip_dispatch\` or \`gossip_orchestrate\` directly — no write mode needed.

## Memory

Agent memory is auto-managed:
- **MCP dispatch/collect**: Memory loaded at dispatch, written at collect. No manual action.
- **CLI chat (handleMessage)**: Same pipeline — memory loaded and written automatically.
- **Native Claude Agent tool**: Bypasses gossipcat pipeline. Manually read .gossip/agents/<id>/memory/MEMORY.md and include in prompt. Write task entry to tasks.jsonl after completion.

Skills are auto-injected from agent config. Project-wide skills in .gossip/skills/.`;
  }

  /**
   * Read _project session memory using warmth-only selection (no relevance filtering).
   * Returns the body content of the top knowledge files, capped at 2500 chars.
   */
  private readProjectMemory(): string | null {
    const knowledgeDir = join(this.projectRoot, '.gossip', 'agents', '_project', 'memory', 'knowledge');
    if (!existsSync(knowledgeDir)) return null;

    const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) return null;

    // Score by warmth (importance × recency decay). Pinned files get warmth = Infinity.
    const scored = files.map(f => {
      try {
        const content = readFileSync(join(knowledgeDir, f), 'utf-8');
        const importance = parseFloat(content.match(/importance:\s*([\d.]+)/)?.[1] ?? '0.5');
        const isPinned = /pinned:\s*true/i.test(content);
        // Extract timestamp from filename: 2026-03-29T22-32-45
        const tsPart = f.slice(0, 19);
        const isoApprox = tsPart.replace(/T(\d\d)-(\d\d)-(\d\d)/, 'T$1:$2:$3');
        const days = Math.max(0, (Date.now() - new Date(isoApprox).getTime()) / 86400000);
        const warmth = isPinned ? Infinity : importance * (1 / (1 + days / 30));

        // Extract body (everything after second ---)
        const bodyStart = content.indexOf('---', 4);
        const body = bodyStart !== -1 ? content.slice(bodyStart + 3).trim() : '';
        return { warmth, body };
      } catch { return null; }
    }).filter((s): s is { warmth: number; body: string } => s !== null && s.body.length > 0);

    if (scored.length === 0) return null;

    scored.sort((a, b) => b.warmth - a.warmth);
    const top = scored.slice(0, 3);
    const combined = top.map(s => s.body).join('\n\n---\n\n');
    return combined.slice(0, 2500) || null;
  }

  /**
   * Verify tool-related claims in session notes against MCP server source.
   * Annotates TODO/remaining lines where the referenced tool actually exists.
   */
  private verifyToolClaims(content: string): string {
    const mcpPath = join(this.projectRoot, 'apps', 'cli', 'src', 'mcp-server-sdk.ts');
    if (!existsSync(mcpPath)) return content;

    const rawSource = readFileSync(mcpPath, 'utf-8');
    // Strip comments once — avoids false positives from gossip_tools() listing
    const source = rawSource.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '');

    const keywordRe = /TODO|remaining|deferred|needed|pending/i;
    const toolRe = /gossip_\w+/;

    return content.split('\n').map(line => {
      if (!keywordRe.test(line)) return line;
      const toolMatch = line.match(toolRe);
      if (!toolMatch) return line;
      const toolName = toolMatch[0];
      const pattern = new RegExp(`server\\.tool\\(\\s*['"]${toolName}['"]`);
      if (pattern.test(source)) {
        return `~~${line.trim()}~~ *(verified: ${toolName} exists in MCP server)*`;
      }
      return line;
    }).join('\n');
  }

  /** Read .gossip/next-session.md if it exists — user/orchestrator notes for the next session */
  private readNextSessionNotes(): string | null {
    const notesPath = join(this.projectRoot, '.gossip', 'next-session.md');
    if (!existsSync(notesPath)) return null;
    try {
      const content = readFileSync(notesPath, 'utf-8').trim();
      if (content.length === 0) return null;
      return this.verifyToolClaims(content.slice(0, 2000));
    } catch { return null; }
  }
}
