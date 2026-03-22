import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs';
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
    let skills = '';
    try {
      const catalogPath = resolve(__dirname, 'default-skills', 'catalog.json');
      if (existsSync(catalogPath)) {
        const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8')) as { skills: Array<{ name: string }> };
        skills = `\nAvailable skills: ${catalog.skills.map(s => s.name).join(', ')}`;
      }
    } catch { /* catalog unavailable */ }

    return `# Gossipcat — Multi-Agent Orchestration

Gossipcat is not configured yet. To set up your multi-agent team:

1. Decide which LLM providers you have API keys for (google, openai, anthropic, local)
2. Call gossip_setup() with your desired team configuration

Example:
\`\`\`
gossip_setup({
  main_agent: { provider: "anthropic", model: "claude-sonnet-4-6" },
  agents: {
    "gemini-reviewer": { provider: "google", model: "gemini-2.5-pro", preset: "reviewer", skills: ["code_review", "security_audit"] },
    "gemini-tester": { provider: "google", model: "gemini-2.5-flash", preset: "tester", skills: ["testing", "debugging"] }
  }
})
\`\`\`

Available presets: reviewer, researcher, implementer, tester, debugger${skills}`;
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

    return `# Gossipcat — Multi-Agent Orchestration

## Your Team

${teamSection}

## Tools

| Tool | Description |
|------|-------------|
| \`gossip_dispatch(agent_id, task)\` | Send task to one agent. Returns task ID. |
| \`gossip_dispatch_parallel(tasks)\` | Fan out to multiple agents simultaneously. |
| \`gossip_collect(task_ids?, timeout_ms?)\` | Collect results. Waits for completion. |
| \`gossip_bootstrap()\` | Refresh this prompt with latest team state. |
| \`gossip_setup(config)\` | Create or update team configuration. |
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
}
