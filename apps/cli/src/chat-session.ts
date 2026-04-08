import { createInterface, Interface as ReadlineInterface } from 'readline';
import { MainAgent, ChatResponse, ChatChoice, TaskProgressEvent } from '@gossip/orchestrator';
import { ContentBlock } from '@gossip/types';
import { GossipConfig } from './config';
import { ChatRenderer } from './chat-renderer';
import { Spinner } from './spinner';
import { inlineSelect } from './inline-selector';
import { ProgressTree } from './progress-tree';

// ── Types ───────────────────────────────────────────────────────────────

export interface ChatSessionConfig {
  mainAgent: MainAgent;
  config: GossipConfig;
  /** chat.ts provides this to clean up relay, toolServer, mainAgent */
  onShutdown: () => Promise<void>;
}

type ChatState = 'idle' | 'choice' | 'processing';

interface PendingChoice {
  options: ChatChoice[];
  message: string;
  allowCustom: boolean;
  type: 'select' | 'confirm' | 'multiselect';
  originalMessage: string | ContentBlock[];
}

// ── ChatSession ─────────────────────────────────────────────────────────

export class ChatSession {
  private state: ChatState = 'idle';
  private pending: PendingChoice | null = null;
  private writeMode: { mode: 'sequential' | 'scoped' | 'worktree'; scope?: string } | null = null;
  private lastTaskIds: string[] = [];
  private mainAgent: MainAgent;
  private rl!: ReadlineInterface;
  private renderer: ChatRenderer;
  private spinner: Spinner;
  private onShutdown: () => Promise<void>;
  private isShuttingDown = false;
  private currentAbort: AbortController | null = null;
  private progressTree!: ProgressTree;

  constructor(opts: ChatSessionConfig) {
    this.mainAgent = opts.mainAgent;
    this.onShutdown = opts.onShutdown;
    this.renderer = new ChatRenderer();
    this.spinner = new Spinner();

    // Render plan execution progress via ProgressTree pipeline bars
    this.mainAgent.onTaskProgress((event: TaskProgressEvent) => {
      if (event.status === 'init' && event.agents) {
        this.spinner.stop();
        this.progressTree.start(event.agents);
        return;
      }
      if (!this.progressTree.isActive()) return;
      if (event.status === 'start' || event.status === 'progress') {
        this.progressTree.update(event.agentId, event);
        return;
      }
      if (event.status === 'done' || event.status === 'error') {
        this.progressTree.update(event.agentId, event);
        return;
      }
      if (event.status === 'finish') {
        this.progressTree.finish();
      }
    });
  }

  /** Show interactive command picker filtered by current input */
  private async showCommandPicker(filter?: string): Promise<void> {
    const prefix = filter?.slice(1).toLowerCase() || '';
    const allEntries = Object.entries(this.commandDescriptions);
    const filtered = prefix
      ? allEntries.filter(([name]) => name.toLowerCase().startsWith(prefix))
      : allEntries;

    if (filtered.length === 0) return;

    // If exact match, don't show picker — just let readline handle it
    if (filtered.length === 1 && filtered[0][0].toLowerCase() === prefix) return;

    const options = filtered.map(([name, desc]) => ({
      value: name,
      label: `/${name}`,
      hint: desc,
    }));

    // Clear current line before showing picker
    this.rl.write(null as any, { ctrl: true, name: 'u' }); // clear line

    const selected = await inlineSelect({
      message: 'Commands',
      options,
      rl: this.rl,
    });

    if (selected && this.commands[selected]) {
      this.state = 'processing';
      try {
        const handled = (await this.commands[selected]('')) || false;
        if (!handled) { this.state = 'idle'; this.prompt(); }
      } catch (err) {
        this.renderer.error(err);
        this.state = 'idle';
        this.prompt();
      }
    } else {
      this.prompt();
    }
  }

  start(): void {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '\x1b[36m>\x1b[0m ',
      historySize: 100,
      terminal: true,
      // Return empty so readline doesn't do its own ugly completion
      completer: () => [[], ''] as [string[], string],
    });

    this.spinner.setReadline(this.rl);
    this.progressTree = new ProgressTree(this.rl);

    // Tab key: show interactive command picker when line starts with /
    process.stdin.on('keypress', (_str: string, key: { name?: string }) => {
      if (key?.name === 'tab' && this.state === 'idle') {
        const line = this.rl.line;
        if (line?.startsWith('/')) {
          setImmediate(() => this.showCommandPicker(line));
        }
      }
    });

    this.rl.on('line', (line) => {
      this.onInput(line).catch((err) => {
        this.spinner.stop();
        if (err?.name !== 'AbortError') {
          this.renderer.error(err);
        }
        this.state = 'idle';
        this.prompt();
      });
    });

    this.rl.on('close', () => {
      this.shutdown().catch(() => process.exit(1));
    });

    // Ctrl+C: cancel current operation or exit if idle.
    // Use process.on('SIGINT') as the primary handler — rl.on('SIGINT') only
    // fires when readline is active, but ProgressTree pauses readline during
    // plan execution, making Ctrl+C unresponsive.
    let lastSigintTime = 0;
    const handleSigint = () => {
      if (this.progressTree?.isActive()) this.progressTree.finish();
      if (this.state === 'processing' && this.currentAbort) {
        // Cancel current operation + clean up zombie tasks
        this.currentAbort.abort();
        this.currentAbort = null;
        this.spinner.stop();
        const cancelled = this.mainAgent.cancelRunningTasks();
        this.renderer.info(`Cancelled.${cancelled > 0 ? ` (${cancelled} running task${cancelled > 1 ? 's' : ''} stopped)` : ''}`);
        this.state = 'idle';
        this.prompt();
      } else if (this.state === 'choice') {
        // Cancel choice selection, return to idle
        this.pending = null;
        this.spinner.stop();
        this.renderer.info('Cancelled.');
        this.state = 'idle';
        this.prompt();
      } else {
        // Idle — double Ctrl+C to exit (like Claude Code)
        const now = Date.now();
        if (now - lastSigintTime < 1500) {
          this.shutdown().catch(() => process.exit(0));
        } else {
          lastSigintTime = now;
          this.renderer.info('Press Ctrl+C again to exit, or type "exit".');
          this.prompt();
        }
      }
    };
    this.rl.on('SIGINT', handleSigint);
    process.on('SIGINT', handleSigint);

    this.prompt();
  }

  /** Create an AbortController for the current operation */
  private startAbortable(): AbortController {
    this.currentAbort = new AbortController();
    return this.currentAbort;
  }

  /** Clear the current abort controller */
  private clearAbort(): void {
    this.currentAbort = null;
  }

  // ── Input routing ───────────────────────────────────────────────────

  async onInput(line: string): Promise<void> {
    const input = line.trim();
    if (!input) { this.prompt(); return; }
    if (input === 'exit' || input === 'quit') {
      await this.shutdown();
      return;
    }

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

  // ── Free-text input ─────────────────────────────────────────────────

  private async handleFreeText(input: string | ContentBlock[]): Promise<void> {
    this.state = 'processing';

    if (this.writeMode) {
      await this.handleWriteModeInput(typeof input === 'string' ? input : '');
      return;
    }

    const spinnerText = this.mainAgent.hasAgents() ? 'thinking...' : 'analyzing project...';
    this.spinner.start(spinnerText);
    const abort = this.startAbortable();

    try {
      const response = await this.mainAgent.handleMessage(input);
      if (abort.signal.aborted) return;  // cancelled by Ctrl+C
      this.spinner.stop();
      this.clearAbort();
      await this.display(response, input);
    } catch (err) {
      this.spinner.stop();
      this.clearAbort();
      if ((err as any)?.name === 'AbortError' || abort.signal.aborted) return;
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
    try {
      const { taskId } = this.mainAgent.dispatch(agents[0].id, input, options);
      const { results } = await this.mainAgent.collect([taskId]);
      const r = results[0];
      if (r?.status === 'completed') {
        this.renderer.text(r.result ?? '');
      } else {
        this.renderer.error(new Error(r?.error ?? 'Unknown write mode error'));
      }
    } catch (err) {
      this.renderer.error(err);
    } finally {
      this.spinner.stop();
    }
    this.state = 'idle';
    this.prompt();
  }

  // ── Choice input ────────────────────────────────────────────────────

  private async handleChoiceInput(input: string): Promise<void> {
    if (!this.pending) { this.state = 'idle'; this.prompt(); return; }

    const { options, allowCustom, type, originalMessage } = this.pending;

    if (type === 'multiselect') {
      const nums = input.split(',').map(s => parseInt(s.trim(), 10));
      const valid = nums.length > 0 && nums.every(n => !isNaN(n) && n >= 1 && n <= options.length);
      if (!valid) {
        this.renderer.warn(`Pick numbers 1-${options.length} separated by commas`);
        this.prompt();
        return;
      }
      const selectedValues = nums.map(n => options[n - 1].value).join(',');
      await this.processChoice(selectedValues, originalMessage);
      return;
    }

    const num = parseInt(input, 10);
    let selectedValue: string | undefined;

    if (!isNaN(num) && num >= 1 && num <= options.length) {
      selectedValue = options[num - 1].value;
    } else {
      const match = options.find(o =>
        o.value.toLowerCase() === input.toLowerCase() ||
        o.label.toLowerCase() === input.toLowerCase()
      );
      selectedValue = match?.value;
    }

    if (!selectedValue && allowCustom) {
      this.pending = null;
      await this.handleFreeText(input);
      return;
    }

    if (!selectedValue) {
      this.renderer.warn(type === 'confirm' ? 'Enter a number or type the option name' : `Pick 1-${options.length}`);
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
    const abort = this.startAbortable();

    try {
      const textMsg = typeof originalMessage === 'string'
        ? originalMessage
        : originalMessage.filter(b => b.type === 'text').map(b => (b as any).text).join(' ') || '';
      const response = await this.mainAgent.handleChoice(textMsg, selectedValue);
      if (abort.signal.aborted) return;
      this.spinner.stop();
      this.clearAbort();
      await this.display(response, originalMessage);
    } catch (err) {
      this.spinner.stop();
      this.clearAbort();
      if ((err as any)?.name === 'AbortError' || abort.signal.aborted) return;
      this.renderer.error(err);
      this.state = 'idle';
      this.prompt();
    }
  }

  // ── Display (NEVER recursive) ───────────────────────────────────────

  /**
   * Render a ChatResponse. FLAT — renders once and returns.
   * For select/confirm choices: launches inline arrow-key selector.
   * For multiselect: falls back to numbered list with text input.
   */
  private async display(response: ChatResponse, originalMessage: string | ContentBlock[]): Promise<void> {
    if (response.agents && response.agents.length > 1 && !response.choices) {
      this.renderer.agents(response.agents);
    }

    if (response.text) {
      this.renderer.text(response.text);
    }

    if (response.choices && response.choices.options.length > 0) {
      const { message, options, allowCustom, type } = response.choices;
      const choiceType = type || 'select';

      // Multiselect: fall back to numbered list + text input
      if (choiceType === 'multiselect') {
        if (message) this.renderer.choiceMessage(message);
        this.renderer.choices(options, { type: choiceType, allowCustom });
        this.pending = {
          options,
          message: message || '',
          allowCustom: allowCustom ?? false,
          type: choiceType,
          originalMessage,
        };
        this.state = 'choice';
        this.prompt();
        return;
      }

      // Select / Confirm: use arrow-key inline selector
      const selected = await inlineSelect({
        message: message || 'Choose an option:',
        options,
        allowCustom,
        rl: this.rl,
      });

      if (selected === null) {
        // Cancelled (Ctrl+C)
        this.state = 'idle';
        this.prompt();
        return;
      }

      if (selected === '__custom__') {
        // User wants to type a custom response — switch to idle for freetext
        this.state = 'idle';
        this.renderer.info('Type your response:');
        this.prompt();
        return;
      }

      // Process the selected choice
      await this.processChoice(selected, originalMessage);
      return;
    }

    this.state = 'idle';
    this.prompt();
  }

  // ── Command handling ────────────────────────────────────────────────

  /** Command descriptions for the picker */
  private commandDescriptions: Record<string, string> = {
    help: 'Show all commands',
    agents: 'List configured agents',
    status: 'System status',
    model: 'Switch orchestrator model',
    bootstrap: 'Regenerate team context',
    tools: 'List available tools',
    dispatch: 'Send task to one agent',
    'dispatch-parallel': 'Fan out to multiple agents',
    collect: 'Collect agent results',
    'dispatch-consensus': 'Dispatch with cross-review',
    'collect-consensus': 'Collect with consensus',
    plan: 'Plan a task',
    write: 'Set write mode',
    init: 'Initialize project team',
    health: 'Check if agents are running or stuck',
    image: 'Send clipboard image',
  };

  private async handleCommand(input: string): Promise<void> {
    const spaceIdx = input.indexOf(' ');
    const cmd = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).slice(1);
    const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);

    // "/" alone → interactive command picker
    if (!cmd) {
      await this.showCommandPicker();
      return;
    }

    const handler = this.commands[cmd];
    let stateHandled = false;

    if (handler) {
      this.state = 'processing';
      try {
        stateHandled = (await handler(args)) || false;
      } catch (err) {
        this.renderer.error(err);
      }
    } else {
      this.renderer.warn(`Unknown command: /${cmd}. Type / to see all commands.`);
    }

    if (!stateHandled) {
      this.state = 'idle';
      this.prompt();
    }
  }

  // ── Command registry ────────────────────────────────────────────────

  private commands: Record<string, (args: string) => Promise<boolean | void>> = {
    help: async () => {
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
      this.renderer.section('Info & Config', [
        '/agents                             List configured agents',
        '/status                             System status',
        '/model [provider/model]             Show or switch orchestrator model',
        '/bootstrap                          Regenerate team context prompt',
        '/init <description>                 Initialize project with tailored agent team',
        '/tools                              List all tools',
        '/image [message]                    Send clipboard image to orchestrator',
      ]);
      this.renderer.info('Tab to autocomplete commands. "exit" to quit.');
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

    model: async (args: string) => {
      const current = this.mainAgent.getModel();

      // Direct switch: /model google/gemini-2.5-pro
      if (args.trim()) {
        const parts = args.trim().split('/');
        if (parts.length === 2) {
          try {
            await this.mainAgent.setModel(parts[0], parts[1]);
            this.renderer.info(`Switched to ${parts[0]}/${parts[1]}`);
          } catch (err) {
            this.renderer.error(err);
          }
          return;
        }
      }

      // Interactive selector
      const models = [
        { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', hint: 'google — best' },
        { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', hint: 'google — fast/cheap' },
        { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', hint: 'anthropic — best' },
        { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'anthropic — fast' },
        { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'anthropic — cheapest' },
        { value: 'openai/gpt-4o', label: 'GPT-4o', hint: 'openai — best' },
        { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini', hint: 'openai — cheapest' },
      ];

      // Mark current model
      const currentKey = `${current.provider}/${current.model}`;
      const options = models.map(m => ({
        ...m,
        label: m.value === currentKey ? `${m.label} (current)` : m.label,
      }));

      const selected = await inlineSelect({
        message: `Orchestrator model (${currentKey})`,
        options,
        rl: this.rl,
      });

      if (selected && selected !== currentKey) {
        const [provider, model] = selected.split('/');
        try {
          await this.mainAgent.setModel(provider, model);
          this.renderer.info(`Switched to ${provider}/${model}`);
        } catch (err) {
          this.renderer.error(err);
        }
      } else if (selected === currentKey) {
        this.renderer.info('Already using this model.');
      }

      this.state = 'idle';
      this.prompt();
      return true;
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
        'dispatch', 'dispatch-parallel', 'collect',
        'dispatch-consensus', 'collect-consensus',
        'plan', 'orchestrate', 'agents', 'status', 'bootstrap',
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
        return `${tid} → ${(t as any)?.agentId || 'unknown'}`;
      });
      if (errors.length) lines.push(`Errors: ${errors.join(', ')}`);
      this.renderer.section(`Dispatched ${taskIds.length} tasks`, lines);
    },

    collect: async (args: string) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const ids = parts[0] ? parts[0].split(',') : (this.lastTaskIds.length > 0 ? this.lastTaskIds : undefined);
      const timeout = parts[1] ? parseInt(parts[1], 10) : 600_000;

      this.spinner.start(`collecting${ids ? ` ${ids.length} tasks` : ' all'}...`);
      try {
        const { results } = await this.mainAgent.collect(ids, timeout);
        for (const r of results) {
          const dur = r.completedAt ? `${r.completedAt - r.startedAt}ms` : '?';
          if (r.status === 'completed') {
            this.renderer.section(`${r.agentId} (${dur})`, [r.result ?? '']);
          } else {
            this.renderer.warn(`${r.agentId}: ${r.status === 'failed' ? (r.error ?? 'failed') : 'still running'}`);
          }
        }
      } finally {
        this.spinner.stop();
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
      const lines = taskIds.map(tid => `${tid} → ${(this.mainAgent.getTask(tid) as any)?.agentId || 'unknown'}`);
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

      this.spinner.start(`collecting ${ids.length} tasks + cross-review...`);
      try {
        const { results, consensus: report } = await this.mainAgent.collect(ids, timeout, { consensus: true });
        for (const r of results) {
          const dur = r.completedAt ? `${r.completedAt - r.startedAt}ms` : '?';
          this.renderer.section(`${r.agentId} (${dur})`, [r.status === 'completed' ? (r.result ?? '') : `${r.status}: ${r.error ?? 'unknown'}`]);
        }
        if (report) {
          this.renderer.text(report.summary ?? '');
        } else {
          this.renderer.warn('Consensus cross-review did not run (need >= 2 successful agents).');
        }
      } finally {
        this.spinner.stop();
      }
      this.lastTaskIds = [];
    },

    plan: async (args: string) => {
      const task = args.trim();
      if (!task) {
        this.renderer.warn('Usage: /plan <task>');
        return false;
      }
      this.spinner.start('planning...');
      try {
        const response = await this.mainAgent.handleMessage(`Plan this task: ${task}`);
        this.spinner.stop();
        await this.display(response, task);
      } catch (err) {
        this.spinner.stop();
        throw err;
      }
      return true;
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
      if (mode === 'scoped' && !parts[1]) {
        this.renderer.warn('Scoped mode requires a directory path.');
        return;
      }
      this.writeMode = { mode, scope: parts[1] };
      this.renderer.info(`Write mode: ${mode}${parts[1] ? ` (scope: ${parts[1]})` : ''}`);
    },

    init: async (args: string) => {
      const description = args.trim();
      if (!description) {
        this.renderer.warn('Usage: /init <project description>');
        this.renderer.info('Example: /init building a snake game in TypeScript');
        return false;
      }
      this.spinner.start('scanning project and proposing team...');
      try {
        const response = await this.mainAgent.handleMessage(description);
        this.spinner.stop();
        await this.display(response, description);
      } catch (err) {
        this.spinner.stop();
        throw err;
      }
      return true;
    },

    health: async () => {
      const activeTasks = this.mainAgent.getActiveTasksHealth();
      if (activeTasks.length === 0) {
        this.renderer.info('No active tasks.');
        return;
      }
      const lines = activeTasks.map(t => {
        const elapsed = (t.elapsedMs / 1000).toFixed(1);
        const stuck = t.isLikelyStuck ? ' \x1b[31m⚠ LIKELY STUCK\x1b[0m' : '';
        return `${t.agentId} [${t.id}]: ${t.task} — ${elapsed}s, ${t.toolCalls} tool calls${stuck}`;
      });
      this.renderer.section(`Active Tasks (${activeTasks.length})`, lines);
    },

    image: async (args: string) => {
      const { readClipboardImage } = await import('./clipboard');
      const { processImage } = await import('./image-handler');

      const image = await readClipboardImage();
      if (!image) {
        this.renderer.warn('No image found in clipboard.');
        return false;
      }

      const processed = processImage(image);
      const dimStr = processed.dimensions ? ` ${processed.dimensions.width}x${processed.dimensions.height}` : '';
      this.renderer.info(`Image: ${processed.format.toUpperCase()}${dimStr} (${Math.round(processed.sizeBytes / 1024)} KB)`);

      const text = args.trim() || 'Describe this image.';
      const content: ContentBlock[] = [
        { type: 'image', data: processed.base64, mediaType: processed.mediaType },
        { type: 'text', text },
      ];

      this.spinner.start('thinking...');
      try {
        const response = await this.mainAgent.handleMessage(content);
        this.spinner.stop();
        await this.display(response, content);
      } catch (err) {
        this.spinner.stop();
        throw err;
      }
      return true;
    },
  };

  // ── Prompt ──────────────────────────────────────────────────────────

  private prompt(): void {
    if (this.isShuttingDown) return;
    if (this.state === 'choice') {
      this.rl.setPrompt('  choice> ');
    } else if (this.writeMode) {
      this.rl.setPrompt(`[${this.writeMode.mode}]> `);
    } else {
      this.rl.setPrompt('\x1b[36m>\x1b[0m ');
    }
    this.rl.prompt();
  }

  // ── Shutdown ────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.spinner.stop();
    if (this.progressTree?.isActive()) this.progressTree.finish();
    this.renderer.info('Shutting down...');
    
    // rl.close() is idempotent — safe to call even if already closed.
    if (this.rl) {
        this.rl.close();
    }

    const forceExit = setTimeout(() => {
      process.exit(0);
    }, 3000);

    try {
      await this.onShutdown();
    } catch { 
      // ignore shutdown errors 
    }
    
    clearTimeout(forceExit);
    process.exit(0);
  }
}
