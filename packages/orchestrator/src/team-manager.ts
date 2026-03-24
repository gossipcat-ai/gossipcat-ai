/**
 * TeamManager — proposes and applies team changes (add/remove/modify agents),
 * detects skill gaps, and monitors scope drift.
 */

import { AgentConfig, ToolResult, TeamChangeAction } from './types';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface TeamManagerConfig {
  registry: any; // AgentRegistry — use any to avoid circular imports
  pipeline: any; // DispatchPipeline
  projectRoot: string;
}

export class TeamManager {
  private registry: any;
  private pipeline: any;
  private projectRoot: string;
  pendingAction: TeamChangeAction | null = null;

  constructor(config: TeamManagerConfig) {
    this.registry = config.registry;
    this.pipeline = config.pipeline;
    this.projectRoot = config.projectRoot;
  }

  proposeAdd(config: AgentConfig): ToolResult {
    this.pendingAction = { action: 'add', agentId: config.id, config };
    const skills = config.skills.join(', ');
    return {
      text: `Proposed: Add ${config.id} (${config.preset ?? config.model}, skills: ${skills})\n - [confirm_add] Add this agent\n - [cancel] Cancel`,
    };
  }

  proposeRemove(agentId: string): ToolResult {
    const agent = this.registry.get(agentId);
    if (!agent) return { text: `Error: agent '${agentId}' not found in registry.` };

    const activeTasks = this.pipeline?.getActiveTasks?.(agentId);
    if (activeTasks?.length) {
      this.pendingAction = { action: 'remove', agentId, reason: 'active_tasks' };
      return {
        text: `${agentId} has ${activeTasks.length} active tasks.\n - [wait_and_remove] Let tasks finish, then remove\n - [force_remove] Cancel tasks and remove now\n - [cancel] Keep agent`,
      };
    }

    this.pendingAction = { action: 'remove', agentId };
    return {
      text: `Remove ${agentId} from the team?\n - [confirm_remove] Remove\n - [cancel] Cancel`,
    };
  }

  proposeModify(agentId: string, changes: { skills?: string[]; preset?: string }): ToolResult {
    const agent = this.registry.get(agentId);
    if (!agent) return { text: `Error: agent '${agentId}' not found in registry.` };

    this.pendingAction = { action: 'modify', agentId, config: changes };
    const parts: string[] = [];
    if (changes.skills) parts.push(`skills: ${changes.skills.join(', ')}`);
    if (changes.preset) parts.push(`preset: ${changes.preset}`);
    return {
      text: `Proposed: Modify ${agentId} — ${parts.join('; ')}\n - [confirm_modify] Apply changes\n - [cancel] Cancel`,
    };
  }

  applyAdd(config: AgentConfig): void {
    this.registry.register(config);
    this.writeConfig();
    const dir = join(this.projectRoot, '.gossip', 'agents', config.id);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.pendingAction = null;
  }

  applyRemove(agentId: string): void {
    this.registry.unregister(agentId);
    this.writeConfig();
    this.pendingAction = null;
  }

  detectSkillGap(requiredSkill: string): ToolResult | null {
    const agents: AgentConfig[] = this.registry.getAll();
    if (agents.some((a: AgentConfig) => a.skills.includes(requiredSkill))) return null;
    return {
      text: `None of your agents have '${requiredSkill}' skills.\n - [suggest_add] Add a ${requiredSkill.replace(/_/g, '-')}-reviewer agent\n - [dispatch_anyway] Send to closest match\n - [skip] Skip`,
    };
  }

  detectScopeChange(conversationHistory: string[], projectDescription: string): ToolResult | null {
    const recent = conversationHistory.slice(-5);
    const extract = (text: string) =>
      text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const projWords = new Set(extract(projectDescription));
    const convWords = extract(recent.join(' '));
    if (convWords.length === 0 || projWords.size === 0) return null;
    const overlap = convWords.filter(w => projWords.has(w)).length;
    const ratio = overlap / convWords.length;
    if (ratio >= 0.3) return null;
    return {
      text: `Your project has expanded beyond '${projectDescription}'.\n - [re_evaluate] Propose updated team\n - [keep] Keep current team`,
    };
  }

  private writeConfig(): void {
    const configPath = join(this.projectRoot, '.gossip', 'config.json');
    let existing: any = {};
    if (existsSync(configPath)) {
      try { existing = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }
    }
    const agents: AgentConfig[] = this.registry.getAll();
    existing.agents = agents.map((a: AgentConfig) => ({
      id: a.id, provider: a.provider, model: a.model,
      ...(a.preset ? { preset: a.preset } : {}),
      skills: a.skills,
    }));
    const dir = join(this.projectRoot, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
  }
}
