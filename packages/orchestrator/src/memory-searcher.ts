import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { loadIndex, tokenize, corpusDir } from './memory-index-sidecar';
import { rankDocuments } from './memory-index-bm25';

const MAX_QUERY_LENGTH = 500;
const MAX_KEYWORDS = 20;
const MAX_TASK_FILE_BYTES = 2 * 1024 * 1024; // 2MB

export interface SearchResult {
  source: string;
  name: string;
  description: string;
  score: number;
  snippets: string[];
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  importance: number;
}

export class MemorySearcher {
  constructor(private projectRoot: string) {}

  /**
   * Search the public auto-memory corpus using BM25 via the sidecar index.
   *
   * The sidecar index lives at <projectRoot>/.gossip/memory-index.json.
   * `loadIndex` performs an incremental rebuild if any corpus *.md file has a
   * newer mtime than the stored entry — this is the lazy rebuild trigger.
   */
  private searchCorpus(query: string, maxResults: number): SearchResult[] {
    const safeQuery = query.slice(0, MAX_QUERY_LENGTH);
    const terms = Array.from(new Set(tokenize(safeQuery)));
    if (terms.length === 0) return [];

    // loadIndex: lazy incremental rebuild if any source mtime > index mtime.
    const index = loadIndex(this.projectRoot);
    if (index.totalDocs === 0) return [];

    const ranked = rankDocuments(terms, index, { openBoost: 0 });
    const limit = Math.min(maxResults, 10);

    return ranked.slice(0, limit).map(({ filename, score }) => {
      const doc = index.docs[filename]!;
      // Reconstruct snippets from the corpus file body (best-effort; never blocks search)
      let snippets: string[] = [];
      try {
        const corpus = corpusDir(this.projectRoot);
        const content = readFileSync(join(corpus, filename), 'utf-8');
        const body = content.replace(/^---[\s\S]*?\n---\n*/m, '');
        // Reuse keyword-based snippet extraction with the tokenized terms
        snippets = this.extractSnippets(body, terms);
      } catch { /* skip — sidecar result still returned without snippets */ }

      return {
        source: filename,
        name: doc.name,
        description: doc.description ?? '',
        score,
        snippets,
      };
    });
  }

  search(agentId: string, query: string, maxResults = 3): SearchResult[] {
    if (!query || !query.trim()) return [];

    // Validate agentId to prevent path traversal (defense-in-depth; MCP handler also validates)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) return [];

    // Cap query length to prevent DoS via keyword extraction
    const safeQuery = query.slice(0, MAX_QUERY_LENGTH);

    // The _project sentinel searches the shared auto-memory corpus via BM25 sidecar.
    // loadIndex inside searchCorpus handles lazy incremental rebuild when any
    // corpus *.md mtime advances past the stored index entry mtime.
    if (agentId === '_project') {
      return this.searchCorpus(query, maxResults);
    }

    const limit = Math.min(maxResults, 10);
    const keywords = this.extractKeywords(safeQuery);
    if (keywords.length === 0) return [];

    const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
    if (!existsSync(memDir)) return [];

    const results: SearchResult[] = [];

    // Search knowledge .md files
    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = join(knowledgeDir, file);
        try {
          const content = readFileSync(filePath, 'utf-8');
          const frontmatter = this.parseFrontmatter(content);
          const body = content.replace(/^---[\s\S]*?---\n*/, '');

          // Regression baseline: files with no frontmatter still appear, name falls back to basename.
          const name = frontmatter?.name || basename(file, '.md');
          const description = frontmatter?.description || '';
          const importance = frontmatter?.importance ?? 0.5;

          const score = this.scoreContent(keywords, name, description, body, importance);
          if (score > 0) {
            results.push({
              source: file,
              name,
              description,
              score,
              snippets: this.extractSnippets(body, keywords),
            });
          }
        } catch {
          // skip inaccessible files
        }
      }
    }

    // Search tasks.jsonl (with size guard to prevent event-loop stall)
    const tasksPath = join(memDir, 'tasks.jsonl');
    if (existsSync(tasksPath)) {
      try {
        const stat = statSync(tasksPath);
        if (stat.size > MAX_TASK_FILE_BYTES) return results.sort((a, b) => b.score - a.score).slice(0, limit);
        const lines = readFileSync(tasksPath, 'utf-8').split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as { taskId?: string; task?: string; skills?: string[] };
            const taskText = entry.task || '';
            const skillsText = (entry.skills || []).join(' ');
            const combined = `${taskText} ${skillsText}`;
            const score = this.scoreTaskEntry(keywords, taskText, skillsText);
            if (score > 0) {
              results.push({
                source: 'tasks.jsonl',
                name: entry.taskId || 'task',
                description: taskText.slice(0, 120),
                score,
                snippets: this.extractSnippets(combined, keywords),
              });
            }
          } catch {
            // skip malformed lines
          }
        }
      } catch {
        // skip inaccessible tasks file
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private extractKeywords(query: string): string[] {
    const words = query.toLowerCase().split(/\s+/);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const word of words) {
      const clean = word.replace(/[^a-z0-9]/g, '');
      if (clean.length > 3 && !seen.has(clean)) {
        seen.add(clean);
        result.push(clean);
      }
      if (result.length >= MAX_KEYWORDS) break;
    }
    return result;
  }

  private scoreContent(
    keywords: string[],
    name: string,
    description: string,
    body: string,
    importance: number,
  ): number {
    const nameLower = name.toLowerCase();
    const descLower = description.toLowerCase();
    const bodyLower = body.toLowerCase();

    let score = 0;
    for (const kw of keywords) {
      if (nameLower.includes(kw)) score += 3;
      if (descLower.includes(kw)) score += 2;
      // body match capped at 5 per keyword
      let bodyCount = 0;
      let idx = 0;
      while (bodyCount < 5 && (idx = bodyLower.indexOf(kw, idx)) !== -1) {
        bodyCount++;
        score += 1;
        idx += kw.length;
      }
    }

    return score > 0 ? score * importance : 0;
  }

  private scoreTaskEntry(keywords: string[], task: string, skills: string): number {
    const taskLower = task.toLowerCase();
    const skillsLower = skills.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (taskLower.includes(kw)) score += 3;
      if (skillsLower.includes(kw)) score += 2;
    }
    return score;
  }

  private extractSnippets(body: string, keywords: string[]): string[] {
    const lines = body.split('\n');
    const bodyLower = body.toLowerCase();
    const snippets: string[] = [];
    const seen = new Set<number>();

    // Precompute line start offsets to avoid O(n²) string splitting
    const lineStarts: number[] = [0];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\n') lineStarts.push(i + 1);
    }

    for (const kw of keywords) {
      let idx = 0;
      while (snippets.length < 3 && (idx = bodyLower.indexOf(kw, idx)) !== -1) {
        // Binary search for the line containing this offset
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
        }
        const lineIdx = lo;

        if (!seen.has(lineIdx)) {
          const line = lines[lineIdx]?.trim();
          if (line && line.length > 0) {
            seen.add(lineIdx);
            snippets.push(line);
          }
        }
        idx += kw.length;
        if (snippets.length >= 3) break;
      }
      if (snippets.length >= 3) break;
    }

    return snippets;
  }

  private parseFrontmatter(content: string): ParsedFrontmatter | null {
    // Normalize CRLF to LF for cross-platform compatibility
    const normalized = content.replace(/\r\n/g, '\n');
    const match = normalized.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;
    const lines = match[1].split('\n');
    const obj: Record<string, string> = {};
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      obj[key] = value;
    }
    const rawImportance = obj.importance !== undefined ? parseFloat(obj.importance) : NaN;
    const importance = Number.isNaN(rawImportance) ? 0.5 : Math.max(0, Math.min(1, rawImportance));
    return {
      name: obj.name || '',
      description: obj.description || '',
      importance,
    };
  }
}
