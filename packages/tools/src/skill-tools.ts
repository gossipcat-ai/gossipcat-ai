import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface SuggestSkillArgs {
  skill_name: string;
  reason: string;
  task_context: string;
}

export interface GapSuggestion {
  type: 'suggestion';
  skill: string;
  reason: string;
  agent: string;
  task_context: string;
  timestamp: string;
}

export interface GapResolution {
  type: 'resolution';
  skill: string;
  skeleton_path: string;
  triggered_by: number;
  timestamp: string;
}

export type GapEntry = GapSuggestion | GapResolution;

export class SkillTools {
  private readonly gapLogPath: string;

  constructor(projectRoot: string) {
    const gossipDir = join(projectRoot, '.gossip');
    if (!existsSync(gossipDir)) {
      mkdirSync(gossipDir, { recursive: true });
    }
    this.gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  }

  async suggestSkill(args: SuggestSkillArgs, callerId?: string): Promise<string> {
    const entry: GapSuggestion = {
      type: 'suggestion',
      skill: args.skill_name,
      reason: args.reason,
      agent: callerId ?? 'unknown',
      task_context: args.task_context,
      timestamp: new Date().toISOString(),
    };

    appendFileSync(this.gapLogPath, JSON.stringify(entry) + '\n');

    return `Suggestion noted: '${args.skill_name}'. Continue with your current skills.`;
  }
}
