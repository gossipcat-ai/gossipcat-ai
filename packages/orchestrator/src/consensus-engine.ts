import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
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
const MAX_SUMMARY_LENGTH = 3000;
const MAX_CROSS_REVIEW_ENTRIES = 50; // DoS prevention
const VALID_ACTIONS = new Set(['agree', 'disagree', 'new']);

export interface ConsensusEngineConfig {
  llm: ILLMProvider;
  registryGet: (agentId: string) => AgentConfig | undefined;
  projectRoot?: string;
}

export class ConsensusEngine {
  protected readonly config: ConsensusEngineConfig;

  constructor(config: ConsensusEngineConfig) {
    this.config = config;
  }

  extractSummary(result: string): string {
    const idx = result.indexOf(SUMMARY_HEADER);
    if (idx !== -1) {
      const afterHeader = result.slice(idx + SUMMARY_HEADER.length).trimStart();
      const nextHeader = afterHeader.search(/\n##\s/);
      const nextBlankLine = afterHeader.indexOf('\n\n');
      let end = afterHeader.length;
      if (nextHeader !== -1) end = Math.min(end, nextHeader);
      if (nextBlankLine !== -1) end = Math.min(end, nextBlankLine);
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
        confirmed: [], disputed: [], unique: [], newFindings: [], signals: [],
        summary: 'Consensus skipped: insufficient agents (need ≥2 successful).',
      };
    }

    process.stderr.write(`[consensus] Starting cross-review for ${successful.length} agents\n`);
    const crossReviewEntries = await this.dispatchCrossReview(results);
    process.stderr.write(`[consensus] Cross-review complete: ${crossReviewEntries.length} entries\n`);

    const report = await this.synthesize(results, crossReviewEntries);
    process.stderr.write(`[consensus] ${report.confirmed.length} confirmed, ${report.disputed.length} disputed, ${report.unique.length} unique, ${report.newFindings.length} new\n`);

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
      summaries.set(r.agentId, raw.replace(/<\/?data>/gi, ''));
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

    // Build peer findings section
    const peerLines: string[] = [];
    for (const [peerId, peerSummary] of summaries) {
      if (peerId === agent.agentId) continue;
      const peerConfig = this.config.registryGet(peerId);
      const preset = peerConfig?.preset ?? 'unknown';
      // SECURITY: Wrap external LLM output in <data> tags to prevent prompt injection.
      peerLines.push(`Agent "${peerId}" (${preset}):\n<data>${peerSummary}</data>`);
    }

    const userContent = `You previously reviewed code and produced findings. Now review your peers' findings.

YOUR FINDINGS (Phase 1):
<data>${ownSummary}</data>

PEER FINDINGS:
${peerLines.join('\n\n')}

For each peer finding, respond with one of:
- AGREE: You independently confirm this finding is correct. Cite your evidence.
- DISAGREE: You believe this finding is incorrect. Explain why with evidence (file:line references).
- NEW: Something ALL agents missed that you now realize after seeing peer work.

Return ONLY a JSON array:
[
  { "action": "agree"|"disagree"|"new", "agentId": "peer_id", "finding": "summary", "evidence": "your reasoning", "confidence": 1-5 }
]`;

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a code reviewer performing cross-review. Return only valid JSON.' },
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
    const signals: ConsensusSignal[] = [];
    const newFindings: ConsensusNewFinding[] = [];
    const successful = results.filter(r => r.status === 'completed' && r.result);

    // (a) Seed finding map from Phase 1 results
    const findingMap = new Map<string, {
      originalAgentId: string;
      finding: string;
      confirmedBy: string[];
      disputedBy: Array<{ agentId: string; reason: string; evidence: string }>;
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
          confidences: [],
        });
      }
    }

    // Build taskId lookup from results
    const agentTaskIds = new Map<string, string>();
    for (const r of successful) agentTaskIds.set(r.agentId, r.id);

    // (b) Apply cross-review entries
    for (const entry of crossReviewEntries) {
      const now = new Date().toISOString();

      if (entry.action === 'new') {
        newFindings.push({
          agentId: entry.agentId,
          finding: entry.finding,
          evidence: entry.evidence,
          confidence: entry.confidence,
        });
        signals.push({
          type: 'consensus',
          taskId: agentTaskIds.get(entry.agentId) ?? '',
          signal: 'new_finding',
          agentId: entry.agentId,
          evidence: entry.evidence,
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
            taskId: agentTaskIds.get(entry.agentId) ?? '',
            signal: 'agreement',
            agentId: entry.agentId,
            counterpartId: entry.peerAgentId,
            evidence: entry.evidence,
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
            signals.push({
              type: 'consensus',
              taskId: agentTaskIds.get(entry.peerAgentId) ?? '',
              signal: 'hallucination_caught',
              agentId: entry.peerAgentId,
              counterpartId: entry.agentId,
              outcome: isCitationFabricated ? 'fabricated_citation' : 'incorrect',
              evidence: entry.evidence,
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
              taskId: agentTaskIds.get(entry.agentId) ?? '',
              signal: 'disagreement',
              agentId: entry.agentId,
              counterpartId: entry.peerAgentId,
              evidence: entry.evidence,
              timestamp: now,
            });
          }
        }
      }
    }

    // (c) Tag findings
    const confirmed: ConsensusFinding[] = [];
    const disputed: ConsensusFinding[] = [];
    const unique: ConsensusFinding[] = [];
    let findingIdx = 0;

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
        confidence: Math.round(avgConfidence),
      };

      const now = new Date().toISOString();
      if (entry.disputedBy.length > 0 && entry.confirmedBy.length === 0) {
        // Pure dispute — no one confirmed
        finding.tag = 'disputed';
        disputed.push(finding);
      } else if (entry.disputedBy.length > 0 && entry.confirmedBy.length > 0) {
        // Mixed — both confirmed and disputed. Tag as disputed but note confirmations.
        finding.tag = 'disputed';
        disputed.push(finding);
      } else if (entry.confirmedBy.length > 0) {
        // Confirmed by peers — verify finding is real before accepting
        // Check 1: citations reference real code
        const findingHasFabricatedCitation = await this.verifyCitations(entry.finding);
        // Check 2: negative claims ("no validation") are verified against actual code
        const findingHasFalseNegative = !findingHasFabricatedCitation
          ? await this.verifyNegativeClaim(entry.finding)
          : false;

        if (findingHasFabricatedCitation || findingHasFalseNegative) {
          // Finding claims something about code that isn't true — demote to unique, flag
          finding.tag = 'unique';
          unique.push(finding);
          const reason = findingHasFabricatedCitation ? 'fabricated_citation' : 'false_negative_claim';
          signals.push({
            type: 'consensus',
            taskId: agentTaskIds.get(entry.originalAgentId) ?? '',
            signal: 'hallucination_caught',
            agentId: entry.originalAgentId,
            outcome: reason as any,
            evidence: `Confirmed finding contains false claim: "${entry.finding.slice(0, 200)}"`,
            timestamp: now,
          });
          continue;
        }

        // Check if this was a unique finding (only one agent originally found it)
        const isUniquelyDiscovered = !Array.from(findingMap.values()).some(
          other => other !== entry && other.finding === entry.finding && other.originalAgentId !== entry.originalAgentId
        );
        finding.tag = 'confirmed';
        confirmed.push(finding);
        // Emit unique_confirmed signal if only one agent originally found this
        if (isUniquelyDiscovered) {
          signals.push({
            type: 'consensus',
            taskId: agentTaskIds.get(entry.originalAgentId) ?? '',
            signal: 'unique_confirmed',
            agentId: entry.originalAgentId,
            evidence: entry.finding,
            timestamp: now,
          });
        }
      } else {
        // No one confirmed or disputed — truly unique/unverified
        finding.tag = 'unique';
        unique.push(finding);
        signals.push({
          type: 'consensus',
          taskId: agentTaskIds.get(entry.originalAgentId) ?? '',
          signal: 'unique_unconfirmed',
          agentId: entry.originalAgentId,
          evidence: entry.finding,
          timestamp: now,
        });
      }
    }

    // (d) Generate formatted report
    const summary = this.formatReport(confirmed, disputed, unique, newFindings, successful.length);

    return {
      agentCount: successful.length,
      rounds: 2,
      confirmed,
      disputed,
      unique,
      newFindings,
      signals,
      summary,
    };
  }

  /**
   * Verify file:line citations in disagreement evidence against actual source code.
   * Returns true if any citation is fabricated (file doesn't exist, line doesn't match claim).
   */
  async verifyCitations(evidence: string): Promise<boolean> {
    if (!this.config.projectRoot) return false;

    // Extract file:line patterns like "task-dispatcher.ts:146" or "consensus-engine.ts:113"
    const citationPattern = /(?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,4}):(\d+)/g;
    const citations: Array<{ file: string; line: number }> = [];
    let match;
    while ((match = citationPattern.exec(evidence)) !== null) {
      citations.push({ file: match[1], line: parseInt(match[2], 10) });
    }

    if (citations.length === 0) return false;

    // Extract positive code-behavior claims tied to citations.
    // Pattern: "[code/file] explicitly throws" or "at line X, throws" etc.
    // Only match positive assertions, not negations like "not a guard" or "doesn't throw".
    const claimPatterns = [
      /(?:explicitly |directly )?(?:throws?|throw new)\b/,
      /(?:explicitly |directly )?(?:checks?|validates?|verifies?)\b/,
      /(?:explicitly |directly )?(?:returns?|calls?|invokes?)\b/,
      /(?:explicitly |directly )?(?:prevents?|blocks?|rejects?)\b/,
    ];

    // Find claims near citation references (within ~50 chars of the file:line mention)
    const lowerEvidence = evidence.toLowerCase();
    const citationClaims: string[] = [];
    for (const citation of citations) {
      const citRef = `${citation.file}:${citation.line}`.toLowerCase();
      const citIdx = lowerEvidence.indexOf(citRef);
      if (citIdx === -1) continue;

      // Look at surrounding context for positive claims (not preceded by "not", "no", "doesn't", "don't")
      const contextStart = Math.max(0, citIdx - 30);
      const contextEnd = Math.min(lowerEvidence.length, citIdx + citRef.length + 100);
      const context = lowerEvidence.slice(contextStart, contextEnd);

      for (const pattern of claimPatterns) {
        const match = context.match(pattern);
        if (match) {
          // Skip if preceded by negation
          const beforeMatch = context.slice(0, match.index);
          if (/\b(not?|doesn'?t|don'?t|never|isn'?t|just a|without)\s*$/.test(beforeMatch)) continue;
          citationClaims.push(match[0]);
        }
      }
    }

    for (const citation of citations) {
      try {
        // Resolve file path — try direct, then search common locations
        const filePath = await this.resolveFilePath(citation.file);
        if (!filePath) return true; // File doesn't exist — fabricated citation

        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n');

        if (citation.line > lines.length) return true; // Line number beyond file length

        // Check a window around the cited line (±5 lines) for claimed behavior
        const start = Math.max(0, citation.line - 6);
        const end = Math.min(lines.length, citation.line + 5);
        const window = lines.slice(start, end).join('\n').toLowerCase();

        // If the agent makes positive claims about what the code does, verify those keywords exist nearby
        if (citationClaims.length > 0) {
          const hasAnyClaim = citationClaims.some(claim => window.includes(claim));
          if (!hasAnyClaim) return true; // Claims behavior that doesn't exist at the cited location
        }
      } catch {
        // File read failed — treat as fabricated
        return true;
      }
    }

    return false;
  }

  /**
   * Verify negative claims in findings (e.g., "no validation", "no sanitization").
   * Searches cited files for evidence that the claimed-missing code actually exists.
   * Returns true if the negative claim is false (code exists but finding says it doesn't).
   */
  async verifyNegativeClaim(finding: string): Promise<boolean> {
    if (!this.config.projectRoot) return false;

    // Detect negative claims about code
    const negativeClaims = /\b(?:no |lacks? |missing |without |does not |doesn'?t |absent|never )(sanitiz|validat|check|verif|guard|filter|escap|authenti)/i;
    const match = finding.match(negativeClaims);
    if (!match) return false; // No negative claim detected

    const claimedMissing = match[1].toLowerCase(); // e.g., "validat", "sanitiz"

    // Map claimed-missing stems to code patterns that would indicate the behavior exists
    const codeIndicators: Record<string, string[]> = {
      sanitiz: ['sanitiz', 'replace(', 'strip', 'escape', 'filter'],
      validat: ['validat', '.test(', 'throw new error', 'reject', 'invalid', 'known_', 'safe_name'],
      check: ['check', '.test(', 'if (', 'throw', 'assert'],
      verif: ['verif', '.test(', 'assert', 'throw'],
      guard: ['guard', '.test(', 'if (!', 'throw'],
      filter: ['filter', 'replace(', 'strip', 'sanitiz'],
      escap: ['escap', 'replace(', 'encode'],
      authenti: ['authenti', 'auth', 'token', 'credential', 'login'],
    };

    const indicators = codeIndicators[claimedMissing] || [claimedMissing];

    // Extract file references from the finding
    const filePattern = /(?:[\w./-]+\/)?([a-zA-Z][\w.-]+\.[a-z]{1,4})(?::(\d+))?/g;
    const files: string[] = [];
    let fileMatch;
    while ((fileMatch = filePattern.exec(finding)) !== null) {
      files.push(fileMatch[1]); // capture group 1 = clean filename
    }

    if (files.length === 0) return false; // No files cited — can't verify

    // Search cited files for code that contradicts the negative claim
    for (const fileRef of files) {
      try {
        const filePath = await this.resolveFilePath(fileRef);
        if (!filePath) continue;

        const content = (await readFile(filePath, 'utf-8')).toLowerCase();
        const lines = content.split('\n');
        const codeLines = lines.filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
        const codeContent = codeLines.join('\n');

        // If the file contains indicators of the behavior the finding says is missing, the claim is false
        const hasIndicator = indicators.some(ind => codeContent.includes(ind));
        if (hasIndicator) {
          return true; // Code contradicts the negative claim
        }
      } catch { continue; }
    }

    return false;
  }

  /**
   * Resolve a relative file reference to an absolute path within the project.
   */
  private async resolveFilePath(fileRef: string): Promise<string | null> {
    const root = this.config.projectRoot!;
    const fileName = fileRef.split('/').pop()!;

    // Try the reference as-is (could be a full relative path)
    try {
      await stat(join(root, fileRef));
      return join(root, fileRef);
    } catch { /* not found at root */ }

    // Recursive search in common source directories
    const searchDirs = ['packages', 'src', 'apps'];
    for (const dir of searchDirs) {
      const found = await this.findFile(join(root, dir), fileName);
      if (found) return found;
    }

    return null;
  }

  private async findFile(dir: string, fileName: string): Promise<string | null> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isFile() && entry.name === fileName) return fullPath;
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
    const indicators = [
      'does not exist',
      "doesn't exist",
      'no such file',
      'no such function',
      'no such method',
      'no such variable',
      'file not found',
      'function not found',
      'method not found',
      'line is a comment',      // tightened: was 'is a comment'
      'file only has',          // tightened: was 'only has'
      'no line \\d',            // tightened: was 'no line' — require digit after
      'nonexistent',
      'non-existent',
      'never defined',
      'is not defined in',      // tightened: was 'not defined'
      'not defined anywhere',   // tightened: was 'not defined'
      'fabricated',
      'hallucinated',
    ];
    const lower = evidence.toLowerCase();
    return indicators.some(phrase => {
      if (phrase.includes('\\d')) {
        return new RegExp(phrase).test(lower);
      }
      return lower.includes(phrase);
    });
  }

  /**
   * Find a matching finding in the map for a given peer agent and finding text.
   * 3-tier matching: exact, substring, word overlap.
   */
  private findMatchingFinding(
    findingMap: Map<string, { originalAgentId: string; finding: string; confirmedBy: string[]; disputedBy: any[]; confidences: number[] }>,
    peerAgentId: string,
    findingText: string,
  ): string | null {
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
   * Format the consensus report as a human-readable string.
   */
  private formatReport(
    confirmed: ConsensusFinding[],
    disputed: ConsensusFinding[],
    unique: ConsensusFinding[],
    newFindings: ConsensusNewFinding[],
    agentCount: number,
  ): string {
    const bar = '═══════════════════════════════════════════';
    const lines: string[] = [];

    lines.push(bar);
    lines.push(`CONSENSUS REPORT (${agentCount} agents, 2 rounds)`);
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
    lines.push(`Summary: ${confirmed.length} confirmed, ${disputed.length} disputed, ${unique.length} unique, ${newFindings.length} new`);
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
