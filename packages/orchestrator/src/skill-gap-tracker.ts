import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { normalizeSkillName } from './skill-name';

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

export interface GapData {
  skill: string;
  suggestions: GapSuggestion[];
  uniqueAgents: string[];
}

const MAX_LOG_LINES = 5000;
const TRUNCATE_TO = 1000;

export class SkillGapTracker {
  private readonly gapLogPath: string;
  private readonly resolutionsPath: string;
  private resolutionsCache: Record<string, string> | null = null;

  constructor(projectRoot: string) {
    this.gapLogPath = join(projectRoot, '.gossip', 'skill-gaps.jsonl');
    this.resolutionsPath = join(projectRoot, '.gossip', 'skill-resolutions.json');
    this.migrateResolutions();
  }

  checkThresholds(): { pending: string[]; count: number } {
    this.truncateIfNeeded();
    const pending = this.getPendingSkills();
    return { pending, count: pending.length };
  }

  isAtThreshold(skillName: string): boolean {
    const normalized = normalizeSkillName(skillName);
    const resolutions = this.loadResolutions();
    if (resolutions[normalized]) return false;
    const suggestions = this.getSuggestionsForSkill(normalized);
    const uniqueAgents = new Set(suggestions.map(s => s.agent));
    return suggestions.length >= 3 && uniqueAgents.size >= 2;
  }

  getGapData(skillNames: string[]): GapData[] {
    return skillNames.map(name => {
      const normalized = normalizeSkillName(name);
      const suggestions = this.getSuggestionsForSkill(normalized);
      const uniqueAgents = [...new Set(suggestions.map(s => s.agent))];
      return { skill: normalized, suggestions, uniqueAgents };
    });
  }

  recordResolution(skillName: string): void {
    const normalized = normalizeSkillName(skillName);
    const resolutions = this.loadResolutions();
    resolutions[normalized] = new Date().toISOString();
    const dir = join(this.resolutionsPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.resolutionsPath, JSON.stringify(resolutions, null, 2));
    this.resolutionsCache = resolutions;
  }

  getSuggestionsSince(agentId: string, sinceMs: number): GapSuggestion[] {
    return this.readSuggestions().filter(
      s => s.agent === agentId && new Date(s.timestamp).getTime() >= sinceMs
    );
  }

  appendSuggestion(suggestion: GapSuggestion): void {
    const dir = join(this.gapLogPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(this.gapLogPath, JSON.stringify(suggestion) + '\n');
    this.truncateIfNeeded();
  }

  private getPendingSkills(): string[] {
    const resolutions = this.loadResolutions();
    const suggestions = this.readSuggestions();
    const bySkill = new Map<string, GapSuggestion[]>();
    for (const s of suggestions) {
      const norm = normalizeSkillName(s.skill);
      if (resolutions[norm]) continue;
      if (!bySkill.has(norm)) bySkill.set(norm, []);
      bySkill.get(norm)!.push(s);
    }
    const pending: string[] = [];
    for (const [skill, entries] of bySkill) {
      const uniqueAgents = new Set(entries.map(e => e.agent));
      if (entries.length >= 3 && uniqueAgents.size >= 2) {
        pending.push(skill);
      }
    }
    return pending;
  }

  private getSuggestionsForSkill(normalizedName: string): GapSuggestion[] {
    return this.readSuggestions().filter(
      s => normalizeSkillName(s.skill) === normalizedName
    );
  }

  private readSuggestions(): GapSuggestion[] {
    if (!existsSync(this.gapLogPath)) return [];
    try {
      const lines = readFileSync(this.gapLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      return lines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter((e): e is GapSuggestion => e !== null && e.type === 'suggestion');
    } catch { return []; }
  }

  private loadResolutions(): Record<string, string> {
    if (this.resolutionsCache) return this.resolutionsCache;
    if (!existsSync(this.resolutionsPath)) {
      this.resolutionsCache = {};
      return this.resolutionsCache;
    }
    try {
      this.resolutionsCache = JSON.parse(readFileSync(this.resolutionsPath, 'utf-8'));
      return this.resolutionsCache!;
    } catch {
      this.resolutionsCache = {};
      return this.resolutionsCache;
    }
  }

  private migrateResolutions(): void {
    if (existsSync(this.resolutionsPath)) return;
    if (!existsSync(this.gapLogPath)) return;
    try {
      const lines = readFileSync(this.gapLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      const resolutions: Record<string, string> = {};
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'resolution') {
            resolutions[normalizeSkillName(entry.skill)] = entry.timestamp;
          }
        } catch { /* skip */ }
      }
      if (Object.keys(resolutions).length > 0) {
        const dir = join(this.resolutionsPath, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.resolutionsPath, JSON.stringify(resolutions, null, 2));
        this.resolutionsCache = resolutions;
      }
    } catch { /* best-effort */ }
  }

  private truncateIfNeeded(): void {
    if (!existsSync(this.gapLogPath)) return;
    try {
      const content = readFileSync(this.gapLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      if (lines.length > MAX_LOG_LINES) {
        writeFileSync(this.gapLogPath, lines.slice(-TRUNCATE_TO).join('\n') + '\n');
      }
    } catch { /* best-effort */ }
  }
}
