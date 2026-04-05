import { readFile, readdir, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';

/** Generate a short consensus round ID: xxxxxxxx-xxxxxxxx (17 chars from UUID) */
function shortConsensusId(): string {
  const hex = randomUUID().replace(/-/g, '');
  return hex.slice(0, 8) + '-' + hex.slice(8, 16);
}
import { LLMMessage } from '@gossip/types';
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
const VALID_ACTIONS = new Set(['agree', 'disagree', 'unverified', 'new']);

export interface ConsensusEngineConfig {
  llm: ILLMProvider;
  registryGet: (agentId: string) => AgentConfig | undefined;
  projectRoot?: string;
  agentLlm?: (agentId: string) => ILLMProvider | undefined;
}

export class ConsensusEngine {
  protected readonly config: ConsensusEngineConfig;
  private fileCache = new Map<string, string | null>();
  private pathCache = new Map<string, string | null>();

  constructor(config: ConsensusEngineConfig) {
    this.config = config;
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
      this.fileCache.set(filePath, null);
      return null;
    }
  }

  extractSummary(result: string): string {
    const idx = result.indexOf(SUMMARY_HEADER);
    if (idx !== -1) {
      const afterHeader = result.slice(idx + SUMMARY_HEADER.length).trimStart();
      // Only stop at the next markdown header (##), not at blank lines
      // — summaries often have blank-line-separated bullet points
      const nextHeader = afterHeader.search(/\n##\s/);
      let end = afterHeader.length;
      if (nextHeader !== -1) end = Math.min(end, nextHeader);
      // Cap extracted summary to prevent unbounded prompt sizes
      return afterHeader.slice(0, Math.min(end, MAX_SUMMARY_LENGTH)).trim();
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
    process.stderr.write(`[consensus] Starting cross-review for ${successful.length} agents\n`);
    const crossReviewStart = Date.now();
    const crossReviewEntries = await this.dispatchCrossReview(results);
    const crossReviewMs = Date.now() - crossReviewStart;
    process.stderr.write(`[consensus] Cross-review complete: ${crossReviewEntries.length} entries (${Math.round(crossReviewMs / 1000)}s)\n`);

    const synthesizeStart = Date.now();
    const report = await this.synthesize(results, crossReviewEntries);
    const synthesizeMs = Date.now() - synthesizeStart;
    // Build per-agent timing from task results
    const perAgent = successful.map(r => ({
      agentId: r.agentId,
      durationMs: (r.completedAt && r.startedAt) ? r.completedAt - r.startedAt : 0,
    }));
    process.stderr.write(`[consensus] Synthesis: ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unverified.length} unverified, ${report.unique.length} unique, ${report.newFindings.length} new (${Math.round(synthesizeMs / 1000)}s)\n`);

    const totalMs = Date.now() - consensusStart;
    const timing = { totalMs, perAgent, crossReviewMs, synthesizeMs };
    process.stderr.write(`[consensus] Total: ${Math.round(totalMs / 1000)}s (cross-review: ${Math.round(crossReviewMs / 1000)}s, synthesis: ${Math.round(synthesizeMs / 1000)}s)\n`);
    // Always regenerate report with timing data
    report.summary = this.formatReport(report.confirmed, report.disputed, report.unverified, report.unique, report.newFindings, successful.length, report.rounds, timing, report.insights);

    return report;
  }

  /**
   * Phase 2: Send cross-review prompts to each agent and collect structured responses.
   * Each agent reviews all peer summaries and produces agree/disagree/new entries.
   */
  async dispatchCrossReview(results: TaskEntry[]): Promise<CrossReviewEntry[]> {
    const successful = results.filter(r => r.status === 'completed' && r.result);
    if (successful.length < 2) return [];

    // Build summary map: agentId -> extracted + sanitized summary
    const summaries = new Map<string, string>();
    for (const r of successful) {
      const raw = this.extractSummary(r.result!);
      // Escape </data> to prevent prompt fence escape (agent output could contain the literal tag)
      summaries.set(r.agentId, raw.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, ''));
    }

    // Dispatch cross-review in parallel, each agent reviews peers
    const allEntries = await Promise.all(
      successful.map(async agent => {
        const start = Date.now();
        const entries = await this.crossReviewForAgent(agent, summaries);
        process.stderr.write(`[consensus] ${agent.agentId} cross-review: ${entries.length} entries (${Math.round((Date.now() - start) / 1000)}s)\n`);
        return entries;
      })
    );

    return allEntries.flat();
  }

  /**
   * Build the cross-review prompt for a single agent without calling the LLM.
   */
  private async buildCrossReviewPrompt(
    agent: TaskEntry,
    summaries: Map<string, string>,
  ): Promise<{ system: string; user: string }> {
    const ownSummary = summaries.get(agent.agentId) ?? '';

    // Build peer findings section — parse <agent_finding> tags and assign stable IDs
    const peerLines: string[] = [];
    const agentFindingPattern = /<agent_finding\s+([^>]*)>([\s\S]*?)<\/agent_finding>/g;
    const MAX_ANCHORS_PER_SUMMARY = 15;

    for (const [peerId, peerSummary] of summaries) {
      if (peerId === agent.agentId) continue;
      const peerConfig = this.config.registryGet(peerId);
      const preset = peerConfig?.preset ?? 'unknown';

      // Extract individual findings from <agent_finding> tags and assign IDs
      const findings: Array<{ id: string; attrs: string; content: string }> = [];
      let afMatch: RegExpExecArray | null;
      const pattern = new RegExp(agentFindingPattern.source, agentFindingPattern.flags);
      let findingIdx = 0;
      while ((afMatch = pattern.exec(peerSummary)) !== null) {
        const attrs = afMatch[1];
        const content = afMatch[2].trim();
        // MUST match synthesize() filtering exactly: length 15-2000, type attribute required.
        // If these filters diverge, findingIdx goes out of sync → wrong finding confirmed/disputed.
        if (!content || content.length < 15 || content.length > 2000) continue;
        if (!attrs.match(/type="(finding|suggestion|insight)"/)) continue;
        findingIdx++;
        findings.push({ id: `${peerId}:f${findingIdx}`, attrs, content });
      }

      let peerBlock: string;
      if (findings.length > 0) {
        // Structured: numbered findings with IDs and inline code anchors
        const findingBlocks: string[] = [];
        let anchorCount = 0;
        for (const f of findings) {
          let block = `[${f.id}] <agent_finding ${f.attrs}>${f.content}</agent_finding>`;
          // Attach code snippets for verification
          if (this.config.projectRoot && anchorCount < MAX_ANCHORS_PER_SUMMARY) {
            const snippets = await this.snippetsForFinding(f.content);
            if (snippets) {
              block += '\n' + snippets;
              anchorCount += (snippets.match(/<anchor /g) || []).length;
            }
          }
          findingBlocks.push(block);
        }
        peerBlock = `Agent "${peerId}" (${preset}):\n<data>${findingBlocks.join('\n\n')}</data>`;
      } else {
        // Fallback: no structured findings found, use raw summary with line-level anchors
        const summaryLines = peerSummary.split('\n');
        const annotatedLines: string[] = [];
        let anchorCount = 0;
        for (const line of summaryLines) {
          annotatedLines.push(line);
          const trimmed = line.trim();
          if (trimmed && this.config.projectRoot && anchorCount < MAX_ANCHORS_PER_SUMMARY) {
            const snippets = await this.snippetsForFinding(trimmed);
            if (snippets) {
              annotatedLines.push(snippets);
              anchorCount += (snippets.match(/<anchor /g) || []).length;
            }
          }
        }
        peerBlock = `Agent "${peerId}" (${preset}):\n<data>${annotatedLines.join('\n')}</data>`;
      }
      peerLines.push(peerBlock);
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
   */
  private async crossReviewForAgent(
    agent: TaskEntry,
    summaries: Map<string, string>,
  ): Promise<CrossReviewEntry[]> {
    const { system, user } = await this.buildCrossReviewPrompt(agent, summaries);
    const messages: LLMMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    try {
      const llm = this.config.agentLlm?.(agent.agentId) ?? this.config.llm;
      const response = await llm.generate(messages, { temperature: 0 });
      if (!response.text?.trim()) {
        process.stderr.write(`[consensus] ${agent.agentId} returned empty cross-review response\n`);
        return [];
      }
      const validPeerIds = new Set(summaries.keys());
      const entries = this.parseCrossReviewResponse(agent.agentId, response.text, MAX_CROSS_REVIEW_ENTRIES);
      if (entries.length === 0) {
        process.stderr.write(`[consensus] ${agent.agentId} cross-review parsed to 0 entries (response length: ${response.text.length})\n`);
      }
      // Filter: no self-references, peerAgentId must be a real agent in this batch
      return entries.filter(e => e.peerAgentId !== agent.agentId && validPeerIds.has(e.peerAgentId));
    } catch (err) {
      process.stderr.write(`[consensus] ${agent.agentId} cross-review LLM call failed: ${(err as Error).message}\n`);
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
    const successful = results.filter(r => r.status === 'completed' && r.result);
    const consensusId = shortConsensusId();

    const summaries = new Map<string, string>();
    for (const r of successful) {
      const raw = this.extractSummary(r.result!);
      summaries.set(r.agentId, raw.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, ''));
    }

    const prompts: Array<{ agentId: string; system: string; user: string; isNative: boolean }> = [];
    for (const agent of successful) {
      const { system, user } = await this.buildCrossReviewPrompt(agent, summaries);
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
    const consensusId = shortConsensusId();
    const signals: ConsensusSignal[] = [];
    const newFindings: ConsensusNewFinding[] = [];
    const successful = results.filter(r => r.status === 'completed' && r.result);

    // (a) Seed finding map from Phase 1 results
    const findingMap = new Map<string, {
      originalAgentId: string;
      finding: string;
      findingType?: 'finding' | 'suggestion' | 'insight';
      severity?: 'critical' | 'high' | 'medium' | 'low';
      confirmedBy: string[];
      disputedBy: Array<{ agentId: string; reason: string; evidence: string }>;
      unverifiedBy: Array<{ agentId: string; reason: string }>;
      confidences: number[];
    }>();

    const ANCHOR_PATTERN = /[\w./-]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|md|json|yaml|yml|toml|sh):\d+/;

    // findingId → findingMap key lookup (for cross-review matching by ID)
    const findingIdToKey = new Map<string, string>();

    for (const r of successful) {
      const summary = this.extractSummary(r.result!);
      let agentFindingsFound = 0;

      // Primary: parse <agent_finding> tags from raw summary
      const agentFindingPattern = /<agent_finding\s+([^>]*)>([\s\S]*?)<\/agent_finding>/g;
      let afMatch: RegExpExecArray | null;
      let findingIdx = 0;
      while ((afMatch = agentFindingPattern.exec(summary)) !== null) {
        const attrs = afMatch[1];
        const content = afMatch[2].trim();
        if (!content || content.length < 15 || content.length > 2000) continue;

        const typeMatch = attrs.match(/type="(finding|suggestion|insight)"/);
        if (!typeMatch) continue;
        const severityMatch = attrs.match(/severity="(critical|high|medium|low)"/);

        findingIdx++;
        const findingType = typeMatch[1] as 'finding' | 'suggestion' | 'insight';
        const severity = severityMatch?.[1] as 'critical' | 'high' | 'medium' | 'low' | undefined;
        const key = `${r.agentId}::${content}`;
        const hasAnchor = ANCHOR_PATTERN.test(content);

        // Register stable findingId matching the IDs assigned in buildCrossReviewPrompt
        const findingId = `${r.agentId}:f${findingIdx}`;
        findingIdToKey.set(findingId, key);

        findingMap.set(key, {
          originalAgentId: r.agentId,
          finding: content,
          findingType,
          severity,
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: hasAnchor ? [] : [2],
        });
        agentFindingsFound++;
      }

      // Per-agent fallback: if THIS agent produced no tags, use legacy bullet parsing
      if (agentFindingsFound === 0) {
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

    // Prune findingIdToKey: dedup may have deleted keys from findingMap
    for (const [fid, key] of findingIdToKey) {
      if (!findingMap.has(key)) findingIdToKey.delete(fid);
    }

    // Build taskId lookup from results
    const agentTaskIds = new Map<string, string>();
    for (const r of successful) agentTaskIds.set(r.agentId, r.id);

    // Helper: get taskId with recoverable fallback (never empty string)
    const getTaskId = (agentId: string): string => {
      const id = agentTaskIds.get(agentId);
      if (id && id.length > 0) return id;
      process.stderr.write(`[consensus] WARNING: no taskId for agent "${agentId}", using fallback\n`);
      return `unknown-${consensusId}-${agentId}`;
    };

    // Helper: cap evidence to prevent unbounded signal payload sizes
    const MAX_EVIDENCE_LENGTH = 2000;
    const capEvidence = (e: string): string =>
      e.length > MAX_EVIDENCE_LENGTH ? e.slice(0, MAX_EVIDENCE_LENGTH) : e;

    // Helper: resolve cross-review entry to a findingMap key.
    // Tries findingId first (exact, fast), falls back to text matching (fuzzy, slow).
    const resolveEntry = (entry: CrossReviewEntry): string | null => {
      if (entry.findingId && findingIdToKey.has(entry.findingId)) {
        return findingIdToKey.get(entry.findingId)!;
      }
      return this.findMatchingFinding(findingMap, entry.peerAgentId, entry.finding);
    };

    // (b) Apply cross-review entries
    const crossReviewTimestamp = new Date().toISOString();
    for (const entry of crossReviewEntries) {
      const now = crossReviewTimestamp;

      if (entry.action === 'new') {
        newFindings.push({
          agentId: entry.agentId,
          finding: entry.finding,
          evidence: entry.evidence,
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
            signals.push({
              type: 'consensus',
              taskId: getTaskId(entry.agentId),
              consensusId,
              signal: 'hallucination_caught',
              agentId: entry.agentId,
              counterpartId: entry.peerAgentId,
              outcome: isCitationFabricated ? 'fabricated_citation' : 'incorrect',
              evidence: capEvidence(entry.evidence),
              timestamp: now,
              severity: f.severity,
            });
          } else {
            f.disputedBy.push({
              agentId: entry.agentId,
              reason: entry.evidence,
              evidence: entry.evidence,
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

      if (entry.disputedBy.length > 0) {
        finding.tag = 'disputed';
        disputed.push(finding);
      } else if (entry.confirmedBy.length > 0) {
        // Pre-filter: check if finding cites non-existent code
        // Requires BOTH keyword hallucination AND fabricated citation (AND gate)
        // to avoid false positives from stale/moved files after refactoring
        const hasFabricatedCitation = await this.verifyCitations(entry.finding);
        const hasHallucinationKeywords = this.detectHallucination(entry.finding);
        if (hasFabricatedCitation && hasHallucinationKeywords) {
          finding.tag = 'unique';
          unique.push(finding);
          signals.push({
            type: 'consensus',
            taskId: getTaskId(entry.originalAgentId),
            consensusId,
            signal: 'hallucination_caught',
            agentId: entry.originalAgentId,
            outcome: 'fabricated_citation',
            evidence: capEvidence(`Confirmed finding cites non-existent code: "${entry.finding.slice(0, 200)}"`),
            timestamp: now,
            severity: entry.severity,
          });
          continue;
        } else if (hasFabricatedCitation) {
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
        });
      } else {
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
   * Verify file:line citations in disagreement evidence against actual source code.
   * Returns true if any citation is fabricated (file doesn't exist, line doesn't match claim).
   */
  async verifyCitations(evidence: string): Promise<boolean> {
    if (!this.config.projectRoot) return false;

    // Verify the project root itself is accessible — if not, we can't verify anything
    try {
      await stat(this.config.projectRoot);
    } catch {
      // Project root inaccessible — benefit of doubt, not fabricated
      return false;
    }

    // Extract file:line patterns like "task-dispatcher.ts:146" or "consensus-engine.ts:113"
    const citationPattern = /(?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,6}):(\d+)/g;
    const citations: Array<{ file: string; line: number }> = [];
    let match;
    while ((match = citationPattern.exec(evidence)) !== null) {
      citations.push({ file: match[1], line: parseInt(match[2], 10) });
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
        // File read failed — benefit of doubt, don't count as failed
        continue;
      }
    }
    // Fabricated if more than half of citations are invalid
    return failed > citations.length / 2;
  }

  /**
   * Resolve a relative file reference to an absolute path within the project.
   */
  /** Guard: resolved path must stay within project root */
  private isInsideRoot(candidate: string, root: string): boolean {
    const normalized = resolve(candidate);
    const normalizedRoot = resolve(root);
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + '/');
  }

  private async resolveFilePath(fileRef: string): Promise<string | null> {
    const root = this.config.projectRoot!;
    const fileName = fileRef.split('/').pop()!;

    // Try the reference as-is (could be a full relative path)
    try {
      const candidate = join(root, fileRef);
      if (!this.isInsideRoot(candidate, root)) return null; // path traversal guard
      await stat(candidate);
      return candidate;
    } catch { /* not found at root */ }

    // Try bare filename at project root (covers eslint.config.ts, vite.config.ts, etc.)
    if (fileName !== fileRef) {
      try {
        const candidate = join(root, fileName);
        if (!this.isInsideRoot(candidate, root)) return null;
        await stat(candidate);
        return candidate;
      } catch { /* not at root */ }
    }

    // Recursive search in common source directories (including tests, tools, lib)
    const searchDirs = ['packages', 'src', 'apps', 'tests', 'test', 'tools', 'scripts', 'lib'];
    for (const dir of searchDirs) {
      const found = await this.findFile(join(root, dir), fileName);
      if (found) return found;
    }

    return null;
  }

  private async findFile(dir: string, fileName: string): Promise<string | null> {
    const root = this.config.projectRoot;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) {
          // Path traversal guard — findFile results must be inside project root
          if (root && !this.isInsideRoot(fullPath, root)) return null;
          return fullPath;
        }
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
          const found = await this.findFile(fullPath, fileName);
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
    const root = this.config.projectRoot;
    if (!root) return null;

    const CONTEXT_LINES = 2;
    const searchDirs = ['packages', 'src', 'apps', 'tests', 'test', 'tools', 'scripts', 'lib'];
    const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx']);

    for (const dir of searchDirs) {
      const result = await this.grepDir(join(root, dir), identifier, sourceExts, CONTEXT_LINES);
      if (result) return result;
    }
    return null;
  }

  private async grepDir(
    dir: string,
    identifier: string,
    exts: Set<string>,
    contextLines: number,
  ): Promise<{ file: string; line: number; snippet: string } | null> {
    const root = this.config.projectRoot;
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
            const relPath = root ? fullPath.replace(root + '/', '') : fullPath;
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
            toRemove.add(keyA);
            process.stderr.write(
              `[consensus] Dedup: merged "${entryA.finding.slice(0, 60)}..." (${entryA.originalAgentId}) into "${entryB.finding.slice(0, 60)}..." (${entryB.originalAgentId}) [B more precise]\n`
            );
            break; // A is removed, stop comparing it
          }
          // Default: merge B into A
          entryA.confirmedBy.push(entryB.originalAgentId);
          entryA.confidences.push(4); // high confidence — independent discovery
          if (entryB.findingType === 'finding') entryA.findingType = 'finding';
          if (entryB.severity && (!entryA.severity || (SEVERITY_RANK[entryB.severity] || 0) > (SEVERITY_RANK[entryA.severity] || 0))) entryA.severity = entryB.severity;
          toRemove.add(keyB);
          process.stderr.write(
            `[consensus] Dedup: merged "${entryB.finding.slice(0, 60)}..." (${entryB.originalAgentId}) into "${entryA.finding.slice(0, 60)}..." (${entryA.originalAgentId})\n`
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

    return lines.join('\n');
  }

  /**
   * Parse LLM cross-review response into structured entries.
   * Handles markdown code fences, invalid JSON, and confidence clamping.
   */
  parseCrossReviewResponse(reviewerAgentId: string, text: string, limit: number): CrossReviewEntry[] {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Fallback: try to extract a JSON array from within the text (native agents often wrap JSON in prose)
      const jsonArrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonArrayMatch) {
        try {
          parsed = JSON.parse(jsonArrayMatch[0]);
        } catch {
          // Still not valid JSON
        }
      }
      if (!parsed) {
        if (cleaned.length > 0) {
          process.stderr.write(`[consensus] ${reviewerAgentId} cross-review response is not valid JSON (${cleaned.length} chars)\n`);
        }
        return [];
      }
    }

    if (!Array.isArray(parsed)) {
      process.stderr.write(`[consensus] ${reviewerAgentId} cross-review response is not an array\n`);
      return [];
    }

    // SECURITY: Limit the number of entries to prevent DoS attacks.
    const limited = parsed.slice(0, limit);

    const entries: CrossReviewEntry[] = [];
    for (const item of limited) {
      if (!item || typeof item !== 'object') continue;
      if (!VALID_ACTIONS.has(item.action)) continue;
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
      const findingId = item.findingId ?? '';
      const peerFromId = findingId.includes(':') ? findingId.split(':')[0] : '';
      entries.push({
        action: item.action as CrossReviewEntry['action'],
        agentId: reviewerAgentId,
        peerAgentId: peerFromId || item.agentId || '',
        findingId: findingId || undefined,
        finding: item.finding,
        evidence: item.evidence,
        confidence,
      });
    }

    return entries;
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
  ): Promise<ConsensusReport> {
    const report = await this.synthesize(results, crossReviewEntries);

    // Overwrite the auto-generated consensusId with the one from phase 1
    for (const signal of report.signals) {
      signal.consensusId = consensusId;
    }
    // Also update finding IDs to use the provided consensusId
    const allFindings = [...report.confirmed, ...report.disputed, ...report.unverified, ...report.unique, ...(report.insights || [])];
    for (const f of allFindings) {
      if (f.id) {
        // Replace auto-generated prefix with provided consensusId
        const suffix = f.id.split(':').pop() || f.id;
        f.id = `${consensusId}:${suffix}`;
      }
    }

    return report;
  }
}
