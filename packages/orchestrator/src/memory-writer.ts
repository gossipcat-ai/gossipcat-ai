import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry } from './types';

/** Truncate text at a word boundary, appending "..." if truncated */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

export class MemoryWriter {
  constructor(private projectRoot: string) {}

  private getMemDir(agentId: string): string {
    return join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
  }

  private ensureDirs(agentId: string): string {
    const memDir = this.getMemDir(agentId);
    mkdirSync(join(memDir, 'knowledge'), { recursive: true });
    mkdirSync(join(memDir, 'calibration'), { recursive: true });
    return memDir;
  }

  async writeTaskEntry(agentId: string, data: {
    taskId: string;
    task: string;
    skills: string[];
    scores: { relevance: number; accuracy: number; uniqueness: number };
    lens?: string;
    findings?: number;
  }): Promise<void> {
    const memDir = this.ensureDirs(agentId);
    const entry: TaskMemoryEntry = {
      version: 1,
      taskId: data.taskId,
      task: truncateAtWord(data.task, 500),
      skills: data.skills,
      lens: data.lens,
      findings: data.findings ?? 0,
      hallucinated: 0,
      scores: data.scores,
      warmth: 1.0,
      importance: this.deriveImportance(data.scores),
      timestamp: new Date().toISOString(),
    };
    appendFileSync(join(memDir, 'tasks.jsonl'), JSON.stringify(entry) + '\n');
  }

  /**
   * Extract key facts from a task result and write as a knowledge entry.
   * This is what enables agents to "remember" what happened in prior tasks —
   * file names, technology choices, patterns used — without LLM summarization.
   */
  writeKnowledgeFromResult(agentId: string, data: {
    taskId: string;
    task: string;
    result: string;
  }): void {
    const memDir = this.ensureDirs(agentId);
    const knowledgeDir = join(memDir, 'knowledge');

    // Extract structured facts from the result text
    const facts = this.extractFacts(data.task, data.result);
    if (!facts) return; // nothing useful to remember

    // Use taskId as filename (unique, no collisions)
    const filename = `task-${data.taskId}.md`;
    const today = new Date().toISOString().split('T')[0];

    const content = [
      '---',
      `name: ${truncateAtWord(data.task, 80).replace(/\n/g, ' ')}`,
      `description: ${facts.description}`,
      `importance: ${facts.importance}`,
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      facts.body,
    ].join('\n');

    writeFileSync(join(knowledgeDir, filename), content);
  }

  /** Extract structured knowledge from task + result without LLM calls */
  private extractFacts(task: string, result: string): { description: string; importance: number; body: string } | null {
    const combined = `${task}\n${result}`;
    const lines: string[] = [];

    // Extract file names mentioned (common patterns from agent output)
    // Allows articles/prepositions between verb and filename: "created the `index.html`"
    const filePatterns = combined.match(/(?:created?|modified?|updated?|wrote?|saved?)\s+(?:the\s+|a\s+|an\s+)?(?:new\s+|placeholder\s+|main\s+|core\s+)?[`"']?([a-zA-Z0-9_/.:-]+\.\w{1,5})[`"']?/gi) || [];
    // Also catch backtick-quoted filenames standalone ("`src/app.js`")
    const backtickFiles = combined.match(/`([a-zA-Z0-9_/.:-]+\.\w{1,5})`/g) || [];
    const allMatches = [...filePatterns, ...backtickFiles];
    const files = [...new Set(allMatches.map(m => {
      const match = m.match(/[`"']?([a-zA-Z0-9_/.:-]+\.\w{1,5})[`"']?$/);
      return match ? match[1] : '';
    }).filter(Boolean))];
    if (files.length > 0) {
      lines.push(`Files: ${files.join(', ')}`);
    }

    // Extract technology mentions
    const techKeywords = ['typescript', 'javascript', 'react', 'vue', 'angular', 'svelte', 'next.js', 'node.js',
      'express', 'fastify', 'python', 'django', 'flask', 'rust', 'go', 'java', 'kotlin', 'swift',
      'html', 'css', 'tailwind', 'canvas', 'web audio', 'webgl', 'three.js', 'tone.js',
      'es modules', 'commonjs', 'webpack', 'vite', 'esbuild', 'rollup',
      'jest', 'vitest', 'mocha', 'postgresql', 'mysql', 'mongodb', 'redis', 'supabase', 'firebase'];
    const foundTech = techKeywords.filter(kw => combined.toLowerCase().includes(kw));
    if (foundTech.length > 0) {
      lines.push(`Technology: ${foundTech.join(', ')}`);
    }

    // Extract key decisions/patterns (lines containing decision language)
    const decisionPatterns = /(?:I (?:chose|decided|used|picked|went with|created|set up|initialized|configured)|(?:using|chose|selected) .{5,60}(?:for|because|since|as))/gi;
    const decisions = combined.match(decisionPatterns) || [];
    if (decisions.length > 0) {
      lines.push(`Decisions: ${decisions.slice(0, 5).map(d => d.trim()).join('; ')}`);
    }

    // Extract task summary (first 2 meaningful sentences of result)
    const sentences = result.split(/[.!]\s+/).filter(s => s.trim().length > 20).slice(0, 2);
    if (sentences.length > 0) {
      lines.push(`Summary: ${sentences.join('. ')}.`);
    }

    if (lines.length === 0) return null;

    // Build description from files + tech for keyword matching
    const descParts = [...files.slice(0, 3), ...foundTech.slice(0, 3)];
    const description = descParts.length > 0
      ? descParts.join(', ')
      : truncateAtWord(task, 80).replace(/\n/g, ' ');

    return {
      description,
      importance: files.length > 3 ? 0.9 : files.length > 0 ? 0.7 : 0.5,
      body: lines.join('\n'),
    };
  }

  private deriveImportance(scores: { relevance: number; accuracy: number; uniqueness: number }): number {
    return (scores.relevance + scores.accuracy + scores.uniqueness) / 15;
  }

  rebuildIndex(agentId: string): void {
    const memDir = this.getMemDir(agentId);
    const parts: string[] = [`# Agent Memory — ${agentId}\n`];

    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        parts.push('## Knowledge');
        for (const file of files) {
          const content = readFileSync(join(knowledgeDir, file), 'utf-8');
          const descMatch = content.match(/description:\s*(.+)/);
          const desc = descMatch ? descMatch[1].trim() : file.replace('.md', '');
          parts.push(`- [${file.replace('.md', '')}](knowledge/${file}) — ${desc}`);
        }
        parts.push('');
      }
    }

    const calPath = join(memDir, 'calibration', 'accuracy.md');
    if (existsSync(calPath)) {
      const content = readFileSync(calPath, 'utf-8');
      const descMatch = content.match(/description:\s*(.+)/);
      parts.push('## Calibration');
      parts.push(`- [accuracy](calibration/accuracy.md) — ${descMatch ? descMatch[1].trim() : 'accuracy data'}`);
      parts.push('');
    }

    const tasksPath = join(memDir, 'tasks.jsonl');
    if (existsSync(tasksPath)) {
      const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-5).reverse();
      if (recent.length > 0) {
        parts.push('## Recent Tasks');
        for (const line of recent) {
          try {
            const entry = JSON.parse(line) as TaskMemoryEntry;
            const date = entry.timestamp.split('T')[0];
            // Single-line summary for index — collapse newlines, limit to 120 chars
            const summary = entry.task.replace(/\n/g, ' ').replace(/\s+/g, ' ').slice(0, 500);
            parts.push(`- ${date}: ${summary}`);
          } catch { /* skip malformed */ }
        }
        parts.push('');
      }
    }

    writeFileSync(join(memDir, 'MEMORY.md'), parts.join('\n'));
  }
}
