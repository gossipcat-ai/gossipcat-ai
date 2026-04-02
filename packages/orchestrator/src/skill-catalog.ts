import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import { normalizeSkillName } from './skill-name';
import { parseSkillFrontmatter } from './skill-parser';

export interface CatalogEntry {
  name: string;
  description: string;
  keywords: string[];
  categories: string[];
  source: 'default' | 'project';
}

interface CatalogData {
  version: number;
  skills: Array<{
    name: string;
    description: string;
    keywords: string[];
    categories: string[];
  }>;
}

export class SkillCatalog {
  private entries: CatalogEntry[] = [];
  private readonly defaultSkillsDir: string;
  private readonly projectSkillsDir: string | null;
  private projectFileMtimes: Map<string, number> = new Map();

  constructor(projectRoot?: string, catalogPath?: string) {
    const defaultPath = catalogPath || resolve(__dirname, 'default-skills', 'catalog.json');
    this.defaultSkillsDir = resolve(__dirname, 'default-skills');
    this.projectSkillsDir = projectRoot ? join(projectRoot, '.gossip', 'skills') : null;

    try {
      const raw = readFileSync(defaultPath, 'utf-8');
      const data: CatalogData = JSON.parse(raw);
      this.entries = data.skills.map(s => ({
        ...s,
        name: normalizeSkillName(s.name),
        source: 'default' as const,
      }));
    } catch { /* no default catalog */ }

    this.loadProjectSkills();
  }

  listSkills(): CatalogEntry[] {
    this.reloadIfChanged();
    return [...this.entries];
  }

  matchTask(taskText: string): CatalogEntry[] {
    this.reloadIfChanged();
    const lower = taskText.toLowerCase();
    return this.entries.filter(entry => {
      if ((entry as any)._status === 'disabled') return false;
      return entry.keywords.some(kw => {
        const escaped = kw.toLowerCase().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`).test(lower);
      });
    });
  }

  checkCoverage(agentSkills: string[], taskText: string): string[] {
    const normalizedAgentSkills = agentSkills.map(normalizeSkillName);
    const matched = this.matchTask(taskText);
    const warnings: string[] = [];
    for (const entry of matched) {
      if (!normalizedAgentSkills.includes(entry.name)) {
        warnings.push(
          `Skill '${entry.name}' (${entry.description}) may be relevant but is not assigned to this agent.`
        );
      }
    }
    return warnings;
  }

  validate(): string[] {
    const issues: string[] = [];
    const mdFiles = readdirSync(this.defaultSkillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => normalizeSkillName(f.replace('.md', '')));

    for (const file of mdFiles) {
      if (!this.entries.find(e => e.name === file)) {
        issues.push(`Skill file '${file}' has no catalog entry`);
      }
    }
    return issues;
  }

  private loadProjectSkills(): void {
    if (!this.projectSkillsDir || !existsSync(this.projectSkillsDir)) return;

    const files = readdirSync(this.projectSkillsDir).filter(f => f.endsWith('.md'));
    const newMtimes = new Map<string, number>();

    for (const file of files) {
      const filePath = join(this.projectSkillsDir, file);
      try {
        const mtime = statSync(filePath).mtimeMs;
        newMtimes.set(file, mtime);
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseSkillFrontmatter(content);
        if (!fm) continue;

        const entry: CatalogEntry & { _status?: string } = {
          name: normalizeSkillName(fm.name),
          description: fm.description,
          keywords: fm.keywords,
          categories: [],
          source: 'project',
        };
        (entry as any)._status = fm.status;

        // Remove default entry with same name (project overrides)
        this.entries = this.entries.filter(e => !(e.name === entry.name && e.source === 'default'));
        // Remove old project entry with same name
        this.entries = this.entries.filter(e => !(e.name === entry.name && e.source === 'project'));
        if (fm.status !== 'disabled') {
          this.entries.push(entry);
        }
      } catch { /* skip malformed files */ }
    }
    this.projectFileMtimes = newMtimes;
  }

  private reloadIfChanged(): void {
    if (!this.projectSkillsDir || !existsSync(this.projectSkillsDir)) return;

    const files = readdirSync(this.projectSkillsDir).filter(f => f.endsWith('.md'));
    let changed = files.length !== this.projectFileMtimes.size;
    if (!changed) {
      for (const file of files) {
        const filePath = join(this.projectSkillsDir, file);
        try {
          const mtime = statSync(filePath).mtimeMs;
          if (mtime !== this.projectFileMtimes.get(file)) {
            changed = true;
            break;
          }
        } catch { changed = true; break; }
      }
    }

    if (changed) {
      this.entries = this.entries.filter(e => e.source === 'default');
      this.loadProjectSkills();
    }
  }
}
