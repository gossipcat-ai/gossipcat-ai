/** ANSI color helpers */
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
};

/**
 * Handles all terminal output formatting for the chat CLI.
 * Single source of truth for writing to stdout.
 */
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
   * Adapts hint text for multiselect and allowCustom.
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
