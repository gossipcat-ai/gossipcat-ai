#!/usr/bin/env node
import { findConfigPath, loadConfig, configToAgentConfigs } from './config';
import { runSetupWizard } from './setup-wizard';
import { startChat } from './chat';
import { createAgent, listAgents, removeAgent } from './create-agent';
import { createTeam } from './create-team';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'setup':
      await runSetupWizard();
      return;

    case 'create-agent':
      await createAgent();
      return;

    case 'list-agents':
    case 'agents':
      await listAgents();
      return;

    case 'remove-agent':
      await removeAgent(args[1]);
      return;

    case 'create-team':
      await createTeam(args.slice(1).join(' ') || undefined);
      return;

    case 'mcp-serve':
      // Run MCP server via stdio — used by Claude Code / Cursor / any MCP client
      await import('./mcp-server-sdk');
      return;

    case 'tasks': {
      const { runTasksCommand } = await import('./tasks-command');
      runTasksCommand(process.argv.slice(3));
      return;
    }

    case 'sync': {
      const { runSyncCommand } = await import('./sync-command');
      await runSyncCommand(process.argv.slice(3));
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
  }

  // Check for config
  const configPath = findConfigPath();
  if (!configPath) {
    console.log('No gossip.agents.json found. Running setup wizard...');
    await runSetupWizard();
    return;
  }

  const config = loadConfig(configPath);

  // One-shot task — boot, run, print result, exit
  if (args.length > 0) {
    // Parse --write-mode flag
    let writeMode: string | undefined;
    let scope: string | undefined;
    const filteredArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--write-mode' && i + 1 < args.length) {
        writeMode = args[++i];
      } else if (args[i] === '--scope' && i + 1 < args.length) {
        scope = args[++i];
      } else {
        filteredArgs.push(args[i]);
      }
    }
    const task = filteredArgs.join(' ');

    if (writeMode && !['sequential', 'scoped', 'worktree'].includes(writeMode)) {
      console.error(`Invalid write mode: "${writeMode}". Must be sequential, scoped, or worktree.`);
      process.exit(1);
    }

    const { RelayServer } = await import('@gossip/relay');
    const { ToolServer } = await import('@gossip/tools');
    const { MainAgent } = await import('@gossip/orchestrator');
    const { Keychain } = await import('./keychain');

    const keychain = new Keychain();
    const relay = new RelayServer({ port: 0 });
    await relay.start();
    const toolServer = new ToolServer({ relayUrl: relay.url, projectRoot: process.cwd() });
    await toolServer.start();

    const mainKey = await keychain.getKey(config.main_agent.provider);
    const mainAgent = new MainAgent({
      provider: config.main_agent.provider, model: config.main_agent.model,
      apiKey: mainKey || undefined, relayUrl: relay.url,
      agents: configToAgentConfigs(config), projectRoot: process.cwd(),
      toolServer: {
        assignScope: (agentId: string, scope: string) => toolServer.assignScope(agentId, scope),
        assignRoot: (agentId: string, root: string) => toolServer.assignRoot(agentId, root),
        releaseAgent: (agentId: string) => toolServer.releaseAgent(agentId),
      },
    });
    await mainAgent.start();

    if (writeMode) {
      // Write mode: dispatch to first available agent with write options
      const agents = configToAgentConfigs(config);
      if (agents.length === 0) {
        console.error('No agents configured. Run gossipcat setup first.');
        process.exit(1);
      }
      const options = { writeMode: writeMode as 'sequential' | 'scoped' | 'worktree', scope };
      const { taskId } = mainAgent.dispatch(agents[0].id, task, options);
      const { results } = await mainAgent.collect([taskId]);
      const r = results[0];
      console.log(r?.status === 'completed' ? r.result : `Error: ${r?.error || 'Unknown'}`);
    } else {
      const response = await mainAgent.handleMessage(task);
      console.log(response.text);
    }

    await mainAgent.stop();
    await toolServer.stop();
    await relay.stop();
    return;
  }

  // Interactive chat
  await startChat(config);
}

function printHelp(): void {
  console.log(`
  gossipcat — Multi-Agent Orchestration CLI

  Usage:
    gossipcat                  Interactive chat with your agent team
    gossipcat setup            Run the setup wizard
    gossipcat create-agent     Add a new agent to your team (interactive)
    gossipcat create-team      Create a full team from a description (AI-powered)
    gossipcat list-agents      Show your current agent team
    gossipcat remove-agent     Remove an agent from your team
    gossipcat tasks            Show recent task history
    gossipcat tasks <id>       Show detail for a specific task
    gossipcat tasks --agent <id>  Filter tasks by agent
    gossipcat sync             Sync task history to Supabase
    gossipcat sync --setup     Configure Supabase connection
    gossipcat sync --status    Show sync status
    gossipcat mcp-serve        Start MCP server (for Claude Code / Cursor)
    gossipcat help             Show this help

  Write modes:
    --write-mode sequential    Queue write tasks (one at a time)
    --write-mode scoped        Directory-locked parallel writes
    --write-mode worktree      Git worktree isolation
    --scope <path>             Directory scope for scoped mode

  Examples:
    gossipcat create-team "Building a Next.js + Supabase SaaS. Need architecture, coding, and review."
    gossipcat create-team      (interactive prompt if no description given)
    gossipcat --write-mode scoped --scope packages/relay/ "refactor the relay module"

  Agent files:
    .gossip/agents/<id>/
      instructions.md          Agent system prompt and rules
      memory/MEMORY.md         Persistent memory index
      memory/*.md              Individual memory files
      context/                 Context files injected into prompts
      config.json              Agent-specific overrides
`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
