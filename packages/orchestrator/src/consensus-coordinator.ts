import { randomUUID } from 'crypto';
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ILLMProvider, createProvider } from './llm-client';
import { IConsensusJudge } from './consensus-judge';
import { ConsensusEngine } from './consensus-engine';
import { ConsensusReport } from './consensus-types';
import { PerformanceWriter } from './performance-writer';
import { MemoryWriter } from './memory-writer';
import { AgentConfig, TaskEntry } from './types';
import { GossipPublisher } from './gossip-publisher';
import { extractCategories } from './category-extractor';

const log = (msg: string) => process.stderr.write(`[gossipcat] ${msg}\n`);

export interface ConsensusCoordinatorConfig {
  llm: ILLMProvider | null;
  registryGet: (id: string) => AgentConfig | undefined;
  projectRoot: string;
  keyProvider: ((provider: string) => Promise<string | null>) | null;
}

type ConsensusPhase = 'idle' | 'review' | 'cross_review' | 'synthesis';

export class ConsensusCoordinator {
  private llm: ILLMProvider | null;
  private registryGet: (id: string) => AgentConfig | undefined;
  private projectRoot: string;
  private keyProvider: ((provider: string) => Promise<string | null>) | null;
  private consensusJudge: IConsensusJudge | null = null;
  private gossipPublisher: GossipPublisher | null = null;
  private memWriter: MemoryWriter;

  private currentPhase: ConsensusPhase = 'idle';

  readonly sessionConsensusHistory: Array<{ timestamp: string; confirmed: number; disputed: number; unverified: number; unique: number; newFindings?: number; agents?: string[]; summary: string }> = [];

  constructor(config: ConsensusCoordinatorConfig) {
    this.llm = config.llm;
    this.registryGet = config.registryGet;
    this.projectRoot = config.projectRoot;
    this.keyProvider = config.keyProvider;
    this.memWriter = new MemoryWriter(config.projectRoot);
  }

  setConsensusJudge(judge: IConsensusJudge): void {
    this.consensusJudge = judge;
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

  async runConsensus(results: TaskEntry[]): Promise<ConsensusReport | undefined> {
    if (!this.llm || results.filter(r => r.status === 'completed').length < 2) return undefined;

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
              agentLlmCache.set(r.agentId, createProvider(agentConfig.provider, agentConfig.model, key));
            } else {
              agentLlmCache.set(r.agentId, null);
            }
          } catch {
            agentLlmCache.set(r.agentId, null);
          }
        }
        agentLlm = (agentId: string) => agentLlmCache.get(agentId) ?? undefined;
      }

      const engine = new ConsensusEngine({ llm: this.llm, registryGet: this.registryGet, projectRoot: this.projectRoot, agentLlm });
      const consensusReport = await engine.run(results);
      const perfWriter = new PerformanceWriter(this.projectRoot);

      this.currentPhase = 'cross_review';

      // Consensus Judge Integration
      const agentTaskIdMap = new Map<string, string>();
      for (const r of results) agentTaskIdMap.set(r.agentId, r.id);
      const consensusId = consensusReport.signals[0]?.consensusId ?? randomUUID().slice(0, 12);

      if (consensusReport.confirmed.length > 0 && this.consensusJudge) {
        try {
          const verdicts = await this.consensusJudge.verify(consensusReport.confirmed);
          const now = new Date().toISOString();

          verdicts.sort((a, b) => b.index - a.index);

          for (const v of verdicts) {
            const findingIndex = v.index - 1;
            const finding = consensusReport.confirmed[findingIndex];
            if (!finding) continue;

            if (v.verdict === 'REFUTED') {
              consensusReport.confirmed.splice(findingIndex, 1);
              finding.tag = 'disputed';
              consensusReport.disputed.push(finding);

              consensusReport.signals.push({
                type: 'consensus', signal: 'hallucination_caught', consensusId,
                agentId: finding.originalAgentId, outcome: 'judge_refuted',
                evidence: v.evidence, timestamp: now, taskId: agentTaskIdMap.get(finding.originalAgentId) || finding.id || '',
              });
              for (const confirmerId of finding.confirmedBy) {
                consensusReport.signals.push({
                  type: 'consensus', signal: 'hallucination_caught', consensusId,
                  agentId: confirmerId, outcome: 'confirmed_hallucination',
                  evidence: `Confirmed refuted finding: ${v.evidence}`,
                  timestamp: now, taskId: agentTaskIdMap.get(confirmerId) || finding.id || '',
                });
              }
            } else if (v.verdict === 'VERIFIED') {
              consensusReport.signals.push({
                type: 'consensus', signal: 'consensus_verified', consensusId,
                agentId: finding.originalAgentId,
                evidence: v.evidence, timestamp: now, taskId: agentTaskIdMap.get(finding.originalAgentId) || finding.id || '',
                severity: finding.severity,
              });
            }
          }
        } catch (err) {
          log(`Consensus judge failed: ${(err as Error).message}`);
        }
      }

      this.currentPhase = 'synthesis';

      // Write performance signals
      if (consensusReport.signals.length > 0) {
        perfWriter.appendSignals(consensusReport.signals);

        try {
          this.memWriter.updateImportanceFromSignals(
            consensusReport.signals.map(s => ({ signal: s.signal, agentId: s.agentId, taskId: s.taskId }))
          );
        } catch { /* best-effort */ }
      }

      // Extract categories from confirmed findings
      if (consensusReport.confirmed.length > 0) {
        const now = new Date().toISOString();
        for (const finding of consensusReport.confirmed) {
          const categories = extractCategories(finding.finding);
          for (const category of categories) {
            perfWriter.appendSignal({
              type: 'consensus',
              signal: 'category_confirmed',
              consensusId,
              agentId: finding.originalAgentId,
              taskId: finding.id || '',
              category,
              evidence: finding.finding,
              timestamp: now,
              severity: finding.severity,
            } as any);
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
            this.memWriter.writeConsensusKnowledge(agentId, findings);
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
      };
      this.sessionConsensusHistory.push(historyEntry);

      // Persist to consensus-history.jsonl for dashboard
      try {
        const historyPath = join(this.projectRoot, '.gossip', 'consensus-history.jsonl');
        mkdirSync(join(this.projectRoot, '.gossip'), { recursive: true });
        appendFileSync(historyPath, JSON.stringify(historyEntry) + '\n');
        this.rotateJsonlFile(historyPath, 200, 100);
      } catch { /* best-effort */ }

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
      process.stderr.write(`[gossipcat] Consensus failed: ${(err as Error).message}\n`);
      return undefined;
    } finally {
      this.currentPhase = 'idle';
    }
  }

  /** Rotate a JSONL file: if over maxEntries lines, keep only the last keepEntries. */
  private rotateJsonlFile(filePath: string, maxEntries: number, keepEntries: number): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      if (lines.length > maxEntries) {
        writeFileSync(filePath, lines.slice(-keepEntries).join('\n') + '\n');
      }
    } catch { /* file may not exist yet */ }
  }
}
