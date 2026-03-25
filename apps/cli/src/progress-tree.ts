import { Interface as ReadlineInterface } from 'readline';
import { TaskProgressEvent } from '@gossip/orchestrator';

const MAX_TURNS = 15;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
};

interface AgentState {
  agentId: string;
  task: string;
  status: 'pending' | 'running' | 'done' | 'error';
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  currentTool: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/** Format token counts: 0 → "", <1000 → "847 tok", >=1000 → "12.4k tok" */
export function formatTokens(n: number): string {
  if (n === 0) return '';
  if (n < 1000) return `${n} tok`;
  return `${(n / 1000).toFixed(1)}k tok`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function renderBar(toolCalls: number): string {
  const filled = Math.min(toolCalls, MAX_TURNS);
  return '█'.repeat(filled) + '░'.repeat(MAX_TURNS - filled);
}

function renderStatus(state: AgentState, spinnerIdx: number): string {
  switch (state.status) {
    case 'pending':
      return `${c.dim}○ pending${c.reset}`;
    case 'running': {
      const frame = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
      const tool = state.currentTool || 'working';
      return `${c.cyan}${frame}${c.reset} ${c.dim}${tool}${c.reset}`;
    }
    case 'done': {
      const dur = state.completedAt
        ? ((state.completedAt - state.startedAt) / 1000).toFixed(1) + 's'
        : '';
      return `${c.green}✓ done${c.reset}${dur ? `  ${c.dim}${dur}${c.reset}` : ''}`;
    }
    case 'error': {
      const msg = state.error ? truncate(state.error, 40) : 'error';
      return `${c.red}✗ ${msg}${c.reset}`;
    }
  }
}

function renderAgentLine(state: AgentState, spinnerIdx: number, wide: boolean): string {
  const name = truncate(state.agentId, 16).padEnd(16);
  const bar = renderBar(state.toolCalls);
  const turns = `${state.toolCalls}/${MAX_TURNS}`.padStart(5);
  const task = truncate(state.task, 24).padEnd(24);
  const status = renderStatus(state, spinnerIdx);

  let stats = '';
  if (wide && state.status === 'done') {
    const toks = formatTokens(state.inputTokens + state.outputTokens);
    stats = toks ? toks.padEnd(14) : ''.padEnd(14);
  } else if (wide) {
    stats = ''.padEnd(14);
  }

  return `  ${c.dim}${name}${c.reset}  ${c.cyan}${bar}${c.reset}  ${turns}  ${task}  ${stats}${status}`;
}

/**
 * Multi-line ANSI pipeline progress renderer.
 * Shows per-agent execution status with progress bars during plan execution.
 */
export class ProgressTree {
  private rl: ReadlineInterface;
  private agents: AgentState[] = [];
  private interval: NodeJS.Timeout | null = null;
  private spinnerIdx = 0;
  private startedAt = 0;
  private lineCount = 0;

  constructor(rl: ReadlineInterface) {
    this.rl = rl;
  }

  /** Initialize agents as pending, pause readline, start render loop */
  start(agentList: Array<{ agentId: string; task: string }>): void {
    this.agents = agentList.map(a => ({
      agentId: a.agentId,
      task: a.task,
      status: 'pending',
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      currentTool: '',
      startedAt: Date.now(),
    }));
    this.startedAt = Date.now();
    this.spinnerIdx = 0;
    this.lineCount = 0;

    if (!process.stdout.isTTY) {
      process.stdout.write(`  Running ${agentList.length} agent${agentList.length !== 1 ? 's' : ''}...\n`);
      return;
    }

    this.rl.pause();
    this.draw();

    this.interval = setInterval(() => {
      this.spinnerIdx++;
      this.draw();
    }, 80);
  }

  /** Update agent state from a TaskProgressEvent */
  update(agentId: string, event: TaskProgressEvent): void {
    const state = this.agents.find(a => a.agentId === agentId);
    if (!state) return;

    switch (event.status) {
      case 'start':
        state.status = 'running';
        state.startedAt = Date.now();
        break;
      case 'progress':
        state.status = 'running';
        if (event.toolCalls !== undefined) state.toolCalls = event.toolCalls;
        if (event.currentTool !== undefined) state.currentTool = event.currentTool;
        if (event.inputTokens !== undefined) state.inputTokens = event.inputTokens;
        if (event.outputTokens !== undefined) state.outputTokens = event.outputTokens;
        break;
      case 'done':
        state.status = 'done';
        state.completedAt = Date.now();
        if (event.inputTokens !== undefined) state.inputTokens = event.inputTokens;
        if (event.outputTokens !== undefined) state.outputTokens = event.outputTokens;
        if (event.toolCalls !== undefined) state.toolCalls = event.toolCalls;
        break;
      case 'error':
        state.status = 'error';
        state.completedAt = Date.now();
        state.error = event.error ?? 'unknown error';
        break;
    }

    if (!process.stdout.isTTY) {
      if (event.status === 'done' || event.status === 'error') {
        const icon = event.status === 'done' ? '✓' : '✗';
        const suffix = event.status === 'done'
          ? formatTokens(state.inputTokens + state.outputTokens)
          : (event.error ?? 'error');
        process.stdout.write(`  ${icon} ${agentId}: ${suffix}\n`);
      }
    }
  }

  /** Final redraw, clear interval, resume readline */
  finish(): void {
    if (!this.interval && process.stdout.isTTY) {
      // not active in TTY mode
      if (this.agents.length === 0) return;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (process.stdout.isTTY) {
      this.draw();
      this.rl.resume();
    } else {
      if (this.agents.length > 0) {
        const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
        process.stdout.write(`  ${this.agents.length} agent${this.agents.length !== 1 ? 's' : ''} · ${elapsed}s\n`);
      }
    }
  }

  isActive(): boolean {
    return this.interval !== null;
  }

  private draw(): void {
    const wide = (process.stdout.columns ?? 80) >= 100;

    // Move cursor up to overwrite previous block
    if (this.lineCount > 0) {
      process.stdout.write(`\x1b[${this.lineCount}A`);
    }

    let lines = 0;
    for (const state of this.agents) {
      const line = renderAgentLine(state, this.spinnerIdx, wide);
      process.stdout.write(`${line}\x1b[K\n`);
      lines++;
    }

    // Footer summary
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const summary = `  ${c.dim}${this.agents.length} agent${this.agents.length !== 1 ? 's' : ''} · ${elapsed}s${c.reset}`;
    process.stdout.write(`${summary}\x1b[K\n`);
    lines++;

    this.lineCount = lines;
  }
}
