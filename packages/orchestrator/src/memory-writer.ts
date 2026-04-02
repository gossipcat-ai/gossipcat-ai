import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { TaskMemoryEntry } from './types';
import type { ILLMProvider } from './llm-client';
import type { LLMMessage } from '@gossip/types';
import { discoverProjectStructure } from './project-structure';

/** Truncate text at a word boundary, appending "..." if truncated */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '...';
}

/** Truncate by keeping start + end — tail-biased (25/75) since conclusions are at the end */
/** Sanitize a string for use as a bare YAML value — strip newlines, colons, quotes */
function sanitizeYamlValue(str: string): string {
  return str.replace(/[\n\r]/g, ' ').replace(/:/g, '-').replace(/"/g, "'").replace(/\s+/g, ' ').trim();
}

function truncateStartAndEnd(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const head = Math.floor(maxLen * 0.25);
  const tail = maxLen - head;
  return `${text.slice(0, head)}\n\n[... truncated ${text.length - maxLen} chars ...]\n\n${text.slice(-tail)}`;
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
    agentAccuracy?: number;
  }): Promise<void> {
    const memDir = this.ensureDirs(agentId);
    const knowledgeDir = join(memDir, 'knowledge');

    // Truncate result before processing to prevent resource exhaustion
    const safeResult = data.result.length > 50000 ? data.result.slice(0, 50000) : data.result;

    // Generate cognitive summary via LLM (attempt even if extractFacts would return null)
    let cognitiveSummary: string | null = null;
    if (this.summaryLlm) {
      try {
        cognitiveSummary = await this.generateCognitiveSummary(agentId, data.task, safeResult);
      } catch { /* fall back to regex extraction */ }
    }

    const facts = this.extractFacts(data.task, safeResult);
    // Skip only when both LLM and regex extraction failed
    if (!facts && !cognitiveSummary) return;

    // Timestamp prefix for chronological ordering + taskId for uniqueness
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${timestamp}-${data.taskId}.md`;
    const today = now.toISOString().split('T')[0];

    // Warmth-aware pruning — evict lowest-warmth files, not just oldest
    this.pruneKnowledgeDir(knowledgeDir, 25);

    // Build knowledge body: metadata (regex) + understanding (LLM or regex fallback)
    let body: string;
    let description = facts?.description || truncateAtWord(data.task, 100).replace(/\n/g, ' ');
    let importance = facts?.importance || 0.6;
    if (cognitiveSummary) {
      // Extract LLM-generated metadata lines and strip from summary body
      // Use (?:^|\n) anchor to handle first-line placement
      const techMatch = cognitiveSummary.match(/(?:^|\n)TECHNOLOGIES:\s*(.+)/i);
      const descMatch = cognitiveSummary.match(/(?:^|\n)DESCRIPTION:\s*(.+)/i);
      const llmTech = techMatch ? techMatch[1].trim() : null;
      if (descMatch) description = descMatch[1].trim().slice(0, 120);
      const cleanSummary = cognitiveSummary
        .replace(/^TECHNOLOGIES:\s*.+/gim, '')
        .replace(/^DESCRIPTION:\s*.+/gim, '')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();

      // Replace regex technology with LLM-detected technology in metadata
      let metadata = facts?.metadata || '';
      if (llmTech) {
        metadata = metadata.replace(/Technology: .+/, `Technology: ${llmTech}`);
        if (!metadata.includes('Technology:')) metadata += `${metadata ? '\n' : ''}Technology: ${llmTech}`;
      }
      body = metadata ? `${metadata}\n\n${cleanSummary}` : cleanSummary;
    } else {
      body = facts!.body;
    }

    const accuracyLine = data.agentAccuracy !== undefined
      ? `agentAccuracy: ${data.agentAccuracy.toFixed(2)}`
      : null;
    const content = [
      '---',
      `name: ${truncateAtWord(data.task, 80).replace(/\n/g, ' ')}`,
      `description: ${description.replace(/\n/g, ' ')}`,
      `importance: ${importance}`,
      ...(accuracyLine ? [accuracyLine] : []),
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      ...(data.agentAccuracy !== undefined && data.agentAccuracy < 0.4
        ? ['> ⚠ This agent has low accuracy (' + (data.agentAccuracy * 100).toFixed(0) + '%). Treat factual claims as unverified.\n']
        : []),
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
- If the task confirmed something works, say what and why it matters
- End with exactly two metadata lines:
  DESCRIPTION: one sentence (max 100 chars) summarizing what was learned, not what files were touched
  TECHNOLOGIES: comma-separated list of languages/frameworks actually used (e.g. typescript, jest, esbuild). Only include technologies that appear in the code, not ones merely mentioned.`,
      },
      {
        role: 'user',
        content: `Task: ${task.slice(0, 500)}\n\nResult:\n${truncateStartAndEnd(result, 4000)}`,
      },
    ];

    const response = await this.summaryLlm!.generate(messages, { temperature: 0 });
    return (response.text || '').slice(0, 1500);
  }

  /**
   * Write a session summary to the _project virtual agent's memory.
   * Dedicated method with higher output cap (3000 chars) and session-specific prompt.
   * Falls back to raw data save if LLM fails.
   */
  async writeSessionSummary(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
  }): Promise<string> {
    const memDir = this.ensureDirs('_project');
    const knowledgeDir = join(memDir, 'knowledge');
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `${timestamp}-session.md`;
    const today = now.toISOString().split('T')[0];

    // Prune knowledge files (warmth-aware for _project)
    this.pruneProjectKnowledge(knowledgeDir);

    // Assemble raw data for LLM input
    const rawInput = [
      data.gossip ? `## Task Summaries\n${data.gossip}` : '',
      data.consensus ? `## Consensus Runs\n${data.consensus}` : '',
      data.performance ? `## Agent Performance\n${data.performance}` : '',
      data.gitLog ? `## Git Log\n${data.gitLog}` : '',
      data.notes ? `## User Notes\n${data.notes}` : '',
    ].filter(Boolean).join('\n\n');

    // Discover project structure for LLM grounding (prevents path hallucination)
    const discovered = discoverProjectStructure(this.projectRoot).map(p => `- ${p}`);
    const projectContext = discovered.length > 0
      ? `PROJECT CONTEXT:\n${discovered.join('\n')}\n- Only cite file paths that conform to the directory structure above. If no paths are available, describe features by name without paths.`
      : '';

    let summaryBody: string;
    let pinned = false;
    let summaryOneLiner = 'Session summary'; // Will be replaced by LLM extraction

    if (this.summaryLlm) {
      try {
        const messages: LLMMessage[] = [
          {
            role: 'system',
            content: `You are writing a project memory entry that will be loaded into the orchestrator's context at the start of the next session. This helps the orchestrator make better decisions about agent dispatch, task planning, and avoiding past mistakes.

${projectContext}

Write as a briefing for a new team lead taking over. Focus on:

1. WHAT SHIPPED — concrete deliverables. Name features, cite file paths.
2. WHAT FAILED AND WHY — approaches that didn't work. Format: "We tried X because Y. It failed because Z. The fix was W."
3. AGENT OBSERVATIONS — which agents are reliable for what, who hallucinates, who finds things others miss.
4. IN PROGRESS — specs in review, half-built features. Include file paths and what needs to happen next.
5. USER PREFERENCES — how the user works (e.g., "always runs multi-agent review before merging").

Rules:
- Start with EXACTLY one line: SUMMARY: <one-line description of the entire session, max 80 chars, no colons>
  Example: SUMMARY: Shipped auth module, fixed 3 race conditions, added 40 tests
  Example: SUMMARY: Dashboard redesign phases 1-4, persistence fix, dispatch rules
- Then a blank line, then start with "## What shipped"
- Max 500 words after the SUMMARY line. No other preamble.
- Cite file paths when referencing code or specs
- Include specific numbers (commit count, finding count, test count)
- Warnings > accomplishments — what NOT to do is more useful
- NEVER fabricate file paths. Only cite paths that appear in the Git Log or Task Summaries. All paths must conform to the PROJECT CONTEXT above. If no paths are available, describe features by name without paths.
- If ANY section has a "never do this again" lesson, respond with PINNED:true on the first line, then the summary`,
          },
          {
            role: 'user',
            content: truncateStartAndEnd(rawInput, 6000),
          },
        ];

        const response = await this.summaryLlm.generate(messages, { temperature: 0 });
        summaryBody = (response.text || '').slice(0, 3000);

        // Check if LLM flagged as pinned
        if (summaryBody.startsWith('PINNED:true')) {
          pinned = true;
          summaryBody = summaryBody.replace(/^PINNED:true\s*\n?/, '');
        }

        // Extract SUMMARY: line from LLM output (explicitly requested in prompt)
        const summaryMatch = summaryBody.match(/^SUMMARY:\s*(.+)$/m);
        if (summaryMatch) {
          summaryOneLiner = sanitizeYamlValue(summaryMatch[1].trim().slice(0, 100));
          // Strip the SUMMARY line from the body — it's metadata, not content
          summaryBody = summaryBody.replace(/^SUMMARY:.*\n?\n?/m, '').trim();
        } else {
          // Fallback: extract from first bold bullet or first meaningful sentence
          const firstBullet = summaryBody.match(/[-*]\s+\*\*([^*\n]+)\*\*/);
          const firstSentence = summaryBody.replace(/^#+\s+.+$/gm, '').trim().split('\n').find(l => l.trim().length > 10);
          if (firstBullet) {
            summaryOneLiner = sanitizeYamlValue(firstBullet[1].replace(/[:(].*/,'').trim().slice(0, 80));
          } else if (firstSentence) {
            summaryOneLiner = sanitizeYamlValue(firstSentence.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').trim().slice(0, 80));
          }
        }
      } catch (err) {
        // Fallback: save raw data with warning header
        process.stderr.write(`[gossipcat] Session summary LLM failed: ${(err as Error).message}\n`);
        summaryBody = `> ⚠️ LLM summary failed — raw data below. Review and restructure manually.\n\n${rawInput.slice(0, 3000)}`;
      }
    } else {
      // No LLM available — save raw data with note
      summaryBody = `> ⚠️ No summary LLM configured — raw data below.\n\n${rawInput.slice(0, 3000)}`;
    }

    const content = [
      '---',
      `name: Session ${today} — ${summaryOneLiner}`,
      `description: ${summaryOneLiner}`,
      `importance: 0.95`,
      pinned ? `pinned: true` : '',
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      summaryBody,
    ].filter(l => l !== '').join('\n');

    writeFileSync(join(knowledgeDir, filename), content);

    // Write next-session.md so the next session gets prioritized action items
    // This is the primary source of truth for session continuity — knowledge files
    // are supplementary context, but next-session.md drives the opening briefing.
    const nextSessionPath = join(this.projectRoot, '.gossip', 'next-session.md');
    const nextSessionContent = `# Next Session Plan\n\n${summaryBody}\n`;
    writeFileSync(nextSessionPath, nextSessionContent);

    // Write task entry for session tracking
    await this.writeTaskEntry('_project', {
      taskId: `session-${timestamp}`,
      task: `Session ${today}: ${summaryOneLiner}`,
      skills: [],
      scores: { relevance: 5, accuracy: 5, uniqueness: 5 },
    });

    this.rebuildIndex('_project');
    return summaryBody;
  }

  /** Warmth-aware pruning for _project knowledge files */
  private pruneProjectKnowledge(knowledgeDir: string): void {
    this.pruneKnowledgeDir(knowledgeDir, 10);
  }

  /** Shared warmth-aware pruning — evicts lowest-warmth files, respects pinned */
  private pruneKnowledgeDir(knowledgeDir: string, maxFiles: number): void {
    try {
      const existing = readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).sort();
      if (existing.length < maxFiles) return;

      const scored = existing.map(f => {
        const content = readFileSync(join(knowledgeDir, f), 'utf-8');
        const importance = parseFloat(content.match(/importance:\s*([\d.]+)/)?.[1] ?? '0.5');
        const isPinned = /pinned:\s*true/i.test(content);
        const ts = f.slice(0, 19).replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4');
        const days = Math.max(0, (Date.now() - new Date(ts).getTime()) / 86400000);
        const warmth = isPinned ? Infinity : importance * (1 / (1 + days / 30));
        return { file: f, warmth, isPinned };
      });

      scored.sort((a, b) => a.warmth - b.warmth);

      const toRemove = scored.slice(0, existing.length - maxFiles + 1);
      for (const item of toRemove) {
        if (item.isPinned) continue;
        unlinkSync(join(knowledgeDir, item.file));
      }
    } catch { /* best-effort */ }
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

    // Extract technology mentions — use word boundaries to avoid false positives
    // (e.g. "go" matching in "category", "orchestrator", "ago")
    const techKeywords = ['typescript', 'javascript', 'react', 'vue', 'angular', 'svelte', 'next\\.js', 'node\\.js',
      'express', 'fastify', 'python', 'django', 'flask', 'rust', 'golang', 'java', 'kotlin', 'swift',
      'html', 'css', 'tailwind', 'canvas', 'web audio', 'webgl', 'three\\.js', 'tone\\.js',
      'es modules', 'commonjs', 'webpack', 'vite', 'esbuild', 'rollup',
      'jest', 'vitest', 'mocha', 'postgresql', 'mysql', 'mongodb', 'redis', 'supabase', 'firebase'];
    const lowerCombined = combined.toLowerCase();
    const foundTech = techKeywords
      .filter(kw => new RegExp(`\\b${kw}\\b`).test(lowerCombined))
      .map(kw => kw.replace(/\\\./g, '.')); // unescape dots for output
    // Detect languages from file extensions when keyword matching misses them
    const extMap: Record<string, string> = { '.go': 'golang', '.py': 'python', '.rs': 'rust', '.kt': 'kotlin', '.swift': 'swift' };
    for (const [ext, tech] of Object.entries(extMap)) {
      if (!foundTech.includes(tech) && files.some(f => f.endsWith(ext))) foundTech.push(tech);
    }
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

    // Build description: prefer summary sentence, fall back to files + tech
    const firstSentence = sentences.length > 0 ? truncateAtWord(sentences[0], 100) : '';
    const descParts = [...files.slice(0, 3), ...foundTech.slice(0, 3)];
    const description = firstSentence
      || (descParts.length > 0 ? descParts.join(', ') : truncateAtWord(task, 80).replace(/\n/g, ' '));

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

  writeConsensusKnowledge(agentId: string, findings: Array<{ originalAgentId: string; finding: string; tag?: string }>): void {
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

    const tagEmoji: Record<string, string> = {
      confirmed: '✓', disputed: '⚡', unverified: '?', unique: '◇',
    };

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
      ...peerFindings.map(f => {
        const emoji = tagEmoji[f.tag || ''] || '';
        const status = f.tag ? ` [${f.tag.toUpperCase()}]` : '';
        return `- ${emoji} [${f.originalAgentId}]${status} ${f.finding}`;
      }),
    ].join('\n');

    // Warmth-aware pruning — same as writeKnowledgeFromResult
    this.pruneKnowledgeDir(knowledgeDir, 25);

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
        // Acquire lock to prevent race with concurrent signal updates or compaction
        writeFileSync(lockPath, `${Date.now()}`);

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
      } catch { /* best-effort */ } finally {
        try { unlinkSync(lockPath); } catch { /* already deleted */ }
      }
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
