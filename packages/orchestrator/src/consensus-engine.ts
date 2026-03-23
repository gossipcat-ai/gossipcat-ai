import { LLMMessage } from '@gossip/types';
import { ILLMProvider } from './llm-client';
import { AgentConfig, TaskEntry } from './types';
import { CrossReviewEntry } from './consensus-types';

export type {
  ConsensusReport,
  ConsensusFinding,
  ConsensusNewFinding,
  ConsensusSignal,
  CrossReviewEntry,
} from './consensus-types';

const SUMMARY_HEADER = '## Consensus Summary';
const FALLBACK_MAX_LENGTH = 2000;
const VALID_ACTIONS = new Set(['agree', 'disagree', 'new']);

export interface ConsensusEngineConfig {
  llm: ILLMProvider;
  registryGet: (agentId: string) => AgentConfig | undefined;
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

  /**
   * Phase 2: Send cross-review prompts to each agent and collect structured responses.
   * Each agent reviews all peer summaries and produces agree/disagree/new entries.
   */
  async dispatchCrossReview(results: TaskEntry[]): Promise<CrossReviewEntry[]> {
    const successful = results.filter(r => r.status === 'completed' && r.result);
    if (successful.length < 2) return [];

    // Build summary map: agentId -> extracted summary
    const summaries = new Map<string, string>();
    for (const r of successful) {
      summaries.set(r.agentId, this.extractSummary(r.result!));
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
      peerLines.push(`Agent "${peerId}" (${preset}):\n${peerSummary}`);
    }

    const userContent = `You previously reviewed code and produced findings. Now review your peers' findings.

YOUR FINDINGS (Phase 1):
${ownSummary}

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
      const entries = this.parseCrossReviewResponse(agent.agentId, response.text);
      // Filter out self-references — an agent can't cross-review its own findings
      return entries.filter(e => e.peerAgentId !== agent.agentId);
    } catch {
      // Graceful degradation: skip agents whose LLM call fails
      return [];
    }
  }

  /**
   * Parse LLM cross-review response into structured entries.
   * Handles markdown code fences, invalid JSON, and confidence clamping.
   */
  private parseCrossReviewResponse(reviewerAgentId: string, text: string): CrossReviewEntry[] {
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

    const entries: CrossReviewEntry[] = [];
    for (const item of parsed) {
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
