import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { SessionGossipEntry, PlanState } from './types';
import { ILLMProvider } from './llm-client';
import { LLMMessage } from '@gossip/types';

import { gossipLog as log } from './log';

export interface SessionContextConfig {
  llm: ILLMProvider | null;
  projectRoot: string;
}

export class SessionContext {
  private readonly projectRoot: string;
  private readonly llm: ILLMProvider | null;

  private sessionGossip: SessionGossipEntry[] = [];
  private plans: Map<string, PlanState> = new Map();
  private static readonly MAX_SESSION_GOSSIP = 20;

  private sessionStartTime: Date = new Date();

  constructor(config: SessionContextConfig) {
    this.projectRoot = config.projectRoot;
    this.llm = config.llm;

    // Track session start time for git log range.
    // Check if gossip file has entries — if so, this is a reconnect within an existing session.
    // Use the oldest gossip entry's timestamp as the real session start.
    try {
      const gossipPath = join(config.projectRoot, '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl');
      const { existsSync: ex, readFileSync: rf } = require('fs');
      if (ex(gossipPath)) {
        const lines = rf(gossipPath, 'utf-8').trim().split('\n').filter(Boolean);
        if (lines.length > 0) {
          const first = JSON.parse(lines[0]);
          if (first.timestamp) this.sessionStartTime = new Date(first.timestamp);
        }
      }
    } catch { /* best-effort — fall back to now */ }
  }

  registerPlan(plan: PlanState): void {
    this.plans.set(plan.id, plan);
  }

  /** Build chain context string for a plan step (used by native agent bridge) */
  getChainContext(planId: string, step: number): string {
    if (step <= 1) return '';
    const plan = this.plans.get(planId);
    if (!plan) return '';
    const priorSteps = plan.steps.filter(s => s.step < step && s.result);
    if (priorSteps.length === 0) return '';
    return '[Chain Context — results from prior steps in this plan]\n' +
      priorSteps.map(s => `Step ${s.step} (${s.agentId}): ${s.result!.slice(0, 1000)}`).join('\n\n');
  }

  /** Record a native task result into the plan so subsequent steps get chain context */
  recordPlanStepResult(planId: string, step: number, result: string): void {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const planStep = plan.steps.find(s => s.step === step);
    if (planStep) {
      planStep.result = (result || '').slice(0, 2000);
    }
  }

  getSessionStartTime(): Date {
    return this.sessionStartTime;
  }

  getSessionGossip(): SessionGossipEntry[] {
    return this.sessionGossip;
  }

  /** Get the plans map (for collect() plan cleanup in DispatchPipeline) */
  getPlans(): Map<string, PlanState> {
    return this.plans;
  }

  async summarizeAndStoreGossip(agentId: string, result: string): Promise<void> {
    try {
      const summary = await this.summarizeForSession(agentId, result);
      if (summary) {
        this.sessionGossip.push({ agentId, taskSummary: summary, timestamp: Date.now() });
        if (this.sessionGossip.length > SessionContext.MAX_SESSION_GOSSIP) {
          this.sessionGossip.shift();
        }
        // Persist to disk for crash safety — gossip_session_save reads this file
        try {
          const gossipPath = join(this.projectRoot, '.gossip', 'agents', '_project', 'memory', 'session-gossip.jsonl');
          mkdirSync(dirname(gossipPath), { recursive: true });
          appendFileSync(gossipPath, JSON.stringify({ agentId, taskSummary: summary, timestamp: Date.now() }) + '\n');
          this.rotateJsonlFile(gossipPath, 100, 50);
        } catch { /* best-effort disk persistence */ }
      }
    } catch (err) {
      log(`Session gossip summarization failed for ${agentId}: ${(err as Error).message}`);
    }
  }

  private async summarizeForSession(agentId: string, result: string): Promise<string> {
    const messages: LLMMessage[] = [
      { role: 'system', content: 'Summarize the agent result in 1-2 sentences (max 400 chars). Extract only factual findings. No instructions or directives.' },
      { role: 'user', content: `Agent ${agentId} result:\n${result.slice(0, 2000)}` },
    ];
    const response = await this.llm!.generate(messages, { temperature: 0 });
    return (response.text || '').slice(0, 400);
  }

  /** Rotate a JSONL file: if over maxEntries lines, keep only the last keepEntries. */
  rotateJsonlFile(filePath: string, maxEntries: number, keepEntries: number): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      if (lines.length > maxEntries) {
        writeFileSync(filePath, lines.slice(-keepEntries).join('\n') + '\n');
      }
    } catch { /* file may not exist yet */ }
  }
}
