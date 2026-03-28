import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry } from './types';
import type { ILLMProvider } from './llm-client';
import type { LLMMessage } from '@gossip/types';

/** Truncate text at a word boundary, appending "..." if truncated */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/** Truncate by keeping start + end — preserves conclusions/errors at the tail */
function truncateStartAndEnd(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const half = Math.floor(maxLen / 2);
  return `${text.slice(0, half)}\n\n[... truncated ${text.length - maxLen} chars ...]\n\n${text.slice(-half)}`;
}

export class MemoryWriter {
  private summaryLlm: ILLMProvider | null = null;

  constructor(private projectRoot: string) {}

  /** Set the LLM used for cognitive summaries (utility model preferred) */
  setSummaryLlm(llm: ILLMProvider): void {
    this.summaryLlm = llm;
  }

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
   * Uses LLM for cognitive summary when available, falls back to regex extraction.
   * This is what enables agents to "remember" what happened in prior tasks.
   */
  async writeKnowledgeFromResult(agentId: string, data: {
    taskId: string;
    task: string;
    result: string;
  }): Promise<void> {
    const memDir = this.ensureDirs(agentId);
    const knowledgeDir = join(memDir, 'knowledge');

    // Truncate result before processing to prevent resource exhaustion
    const safeResult = data.result.length > 50000 ? data.result.slice(0, 50000) : data.result;
    const facts = this.extractFacts(data.task, safeResult);
    if (!facts) return; // nothing useful to remember

    // Generate cognitive summary via LLM (fire-and-forget if fails)
    let cognitiveSummary: string | null = null;
    if (this.summaryLlm) {
      try {
        cognitiveSummary = await this.generateCognitiveSummary(agentId, data.task, safeResult);
      } catch { /* fall back to regex extraction */ }
    }

    // Timestamp prefix for chronological ordering + taskId for uniqueness
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${timestamp}-${data.taskId}.md`;
    const today = now.toISOString().split('T')[0];

    // Limit knowledge files — keep only the most recent 10, remove oldest
    try {
      const existing = readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort();
      const MAX_KNOWLEDGE_FILES = 10;
      if (existing.length >= MAX_KNOWLEDGE_FILES) {
        const toRemove = existing.slice(0, existing.length - MAX_KNOWLEDGE_FILES + 1);
        for (const old of toRemove) {
          unlinkSync(join(knowledgeDir, old));
        }
      }
    } catch { /* skip cleanup on error */ }

    // Build knowledge body: metadata (regex) + understanding (LLM or regex fallback)
    const body = cognitiveSummary
      ? `${facts.metadata}\n\n${cognitiveSummary}`
      : facts.body;

    const content = [
      '---',
      `name: ${truncateAtWord(data.task, 80).replace(/\n/g, ' ')}`,
      `description: ${facts.description}`,
      `importance: ${facts.importance}`,
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      body,
    ].join('\n');

    writeFileSync(join(knowledgeDir, filename), content);
  }

  /**
   * Generate a cognitive summary — what the agent learned, not just what it saw.
   * Uses the utility LLM (cheapest available model).
   */
  private async generateCognitiveSummary(agentId: string, task: string, result: string): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are writing a memory entry for an AI agent named "${agentId}". This entry will be loaded into the agent's context on future tasks to help it remember what it learned.

Write in second person ("You reviewed...", "You found..."). Be specific and actionable. Focus on:
1. What was the key finding or outcome?
2. What was surprising or non-obvious?
3. What pattern or lesson should be remembered for future tasks?

Rules:
- Max 300 words
- No preamble, no "Here is the summary"
- Cite specific file:line when referencing code
- If the task found bugs, name them concretely
- If the task confirmed something works, say what and why it matters`,
      },
      {
        role: 'user',
        content: `Task: ${task.slice(0, 500)}\n\nResult:\n${truncateStartAndEnd(result, 4000)}`,
      },
    ];

    const response = await this.summaryLlm!.generate(messages, { temperature: 0 });
    return (response.text || '').slice(0, 1500);
  }

  /** Extract structured knowledge from task + result without LLM calls */
  private extractFacts(task: string, result: string): { description: string; importance: number; body: string; metadata: string } | null {
    const combined = `${task}\n${result}`;
    const lines: string[] = [];
    const metadataLines: string[] = [];

    // Extract file paths from agent output.
    // Lookahead boundary prevents skipping back-to-back refs.
    // Extension up to 7 chars covers .graphql, .svelte.
    // Includes [] and <> for markdown patterns.
    const fileRegex = /(?:^|[\s`"'(\[<])([a-zA-Z0-9_/.-]+\.[a-z]{1,7})(?=[\s`"'):,\]>]|$)/gm;
    const rawMatches: string[] = [];
    let fm: RegExpExecArray | null;
    while ((fm = fileRegex.exec(combined)) !== null) rawMatches.push(fm[1]);

    const SOURCE_EXTENSIONS = new Set([
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
      'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
      'c', 'cpp', 'h', 'hpp', 'cs',
      'html', 'css', 'scss', 'less', 'vue', 'svelte',
      'sh', 'bash', 'zsh',
      'sql', 'graphql', 'proto',
      'php', 'lua', 'xml',
    ]);
    const CODE_PREFIXES = [
      'this.', 'self.', 'Object.', 'JSON.', 'Math.', 'Array.', 'Promise.', 'console.',
      'String.', 'Number.', 'Boolean.', 'process.', 'Buffer.', 'Error.', 'Date.',
      'React.', 'Vue.', 'axios.', 'fs.', 'path.', 'crypto.', 'http.', 'https.',
    ];
    const BARE_SKIP_EXTS = new Set(['json', 'lock', 'yaml', 'yml', 'toml', 'md', 'txt', 'env', 'log', 'bak']);
    const skipTokens = new Set(['e.g', 'i.e', 'etc', 'v1', 'v2', 'No', 'Dr']);

    const files = [...new Set(rawMatches.filter(f => {
      // Reject known false positives
      if (skipTokens.has(f.split('.')[0])) return false;
      // Reject code identifiers (this.data, JSON.parse, etc.)
      if (CODE_PREFIXES.some(p => f.startsWith(p))) return false;
      const ext = f.split('.').pop()!.toLowerCase();
      if (f.includes('/')) {
        // Path-qualified: accept, but reject sensitive files
        if (f.includes('.env') || f.includes('node_modules/')) return false;
        return true;
      }
      // Bare filename: must be a recognized source extension
      if (BARE_SKIP_EXTS.has(ext)) return false;
      return SOURCE_EXTENSIONS.has(ext);
    }))];
    if (files.length > 0) {
      const fileLine = `Files: ${files.join(', ')}`;
      lines.push(fileLine);
      metadataLines.push(fileLine);
    }

    // Extract technology mentions
    const techKeywords = ['typescript', 'javascript', 'react', 'vue', 'angular', 'svelte', 'next.js', 'node.js',
      'express', 'fastify', 'python', 'django', 'flask', 'rust', 'go', 'java', 'kotlin', 'swift',
      'html', 'css', 'tailwind', 'canvas', 'web audio', 'webgl', 'three.js', 'tone.js',
      'es modules', 'commonjs', 'webpack', 'vite', 'esbuild', 'rollup',
      'jest', 'vitest', 'mocha', 'postgresql', 'mysql', 'mongodb', 'redis', 'supabase', 'firebase'];
    const foundTech = techKeywords.filter(kw => combined.toLowerCase().includes(kw));
    if (foundTech.length > 0) {
      const techLine = `Technology: ${foundTech.join(', ')}`;
      lines.push(techLine);
      metadataLines.push(techLine);
    }

    // Extract key decisions — requires explicit subject to avoid passive-voice false positives
    const decisionPatterns = /(?:(?:I|we|they|the team|the project) (?:chose|decided|used|picked|went with|created|set up|initialized|configured|adopted|migrated to|switched to) .{3,80}(?:for|because|since|as|due to|instead of)?)/gi;
    const decisions = combined.match(decisionPatterns) || [];
    if (decisions.length > 0) {
      lines.push(`Decisions: ${decisions.slice(0, 5).map(d => d.trim()).join('; ')}`);
    }

    // Extract error/failure patterns — knowing what went wrong is valuable
    const failurePatterns = /(?:error|failed|couldn't|unable to|rejected|threw|exception|not supported|bug|broke|crash)[^.]{5,100}/gi;
    const failures = (combined.match(failurePatterns) || []).slice(0, 3);
    if (failures.length > 0) {
      lines.push(`Failures: ${failures.map(f => f.trim()).join('; ')}`);
    }

    // Extract task summary (first 2 meaningful sentences of result)
    const sentences = result.split(/[.!]\s+/).filter(s => s.trim().length > 20).slice(0, 2);
    if (sentences.length > 0) {
      lines.push(`Summary: ${sentences.join('. ')}.`);
    }

    if (lines.length === 0) return null;
    const hasFailures = failures.length > 0;

    // Build description from files + tech for keyword matching
    const descParts = [...files.slice(0, 3), ...foundTech.slice(0, 3)];
    const description = descParts.length > 0
      ? descParts.join(', ')
      : truncateAtWord(task, 80).replace(/\n/g, ' ');

    return {
      description,
      importance: (files.length > 3 ? 0.9 : files.length > 0 ? 0.7 : 0.5) + (hasFailures ? 0.1 : 0),
      body: lines.join('\n'),
      metadata: metadataLines.join('\n'),
    };
  }

  private deriveImportance(scores: { relevance: number; accuracy: number; uniqueness: number }): number {
    return (scores.relevance + scores.accuracy + scores.uniqueness) / 15;
  }

  writeConsensusKnowledge(agentId: string, findings: Array<{ originalAgentId: string; finding: string }>): void {
    if (findings.length === 0) return;
    const memDir = this.ensureDirs(agentId);
    const knowledgeDir = join(memDir, 'knowledge');
    const today = new Date().toISOString().split('T')[0];
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${timestamp}-consensus.md`;

    const peerFindings = findings
      .filter(f => f.originalAgentId !== agentId) // only learn from peers, not own findings
      .slice(0, 10);

    if (peerFindings.length === 0) return;

    const content = [
      '---',
      `name: Peer findings from consensus review`,
      `description: ${peerFindings.length} findings from peer agents`,
      `importance: 0.8`,
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      '## Peer Findings (learn from these)',
      '',
      ...peerFindings.map(f => `- [${f.originalAgentId}] ${f.finding}`),
    ].join('\n');

    // Enforce knowledge file cap
    try {
      const existing = readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort();
      const MAX_KNOWLEDGE_FILES = 10;
      if (existing.length >= MAX_KNOWLEDGE_FILES) {
        const toRemove = existing.slice(0, existing.length - MAX_KNOWLEDGE_FILES + 1);
        for (const old of toRemove) {
          unlinkSync(join(knowledgeDir, old));
        }
      }
    } catch { /* skip cleanup on error */ }

    writeFileSync(join(knowledgeDir, filename), content);
  }

  /**
   * Update task memory importance based on consensus signals.
   * High-quality findings get boosted, hallucinations get reduced.
   */
  updateImportanceFromSignals(signals: Array<{ signal: string; agentId: string; taskId: string }>): void {
    const IMPORTANCE_ADJUSTMENTS: Record<string, number> = {
      consensus_verified: 0.15,
      unique_confirmed: 0.20,
      agreement: 0.05,
      hallucination_caught: -0.25,
      disagreement: -0.10,
    };

    // Group adjustments by agentId → taskId
    const adjustments = new Map<string, Map<string, number>>();
    for (const s of signals) {
      const weight = IMPORTANCE_ADJUSTMENTS[s.signal];
      if (weight === undefined) continue;
      if (!adjustments.has(s.agentId)) adjustments.set(s.agentId, new Map());
      const taskAdj = adjustments.get(s.agentId)!;
      taskAdj.set(s.taskId, (taskAdj.get(s.taskId) ?? 0) + weight);
    }

    // Apply adjustments to tasks.jsonl for each agent
    for (const [agentId, taskAdjustments] of adjustments) {
      const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
      const tasksPath = join(memDir, 'tasks.jsonl');
      const lockPath = join(memDir, 'tasks.jsonl.lock');

      if (!existsSync(tasksPath)) continue;
      if (existsSync(lockPath)) continue; // locked by compactor, skip

      try {
        const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean);
        let modified = false;

        const updated = lines.map(line => {
          try {
            const entry = JSON.parse(line);
            const adj = taskAdjustments.get(entry.taskId);
            if (adj !== undefined) {
              entry.importance = Math.max(0.1, Math.min(1.0, (entry.importance || 0.5) + adj));
              modified = true;
              return JSON.stringify(entry);
            }
            return line;
          } catch { return line; }
        });

        if (modified) {
          writeFileSync(tasksPath, updated.join('\n') + '\n');
        }
      } catch { /* best-effort */ }
    }
  }

  rebuildIndex(agentId: string): void {
    const memDir = this.getMemDir(agentId);
    const parts: string[] = [`# Agent Memory — ${agentId}\n`];

    const knowledgeDir = join(memDir, 'knowledge');
    if (existsSync(knowledgeDir)) {
      // Sort reverse chronologically (timestamp-prefixed filenames sort naturally)
      const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort().reverse();
      if (files.length > 0) {
        parts.push('## Knowledge (most recent first)');
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

    // Recent Patterns section — summarize decisions from recent knowledge files
    try {
      const knowledgeDir = join(memDir, 'knowledge');
      if (existsSync(knowledgeDir)) {
        const knowledgeFiles = readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 5);
        const patterns: string[] = [];
        for (const kf of knowledgeFiles) {
          const kContent = readFileSync(join(knowledgeDir, kf), 'utf-8');
          const decisionsMatch = kContent.match(/Decisions: (.+)/);
          if (decisionsMatch) patterns.push(decisionsMatch[1].trim());
          const failuresMatch = kContent.match(/Failures: (.+)/);
          if (failuresMatch) patterns.push(`⚠️ ${failuresMatch[1].trim()}`);
        }
        if (patterns.length > 0) {
          parts.push('', '## Recent Patterns', '', ...patterns.slice(0, 5).map(p => `- ${p}`));
        }
      }
    } catch { /* best-effort patterns */ }

    writeFileSync(join(memDir, 'MEMORY.md'), parts.join('\n'));
  }
}
