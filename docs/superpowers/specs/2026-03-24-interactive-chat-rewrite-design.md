# Interactive Chat Rewrite — Design Spec

> Ground-up rewrite of the gossipcat interactive chat CLI. The current `chat.ts` has accumulated too many patches and the architecture is fundamentally broken.
>
> **v2** — Updated after multi-agent consensus review (4 Gemini agents + Claude subagent, 30 gaps identified and resolved).

## Why Rewrite

The current chat.ts (530+ lines) has these structural problems:

1. **@clack/prompts corrupts readline** — any interactive select/confirm breaks stdin, making subsequent input impossible
2. **Custom inlineSelect has rendering bugs** — infinite re-render loops, cursor position corruption. The `inlineSelect` function is referenced but not even defined in the file.
3. **No state machine** — the REPL mixes free-text, choices, init flow, and commands in one flat handler with scattered flags (`pendingChoices`, `_pendingChoices`, `activeWriteMode`)
4. **renderResponse is recursive** — choice -> handleChoice -> renderResponse -> choice creates deep call stacks and hard-to-trace bugs
5. **No spinner during async operations** — user sees a blank cursor with no feedback
6. **Config is static** — `configToAgentConfigs(config)` caches the initial config, doesn't reflect runtime changes (agents added after init)
7. **Duplicate state variables** — both `pendingChoices` and `_pendingChoices` exist at module level
8. **Async readline handler has no .catch** — `rl.on('line', async ...)` with no error boundary = unhandled rejection crash in Node 18+

## What Works (Keep)

The backend orchestrator layer is solid:
- `MainAgent.handleMessage()` with cognitive/decompose modes
- `MainAgent.handleChoice()` for choice follow-ups
- `ToolRouter` + `ToolExecutor` with 11 tool handlers
- `ProjectInitializer` with archetype catalog and hybrid scoring
- `TeamManager` for team evolution
- Consensus protocol end-to-end
- 558+ tests passing

Only `apps/cli/src/chat.ts` needs rewriting. The orchestrator API stays the same.

## Design Principles

1. **Readline only** — no @clack/prompts, no inquirer, no raw stdin mode. Just `readline.createInterface` for all input.
2. **Numbered choices** — when the system presents options, show numbered list. User types a number. Simple, reliable, no terminal corruption.
3. **State machine** — explicit states: `idle`, `choice`, `processing`. Each state defines what input means.
4. **No recursive renderResponse** — flat output. If a response has choices, set state to `choice` and return. The next line input resolves the choice.
5. **Dynamic config** — always read agent count from `mainAgent` registry, not the static config object.
6. **Clear feedback** — every async operation shows a spinner. Every error shows a message. No blank cursors.
7. **Dependency injection** — ChatSession receives all deps through constructor for testability.
8. **Safe async boundaries** — every async handler is wrapped with `.catch` at the call site.

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                    chat.ts (entry)                     │
│  Boot relay, toolServer, mainAgent                    │
│  Create ChatSession with shutdown callback            │
│  Wire rl.on('line') with .catch()                     │
│  Wire rl.on('close'), process.on('SIGINT')            │
└────────────────────┬──────────────────────────────────┘
                     │
┌────────────────────▼──────────────────────────────────┐
│                  ChatSession                          │
│                                                       │
│  state: 'idle' | 'choice' | 'processing'             │
│  writeMode: { mode, scope } | null                    │
│  pendingChoices: { options, message, allowCustom,     │
│                    type, originalMessage } | null      │
│  lastTaskIds: string[]                                │
│                                                       │
│  onInput(line) ──→ route by state:                    │
│    idle       → handleCommand() or handleFreeText()   │
│    choice     → handleChoiceInput()                   │
│    processing → renderer.info('Still working...')     │
│                                                       │
│  display(response, originalMessage) ──→ flat render   │
│    render agents, text, choices — NEVER recurse       │
│                                                       │
│  Commands: map of name → handler function             │
│    All 14 current commands preserved                  │
└────────────────────┬──────────────────────────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
   ChatRenderer   Spinner    MainAgent
   (output)     (feedback)  (orchestrator)
```

### State Machine

```
         ┌─────────┐
    ┌───→│  idle    │←──────────────┐
    │    └────┬─────┘               │
    │         │ user types          │
    │         │ (or /command)       │
    │         ▼                     │
    │    ┌──────────┐               │
    │    │processing │──→ display() │
    │    └──────────┘      │        │
    │                      │        │
    │              has choices?      │
    │              ├── no ──────────┘
    │              ▼
    │    ┌──────────┐
    │    │  choice   │
    │    └────┬─────┘
    │         │ user types number/name/freetext
    │         ▼
    │    ┌──────────┐
    └────│processing │──→ display()
         └──────────┘

Note: writeMode is an orthogonal flag on ChatSession, not a state.
When writeMode is active, handleFreeText routes to dispatch+collect
instead of handleMessage. The state machine transitions are the same.
```

### File Structure

| File | Responsibility | ~Lines |
|------|----------------|--------|
| `apps/cli/src/chat.ts` | **Rewrite.** Thin entry point: boot infrastructure, create ChatSession, wire events, handle shutdown | ~80 |
| `apps/cli/src/chat-session.ts` | **New.** ChatSession class — state machine, input routing, command registry, display | ~250 |
| `apps/cli/src/chat-renderer.ts` | **New.** Format ChatResponse for terminal — text, choices, agents, spinners, errors | ~80 |
| `apps/cli/src/spinner.ts` | **New.** Simple inline spinner with readline coordination (pause/resume) | ~40 |

## Detailed Design

### MainAgent API Additions

The `MainAgent.registry` is private. We need two convenience methods:

```typescript
// Add to MainAgent class:
getAgentCount(): number {
  return this.registry.getAll().length;
}

hasAgents(): boolean {
  return this.registry.getAll().length > 0;
}

getAgentList(): AgentConfig[] {
  return this.registry.getAll();
}
```

These are trivial, non-breaking additions.

### Spinner

The spinner must coordinate with readline to avoid stdout interleaving.

```typescript
import { Interface as ReadlineInterface } from 'readline';

export class Spinner {
  private interval: NodeJS.Timeout | null = null;
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private idx = 0;
  private rl: ReadlineInterface | null = null;

  /** Bind to readline for pause/resume coordination */
  setReadline(rl: ReadlineInterface): void {
    this.rl = rl;
  }

  start(message: string): void {
    this.stop(); // clear any existing spinner
    this.idx = 0;
    // Pause readline so its prompt doesn't interleave with spinner output
    this.rl?.pause();
    // Only animate if stdout is a TTY
    if (process.stdout.isTTY) {
      this.interval = setInterval(() => {
        process.stdout.write(`\r  ${this.frames[this.idx++ % this.frames.length]} ${message}`);
      }, 80);
    } else {
      // Non-TTY: single line, no animation
      console.log(`  ... ${message}`);
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      if (process.stdout.isTTY) {
        process.stdout.write('\r\x1b[K'); // clear line
      }
    }
    // Resume readline so prompt reappears
    this.rl?.resume();
  }
}
```

### ChatRenderer

Handles all terminal output formatting. Single source of truth for writing to stdout.

```typescript
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
};

export class ChatRenderer {
  /** Show agent attribution when multiple agents contributed */
  agents(agentIds: string[]): void {
    if (agentIds.length > 1) {
      console.log(`${c.dim}  Agents: ${agentIds.join(', ')}${c.reset}`);
    }
  }

  /** Render main text content */
  text(content: string): void {
    console.log('');
    console.log(content);
    console.log('');
  }

  /** Render the choice prompt message (e.g. "Start building?") */
  choiceMessage(message: string): void {
    console.log(`\n${c.bold}${message}${c.reset}`);
  }

  /**
   * Render numbered choice list.
   * For 'confirm' type: show as yes/no style.
   * For 'select' (default): show numbered list.
   * For 'multiselect': show numbered list with multi-pick hint.
   * If allowCustom: show freetext hint after options.
   */
  choices(
    options: Array<{ value: string; label: string; hint?: string }>,
    opts?: { type?: 'select' | 'confirm' | 'multiselect'; allowCustom?: boolean },
  ): void {
    console.log('');
    for (let i = 0; i < options.length; i++) {
      const hint = options[i].hint ? ` ${c.dim}(${options[i].hint})${c.reset}` : '';
      console.log(`  ${c.cyan}${i + 1}.${c.reset} ${options[i].label}${hint}`);
    }
    if (opts?.type === 'multiselect') {
      console.log(`${c.dim}  (enter multiple numbers separated by commas, e.g. 1,3)${c.reset}`);
    }
    if (opts?.allowCustom) {
      console.log(`${c.dim}  (or type a custom response)${c.reset}`);
    }
    console.log('');
  }

  error(err: unknown): void {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.log(`\n${c.yellow}  Error: ${msg}${c.reset}\n`);
  }

  warn(msg: string): void {
    console.log(`  ${c.yellow}${msg}${c.reset}`);
  }

  info(msg: string): void {
    console.log(`  ${c.dim}${msg}${c.reset}`);
  }

  /** Render a formatted section (for /agents, /status, etc.) */
  section(title: string, lines: string[]): void {
    console.log(`\n${c.bold}${title}${c.reset}`);
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    console.log('');
  }
}
```

### ChatSession Class

```typescript
import { Interface as ReadlineInterface, createInterface } from 'readline';
import { MainAgent, ChatResponse, ChatChoice } from '@gossip/orchestrator';
import { ContentBlock } from '@gossip/types';
import { GossipConfig, configToAgentConfigs } from './config';
import { ChatRenderer } from './chat-renderer';
import { Spinner } from './spinner';

interface ChatSessionConfig {
  mainAgent: MainAgent;
  config: GossipConfig;
  onShutdown: () => Promise<void>;  // chat.ts provides this to clean up relay/toolServer
}

type ChatState = 'idle' | 'choice' | 'processing';

interface PendingChoice {
  options: ChatChoice[];
  message: string;
  allowCustom: boolean;
  type: 'select' | 'confirm' | 'multiselect';
  originalMessage: string | ContentBlock[];
}

export class ChatSession {
  private state: ChatState = 'idle';
  private pending: PendingChoice | null = null;
  private writeMode: { mode: 'sequential' | 'scoped' | 'worktree'; scope?: string } | null = null;
  private lastTaskIds: string[] = [];
  private mainAgent: MainAgent;
  private config: GossipConfig;
  private rl!: ReadlineInterface;
  private renderer: ChatRenderer;
  private spinner: Spinner;
  private onShutdown: () => Promise<void>;
  private isShuttingDown = false;

  constructor(opts: ChatSessionConfig) {
    this.mainAgent = opts.mainAgent;
    this.config = opts.config;
    this.onShutdown = opts.onShutdown;
    this.renderer = new ChatRenderer();
    this.spinner = new Spinner();
  }

  start(): void {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${'\x1b[36m'}>${'\x1b[0m'} `,
      historySize: 100,  // preserve current behavior (readline default is 30)
      terminal: true,
    });

    this.spinner.setReadline(this.rl);

    // CRITICAL: wrap async handler with .catch to prevent unhandled rejection crash
    this.rl.on('line', (line) => {
      this.onInput(line).catch((err) => {
        this.spinner.stop();
        this.renderer.error(err);
        this.state = 'idle';
        this.prompt();
      });
    });

    this.rl.on('close', () => {
      this.shutdown().catch(() => process.exit(0));
    });

    this.prompt();
  }

  /** Called on every line of input */
  async onInput(line: string): Promise<void> {
    const input = line.trim();
    if (!input) { this.prompt(); return; }
    if (input === 'exit' || input === 'quit') { await this.shutdown(); return; }

    switch (this.state) {
      case 'idle':
        if (input.startsWith('/')) {
          await this.handleCommand(input);
        } else {
          await this.handleFreeText(input);
        }
        break;

      case 'choice':
        await this.handleChoiceInput(input);
        break;

      case 'processing':
        this.renderer.info('Still working...');
        break;
    }
  }

  // ── Free-text input ───────────────────────────────────────────────────

  private async handleFreeText(input: string | ContentBlock[]): Promise<void> {
    this.state = 'processing';

    // Write mode: route to dispatch+collect instead of handleMessage
    if (this.writeMode) {
      await this.handleWriteModeInput(typeof input === 'string' ? input : '');
      return;
    }

    const spinnerText = this.mainAgent.hasAgents() ? 'thinking...' : 'analyzing project...';
    this.spinner.start(spinnerText);

    try {
      const response = await this.mainAgent.handleMessage(input);
      this.spinner.stop();
      this.display(response, input);
    } catch (err) {
      this.spinner.stop();
      this.renderer.error(err);
      this.state = 'idle';
      this.prompt();
    }
  }

  private async handleWriteModeInput(input: string): Promise<void> {
    const agents = this.mainAgent.getAgentList();
    if (agents.length === 0) {
      this.renderer.warn('No agents configured.');
      this.state = 'idle';
      this.prompt();
      return;
    }

    this.spinner.start(`dispatching [${this.writeMode!.mode}]...`);
    const options = { writeMode: this.writeMode!.mode, scope: this.writeMode!.scope };
    const { taskId } = this.mainAgent.dispatch(agents[0].id, input, options);
    try {
      const { results } = await this.mainAgent.collect([taskId]);
      this.spinner.stop();
      const r = results[0];
      if (r?.status === 'completed') {
        this.renderer.text(r.result);
      } else {
        this.renderer.error(new Error(r?.error || 'Unknown'));
      }
    } catch (err) {
      this.spinner.stop();
      this.renderer.error(err);
    }
    this.state = 'idle';
    this.prompt();
  }

  // ── Choice input ──────────────────────────────────────────────────────

  private async handleChoiceInput(input: string): Promise<void> {
    if (!this.pending) { this.state = 'idle'; this.prompt(); return; }

    const { options, allowCustom, type, originalMessage } = this.pending;

    // Handle multiselect: parse comma-separated numbers
    if (type === 'multiselect') {
      const nums = input.split(',').map(s => parseInt(s.trim(), 10));
      const valid = nums.every(n => n >= 1 && n <= options.length);
      if (!valid || nums.length === 0) {
        this.renderer.warn(`Pick numbers 1-${options.length} separated by commas`);
        this.prompt();
        return;
      }
      // For multiselect, join values with comma for handleChoice
      const selectedValues = nums.map(n => options[n - 1].value).join(',');
      await this.processChoice(selectedValues, originalMessage);
      return;
    }

    // Single select / confirm: match by number
    const num = parseInt(input, 10);
    let selectedValue: string | undefined;

    if (num >= 1 && num <= options.length) {
      selectedValue = options[num - 1].value;
    } else {
      // Match by name (case-insensitive)
      const match = options.find(o =>
        o.value.toLowerCase() === input.toLowerCase() ||
        o.label.toLowerCase() === input.toLowerCase()
      );
      selectedValue = match?.value;
    }

    // If no match and allowCustom is true, treat as freetext to handleMessage
    if (!selectedValue && allowCustom) {
      this.pending = null;
      await this.handleFreeText(input);
      return;
    }

    if (!selectedValue) {
      if (type === 'confirm') {
        this.renderer.warn('Enter a number, or type the option name');
      } else {
        this.renderer.warn(`Pick 1-${options.length}`);
      }
      this.prompt();
      return;
    }

    await this.processChoice(selectedValue, originalMessage);
  }

  private async processChoice(
    selectedValue: string,
    originalMessage: string | ContentBlock[],
  ): Promise<void> {
    this.state = 'processing';
    this.pending = null;
    this.spinner.start('processing...');

    try {
      const textMsg = typeof originalMessage === 'string'
        ? originalMessage
        : originalMessage.filter(b => b.type === 'text').map(b => (b as any).text).join(' ') || '';
      const response = await this.mainAgent.handleChoice(textMsg, selectedValue);
      this.spinner.stop();
      this.display(response, originalMessage);
    } catch (err) {
      this.spinner.stop();
      this.renderer.error(err);
      this.state = 'idle';
      this.prompt();
    }
  }

  // ── Display (NEVER recursive) ─────────────────────────────────────────

  /**
   * Render a ChatResponse. This is FLAT — it renders once and returns.
   * If choices are present, it sets state to 'choice' and waits for input.
   */
  private display(response: ChatResponse, originalMessage: string | ContentBlock[]): void {
    // Agent attribution
    if (response.agents && response.agents.length > 1 && !response.choices) {
      this.renderer.agents(response.agents);
    }

    // Main text
    if (response.text) {
      this.renderer.text(response.text);
    }

    // Choices — set state, DON'T recurse
    if (response.choices && response.choices.options.length > 0) {
      const { message, options, allowCustom, type } = response.choices;

      // Show the choice prompt message (e.g. "Start building?")
      if (message) {
        this.renderer.choiceMessage(message);
      }

      this.renderer.choices(options, { type: type || 'select', allowCustom });
      this.pending = {
        options,
        message: message || '',
        allowCustom: allowCustom ?? false,
        type: type || 'select',
        originalMessage,
      };
      this.state = 'choice';
    } else {
      this.state = 'idle';
    }

    this.prompt();
  }

  // ── Command handling ──────────────────────────────────────────────────

  private async handleCommand(input: string): Promise<void> {
    const spaceIdx = input.indexOf(' ');
    const cmd = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).slice(1); // strip /
    const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);

    const handler = this.commands[cmd];
    if (handler) {
      this.state = 'processing';
      this.spinner.start(`${cmd}...`);
      try {
        await handler(args);
        this.spinner.stop();
      } catch (err) {
        this.spinner.stop();
        this.renderer.error(err);
      }
    } else {
      this.renderer.warn(`Unknown command: /${cmd}. Try /help`);
    }

    this.state = 'idle';
    this.prompt();
  }

  /**
   * Command registry. Each command is a function that takes args string.
   * Commands have access to this.mainAgent, this.renderer, this.config, etc.
   * through closure over the ChatSession instance.
   *
   * No circular deps: commands are plain functions defined on the class,
   * not separate classes that need a back-reference to ChatSession.
   */
  private commands: Record<string, (args: string) => Promise<void>> = {
    help: async () => {
      // Same content as current /help, using this.renderer.section()
      this.renderer.section('Dispatch & Collect', [
        '/dispatch <agent_id> <task>         Send task to one agent',
        '/dispatch-parallel <json>           Fan out to multiple agents',
        '/collect [task_ids] [timeout_ms]    Collect results (default: last dispatch)',
      ]);
      this.renderer.section('Consensus (cross-review)', [
        '/dispatch-consensus <task>          Dispatch to all agents with consensus',
        '/collect-consensus [task_ids] [ms]  Collect + cross-review',
      ]);
      this.renderer.section('Planning & Write Modes', [
        '/plan <task>                        Plan task with write-mode suggestions',
        '/write <mode> [scope]               Set write mode (sequential/scoped/worktree)',
        '/write off                          Disable write mode',
      ]);
      this.renderer.section('Info', [
        '/agents                             List configured agents',
        '/status                             System status',
        '/bootstrap                          Regenerate team context prompt',
        '/init <description>                 Initialize project with tailored agent team',
        '/tools                              List all tools',
        '/image [message]                    Send clipboard image to orchestrator',
      ]);
      this.renderer.info('Or just type naturally. "exit" to quit.');
    },

    agents: async () => {
      const agents = this.mainAgent.getAgentList();
      const lines = agents.map(a =>
        `${a.id}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`
      );
      this.renderer.section(`Agents (${agents.length})`, lines);
    },

    status: async () => {
      const agents = this.mainAgent.getAgentList();
      this.renderer.section('Status', [
        `Agents: ${agents.length} configured`,
        `Pending tasks: ${this.lastTaskIds.length}`,
        `Write mode: ${this.writeMode ? `${this.writeMode.mode}${this.writeMode.scope ? ` (${this.writeMode.scope})` : ''}` : 'off'}`,
      ]);
    },

    bootstrap: async () => {
      const { BootstrapGenerator } = await import('@gossip/orchestrator');
      const gen = new BootstrapGenerator(process.cwd());
      const result = gen.generate();
      const { writeFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
      writeFileSync(join(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
      this.renderer.info(`Bootstrap refreshed (${result.agentCount} agents, tier: ${result.tier})`);
    },

    tools: async () => {
      const list = [
        'dispatch           — Send task to one agent',
        'dispatch-parallel  — Fan out to multiple agents',
        'collect            — Collect results',
        'dispatch-consensus — Dispatch with consensus instruction',
        'collect-consensus  — Collect + cross-review',
        'plan               — Plan task with write-mode suggestions',
        'orchestrate        — Auto-decompose task via MainAgent',
        'agents             — List agents',
        'status             — System status',
        'bootstrap          — Regenerate team prompt',
      ];
      this.renderer.section(`Tools (${list.length})`, list.map(t => `/${t}`));
    },

    dispatch: async (args: string) => {
      const spaceIdx = args.indexOf(' ');
      if (spaceIdx === -1) {
        this.renderer.warn('Usage: /dispatch <agent_id> <task>');
        return;
      }
      const agentId = args.slice(0, spaceIdx).trim();
      const task = args.slice(spaceIdx + 1).trim();
      const { taskId } = this.mainAgent.dispatch(agentId, task);
      this.lastTaskIds = [taskId];
      this.renderer.info(`Dispatched to ${agentId}. Task ID: ${taskId}`);
    },

    'dispatch-parallel': async (args: string) => {
      let taskDefs: Array<{ agent_id: string; task: string }>;
      try {
        taskDefs = JSON.parse(args);
      } catch {
        this.renderer.warn('Usage: /dispatch-parallel [{"agent_id":"...","task":"..."},...]');
        return;
      }
      const { taskIds, errors } = await this.mainAgent.dispatchParallel(
        taskDefs.map(d => ({ agentId: d.agent_id, task: d.task })),
      );
      this.lastTaskIds = taskIds;
      const lines = taskIds.map(tid => {
        const t = this.mainAgent.getTask(tid);
        return `${tid} -> ${t?.agentId || 'unknown'}`;
      });
      if (errors.length) lines.push(`Errors: ${errors.join(', ')}`);
      this.renderer.section(`Dispatched ${taskIds.length} tasks`, lines);
    },

    collect: async (args: string) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const ids = parts[0] ? parts[0].split(',') : (this.lastTaskIds.length > 0 ? this.lastTaskIds : undefined);
      const timeout = parts[1] ? parseInt(parts[1], 10) : 120_000;

      const { results } = await this.mainAgent.collect(ids, timeout);
      for (const r of results) {
        const dur = r.completedAt ? `${r.completedAt - r.startedAt}ms` : '?';
        if (r.status === 'completed') {
          this.renderer.section(`${r.agentId} (${dur})`, [r.result]);
        } else {
          this.renderer.warn(`${r.agentId}: ${r.status === 'failed' ? r.error : 'still running'}`);
        }
      }
      this.lastTaskIds = [];
    },

    'dispatch-consensus': async (args: string) => {
      const task = args.trim();
      if (!task) {
        this.renderer.warn('Usage: /dispatch-consensus <task>');
        return;
      }
      const agents = this.mainAgent.getAgentList();
      if (agents.length < 2) {
        this.renderer.warn(`Need >= 2 agents for consensus. Currently: ${agents.length}`);
        return;
      }
      const taskDefs = agents.map(a => ({ agentId: a.id, task }));
      const { taskIds, errors } = await this.mainAgent.dispatchParallel(taskDefs, { consensus: true });
      this.lastTaskIds = taskIds;
      const lines = taskIds.map(tid => {
        const t = this.mainAgent.getTask(tid);
        return `${tid} -> ${t?.agentId || 'unknown'}`;
      });
      if (errors.length) lines.push(`Errors: ${errors.join(', ')}`);
      lines.push('Call /collect-consensus when ready.');
      this.renderer.section(`Dispatched ${taskIds.length} tasks with consensus`, lines);
    },

    'collect-consensus': async (args: string) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const ids = parts[0] ? parts[0].split(',') : (this.lastTaskIds.length > 0 ? this.lastTaskIds : undefined);
      const timeout = parts[1] ? parseInt(parts[1], 10) : 300_000;

      if (!ids || ids.length === 0) {
        this.renderer.warn('No task IDs. Run /dispatch-consensus first.');
        return;
      }

      const { results, consensus: report } = await this.mainAgent.collect(ids, timeout, { consensus: true });
      for (const r of results) {
        const dur = r.completedAt ? `${r.completedAt - r.startedAt}ms` : '?';
        if (r.status === 'completed') {
          this.renderer.section(`${r.agentId} (${dur})`, [r.result]);
        } else {
          this.renderer.warn(`${r.agentId}: ${r.status === 'failed' ? r.error : 'still running'}`);
        }
      }
      if (report) {
        this.renderer.text(report.summary);
      } else {
        this.renderer.warn('Consensus cross-review did not run (need >= 2 successful agents).');
      }
      this.lastTaskIds = [];
    },

    plan: async (args: string) => {
      const task = args.trim();
      if (!task) {
        this.renderer.warn('Usage: /plan <task>');
        return;
      }
      const response = await this.mainAgent.handleMessage(`Plan this task: ${task}`);
      // Plan responses can have choices too — use display() for proper handling
      this.spinner.stop();
      this.display(response, task);
      return; // display() sets state and calls prompt()
    },

    write: async (args: string) => {
      const parts = args.trim().split(/\s+/);
      if (parts[0] === 'off') {
        this.writeMode = null;
        this.renderer.info('Write mode disabled.');
        return;
      }
      const validModes = ['sequential', 'scoped', 'worktree'] as const;
      const mode = parts[0] as typeof validModes[number];
      if (!mode || !validModes.includes(mode)) {
        this.renderer.warn('Usage: /write <mode> [scope] | /write off');
        this.renderer.info('Modes: sequential, scoped, worktree');
        return;
      }
      const scope = parts[1] || undefined;
      if (mode === 'scoped' && !scope) {
        this.renderer.warn('Scoped mode requires a directory path.');
        return;
      }
      this.writeMode = { mode, scope };
      this.renderer.info(`Write mode: ${mode}${scope ? ` (scope: ${scope})` : ''}`);
    },

    init: async (args: string) => {
      const description = args.trim();
      if (!description) {
        this.renderer.warn('Usage: /init <project description>');
        this.renderer.info('Example: /init building a snake game in TypeScript');
        return;
      }
      const response = await this.mainAgent.handleMessage(description);
      this.spinner.stop();
      this.display(response, description);
      return; // display() handles choices if present
    },

    image: async (args: string) => {
      const { readClipboardImage } = await import('./clipboard');
      const { processImage } = await import('./image-handler');

      const image = await readClipboardImage();
      if (!image) {
        this.renderer.warn('No image found in clipboard.');
        return;
      }

      const processed = processImage(image);
      const dimStr = processed.dimensions ? ` ${processed.dimensions.width}x${processed.dimensions.height}` : '';
      this.renderer.info(`Image: ${processed.format.toUpperCase()}${dimStr} (${Math.round(processed.sizeBytes / 1024)} KB)`);

      const text = args.trim() || 'Describe this image.';
      const content: ContentBlock[] = [
        { type: 'image', data: processed.base64, mediaType: processed.mediaType },
        { type: 'text', text },
      ];

      const response = await this.mainAgent.handleMessage(content);
      this.spinner.stop();
      // Pass ContentBlock[] as originalMessage so choices preserve image context
      this.display(response, content);
      return;
    },
  };

  // ── Prompt ────────────────────────────────────────────────────────────

  private prompt(): void {
    if (this.state === 'choice') {
      this.rl.setPrompt('  choice> ');
    } else if (this.writeMode) {
      this.rl.setPrompt(`[${this.writeMode.mode}]> `);
    } else {
      this.rl.setPrompt('\x1b[36m>\x1b[0m ');
    }
    this.rl.prompt();
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    this.spinner.stop();
    this.renderer.info('Shutting down...');
    this.rl.close();
    // Force exit after 3s if graceful shutdown hangs
    const forceExit = setTimeout(() => process.exit(0), 3000);
    try {
      await this.onShutdown();  // chat.ts cleans up relay, toolServer, mainAgent
    } catch { /* ignore shutdown errors */ }
    clearTimeout(forceExit);
    process.exit(0);
  }
}
```

### Boot Flow (chat.ts entry point)

```typescript
import { createInterface } from 'readline';
import { MainAgent, MainAgentConfig, BootstrapGenerator } from '@gossip/orchestrator';
import { RelayServer } from '@gossip/relay';
import { ToolServer } from '@gossip/tools';
import { GossipConfig, configToAgentConfigs } from './config';
import { Keychain } from './keychain';
import { ChatSession } from './chat-session';
import { Spinner } from './spinner';

export async function startChat(config: GossipConfig): Promise<void> {
  const spinner = new Spinner();
  spinner.start('Starting Gossip Mesh...');

  // Boot relay, tool server, main agent (same as today)
  const relay = new RelayServer({ port: 0 });
  await relay.start();

  const toolServer = new ToolServer({
    relayUrl: relay.url,
    projectRoot: process.cwd(),
  });
  await toolServer.start();

  const keychain = new Keychain();
  const mainKey = await keychain.getKey(config.main_agent.provider);

  // Generate bootstrap prompt
  const bootstrapGen = new BootstrapGenerator(process.cwd());
  const { prompt: bootstrapPrompt } = bootstrapGen.generate();
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
  writeFileSync(join(process.cwd(), '.gossip', 'bootstrap.md'), bootstrapPrompt);

  const mainAgentConfig: MainAgentConfig = {
    provider: config.main_agent.provider,
    model: config.main_agent.model,
    apiKey: mainKey || undefined,
    relayUrl: relay.url,
    agents: configToAgentConfigs(config),
    projectRoot: process.cwd(),
    bootstrapPrompt,
    keyProvider: async (provider: string) => keychain.getKey(provider),
    toolServer: {
      assignScope: (agentId: string, scope: string) => toolServer.assignScope(agentId, scope),
      assignRoot: (agentId: string, root: string) => toolServer.assignRoot(agentId, root),
      releaseAgent: (agentId: string) => toolServer.releaseAgent(agentId),
    },
  };

  const mainAgent = new MainAgent(mainAgentConfig);
  await mainAgent.start();

  spinner.stop();

  // Show welcome
  const orchestratorLabel = `${config.main_agent.provider}/${config.main_agent.model}`;
  const agentCount = mainAgent.getAgentCount();
  if (agentCount === 0) {
    console.log(`Ready — orchestrator online (${orchestratorLabel}), no agents yet`);
    console.log("  Describe your project and I'll set up a tailored agent team.");
    console.log('  Or use /init <description> to initialize explicitly.');
    console.log('  /help for all commands.\n');
  } else {
    console.log(`Ready — ${agentCount} agent${agentCount !== 1 ? 's' : ''} online (${orchestratorLabel}, relay :${relay.port})\n`);
  }

  // Create and start chat session
  const session = new ChatSession({
    mainAgent,
    config,
    onShutdown: async () => {
      await mainAgent.stop();
      await toolServer.stop();
      await relay.stop();
    },
  });
  session.start();

  // SIGINT handler — delegates to ChatSession.shutdown()
  process.on('SIGINT', () => {
    session.shutdown().catch(() => process.exit(0));
  });

  // Safety net for unhandled rejections
  process.on('unhandledRejection', (err) => {
    console.error('\n  Unhandled error:', err instanceof Error ? err.message : err);
    session.shutdown().catch(() => process.exit(1));
  });
}
```

## Key Differences from Current

| Current | Rewrite |
|---------|---------|
| @clack/prompts for choices | Numbered list + readline |
| Recursive renderResponse | Flat display() — never recurses |
| Scattered state flags | Explicit state machine (idle/choice/processing) + writeMode flag |
| Raw stdin mode for selector | No raw mode ever — all through readline |
| Static config for agent count | Dynamic via `mainAgent.getAgentCount()` / `getAgentList()` |
| 530+ lines in one file | 4 focused files (session ~250, renderer ~80, spinner ~40, entry ~80) |
| Static `process.stdout.write` spinner | Dedicated Spinner class with readline pause/resume + TTY check |
| handleChoice called from renderResponse | handleChoice called from onInput when state=choice |
| No error boundary on rl.on('line') | `.catch()` wraps every async handler |
| No SIGINT handler isolation | `ChatSession.shutdown()` with `isShuttingDown` guard |
| `choices.message` ignored | Rendered via `renderer.choiceMessage()` |
| `allowCustom` ignored | Falls through to `handleFreeText()` on unrecognized input |
| Only select type | select, confirm, multiselect all handled |
| `/image` choices lose image context | `pendingOriginalMessage` stores `ContentBlock[]` |
| `historySize` implicit | Explicit `historySize: 100` |
| Spinner corrupts readline prompt | `rl.pause()` / `rl.resume()` around spinner |

## What About Arrow-Key Selection?

Deferred. The numbered approach works reliably. Arrow-key selection requires raw stdin which breaks readline. If we want it later, it should be implemented as a separate terminal UI mode (not mixed with readline).

## Required MainAgent Changes

Add these convenience methods (non-breaking):

```typescript
// In MainAgent class:
getAgentCount(): number { return this.registry.getAll().length; }
hasAgents(): boolean { return this.registry.getAll().length > 0; }
getAgentList(): AgentConfig[] { return this.registry.getAll(); }
```

## Testing

### Test Files

| File | What it tests |
|------|---------------|
| `tests/cli/chat-session.test.ts` | Unit test ChatSession with mock MainAgent |
| `tests/cli/chat-renderer.test.ts` | Verify output formatting |
| `tests/cli/spinner.test.ts` | Spinner start/stop, TTY check, readline coordination |
| `tests/cli/chat-e2e.test.ts` | Full session: boot -> init -> accept -> task |

### ChatSession Test Strategy

ChatSession uses DI — mock `MainAgent` and capture stdout.

```typescript
// Mock MainAgent
const mockAgent = {
  handleMessage: jest.fn(),
  handleChoice: jest.fn(),
  hasAgents: jest.fn(() => true),
  getAgentCount: jest.fn(() => 2),
  getAgentList: jest.fn(() => []),
  dispatch: jest.fn(),
  collect: jest.fn(),
  dispatchParallel: jest.fn(),
  getTask: jest.fn(),
  stop: jest.fn(),
};

// Create session with mock
const session = new ChatSession({
  mainAgent: mockAgent as any,
  config: testConfig,
  onShutdown: jest.fn(),
});
```

### Key Test Cases

**State machine transitions:**
1. idle + text -> processing -> response without choices -> idle
2. idle + text -> processing -> response with choices -> choice
3. choice + valid number -> processing -> idle
4. choice + invalid number -> warn, stay in choice
5. choice + name match (case-insensitive) -> processing
6. choice + freetext when allowCustom -> handleFreeText
7. choice + freetext when !allowCustom -> warn
8. processing + any input -> "Still working..." info
9. idle + /command -> processing -> idle
10. idle + exit -> shutdown

**Error handling:**
11. handleMessage throws -> error rendered, back to idle
12. handleChoice throws -> error rendered, back to idle
13. Empty input -> prompt again (no state change)

**Choice types:**
14. select: numbered list, pick by number
15. confirm: two options, pick by number or name
16. multiselect: comma-separated numbers (e.g. "1,3")

**Write mode:**
17. /write sequential -> writeMode set, prompt changes
18. Free text in writeMode -> dispatch+collect flow
19. /write off -> writeMode cleared

**Spinner:**
20. Spinner start calls rl.pause()
21. Spinner stop calls rl.resume()
22. Non-TTY: spinner prints single line, no animation

## Migration

1. Add `getAgentCount()`, `hasAgents()`, `getAgentList()` to `MainAgent`
2. Create new files: `chat-session.ts`, `chat-renderer.ts`, `spinner.ts`
3. Rename current `chat.ts` to `chat-legacy.ts`
4. Create new `chat.ts` as thin boot entry point
5. Wire `index.ts` to import from new `chat.ts` (same export signature)
6. Run tests, verify all 14 commands work
7. Delete `chat-legacy.ts` once stable

### Migration Safety

- The new `startChat()` has the same signature as the old one
- No changes to `MainAgent` internals — only 3 new public methods
- `index.ts` import path doesn't change
- Old file preserved as `chat-legacy.ts` until verified
