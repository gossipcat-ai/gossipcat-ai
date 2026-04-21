import { appendFileSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, openSync, closeSync, constants } from 'fs';
import { join, resolve } from 'path';
import { TaskMemoryEntry } from './types';
import { MemoryCompactor } from './memory-compactor';
import type { ILLMProvider } from './llm-client';
import type { LLMMessage } from '@gossip/types';
import { discoverProjectStructure } from './project-structure';
import { gossipLog } from './log';

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

/** Reject agentIds that could escape the .gossip/agents/ directory tree */
function validateAgentId(agentId: string): void {
  if (!agentId || agentId === '.' || agentId === '..' || agentId.includes('/') || agentId.includes('\\') || agentId.includes('\0')) {
    throw new Error(`Invalid agentId: ${agentId.slice(0, 50)} — must not contain path separators`);
  }
}

/** Strip path separators from taskId for safe use in filenames */
function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[/\\:*?"<>|\0]/g, '_');
}

/**
 * The three artifacts produced by a session save, plus the metadata needed
 * to write them. Returned by `prepareSessionArtifacts*` so the caller can
 * control write order + per-artifact try/catch semantics.
 *
 * Write order (mandatory):
 *   1. next-session.md       (bootstrap continuity)
 *   2. cognitive knowledge   (LRU store)
 *   3. .gossip/memory/*.md   (dashboard visibility)
 *
 * Spec: docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md
 */
export interface SessionArtifacts {
  /** The processed summary body (post STALE/PINNED cleanup, pre-write). */
  summaryBody: string;
  /** One-line session summary extracted from SUMMARY: or fallback heuristic. */
  summaryOneLiner: string;
  /** ISO-ish timestamp used for cognitive-store filename (YYYY-MM-DDTHH-mm-ss). */
  timestamp: string;
  /** Calendar date (YYYY-MM-DD). */
  today: string;
  /** True if the LLM flagged the session as PINNED. */
  pinned: boolean;

  /** Absolute path of the cognitive knowledge file (.gossip/agents/_project/memory/knowledge/<ts>-session.md). */
  knowledgePath: string;
  /** Content to write to knowledgePath. */
  knowledgeContent: string;

  /** Absolute path of .gossip/next-session.md. */
  nextSessionPath: string;
  /** Content to write to nextSessionPath. */
  nextSessionContent: string;

  /** Directory containing the dashboard-visible gossip memory files (.gossip/memory/). */
  gossipMemoryDir: string;
  /** Absolute path of the gossip-memory session file. */
  gossipMemoryPath: string;
  /** Content to write to gossipMemoryPath. */
  gossipMemoryContent: string;
  /** Resolved status derived from the summary's "Open for next session" section ("open" | "shipped"). */
  gossipStatus: 'open' | 'shipped';
}

export class MemoryWriter {
  private summaryLlm: ILLMProvider | null = null;

  constructor(private projectRoot: string) {}

  /** Set the LLM used for cognitive summaries (utility model preferred) */
  setSummaryLlm(llm: ILLMProvider): void {
    this.summaryLlm = llm;
  }

  private getMemDir(agentId: string): string {
    validateAgentId(agentId);
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
    resolutionRoots?: string[];
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
    const filename = `${timestamp}-${sanitizeTaskId(data.taskId)}.md`;
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
    const citations = this.validateCitations(body, data.resolutionRoots);
    const citationLines: string[] = [`citationsVerified: ${citations.verified}/${citations.total}`];
    if (citations.unverified.length > 0) {
      citationLines.push('citationsFabricated:');
      for (const u of citations.unverified) {
        citationLines.push(`  - "${u}"`);
      }
    }
    const content = [
      '---',
      `name: ${truncateAtWord(data.task, 80).replace(/\n/g, ' ')}`,
      `description: ${description.replace(/\n/g, ' ')}`,
      `importance: ${importance}`,
      ...(accuracyLine ? [accuracyLine] : []),
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      ...citationLines,
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
   * Annotation-only citation check: scans `body` for file-like tokens (optionally
   * with a `:NN` line-number suffix), resolves each against `projectRoot` plus any
   * supplied `resolutionRoots`, and reports how many are real. Never drops or
   * mutates content — the caller records the counts in frontmatter for later
   * analysis.
   */
  private validateCitations(
    body: string,
    resolutionRoots?: string[],
  ): { total: number; verified: number; unverified: string[] } {
    // Mirrors extractFacts() regex but also captures an optional :NN suffix.
    const fileRegex = /(?:^|[\s`"'(\[<])([a-zA-Z0-9_/.-]+\.[a-z]{1,7})(?::(\d+))?(?=[\s`"'):,\]>]|$)/gm;
    const seen = new Set<string>();
    const citations: Array<{ path: string; line?: number; key: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = fileRegex.exec(body)) !== null) {
      const path = m[1];
      // Skip URLs — the extension-ish tail after a URL is not a local citation.
      // Check the 8 chars before the match for http:// or https:// scheme.
      const before = body.slice(Math.max(0, m.index - 8), m.index + 1);
      if (/https?:\/\//.test(before) || /https?:\/\//.test(path)) continue;
      const line = m[2] ? parseInt(m[2], 10) : undefined;
      const key = line !== undefined ? `${path}:${line}` : path;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({ path, line, key });
    }

    const roots = [this.projectRoot, ...(resolutionRoots ?? [])];
    const unverified: string[] = [];
    let verified = 0;
    for (const c of citations) {
      let hit: string | null = null;
      for (const root of roots) {
        const abs = resolve(root, c.path);
        if (existsSync(abs)) { hit = abs; break; }
      }
      if (!hit) {
        unverified.push(c.key);
        continue;
      }
      if (c.line !== undefined) {
        try {
          const lineCount = readFileSync(hit, 'utf8').split('\n').length;
          if (c.line > lineCount || c.line < 1) {
            unverified.push(c.key);
            continue;
          }
        } catch {
          unverified.push(c.key);
          continue;
        }
      }
      verified++;
    }

    return { total: citations.length, verified, unverified };
  }

  /**
   * Generate a cognitive summary — what the agent learned, not just what it saw.
   * Uses the utility LLM (cheapest available model).
   */
  private async generateCognitiveSummary(agentId: string, task: string, result: string): Promise<string> {
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are writing a memory entry for an AI agent named "${sanitizeYamlValue(agentId)}". This entry will be loaded into the agent's context on future tasks to help it remember what it learned.

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

  /** Session summary data shared across public methods */
  private sessionSummaryData(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
  }) {
    const memDir = this.ensureDirs('_project');
    const knowledgeDir = join(memDir, 'knowledge');
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const today = now.toISOString().split('T')[0];

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

    // Load existing knowledge file descriptions for staleness detection
    let existingMemoriesContext = '';
    const existingFiles: string[] = [];
    try {
      const files = readdirSync(knowledgeDir).filter(f => f.endsWith('.md') && !f.endsWith('-session.md'));
      for (const f of files) {
        const content = readFileSync(join(knowledgeDir, f), 'utf-8');
        const descMatch = content.match(/description:\s*(.+)/);
        const desc = descMatch ? descMatch[1].trim() : '(no description)';
        existingFiles.push(f);
        existingMemoriesContext += `- ${f} — ${desc}\n`;
      }
    } catch { /* no existing files */ }

    return { memDir, knowledgeDir, timestamp, today, rawInput, projectContext, existingMemoriesContext, existingFiles };
  }

  /**
   * Build the system + user prompts for session summary LLM call.
   * Used by the native utility path to dispatch via Agent() instead of calling LLM directly.
   */
  getSessionSummaryPrompt(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
  }): { system: string; user: string } {
    const { rawInput, projectContext, existingMemoriesContext } = this.sessionSummaryData(data);

    const system = `You are writing a project memory entry that will be loaded into the orchestrator's context at the start of the next session. This helps the orchestrator make better decisions about agent dispatch, task planning, and avoiding past mistakes.

${projectContext}

Write as a briefing for a new team lead taking over. This output is split into two destinations:
- The "## Open for next session" section goes into next-session.md (injected into EVERY agent dispatch — keep it tight)
- Everything else goes into a knowledge file (retrievable on demand, not auto-injected)

Sections:

1. OPEN FOR NEXT SESSION — prioritized bullet list of what needs attention next. Max 5-7 bullets, ~150 words. Each bullet: one line, actionable, with file path if relevant. This section is the MOST IMPORTANT and MUST be concise — it costs tokens on every agent dispatch.
   ONLY include items where: (a) work was explicitly started but not committed (half-built), (b) the user or orchestrator explicitly said "defer this" or "next session", or (c) a consensus finding is unresolved AND has a concrete fix action. Do NOT include: items that were merely discussed then dropped, potential improvements nobody committed to, concerns raised and then dismissed in conversation, or theoretical issues without evidence. When in doubt, leave it out — the orchestrator will verify open items against the code at session start anyway.
2. WHAT SHIPPED — concrete deliverables. Name features, cite file paths. Max ~150 words.
3. WHAT FAILED AND WHY — approaches that didn't work. Format: "We tried X because Y. It failed because Z. The fix was W." Max ~100 words.
4. AGENT OBSERVATIONS — which agents are reliable for what, who hallucinates, who finds things others miss. Max ~100 words.

Rules:
- Start with EXACTLY one line: SUMMARY: <one-line description of the entire session, max 80 chars, no colons>
  Example: SUMMARY: Shipped auth module, fixed 3 race conditions, added 40 tests
  Example: SUMMARY: Dashboard redesign phases 1-4, persistence fix, dispatch rules
- Then a blank line, then start with "## Open for next session"
- Total max 500 words. No preamble. Every word counts — this is injected into LLM context.
- Cite file paths when referencing code or specs
- Include specific numbers (commit count, finding count, test count)
- Warnings > accomplishments — what NOT to do is more useful
- NEVER fabricate file paths. Only cite paths that appear in the Git Log or Task Summaries. All paths must conform to the PROJECT CONTEXT above. If no paths are available, describe features by name without paths.
- If ANY section has a "never do this again" lesson, respond with PINNED:true on the first line, then the summary
${existingMemoriesContext ? `
EXISTING MEMORY FILES:
${existingMemoriesContext}
After your summary, if any of these memory files describe work that is NOW COMPLETED based on the Git Log above, add one line per file:
STALE: <exact filename>
Only mark a file STALE if the git log clearly shows the described work has shipped. Do not guess. Omit the STALE section entirely if nothing is stale.` : ''}`;

    const user = truncateStartAndEnd(rawInput, 6000);
    return { system, user };
  }

  /**
   * Prepare session artifacts from raw LLM output without writing the three
   * main files. The caller is responsible for writing them in order:
   *   1. next-session.md     (bootstrap continuity — highest priority)
   *   2. cognitive knowledge (LRU store)
   *   3. .gossip/memory/     (dashboard visibility — best-effort)
   *
   * Book-keeping side effects (STALE normalization, LRU pruning, tasks.jsonl
   * entry, MEMORY.md rebuild, compaction) happen during preparation because
   * they are internal to the cognitive store and orthogonal to the three
   * artifact writes. Used by the native utility path after Agent() completes.
   */
  async prepareSessionArtifactsFromRaw(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
    raw: string;
  }): Promise<SessionArtifacts> {
    const { memDir, knowledgeDir, timestamp, today, rawInput, existingFiles } = this.sessionSummaryData(data);
    return this.processSessionResponse(data.raw, rawInput, knowledgeDir, memDir, today, timestamp, existingFiles);
  }

  /**
   * Prepare session artifacts using the configured summary LLM (with fallback).
   * The caller (see apps/cli/src/mcp-server-sdk.ts session_save handler) is
   * responsible for writing the three files in order.
   */
  async prepareSessionArtifacts(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
  }): Promise<SessionArtifacts> {
    const SESSION_SUMMARY_MAX_CHARS = 4000;
    const { memDir, knowledgeDir, timestamp, today, rawInput, existingFiles } = this.sessionSummaryData(data);

    let raw = '';
    if (this.summaryLlm) {
      try {
        const { system, user } = this.getSessionSummaryPrompt(data);
        const messages: LLMMessage[] = [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ];

        const response = await this.summaryLlm.generate(messages, { temperature: 0 });
        raw = response.text || '';
      } catch (err) {
        gossipLog(`Session summary LLM failed: ${(err as Error).message}`);
        raw = ''; // Will trigger fallback in processSessionResponse
      }
    }

    if (!raw) {
      // No LLM available or LLM failed — save raw data with note
      const fallback = this.summaryLlm
        ? `> ⚠️ LLM summary failed — raw data below. Review and restructure manually.\n\n${rawInput.slice(0, SESSION_SUMMARY_MAX_CHARS)}`
        : `> ⚠️ No summary LLM configured — raw data below.\n\n${rawInput.slice(0, SESSION_SUMMARY_MAX_CHARS)}`;
      return this.processSessionResponse(fallback, rawInput, knowledgeDir, memDir, today, timestamp, existingFiles, true);
    }

    return this.processSessionResponse(raw, rawInput, knowledgeDir, memDir, today, timestamp, existingFiles);
  }

  /**
   * Convenience wrapper: prepare artifacts AND write the three files in order.
   * Preserved for backward-compat with existing callers/tests that rely on the
   * single-call signature returning the summary body string.
   *
   * New callers should prefer `prepareSessionArtifactsFromRaw` + `writeSessionArtifacts`
   * so each write can have its own try/catch with caller-owned semantics.
   */
  async writeSessionSummaryFromRaw(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
    raw: string;
  }): Promise<string> {
    const artifacts = await this.prepareSessionArtifactsFromRaw(data);
    this.writeSessionArtifacts(artifacts);
    return artifacts.summaryBody;
  }

  /** Convenience wrapper: prepare + write all three files. See prepareSessionArtifacts() for the separated API. */
  async writeSessionSummary(data: {
    gossip: string;
    consensus: string;
    performance: string;
    gitLog: string;
    notes?: string;
  }): Promise<string> {
    const artifacts = await this.prepareSessionArtifacts(data);
    this.writeSessionArtifacts(artifacts);
    return artifacts.summaryBody;
  }

  /**
   * Write the three session artifacts in mandatory order:
   *   1. next-session.md       — bootstrap continuity; throws on failure
   *   2. cognitive knowledge   — LRU store; logged & continued on failure
   *   3. .gossip/memory/       — dashboard visibility; logged & continued on failure
   *
   * Per-artifact failure isolation: a failure in (2) or (3) must not prevent
   * (1) from being persisted, and must not cause the session save to report
   * failure to the user. See docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md.
   */
  writeSessionArtifacts(a: SessionArtifacts): void {
    // (1) next-session.md — must succeed; bootstrap continuity is the highest-priority artifact.
    try {
      writeFileSync(a.nextSessionPath, a.nextSessionContent);
    } catch (err) {
      gossipLog(`next-session.md write failed: ${(err as Error).message}`);
      throw err;
    }

    // (2) cognitive knowledge file — best-effort but logged loudly; cognitive store degraded is not fatal.
    try {
      writeFileSync(a.knowledgePath, a.knowledgeContent);
    } catch (err) {
      gossipLog(`cognitive knowledge write failed: ${(err as Error).message}`);
    }

    // (3) .gossip/memory/session_*.md — best-effort dashboard visibility.
    try {
      mkdirSync(a.gossipMemoryDir, { recursive: true });
      writeFileSync(a.gossipMemoryPath, a.gossipMemoryContent);
    } catch (err) {
      gossipLog(`.gossip/memory write failed: ${(err as Error).message}`);
    }
  }

  /**
   * Shared post-processing for session summary responses.
   * Validates, truncates, extracts metadata, handles STALE/PINNED.
   *
   * Prepares the three artifact contents (next-session.md, cognitive knowledge,
   * gossip-memory session file) and returns them in a SessionArtifacts record.
   * Internal book-keeping side effects (STALE normalization, LRU pruning,
   * tasks.jsonl append, MEMORY.md rebuild, compaction) happen here because
   * they are cognitive-store internals, not dashboard-visible artifacts.
   *
   * The three main writes are deliberately NOT performed here — the caller
   * controls order, try/catch boundaries, and per-artifact failure semantics
   * per docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md.
   */
  private async processSessionResponse(
    raw: string,
    rawInput: string,
    knowledgeDir: string,
    memDir: string,
    today: string,
    timestamp: string,
    existingFiles: string[],
    isFallback = false,
  ): Promise<SessionArtifacts> {
    const SESSION_SUMMARY_MAX_CHARS = 4000;
    const filename = `${timestamp}-session.md`;
    let summaryBody: string;
    let rawLlmResponse = '';
    let pinned = false;
    let summaryOneLiner = 'Session summary';

    if (isFallback) {
      // Fallback content passed directly — skip validation
      summaryBody = raw;
    } else {
      rawLlmResponse = raw;

      // Validate completeness before truncating. We only require a ## header —
      // the SUMMARY: line is nice-to-have, and the fallback extraction below can
      // synthesize a one-liner from the first bullet or sentence if it's missing.
      const hasSectionHeader = /^##\s+\w/m.test(raw);

      if (!hasSectionHeader) {
        gossipLog('Session summary missing required structure, using raw fallback');
        // Persist the raw LLM output so we can diagnose what went wrong next time,
        // instead of throwing it away and being blind to the failure mode.
        try {
          const debugPath = join(memDir, 'last-malformed-summary.txt');
          writeFileSync(debugPath, `# Malformed session summary @ ${timestamp}\n# No ## header found in LLM output.\n\n---\n${raw}`);
        } catch {}
        summaryBody = `> ⚠️ LLM summary malformed — raw data below.\n\n${rawInput.slice(0, SESSION_SUMMARY_MAX_CHARS)}`;
      } else if (raw.length > SESSION_SUMMARY_MAX_CHARS - 100 && !/[.!)\n]$/.test(raw.trimEnd())) {
        // Likely truncated by model output limit — trim to last complete paragraph
        const lastPara = raw.lastIndexOf('\n\n');
        summaryBody = (lastPara > 1000 ? raw.slice(0, lastPara) : raw).slice(0, SESSION_SUMMARY_MAX_CHARS);
        gossipLog('Session summary truncated — trimmed to last complete paragraph');
      } else {
        summaryBody = raw.slice(0, SESSION_SUMMARY_MAX_CHARS);
      }

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
    }

    // Parse STALE: lines from FULL LLM output (before truncation) to avoid losing
    // stale annotations that fall beyond the summary char slice
    const stalePattern = /^STALE:\s*(.+)$/gm;
    let staleMatch: RegExpExecArray | null;
    const staleFiles: string[] = [];
    const staleSource = rawLlmResponse || summaryBody;
    while ((staleMatch = stalePattern.exec(staleSource)) !== null) {
      const staleFilename = staleMatch[1].trim();
      if (existingFiles.includes(staleFilename)) {
        staleFiles.push(staleFilename);
      }
    }
    if (staleFiles.length > 0) {
      for (const sf of staleFiles) {
        try {
          const filePath = join(knowledgeDir, sf);
          let fileContent = readFileSync(filePath, 'utf-8');
          fileContent = fileContent.replace(/importance:\s*[\d.]+/, 'importance: 0.1');
          if (!/status:/.test(fileContent)) {
            fileContent = fileContent.replace(/\n---/, '\nstatus: shipped\n---');
          } else {
            fileContent = fileContent.replace(/status:\s*.+/, 'status: shipped');
          }
          writeFileSync(filePath, fileContent);
          gossipLog(`🗜️  Marked stale: ${sf}`);
        } catch { /* best-effort */ }
      }
      // Strip STALE: lines from summary body (metadata, not content)
      summaryBody = summaryBody.replace(/^STALE:.*\n?/gm, '').trim();
    }

    // Prune AFTER staleness downgrades so demoted files are eviction candidates
    this.pruneProjectKnowledge(knowledgeDir);

    // (a) cognitive knowledge file content
    const knowledgeContent = [
      '---',
      `name: Session ${today} — ${summaryOneLiner}`,
      `description: ${summaryOneLiner}`,
      `importance: 0.4`,
      pinned ? `pinned: true` : '',
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      summaryBody,
    ].filter(l => l !== '').join('\n');
    const knowledgePath = join(knowledgeDir, filename);

    // (b) next-session.md — ONLY the priorities section (≤1500 chars).
    // Full session detail stays in the knowledge file for on-demand retrieval.
    // This keeps bootstrap context lean — agents get priorities, not history.
    const nextSessionPath = join(this.projectRoot, '.gossip', 'next-session.md');
    const openMatch = summaryBody.match(/##\s+Open[^\n]*\n([\s\S]*?)(?=\n##|\s*$)/i);
    const NEXT_SESSION_MAX_CHARS = 1500;
    const nextSessionContent = openMatch
      ? `# Next Session\n\n${openMatch[0].trim()}\n`
      : `# Next Session\n\n${truncateAtWord(summaryBody, NEXT_SESSION_MAX_CHARS)}\n`;

    // (c) .gossip/memory/session_YYYY_MM_DD.md — canonical dashboard-visible artifact.
    // Separate store from cognitive knowledge: dashboard-facing, pruned on its own
    // schedule, never a destination for cognitive-store importance values (always 0.4).
    // Same-date collision: second save overwrites first (semantics pinned in spec
    // invariant 4). Cognitive store retains per-timestamp versions for recall.
    const gossipMemoryDir = join(this.projectRoot, '.gossip', 'memory');
    const gossipMemoryFilename = `session_${today.replace(/-/g, '_')}.md`;
    const gossipMemoryPath = join(gossipMemoryDir, gossipMemoryFilename);
    const gossipStatus = openMatch && openMatch[0].trim().length > '## Open for next session'.length + 5
      ? 'open'
      : 'shipped';
    const gossipName = sanitizeYamlValue(`Session ${today} — ${summaryOneLiner}`).slice(0, 120);
    const gossipMemoryContent = [
      '---',
      `name: ${gossipName}`,
      `description: ${summaryOneLiner}`,
      `status: ${gossipStatus}`,
      `type: session`,
      `importance: 0.4`,
      `lastAccessed: ${today}`,
      `updated: ${today}`,
      `accessCount: 0`,
      '---',
      '',
      summaryBody,
    ].join('\n');

    // One-time migration: normalize old importance=1.0 entries
    const migrationTasksPath = join(memDir, 'tasks.jsonl');
    if (existsSync(migrationTasksPath)) {
      try {
        const mLines = readFileSync(migrationTasksPath, 'utf-8').trim().split('\n').filter(Boolean);
        let migrated = false;
        const fixed = mLines.map(line => {
          try {
            const e = JSON.parse(line);
            if (e.importance > 0.5) { e.importance = 0.4; migrated = true; }
            return JSON.stringify(e);
          } catch { return line; }
        });
        if (migrated) writeFileSync(migrationTasksPath, fixed.join('\n') + '\n');
      } catch { /* best-effort */ }
    }

    // Write task entry for session tracking (internal cognitive-store bookkeeping)
    await this.writeTaskEntry('_project', {
      taskId: `session-${timestamp}`,
      task: `Session ${today}: ${summaryOneLiner}`,
      skills: [],
      scores: { relevance: 2, accuracy: 2, uniqueness: 2 },
    });

    this.rebuildIndex('_project');

    // Compact _project memory — session saves bypass the collect pipeline
    try {
      const compactor = new MemoryCompactor(this.projectRoot);
      compactor.compactIfNeeded('_project', 15);
    } catch { /* best-effort compaction */ }

    return {
      summaryBody,
      summaryOneLiner,
      timestamp,
      today,
      pinned,
      knowledgePath,
      knowledgeContent,
      nextSessionPath,
      nextSessionContent,
      gossipMemoryDir,
      gossipMemoryPath,
      gossipMemoryContent,
      gossipStatus,
    };
  }

  /** Warmth-aware pruning for _project knowledge files */
  private pruneProjectKnowledge(knowledgeDir: string): void {
    this.pruneKnowledgeDir(knowledgeDir, 10);
  }

  /** Shared warmth-aware pruning — evicts lowest-warmth files, respects pinned */
  private pruneKnowledgeDir(knowledgeDir: string, maxFiles: number): void {
    try {
      const existing = readdirSync(knowledgeDir).filter(f => f.endsWith('.md') && !f.endsWith('-session.md')).sort();

      // Only run main eviction if over cap
      if (existing.length >= maxFiles) {
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

        const targetCount = maxFiles - 1; // leave room for incoming file
        const unpinned = scored.filter(s => !s.isPinned);
        const toEvict = unpinned.slice(0, Math.max(0, existing.length - targetCount));

        if (toEvict.length === 0 && existing.length >= maxFiles) {
          gossipLog(`pruneKnowledgeDir: all ${existing.length} files are pinned, cannot evict to stay under ${maxFiles}`);
        }

        for (const item of toEvict) {
          unlinkSync(join(knowledgeDir, item.file));
        }
      }

      // Session file management: TTL expiry + compaction
      const sessionFiles = readdirSync(knowledgeDir).filter(f => f.endsWith('-session.md')).sort();
      const MAX_SESSION_FILES = 5;
      const SESSION_TTL_DAYS = 14;

      // TTL: demote session files older than 14 days (still queryable, not auto-injected)
      for (const sf of sessionFiles) {
        try {
          const ts = sf.slice(0, 19).replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4');
          const days = (Date.now() - new Date(ts).getTime()) / 86400000;
          if (days > SESSION_TTL_DAYS) {
            const sfPath = join(knowledgeDir, sf);
            const sfContent = readFileSync(sfPath, 'utf-8');
            if (!/importance:\s*0\.1/.test(sfContent)) {
              writeFileSync(sfPath, sfContent.replace(/importance:\s*[\d.]+/, 'importance: 0.1'));
            }
          }
        } catch { /* best-effort */ }
      }

      // Compaction: when >MAX_SESSION_FILES, compact oldest into a digest
      if (sessionFiles.length > MAX_SESSION_FILES) {
        const toCompact = sessionFiles.slice(0, sessionFiles.length - MAX_SESSION_FILES);
        const bodies: string[] = [];
        for (const sf of toCompact) {
          try {
            const sfContent = readFileSync(join(knowledgeDir, sf), 'utf-8');
            const body = sfContent.split('---').slice(2).join('---').trim();
            if (body) bodies.push(body.slice(0, 800));
          } catch { /* skip */ }
        }
        if (bodies.length > 0) {
          // Write a compact digest from the old sessions
          const digestName = `${toCompact[0].slice(0, 10)}-to-${toCompact[toCompact.length - 1].slice(0, 10)}-digest-session.md`;
          const today = new Date().toISOString().split('T')[0];
          const digestContent = [
            '---',
            `name: Session digest ${toCompact[0].slice(0, 10)} to ${toCompact[toCompact.length - 1].slice(0, 10)}`,
            `description: Compacted summary of ${toCompact.length} older sessions`,
            `importance: 0.2`,
            `lastAccessed: ${today}`,
            `accessCount: 0`,
            '---',
            '',
            ...bodies,
          ].join('\n').slice(0, 3000);
          writeFileSync(join(knowledgeDir, digestName), digestContent);
          // Remove compacted originals
          for (const sf of toCompact) {
            try { unlinkSync(join(knowledgeDir, sf)); } catch { /* best-effort */ }
          }
        }
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
    return Math.min(0.85, (scores.relevance + scores.accuracy + scores.uniqueness) / 15);
  }

  writeConsensusKnowledge(
    agentId: string,
    findings: Array<{ originalAgentId: string; finding: string; tag?: string }>,
    resolutionRoots?: string[],
  ): void {
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

    const bodyLines = [
      '## Peer Findings (learn from these)',
      '',
      ...peerFindings.map(f => {
        const emoji = tagEmoji[f.tag || ''] || '';
        const status = f.tag ? ` [${f.tag.toUpperCase()}]` : '';
        return `- ${emoji} [${f.originalAgentId}]${status} ${f.finding}`;
      }),
    ];
    const body = bodyLines.join('\n');

    const citations = this.validateCitations(body, resolutionRoots);
    const citationLines: string[] = [`citationsVerified: ${citations.verified}/${citations.total}`];
    if (citations.unverified.length > 0) {
      citationLines.push('citationsFabricated:');
      for (const u of citations.unverified) {
        citationLines.push(`  - "${u}"`);
      }
    }

    const content = [
      '---',
      `name: Peer findings from consensus review`,
      `description: ${peerFindings.length} findings from peer agents`,
      `importance: 0.8`,
      `lastAccessed: ${today}`,
      `accessCount: 0`,
      ...citationLines,
      '---',
      '',
      body,
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
      try { validateAgentId(agentId); } catch { continue; }
      const memDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'memory');
      const tasksPath = join(memDir, 'tasks.jsonl');
      const lockPath = join(memDir, 'tasks.jsonl.lock');

      if (!existsSync(tasksPath)) continue;

      // Atomic lock acquisition (same O_EXCL pattern as MemoryCompactor)
      let fd: number;
      try {
        fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
        writeFileSync(fd, `${Date.now()}`);
        closeSync(fd);
      } catch { continue; } // lock held by compactor or another writer, skip

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
