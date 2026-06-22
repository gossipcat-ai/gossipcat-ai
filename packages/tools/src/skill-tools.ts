import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

    // Truncate if log has grown too large (>5000 lines → keep 1000)
    this.truncateIfNeeded();

    return `Suggestion noted: '${args.skill_name}'. Continue with your current skills.`;
  }

  private truncateIfNeeded(): void {
    try {
      const content = readFileSync(this.gapLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length > 5000) {
        writeFileSync(this.gapLogPath, lines.slice(-1000).join('\n') + '\n');
      }
    } catch { /* best-effort */ }
  }
}
