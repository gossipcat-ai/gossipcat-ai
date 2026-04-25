import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { AgentConfig } from '@gossip/orchestrator';

export interface GossipConfig {
  main_agent: {
    provider: string;
    model: string;
  };
  utility_model?: {
    provider: string;
    model: string;
  };
  /**
   * Sandbox enforcement level for write-mode tasks.
   * - "off":   no prompt sanitization, no post-task audit
   * - "warn":  sanitize prompts, run audit, record signals, but accept results
   * - "block": sanitize prompts, run audit, reject results from tasks that
   *            wrote outside their declared scope/worktree boundary
   * Default: "warn"
   */
  sandboxEnforcement?: 'off' | 'warn' | 'block';
  /**
   * Consensus-engine configuration. Issue #126 / PR-B.
   */
  consensus?: {
    /**
     * When true, ConsensusEngine calls `git worktree list -z --porcelain`
     * once per round() and merges all passing paths through
     * validateResolutionRoot alongside explicit resolutionRoots. Default
     * false (no behavior change for default installs).
     */
    autoDiscoverWorktrees?: boolean;
  };
  agents?: Record<string, {
    provider: string;
    model: string;
    preset?: string;
    skills: string[];
    native?: boolean;
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
    throw new Error(`Failed to parse config at ${configPath}. The gossipcat config file must be valid JSON (tried .gossip/config.json and gossip.agents.json legacy path).`);
  }

  return validateConfig(parsed);
}

// Keep this list aligned with the `main_provider` Zod enum in
// apps/cli/src/mcp-server-sdk.ts (around the gossip_setup tool definition).
// "none" is the documented zero-config token on Claude Code host — see the
// describe() string on the Zod enum and the `provider === 'none'` branch in
// the orchestrator-bootstrap path that prints "Native Claude Code orchestration
// enabled". Drift between these two lists means some values pass schema but
// fail validateConfig (or vice versa) — that is a hard-to-diagnose user-facing
// bug. If you change one, change the other.
const VALID_PROVIDERS = ['anthropic', 'openai', 'openclaw', 'google', 'local', 'native', 'none'];

const CLAUDE_MODEL_MAP: Record<string, { provider: string; model: string }> = {
  opus:   { provider: 'anthropic', model: 'claude-opus-4-6' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  haiku:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

export function validateConfig(raw: any): GossipConfig {
  if (!raw.main_agent) throw new Error('Config missing "main_agent" field');
  if (!raw.main_agent.provider) throw new Error('Config missing "main_agent.provider"');
  if (!raw.main_agent.model) throw new Error('Config missing "main_agent.model"');

  if (!VALID_PROVIDERS.includes(raw.main_agent.provider)) {
    throw new Error(
      `Invalid provider "${raw.main_agent.provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
    );
  }

  if (raw.consensus !== undefined) {
    if (typeof raw.consensus !== 'object' || raw.consensus === null) {
      throw new Error('Config "consensus" must be an object');
    }
    if (
      raw.consensus.autoDiscoverWorktrees !== undefined &&
      typeof raw.consensus.autoDiscoverWorktrees !== 'boolean'
    ) {
      throw new Error('Config "consensus.autoDiscoverWorktrees" must be a boolean');
    }
  }

  if (raw.sandboxEnforcement !== undefined) {
    const valid = ['off', 'warn', 'block'];
    if (!valid.includes(raw.sandboxEnforcement)) {
      throw new Error(
        `Invalid sandboxEnforcement "${raw.sandboxEnforcement}". Must be one of: ${valid.join(', ')}`
      );
    }
  }

  if (raw.utility_model) {
    if (!raw.utility_model.provider) throw new Error('Config "utility_model" missing provider');
    if (!raw.utility_model.model) throw new Error('Config "utility_model" missing model');
    if (!VALID_PROVIDERS.includes(raw.utility_model.provider)) {
      throw new Error(
        `Invalid utility_model provider "${raw.utility_model.provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
      );
    }
    if (raw.utility_model.provider === 'native') {
      const validNativeModels = Object.keys(CLAUDE_MODEL_MAP);
      if (!validNativeModels.includes(raw.utility_model.model)) {
        throw new Error(
          `Invalid native utility_model model "${raw.utility_model.model}". Must be one of: ${validNativeModels.join(', ')}`
        );
      }
    }
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
      if (agent.base_url) {
        try {
          const { protocol } = new URL(agent.base_url);
          if (protocol !== 'http:' && protocol !== 'https:') {
            throw new Error(`Agent "${id}" base_url must use http or https scheme`);
          }
        } catch (e: any) {
          if (e.message.includes(id)) throw e;
          throw new Error(`Agent "${id}" has invalid base_url: ${agent.base_url}`);
        }
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
    native: agent.native,
  }));
}

// ── Claude Code subagent loading ─────────────────────────────────────────

export interface ClaudeSubagent {
  id: string;
  name: string;
  provider: string;
  model: string;
  description: string;
  instructions: string;
  source: string; // file path
}

/**
 * Load Claude Code subagent definitions from .claude/agents/*.md.
 * Returns agent configs + full instructions for each.
 * Skips agents whose IDs already exist in `existingIds` to avoid duplicates.
 */
export function loadClaudeSubagents(projectRoot?: string, existingIds?: Set<string>): ClaudeSubagent[] {
  const root = projectRoot || process.cwd();
  const agentsDir = join(root, '.claude', 'agents');

  if (!existsSync(agentsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }

  const agents: ClaudeSubagent[] = [];
  for (const file of files) {
    const filePath = join(agentsDir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter) continue;

      const fm = frontmatter[1];
      const name = fm.match(/^name:\s*(.+)/m)?.[1]?.trim();
      const modelKey = fm.match(/^model:\s*(.+)/m)?.[1]?.trim()?.toLowerCase();
      const description = fm.match(/^description:\s*(.+)/m)?.[1]?.trim() || '';

      if (!name || !modelKey) continue;

      const mapped = CLAUDE_MODEL_MAP[modelKey];
      if (!mapped) {
        process.stderr.write(`[gossipcat] Skipping .claude/agents/${file}: unknown model "${modelKey}" (expected: opus, sonnet, haiku)\n`);
        continue;
      }

      const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      if (existingIds?.has(id)) continue;

      // Instructions = everything after the frontmatter
      const instructions = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();

      agents.push({
        id,
        name,
        provider: mapped.provider,
        model: mapped.model,
        description,
        instructions,
        source: filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return agents;
}

/** Convert Claude subagents to gossipcat AgentConfig format */
export function claudeSubagentsToConfigs(subagents: ClaudeSubagent[]): AgentConfig[] {
  return subagents.map(sa => ({
    id: sa.id,
    provider: sa.provider as AgentConfig['provider'],
    model: sa.model,
    role: sa.description || sa.name,
    skills: inferSkills(sa.description, sa.name),
    native: true,
  }));
}

export function inferSkills(description: string, name: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const skills: string[] = [];
  if (/prompt|llm|ai|agent/.test(text)) skills.push('prompt_engineering');
  if (/security|vulnerab|owasp/.test(text)) skills.push('security_audit');
  if (/review|audit|code quality/.test(text)) skills.push('code_review');
  if (/test|qa/.test(text)) skills.push('testing');
  if (/typescript|ts\b/.test(text)) skills.push('typescript');
  if (/react|frontend|ui/.test(text)) skills.push('frontend');
  if (/backend|api|server/.test(text)) skills.push('backend');
  if (/architect/.test(text)) skills.push('architecture');
  // Always add a general skill
  if (skills.length === 0) skills.push('general');
  return skills;
}
