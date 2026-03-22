import * as p from '@clack/prompts';
import { createInterface, Interface } from 'readline';
import { MainAgent, MainAgentConfig, ChatResponse } from '@gossip/orchestrator';
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

  // Show interactive choices if present
  if (response.choices && response.choices.options.length > 0) {
    console.log('');

    const options = response.choices.options.map(opt => ({
      value: opt.value,
      label: opt.label,
      hint: opt.hint,
    }));

    // Add custom input option if allowed
    if (response.choices.allowCustom) {
      options.push({
        value: '__custom__',
        label: 'Let me explain what I want...',
        hint: 'Type a custom response',
      });
    }

    if (response.choices.type === 'confirm') {
      const confirmed = await p.confirm({
        message: response.choices.message,
      });
      if (p.isCancel(confirmed)) return;
      const choice = confirmed ? 'yes' : 'no';
      const followUp = await mainAgent.handleChoice(originalMessage, choice);
      await renderResponse(followUp, originalMessage, mainAgent);

    } else if (response.choices.type === 'multiselect') {
      const selected = await p.multiselect({
        message: response.choices.message,
        options,
        required: true,
      });
      if (p.isCancel(selected)) return;
      const choice = (selected as string[]).join(', ');
      const followUp = await mainAgent.handleChoice(originalMessage, choice);
      await renderResponse(followUp, originalMessage, mainAgent);

    } else {
      // Default: single select
      const selected = await p.select({
        message: response.choices.message,
        options,
      });
      if (p.isCancel(selected)) return;

      if (selected === '__custom__') {
        const custom = await p.text({
          message: 'What do you want instead?',
          placeholder: 'Describe your preferred approach...',
        });
        if (p.isCancel(custom)) return;
        const followUp = await mainAgent.handleChoice(originalMessage, custom as string);
        await renderResponse(followUp, originalMessage, mainAgent);
      } else {
        const followUp = await mainAgent.handleChoice(originalMessage, selected as string);
        await renderResponse(followUp, originalMessage, mainAgent);
      }
    }
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
  };

  const mainAgent = new MainAgent(mainAgentConfig);
  await mainAgent.start();

  const agentCount = configToAgentConfigs(config).length;
  s.stop(`Ready — ${agentCount} agent${agentCount !== 1 ? 's' : ''} online (relay :${relay.port})`);

  console.log(`${c.dim}  Type a task or question. "exit" to quit.${c.reset}\n`);

  // ── REPL loop ───────────────────────────────────────────────────────────
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.cyan}>${c.reset} `,
  });
  rl.prompt();

  let activeWriteMode: { mode: 'sequential' | 'scoped' | 'worktree'; scope?: string } | null = null;

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === 'exit' || input === 'quit') {
      await shutdown(relay, toolServer, mainAgent, rl);
      return;
    }

    if (input === '/write' || input.startsWith('/write ')) {
      const parts = input.slice(7).trim().split(/\s+/);
      const validModes = ['sequential', 'scoped', 'worktree'] as const;
      const mode = parts[0] as typeof validModes[number];
      if (!mode || !validModes.includes(mode)) {
        if (parts[0] === 'off') {
          activeWriteMode = null;
          console.log(`\n${c.green}  Write mode disabled.${c.reset}\n`);
          rl.prompt();
          return;
        }
        console.log(`\n${c.yellow}  Usage: /write <mode> [scope] | /write off${c.reset}`);
        console.log(`${c.dim}  Modes: sequential, scoped, worktree${c.reset}`);
        console.log(`${c.dim}  Example: /write scoped packages/relay/${c.reset}\n`);
        rl.prompt();
        return;
      }
      const scope = parts[1] || undefined;
      activeWriteMode = { mode, scope };
      console.log(`\n${c.green}  Write mode: ${mode}${scope ? ` (scope: ${scope})` : ''}${c.reset}`);
      console.log(`${c.dim}  All dispatched tasks will use this mode. /write off to disable.${c.reset}\n`);
      rl.prompt();
      return;
    }

    if (input === '/image' || input.startsWith('/image ')) {
      try {
        const { readClipboardImage } = await import('./clipboard');
        const { processImage } = await import('./image-handler');

        const image = await readClipboardImage();
        if (!image) {
          console.log(`\n${c.yellow}  No image found in clipboard. Copy an image first, then run /image.${c.reset}\n`);
          rl.prompt();
          return;
        }

        const processed = processImage(image);
        const dimStr = processed.dimensions
          ? ` ${processed.dimensions.width}x${processed.dimensions.height}`
          : '';
        console.log(`\n${c.green}  Image detected: ${processed.format.toUpperCase()}${dimStr} (${Math.round(processed.sizeBytes / 1024)} KB)${c.reset}`);

        // Extract inline message: "/image what's this?" → "what's this?"
        const inlineMessage = input.startsWith('/image ') ? input.slice(7).trim() : '';

        const sendImage = async (text: string) => {
          const content: ContentBlock[] = [
            { type: 'image', data: processed.base64, mediaType: processed.mediaType },
          ];
          content.push({ type: 'text', text });

          process.stdout.write(`${c.dim}  thinking...${c.reset}`);
          try {
            const response = await mainAgent.handleMessage(content);
            process.stdout.write('\r\x1b[K');
            await renderResponse(response, text, mainAgent);
          } catch (err) {
            process.stdout.write('\r\x1b[K');
            console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
          }
          rl.prompt();
        };

        if (inlineMessage) {
          // /image what's wrong with this UI? → send immediately
          await sendImage(inlineMessage);
        } else {
          // /image alone → prompt for message
          rl.question(`${c.dim}  Message (Enter for image only): ${c.reset}`, async (message) => {
            await sendImage(message?.trim() || 'Describe this image.');
          });
        }
      } catch (err) {
        console.log(`\n${c.yellow}  Error: ${(err as Error).message}${c.reset}\n`);
        rl.prompt();
      }
      return;
    }

    try {
      if (activeWriteMode) {
        // Write mode: dispatch directly to first agent
        const agents = configToAgentConfigs(config);
        if (agents.length === 0) {
          console.log(`\n${c.yellow}  No agents configured.${c.reset}\n`);
          rl.prompt();
          return;
        }
        process.stdout.write(`${c.dim}  dispatching [${activeWriteMode.mode}]...${c.reset}`);
        const options = { writeMode: activeWriteMode.mode, scope: activeWriteMode.scope };
        const { taskId } = mainAgent.dispatch(agents[0].id, input, options);
        const results = await mainAgent.collect([taskId]);
        process.stdout.write('\r\x1b[K');
        const r = results[0];
        if (r?.status === 'completed') {
          console.log(`\n${r.result}\n`);
        } else {
          console.log(`\n${c.yellow}  Error: ${r?.error || 'Unknown'}${c.reset}\n`);
        }
      } else {
        // Normal mode: orchestrate via MainAgent
        process.stdout.write(`${c.dim}  thinking...${c.reset}`);
        const response = await mainAgent.handleMessage(input);
        process.stdout.write('\r\x1b[K');
        await renderResponse(response, input, mainAgent);
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
  await mainAgent.stop();
  await toolServer.stop();
  await relay.stop();
  process.exit(0);
}
