import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { normalizeSkillName } from './skill-name';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype', '_project']);

/** A single skill binding for an agent — like a smart contract storage slot */
export interface SkillSlot {
  skill: string;
  enabled: boolean;
  source: 'config' | 'manual' | 'auto' | 'imported';
  version: number;
  boundAt: string; // ISO timestamp
}

/** The full index: agent → skill → slot */
export type SkillIndexData = Record<string, Record<string, SkillSlot>>;

/**
 * Per-agent skill index — deterministic addressing for skill bindings.
 *
 * Like smart contract storage slots:
 * - agent.slot[skill] → { enabled, version, source }
 * - O(1) lookup, no scanning
 * - Enable/disable without deleting
 * - Shared skills, per-agent binding
 *
 * Persists to `.gossip/skill-index.json`.
 */
export class SkillIndex {
  private data: SkillIndexData = {};
  private readonly filePath: string;
  private dirty = false;
  private _exists = false;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, '.gossip', 'skill-index.json');
    this.load();
  }

  /** Bind a skill to an agent (creates or updates the slot) */
  bind(agentId: string, skill: string, options?: { enabled?: boolean; source?: SkillSlot['source'] }): SkillSlot {
    this.validateAgentId(agentId);
    const name = this.validateSkillName(skill);
    if (!this.data[agentId]) this.data[agentId] = Object.create(null);

    const existing = this.data[agentId][name];
    const slot: SkillSlot = {
      skill: name,
      enabled: options?.enabled ?? true,
      source: options?.source ?? existing?.source ?? 'manual',
      version: existing ? existing.version + 1 : 1,
      boundAt: new Date().toISOString(),
    };

    this.data[agentId][name] = slot;
    this.dirty = true;
    this.save();
    return slot;
  }

  /** Unbind a skill from an agent (removes the slot entirely) */
  unbind(agentId: string, skill: string): boolean {
    this.validateAgentId(agentId);
    const name = normalizeSkillName(skill);
    if (!this.data[agentId]?.[name]) return false;

    delete this.data[agentId][name];
    if (Object.keys(this.data[agentId]).length === 0) delete this.data[agentId];
    this.dirty = true;
    this.save();
    return true;
  }

  /** Enable a previously disabled skill slot */
  enable(agentId: string, skill: string): boolean {
    this.validateAgentId(agentId);
    const slot = this.resolveSlot(agentId, skill);
    if (!slot) return false;
    slot.enabled = true;
    slot.version++;
    this.dirty = true;
    this.save();
    return true;
  }

  /** Disable a skill slot without removing it */
  disable(agentId: string, skill: string): boolean {
    this.validateAgentId(agentId);
    const slot = this.resolveSlot(agentId, skill);
    if (!slot) return false;
    slot.enabled = false;
    slot.version++;
    this.dirty = true;
    this.save();
    return true;
  }

  /**
   * Resolve a skill slot by normalized name, falling back to raw key lookup.
   * This handles on-disk data that was written without normalization.
   */
  private resolveSlot(agentId: string, skill: string): SkillSlot | undefined {
    const agentSlots = this.data[agentId];
    if (!agentSlots) return undefined;
    const name = normalizeSkillName(skill);
    if (agentSlots[name]) return agentSlots[name];
    // Fallback: search by matching normalized value of stored key
    for (const key of Object.keys(agentSlots)) {
      if (normalizeSkillName(key) === name) return agentSlots[key];
    }
    return undefined;
  }

  /** Get all enabled skill names for an agent */
  getEnabledSkills(agentId: string): string[] {
    const agentSlots = this.data[agentId];
    if (!agentSlots) return [];
    return Object.values(agentSlots)
      .filter(s => s.enabled)
      .map(s => s.skill);
  }

  /** Get all slots for an agent (enabled and disabled) — returns copies */
  getAgentSlots(agentId: string): SkillSlot[] {
    const agentSlots = this.data[agentId];
    if (!agentSlots) return [];
    return Object.values(agentSlots).map(s => ({ ...s }));
  }

  /** Get a specific slot — returns a copy */
  getSlot(agentId: string, skill: string): SkillSlot | undefined {
    const slot = this.data[agentId]?.[normalizeSkillName(skill)];
    return slot ? { ...slot } : undefined;
  }

  /** Get the full index data — returns a deep copy */
  getIndex(): SkillIndexData {
    return JSON.parse(JSON.stringify(this.data));
  }

  /** Get all agent IDs in the index */
  getAgentIds(): string[] { return Object.keys(this.data); }

  /** Check if an index file exists (for backward compat detection) */
  exists(): boolean { return this._exists; }

  /**
   * Seed index from agent configs — call once on first load when no index file exists.
   * Imports existing config.skills[] as 'config' source slots.
   */
  seedFromConfigs(agents: Array<{ id: string; skills: string[] }>): void {
    for (const agent of agents) {
      if (DANGEROUS_KEYS.has(agent.id) || !agent.id) continue;
      if (!this.data[agent.id]) this.data[agent.id] = Object.create(null);
      for (const skill of agent.skills) {
        if (typeof skill !== 'string' || !skill) continue;
        const name = normalizeSkillName(skill);
        if (!name) continue;
        if (!this.data[agent.id][name]) {
          this.data[agent.id][name] = {
            skill: name,
            enabled: true,
            source: 'config',
            version: 1,
            boundAt: new Date().toISOString(),
          };
        }
      }
    }
    this.dirty = true;
    this.save();
  }

  private validateAgentId(agentId: string): void {
    if (!agentId || typeof agentId !== 'string' || DANGEROUS_KEYS.has(agentId)) {
      throw new Error(`Invalid agentId: "${agentId}"`);
    }
  }

  private validateSkillName(skill: string): string {
    const name = normalizeSkillName(skill);
    if (!name) throw new Error(`Invalid skill name: "${skill}"`);
    return name;
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Structural validation: must be a non-null, non-array object
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // Sanitize: remove prototype-polluting keys from disk JSON
        for (const key of Object.keys(parsed)) {
          if (DANGEROUS_KEYS.has(key)) delete parsed[key];
        }
        this.data = parsed as SkillIndexData;
        this._exists = true;
      }
    } catch { /* file doesn't exist or corrupted — start fresh */ }
  }

  private save(): void {
    if (!this.dirty) return;
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true }); // idempotent, no TOCTOU
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n');
    this._exists = true;
    this.dirty = false;
  }
}
