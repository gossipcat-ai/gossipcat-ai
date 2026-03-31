import { readFile, readdir, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';
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
        confirmed: [], disputed: [], unverified: [], unique: [], newFindings: [], signals: [],
        summary: 'Consensus skipped: insufficient agents (need ≥2 successful).',
      };
    }

    const consensusStart = Date.now();
    process.stderr.write(`[consensus] Starting cross-review for ${successful.length} agents\n`);
    const crossReviewStart = Date.now();
    const crossReviewEntries = await this.dispatchCrossReview(results);
    const crossReviewMs = Date.now() - crossReviewStart;
    process.stderr.write(`[consensus] Cross-review complete: ${crossReviewEntries.length} entries (${Math.round(crossReviewMs / 1000)}s)\n`);

    const report = await this.synthesize(results, crossReviewEntries);
    // Build per-agent timing from task results
    const perAgent = successful.map(r => ({
      agentId: r.agentId,
      durationMs: (r.completedAt && r.startedAt) ? r.completedAt - r.startedAt : 0,
    }));
    const totalMs = Date.now() - consensusStart;
    const timing = { totalMs, perAgent, crossReviewMs };
    process.stderr.write(`[consensus] ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unverified.length} unverified, ${report.unique.length} unique, ${report.newFindings.length} new\n`);

    // Phase 3: Orchestrator verification of UNVERIFIED findings
    if (report.unverified.length > 0) {
      process.stderr.write(`[consensus] Phase 3: verifying ${report.unverified.length} unverified findings\n`);
      await this.verifyUnverified(report, successful);
      process.stderr.write(`[consensus] After verification: ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unverified.length} unverified\n`);
    }

    // Always regenerate report with timing data
    report.summary = this.formatReport(report.confirmed, report.disputed, report.unverified, report.unique, report.newFindings, successful.length, report.rounds, timing);

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
      successful.map(agent => this.crossReviewForAgent(agent, summaries))
    );

    return allEntries.flat();
  }

  /**
   * Build the cross-review prompt for a single agent and call the LLM.
   */
  private async crossReviewForAgent(
    agent: TaskEntry,
    summaries: Map<string, string>,
  ): Promise<CrossReviewEntry[]> {
    const ownSummary = summaries.get(agent.agentId) ?? '';

    // Build peer findings section with per-finding inline code snippets
    const peerLines: string[] = [];
    for (const [peerId, peerSummary] of summaries) {
      if (peerId === agent.agentId) continue;
      const peerConfig = this.config.registryGet(peerId);
      const preset = peerConfig?.preset ?? 'unknown';

      // Split summary into individual findings and attach code snippets to each
      const summaryLines = peerSummary.split('\n');
      const annotatedLines: string[] = [];
      for (const line of summaryLines) {
        annotatedLines.push(line);
        // Only fetch snippets for non-empty lines that might contain citations
        const trimmed = line.trim();
        if (trimmed && this.config.projectRoot) {
          const snippets = await this.snippetsForFinding(trimmed);
          if (snippets) annotatedLines.push(snippets);
        }
      }

      // SECURITY: Wrap external LLM output in <data> tags to prevent prompt injection.
      const peerBlock = `Agent "${peerId}" (${preset}):\n<data>${annotatedLines.join('\n')}</data>`;
      peerLines.push(peerBlock);
    }

    const userContent = `You previously reviewed code and produced findings. Now review your peers' findings.

YOUR FINDINGS (Phase 1):
<data>${ownSummary}</data>

PEER FINDINGS (each finding with a file:line citation has a short code anchor inline):
${peerLines.join('\n\n')}

For each peer finding, you MUST:
1. If the finding has an inline <anchor> block, use it to verify the claim against actual code
2. Only AGREE if the claim is factually accurate based on the actual code
3. DISAGREE if the code contradicts the claim (e.g., finding says "no validation" but code has validation)

Respond with one of:
- AGREE: The finding is factually correct — you verified it against the code. Cite your evidence.
- DISAGREE: The finding is factually incorrect — the code shows otherwise. Cite file:line and what the code actually does.
- UNVERIFIED: You cannot verify or refute this finding — no anchor is present, the line number is wrong, or you lack sufficient context. This is NOT disagreement — it means "I can't confirm or deny."
- NEW: Something ALL agents missed that you now realize after seeing peer work.

IMPORTANT: Use DISAGREE only when you have evidence the finding is WRONG. Use UNVERIFIED when you simply cannot check it. "I can't find line 172" is UNVERIFIED, not DISAGREE.

Return ONLY a JSON array:
[
  { "action": "agree"|"disagree"|"unverified"|"new", "agentId": "peer_id", "finding": "summary", "evidence": "your reasoning with file:line references", "confidence": 1-5 }
]`;

    const messages: LLMMessage[] = [
      { role: 'system', content: `You are a code reviewer performing cross-review. Your job is to verify peer findings against actual code — catch errors, but also confirm good work.

VERIFICATION RULES:
- If a finding has an <anchor> block, use the code shown to verify the claim
- AGREE only if you can confirm the claim is factually correct — cite your evidence
- DISAGREE only if you have concrete evidence the finding is WRONG — the code contradicts the claim
- UNVERIFIED if an anchor is missing for a cited file, the line number is wrong, or the code in the anchor is insufficient to verify the claim. First try to reason about the claim's plausibility from what you CAN see. Only use UNVERIFIED as a last resort when you truly cannot assess the claim.
- Do NOT agree with a finding just because it sounds plausible — verify it
- Agreeing without verification is WORSE than disagreeing — a false confirmation poisons the system

Return only valid JSON.` },
      { role: 'user', content: userContent },
    ];

    try {
      const response = await this.config.llm.generate(messages, { temperature: 0 });
      const validPeerIds = new Set(summaries.keys());
      const entries = this.parseCrossReviewResponse(agent.agentId, response.text, MAX_CROSS_REVIEW_ENTRIES);
      // Filter: no self-references, peerAgentId must be a real agent in this batch
      return entries.filter(e => e.peerAgentId !== agent.agentId && validPeerIds.has(e.peerAgentId));
    } catch {
      // Graceful degradation: skip agents whose LLM call fails
      return [];
    }
  }

  /**
   * Phase 3: Synthesize Phase 1 results and Phase 2 cross-review entries into a consensus report.
   */
  async synthesize(results: TaskEntry[], crossReviewEntries: CrossReviewEntry[]): Promise<ConsensusReport> {
    const consensusId = randomUUID().slice(0, 12);
    const signals: ConsensusSignal[] = [];
    const newFindings: ConsensusNewFinding[] = [];
    const successful = results.filter(r => r.status === 'completed' && r.result);

    // (a) Seed finding map from Phase 1 results
    const findingMap = new Map<string, {
      originalAgentId: string;
      finding: string;
      confirmedBy: string[];
      disputedBy: Array<{ agentId: string; reason: string; evidence: string }>;
      unverifiedBy: Array<{ agentId: string; reason: string }>;
      confidences: number[];
    }>();

    for (const r of successful) {
      const summary = this.extractSummary(r.result!);
      const lines = summary.split('\n').filter(l => l.trimStart().startsWith('-'));
      for (const line of lines) {
        const finding = line.replace(/^\s*-\s*/, '').trim();
        if (!finding) continue;
        const key = `${r.agentId}::${finding}`;
        findingMap.set(key, {
          originalAgentId: r.agentId,
          finding,
          confirmedBy: [],
          disputedBy: [],
          unverifiedBy: [],
          confidences: [],
        });
      }
    }

    // (a.2) Semantic dedup: merge findings across agents that describe the same issue
    this.deduplicateFindings(findingMap);

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
        const matchKey = this.findMatchingFinding(findingMap, entry.peerAgentId, entry.finding);
        if (matchKey) {
          const f = findingMap.get(matchKey)!;
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
          });
        }
        continue;
      }

      if (entry.action === 'disagree') {
        const matchKey = this.findMatchingFinding(findingMap, entry.peerAgentId, entry.finding);
        if (matchKey) {
          const f = findingMap.get(matchKey)!;
          f.confidences.push(entry.confidence);

          const isKeywordHallucination = this.detectHallucination(entry.evidence);
          const isCitationFabricated = !isKeywordHallucination
            ? await this.verifyCitations(entry.evidence)
            : false;
          const isHallucination = isKeywordHallucination || isCitationFabricated;

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
            });
          }
        }
      }

      if (entry.action === 'unverified') {
        const matchKey = this.findMatchingFinding(findingMap, entry.peerAgentId, entry.finding);
        if (matchKey) {
          const f = findingMap.get(matchKey)!;
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
          });
        }
      }
    }

    // (c) Tag findings
    const confirmed: ConsensusFinding[] = [];
    const disputed: ConsensusFinding[] = [];
    const unverified: ConsensusFinding[] = [];
    const unique: ConsensusFinding[] = [];
    let findingIdx = 0;
    const taggingTimestamp = new Date().toISOString();

    for (const [, entry] of findingMap) {
      findingIdx++;
      const avgConfidence = entry.confidences.length > 0
        ? entry.confidences.reduce((a, b) => a + b, 0) / entry.confidences.length
        : 3;

      const finding: ConsensusFinding = {
        id: `f${findingIdx}`,
        originalAgentId: entry.originalAgentId,
        finding: entry.finding,
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
        // Pre-filter: check if finding cites non-existent code (cheap structural check)
        const hasFabricatedCitation = await this.verifyCitations(entry.finding);
        if (hasFabricatedCitation) {
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
          });
        }
      } else if (entry.unverifiedBy.length > 0) {
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
        });
      }
    }

    // (d) Generate formatted report
    const summary = this.formatReport(confirmed, disputed, unverified, unique, newFindings, successful.length);

    return {
      agentCount: successful.length,
      rounds: 2,
      confirmed,
      disputed,
      unverified,
      unique,
      newFindings,
      signals,
      summary,
    };
  }

  /**
   * Phase 3: Orchestrator verifies UNVERIFIED findings by reading actual code.
   * Single batch LLM call with ±10 lines of context per finding.
   * Promotes findings to CONFIRMED or DISPUTED; remaining stay UNVERIFIED.
   * Mutates the report in place.
   */
  private async verifyUnverified(report: ConsensusReport, results: TaskEntry[]): Promise<void> {
    if (!this.config.projectRoot || report.unverified.length === 0) return;

    // Build agent → taskId map (same as synthesize)
    const agentTaskIds = new Map<string, string>();
    for (const r of results) agentTaskIds.set(r.agentId, r.id);
    const getTaskId = (agentId: string): string => {
      const id = agentTaskIds.get(agentId);
      if (id && id.length > 0) return id;
      return `phase3-${agentId}-${Date.now()}`;
    };

    const citationPattern = /((?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,6})):(\d+)/;
    const VERIFY_CONTEXT = 10; // ±10 lines for deeper context than cross-review anchors
    const MAX_VERIFY = 20; // cap findings per batch to bound prompt size
    const MAX_SNIPPET_CHARS = 3000; // per-finding snippet cap

    // Build finding blocks with code context
    const findingBlocks: Array<{ idx: number; finding: ConsensusFinding; block: string }> = [];

    for (let i = 0; i < Math.min(report.unverified.length, MAX_VERIFY); i++) {
      const f = report.unverified[i];
      const match = citationPattern.exec(f.finding);

      let codeBlock = '';
      if (match) {
        const fullRef = match[1];
        const bareFile = match[2];
        const lineNum = parseInt(match[3], 10);

        try {
          const filePath = await this.cachedResolve(fullRef) ?? await this.cachedResolve(bareFile);
          if (filePath) {
            const content = await this.cachedRead(filePath);
            if (content) {
              const fileLines = content.split('\n');
              if (lineNum <= fileLines.length) {
                const start = Math.max(0, lineNum - 1 - VERIFY_CONTEXT);
                const end = Math.min(fileLines.length, lineNum + VERIFY_CONTEXT);
                let snippet = fileLines.slice(start, end)
                  .map((l, j) => `  ${start + j + 1}: ${l}`)
                  .join('\n');
                if (snippet.length > MAX_SNIPPET_CHARS) {
                  snippet = snippet.slice(0, MAX_SNIPPET_CHARS) + '\n  [truncated]';
                }
                const safeSnippet = snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
                codeBlock = `\n<code src="${fullRef}:${lineNum}">\n${safeSnippet}\n</code>`;
              }
            }
          }
        } catch { /* skip code context on error */ }
      } else {
        // Fallback: try to find a bare filename in the finding text and load first 30 lines
        const bareFilePattern = /(?:[\s`"'(]|^)(([\w./-]+\/)?([a-zA-Z][\w.-]+\.(jsonl?|md|ts|tsx|js|jsx|yaml|yml|toml)))(?:[\s`"',.):]|$)/;
        const bareMatch = bareFilePattern.exec(f.finding);
        if (bareMatch) {
          try {
            const fileRef = bareMatch[1];
            const filePath = await this.cachedResolve(fileRef);
            if (filePath) {
              const content = await this.cachedRead(filePath);
              if (content) {
                const fileLines = content.split('\n');
                const headEnd = Math.min(fileLines.length, 30);
                let snippet = fileLines.slice(0, headEnd)
                  .map((l, j) => `  ${j + 1}: ${l}`)
                  .join('\n');
                if (snippet.length > MAX_SNIPPET_CHARS) {
                  snippet = snippet.slice(0, MAX_SNIPPET_CHARS) + '\n  [truncated]';
                }
                const safeSnippet = snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
                codeBlock = `\n<code type="file-head" src="${fileRef}" lines="${fileLines.length}">\n${safeSnippet}\n</code>`;
              }
            }
          } catch { /* skip */ }
        }
      }

      findingBlocks.push({
        idx: i,
        finding: f,
        block: `Finding ${i + 1} (by ${f.originalAgentId}):\n"${f.finding}"${codeBlock}`,
      });
    }

    if (findingBlocks.length === 0) return;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a senior code verification agent. Your task is to verify findings that peer reviewers could not verify during cross-review.

For each finding:
- If the code is shown and the finding is FACTUALLY CORRECT based on the code, respond CONFIRMED
- If the code is shown and the finding is FACTUALLY WRONG (the code contradicts the claim), respond DISPUTED with evidence
- If you cannot determine correctness (no code shown, claim is subjective, or insufficient context), respond UNVERIFIED

Be strict: only CONFIRMED if you can see the evidence in the code. Only DISPUTED if the code clearly contradicts the claim.

Return ONLY a JSON array:
[{ "index": 1, "verdict": "CONFIRMED"|"DISPUTED"|"UNVERIFIED", "evidence": "brief explanation" }]`,
      },
      {
        role: 'user',
        content: `Verify these ${findingBlocks.length} unverified findings:\n\n${findingBlocks.map(fb => fb.block).join('\n\n---\n\n')}`,
      },
    ];

    try {
      const response = await this.config.llm.generate(messages, { temperature: 0 });

      // Parse response
      const text = response.text.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim();
      const verdicts: Array<{ index: number; verdict: string; evidence: string }> = JSON.parse(text);
      if (!Array.isArray(verdicts)) return;

      const consensusId = report.signals[0]?.consensusId ?? randomUUID().slice(0, 12);
      const now = new Date().toISOString();

      // Process verdicts — deduplicate by index to prevent double-promotion
      const toRemove: number[] = [];
      const processed = new Set<number>();
      for (const v of verdicts) {
        const fbIdx = v.index - 1; // 1-indexed from LLM
        if (processed.has(fbIdx)) continue;
        const fb = findingBlocks[fbIdx];
        if (!fb || !v.verdict) continue;
        processed.add(fbIdx);

        const verdict = v.verdict.toUpperCase();
        if (verdict === 'CONFIRMED') {
          fb.finding.tag = 'confirmed';
          fb.finding.confirmedBy = [...fb.finding.confirmedBy, '_orchestrator'];
          report.confirmed.push(fb.finding);
          toRemove.push(fb.idx);
          report.signals.push({
            type: 'consensus', signal: 'unique_confirmed', consensusId,
            agentId: fb.finding.originalAgentId,
            evidence: `Phase 3 orchestrator verified: ${(v.evidence || '').slice(0, 200)}`,
            timestamp: now, taskId: getTaskId(fb.finding.originalAgentId),
          });
        } else if (verdict === 'DISPUTED') {
          fb.finding.tag = 'disputed';
          fb.finding.disputedBy = [...fb.finding.disputedBy, {
            agentId: '_orchestrator',
            reason: (v.evidence || 'Orchestrator verification found the claim incorrect').slice(0, 300),
            evidence: (v.evidence || '').slice(0, 300),
          }];
          report.disputed.push(fb.finding);
          toRemove.push(fb.idx);
          report.signals.push({
            type: 'consensus', signal: 'hallucination_caught', consensusId,
            agentId: fb.finding.originalAgentId,
            evidence: `Phase 3 orchestrator disputed: ${(v.evidence || '').slice(0, 200)}`,
            timestamp: now, taskId: getTaskId(fb.finding.originalAgentId),
          });
        }
        // UNVERIFIED stays in place
      }

      // Remove promoted findings from unverified (deduplicate + reverse order to preserve indices)
      const uniqueToRemove = [...new Set(toRemove)].sort((a, b) => b - a);
      for (const idx of uniqueToRemove) {
        report.unverified.splice(idx, 1);
      }

      report.rounds = 3;
    } catch {
      // Phase 3 is best-effort — don't fail the entire consensus on verification error
    }
  }

  /**
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
        const filePath = await this.cachedResolve(fullRef) ?? await this.cachedResolve(bareFile);
        if (!filePath) continue;
        const fileStat = await stat(filePath);
        if (fileStat.size > MAX_FILE_SIZE) continue;
        const content = await this.cachedRead(filePath);
        if (!content) continue;
        const fileLines = content.split('\n');
        if (lineNum > fileLines.length) continue;

        const start = Math.max(0, lineNum - 1 - CONTEXT_LINES);
        const end = Math.min(fileLines.length, lineNum + CONTEXT_LINES);
        const snippet = fileLines.slice(start, end)
          .map((l, i) => `  ${start + i + 1}: ${l}`)
          .join('\n');
        const safeSnippet = snippet.replace(/<\/?(data|anchor|code)\b[^>]*>/gi, '');
        anchors.push(`<anchor src="${fullRef}:${lineNum}">\n${safeSnippet}\n</anchor>`);
      } catch { /* file unreadable, skip */ }
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
    const lowerText = findingText.toLowerCase();
    for (const [key, entry] of findingMap) {
      if (entry.originalAgentId !== peerAgentId) continue;
      const lowerFinding = entry.finding.toLowerCase();
      if (lowerFinding.includes(lowerText) || lowerText.includes(lowerFinding)) {
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
      confirmedBy: string[];
      disputedBy: Array<{ agentId: string; reason: string; evidence: string }>;
      unverifiedBy: Array<{ agentId: string; reason: string }>;
      confidences: number[];
    }>,
  ): void {
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
            toRemove.add(keyA);
            process.stderr.write(
              `[consensus] Dedup: merged "${entryA.finding.slice(0, 60)}..." (${entryA.originalAgentId}) into "${entryB.finding.slice(0, 60)}..." (${entryB.originalAgentId}) [B more precise]\n`
            );
            break; // A is removed, stop comparing it
          }
          // Default: merge B into A
          entryA.confirmedBy.push(entryB.originalAgentId);
          entryA.confidences.push(4); // high confidence — independent discovery
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
        lines.push(`  ✓ [${origPreset} + ${confirmerPresets}] ${f.finding}`);
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
        lines.push(`  ◇ [${origPreset}, unverified by ${unvNames}] "${f.finding}"`);
        lines.push(`    → To verify: re-dispatch to a second agent, or read the code directly`);
      }
      lines.push('');
    }

    if (unique.length > 0) {
      lines.push('UNIQUE (one agent only — verify before acting):');
      for (const f of unique) {
        const preset = this.config.registryGet(f.originalAgentId)?.preset || f.originalAgentId;
        lines.push(`  ? [${preset}] "${f.finding}"`);
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

    lines.push(bar);
    lines.push(`Summary: ${confirmed.length} confirmed, ${disputed.length} disputed, ${unverified.length} unverified, ${unique.length} unique, ${newFindings.length} new`);
    lines.push(bar);

    return lines.join('\n');
  }

  /**
   * Parse LLM cross-review response into structured entries.
   * Handles markdown code fences, invalid JSON, and confidence clamping.
   */
  private parseCrossReviewResponse(reviewerAgentId: string, text: string, limit: number): CrossReviewEntry[] {
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
      return [];
    }

    if (!Array.isArray(parsed)) return [];

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

      entries.push({
        action: item.action as CrossReviewEntry['action'],
        agentId: reviewerAgentId,
        peerAgentId: item.agentId ?? '',
        finding: item.finding,
        evidence: item.evidence,
        confidence,
      });
    }

    return entries;
  }
}
