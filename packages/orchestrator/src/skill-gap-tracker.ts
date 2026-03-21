import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Types defined locally — no cross-package dependency on @gossip/tools.
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

const MAX_SCAN_LINES = 500;
const MAX_LOG_LINES = 5000;
const TRUNCATE_TO = 1000;

export class SkillGapTracker {
  private readonly gapLogPath: string;
  private readonly skillsDir: string;

  constructor(projectRoot: string) {
    this.gapLogPath = join(projectRoot, '.gossip', 'skill-gaps.jsonl');
    this.skillsDir = join(projectRoot, '.gossip', 'skills');
  }

  private readEntries(): GapEntry[] {
    if (!existsSync(this.gapLogPath)) return [];
    const content = readFileSync(this.gapLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-MAX_SCAN_LINES);
    return tail.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean) as GapEntry[];
  }

  getPendingSkills(): string[] {
    const entries = this.readEntries();
    const resolved = new Set(
      entries.filter(e => e.type === 'resolution').map(e => e.skill)
    );
    const suggestions = entries.filter(
      (e): e is GapSuggestion => e.type === 'suggestion' && !resolved.has(e.skill)
    );
    return [...new Set(suggestions.map(s => s.skill))];
  }

  shouldGenerate(skillName: string): boolean {
    const entries = this.readEntries();
    const resolved = entries.some(e => e.type === 'resolution' && e.skill === skillName);
    if (resolved) return false;

    const suggestions = entries.filter(
      (e): e is GapSuggestion => e.type === 'suggestion' && e.skill === skillName
    );
    const uniqueAgents = new Set(suggestions.map(e => e.agent));
    return suggestions.length >= 3 && uniqueAgents.size >= 2;
  }

  generateSkeleton(skillName: string): { generated: boolean; path?: string; message?: string } {
    if (!this.shouldGenerate(skillName)) {
      return { generated: false, message: `Threshold not met for '${skillName}'` };
    }

    const entries = this.readEntries();
    const suggestions = entries.filter(
      (e): e is GapSuggestion => e.type === 'suggestion' && e.skill === skillName
    );

    const seen = new Map<string, string>();
    for (const s of suggestions) {
      if (!seen.has(s.agent)) seen.set(s.agent, s.reason);
    }

    const fileName = skillName.replace(/_/g, '-') + '.md';
    mkdirSync(this.skillsDir, { recursive: true });
    const filePath = join(this.skillsDir, fileName);

    const suggestedBy = [...seen.entries()]
      .map(([agent, reason]) => `- ${agent}: "${reason}"`)
      .join('\n');

    const content = `# ${skillName}\n\n> Auto-generated from ${suggestions.length} agent suggestions. REVIEW AND EDIT BEFORE ASSIGNING TO AGENTS.\n\n## Suggested By\n${suggestedBy}\n\n## What You Do\n[TODO: Define what this skill covers]\n\n## Approach\n[TODO: Fill in your checklist — use the reasons above as starting points]\n\n## Output Format\n[TODO: Define expected output structure]\n\n## Don't\n[TODO: Add anti-patterns to avoid]\n`;

    writeFileSync(filePath, content);

    const resolution: GapResolution = {
      type: 'resolution',
      skill: skillName,
      skeleton_path: `.gossip/skills/${fileName}`,
      triggered_by: suggestions.length,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this.gapLogPath, JSON.stringify(resolution) + '\n');

    this.truncateIfNeeded();

    return {
      generated: true,
      path: filePath,
      message: `Created draft skill '${skillName}' based on ${suggestions.length} agent suggestions. Review at .gossip/skills/${fileName} before assigning to agents.`,
    };
  }

  getSuggestionsSince(agentId: string, sinceMs: number): GapSuggestion[] {
    return this.readEntries().filter(
      (e): e is GapSuggestion =>
        e.type === 'suggestion' &&
        e.agent === agentId &&
        new Date(e.timestamp).getTime() >= sinceMs
    );
  }

  checkAndGenerate(): string[] {
    const messages: string[] = [];
    for (const skill of this.getPendingSkills()) {
      const result = this.generateSkeleton(skill);
      if (result.generated && result.message) {
        messages.push(result.message);
      }
    }
    return messages;
  }

  private truncateIfNeeded(): void {
    if (!existsSync(this.gapLogPath)) return;
    const content = readFileSync(this.gapLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      writeFileSync(this.gapLogPath, lines.slice(-TRUNCATE_TO).join('\n') + '\n');
    }
  }
}
