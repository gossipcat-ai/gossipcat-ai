import * as p from '@clack/prompts';
import { createInterface, Interface } from 'readline';
import { MainAgent, MainAgentConfig, ChatResponse, BootstrapGenerator } from '@gossip/orchestrator';
import { RelayServer } from '@gossip/relay';
import { ToolServer } from '@gossip/tools';
import { ContentBlock } from '@gossip/types';
import { GossipConfig, configToAgentConfigs } from './config';
import { Keychain } from './keychain';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  gray:   '\x1b[90m',
};

// Module-level state for pending choices (shared between renderResponse and REPL handler)
let pendingChoices: { options: Array<{ value: string; label: string; hint?: string }>; originalMessage: string; mainAgent: MainAgent } | null = null;

/**
 * Inline arrow-key selector — doesn't use @clack or inquirer.
 * Temporarily takes over stdin in raw mode, renders a selectable list,
 * returns the selected value. Restores stdin state after.
 */
function inlineSelect(options: Array<{ value: string; label: string; hint?: string }>): Promise<string | null> {
  return new Promise((resolve) => {
    let selected = 0;
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    function render() {
      // Move cursor up to redraw (clear previous render)
      if (selected >= 0) {
        process.stdout.write(`\x1b[${options.length}A`); // move up N lines
      }
      for (let i = 0; i < options.length; i++) {
        const prefix = i === selected ? `${c.cyan}  > ` : '    ';
        const label = i === selected ? `${c.bold}${options[i].label}${c.reset}` : `${c.dim}${options[i].label}${c.reset}`;
        const hint = options[i].hint ? ` ${c.dim}(${options[i].hint})${c.reset}` : '';
        process.stdout.write(`\r\x1b[K${prefix}${label}${hint}\n`);
      }
    }

    // Initial render
    for (const opt of options) {
      console.log(''); // reserve lines
    }
    render();

    stdin.setRawMode(true);
    stdin.resume();

    function onData(buf: Buffer) {
      const key = buf.toString();

      if (key === '\x1b[A') { // up arrow
        selected = (selected - 1 + options.length) % options.length;
        render();
      } else if (key === '\x1b[B') { // down arrow
        selected = (selected + 1) % options.length;
        render();
      } else if (key === '\r' || key === '\n') { // enter
        cleanup();
        resolve(options[selected].value);
      } else if (key === '\x03' || key === '\x1b') { // ctrl-c or escape
        cleanup();
        resolve(null);
      } else if (key >= '1' && key <= '9') { // number key
        const idx = parseInt(key, 10) - 1;
        if (idx < options.length) {
          selected = idx;
          render();
          cleanup();
          resolve(options[selected].value);
        }
      }
    }

    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
    }

    stdin.on('data', onData);
  });
}

// ── Render a ChatResponse ───────────────────────────────────────────────────
async function renderResponse(
  response: ChatResponse,
  originalMessage: string,
  mainAgent: MainAgent,
): Promise<void> {
  // Show agent attribution if multiple agents contributed
  if (response.agents && response.agents.length > 1) {
    console.log(`${c.dim}  Agents: ${response.agents.join(', ')}${c.reset}`);
  }

  // Show main text
  if (response.text) {
    console.log('');
    console.log(response.text);
  }

  // Show interactive choices — inline arrow-key selector
  if (response.choices && response.choices.options.length > 0) {
    console.log('');
    const selectedValue = await inlineSelect(response.choices.options);

    if (selectedValue) {
      process.stdout.write(`${c.dim}  processing...${c.reset}`);
      try {
        const followUp = await mainAgent.handleChoice(originalMessage, selectedValue);
        process.stdout.write('\r\x1b[K');
        await renderResponse(followUp, originalMessage, mainAgent);
      } catch (err) {
        process.stdout.write('\r\x1b[K');
        console.log(`${c.yellow}  Error: ${err instanceof Error ? err.message : 'Unknown'}${c.reset}`);
      }
    }
    return;
  }

  console.log('');
}

// ── Main chat loop ──────────────────────────────────────────────────────────
export async function startChat(config: GossipConfig): Promise<void> {
  const keychain = new Keychain();

  // ── Boot infrastructure ─────────────────────────────────────────────────
  const s = p.spinner();
  s.start('Starting Gossip Mesh...');

  const relay = new RelayServer({ port: 0 });
  await relay.start();

  const toolServer = new ToolServer({
    relayUrl: relay.url,
    projectRoot: process.cwd(),
  });
  await toolServer.start();

  const mainKey = await keychain.getKey(config.main_agent.provider);

  // Generate bootstrap prompt for team context
  const { BootstrapGenerator } = await import('@gossip/orchestrator');
  const bootstrapGen = new BootstrapGenerator(process.cwd());
  const { prompt: bootstrapPrompt } = bootstrapGen.generate();
  // Write .gossip/bootstrap.md for humans/tools that read static files
  const { writeFileSync: writeBs, mkdirSync: mkBs } = await import('fs');
  const { join: joinBs } = await import('path');
  mkBs(joinBs(process.cwd(), '.gossip'), { recursive: true });
  writeBs(joinBs(process.cwd(), '.gossip', 'bootstrap.md'), bootstrapPrompt);

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

  const agents = configToAgentConfigs(config);
  const orchestratorLabel = `${config.main_agent.provider}/${config.main_agent.model}`;

  if (agents.length === 0) {
    s.stop(`Ready — orchestrator online (${orchestratorLabel}), no agents yet`);
    console.log(`\n${c.green}  Describe your project and I'll set up a tailored agent team.${c.reset}`);
    console.log(`${c.dim}  Or use /init <description> to initialize explicitly.${c.reset}`);
    console.log(`${c.dim}  /help for all commands.${c.reset}\n`);
  } else {
    s.stop(`Ready — ${agents.length} agent${agents.length !== 1 ? 's' : ''} online (${orchestratorLabel}, relay :${relay.port})`);
    console.log(`\n${c.dim}  Just type naturally to chat. Or use slash commands:${c.reset}`);
    console.log(`${c.dim}  /dispatch-consensus <task>  →  dispatch to all ${agents.length} agents + cross-review${c.reset}`);
    console.log(`${c.dim}  /dispatch <agent> <task>    →  dispatch to one agent${c.reset}`);
    console.log(`${c.dim}  /help                       →  all commands${c.reset}\n`);
  }

  // ── REPL loop ───────────────────────────────────────────────────────────
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan}>${c.reset} `,
    historySize: 100,
    terminal: true,
  });
  rl.prompt();

  // Track pending task IDs for /collect
  let lastTaskIds: string[] = [];

  // ── Command handlers (mirror MCP tools) ─────────────────────────────────
  const commands: Record<string, (args: string) => Promise<void>> = {

    // /help — list commands
    async help() {
      console.log(`
${c.bold}Dispatch & Collect${c.reset}
  ${c.cyan}/dispatch${c.reset} <agent_id> <task>         Send task to one agent
  ${c.cyan}/dispatch-parallel${c.reset} <json>           Fan out to multiple agents
  ${c.cyan}/collect${c.reset} [task_ids] [timeout_ms]    Collect results (default: last dispatch)

${c.bold}Consensus (cross-review)${c.reset}
  ${c.cyan}/dispatch-consensus${c.reset} <task>          Dispatch to all agents with consensus
  ${c.cyan}/collect-consensus${c.reset} [task_ids] [ms]  Collect + cross-review → tagged report

${c.bold}Planning & Write Modes${c.reset}
  ${c.cyan}/plan${c.reset} <task>                        Plan task with write-mode suggestions
  ${c.cyan}/write${c.reset} <mode> [scope]               Set write mode (sequential/scoped/worktree)
  ${c.cyan}/write off${c.reset}                          Disable write mode

${c.bold}Info${c.reset}
  ${c.cyan}/agents${c.reset}                             List configured agents
  ${c.cyan}/status${c.reset}                             System status
  ${c.cyan}/bootstrap${c.reset}                          Regenerate team context prompt
  ${c.cyan}/init${c.reset} <description>                  Initialize project with tailored agent team
  ${c.cyan}/tools${c.reset}                              List all tools
  ${c.cyan}/image${c.reset} [message]                    Send clipboard image to orchestrator

${c.dim}Or just type naturally — the orchestrator understands intent.${c.reset}
${c.dim}"exit" to quit.${c.reset}
`);
    },

    // /agents — list configured agents
    async agents() {
      const agents = configToAgentConfigs(config);
      console.log(`\n${c.bold}Agents (${agents.length}):${c.reset}`);
      for (const a of agents) {
        console.log(`  ${c.cyan}${a.id}${c.reset}: ${a.provider}/${a.model} (${a.preset || 'custom'}) — skills: ${a.skills.join(', ')}`);
      }
      console.log('');
    },

    // /status — system status
    async status() {
      const agents = configToAgentConfigs(config);
      const tasks = lastTaskIds.length;
      console.log(`\n${c.bold}Status:${c.reset}`);
      console.log(`  Relay: :${relay.port}`);
      console.log(`  Agents: ${agents.length} configured`);
      console.log(`  Pending tasks: ${tasks}`);
      console.log('');
    },

    // /bootstrap — regenerate team context
    async bootstrap() {
      const gen = new BootstrapGenerator(process.cwd());
      const result = gen.generate();
      const { writeFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
      writeFileSync(join(process.cwd(), '.gossip', 'bootstrap.md'), result.prompt);
      console.log(`\n${c.green}  Bootstrap refreshed (${result.agentCount} agents, tier: ${result.tier})${c.reset}\n`);
    },

    // /tools — list available tools
    async tools() {
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
      console.log(`\n${c.bold}Tools (${list.length}):${c.reset}`);
      for (const t of list) console.log(`  /${t}`);
      console.log('');
    },

    // /dispatch <agent_id> <task>
    async dispatch(args: string) {
      const spaceIdx = args.indexOf(' ');
      if (spaceIdx === -1) {
        console.log(`\n${c.yellow}  Usage: /dispatch <agent_id> <task>${c.reset}\n`);
        return;
      }
      const agentId = args.slice(0, spaceIdx).trim();
      const task = args.slice(spaceIdx + 1).trim();
      const { taskId } = mainAgent.dispatch(agentId, task);
      lastTaskIds = [taskId];
      console.log(`\n${c.green}  Dispatched to ${agentId}. Task ID: ${taskId}${c.reset}\n`);
    },

    // /dispatch-parallel <json array>
    'dispatch-parallel': async (args: string) => {
      let taskDefs: Array<{ agent_id: string; task: string }>;
      try {
        taskDefs = JSON.parse(args);
      } catch {
        console.log(`\n${c.yellow}  Usage: /dispatch-parallel [{"agent_id":"...","task":"..."},...]${c.reset}\n`);
        return;
      }
      const { taskIds, errors } = await mainAgent.dispatchParallel(
        taskDefs.map(d => ({ agentId: d.agent_id, task: d.task })),
      );
      lastTaskIds = taskIds;
      console.log(`\n${c.green}  Dispatched ${taskIds.length} tasks:${c.reset}`);
      for (const tid of taskIds) {
        const t = mainAgent.getTask(tid);
        console.log(`${c.dim}    ${tid} → ${t?.agentId || 'unknown'}${c.reset}`);
      }
      if (errors.length) console.log(`${c.yellow}  Errors: ${errors.join(', ')}${c.reset}`);
      console.log('');
    },

    // /collect [task_ids_csv] [timeout_ms]
    async collect(args: string) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const ids = parts[0] ? parts[0].split(',') : (lastTaskIds.length > 0 ? lastTaskIds : undefined);
      const timeout = parts[1] ? parseInt(parts[1], 10) : 120_000;

      process.stdout.write(`${c.dim}  collecting${ids ? ` ${ids.length} tasks` : ' all'}...${c.reset}`);
      const { results } = await mainAgent.collect(ids, timeout);
      process.stdout.write('\r\x1b[K');

      for (const r of results) {
        const dur = r.completedAt ? `${r.completedAt - r.startedAt}ms` : '?';
        if (r.status === 'completed') {
          console.log(`\n${c.cyan}── ${r.agentId} (${dur}) ──${c.reset}`);
          console.log(r.result);
        } else {
          console.log(`\n${c.yellow}── ${r.agentId}: ${r.status === 'failed' ? r.error : 'still running'} ──${c.reset}`);
        }
      }
      lastTaskIds = [];
      console.log('');
    },

    // /dispatch-consensus <task> — dispatches to ALL agents with consensus
    'dispatch-consensus': async (args: string) => {
      const task = args.trim();
      if (!task) {
        console.log(`\n${c.yellow}  Usage: /dispatch-consensus <task>${c.reset}\n`);
        return;
      }
      const agents = configToAgentConfigs(config);
      if (agents.length < 2) {
        console.log(`\n${c.yellow}  Need ≥2 agents for consensus. Currently: ${agents.length}${c.reset}\n`);
        return;
      }
      const taskDefs = agents.map(a => ({ agentId: a.id, task }));
      const { taskIds, errors } = await mainAgent.dispatchParallel(taskDefs, { consensus: true });
      lastTaskIds = taskIds;
      console.log(`\n${c.green}  Dispatched ${taskIds.length} tasks with consensus:${c.reset}`);
      for (const tid of taskIds) {
        const t = mainAgent.getTask(tid);
        console.log(`${c.dim}    ${tid} → ${t?.agentId || 'unknown'}${c.reset}`);
      }
      if (errors.length) console.log(`${c.yellow}  Errors: ${errors.join(', ')}${c.reset}`);
      console.log(`${c.dim}  Call /collect-consensus when ready.${c.reset}\n`);
    },

    // /collect-consensus [task_ids_csv] [timeout_ms]
    'collect-consensus': async (args: string) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const ids = parts[0] ? parts[0].split(',') : (lastTaskIds.length > 0 ? lastTaskIds : undefined);
      const timeout = parts[1] ? parseInt(parts[1], 10) : 300_000;

      if (!ids || ids.length === 0) {
        console.log(`\n${c.yellow}  No task IDs. Run /dispatch-consensus first.${c.reset}\n`);
        return;
      }

      process.stdout.write(`${c.dim}  collecting ${ids.length} tasks + cross-review...${c.reset}`);
      const { results, consensus: report } = await mainAgent.collect(ids, timeout, { consensus: true });
      process.stdout.write('\r\x1b[K');

      for (const r of results) {
        const dur = r.completedAt ? `${r.completedAt - r.startedAt}ms` : '?';
        if (r.status === 'completed') {
          console.log(`\n${c.cyan}── ${r.agentId} (${dur}) ──${c.reset}`);
          console.log(r.result);
        } else {
          console.log(`\n${c.yellow}── ${r.agentId}: ${r.status === 'failed' ? r.error : 'still running'} ──${c.reset}`);
        }
      }

      if (report) {
        console.log(`\n${c.bold}${report.summary}${c.reset}`);
      } else {
        console.log(`\n${c.yellow}  Consensus cross-review did not run (need ≥2 successful agents).${c.reset}`);
      }
      lastTaskIds = [];
      console.log('');
    },

    // /plan <task>
    async plan(args: string) {
      const task = args.trim();
      if (!task) {
        console.log(`\n${c.yellow}  Usage: /plan <task>${c.reset}\n`);
        return;
      }
      process.stdout.write(`${c.dim}  planning...${c.reset}`);
      const response = await mainAgent.handleMessage(`Plan this task: ${task}`);
      process.stdout.write('\r\x1b[K');
      console.log(`\n${response.text}\n`);
    },

    // /write <mode> [scope] | off
    async write(args: string) {
      const parts = args.trim().split(/\s+/);
      const validModes = ['sequential', 'scoped', 'worktree'] as const;
      const mode = parts[0] as typeof validModes[number];
      if (parts[0] === 'off') {
        activeWriteMode = null;
        console.log(`\n${c.green}  Write mode disabled.${c.reset}\n`);
        return;
      }
      if (!mode || !validModes.includes(mode)) {
        console.log(`\n${c.yellow}  Usage: /write <mode> [scope] | /write off${c.reset}`);
        console.log(`${c.dim}  Modes: sequential, scoped, worktree${c.reset}\n`);
        return;
      }
      const scope = parts[1] || undefined;
      if (mode === 'scoped' && !scope) {
        console.log(`\n${c.yellow}  Scoped mode requires a directory path.${c.reset}\n`);
        return;
      }
      activeWriteMode = { mode, scope };
      console.log(`\n${c.green}  Write mode: ${mode}${scope ? ` (scope: ${scope})` : ''}${c.reset}\n`);
    },

    // /init <description> — initialize project with tailored agent team
    async init(args: string) {
      const description = args.trim();
      if (!description) {
        console.log(`\n${c.yellow}  Usage: /init <project description>${c.reset}`);
        console.log(`${c.dim}  Example: /init building a snake game in TypeScript${c.reset}\n`);
        return;
      }
      process.stdout.write(`${c.dim}  scanning project and proposing team...${c.reset}`);
      const response = await mainAgent.handleMessage(description);
      process.stdout.write('\r\x1b[K');
      console.log(`\n${response.text}\n`);
      // If choices present, they'll be handled by the existing REPL flow
    },

    // /image [message]
    async image(args: string) {
      const { readClipboardImage } = await import('./clipboard');
      const { processImage } = await import('./image-handler');

      const image = await readClipboardImage();
      if (!image) {
        console.log(`\n${c.yellow}  No image found in clipboard.${c.reset}\n`);
        return;
      }

      const processed = processImage(image);
      const dimStr = processed.dimensions ? ` ${processed.dimensions.width}x${processed.dimensions.height}` : '';
      console.log(`\n${c.green}  Image: ${processed.format.toUpperCase()}${dimStr} (${Math.round(processed.sizeBytes / 1024)} KB)${c.reset}`);

      const text = args.trim() || 'Describe this image.';
      const content: ContentBlock[] = [
        { type: 'image', data: processed.base64, mediaType: processed.mediaType },
        { type: 'text', text },
      ];

      process.stdout.write(`${c.dim}  thinking...${c.reset}`);
      const response = await mainAgent.handleMessage(content);
      process.stdout.write('\r\x1b[K');
      await renderResponse(response, text, mainAgent);
    },
  };

  let activeWriteMode: { mode: 'sequential' | 'scoped' | 'worktree'; scope?: string } | null = null;

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === 'exit' || input === 'quit') {
      await shutdown(relay, toolServer, mainAgent, rl);
      return;
    }

    // ── Slash commands ────────────────────────────────────────────────────
    if (input.startsWith('/')) {
      const spaceIdx = input.indexOf(' ');
      const cmd = (spaceIdx === -1 ? input : input.slice(0, spaceIdx)).slice(1);
      const args = spaceIdx === -1 ? '' : input.slice(spaceIdx + 1);

      const handler = commands[cmd];
      if (handler) {
        try {
          await handler(args);
        } catch (err) {
          console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
        }
      } else {
        console.log(`\n${c.yellow}  Unknown command: /${cmd}. Try /help${c.reset}\n`);
      }
      rl.prompt();
      return;
    }

    // ── Free-text input ───────────────────────────────────────────────────
    try {
      if (activeWriteMode) {
        if (agents.length === 0) {
          console.log(`\n${c.yellow}  No agents configured.${c.reset}\n`);
          rl.prompt();
          return;
        }
        process.stdout.write(`${c.dim}  dispatching [${activeWriteMode.mode}]...${c.reset}`);
        const options = { writeMode: activeWriteMode.mode, scope: activeWriteMode.scope };
        const { taskId } = mainAgent.dispatch(agents[0].id, input, options);
        const { results } = await mainAgent.collect([taskId]);
        process.stdout.write('\r\x1b[K');
        const r = results[0];
        if (r?.status === 'completed') {
          console.log(`\n${r.result}\n`);
        } else {
          console.log(`\n${c.yellow}  Error: ${r?.error || 'Unknown'}${c.reset}\n`);
        }
      } else {
        // Show appropriate spinner based on state
        const isInit = configToAgentConfigs(config).length === 0;
        const spinnerText = isInit ? 'analyzing project and proposing team...' : 'thinking...';
        process.stdout.write(`\r${c.dim}  ${spinnerText}${c.reset}`);
        try {
          const response = await mainAgent.handleMessage(input);
          process.stdout.write('\r\x1b[K');
          await renderResponse(response, input, mainAgent);
        } catch (err) {
          process.stdout.write('\r\x1b[K');
          console.log(`\n${c.yellow}  Error: ${err instanceof Error ? err.message : 'Unknown error'}${c.reset}\n`);
        }
      }
    } catch (err) {
      process.stdout.write('\r\x1b[K');
      console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await shutdown(relay, toolServer, mainAgent, rl);
  });

  process.on('SIGINT', async () => {
    await shutdown(relay, toolServer, mainAgent, rl);
  });
}

async function shutdown(
  relay: RelayServer,
  toolServer: ToolServer,
  mainAgent: MainAgent,
  rl: Interface,
): Promise<void> {
  console.log(`\n${c.dim}  Shutting down...${c.reset}`);
  rl.close();
  // Force exit after 3s if graceful shutdown hangs
  const forceExit = setTimeout(() => process.exit(0), 3000);
  try {
    await mainAgent.stop();
    await toolServer.stop();
    await relay.stop();
  } catch { /* ignore shutdown errors */ }
  clearTimeout(forceExit);
  process.exit(0);
}
