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
    const task = args.join(' ');
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
    });
    await mainAgent.start();

    const response = await mainAgent.handleMessage(task);
    console.log(response.text);

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
    gossipcat mcp-serve        Start MCP server (for Claude Code / Cursor)
    gossipcat help             Show this help

  Examples:
    gossipcat create-team "Building a Next.js + Supabase SaaS. Need architecture, coding, and review."
    gossipcat create-team      (interactive prompt if no description given)

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
