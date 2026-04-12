import { readFile, readdir, stat } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';
import { log as _log } from './log';

/** Generate a short consensus round ID: xxxxxxxx-xxxxxxxx (17 chars from UUID) */
function shortConsensusId(): string {
  const hex = randomUUID().replace(/-/g, '');
  return hex.slice(0, 8) + '-' + hex.slice(8, 16);
}
import { LLMMessage, ToolDefinition } from '@gossip/types';
import { ILLMProvider } from './llm-client';
import { AgentConfig, TaskEntry } from './types';
import { ConsensusReport, ConsensusFinding, ConsensusNewFinding, ConsensusSignal, CrossReviewEntry } from './consensus-types';

export type {
  ConsensusReport,
  ConsensusFinding,
  ConsensusNewFinding,
  ConsensusSignal,
  CrossReviewEntry,
} from './consensus-types';

const SUMMARY_HEADER = '## Consensus Summary';
const FALLBACK_MAX_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 5000; // raised from 3000 — citations were being truncated before snippet extraction
const MAX_CROSS_REVIEW_ENTRIES = 50; // DoS prevention
/**
 * Model-aware context budget for cross-review prompts.
 * ~4 chars/token average, leave 20% headroom for response tokens.
 * Progressive compaction when over budget: drop suggestions → strip anchors → drop LOW findings.
 * INVARIANT: never reorder findings — findingIdx must stay in lockstep with synthesize().
 */
const DEFAULT_BUDGET_CHARS = 400_000; // Sonnet: 200K tokens × 4 chars × 0.5 headroom
const MODEL_BUDGETS: Record<string, number> = {
  'sonnet':  400_000,   // 200K token context
  'haiku':   400_000,   // 200K token context
  'opus':    400_000,   // 200K token context
  'gemini':  2_400_000, // ~1M token context
  'gpt':     320_000,   // 128K token context
};
function budgetForAgent(preset: string): number {
  const p = preset.toLowerCase();
  for (const [key, budget] of Object.entries(MODEL_BUDGETS)) {
    if (p.includes(key)) return budget;
  }
  return DEFAULT_BUDGET_CHARS;
}
/** Minimum findings per peer to produce a useful cross-review. Below this, skip the peer. */
const MIN_FINDINGS_PER_PEER = 2;
const VALID_ACTIONS = new Set(['agree', 'disagree', 'unverified', 'new']);
const ANCHOR_PATTERN = /[\w./-]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|md|json|yaml|yml|toml|sh):\d+/;
const MAX_VERIFIER_TURNS = 7;

const VERIFIER_TOOLS: ToolDefinition[] = [
  { name: 'file_read', description: 'Read file contents', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or project-relative file path' }, startLine: { type: 'number', description: 'First line to read (1-based)' }, endLine: { type: 'number', description: 'Last line to read (inclusive)' } }, required: ['path'] } },
  { name: 'file_grep', description: 'Search file contents by regex', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern to search for' }, path: { type: 'string', description: 'Directory or file to search in' }, maxResults: { type: 'number', description: 'Maximum number of results to return' } }, required: ['pattern'] } },
  { name: 'file_search', description: 'Find files by glob pattern', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern to match files' }, path: { type: 'string', description: 'Root directory to search from' } }, required: ['pattern'] } },
  { name: 'memory_query', description: 'Search agent memory by keyword', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Keyword or phrase to search memory' } }, required: ['query'] } },
  { name: 'git_log', description: 'Show git log for a file or path', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File or directory to show history for' }, maxCount: { type: 'number', description: 'Maximum number of commits to return' } }, required: [] } },
];

export interface ConsensusEngineConfig {
  llm: ILLMProvider;
  registryGet: (agentId: string) => AgentConfig | undefined;
  projectRoot?: string;
  agentLlm?: (agentId: string) => ILLMProvider | undefined;
  verifierToolRunner?: (agentId: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
}

export class ConsensusEngine {
  protected readonly config: ConsensusEngineConfig;
  private fileCache = new Map<string, string | null>();
  private pathCache = new Map<string, string | null>();
  /**
   * Per-task worktree paths discovered from TaskEntry.worktreeInfo. Used as
   * additional file-resolution roots so consensus auto-anchor can find files
   * created in a feature-branch worktree (which only exist there, not in the
   * main project root). Populated lazily by updateWorktreeRoots() at the
   * start of dispatchCrossReview / synthesize. The pathCache is invalidated
   * when this set changes so a stale "file not found" doesn't poison later
   * resolutions.
   */
  private currentWorktreeRoots: Set<string> = new Set();

  constructor(config: ConsensusEngineConfig) {
    this.config = config;
  }

  /**
   * Capture all worktree paths from a TaskEntry array as additional resolver
   * roots. Called at the start of every consensus pipeline entry point so
   * snippetsForFinding can resolve citations to files that only exist in a
   * feature-branch worktree, not in the main project root. Closes the
   * "Consensus auto-anchor resolves against project root, not worktree" gap.
   */
  private updateWorktreeRoots(results: TaskEntry[]): void {
    const next = new Set<string>();
    for (const r of results) {
      const wt = r.worktreeInfo?.path;
      if (wt && typeof wt === 'string') {
        next.add(resolve(wt));
      }
    }
    // Reset path cache only if the worktree set changed — otherwise we'd
    // wipe a hot cache between back-to-back synthesize calls on the same
    // round (synthesize → synthesizeWithCrossReview → ...).
    let changed = next.size !== this.currentWorktreeRoots.size;
    if (!changed) {
      for (const wt of next) {
        if (!this.currentWorktreeRoots.has(wt)) { changed = true; break; }
      }
    }
    if (changed) {
      this.currentWorktreeRoots = next;
      // Clear both caches on worktree change. pathCache holds ref→abspath,
      // fileCache holds abspath→content (or null on read failure). If only
      // pathCache clears, a cached null from a previous worktree can shadow
      // a file that now exists at the same absolute path after the switch
      // (or vice versa), biasing verifyCitations toward stale benefit-of-
      // doubt outcomes. See consensus round 82a3c123-19db41e7 Tier 1A
      // Fix #4 — fileCache invalidation parity with pathCache.
      this.pathCache.clear();
      this.fileCache.clear();
    }
  }

  /**
   * All valid resolution roots: the configured projectRoot first (most
   * citations live here), followed by every active worktree path. The
   * resolver and the path-traversal guard both iterate this list.
   */
  private getValidRoots(): string[] {
    const roots: string[] = [];
    if (this.config.projectRoot) roots.push(this.config.projectRoot);
    for (const wt of this.currentWorktreeRoots) roots.push(wt);
    return roots;
  }

  private async cachedResolve(fileRef: string): Promise<string | null> {
    if (this.pathCache.has(fileRef)) return this.pathCache.get(fileRef)!;
    const resolved = await this.resolveFilePath(fileRef);
    this.pathCache.set(fileRef, resolved);
    return resolved;
  }

  private async cachedRead(filePath: string): Promise<string | null> {
    if (this.fileCache.has(filePath)) return this.fileCache.get(filePath)!;
    try {
      const content = await readFile(filePath, 'utf-8');
      this.fileCache.set(filePath, content);
      return content;
    } catch {
      // Don't cache failures — transient I/O errors (locked file, network FS blip)
      // should be retried on the next call, not permanently poisoned.
      return null;
    }
  }

  extractSummary(result: string): string {
    const idx = result.indexOf(SUMMARY_HEADER);
    if (idx !== -1) {
      // Cap before regex scan to bound search cost
      const afterHeader = result.slice(idx + SUMMARY_HEADER.length, idx + SUMMARY_HEADER.length + MAX_SUMMARY_LENGTH).trimStart();
      // Only stop at the next markdown header (##), not at blank lines
      // — summaries often have blank-line-separated bullet points
      const nextHeader = afterHeader.search(/\n##\s/);
      let end = afterHeader.length;
      if (nextHeader !== -1) end = Math.min(end, nextHeader);
      return afterHeader.slice(0, end).trim();
    }

    if (result.length <= FALLBACK_MAX_LENGTH) return result;
    const truncated = result.slice(0, FALLBACK_MAX_LENGTH);
    const lastPeriod = truncated.lastIndexOf('.');
    if (lastPeriod > FALLBACK_MAX_LENGTH * 0.5) {
      return truncated.slice(0, lastPeriod + 1);
    }
    return truncated;
  }

  async run(results: TaskEntry[]): Promise<ConsensusReport> {
    const successful = results.filter(r => r.status === 'completed' && r.result);
    if (successful.length < 2) {
      return {
        agentCount: 0, rounds: 0,
        confirmed: [], disputed: [], unverified: [], unique: [], insights: [], newFindings: [], signals: [],
        summary: 'Consensus skipped: insufficient agents (need ≥2 successful).',
      };
    }

    const consensusStart = Date.now();
    _log('consensus', `Starting cross-review for ${successful.length} agents`);
    this.updateWorktreeRoots(results);
    const crossReviewStart = Date.now();
    const crossReviewEntries = await this.dispatchCrossReview(results);
    const crossReviewMs = Date.now() - crossReviewStart;
    _log('consensus', `Cross-review complete: ${crossReviewEntries.length} entries (${Math.round(crossReviewMs / 1000)}s)`);

    const synthesizeStart = Date.now();
    const report = await this.synthesize(results, crossReviewEntries);
    const synthesizeMs = Date.now() - synthesizeStart;
    // Build per-agent timing from task results
    const perAgent = successful.map(r => ({
      agentId: r.agentId,
      durationMs: (r.completedAt && r.startedAt) ? r.completedAt - r.startedAt : 0,
    }));
    _log('consensus', `Synthesis: ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unverified.length} unverified, ${report.unique.length} unique, ${report.newFindings.length} new (${Math.round(synthesizeMs / 1000)}s)`);

    const totalMs = Date.now() - consensusStart;
    const timing = { totalMs, perAgent, crossReviewMs, synthesizeMs };
    _log('consensus', `Total: ${Math.round(totalMs / 1000)}s (cross-review: ${Math.round(crossReviewMs / 1000)}s, synthesis: ${Math.round(synthesizeMs / 1000)}s)`);
    // Always regenerate report with timing data
    report.summary = this.formatReport(report.confirmed, report.disputed, report.unverified, report.unique, report.newFindings, successful.length, report.rounds, timing, report.insights);

    return report;
  }

  /**
   * Phase 2: Send cross-review prompts to each agent and collect structured responses.
   * Each agent reviews all peer summaries and produces agree/disagree/new entries.
   */
  async dispatchCrossReview(results: TaskEntry[]): Promise<CrossReviewEntry[]> {
    this.updateWorktreeRoots(results);
    const successful = results.filter(r => r.status === 'completed' && r.result);
    if (successful.length < 2) return [];

    // Build summary map: agentId -> extracted + sanitized summary (bounded, used for own-context)
    // Also build rawResults map: agentId -> full sanitized result (used for finding extraction,
    // so IDs stay in sync with synthesize() which also parses the full raw text).
    const summaries = new Map<string, string>();
    const rawResults = new Map<string, string>();
    const sanitize = (s: string) => s.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
    for (const r of successful) {
      summaries.set(r.agentId, sanitize(this.extractSummary(r.result!)));
      rawResults.set(r.agentId, sanitize(r.result!));
    }

    // Dispatch cross-review in parallel, each agent reviews peers
    const allEntries = await Promise.all(
      successful.map(async agent => {
        const start = Date.now();
        const entries = await this.crossReviewForAgent(agent, summaries, rawResults);
        _log('consensus', `${agent.agentId} cross-review: ${entries.length} entries (${Math.round((Date.now() - start) / 1000)}s)`);
        return entries;
      })
    );

    return allEntries.flat();
  }

  /**
   * Build the cross-review prompt for a single agent without calling the LLM.
   * Applies progressive context compaction when the assembled prompt exceeds the
   * model-aware budget. Compaction passes (in order):
   *   1. Drop suggestion/insight-type findings (keep type="finding" only)
   *   2. Strip <anchor> code blocks from all findings
   *   3. Drop LOW/INFO-severity findings
   * INVARIANT: findings are never reordered — only dropped in original tag order.
   * This preserves findingIdx lockstep with synthesize().
   */
  private async buildCrossReviewPrompt(
    agent: TaskEntry,
    summaries: Map<string, string>,
    rawResults?: Map<string, string>,
  ): Promise<{ system: string; user: string }> {
    const ownSummary = summaries.get(agent.agentId) ?? '';
    // For finding extraction, prefer the full raw result so IDs stay in sync with synthesize().
    // Fall back to summaries when rawResults isn't provided (legacy callers / tests).
    const findingSource = rawResults ?? summaries;

    const agentFindingPattern = /<agent_finding\s+([^>]*)>([\s\S]*?)<\/agent_finding>/g;
    const MAX_ANCHORS_PER_SUMMARY = 15;
    // Content cap — see parseAgentFindings() for the full rationale. Must match
    // MAX_FINDING_CONTENT over there so findingIdx stays in lockstep with
    // synthesize()'s own pass, otherwise wrong findings get confirmed/disputed.
    const MAX_FINDING_CONTENT = 8000;

    // --- Phase A: Extract all peer findings (preserving order + IDs) ---
    interface ParsedFinding {
      id: string; attrs: string; content: string;
      type: 'finding' | 'suggestion' | 'insight';
      severity: string;
    }
    interface PeerData {
      peerId: string; preset: string; peerSummary: string;
      findings: ParsedFinding[];
      fallback: boolean; // true = no structured findings, use raw summary
    }
    const peers: PeerData[] = [];

    for (const [peerId, peerSummary] of summaries) {
      if (peerId === agent.agentId) continue;
      const peerConfig = this.config.registryGet(peerId);
      const preset = peerConfig?.preset ?? 'unknown';
      const peerFindingText = findingSource.get(peerId) ?? peerSummary;

      const findings: ParsedFinding[] = [];
      let afMatch: RegExpExecArray | null;
      const pattern = new RegExp(agentFindingPattern.source, agentFindingPattern.flags);
      let findingIdx = 0;
      while ((afMatch = pattern.exec(peerFindingText)) !== null) {
        const attrs = afMatch[1];
        let content = afMatch[2].trim();
        if (!content || content.length < 15) continue;
        const typeMatch = attrs.match(/type="(finding|suggestion|insight)"/);
        if (!typeMatch) continue;
        if (content.length > MAX_FINDING_CONTENT) {
          content = content.slice(0, MAX_FINDING_CONTENT) + '\n…[truncated]';
        }
        findingIdx++;
        const sevMatch = attrs.match(/severity="(\w+)"/);
        findings.push({
          id: `${peerId}:f${findingIdx}`, attrs, content,
          type: typeMatch[1] as ParsedFinding['type'],
          severity: sevMatch?.[1]?.toLowerCase() ?? 'medium',
        });
      }
      peers.push({ peerId, preset, peerSummary, findings, fallback: findings.length === 0 });
    }

    // --- Phase B: Determine budget and compaction level ---
    const agentConfig = this.config.registryGet(agent.agentId);
    const budget = budgetForAgent(agentConfig?.preset ?? agentConfig?.model ?? 'sonnet');

    // Compaction levels — each is strictly additive:
    //   none           → all findings, all anchors
    //   drop_suggestions → drop suggestion/insight types, keep anchors
    //   strip_anchors  → drop suggestion/insight types, strip anchors (incremental: anchor savings)
    //   drop_low       → drop suggestion/insight + LOW/INFO severity, strip anchors
    type CompactionLevel = 'none' | 'drop_suggestions' | 'strip_anchors' | 'drop_low';
    const COMPACTION_ORDER: CompactionLevel[] = ['none', 'drop_suggestions', 'strip_anchors', 'drop_low'];

    const shouldInclude = (f: ParsedFinding, level: CompactionLevel): boolean => {
      // Levels 1-3: drop suggestions and insights
      if (level !== 'none' && f.type !== 'finding') return false;
      // Level 3: also drop LOW/INFO severity findings
      if (level === 'drop_low' && (f.severity === 'low' || f.severity === 'info')) return false;
      return true;
    };

    // --- Phase B.1: Pre-compute snippets once (avoids redundant calls across compaction retries) ---
    // Key: finding id → snippet string (or empty). Computed eagerly for all findings.
    const snippetCache = new Map<string, string>();
    if (this.config.projectRoot) {
      for (const peer of peers) {
        if (peer.fallback) continue;
        for (const f of peer.findings) {
          const snippets = await this.snippetsForFinding(f.content);
          snippetCache.set(f.id, snippets);
        }
      }
    }
    // Also pre-compute fallback peer line-level snippets
    const fallbackSnippetCache = new Map<string, string[]>();
    if (this.config.projectRoot) {
      for (const peer of peers) {
        if (!peer.fallback) continue;
        const annotatedLines: string[] = [];
        let anchorCount = 0;
        for (const line of peer.peerSummary.split('\n')) {
          annotatedLines.push(line);
          const trimmed = line.trim();
          if (trimmed && anchorCount < MAX_ANCHORS_PER_SUMMARY) {
            const snippets = await this.snippetsForFinding(trimmed);
            if (snippets) {
              annotatedLines.push(snippets);
              anchorCount += (snippets.match(/<anchor /g) || []).length;
            }
          }
        }
        fallbackSnippetCache.set(peer.peerId, annotatedLines);
      }
    }

    // --- Phase B.2: Try each compaction level until the prompt fits ---
    let peerLines: string[] = [];
    let compactionUsed: CompactionLevel = 'none';
    const stripAnchors = (level: CompactionLevel) => level === 'strip_anchors' || level === 'drop_low';

    for (const level of COMPACTION_ORDER) {
      peerLines = [];
      const noAnchors = stripAnchors(level);

      for (const peer of peers) {
        if (peer.fallback) {
          if (noAnchors) {
            peerLines.push(`Agent "${peer.peerId}" (${peer.preset}):\n<data>${peer.peerSummary}</data>`);
          } else {
            const lines = fallbackSnippetCache.get(peer.peerId) ?? peer.peerSummary.split('\n');
            peerLines.push(`Agent "${peer.peerId}" (${peer.preset}):\n<data>${lines.join('\n')}</data>`);
          }
          continue;
        }

        // Filter findings for this compaction level (preserve original order)
        const visible = peer.findings.filter(f => shouldInclude(f, level));

        // Floor: if too few findings survive, skip this peer entirely
        if (visible.length < MIN_FINDINGS_PER_PEER && peer.findings.length >= MIN_FINDINGS_PER_PEER) {
          continue;
        }
        if (visible.length === 0) continue;

        // Build finding blocks (snippets from cache, no redundant I/O)
        const findingBlocks: string[] = [];
        let anchorCount = 0;
        for (const f of visible) {
          let block = `[${f.id}] <agent_finding ${f.attrs}>${f.content}</agent_finding>`;
          if (!noAnchors && anchorCount < MAX_ANCHORS_PER_SUMMARY) {
            const snippets = snippetCache.get(f.id) ?? '';
            if (snippets) {
              block += '\n' + snippets;
              anchorCount += (snippets.match(/<anchor /g) || []).length;
            }
          }
          findingBlocks.push(block);
        }
        peerLines.push(`Agent "${peer.peerId}" (${peer.preset}):\n<data>${findingBlocks.join('\n\n')}</data>`);
      }

      // Estimate total prompt size using actual template overhead (not hardcoded guesses)
      const peerContent = peerLines.join('\n\n');
      // System prompt: ~1,450 chars. User template scaffolding: ~700 chars. Add 500 char safety margin.
      const SYSTEM_OVERHEAD = 1500;
      const USER_TEMPLATE_OVERHEAD = 1200;
      const estimatedSize = SYSTEM_OVERHEAD + ownSummary.length + peerContent.length + USER_TEMPLATE_OVERHEAD;
      if (estimatedSize <= budget) {
        compactionUsed = level;
        break;
      }
      compactionUsed = level;
    }

    // Log compaction level; warn if still over budget after all passes
    if (compactionUsed !== 'none') {
      const peerContent = peerLines.join('\n\n');
      const finalSize = 1500 + ownSummary.length + peerContent.length + 1200;
      const overBudget = finalSize > budget;
      _log('consensus', `⚡ Context compaction for ${agent.agentId}: level=${compactionUsed}, budget=${Math.round(budget / 1000)}K chars${overBudget ? ` ⚠️ STILL OVER BUDGET (${Math.round(finalSize / 1000)}K chars) — prompt may be truncated by model` : ''}`);
    }

    const user = `You previously reviewed code and produced findings. Now review your peers' findings.

YOUR FINDINGS (Phase 1):
<data>${ownSummary}</data>

PEER FINDINGS (each has an ID like [agent:f1] — use these IDs in your response):
${peerLines.join('\n\n')}

For each peer finding, you MUST:
1. If the finding has an inline <anchor> block, use the code shown to verify the claim
2. Only AGREE if the claim is factually accurate based on the actual code
3. DISAGREE if the code contradicts the claim (e.g., finding says "no validation" but code has validation)

Respond with one of:
- AGREE: The finding is factually correct — you verified it against the code. Cite your evidence.
- DISAGREE: The finding is factually incorrect — the code shows otherwise. Cite file:line and what the code actually does.
- UNVERIFIED: You cannot verify or refute this finding — no anchor is present, the line number is wrong, or you lack sufficient context. This is NOT disagreement — it means "I can't confirm or deny."
- NEW: Something ALL agents missed that you now realize after seeing peer work.

IMPORTANT: Use DISAGREE only when you have evidence the finding is WRONG. Use UNVERIFIED when you simply cannot check it.

Return ONLY a JSON array. Use findingId to reference findings:
[
  { "action": "agree"|"disagree"|"unverified"|"new", "findingId": "agent:f1", "finding": "brief summary", "evidence": "your reasoning", "confidence": 1-5 }
]`;

    const system = `You are a code reviewer performing cross-review. Your job is to verify peer findings against actual code — catch errors, but also confirm good work.

SOURCE FILES: Always cite original source files, not compiled/bundled build output (dist/, build/, out/). Build artifacts have different line numbers — citing them causes false verification failures.

VERIFICATION RULES:
- If a finding has an <anchor> block, use the code shown to verify the claim
- AGREE only if you can confirm the claim is factually correct — cite your evidence
- DISAGREE only if you have concrete evidence the finding is WRONG — the code contradicts the claim
- UNVERIFIED if an anchor is missing for a cited file, the line number is wrong, or the code in the anchor is insufficient to verify the claim. UNVERIFIED is the correct default when you lack context — it is NOT a failure. Use it freely whenever you cannot confidently verify or refute.
- ⚠ warnings mean the agent's citation is unresolvable (file not found, line out of range, or blank line). Treat these as UNVERIFIED — do NOT agree with findings that have broken citations.
- Do NOT agree with a finding just because it sounds plausible — verify it
- Agreeing without verification is WORSE than disagreeing — a false confirmation poisons the system

Return only valid JSON.`;

    return { system, user };
  }

  /**
   * Build the cross-review prompt for a single agent and call the LLM.
   * When `config.verifierToolRunner` is set, runs an inline tool loop so the
   * reviewer can verify file contents before emitting findings.
   */
  private async crossReviewForAgent(
    agent: TaskEntry,
    summaries: Map<string, string>,
    rawResults?: Map<string, string>,
  ): Promise<CrossReviewEntry[]> {
    const { system, user } = await this.buildCrossReviewPrompt(agent, summaries, rawResults);
    const messages: LLMMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    try {
      const llm = this.config.agentLlm?.(agent.agentId) ?? this.config.llm;
      const { verifierToolRunner } = this.config;

      let response: Awaited<ReturnType<typeof llm.generate>>;

      if (verifierToolRunner) {
        const runToolCalls = async (calls: any[]) => {
          for (const tc of calls) {
            let out: string;
            try {
              out = await verifierToolRunner(agent.agentId, tc.name, tc.arguments as Record<string, unknown>);
            } catch (e) {
              out = `Error: ${(e as Error).message}`;
            }
            if (out.length > 8000) out = out.slice(0, 8000) + '\n…[truncated]';
            messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, content: out } as LLMMessage);
          }
        };

        let turn = 0;
        while (true) {
          response = await llm.generate(messages, { temperature: 0, tools: VERIFIER_TOOLS });
          const calls = response.toolCalls ?? [];
          if (calls.length === 0) break;
          if (turn >= MAX_VERIFIER_TURNS) {
            messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: calls } as LLMMessage);
            await runToolCalls(calls);
            messages.push({
              role: 'user',
              content: 'You have reached the maximum verification turns. Emit your cross-review findings now in the required JSON format. Do not request additional tools.',
            } as LLMMessage);
            response = await llm.generate(messages, { temperature: 0 });
            break;
          }
          messages.push({ role: 'assistant', content: response.text ?? '', toolCalls: calls } as LLMMessage);
          await runToolCalls(calls);
          turn++;
        }
      } else {
        response = await llm.generate(messages, { temperature: 0 });
      }

      if (!response.text?.trim()) {
        _log('consensus', `${agent.agentId} returned empty cross-review response`);
        return [];
      }
      const validPeerIds = new Set(summaries.keys());
      const entries = this.parseCrossReviewResponse(agent.agentId, response.text, MAX_CROSS_REVIEW_ENTRIES);
      if (entries.length === 0) {
        _log('consensus', `${agent.agentId} cross-review parsed to 0 entries (response length: ${response.text.length})`);
      }
      // Filter: no self-references, peerAgentId must be a real agent in this batch
      return entries.filter(e => e.peerAgentId !== agent.agentId && validPeerIds.has(e.peerAgentId));
    } catch (err) {
      _log('consensus', `${agent.agentId} cross-review LLM call failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Generate cross-review prompts for all successful agents without calling any LLM.
   * Used in the two-phase consensus flow where native agents handle their own LLM calls.
   */
  async generateCrossReviewPrompts(
    results: TaskEntry[],
    nativeAgentIds?: Set<string>,
  ): Promise<{
    prompts: Array<{ agentId: string; system: string; user: string; isNative: boolean }>;
    summaries: Map<string, string>;
    consensusId: string;
  }> {
    this.updateWorktreeRoots(results);
    const successful = results.filter(r => r.status === 'completed' && r.result);
    const consensusId = shortConsensusId();

    const summaries = new Map<string, string>();
    const rawResults = new Map<string, string>();
    const sanitize = (s: string) => s.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
    for (const r of successful) {
      summaries.set(r.agentId, sanitize(this.extractSummary(r.result!)));
      rawResults.set(r.agentId, sanitize(r.result!));
    }

    const prompts: Array<{ agentId: string; system: string; user: string; isNative: boolean }> = [];
    for (const agent of successful) {
      const { system, user } = await this.buildCrossReviewPrompt(agent, summaries, rawResults);
      prompts.push({
        agentId: agent.agentId,
        system,
        user,
        isNative: nativeAgentIds?.has(agent.agentId) ?? false,
      });
    }

    return { prompts, summaries, consensusId };
  }

  /**
   * Phase 3: Synthesize Phase 1 results and Phase 2 cross-review entries into a consensus report.
   */
  async synthesize(results: TaskEntry[], crossReviewEntries: CrossReviewEntry[]): Promise<ConsensusReport> {
    this.updateWorktreeRoots(results);
    const consensusId = shortConsensusId();
    const signals: ConsensusSignal[] = [];
    const newFindings: ConsensusNewFinding[] = [];
    const successful = results.filter(r => r.status === 'completed' && r.result);

    // (a) Seed finding map from Phase 1 results
    const findingMap = new Map<string, {
      originalAgentId: string;
      /** Per-agent finding id `agentId:fN` from cross-review prompt assembly.
       * Carried to ConsensusFinding so signal writeback can resolve the 3-part
       * finding_id format (`consensusId:agentId:fN`) against the report. */
      authorFindingId?: string;
      finding: string;
      findingType?: 'finding' | 'suggestion' | 'insight';
      severity?: 'critical' | 'high' | 'medium' | 'low';
      category?: string;
      confirmedBy: string[];
      disputedBy: Array<{ agentId: string; reason: string; evidence: string }>;
      unverifiedBy: Array<{ agentId: string; reason: string }>;
      confidences: number[];
    }>();

    // findingId → findingMap key lookup (for cross-review matching by ID)
    const findingIdToKey = new Map<string, string>();

    for (const r of successful) {
      // Parse findings from the FULL raw result so tags placed before the
      // `## Consensus Summary` header (or past the fallback truncation window)
      // are not silently dropped. extractSummary remains the source for the
      // bounded "own context" block in cross-review prompts.
      const raw = r.result!;
      const summary = this.extractSummary(r.result!);

      // Primary: parse <agent_finding> tags from the full raw result
      const parsed = this.parseAgentFindings(r.agentId, raw);
      let findingIdx = 0;
      for (const p of parsed) {
        findingIdx++;
        const key = `${r.agentId}::${p.content}`;

        // Register stable findingId matching the IDs assigned in buildCrossReviewPrompt
        const findingId = `${r.agentId}:f${findingIdx}`;
        findingIdToKey.set(findingId, key);

        findingMap.set(key, {
          originalAgentId: r.agentId,
          authorFindingId: findingId,
          finding: p.content,
          findingType: p.findingType,
          severity: p.severity,
          category: p.category,
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: p.hasAnchor ? [] : [2],
        });
      }
      let agentFindingsFound = parsed.length;

      // Per-agent fallback: if THIS agent produced no tags, use legacy bullet parsing
      if (agentFindingsFound === 0) {
        _log('consensus',
          `⚠ agent "${r.agentId}" emitted ZERO <agent_finding> tags — falling back to bullet parsing. ` +
          `Cross-review IDs will not roundtrip and dashboard results will be incomplete. ` +
          `Fix: ensure the agent uses <agent_finding type="finding" severity="..."> wrapping (see CONSENSUS_OUTPUT_FORMAT).`
        );
        const lines = summary.split('\n').filter(l => l.trimStart().startsWith('-'));
        for (const line of lines) {
          let finding = line.replace(/^\s*-\s*/, '').trim();
          if (!finding || finding.length < 15) continue;
          const prefixMatch = finding.match(/^\[(FINDING|SUGGESTION|INSIGHT)\]\s*/i);
          const findingType = prefixMatch ? prefixMatch[1].toLowerCase() as 'finding' | 'suggestion' | 'insight' : 'finding';
          if (prefixMatch) finding = finding.slice(prefixMatch[0].length).trim();
          const key = `${r.agentId}::${finding}`;
          const hasAnchor = ANCHOR_PATTERN.test(finding);
          findingMap.set(key, {
            originalAgentId: r.agentId,
            finding,
            findingType,
            confirmedBy: [],
            disputedBy: [],
            unverifiedBy: [],
            confidences: hasAnchor ? [] : [2],
          });
        }
      }
    }

    // (a.2) Semantic dedup: merge findings across agents that describe the same issue
    this.deduplicateFindings(findingMap);

    // Redirect findingIdToKey entries for deduped-away findings to their surviving merge target.
    // Without this, cross-review entries pointing to the removed finding silently drop.
    for (const [fid, key] of findingIdToKey) {
      if (!findingMap.has(key)) {
        // Find the surviving key that absorbed this finding (same originalAgentId prefix)
        const agentPrefix = key.split('::')[0];
        let redirected = false;
        for (const [survivingKey] of findingMap) {
          if (survivingKey.startsWith(agentPrefix + '::')) {
            findingIdToKey.set(fid, survivingKey);
            redirected = true;
            break;
          }
        }
        // If the merge target was from a DIFFERENT agent (cross-agent dedup),
        // search all surviving entries for one that lists this agent in confirmedBy
        if (!redirected) {
          for (const [survivingKey, entry] of findingMap) {
            if (entry.confirmedBy.includes(agentPrefix)) {
              findingIdToKey.set(fid, survivingKey);
              redirected = true;
              break;
            }
          }
        }
        if (!redirected) findingIdToKey.delete(fid);
      }
    }

    // Build taskId lookup from results
    const agentTaskIds = new Map<string, string>();
    for (const r of successful) agentTaskIds.set(r.agentId, r.id);

    // Helper: get taskId with recoverable fallback (never empty string)
    const getTaskId = (agentId: string): string => {
      const id = agentTaskIds.get(agentId);
      if (id && id.length > 0) return id;
      _log('consensus', `WARNING: no taskId for agent "${agentId}", using fallback`);
      return `unknown-${consensusId}-${agentId}`;
    };

    // Helper: cap evidence to prevent unbounded signal payload sizes
    const MAX_EVIDENCE_LENGTH = 2000;
    const capEvidence = (e: string): string =>
      e.length > MAX_EVIDENCE_LENGTH ? e.slice(0, MAX_EVIDENCE_LENGTH) : e;

    // Helper: cap the severity of auto-emitted hallucination signals.
    //
    // Heuristic fabrication detection (verifyCitations + detectHallucination)
    // runs without human judgment — it can only inspect structural patterns
    // in text. When it fires on a finding whose *original* severity was
    // critical, the resulting hallucination_caught signal inherits that
    // severity AND the outcome='fabricated_citation' 3.0× multiplier in
    // performance-reader.ts:454. Combined, a single false positive on a
    // critical-severity meta-finding can move an agent 22 accuracy points
    // (demonstrated against sonnet-reviewer in consensus round
    // 99f15984-eb844568, retracted immediately after detection).
    //
    // Capping auto-emits at 'medium' is defense in depth: even after the
    // citation dedup + meta-reference exemption fixes from task #9, any
    // future false positive from this detection path has limited blast
    // radius on agent scores. Human-recorded signals via gossip_signals
    // can still carry critical severity because a human verified the
    // finding — the cap only applies to the automatic emit sites here in
    // synthesize().
    const capAutoSeverity = (s: 'critical' | 'high' | 'medium' | 'low' | undefined):
      'critical' | 'high' | 'medium' | 'low' =>
      s === 'critical' || s === 'high' ? 'medium' : (s ?? 'medium');

    // Helper: runs the fabrication pre-filter on a finding's own text and
    // emits hallucination_caught if the strict AND-gate fires (fabricated
    // citation + hallucination keyword). Returns true if the signal was
    // emitted, false otherwise.
    //
    // Originally the pre-filter was scoped to the confirmed branch only.
    // Tier 2 task #4 broadens it to cover the unverified and fallthrough
    // unique branches too, following gemini:f4 from consensus round
    // 82a3c123-19db41e7 and its re-confirmation in round 99f15984-eb844568.
    // The stale-file downgrade (fabricated without keywords) remains
    // confirmed-branch-only, because stale detection only makes sense when
    // peers confirmed the finding despite unresolvable citations — outside
    // that context we can't distinguish "stale after refactor" from
    // "fabricated from the start".
    const emitFabricationHallucinationIfDetected = async (
      entry: { originalAgentId: string; finding: string; severity?: 'critical' | 'high' | 'medium' | 'low'; category?: string },
    ): Promise<boolean> => {
      const hasFabricatedCitation = await this.verifyCitations(entry.finding, { strict: true });
      if (!hasFabricatedCitation) return false;
      const hasHallucinationKeywords = this.detectHallucination(entry.finding);
      if (!hasHallucinationKeywords) return false;
      signals.push({
        type: 'consensus',
        taskId: getTaskId(entry.originalAgentId),
        consensusId,
        signal: 'hallucination_caught',
        agentId: entry.originalAgentId,
        outcome: 'fabricated_citation',
        evidence: capEvidence(`Finding cites non-existent code: "${entry.finding.slice(0, 200)}"`),
        timestamp: new Date().toISOString(),
        severity: capAutoSeverity(entry.severity),
        category: entry.category,
      });
      return true;
    };

    // Helper: resolve cross-review entry to a findingMap key.
    // Tries findingId first (exact, fast), falls back to text matching (fuzzy, slow).
    const resolveEntry = (entry: CrossReviewEntry): string | null => {
      if (entry.findingId && findingIdToKey.has(entry.findingId)) {
        return findingIdToKey.get(entry.findingId)!;
      }
      return this.findMatchingFinding(findingMap, entry.peerAgentId, entry.finding);
    };

    // (b) Apply cross-review entries
    let newFindingIdx = 0;
    const crossReviewTimestamp = new Date().toISOString();
    for (const entry of crossReviewEntries) {
      const now = crossReviewTimestamp;

      if (entry.action === 'new') {
        // Sanitize before storage — strip XML-like tags that could be re-injected as instructions
        // in future sessions via gossip_remember() or session context loading.
        const sanitize = (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
        const newFindingId = `${consensusId}:${entry.agentId}:n${++newFindingIdx}`;
        newFindings.push({
          agentId: entry.agentId,
          finding: sanitize(entry.finding),
          evidence: sanitize(entry.evidence),
          confidence: entry.confidence,
        });
        signals.push({
          type: 'consensus',
          taskId: getTaskId(entry.agentId),
          consensusId,
          signal: 'new_finding',
          agentId: entry.agentId,
          evidence: capEvidence(entry.evidence),
          timestamp: now,
          findingId: newFindingId,
        });
        continue;
      }

      if (entry.action === 'agree') {
        const matchKey = resolveEntry(entry);
        const f = matchKey ? findingMap.get(matchKey) : undefined;
        if (matchKey && f) {
          f.confirmedBy.push(entry.agentId);
          f.confidences.push(entry.confidence);
          signals.push({
            type: 'consensus',
            taskId: getTaskId(entry.agentId),
            consensusId,
            signal: 'agreement',
            agentId: entry.agentId,
            counterpartId: entry.peerAgentId,
            evidence: capEvidence(entry.evidence),
            timestamp: now,
            severity: f.severity,
            category: f.category,
          });
        }
        continue;
      }

      if (entry.action === 'disagree') {
        const matchKey = resolveEntry(entry);
        const f = matchKey ? findingMap.get(matchKey) : undefined;
        if (matchKey && f) {
          f.confidences.push(entry.confidence);

          const isKeywordHallucination = this.detectHallucination(entry.evidence);
          const isCitationFabricated = await this.verifyCitations(entry.evidence);
          // AND gate: both keyword match AND fabricated citations required.
          // Prevents false positives from legitimate technical language
          // (e.g., "appendFileSync creates the file if it doesn't exist" matching "doesn't exist")
          const isHallucination = isKeywordHallucination && isCitationFabricated;

          if (isHallucination) {
            // Don't add fabricated disputes to the finding's disputedBy list —
            // they should not influence the confirmed/disputed tagging.
            // Penalize the REVIEWER who fabricated the disagreement, not the original author.
            // outcome is always 'fabricated_citation' here: isHallucination = isKeywordHallucination
            // && isCitationFabricated, so the second half is guaranteed true by construction.
            // The previous ternary `isCitationFabricated ? 'fabricated_citation' : 'incorrect'`
            // had an unreachable 'incorrect' branch. See consensus 82a3c123-19db41e7 Tier 1A Fix #2.
            signals.push({
              type: 'consensus',
              taskId: getTaskId(entry.agentId),
              consensusId,
              signal: 'hallucination_caught',
              agentId: entry.agentId,
              counterpartId: entry.peerAgentId,
              outcome: 'fabricated_citation',
              evidence: capEvidence(entry.evidence),
              timestamp: now,
              severity: capAutoSeverity(f.severity),
              category: f.category,
            });
          } else {
            const sanitizeEvidence = (t: string) => t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
            f.disputedBy.push({
              agentId: entry.agentId,
              reason: sanitizeEvidence(entry.evidence),
              evidence: sanitizeEvidence(entry.evidence),
            });
            signals.push({
              type: 'consensus',
              taskId: getTaskId(entry.agentId),
              consensusId,
              signal: 'disagreement',
              agentId: entry.agentId,
              counterpartId: entry.peerAgentId,
              evidence: capEvidence(entry.evidence),
              timestamp: now,
              severity: f.severity,
              category: f.category,
            });
          }
        }
      }

      if (entry.action === 'unverified') {
        const matchKey = resolveEntry(entry);
        const f = matchKey ? findingMap.get(matchKey) : undefined;
        if (matchKey && f) {
          f.unverifiedBy.push({
            agentId: entry.agentId,
            reason: entry.evidence,
          });
          f.confidences.push(entry.confidence);
          // Tiny penalty signal — agent couldn't verify, less useful than agree/disagree
          signals.push({
            type: 'consensus',
            taskId: getTaskId(entry.agentId),
            consensusId,
            signal: 'unverified',
            agentId: entry.agentId,
            counterpartId: entry.peerAgentId,
            evidence: capEvidence(entry.evidence),
            timestamp: now,
            severity: f.severity,
            category: f.category,
          });
        }
      }
    }

    // (c) Tag findings
    const confirmed: ConsensusFinding[] = [];
    const disputed: ConsensusFinding[] = [];
    const unverified: ConsensusFinding[] = [];
    const unique: ConsensusFinding[] = [];
    const insights: ConsensusFinding[] = [];
    let findingIdx = 0;
    const taggingTimestamp = new Date().toISOString();

    for (const [, entry] of findingMap) {
      findingIdx++;
      const avgConfidence = entry.confidences.length > 0
        ? entry.confidences.reduce((a, b) => a + b, 0) / entry.confidences.length
        : 3;

      const finding: ConsensusFinding = {
        id: `${consensusId}:f${findingIdx}`,
        authorFindingId: entry.authorFindingId,
        originalAgentId: entry.originalAgentId,
        finding: entry.finding,
        findingType: entry.findingType,
        severity: entry.severity,
        tag: 'unique',
        confirmedBy: entry.confirmedBy,
        disputedBy: entry.disputedBy,
        unverifiedBy: entry.unverifiedBy.length > 0 ? entry.unverifiedBy : undefined,
        confidence: Math.round(avgConfidence),
      };

      const now = taggingTimestamp;

      // Require disputes to outnumber or tie with confirmations before marking disputed.
      // A single malicious agent cannot override multiple confirmations (majority threshold).
      if (entry.disputedBy.length > 0 && entry.disputedBy.length >= entry.confirmedBy.length) {
        finding.tag = 'disputed';
        disputed.push(finding);
      } else if (entry.confirmedBy.length > 0) {
        // Pre-filter: check if finding cites non-existent code.
        // The helper handles the fabricated+keyword case; the confirmed
        // branch additionally handles the "fabricated but no keyword"
        // stale-file downgrade, which only makes sense when peers have
        // confirmed the finding (outside that context we cannot tell
        // "stale after refactor" from "fabricated from the start").
        if (await emitFabricationHallucinationIfDetected(entry)) {
          finding.tag = 'unique';
          unique.push(finding);
          continue;
        }
        const hasFabricatedCitation = await this.verifyCitations(entry.finding, { strict: true });
        if (hasFabricatedCitation) {
          // Citation failed but no hallucination keywords — likely stale/moved file
          // Downgrade to unique with softer signal instead of hallucination penalty
          finding.tag = 'unique';
          unique.push(finding);
          signals.push({
            type: 'consensus',
            taskId: getTaskId(entry.originalAgentId),
            consensusId,
            signal: 'unique_unconfirmed',
            agentId: entry.originalAgentId,
            evidence: capEvidence(`Confirmed finding has unresolvable citation (stale?): "${entry.finding.slice(0, 200)}"`),
            timestamp: now,
            severity: entry.severity,
            category: entry.category,
          });
          continue;
        }
        finding.tag = 'confirmed';
        confirmed.push(finding);
        // Emit unique_confirmed signal if only one agent originally found this
        const isUniquelyDiscovered = !Array.from(findingMap.values()).some(
          other => other !== entry && other.finding === entry.finding && other.originalAgentId !== entry.originalAgentId
        );
        if (isUniquelyDiscovered) {
          signals.push({
            type: 'consensus',
            taskId: getTaskId(entry.originalAgentId),
            consensusId,
            signal: 'unique_confirmed',
            agentId: entry.originalAgentId,
            evidence: capEvidence(entry.finding),
            timestamp: now,
            severity: entry.severity,
            category: entry.category,
          });
        }
      } else if (entry.unverifiedBy.length > 0) {
        // Route suggestions/insights to insights array instead of unverified
        if (entry.findingType === 'suggestion' || entry.findingType === 'insight') {
          finding.tag = 'unique'; // reuse unique tag for dashboard compat
          finding.findingType = entry.findingType;
          insights.push(finding);
          continue; // skip unverified signal — these aren't failures
        }
        // Tier 2: broadened pre-filter. If the unverified finding itself
        // cites non-existent code and contains hallucination keywords, it's
        // an author fabrication even though peers couldn't verify. Fire
        // hallucination_caught instead of the soft unique_unconfirmed.
        if (await emitFabricationHallucinationIfDetected(entry)) {
          finding.tag = 'unique';
          unique.push(finding);
          continue;
        }
        // Peers couldn't verify (wrong line number, missing context) — not a refutation
        finding.tag = 'unverified';
        unverified.push(finding);
        signals.push({
          type: 'consensus',
          taskId: getTaskId(entry.originalAgentId),
          consensusId,
          signal: 'unique_unconfirmed',
          agentId: entry.originalAgentId,
          evidence: capEvidence(entry.finding),
          timestamp: now,
          severity: entry.severity,
          category: entry.category,
        });
      } else {
        // Tier 2: broadened pre-filter. Same fabrication check for findings
        // that fell through without confirmation, dispute, or unverified mark.
        if (await emitFabricationHallucinationIfDetected(entry)) {
          finding.tag = 'unique';
          unique.push(finding);
          continue;
        }
        finding.tag = 'unique';
        unique.push(finding);
        signals.push({
          type: 'consensus',
          taskId: getTaskId(entry.originalAgentId),
          consensusId,
          signal: 'unique_unconfirmed',
          agentId: entry.originalAgentId,
          evidence: capEvidence(entry.finding),
          timestamp: now,
          severity: entry.severity,
          category: entry.category,
        });
      }
    }

    // (d) Generate formatted report
    const summary = this.formatReport(confirmed, disputed, unverified, unique, newFindings, successful.length, 2, undefined, insights);

    return {
      agentCount: successful.length,
      rounds: 2,
      confirmed,
      disputed,
      unverified,
      unique,
      insights,
      newFindings,
      signals,
      summary,
    };
  }

  /**
   * Extract code snippets for a single finding's file:line citations.
   * Returns formatted anchor blocks as a string, or '' if no citations found.
   */
  protected async snippetsForFinding(findingText: string, maxSnippets = 3): Promise<string> {
    if (!this.config.projectRoot) return '';

    const citationPattern = /((?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,6})):(\d+)/g;
    const CONTEXT_LINES = 2;
    const MAX_FILE_SIZE = 10 * 1024 * 1024;
    const anchors: string[] = [];
    const seen = new Set<string>();

    let match: RegExpExecArray | null;
    while ((match = citationPattern.exec(findingText)) !== null) {
      if (anchors.length >= maxSnippets) break;

      const fullRef = match[1];
      const bareFile = match[2];
      const lineNum = parseInt(match[3], 10);
      const key = `${fullRef}:${lineNum}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const safeRef = fullRef.replace(/["<>]/g, '');
        const filePath = await this.cachedResolve(fullRef) ?? await this.cachedResolve(bareFile);
        if (!filePath) {
          anchors.push(`⚠ Agent cited \`${safeRef}:${lineNum}\` but file not found`);
          continue;
        }
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_FILE_SIZE) continue;
        const content = await this.cachedRead(filePath);
        if (!content) continue;
        const fileLines = content.split('\n');
        if (lineNum > fileLines.length) {
          anchors.push(`⚠ Agent cited \`${safeRef}:${lineNum}\` but file has only ${fileLines.length} lines`);
          continue;
        }
        if (fileLines[lineNum - 1].trim() === '') {
          anchors.push(`⚠ Agent cited \`${safeRef}:${lineNum}\` but line is blank`);
          continue;
        }

        const start = Math.max(0, lineNum - 1 - CONTEXT_LINES);
        const end = Math.min(fileLines.length, lineNum + CONTEXT_LINES);
        const snippet = fileLines.slice(start, end)
          .map((l, i) => `  ${start + i + 1}: ${l}`)
          .join('\n');
        const safeSnippet = snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
        anchors.push(`<anchor src="${safeRef}:${lineNum}">\n${safeSnippet}\n</anchor>`);
      } catch { /* file unreadable, skip */ }
    }

    // Parse <cite> tags for additional anchors
    // <cite tag="file">auth.ts:38</cite> — resolved by file:line fetch (same as regex above, catches explicit citations)
    // <cite tag="fn">functionName</cite> — resolved by identifier grep
    // Also supports legacy <fn>identifier</fn> for backward compat
    if (this.config.projectRoot) {
      const citePattern = /<cite\s+tag="(file|fn)">([^<]+)<\/cite>/g;
      let citeMatch: RegExpExecArray | null;
      while ((citeMatch = citePattern.exec(findingText)) !== null) {
        if (anchors.length >= maxSnippets) break;
        const [, tag, value] = citeMatch;
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > 80) continue;

        if (tag === 'file') {
          // file:line citation — resolve via existing file resolver
          const fileMatch = trimmed.match(/^((?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,6})):(\d+)$/);
          if (fileMatch && !seen.has(trimmed)) {
            seen.add(trimmed);
            const fullRef = fileMatch[1];
            const bareFile = fileMatch[2];
            const lineNum = parseInt(fileMatch[3], 10);
            try {
              const safeRef = fullRef.replace(/["<>]/g, '');
              const filePath = await this.cachedResolve(fullRef) ?? await this.cachedResolve(bareFile);
              if (filePath) {
                const content = await this.cachedRead(filePath);
                if (content) {
                  const fileLines = content.split('\n');
                  if (lineNum <= fileLines.length && fileLines[lineNum - 1].trim() !== '') {
                    const start = Math.max(0, lineNum - 1 - CONTEXT_LINES);
                    const end = Math.min(fileLines.length, lineNum + CONTEXT_LINES);
                    const snippet = fileLines.slice(start, end).map((l, i) => `  ${start + i + 1}: ${l}`).join('\n');
                    const safeSnippet = snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
                    anchors.push(`<anchor src="${safeRef}:${lineNum}" via="cite:file">\n${safeSnippet}\n</anchor>`);
                  }
                }
              }
            } catch { /* skip */ }
          }
        } else if (tag === 'fn') {
          // function name — grep identifier
          const result = await this.grepIdentifier(trimmed);
          if (result) {
            const safeSnippet = result.snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
            anchors.push(`<anchor src="${result.file}:${result.line}" via="cite:fn:${trimmed}">\n${safeSnippet}\n</anchor>`);
          }
        }
      }

      // Legacy: bare <fn> tags (backward compat)
      if (anchors.length === 0) {
        const fnPattern = /<fn>([^<]+)<\/fn>/g;
        let fnMatch: RegExpExecArray | null;
        while ((fnMatch = fnPattern.exec(findingText)) !== null) {
          if (anchors.length >= maxSnippets) break;
          const identifier = fnMatch[1].trim();
          if (!identifier || identifier.length > 60) continue;
          const result = await this.grepIdentifier(identifier);
          if (result) {
            const safeSnippet = result.snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
            anchors.push(`<anchor src="${result.file}:${result.line}" via="fn:${identifier}">\n${safeSnippet}\n</anchor>`);
          }
        }
      }
    }

    return anchors.join('\n');
  }

  /**
   * Verify file:line citations in text against actual source code.
   * Returns true if the cited code is fabricated (file doesn't exist, line
   * doesn't match claim).
   *
   * Threshold modes:
   *   - `strict: false` (default, majority rule): returns true only when
   *     more than half of the extracted citations are unresolvable. This is
   *     the correct rule for the dispute path at :595, where a reviewer's
   *     evidence may legitimately cite multiple files and one bad citation
   *     out of many should not discard a valid refutation.
   *   - `strict: true` (any-failure rule): returns true when ANY cited
   *     line fails to resolve. Used by the pre-filter path at :710 to
   *     catch authors who fabricate even a single citation in an otherwise
   *     real-looking finding. The AND-gate with detectHallucination at
   *     :712 prevents false positives on legitimate stale-file refactor
   *     citations, and the stale-file downgrade branch at :716 catches
   *     post-refactor drift without firing hallucination_caught.
   *
   * This split lets Tier 1B lower the pre-filter threshold without
   * regressing the dispute-path's tolerance for partial bad citations.
   * See consensus round 82a3c123-19db41e7 Tier 1B Fix #3.
   */
  async verifyCitations(evidence: string, opts: { strict?: boolean } = {}): Promise<boolean> {
    const strict = opts.strict === true;
    if (!this.config.projectRoot) return false;

    // Verify the project root itself is accessible — if not, we can't verify anything
    try {
      await stat(this.config.projectRoot);
    } catch {
      // Project root inaccessible — benefit of doubt, not fabricated
      return false;
    }

    // Strip quoted / code-fenced / example-tagged content before citation
    // extraction. This prevents the pre-filter from penalizing findings that
    // describe fabrication detection by quoting example fake paths. Caught in
    // consensus round 99f15984-eb844568: sonnet's f5 finding about the
    // dispute-path attribution bug quoted `fake-file.ts:100` twice as part of
    // explaining the gemini:f1 scenario, and the pre-filter auto-emitted a
    // hallucination_caught signal against sonnet — the finding that was
    // correctly describing the bug that fired on it.
    //
    // Regions stripped:
    //   - Triple-backtick code fences (```...```)
    //   - Single-backtick inline code (`...`)
    //   - <example>...</example> tags (explicit meta-quote marker)
    //   - Content inside "double" or 'single' quote pairs on a single line
    //
    // All other <cite> tags and narrative prose are preserved so the regex
    // still catches real fabricated citations in the finding's own claims.
    const stripped = evidence
      .replace(/```[\s\S]*?```/g, '')          // fenced code blocks
      .replace(/`[^`\n]*`/g, '')               // inline code
      .replace(/<example>[\s\S]*?<\/example>/gi, '')
      .replace(/"[^"\n]*"/g, '')               // double-quoted strings
      .replace(/'[^'\n]*'/g, '');              // single-quoted strings

    // Extract file:line patterns like "task-dispatcher.ts:146" or "consensus-engine.ts:113"
    const citationPattern = /(?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,6}):(\d+)/g;
    const rawCitations: Array<{ file: string; line: number }> = [];
    let match;
    while ((match = citationPattern.exec(stripped)) !== null) {
      rawCitations.push({ file: match[1], line: parseInt(match[2], 10) });
    }

    // Dedupe by (file, line) tuple. Previously a finding that mentioned the
    // same citation twice in narrative text (e.g., "X at foo.ts:42 where
    // foo.ts:42 is broken") counted as two citations and doubled the weight
    // toward the majority/strict threshold — a silent gameable surface.
    // Same consensus round as above.
    const seen = new Set<string>();
    const citations: Array<{ file: string; line: number }> = [];
    for (const c of rawCitations) {
      const key = `${c.file}:${c.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push(c);
    }

    if (citations.length === 0) return false;

    // Require majority of citations to be unresolvable before calling it fabricated.
    // One bad filename out of 5 correct ones shouldn't discard a valid dispute.
    let failed = 0;
    for (const citation of citations) {
      try {
        const filePath = await this.cachedResolve(citation.file);
        if (!filePath) { failed++; continue; }

        const content = await this.cachedRead(filePath);
        if (!content) { failed++; continue; }
        const lines = content.split('\n');

        if (citation.line > lines.length) { failed++; continue; }
      } catch {
        // File read threw — count as failed. The previous "benefit of doubt"
        // behavior was an asymmetric escape hatch: I/O hiccups (EACCES, ENOENT
        // race, network FS latency) silently helped hallucinators by keeping
        // the failed counter at 0 even when citations could not be verified.
        // Counting errors as failures makes the I/O-failure case symmetric
        // with resolve-failure (line 972) and read-returned-null (line 975).
        // The pre-filter AND-gate at :700 (detectHallucination && fabricated
        // citation) is the blast-radius guard that prevents a single transient
        // error from firing hallucination_caught on its own. See consensus
        // round 82a3c123-19db41e7 Tier 1A Fix #5.
        failed++;
        continue;
      }
    }
    // Fabricated if (strict) any citation fails, otherwise majority.
    // The sonnet:new-f1 finding in round 99f15984-eb844568 caught a boundary
    // bug in the majority path: 1 of 2 bad citations is 1 > 1 === false,
    // so an author fabricating exactly half their citations always passed
    // the pre-filter under the old threshold. Tier 1B's strict mode closes
    // that escape hatch for the pre-filter path.
    return strict ? failed >= 1 : failed > citations.length / 2;
  }

  /**
   * Resolve a relative file reference to an absolute path within the project
   * OR within any active worktree (so findings created in a feature-branch
   * worktree can still be auto-anchored when consensus runs back in the main
   * MCP process).
   */
  /** Guard: resolved path must stay inside one of the valid roots */
  private isInsideAnyRoot(candidate: string, roots: string[]): boolean {
    const normalized = resolve(candidate);
    return roots.some(root => {
      const normalizedRoot = resolve(root);
      return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/');
    });
  }

  private async resolveFilePath(fileRef: string): Promise<string | null> {
    const roots = this.getValidRoots();
    if (roots.length === 0) return null;
    const fileName = fileRef.split('/').pop()!;

    // Try every root in order: projectRoot first (most files), then any
    // active worktree paths (for files only present on a feature branch).
    for (const root of roots) {
      // Try the reference as-is (could be a full relative path)
      try {
        const candidate = join(root, fileRef);
        if (this.isInsideAnyRoot(candidate, roots)) {
          await stat(candidate);
          return candidate;
        }
      } catch { /* not at this root */ }

      // Try bare filename at this root (covers eslint.config.ts, vite.config.ts, etc.)
      if (fileName !== fileRef) {
        try {
          const candidate = join(root, fileName);
          if (this.isInsideAnyRoot(candidate, roots)) {
            await stat(candidate);
            return candidate;
          }
        } catch { /* not at this root */ }
      }

      // Recursive search in common source directories under this root
      const searchDirs = ['packages', 'src', 'apps', 'tests', 'test', 'tools', 'scripts', 'lib'];
      for (const dir of searchDirs) {
        const found = await this.findFile(join(root, dir), fileName, roots);
        if (found) return found;
      }
    }

    return null;
  }

  private async findFile(dir: string, fileName: string, validRoots: string[]): Promise<string | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) {
          // Path traversal guard — findFile results must be inside one of
          // the valid roots (projectRoot or any active worktree).
          if (!this.isInsideAnyRoot(fullPath, validRoots)) return null;
          return fullPath;
        }
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          const found = await this.findFile(fullPath, fileName, validRoots);
          if (found) return found;
        }
      }
    } catch { /* directory doesn't exist or not readable */ }
    return null;
  }

  /**
   * Search source files for an identifier (function name, variable, class).
   * Returns the first definition-like match with surrounding context.
   */
  private async grepIdentifier(identifier: string): Promise<{ file: string; line: number; snippet: string } | null> {
    const roots = this.getValidRoots();
    if (roots.length === 0) return null;

    const CONTEXT_LINES = 2;
    const searchDirs = ['packages', 'src', 'apps', 'tests', 'test', 'tools', 'scripts', 'lib'];
    const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx']);

    // Search every root in order — projectRoot first, then any active worktree
    // (so identifiers defined only on a feature branch can still be located).
    for (const root of roots) {
      for (const dir of searchDirs) {
        const result = await this.grepDir(join(root, dir), identifier, sourceExts, CONTEXT_LINES);
        if (result) return result;
      }
    }
    return null;
  }

  private async grepDir(
    dir: string,
    identifier: string,
    exts: Set<string>,
    contextLines: number,
  ): Promise<{ file: string; line: number; snippet: string } | null> {
    // For display, strip whichever valid root prefixes the result so the
    // returned file path is relative. Iterate roots — projectRoot first,
    // then any active worktree — and use the first one that matches.
    const validRoots = this.getValidRoots();
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'dist') {
          const found = await this.grepDir(fullPath, identifier, exts, contextLines);
          if (found) return found;
        }
        if (!entry.isFile()) continue;
        const ext = entry.name.slice(entry.name.lastIndexOf('.'));
        if (!exts.has(ext)) continue;

        const content = await this.cachedRead(fullPath);
        if (!content) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(identifier)) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length, i + 1 + contextLines);
            const snippet = lines.slice(start, end)
              .map((l, idx) => `  ${start + idx + 1}: ${l}`)
              .join('\n');
            let relPath = fullPath;
            for (const root of validRoots) {
              if (fullPath.startsWith(root + '/')) {
                relPath = fullPath.slice(root.length + 1);
                break;
              }
            }
            return { file: relPath, line: i + 1, snippet };
          }
        }
      }
    } catch { /* directory not readable */ }
    return null;
  }

  /**
   * Detect if disagreement evidence indicates a hallucination.
   */
  private detectHallucination(evidence: string): boolean {
    // Use word-boundary regex to avoid false positives on legitimate text.
    // Each pattern must match as a complete phrase, not a substring of a larger sentence.
    const patterns = [
      /\bdoes not exist\b/,
      /\bdoesn'?t exist\b/,
      /\bno such file\b/,
      /\bno such function\b/,
      /\bno such method\b/,
      /\bno such variable\b/,
      /\bfile not found\b/,
      /\bfunction not found\b/,
      /\bmethod not found\b/,
      /\bline is a comment\b/,
      /\bfile only has \d/,
      /\bno line \d/,
      /\bnonexistent\b/,
      /\bnon-existent\b/,
      /\bnever defined\b/,
      /\bis not defined in\b/,
      /\bnot defined anywhere\b/,
      /\bfabricated\b/,
      /\bhallucinated\b/,
    ];
    const lower = evidence.toLowerCase();
    return patterns.some(re => re.test(lower));
  }

  /**
   * Find a matching finding in the map for a given peer agent and finding text.
   * 3-tier matching: exact, substring, word overlap.
   */
  private findMatchingFinding(
    findingMap: Map<string, { originalAgentId: string; finding: string; confirmedBy: string[]; disputedBy: Array<{ agentId: string; reason: string; evidence: string }>; unverifiedBy: Array<{ agentId: string; reason: string }>; confidences: number[] }>,
    peerAgentId: string,
    findingText: string,
  ): string | null {
    // Tier 0: Normalized match (lowercase, strip punctuation, collapse whitespace)
    const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    const normalizedText = normalize(findingText);
    for (const [key, entry] of findingMap) {
      if (entry.originalAgentId !== peerAgentId) continue;
      if (normalize(entry.finding) === normalizedText) return key;
    }

    // Tier 1: Exact match
    const exactKey = `${peerAgentId}::${findingText}`;
    if (findingMap.has(exactKey)) return exactKey;

    // Tier 2: Case-insensitive substring match (either direction)
    // Require minimum length to prevent short phrases ("race condition") from matching everything
    const MIN_SUBSTRING_LENGTH = 25;
    const lowerText = findingText.toLowerCase();
    for (const [key, entry] of findingMap) {
      if (entry.originalAgentId !== peerAgentId) continue;
      const lowerFinding = entry.finding.toLowerCase();
      const shorter = Math.min(lowerText.length, lowerFinding.length);
      if (shorter >= MIN_SUBSTRING_LENGTH && (lowerFinding.includes(lowerText) || lowerText.includes(lowerFinding))) {
        return key;
      }
    }

    // Tier 3: Significant word overlap >50%
    const significantWords = (text: string) =>
      text.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const textWords = significantWords(findingText);
    if (textWords.length === 0) return null;

    for (const [key, entry] of findingMap) {
      if (entry.originalAgentId !== peerAgentId) continue;
      const findingWords = significantWords(entry.finding);
      if (findingWords.length === 0) continue;
      const overlap = textWords.filter(w => findingWords.includes(w)).length;
      const overlapRatio = overlap / Math.max(textWords.length, findingWords.length);
      if (overlapRatio > 0.5) return key;
    }

    return null;
  }

  /**
   * Parse <agent_finding> tags from raw agent output into structured findings.
   * Extracted so it can be unit-tested independently of synthesize().
   */
  private parseAgentFindings(_agentId: string, raw: string): Array<{
    findingType: 'finding' | 'suggestion' | 'insight';
    severity?: 'critical' | 'high' | 'medium' | 'low';
    category?: string;
    content: string;
    hasAnchor: boolean;
  }> {
    // Cap is generous (8 KB) so that long-form findings from verbose agents
    // (gemini-reviewer has emitted 5–6 KB single blocks) still parse. The old
    // 2 KB cap silently dropped them, which forced bullet-fallback and broke
    // finding-ID roundtrip to cross-review — see consensus round
    // c8dae78e-b6334267 for the canonical example. Over-cap findings are
    // truncated (with an ellipsis marker) rather than rejected so the signal
    // is preserved even for runaway outputs.
    const MAX_FINDING_CONTENT = 8000;
    const agentFindingPattern = /<agent_finding\s+([^>]*)>([\s\S]*?)<\/agent_finding>/g;
    const out: Array<{
      findingType: 'finding' | 'suggestion' | 'insight';
      severity?: 'critical' | 'high' | 'medium' | 'low';
      category?: string;
      content: string;
      hasAnchor: boolean;
    }> = [];
    let afMatch: RegExpExecArray | null;
    while ((afMatch = agentFindingPattern.exec(raw)) !== null) {
      const attrs = afMatch[1];
      let content = afMatch[2].trim();
      if (!content || content.length < 15) continue;
      if (content.length > MAX_FINDING_CONTENT) {
        _log('consensus',
          `⚠ agent "${_agentId}" emitted an <agent_finding> of ${content.length} chars ` +
          `(cap ${MAX_FINDING_CONTENT}) — truncating rather than dropping. ` +
          `Consider splitting into multiple tagged findings.`
        );
        content = content.slice(0, MAX_FINDING_CONTENT) + '\n…[truncated]';
      }

      const typeMatch = attrs.match(/type="(finding|suggestion|insight)"/);
      if (!typeMatch) continue;
      const severityMatch = attrs.match(/severity="(critical|high|medium|low)"/);
      const categoryMatch = attrs.match(/category="([a-z_]+)"/);

      out.push({
        findingType: typeMatch[1] as 'finding' | 'suggestion' | 'insight',
        severity: severityMatch?.[1] as 'critical' | 'high' | 'medium' | 'low' | undefined,
        category: categoryMatch?.[1],
        content,
        hasAnchor: ANCHOR_PATTERN.test(content),
      });
    }
    return out;
  }

  /**
   * Semantic dedup: merge findings from different agents that describe the same issue.
   * Uses file path extraction + Jaccard word overlap to detect duplicates.
   * When found, the duplicate is removed and the second agent is added as a co-discoverer
   * (pre-populates confirmedBy so the finding starts as confirmed, not split).
   */
  private deduplicateFindings(
    findingMap: Map<string, {
      originalAgentId: string;
      finding: string;
      findingType?: 'finding' | 'suggestion' | 'insight';
      severity?: 'critical' | 'high' | 'medium' | 'low';
      category?: string;
      confirmedBy: string[];
      disputedBy: Array<{ agentId: string; reason: string; evidence: string }>;
      unverifiedBy: Array<{ agentId: string; reason: string }>;
      confidences: number[];
    }>,
  ): void {
    const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const entries = Array.from(findingMap.entries());
    const toRemove = new Set<string>();

    // Extract file references from a finding
    const extractFile = (text: string): string | null => {
      const match = text.match(/([a-zA-Z][\w.-]+\.[a-z]{1,6})/);
      return match ? match[1].toLowerCase() : null;
    };

    // No stop words — static lists can't distinguish boilerplate from signal.
    // Use raw word overlap with high thresholds instead.
    const significantWords = (text: string) =>
      text.toLowerCase().split(/\W+/).filter(w => w.length > 3);

    for (let i = 0; i < entries.length; i++) {
      const [keyA, entryA] = entries[i];
      if (toRemove.has(keyA)) continue;

      for (let j = i + 1; j < entries.length; j++) {
        const [keyB, entryB] = entries[j];
        if (toRemove.has(keyB)) continue;
        // Only dedup across different agents
        if (entryA.originalAgentId === entryB.originalAgentId) continue;

        // Check if they reference the same file
        const fileA = extractFile(entryA.finding);
        const fileB = extractFile(entryB.finding);
        const sameFile = fileA && fileB && fileA === fileB;

        // Jaccard similarity on significant words
        const wordsA = significantWords(entryA.finding);
        const wordsB = significantWords(entryB.finding);
        if (wordsA.length === 0 || wordsB.length === 0) continue;

        const overlap = wordsA.filter(w => wordsB.includes(w)).length;
        const union = new Set([...wordsA, ...wordsB]).size;
        const jaccard = overlap / union;

        // High thresholds, no stop words — prefer missed dedup over false merge
        const shouldMerge = sameFile ? jaccard > 0.6 : jaccard > 0.7;

        if (shouldMerge) {
          // Prefer the finding with a file:line citation (more actionable)
          const hasCitationA = /:\d+/.test(entryA.finding);
          const hasCitationB = /:\d+/.test(entryB.finding);
          if (!hasCitationA && hasCitationB) {
            // B is more precise — swap: merge A into B
            entryB.confirmedBy.push(entryA.originalAgentId);
            entryB.confidences.push(4);
            // Preserve findingType: 'finding' wins over suggestion/insight (most actionable)
            if (entryA.findingType === 'finding') entryB.findingType = 'finding';
            // Severity: highest wins
            if (entryA.severity && (!entryB.severity || (SEVERITY_RANK[entryA.severity] || 0) > (SEVERITY_RANK[entryB.severity] || 0))) entryB.severity = entryA.severity;
            // Inherit category from loser if winner has none (never overwrite a real category)
            if (entryA.category && !entryB.category) entryB.category = entryA.category;
            toRemove.add(keyA);
            _log('consensus',
              `Dedup: merged "${entryA.finding.slice(0, 60)}..." (${entryA.originalAgentId}) into "${entryB.finding.slice(0, 60)}..." (${entryB.originalAgentId}) [B more precise]`
            );
            break; // A is removed, stop comparing it
          }
          // Default: merge B into A
          entryA.confirmedBy.push(entryB.originalAgentId);
          entryA.confidences.push(4); // high confidence — independent discovery
          if (entryB.findingType === 'finding') entryA.findingType = 'finding';
          if (entryB.severity && (!entryA.severity || (SEVERITY_RANK[entryB.severity] || 0) > (SEVERITY_RANK[entryA.severity] || 0))) entryA.severity = entryB.severity;
          if (entryB.category && !entryA.category) entryA.category = entryB.category;
          toRemove.add(keyB);
          _log('consensus',
            `Dedup: merged "${entryB.finding.slice(0, 60)}..." (${entryB.originalAgentId}) into "${entryA.finding.slice(0, 60)}..." (${entryA.originalAgentId})`
          );
        }
      }
    }

    for (const key of toRemove) {
      findingMap.delete(key);
    }
  }

  /**
   * Format the consensus report as a human-readable string.
   */
  private formatReport(
    confirmed: ConsensusFinding[],
    disputed: ConsensusFinding[],
    unverified: ConsensusFinding[],
    unique: ConsensusFinding[],
    newFindings: ConsensusNewFinding[],
    agentCount: number,
    rounds = 2,
    timing?: { totalMs?: number; perAgent?: Array<{ agentId: string; durationMs: number }>; crossReviewMs?: number },
    insights?: ConsensusFinding[],
  ): string {
    const bar = '═══════════════════════════════════════════';
    const lines: string[] = [];

    lines.push(bar);
    const timingStr = timing?.totalMs ? `, ${Math.round(timing.totalMs / 1000)}s` : '';
    lines.push(`CONSENSUS REPORT (${agentCount} agents, ${rounds} rounds${timingStr})`);
    if (timing?.perAgent?.length) {
      const agentTimes = timing.perAgent.map(a => `${a.agentId}: ${Math.round(a.durationMs / 1000)}s`).join(' | ');
      const crossReview = timing.crossReviewMs ? ` | cross-review: ${Math.round(timing.crossReviewMs / 1000)}s` : '';
      lines.push(`  ${agentTimes}${crossReview}`);
    }
    lines.push(bar);
    lines.push('');

    if (confirmed.length > 0) {
      lines.push('CONFIRMED (high confidence — act on these):');
      for (const f of confirmed) {
        const origPreset = this.config.registryGet(f.originalAgentId)?.preset || f.originalAgentId;
        const confirmerPresets = f.confirmedBy.map(id => this.config.registryGet(id)?.preset || id).join(', ');
        const sev = f.severity ? ` [${f.severity.toUpperCase()}]` : '';
        lines.push(`  ✓ [${origPreset} + ${confirmerPresets}]${sev} ${f.finding}`);
      }
      lines.push('');
    }

    if (disputed.length > 0) {
      lines.push('DISPUTED (agents disagree — review the evidence):');
      for (const f of disputed) {
        const origPreset = this.config.registryGet(f.originalAgentId)?.preset || f.originalAgentId;
        lines.push(`  ⚡ [${origPreset} vs ${f.disputedBy.map(d => this.config.registryGet(d.agentId)?.preset || d.agentId).join(', ')}] "${f.finding}"`);
        lines.push(`    → ${origPreset}: original finding`);
        for (const d of f.disputedBy) {
          const dispPreset = this.config.registryGet(d.agentId)?.preset || d.agentId;
          lines.push(`    → ${dispPreset}: ${d.reason}`);
        }
      }
      lines.push('');
    }

    if (unverified.length > 0) {
      lines.push('UNVERIFIED (peers could not verify — likely valid but needs manual check):');
      for (const f of unverified) {
        const origPreset = this.config.registryGet(f.originalAgentId)?.preset || f.originalAgentId;
        const unvNames = f.unverifiedBy?.map(u => this.config.registryGet(u.agentId)?.preset || u.agentId).join(', ') || '?';
        const sevU = f.severity ? ` [${f.severity.toUpperCase()}]` : '';
        lines.push(`  ◇ [${origPreset}, unverified by ${unvNames}]${sevU} "${f.finding}"`);
        lines.push(`    → finding_id: "${f.id}" — pass to gossip_signals when resolving`);
      }
      lines.push('');
    }

    if (unique.length > 0) {
      lines.push('UNIQUE (one agent only — verify before acting):');
      for (const f of unique) {
        const preset = this.config.registryGet(f.originalAgentId)?.preset || f.originalAgentId;
        const sevQ = f.severity ? ` [${f.severity.toUpperCase()}]` : '';
        lines.push(`  ? [${preset}]${sevQ} "${f.finding}"`);
      }
      lines.push('');
    }

    if (newFindings.length > 0) {
      lines.push('NEW (discovered during cross-review):');
      for (const f of newFindings) {
        const preset = this.config.registryGet(f.agentId)?.preset || f.agentId;
        lines.push(`  ★ [${preset}] "${f.finding}"`);
      }
      lines.push('');
    }

    if (insights && insights.length > 0) {
      lines.push('');
      lines.push('INSIGHTS (suggestions and observations — not code-verifiable):');
      for (const f of insights) {
        const type = f.findingType === 'suggestion' ? '💡' : '🔍';
        lines.push(`  ${type} [${f.originalAgentId}] ${f.finding}`);
      }
    }

    lines.push(bar);
    lines.push(`Summary: ${confirmed.length} confirmed, ${disputed.length} disputed, ${unverified.length} unverified, ${unique.length} unique, ${insights?.length ?? 0} insights, ${newFindings.length} new`);
    lines.push(bar);

    // EXECUTE NOW block: pre-fill signal recording for the orchestrator.
    // This is the same pattern as the utility-task block in gossip_relay — surface the
    // requirement at the moment the orchestrator has the data needed to act on it,
    // not buried in bootstrap rules that decay as the conversation grows.
    // newFindings are excluded — ConsensusNewFinding has no stable id (not in findingMap)
    const actionable = [
      ...confirmed.map(f => ({ kind: 'confirmed' as const, f })),
      ...disputed.map(f => ({ kind: 'disputed' as const, f })),
      ...unverified.map(f => ({ kind: 'unverified' as const, f })),
      ...unique.map(f => ({ kind: 'unique' as const, f })),
    ].filter(x => x.f.id); // skip findings without a stable ID

    if (actionable.length > 0) {
      lines.push('');
      lines.push('⚠️  EXECUTE NOW — record signals for these findings before continuing:');
      lines.push('');
      lines.push('Verify each finding against the code, then call gossip_signals to record the result.');
      lines.push('Every signal MUST include finding_id (already pre-filled below) so the dashboard can');
      lines.push('back-trace the signal to the consensus round and the affected agent score.');
      lines.push('');
      lines.push('Suggested signal type per status:');
      lines.push('  CONFIRMED  → "agreement" (peer agreed) or "unique_confirmed" (you verified solo)');
      lines.push('  DISPUTED   → "hallucination_caught" (if you verify the finding is wrong)');
      lines.push('  UNVERIFIED → "unique_confirmed" (if you verify it) or "hallucination_caught" (if not)');
      lines.push('  UNIQUE     → "unique_confirmed" (verify, then record) or "hallucination_caught"');
      lines.push('');
      lines.push('Pre-filled finding_ids for this round:');
      for (const { kind, f } of actionable) {
        const agentId = f.originalAgentId || 'unknown';
        const truncated = f.finding.length > 80 ? f.finding.slice(0, 77) + '...' : f.finding;
        lines.push(`  [${kind.toUpperCase()}] agent_id: "${agentId}", finding_id: "${f.id}"`);
        lines.push(`     ${truncated}`);
      }
      lines.push('');
      lines.push('Example call:');
      lines.push('  gossip_signals(action: "record", signals: [{');
      lines.push('    signal: "unique_confirmed",  // pick from the list above');
      lines.push('    agent_id: "<agent_id from above>",');
      lines.push('    finding: "<one-line description>",');
      lines.push(`    finding_id: "<finding_id from above>"`);
      lines.push('  }])');
      lines.push('');
      lines.push('Skipping this step leaves agent scores stale and breaks the back-search from');
      lines.push('dashboard finding → signal → score adjustment. Record signals before moving on.');
      lines.push(bar);
    }

    return lines.join('\n');
  }

  /**
   * Parse LLM cross-review response into structured entries.
   *
   * Robust against the failure modes we see from real LLMs (especially Gemini):
   *   1. Plain JSON                                              → JSON.parse
   *   2. Fenced JSON (```json ... ```)                            → fence strip + parse
   *   3. JSON wrapped in prose                                   → balanced-bracket array extraction
   *   4. Single object instead of array                          → wrap in array
   *   5. NDJSON / multiple {} objects with prose between them    → object salvage
   *
   * Bracket extraction is string-aware (respects "..." and \-escapes) so quoted
   * strings containing `]` or `}` no longer break the scan. When all strategies
   * fail, the raw payload is dumped to .gossip/cross-review-failures/ for triage.
   */
  parseCrossReviewResponse(reviewerAgentId: string, text: string, limit: number): CrossReviewEntry[] {
    // Strip markdown code fences if present (Gemini often wraps JSON in prose + fences)
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    let parsed: unknown;

    // Strategy 1: parse the whole cleaned blob
    try {
      parsed = JSON.parse(cleaned);
    } catch { /* fall through */ }

    // Strategy 2: balanced-bracket array extraction (string-aware)
    if (parsed === undefined) {
      parsed = this.extractFirstBalancedJson(cleaned, '[');
    }

    // Strategy 3: salvage individual {} objects from prose-interleaved output
    if (parsed === undefined || (Array.isArray(parsed) && parsed.length === 0)) {
      const objects = this.salvageJsonObjects(cleaned);
      if (objects.length > 0) parsed = objects;
    }

    if (parsed === undefined) {
      if (cleaned.length > 0) {
        _log('consensus', `${reviewerAgentId} cross-review response is not valid JSON (${cleaned.length} chars)`);
        this.dumpFailedCrossReview(reviewerAgentId, text);
      }
      return [];
    }

    // Single-object response → wrap into a one-element array
    if (!Array.isArray(parsed)) {
      if (parsed && typeof parsed === 'object') {
        parsed = [parsed];
      } else {
        _log('consensus', `${reviewerAgentId} cross-review response is not an array`);
        this.dumpFailedCrossReview(reviewerAgentId, text);
        return [];
      }
    }

    // SECURITY: Limit the number of entries to prevent DoS attacks.
    const limited = (parsed as unknown[]).slice(0, limit);

    const entries: CrossReviewEntry[] = [];
    for (const raw of limited) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.action !== 'string' || !VALID_ACTIONS.has(item.action)) continue;
      if (!item.finding || !item.evidence) continue;

      // Clamp confidence to 1-5, default 3 if missing/non-numeric
      let confidence: number;
      if (typeof item.confidence === 'number' && !isNaN(item.confidence)) {
        confidence = Math.max(1, Math.min(5, item.confidence));
      } else {
        confidence = 3;
      }

      // Derive peerAgentId from findingId (e.g., "gemini-reviewer:f1" → "gemini-reviewer")
      // Fall back to item.agentId for backward compatibility
      const findingId = typeof item.findingId === 'string' ? item.findingId : '';
      const peerFromId = findingId.includes(':') ? findingId.split(':')[0] : '';
      const fallbackAgentId = typeof item.agentId === 'string' ? item.agentId : '';
      entries.push({
        action: item.action as CrossReviewEntry['action'],
        agentId: reviewerAgentId,
        peerAgentId: peerFromId || fallbackAgentId,
        findingId: findingId || undefined,
        finding: String(item.finding),
        evidence: String(item.evidence),
        confidence,
      });
    }

    return entries;
  }

  /**
   * Find the first balanced JSON value (`[...]` or `{...}`) embedded in arbitrary
   * text. String-aware: respects `"..."` and `\`-escapes so quoted brackets do
   * not break the scan. Returns the parsed value, or undefined if no balanced
   * block parses successfully.
   */
  private extractFirstBalancedJson(text: string, openChar: '[' | '{'): unknown {
    const closeChar = openChar === '[' ? ']' : '}';
    let start = text.indexOf(openChar);
    while (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === openChar) depth++;
        else if (c === closeChar) {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(text.slice(start, i + 1)); }
            catch { break; } // give up on this start, advance to next openChar
          }
        }
      }
      start = text.indexOf(openChar, start + 1);
    }
    return undefined;
  }

  /**
   * Salvage individual JSON objects from prose-interleaved LLM output.
   * Walks the text finding every balanced `{...}` block and tries to parse
   * each. Used as a last resort when neither full-text parse nor array
   * extraction yields a usable result.
   */
  private salvageJsonObjects(text: string): unknown[] {
    const out: unknown[] = [];
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf('{', i);
      if (start === -1) break;
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let j = start; j < text.length; j++) {
        const c = text[j];
        if (escape) { escape = false; continue; }
        if (c === '\\') { escape = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') depth++;
        else if (c === '}') {
          depth--;
          if (depth === 0) { end = j; break; }
        }
      }
      if (end === -1) break; // unbalanced — bail out
      try {
        const obj = JSON.parse(text.slice(start, end + 1));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj);
      } catch { /* skip this block */ }
      i = end + 1;
    }
    return out;
  }

  /**
   * Best-effort dump of an unparseable cross-review payload to disk so the
   * raw LLM output is recoverable for debugging. Silent on failure — never
   * blocks the consensus pipeline.
   */
  private dumpFailedCrossReview(reviewerAgentId: string, text: string): void {
    if (!this.config.projectRoot) return;
    try {
      const dir = join(this.config.projectRoot, '.gossip', 'cross-review-failures');
      mkdirSync(dir, { recursive: true });
      const safeId = reviewerAgentId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      writeFileSync(join(dir, `${safeId}-${ts}.txt`), text);
    } catch { /* best effort */ }
  }

  /**
   * Synthesize a consensus report from externally-provided cross-review entries.
   * Used in the two-phase flow where native agents perform their own cross-review
   * and feed results back via gossip_relay_cross_review.
   */
  async synthesizeWithCrossReview(
    results: TaskEntry[],
    crossReviewEntries: CrossReviewEntry[],
    consensusId: string,
    relayCrossReviewSkipped?: Array<{ agentId: string; reason: string }>,
  ): Promise<ConsensusReport> {
    const report = await this.synthesize(results, crossReviewEntries);

    // Capture the auto-generated (internal) consensusId BEFORE overwriting it,
    // so we can also rewrite the formatted summary text. The summary was built
    // by formatReport() inside synthesize() using the internal IDs — without
    // this rewrite the orchestrator sees one set of finding IDs in the EXECUTE
    // NOW block while signals/findings on disk are stored under another set,
    // leaving rounds permanently flagged as "signals pending" even after the
    // orchestrator records them. The auto-generated ID format is the short
    // hex pair "<8hex>-<8hex>" set by shortConsensusId(); pull it from any
    // existing signal before we overwrite that field.
    const internalConsensusId = report.signals.find(s => s.consensusId)?.consensusId;

    // Overwrite the auto-generated consensusId with the one from phase 1
    for (const signal of report.signals) {
      signal.consensusId = consensusId;
    }
    // Also update finding IDs to use the provided consensusId
    const allFindings = [...report.confirmed, ...report.disputed, ...report.unverified, ...report.unique, ...(report.insights || [])];
    for (const f of allFindings) {
      if (f.id) {
        const suffix = f.id.split(':').pop() || f.id;
        f.id = `${consensusId}:${suffix}`;
      }
    }

    // Rewrite the summary text so the EXECUTE NOW pre-filled finding_ids
    // match what's actually stored on disk. Anchor the replace on the colon
    // suffix that always follows a consensusId in a finding_id reference
    // (`<consensusId>:<agentId>:fN`) — this eliminates the theoretical risk
    // of an unrelated 8hex-8hex pattern in finding text being silently
    // rewritten (e.g., a git SHA fragment, a UUID slice, a nonce).
    if (internalConsensusId && internalConsensusId !== consensusId) {
      report.summary = report.summary.split(`${internalConsensusId}:`).join(`${consensusId}:`);
    }

    // Surface dropped relay agents so the orchestrator can see who silently
    // failed instead of pretending the round was complete.
    if (relayCrossReviewSkipped && relayCrossReviewSkipped.length > 0) {
      report.relayCrossReviewSkipped = relayCrossReviewSkipped;
      const lines = ['', '⚠️  Relay cross-review skipped:'];
      for (const s of relayCrossReviewSkipped) {
        lines.push(`  - ${s.agentId}: ${s.reason}`);
      }
      report.summary += '\n' + lines.join('\n') + '\n';
    }

    return report;
  }
}
