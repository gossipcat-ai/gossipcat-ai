import * as p from '@clack/prompts';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { Keychain } from './keychain';
import { createProvider, ILLMProvider } from '@gossip/orchestrator';
import { createAgentDirectory } from './create-agent';

const PRESET_SKILLS: Record<string, string[]> = {
  architect:   ['typescript', 'system_design', 'code_review', 'api_design'],
  implementer: ['typescript', 'implementation', 'testing', 'react'],
  reviewer:    ['code_review', 'security_audit', 'debugging'],
  tester:      ['testing', 'debugging', 'e2e', 'integration'],
  researcher:  ['documentation', 'api_design', 'research'],
  debugger:    ['debugging', 'testing', 'code_review'],
};

const SYSTEM_PROMPT = `You are a team configuration engine for Gossip Mesh, a multi-agent orchestration platform.

The user will describe their project and what help they need. Your job is to propose an optimal agent team.

Available providers (the user must have API keys for cloud providers):
- anthropic: Claude Opus 4.6 (most capable), Claude Sonnet 4.6 (fast+smart), Claude Haiku 4.5 (fastest)
- openai: GPT-5 (most capable), GPT-4o (fast+smart), GPT-4o Mini (fastest), o3 (reasoning), o3-mini (fast reasoning)
- google: Gemini 2.5 Pro (most capable), Gemini 2.5 Flash (fast)
- local: Any Ollama model (free, private, fast iteration)

Available roles: architect, implementer, reviewer, tester, researcher, debugger

Available skills: typescript, python, rust, go, java, react, nextjs, express, fastapi, django, node, system_design, code_review, implementation, testing, debugging, security_audit, documentation, api_design, database, devops, frontend, backend, e2e, integration, fast_iteration, ml

Guidelines:
- Match the most capable model to the hardest role (architecture > implementation > review)
- Use cheaper/faster models for mechanical work (testing, fast iteration)
- Local models are great for reviewer/tester roles (free, fast, private)
- Don't create more than 4-5 agents — diminishing returns
- Pick skills based on the tech stack the user mentions
- Each agent needs a unique ID in format: provider-short-name + role (e.g. claude-architect, gpt-implementer)

Respond ONLY with valid JSON in this exact format:
{
  "main_agent": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "reason": "Fast enough to route, smart enough to decompose tasks"
  },
  "agents": [
    {
      "id": "claude-architect",
      "provider": "anthropic",
      "model": "claude-opus-4-6",
      "preset": "architect",
      "skills": ["typescript", "nextjs", "system_design", "api_design"],
      "reason": "Complex architecture decisions need the most capable model"
    }
  ],
  "summary": "One-line description of this team setup"
}`;

// ── Main command ────────────────────────────────────────────────────────────
export async function createTeam(description?: string): Promise<void> {
  p.intro('  Create Agent Team');

  // ── Get description ─────────────────────────────────────────────────────
  if (!description) {
    const input = await p.text({
      message: 'Describe your project and what you need help with:',
      placeholder: 'e.g. "Building a Next.js + Supabase app. Need architecture, implementation, and code review. I have Anthropic and OpenAI keys."',
      validate: (v) => { if (!v?.trim() || v.trim().length < 10) return 'Tell me more about your project and needs (at least 10 characters)'; },
    });
    if (p.isCancel(input)) { p.cancel('Cancelled.'); process.exit(0); }
    description = input;
  }

  // ── Check available providers ───────────────────────────────────────────
  const keychain = new Keychain();
  const available: string[] = [];

  for (const provider of ['anthropic', 'openai', 'google']) {
    const key = await keychain.getKey(provider);
    if (key) available.push(provider);
  }

  // Check Ollama
  let ollamaModels: string[] = [];
  try {
    const res = await fetch('http://localhost:11434/api/tags');
    if (res.ok) {
      const data = await res.json() as any;
      ollamaModels = (data.models || []).map((m: any) => m.name);
      if (ollamaModels.length > 0) available.push('local');
    }
  } catch {}

  if (available.length === 0) {
    p.log.error('No API keys configured and no local models detected.');
    p.log.info('Run gossipcat setup to configure providers first.');
    p.outro('');
    return;
  }

  p.log.info(`Available providers: ${available.join(', ')}${ollamaModels.length > 0 ? ` (Ollama: ${ollamaModels.slice(0, 3).join(', ')})` : ''}`);

  // ── Pick an LLM to generate the team config ────────────────────────────
  const plannerProvider = available.includes('anthropic') ? 'anthropic'
    : available.includes('openai') ? 'openai'
    : available.includes('google') ? 'google'
    : null;

  if (!plannerProvider) {
    p.log.error('Need at least one cloud provider (Anthropic/OpenAI/Google) to generate a team plan.');
    p.log.info('Local models can be added as team members but cannot plan the team.');
    p.outro('');
    return;
  }

  const plannerKey = await keychain.getKey(plannerProvider);
  const plannerModel = plannerProvider === 'anthropic' ? 'claude-sonnet-4-6'
    : plannerProvider === 'openai' ? 'gpt-4o'
    : 'gemini-2.5-flash';

  // ── Generate team config via LLM ────────────────────────────────────────
  const s = p.spinner();
  s.start('Thinking about your ideal team...');

  let llm: ILLMProvider;
  let teamConfig: any;

  try {
    llm = createProvider(plannerProvider, plannerModel, plannerKey || undefined);

    const userPrompt = `Project description: ${description}

Available providers the user has configured: ${available.join(', ')}
${ollamaModels.length > 0 ? `Available local Ollama models: ${ollamaModels.join(', ')}` : 'No local models available.'}

Propose the optimal agent team for this project.`;

    const response = await llm.generate([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ], { temperature: 0 });

    s.stop('Team plan ready');

    // Parse JSON from response
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM did not return valid JSON');
    teamConfig = JSON.parse(jsonMatch[0]);

  } catch (err) {
    s.stop('Failed');
    p.log.error(`Failed to generate team: ${(err as Error).message}`);
    p.outro('Try gossipcat create-agent to add agents manually.');
    return;
  }

  // ── Display proposed team ───────────────────────────────────────────────
  const agents = teamConfig.agents || [];
  const mainAgent = teamConfig.main_agent;

  let teamDisplay = `Orchestrator: ${mainAgent.model} (${mainAgent.provider})`;
  if (mainAgent.reason) teamDisplay += `\n  ${mainAgent.reason}`;
  teamDisplay += '\n';

  for (const agent of agents) {
    teamDisplay += `\n${agent.id}`;
    teamDisplay += `\n  Provider: ${agent.provider}  Model: ${agent.model}`;
    teamDisplay += `\n  Role: ${agent.preset}  Skills: ${agent.skills.join(', ')}`;
    if (agent.reason) teamDisplay += `\n  Why: ${agent.reason}`;
  }

  if (teamConfig.summary) {
    teamDisplay += `\n\n${teamConfig.summary}`;
  }

  p.note(teamDisplay, `Proposed Team (${agents.length} agents)`);

  // ── Confirm ─────────────────────────────────────────────────────────────
  const action = await p.select({
    message: 'What do you want to do?',
    options: [
      { value: 'accept', label: 'Accept this team', hint: 'Create all agents and files' },
      { value: 'modify', label: 'Modify', hint: 'Describe what to change' },
      { value: 'cancel', label: 'Cancel' },
    ],
  });

  if (p.isCancel(action) || action === 'cancel') {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  if (action === 'modify') {
    const modification = await p.text({
      message: 'What would you like to change?',
      placeholder: 'e.g. "Add a debugger agent" or "Use cheaper models" or "Remove the tester"',
    });
    if (p.isCancel(modification)) { p.cancel('Cancelled.'); process.exit(0); }

    // Re-generate with modification
    const s2 = p.spinner();
    s2.start('Adjusting team...');

    try {
      const response = await llm!.generate([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Project description: ${description}\n\nAvailable providers: ${available.join(', ')}\n${ollamaModels.length > 0 ? `Ollama models: ${ollamaModels.join(', ')}` : ''}` },
        { role: 'assistant', content: JSON.stringify(teamConfig) },
        { role: 'user', content: `Modify the team: ${modification}` },
      ], { temperature: 0 });

      s2.stop('Updated');

      const jsonMatch = response.text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('LLM did not return valid JSON');
      teamConfig = JSON.parse(jsonMatch[0]);

      // Show updated team
      const updatedAgents = teamConfig.agents || [];
      let updatedDisplay = `Orchestrator: ${teamConfig.main_agent.model} (${teamConfig.main_agent.provider})\n`;
      for (const agent of updatedAgents) {
        updatedDisplay += `\n${agent.id}`;
        updatedDisplay += `\n  ${agent.provider} / ${agent.model} / ${agent.preset}`;
        updatedDisplay += `\n  Skills: ${agent.skills.join(', ')}`;
      }
      p.note(updatedDisplay, `Updated Team (${updatedAgents.length} agents)`);

      const confirm = await p.confirm({ message: 'Create this team?' });
      if (p.isCancel(confirm) || !confirm) { p.cancel('Cancelled.'); process.exit(0); }

    } catch (err) {
      s2.stop('Failed');
      p.log.error(`Modification failed: ${(err as Error).message}`);
      p.log.info('Proceeding with original team.');
    }
  }

  // ── Check API keys for all agents ───────────────────────────────────────
  for (const agent of teamConfig.agents) {
    if (agent.provider !== 'local' && !available.includes(agent.provider)) {
      p.log.warn(`Agent ${agent.id} uses ${agent.provider} but no API key is configured.`);

      const key = await p.password({
        message: `${agent.provider} API key:`,
        validate: (v) => { if (!v?.trim()) return 'Required for this agent'; },
      });
      if (p.isCancel(key)) { p.cancel('Cancelled.'); process.exit(0); }
      await keychain.setKey(agent.provider, key);
      p.log.success(`${agent.provider} key saved`);
    }
  }

  // ── Create everything ───────────────────────────────────────────────────
  const s3 = p.spinner();
  s3.start('Creating agent files...');

  // Build config
  const config: any = {
    main_agent: { provider: mainAgent.provider, model: mainAgent.model },
    agents: {} as Record<string, any>,
  };

  for (const agent of teamConfig.agents) {
    const agentConfig = {
      provider: agent.provider,
      model: agent.model,
      preset: agent.preset,
      skills: agent.skills || PRESET_SKILLS[agent.preset] || [],
    };
    config.agents[agent.id] = agentConfig;
    createAgentDirectory(agent.id, agentConfig);
  }

  // Write config
  const configPath = resolve(process.cwd(), 'gossip.agents.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  s3.stop('Team created');

  // ── Summary ─────────────────────────────────────────────────────────────
  p.log.success('gossip.agents.json updated');
  p.log.success(`${teamConfig.agents.length} agent directories created in .gossip/agents/`);

  for (const agent of teamConfig.agents) {
    p.log.info(`  .gossip/agents/${agent.id}/`);
  }

  p.outro('Run gossipcat to start chatting with your team!');
}
