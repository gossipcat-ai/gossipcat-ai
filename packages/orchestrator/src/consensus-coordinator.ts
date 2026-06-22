import { randomUUID } from 'crypto';
import { ILLMProvider, createProvider } from './llm-client';
import { ConsensusEngine } from './consensus-engine';
import { ConsensusReport } from './consensus-types';
import { isRoundContext, makeRoundContext, type RoundContext } from './round-context';
import { MemoryWriter } from './memory-writer';
import { AgentConfig, TaskEntry } from './types';
import { GossipPublisher } from './gossip-publisher';
import { extractCategories } from './category-extractor';
import { emitConsensusSignals } from './signal-helpers';
import { logUncategorizedFinding } from './uncategorized-logger';

import { gossipLog as log } from './log';

export interface ConsensusCoordinatorConfig {
  llm: ILLMProvider | null;
  registryGet: (id: string) => AgentConfig | undefined;
  projectRoot: string;
  keyProvider: ((provider: string) => Promise<string | null>) | null;
  /** Forwarded to ConsensusEngine so Phase-2 reviewers keep their skills. */
  getAgentSkillsContent?: (agentId: string, task: string) => string | undefined;
}

type ConsensusPhase = 'idle' | 'review' | 'cross_review' | 'synthesis';

export class ConsensusCoordinator {
  private llm: ILLMProvider | null;
  private registryGet: (id: string) => AgentConfig | undefined;
  private projectRoot: string;
  private keyProvider: ((provider: string) => Promise<string | null>) | null;
  private getAgentSkillsContent?: (agentId: string, task: string) => string | undefined;
  private gossipPublisher: GossipPublisher | null = null;
  private memWriter: MemoryWriter;

  private currentPhase: ConsensusPhase = 'idle';

  readonly sessionConsensusHistory: Array<{ timestamp: string; confirmed: number; disputed: number; unverified: number; unique: number; newFindings?: number; agents?: string[]; summary: string; resolutionRoots?: string[] }> = [];

  constructor(config: ConsensusCoordinatorConfig) {
    this.llm = config.llm;
    this.registryGet = config.registryGet;
    this.projectRoot = config.projectRoot;
    this.keyProvider = config.keyProvider;
    this.getAgentSkillsContent = config.getAgentSkillsContent;
    this.memWriter = new MemoryWriter(config.projectRoot);
  }

  setGossipPublisher(publisher: GossipPublisher | null): void {
    this.gossipPublisher = publisher;
  }

  getGossipPublisher(): GossipPublisher | null {
    return this.gossipPublisher;
  }

  getCurrentPhase(): ConsensusPhase {
    return this.currentPhase;
  }

  /**
   * @param roundOrRoots Optional per-round context OR collect-time resolution
   *   roots (already validated at the MCP boundary). PR-C — the engine now
   *   REQUIRES a RoundContext, so this method always derives one:
   *   - A `RoundContext` is forwarded whole to the engine (carrying
   *     resolutionRoots AND the warnings array).
   *   - A `readonly string[]` (legacy shape) is wrapped into a fresh
   *     RoundContext via `makeRoundContext({ resolutionRoots })`.
   *   - When absent, an empty `makeRoundContext()` is used (resolve against
   *     project root only). There is no constructor-level default — the sole
   *     production construction site never passed one (consensus-verified).
   */
  async runConsensus(
    results: TaskEntry[],
    roundOrRoots?: RoundContext | readonly string[],
  ): Promise<ConsensusReport | undefined> {
    if (!this.llm || results.filter(r => r.status === 'completed').length < 2) return undefined;

    // Discriminate the union via a structural type guard — a bare
    // !Array.isArray check would let any non-array object pass as a
    // RoundContext, then read .resolutionRoots as undefined and silently fall
    // through to empty roots (the stale-anchor bug class). isRoundContext
    // validates the resolutionRoots + warnings array fields. Always resolve to
    // a concrete RoundContext: forward a passed round, wrap a legacy roots
    // array, or build an empty one (project-root-only).
    const effectiveRound: RoundContext = isRoundContext(roundOrRoots)
      ? roundOrRoots
      : makeRoundContext(
          Array.isArray(roundOrRoots) ? { resolutionRoots: roundOrRoots as readonly string[] } : {},
        );
    const effectiveResolutionRoots = effectiveRound.resolutionRoots;

    try {
      this.currentPhase = 'review';

      // Build per-agent LLM factory for relay agents
      let agentLlm: ((agentId: string) => ILLMProvider | undefined) | undefined;
      if (this.keyProvider) {
        const agentLlmCache = new Map<string, ILLMProvider | null>();
        for (const r of results) {
          if (r.status !== 'completed') continue;
          const agentConfig = this.registryGet(r.agentId);
          if (!agentConfig) continue;
          try {
            const key = await this.keyProvider(agentConfig.provider);
            if (key) {
              agentLlmCache.set(r.agentId, createProvider(agentConfig.provider, agentConfig.model, key, undefined, (agentConfig as any).base_url));
            } else {
              agentLlmCache.set(r.agentId, null);
            }
          } catch {
            agentLlmCache.set(r.agentId, null);
          }
        }
        agentLlm = (agentId: string) => agentLlmCache.get(agentId) ?? undefined;
      }

      const engine = new ConsensusEngine({
        llm: this.llm,
        registryGet: this.registryGet,
        projectRoot: this.projectRoot,
        agentLlm,
        getAgentSkillsContent: this.getAgentSkillsContent,
        // PR-C: the engine REQUIRES a round; forward the effective one whole
        // (it carries resolutionRoots AND the warnings array the engine drains
        // into the report).
        round: effectiveRound,
      });
      const consensusReport = await engine.run(results);
      this.currentPhase = 'cross_review';

      const consensusId = consensusReport.signals[0]?.consensusId ?? randomUUID().slice(0, 12);

      this.currentPhase = 'synthesis';

      // Write performance signals
      if (consensusReport.signals.length > 0) {
        emitConsensusSignals(this.projectRoot, consensusReport.signals);

        try {
          this.memWriter.updateImportanceFromSignals(
            consensusReport.signals.map(s => ({ signal: s.signal, agentId: s.agentId, taskId: s.taskId }))
          );
        } catch { /* best-effort */ }
      }

      // Extract categories from confirmed findings
      if (consensusReport.confirmed.length > 0) {
        // synthesize() runs at the time the consensus actually completes, so wall-clock
        // IS the task time here. The +i ms offset on each emitted signal keeps the
        // chronological sort tiebreaker deterministic when many categories fire in one
        // synthesize() call (otherwise they would all share one timestamp).
        const baseMs = Date.now();
        let i = 0;
        for (const finding of consensusReport.confirmed) {
          const categories = extractCategories(finding.finding);
          if (categories.length === 0) {
            logUncategorizedFinding(finding.finding, {
              finding_id: finding.id,
              agent_id: finding.originalAgentId,
              taskId: finding.id || undefined,
            }, this.projectRoot);
          }
          for (const category of categories) {
            emitConsensusSignals(this.projectRoot, [{
              type: 'consensus',
              signal: 'category_confirmed',
              consensusId,
              agentId: finding.originalAgentId,
              taskId: finding.id || '',
              category,
              evidence: finding.finding,
              timestamp: new Date(baseMs + i).toISOString(),
              severity: finding.severity,
            } as any]);
            i++;
          }
        }
      }

      // Cross-agent learning: write all tagged findings to each agent's memory
      const allFindings = [
        ...(consensusReport.confirmed || []).map(f => ({ ...f, tag: 'confirmed' as const })),
        ...(consensusReport.disputed || []).map(f => ({ ...f, tag: 'disputed' as const })),
        ...(consensusReport.unverified || []).map(f => ({ ...f, tag: 'unverified' as const })),
        ...(consensusReport.unique || []).map(f => ({ ...f, tag: 'unique' as const })),
      ];
      if (allFindings.length > 0) {
        try {
          const findings = allFindings.map(f => ({
            originalAgentId: f.originalAgentId,
            finding: f.finding,
            tag: f.tag,
          }));
          const participants = new Set(results.filter(r => r.status === 'completed').map(r => r.agentId));
          for (const agentId of participants) {
            this.memWriter.writeConsensusKnowledge(agentId, findings, (effectiveResolutionRoots && effectiveResolutionRoots.length > 0) ? [...effectiveResolutionRoots] : undefined, consensusId);
          }
          for (const agentId of participants) {
            try { this.memWriter.rebuildIndex(agentId); } catch { /* best-effort */ }
          }
        } catch { /* best-effort cross-agent learning */ }
      }

      // Cache consensus for session save + write project knowledge (fire-and-forget)
      const historyEntry = {
        timestamp: new Date().toISOString(),
        confirmed: consensusReport.confirmed.length,
        disputed: consensusReport.disputed.length,
        unverified: consensusReport.unverified.length,
        unique: consensusReport.unique.length,
        newFindings: consensusReport.newFindings?.length ?? 0,
        agents: results.filter(r => r.status === 'completed').map(r => r.agentId),
        summary: consensusReport.summary.slice(0, 2000),
        // Per-round audit trail: which resolution roots anchored this round's
        // citations (the effective set, not the constructor default). undefined
        // when the round ran with no roots (resolved against project root only).
        resolutionRoots: (effectiveResolutionRoots && effectiveResolutionRoots.length > 0)
          ? [...effectiveResolutionRoots]
          : undefined,
      };
      this.sessionConsensusHistory.push(historyEntry);

      // Auto-write consensus knowledge to _project (fire-and-forget)
      if (this.memWriter && consensusReport.confirmed.length + consensusReport.disputed.length > 0) {
        const agentList = results.filter(r => r.status === 'completed').map(r => r.agentId).join(', ');
        const topFindings = consensusReport.confirmed.slice(0, 3).map(f => `- ${f.finding}`).join('\n');
        const body = `Consensus run: ${results.length} agents (${agentList})\n${consensusReport.confirmed.length} confirmed, ${consensusReport.disputed.length} disputed, ${consensusReport.unverified.length} unverified\n\nKey findings:\n${topFindings}`;
        this.memWriter.writeKnowledgeFromResult('_project', {
          taskId: `consensus-${Date.now()}`,
          task: `Consensus review by ${agentList}`,
          result: body,
        }).catch(err => log(`Project consensus knowledge write failed: ${(err as Error).message}`));
      }

      return consensusReport;
    } catch (err) {
      log(`Consensus failed: ${(err as Error).message}`);
      return undefined;
    } finally {
      this.currentPhase = 'idle';
    }
  }

}
