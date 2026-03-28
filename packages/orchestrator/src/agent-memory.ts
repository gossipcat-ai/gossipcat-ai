import { readFileSync, readdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

export class AgentMemoryReader {
  constructor(private projectRoot: string) {}

  loadMemory(agentId: string, taskText: string): string | null {
    const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
    const indexPath = join(memDir, 'MEMORY.md');

    if (!existsSync(indexPath)) return null;

    const parts: string[] = [];
    // Cap MEMORY.md to first 200 lines (matching Claude Code's limit)
    const indexContent = readFileSync(indexPath, 'utf-8');
    const indexLines = indexContent.split('\n');
    parts.push(indexLines.length > 200 ? indexLines.slice(0, 200).join('\n') + '\n[Truncated]' : indexContent);

    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      const files = this.selectKnowledgeFiles(knowledgeDir, taskText);
      for (const file of files) {
        let content = readFileSync(file.path, 'utf-8');
        // Sanitize: strip potential prompt injection delimiters from agent-generated memory
        content = content.replace(/<\/?(?:agent-memory|system|instructions)>/gi, '');
        parts.push(`<agent-memory>\n${content}\n</agent-memory>`);
        this.touchKnowledgeFile(file.path, content);
      }
    }

    const calPath = join(memDir, 'calibration', 'accuracy.md');
    if (existsSync(calPath)) {
      parts.push(readFileSync(calPath, 'utf-8'));
    }

    return parts.join('\n\n');
  }

  private selectKnowledgeFiles(knowledgeDir: string, taskText: string): Array<{ path: string; score: number }> {
    const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
    const scored: Array<{ path: string; score: number }> = [];
    const lower = taskText.toLowerCase();

    for (const file of files) {
      const filePath = join(knowledgeDir, file);
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = this.parseFrontmatter(content);

      if (frontmatter) {
        // File with frontmatter: score by warmth × relevance
        const warmth = this.calculateWarmth(frontmatter.importance, frontmatter.lastAccessed);
        const relevance = this.calculateRelevance(frontmatter.description, lower);
        if (relevance > 0) {
          scored.push({ path: filePath, score: warmth * relevance });
        }
      } else {
        // Agent-written file without frontmatter: score by content relevance
        // These are plain .md files written by agents managing their own memory
        const relevance = this.calculateRelevance(content.slice(0, 500), lower);
        // Always include recent agent-written files (high base score)
        scored.push({ path: filePath, score: Math.max(relevance, 0.3) });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  calculateWarmth(importance: number, lastAccessed: string): number {
    const days = (Date.now() - new Date(lastAccessed).getTime()) / 86400000;
    return importance * (1 / (1 + days / 30));
  }

  private calculateRelevance(description: string, taskLower: string): number {
    const descWords = description.toLowerCase().split(/[\s,/.]+/).filter(w => w.length > 2);
    if (descWords.length === 0) return 0;

    const taskWords = new Set(taskLower.split(/[\s,/.]+/).filter(w => w.length > 2));

    // Count matches: either exact word match or substring containment (for compound terms)
    let matches = 0;
    for (const w of descWords) {
      if (taskWords.has(w) || taskLower.includes(w)) matches++;
    }

    // Bonus: if description mentions a file extension present in the task, boost relevance
    const descExts: string[] = description.match(/\.\w{1,5}/g) || [];
    const taskExts: string[] = taskLower.match(/\.\w{1,5}/g) || [];
    if (descExts.some(e => taskExts.includes(e))) matches += 1;

    return Math.min(matches / descWords.length, 1.0);
  }

  private parseFrontmatter(content: string): { name: string; description: string; importance: number; lastAccessed: string; accessCount: number } | null {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const lines = match[1].split('\n');
    const obj: Record<string, string> = {};
    for (const line of lines) {
      const [key, ...rest] = line.split(':');
      if (key && rest.length) obj[key.trim()] = rest.join(':').trim();
    }
    return {
      name: obj.name || '',
      description: obj.description || '',
      importance: parseFloat(obj.importance) || 0.5,
      lastAccessed: obj.lastAccessed || new Date().toISOString(),
      accessCount: parseInt(obj.accessCount) || 0,
    };
  }

  private touchKnowledgeFile(filePath: string, content: string): void {
    const today = new Date().toISOString().split('T')[0];
    let updated = content.replace(/lastAccessed:.*/, `lastAccessed: ${today}`);
    const countMatch = updated.match(/accessCount:\s*(\d+)/);
    if (countMatch) {
      const newCount = parseInt(countMatch[1]) + 1;
      updated = updated.replace(/accessCount:\s*\d+/, `accessCount: ${newCount}`);
    }
    writeFileSync(filePath, updated);
  }
}
