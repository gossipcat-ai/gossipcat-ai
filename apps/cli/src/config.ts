import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { AgentConfig } from '@gossip/orchestrator';

export interface GossipConfig {
  main_agent: {
    provider: string;
    model: string;
  };
  agents?: Record<string, {
    provider: string;
    model: string;
    preset?: string;
    skills: string[];
  }>;
}

export function findConfigPath(projectRoot?: string): string | null {
  const root = projectRoot || process.cwd();
  const candidates = [
    resolve(root, '.gossip', 'config.json'),
    resolve(root, 'gossip.agents.json'),
    resolve(root, 'gossip.agents.yaml'),
    resolve(root, 'gossip.agents.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(configPath: string): GossipConfig {
  const raw = readFileSync(configPath, 'utf-8');

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse config at ${configPath}. Use JSON format for gossip.agents.json.`);
  }

  return validateConfig(parsed);
}

const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'local'];

export function validateConfig(raw: any): GossipConfig {
  if (!raw.main_agent) throw new Error('Config missing "main_agent" field');
  if (!raw.main_agent.provider) throw new Error('Config missing "main_agent.provider"');
  if (!raw.main_agent.model) throw new Error('Config missing "main_agent.model"');

  if (!VALID_PROVIDERS.includes(raw.main_agent.provider)) {
    throw new Error(
      `Invalid provider "${raw.main_agent.provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
    );
  }

  if (raw.agents) {
    for (const [id, agent] of Object.entries(raw.agents as Record<string, any>)) {
      if (!agent.provider) throw new Error(`Agent "${id}" missing provider`);
      if (!VALID_PROVIDERS.includes(agent.provider)) {
        throw new Error(`Agent "${id}" has invalid provider "${agent.provider}"`);
      }
      if (!agent.skills || !Array.isArray(agent.skills) || agent.skills.length === 0) {
        throw new Error(`Agent "${id}" must have at least one skill`);
      }
    }
  }

  return raw as GossipConfig;
}

export function configToAgentConfigs(config: GossipConfig): AgentConfig[] {
  return Object.entries(config.agents || {}).map(([id, agent]) => ({
    id,
    provider: agent.provider as AgentConfig['provider'],
    model: agent.model,
    preset: agent.preset,
    skills: agent.skills,
  }));
}
