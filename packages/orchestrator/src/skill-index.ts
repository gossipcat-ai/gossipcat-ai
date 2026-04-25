import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { normalizeSkillName } from './skill-name';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype', '_project']);

/** A single skill binding for an agent — like a smart contract storage slot */
export interface SkillSlot {
  skill: string;
  enabled: boolean;
  source: 'config' | 'manual' | 'auto' | 'imported';
  mode: 'permanent' | 'contextual';
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
  bind(agentId: string, skill: string, options?: { enabled?: boolean; source?: SkillSlot['source']; mode?: SkillSlot['mode'] }): SkillSlot {
    this.validateAgentId(agentId);
    const name = this.validateSkillName(skill);
    if (!this.data[agentId]) this.data[agentId] = Object.create(null);

    const existing = this.data[agentId][name];
    const source = options?.source ?? existing?.source ?? 'manual';
    const slot: SkillSlot = {
      skill: name,
      enabled: options?.enabled ?? true,
      source,
      mode: options?.mode ?? existing?.mode ?? (source === 'auto' ? 'contextual' : 'permanent'),
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

  /** Get the mode for a specific skill slot */
  getSkillMode(agentId: string, skill: string): 'permanent' | 'contextual' {
    const slot = this.data[agentId]?.[normalizeSkillName(skill)];
    return slot?.mode ?? 'permanent';
  }

  /** Get all agent IDs in the index */
  getAgentIds(): string[] { return Object.keys(this.data); }

  /**
   * Drop entries for agents not in `validAgentIds`. Returns the list of
   * removed agent ids. Persists to disk if anything changed.
   *
   * Reconciles the on-disk skill index against the live agent roster
   * (e.g. `Object.keys(config.agents)`). Without this, deleted agents
   * keep ghost entries forever, inflating `getAgentIds().length` in
   * boot logs and skewing any downstream count.
   *
   * Out of scope: agent memory directories under `.gossip/agents/<id>/`.
   * This only touches the in-process `data` map and the
   * `.gossip/skill-index.json` file.
   */
  prune(validAgentIds: string[]): string[] {
    const valid = new Set<string>();
    for (const id of validAgentIds) {
      if (typeof id === 'string' && id.length > 0 && !DANGEROUS_KEYS.has(id)) {
        valid.add(id);
      }
    }
    const removed: string[] = [];
    for (const agentId of Object.keys(this.data)) {
      if (!valid.has(agentId)) {
        delete this.data[agentId];
        removed.push(agentId);
      }
    }
    if (removed.length > 0) {
      this.dirty = true;
      this.save();
    }
    return removed;
  }

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
            mode: 'permanent',
            version: 1,
            boundAt: new Date().toISOString(),
          };
        }
      }
    }
    this.dirty = true;
    this.save();
  }

  /**
   * Ensure a set of default skills is bound to every listed agent with the
   * EXACT mode the caller specifies (which should match the skill file's
   * declared frontmatter mode — the caller is responsible for parsing and
   * filtering). Idempotent: existing slots are untouched, missing ones are
   * added. Runs on EVERY boot (unlike seedFromConfigs which only runs on
   * first-ever init) so default skills reach all agents, including existing
   * installs with a previously-seeded index.
   *
   * **No overlap invariant:** if the same skill already exists on an agent
   * with a different mode, we respect the existing slot and do NOT overwrite
   * it. Permanent and contextual bindings for the same skill file on the same
   * agent cannot co-exist — the existing binding wins. This prevents the
   * ambiguity the user flagged ("there shouldn't be overlap between permanent
   * skills and context-based skills") — once bound, a slot's mode is
   * authoritative for that agent.
   *
   * Introduced 2026-04-08 after validation revealed mode:permanent default
   * skills were never injected into any agent — skill-loader.ts:42-45 uses
   * index.getEnabledSkills(agentId) which only returns bound slots, so a
   * permanent-mode file sitting in default-skills/ never reached any agent.
   */
  ensureBoundWithMode(
    skillNames: string[],
    agentIds: string[],
    mode: 'permanent' | 'contextual',
  ): void {
    let changed = false;
    for (const agentId of agentIds) {
      if (DANGEROUS_KEYS.has(agentId) || !agentId) continue;
      if (!this.data[agentId]) this.data[agentId] = Object.create(null);
      for (const skill of skillNames) {
        if (typeof skill !== 'string' || !skill) continue;
        const name = normalizeSkillName(skill);
        if (!name) continue;
        if (!this.data[agentId][name]) {
          this.data[agentId][name] = {
            skill: name,
            enabled: true,
            source: 'auto',
            mode,
            version: 1,
            boundAt: new Date().toISOString(),
          };
          changed = true;
        }
      }
    }
    if (changed) {
      this.dirty = true;
      this.save();
    }
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
        // Backfill mode for existing slots that don't have it
        for (const agentSlots of Object.values(parsed)) {
          if (!agentSlots || typeof agentSlots !== 'object') continue;
          for (const slot of Object.values(agentSlots) as any[]) {
            if (slot && !slot.mode) {
              slot.mode = (slot.source === 'auto' || slot.source === 'imported')
                ? 'contextual' : 'permanent';
            }
          }
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
