/**
 * Chat entry point — thin boot layer.
 * Creates infrastructure (relay, toolServer, mainAgent),
 * then delegates all interaction to ChatSession.
 */

import { MainAgent, MainAgentConfig, BootstrapGenerator, createProvider, OverlapDetector, LensGenerator, GossipPublisher } from '@gossip/orchestrator';
import { RelayServer } from '@gossip/relay';
import { ToolServer } from '@gossip/tools';
import { GossipAgent } from '@gossip/client';
import { GossipConfig, configToAgentConfigs } from './config';
import { Keychain } from './keychain';
import { ChatSession } from './chat-session';
import { Spinner } from './spinner';

export async function startChat(config: GossipConfig): Promise<void> {
  // Register early so boot errors don't crash without cleanup
  let session: ChatSession | null = null;
  process.on('unhandledRejection', (err) => {
    console.error('\n  Unhandled error:', err instanceof Error ? err.message : err);
    if (session) {
      session.shutdown().catch(() => process.exit(1));
    } else {
      process.exit(1);
    }
  });

  const spinner = new Spinner();
  spinner.start('Starting Gossip Mesh...');

  // ── Boot infrastructure ─────────────────────────────────────────────

  const relay = new RelayServer({ port: 0 });
  await relay.start();

  const toolServer = new ToolServer({
    relayUrl: relay.url,
    projectRoot: process.cwd(),
  });
  await toolServer.start();

  const keychain = new Keychain();
  const mainKey = await keychain.getKey(config.main_agent.provider);

  // Generate bootstrap prompt for team context
  const bootstrapGen = new BootstrapGenerator(process.cwd());
  const { prompt: bootstrapPrompt } = bootstrapGen.generate();
  const { writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');
  mkdirSync(join(process.cwd(), '.gossip'), { recursive: true });
  writeFileSync(join(process.cwd(), '.gossip', 'bootstrap.md'), bootstrapPrompt);

  // TaskGraph Supabase sync (same as MCP path)
  const supaKey = await keychain.getKey('supabase');
  const supaTeamSalt = await keychain.getKey('supabase-team-salt');

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
    syncFactory: () => {
      try {
        const { existsSync: exists, readFileSync: readF } = require('fs');
        const configPath = join(process.cwd(), '.gossip', 'supabase.json');
        if (!exists(configPath) || !supaKey) return null;
        const supaConfig = JSON.parse(readF(configPath, 'utf-8'));
        const { TaskGraph, TaskGraphSync } = require('@gossip/orchestrator');
        const { getUserId, getProjectId, getTeamUserId, getGitEmail } = require('./identity');

        let userId: string;
        let displayName: string | null = null;
        if (supaConfig.mode === 'team') {
          const email = getGitEmail();
          if (!supaTeamSalt || !email) return null;
          userId = getTeamUserId(email, supaTeamSalt);
          displayName = supaConfig.displayName || email;
        } else {
          userId = getUserId(process.cwd());
        }

        return new TaskGraphSync(new TaskGraph(process.cwd()), supaConfig.url, supaKey, userId, getProjectId(process.cwd()), process.cwd(), displayName);
      } catch { return null; }
    },
  };

  const mainAgent = new MainAgent(mainAgentConfig);
  await mainAgent.start();

  // ── Wire agent coordination (same as MCP path) ───────────────────

  // Overlap detection + focus lenses for co-dispatched agents
  try {
    const llmForLens = createProvider(config.main_agent.provider, config.main_agent.model, mainKey || undefined);
    mainAgent.setOverlapDetector(new OverlapDetector());
    mainAgent.setLensGenerator(new LensGenerator(llmForLens));
  } catch (err) {
    process.stderr.write(`[gossipcat] Lens generator failed: ${(err as Error).message}\n`);
  }

  // Gossip publisher — real-time summaries between parallel agents
  try {
    const publisherAgent = new GossipAgent({
      agentId: 'gossip-publisher',
      relayUrl: relay.url,
      reconnect: true,
    });
    await publisherAgent.connect();
    const llmForGossip = createProvider(config.main_agent.provider, config.main_agent.model, mainKey || undefined);
    const gossipPublisher = new GossipPublisher(
      llmForGossip,
      { publishToChannel: (channel: string, data: unknown) => publisherAgent.sendChannel(channel, data as Record<string, unknown>) },
    );
    mainAgent.setGossipPublisher(gossipPublisher);
  } catch (err) {
    process.stderr.write(`[gossipcat] Gossip publisher failed: ${(err as Error).message}\n`);
  }

  spinner.stop();

  // ── Welcome message ─────────────────────────────────────────────────

  const orchestratorLabel = `${config.main_agent.provider}/${config.main_agent.model}`;
  const agentCount = mainAgent.getAgentCount();

  if (agentCount === 0) {
    console.log(`Ready — orchestrator online (${orchestratorLabel}), no agents yet`);
    console.log("\n  Describe what you want to build. I'll brainstorm with you first, then assemble the right team.");
    console.log('  \x1b[2mType / + Enter for commands, Tab to autocomplete\x1b[0m\n');
  } else {
    console.log(`Ready — ${agentCount} agent${agentCount !== 1 ? 's' : ''} online (${orchestratorLabel}, relay :${relay.port})`);
    console.log('  \x1b[2mType / + Enter for commands, Tab to autocomplete\x1b[0m\n');
  }

  // ── Create and start chat session ───────────────────────────────────

  session = new ChatSession({
    mainAgent,
    config,
    onShutdown: async () => {
      // Use allSettled so one failure doesn't skip the rest
      await Promise.allSettled([
        mainAgent.stop(),
        toolServer.stop(),
        relay.stop(),
      ]);
    },
  });
  session.start();

  // ── Process-level handlers ──────────────────────────────────────────

  // SIGINT is handled by ChatSession's rl.on('SIGINT') — cancel or exit based on state.
  // This process-level handler is a fallback if readline isn't active.
  process.on('SIGINT', () => {
    if (session) {
      session.shutdown().catch(() => process.exit(0));
    } else {
      process.exit(0);
    }
  });

}
