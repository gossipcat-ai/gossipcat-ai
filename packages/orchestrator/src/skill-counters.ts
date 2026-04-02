/**
 * Skill activation counters for contextual skill lifecycle management.
 *
 * Tracks per-agent, per-skill activation counts to support:
 * - Auto-disable: contextual skills with 0 activations over 30 dispatches
 * - Promotion: contextual skills activated >80% over 20-dispatch rolling window
 *
 * Counters accumulate in memory during a session and flush to disk on collect.
 * Separate from skill-index.json to avoid per-dispatch writes.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { SkillIndex } from './skill-index';

const STALE_THRESHOLD = 30;
const PROMOTION_RATE = 0.8;
const PROMOTION_MIN_WINDOW = 20;

interface SkillCounter {
  totalDispatches: number;
  activations: number;
  lastActivatedAt: string;
  recentWindow: boolean[]; // circular buffer of last 20 dispatches
}

type CounterData = Record<string, Record<string, SkillCounter>>;

export class SkillCounterTracker {
  private data: CounterData = {};
  private readonly filePath: string;
  private dirty = false;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, '.gossip', 'skill-counters.json');
    this.load();
  }

  /**
   * Record a dispatch for an agent. Call after loadSkills() returns.
   * @param agentId The dispatched agent
   * @param contextualSkills All contextual skills bound to this agent
   * @param activatedSkills Contextual skills that were actually activated (from LoadSkillsResult)
   */
  recordDispatch(agentId: string, contextualSkills: string[], activatedSkills: string[]): void {
    if (!this.data[agentId]) this.data[agentId] = {};
    const activated = new Set(activatedSkills);

    for (const skill of contextualSkills) {
      if (!this.data[agentId][skill]) {
        this.data[agentId][skill] = {
          totalDispatches: 0,
          activations: 0,
          lastActivatedAt: '',
          recentWindow: [],
        };
      }
      const counter = this.data[agentId][skill];
      counter.totalDispatches++;
      const wasActivated = activated.has(skill);
      if (wasActivated) {
        counter.activations++;
        counter.lastActivatedAt = new Date().toISOString();
      }
      // Rolling window: keep enough entries for both stale detection and promotion
      const windowSize = Math.max(STALE_THRESHOLD, PROMOTION_MIN_WINDOW);
      counter.recentWindow.push(wasActivated);
      if (counter.recentWindow.length > windowSize) {
        counter.recentWindow.shift();
      }
    }
    this.dirty = true;
  }

  /**
   * Check for stale skills that should be auto-disabled and skills ready for promotion.
   * Call during gossip_collect flush.
   */
  checkLifecycle(index: SkillIndex): { disabled: string[]; promoted: string[] } {
    const disabled: string[] = [];
    const promoted: string[] = [];

    for (const [agentId, skills] of Object.entries(this.data)) {
      for (const [skill, counter] of Object.entries(skills)) {
        const mode = index.getSkillMode(agentId, skill);
        if (mode !== 'contextual') continue;

        // Auto-disable: last STALE_THRESHOLD dispatches had zero activations (rolling window)
        // Use recentWindow for recency, not cumulative counts which miss dormancy after early use
        const windowFull = counter.recentWindow.length >= STALE_THRESHOLD;
        const windowAllInactive = windowFull && counter.recentWindow.every(v => !v);
        if (windowAllInactive) {
          if (index.disable(agentId, skill)) {
            disabled.push(`${agentId}/${skill}`);
            process.stderr.write(`[gossipcat] Auto-disabled stale skill ${skill} for ${agentId} (${counter.totalDispatches} dispatches, ${counter.activations} activations)\n`);
          }
        }

        // Promotion: >80% activation in rolling window of 20+ dispatches
        if (counter.recentWindow.length >= PROMOTION_MIN_WINDOW) {
          const windowActivations = counter.recentWindow.filter(Boolean).length;
          const rate = windowActivations / counter.recentWindow.length;
          if (rate >= PROMOTION_RATE) {
            index.bind(agentId, skill, { mode: 'permanent' });
            promoted.push(`${agentId}/${skill}`);
            process.stderr.write(`[gossipcat] Promoted skill ${skill} for ${agentId} to permanent (${(rate * 100).toFixed(0)}% activation over ${counter.recentWindow.length} dispatches)\n`);
            // Clear counter — no longer tracked as contextual
            delete this.data[agentId][skill];
            this.dirty = true;
          }
        }
      }
    }
    return { disabled, promoted };
  }

  /** Flush counters to disk. Call during gossip_collect. */
  flush(): void {
    if (!this.dirty) return;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
    this.dirty = false;
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        // Validate structure: each agent → skill → counter with recentWindow array
        for (const [agentId, skills] of Object.entries(raw)) {
          if (!skills || typeof skills !== 'object') { delete raw[agentId]; continue; }
          for (const [skill, counter] of Object.entries(skills as Record<string, any>)) {
            if (!counter || typeof counter !== 'object' || !Array.isArray(counter.recentWindow)) {
              delete (skills as any)[skill];
            }
          }
        }
        this.data = raw;
      }
    } catch { /* start fresh */ }
  }
}
