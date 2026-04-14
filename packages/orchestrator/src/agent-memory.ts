import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

const FINDINGS_MAX_RESULTS = 3;
const FINDINGS_MAX_CHARS = 150;
const FINDINGS_STALE_DAYS = 30;
const FINDINGS_MIN_SCORE = 1;

export class AgentMemoryReader {
  constructor(private projectRoot: string) {}

  loadMemory(agentId: string, taskText: string): string | null {
    if (!agentId || /[/\\.\0]/.test(agentId)) return null;
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
        // Touch files with moderate+ relevance to track access patterns
        if (file.score > 0.3) {
          this.touchKnowledgeFile(file.path, content);
        }
      }
    }

    // Load shared project knowledge (cross-agent context)
    const projectKnowledgeDir = join(this.projectRoot, '.gossip', 'agents', '_project', 'memory', 'knowledge');
    if (existsSync(projectKnowledgeDir)) {
      const projectFiles = this.selectKnowledgeFiles(projectKnowledgeDir, taskText, 3);
      for (const file of projectFiles) {
        let content = readFileSync(file.path, 'utf-8');
        content = content.replace(/<\/?(?:agent-memory|system|instructions)>/gi, '');
        parts.push(`<project-context>\n${content}\n</project-context>`);
        if (file.score > 0.3) {
          this.touchKnowledgeFile(file.path, content);
        }
      }
    }

    const calPath = join(memDir, 'calibration', 'accuracy.md');
    if (existsSync(calPath)) {
      parts.push(readFileSync(calPath, 'utf-8'));
    }

    return parts.join('\n\n');
  }

  /**
   * Pre-fetch relevant consensus findings from implementation-findings.jsonl.
   * Returns top-N findings as short text snippets, capped at FINDINGS_MAX_CHARS each.
   * Skips findings older than FINDINGS_STALE_DAYS. Returns [] when file absent or no matches.
   * Latency: <10ms (one synchronous file read, no LLM calls).
   */
  prefetchConsensusFindingsText(taskText: string): string[] {
    const findingsPath = join(this.projectRoot, '.gossip', 'implementation-findings.jsonl');
    if (!existsSync(findingsPath)) return [];

    let raw: string;
    try {
      raw = readFileSync(findingsPath, 'utf-8');
    } catch {
      return [];
    }

    const keywords = this.extractKeywords(taskText);
    if (keywords.length === 0) return [];

    const cutoffMs = Date.now() - FINDINGS_STALE_DAYS * 86_400_000;
    const scored: Array<{ text: string; score: number }> = [];

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      // Only include peer-confirmed findings (74% of corpus)
      const confirmed = entry.confirmedBy;
      if (!Array.isArray(confirmed) || confirmed.length === 0) continue;

      // Age filter — require timestamp field
      const ts = entry.timestamp;
      if (ts) {
        const ms = typeof ts === 'number' ? ts : new Date(ts as string).getTime();
        if (!isNaN(ms) && ms < cutoffMs) continue;
      }

      // Build searchable text from common finding fields
      const body = [
        entry.finding,
        entry.description,
        entry.text,
        entry.summary,
        entry.task,
      ]
        .filter(Boolean)
        .join(' ');

      if (!body) continue;

      const score = this.scoreKeywords(keywords, body);
      if (score >= FINDINGS_MIN_SCORE) {
        const snippet = body.slice(0, FINDINGS_MAX_CHARS).replace(/\s+/g, ' ').trim();
        scored.push({ text: snippet, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, FINDINGS_MAX_RESULTS)
      .map(s => s.text);
  }

  /** Simple word-boundary keyword overlap scoring (no LLM). */
  private extractKeywords(taskText: string): string[] {
    // Split on whitespace, punctuation, and markdown/code emphasis markers so
    // `**bold**`, `_italic_`, and `` `code` `` yield the inner word alone,
    // not leaking asterisks/underscores/backticks into the keyword token.
    const words = taskText.toLowerCase().split(/[\s,/.;:!?()\[\]{}*_~`"'<>|]+/);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const w of words) {
      if (w.length > 3 && !seen.has(w)) {
        seen.add(w);
        result.push(w);
      }
    }
    return result;
  }

  private scoreKeywords(keywords: string[], text: string): number {
    const lower = text.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      // Word-boundary match (whole word = 2 pts, substring = 1 pt).
      // Escape regex metacharacters — keywords come from untrusted task text,
      // so a token containing '**', '(', '[' etc. (e.g. markdown `**bold**`
      // leaking through the split) would throw "Invalid regular expression"
      // and crash the whole task dispatch.
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`);
      if (re.test(lower)) score += 2;
      else if (lower.includes(kw)) score += 1;
    }
    return score;
  }

  private selectKnowledgeFiles(knowledgeDir: string, taskText: string, maxFiles = 5): Array<{ path: string; score: number }> {
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
        // Also score body content (first 200 chars after frontmatter)
        const bodyStart = content.replace(/^---[\s\S]*?---\n*/, '').slice(0, 200).toLowerCase();
        const bodyRelevance = this.calculateRelevance(bodyStart, lower);
        const combinedRelevance = relevance * 0.7 + bodyRelevance * 0.3;
        if (combinedRelevance > 0) {
          scored.push({ path: filePath, score: warmth * combinedRelevance });
        }
      } else {
        // Agent-written file without frontmatter: score by content relevance
        // These are plain .md files written by agents managing their own memory
        const relevance = this.calculateRelevance(content.slice(0, 500), lower);
        // Always include recent agent-written files (high base score)
        // Apply age-based decay to unindexed files using filesystem mtime
        try {
          const mtime = statSync(filePath).mtimeMs;
          const ageDays = (Date.now() - mtime) / 86400000;
          const ageFactor = 1 / (1 + ageDays / 30);
          scored.push({ path: filePath, score: Math.max(relevance * ageFactor, 0.05) });
        } catch {
          scored.push({ path: filePath, score: relevance });
        }
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, maxFiles);
  }

  calculateWarmth(importance: number, lastAccessed: string): number {
    const days = Math.max(0, (Date.now() - new Date(lastAccessed).getTime()) / 86400000);
    return importance * (1 / (1 + days / 30));
  }

  private calculateRelevance(description: string, taskLower: string): number {
    const descWords = description.toLowerCase().split(/[\s,/.]+/).filter(w => w.length > 3);
    if (descWords.length === 0) return 0;

    const taskWords = new Set(taskLower.split(/[\s,/.]+/).filter(w => w.length > 3));

    // Count matches: exact word match scores full, substring containment scores half
    let matches = 0;
    for (const w of descWords) {
        if (taskWords.has(w)) { matches += 1.0; }
        else if (taskLower.includes(w)) { matches += 0.5; }
    }

    // Bonus: if description mentions a file extension present in the task, boost relevance
    const descExts: string[] = description.match(/\.\w{1,5}/g) || [];
    const taskExts: string[] = taskLower.match(/\.\w{1,5}/g) || [];
    if (descExts.some(e => taskExts.includes(e))) matches += 1;

    // Normalize by the smaller word count so verbose descriptions aren't penalized
    const denominator = Math.min(descWords.length, taskWords.size) || 1;
    return Math.min(matches / denominator, 1.0);
  }

  private parseFrontmatter(content: string): { name: string; description: string; importance: number; lastAccessed: string; accessCount: number; status?: string } | null {
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
      ...(obj.status ? { status: obj.status } : {}),
    };
  }

  private touchKnowledgeFile(filePath: string, content: string): void {
    const today = new Date().toISOString().split('T')[0];
    // Only modify frontmatter (between --- delimiters) to avoid corrupting body content
    // that might contain strings like "lastAccessed:" or "accessCount:"
    const fmEnd = content.indexOf('\n---', 4); // skip opening ---
    if (fmEnd < 0) { writeFileSync(filePath, content); return; }
    let frontmatter = content.slice(0, fmEnd);
    const body = content.slice(fmEnd);
    frontmatter = frontmatter.replace(/lastAccessed:.*/, `lastAccessed: ${today}`);
    const countMatch = frontmatter.match(/accessCount:\s*(\d+)/);
    if (countMatch) {
      const newCount = parseInt(countMatch[1]) + 1;
      frontmatter = frontmatter.replace(/accessCount:\s*\d+/, `accessCount: ${newCount}`);
    }
    writeFileSync(filePath, frontmatter + body);
  }
}
