import { SkillIndex, SkillIndexData } from '@gossip/orchestrator/skill-index';
import { readJsonlWithRotated, normalizeSkillName, resolveSkill } from '@gossip/orchestrator';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { SkillVerdict, SkillCurvePoint, SkillEffectivenessEntry } from '@gossip/types';

// Re-export from @gossip/types so relay consumers get the canonical types.
export type { SkillVerdict, SkillCurvePoint, SkillEffectivenessEntry };

export interface SkillsGetResponse {
  index: SkillIndexData;
  suggestions: string[];
  /**
   * Per-skill post-bind effectiveness curves. One entry per enabled skill
   * binding across the fleet. Empty array when no skills are bound.
   *
   * Derivation: signals from agent-performance.jsonl where
   *   signal.agentId === agent && normalizeSkillName(signal.category) === skill
   *   && signal.timestamp >= boundAt
   * are bucketed into NUM_BUCKETS equal-time windows over [boundAt, now] and
   * each bucket reports accuracy = correct/(correct+hallucinated). Cached
   * for CACHE_TTL_MS keyed on the jsonl mtime.
   */
  effectiveness: SkillEffectivenessEntry[];
}

export interface SkillsBindRequest { agent_id: string; skill: string; enabled: boolean; }
export interface SkillsBindResponse { success: boolean; error?: string; }

const AGENT_ID_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

/** Curve resolution. Spec-default 10 windows; held in a constant for clarity. */
const NUM_BUCKETS = 10;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7d effectiveness window
/** Fallback threshold when frontmatter has no `passed_baseline_rate`. */
const DEFAULT_THRESHOLD = 0.7;
/** Cache TTL — short enough to stay live during a session, long enough to
 *  amortize the jsonl scan across the 5s dashboard poll. */
const CACHE_TTL_MS = 60_000;

function isCorrupt(projectRoot: string, index: SkillIndex): boolean {
  return existsSync(join(projectRoot, '.gossip', 'skill-index.json')) && !index.exists();
}

/* ── frontmatter (status + bound_at + passed_baseline_rate + provenance) ── */

interface SkillFrontmatter {
  status?: string;
  bound_at?: string;
  passed_baseline_rate?: number;
  /** Stored effectiveness delta (pre/post hallucination rate) — verdict basis. */
  effectiveness?: number;
  /** ISO timestamp when the skill passed — best "verdict as of" stamp. */
  passed_at?: string;
  /** ISO timestamp when inconclusive verdict was recorded. */
  inconclusive_at?: string;
  /** ISO timestamp when the skill regressed from a previously-passed state. */
  regressed_from_passed_at?: string;
}

function readSkillFrontmatter(
  projectRoot: string,
  agentId: string,
  skillName: string,
): SkillFrontmatter | null {
  try {
    const resolved = resolveSkill(agentId, skillName, projectRoot);
    if (!resolved) return null;
    const raw = resolved.content;
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return null;
    const block = raw.slice(3, end);
    const out: SkillFrontmatter = {};
    for (const line of block.split('\n')) {
      // Strip inline comments before matching to handle `key: value  # note`
      const trimmed = line.replace(/#.*$/, '').trim();
      const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
      if (!m) continue;
      const key = m[1];
      let value: string = m[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'status') out.status = value;
      else if (key === 'bound_at') out.bound_at = value;
      else if (key === 'passed_baseline_rate') {
        const n = Number(value);
        if (Number.isFinite(n)) out.passed_baseline_rate = n;
      } else if (key === 'effectiveness') {
        const n = Number(value);
        if (Number.isFinite(n)) out.effectiveness = n;
      } else if (key === 'passed_at') out.passed_at = value;
      else if (key === 'inconclusive_at') out.inconclusive_at = value;
      else if (key === 'regressed_from_passed_at') out.regressed_from_passed_at = value;
    }
    // Return null instead of empty object when no recognized fields were parsed
    if (!out.status && !out.bound_at && out.passed_baseline_rate === undefined
        && out.effectiveness === undefined && !out.passed_at && !out.inconclusive_at
        && !out.regressed_from_passed_at) return null;
    return out;
  } catch {
    return null;
  }
}

/* ── signal index (per-agent, per-normalized-skill) ────────────────────── */

interface SignalEvent {
  ts: number;
  signal: string;
}

interface SignalIndex {
  /** agentId → normalizedSkill → events (chronological order). */
  byAgentSkill: Map<string, Map<string, SignalEvent[]>>;
}

const CORRECT_SIGNALS = new Set([
  'agreement',
  'category_confirmed',
  'consensus_verified',
  'unique_confirmed',
]);
const HALLUC_SIGNALS = new Set(['disagreement', 'hallucination_caught']);

function buildSignalIndex(projectRoot: string): SignalIndex {
  const idx: SignalIndex = { byAgentSkill: new Map() };
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return idx;
  let raw: string;
  try { raw = readJsonlWithRotated(perfPath); } catch { return idx; }
  if (!raw) return idx;

  // Track scoped + wildcard retractions on the same pass, then re-filter.
  const retracted = new Set<string>();
  const retractedConsensusIds = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  for (const r of rows) {
    if (r.signal === 'consensus_round_retracted') {
      const cid = (r as { consensus_id?: unknown }).consensus_id;
      if (typeof cid === 'string' && cid.length > 0) retractedConsensusIds.add(cid);
      continue;
    }
    if (r.signal === 'signal_retracted') {
      const agentId = r.agentId as string | undefined;
      const taskKey = (r.taskId ?? r.timestamp) as string | undefined;
      const retractedSignal = (r as { retractedSignal?: unknown }).retractedSignal;
      if (!agentId || !taskKey) continue;
      if (typeof retractedSignal === 'string') {
        retracted.add(`${agentId}:${taskKey}:${retractedSignal}`);
      } else {
        retracted.add(`${agentId}:${taskKey}:*`);
      }
    }
  }

  for (const r of rows) {
    if (r.type !== 'consensus') continue;
    const signal = r.signal as string | undefined;
    if (!signal) continue;
    if (!CORRECT_SIGNALS.has(signal) && !HALLUC_SIGNALS.has(signal)) continue;
    const agentId = r.agentId as string | undefined;
    const category = r.category as string | undefined;
    const tsStr = r.timestamp as string | undefined;
    if (!agentId || !category || !tsStr) continue;
    const ts = new Date(tsStr).getTime();
    if (!Number.isFinite(ts) || ts === 0) continue;

    // Retraction filter
    const taskKey = (r.taskId ?? tsStr) as string;
    if (retracted.has(`${agentId}:${taskKey}:${signal}`)) continue;
    if (retracted.has(`${agentId}:${taskKey}:*`)) continue;
    const findingId = (r as { findingId?: unknown }).findingId;
    if (typeof findingId === 'string') {
      let drop = false;
      for (const cid of retractedConsensusIds) {
        if (findingId.startsWith(cid + ':')) { drop = true; break; }
      }
      if (drop) continue;
    }

    const skillKey = normalizeSkillName(category);
    if (!skillKey) continue;
    let perAgent = idx.byAgentSkill.get(agentId);
    if (!perAgent) { perAgent = new Map(); idx.byAgentSkill.set(agentId, perAgent); }
    let arr = perAgent.get(skillKey);
    if (!arr) { arr = []; perAgent.set(skillKey, arr); }
    arr.push({ ts, signal });
  }

  // Sort each bucket chronologically.
  for (const perAgent of idx.byAgentSkill.values()) {
    for (const arr of perAgent.values()) arr.sort((a, b) => a.ts - b.ts);
  }
  return idx;
}

/* ── effectiveness derivation ──────────────────────────────────────────── */

function deriveEffectiveness(
  projectRoot: string,
  index: SkillIndex,
  signalIdx: SignalIndex,
  nowMs: number,
): SkillEffectivenessEntry[] {
  const out: SkillEffectivenessEntry[] = [];
  for (const agentId of index.getAgentIds()) {
    for (const slot of index.getAgentSlots(agentId)) {
      if (!slot.enabled) continue;
      const fm = readSkillFrontmatter(projectRoot, agentId, slot.skill);
      const boundAtIso = fm?.bound_at ?? slot.boundAt;
      const boundAtMs = new Date(boundAtIso).getTime();
      if (!Number.isFinite(boundAtMs) || boundAtMs <= 0) continue;
      // Bucket span: cap to a recent 7d window so dense recent activity fills
      // all buckets instead of clustering into 2-3 of N. Skills bound long ago
      // with no recent signals collapse to empty buckets (threshold-only render).
      const windowStartMs = Math.max(boundAtMs, nowMs - WINDOW_MS);
      const totalSpan = Math.max(nowMs - windowStartMs, NUM_BUCKETS);
      const bucketMs = totalSpan / NUM_BUCKETS;
      const events = signalIdx.byAgentSkill.get(agentId)?.get(normalizeSkillName(slot.skill)) ?? [];
      const buckets: Array<{ c: number; h: number }> = Array.from(
        { length: NUM_BUCKETS },
        () => ({ c: 0, h: 0 }),
      );
      let n = 0;
      for (const ev of events) {
        if (ev.ts < windowStartMs) continue;
        const rel = ev.ts - windowStartMs;
        let i = Math.floor(rel / bucketMs);
        if (i < 0) i = 0;
        if (i >= NUM_BUCKETS) i = NUM_BUCKETS - 1;
        if (CORRECT_SIGNALS.has(ev.signal)) buckets[i].c++;
        else if (HALLUC_SIGNALS.has(ev.signal)) buckets[i].h++;
        n++;
      }
      const curve: SkillCurvePoint[] = buckets.map((b, i) => {
        const total = b.c + b.h;
        const t = windowStartMs + (i + 1) * bucketMs;
        return { t, value: total > 0 ? b.c / total : null };
      });
      const threshold = fm?.passed_baseline_rate ?? DEFAULT_THRESHOLD;
      const status = (fm?.status as SkillVerdict | undefined) ?? null;

      // Verdict provenance — "verdict as of" timestamp (best-available stamp).
      const verdictAt: string | undefined =
        fm?.passed_at ?? fm?.inconclusive_at ?? fm?.regressed_from_passed_at ?? fm?.bound_at;

      // liveRecovered: frozen verdict says failed/silent but live 7d shows recovery.
      const isFailedVerdict = status === 'failed' || status === 'silent_skill';
      let liveRecovered: boolean | undefined;
      if (isFailedVerdict && n > 0) {
        // Trailing rate: last non-null bucket value, or n-weighted mean over all buckets.
        let trailingRate: number | null = null;
        for (let i = curve.length - 1; i >= 0; i--) {
          const v = curve[i].value;
          if (v != null && Number.isFinite(v)) { trailingRate = v; break; }
        }
        if (trailingRate == null) {
          // Fallback: n-weighted mean
          let totalCorrect = 0;
          for (const b of buckets) totalCorrect += b.c;
          trailingRate = n > 0 ? totalCorrect / n : 0;
        }
        liveRecovered = trailingRate >= threshold;
      }

      out.push({
        agentId,
        skill: slot.skill,
        status,
        curve,
        threshold,
        n,
        boundAt: boundAtIso,
        ...(fm?.effectiveness !== undefined ? { storedEffectiveness: fm.effectiveness } : {}),
        ...(verdictAt !== undefined ? { verdictAt } : {}),
        ...(liveRecovered !== undefined ? { liveRecovered } : {}),
      });
    }
  }
  return out;
}

/* ── cache ─────────────────────────────────────────────────────────────── */

interface CacheEntry {
  payload: SkillsGetResponse;
  builtAtMs: number;
  jsonlMtimeMs: number;
}
const cache = new Map<string, CacheEntry>();

function jsonlMtime(projectRoot: string): number {
  try {
    return statSync(join(projectRoot, '.gossip', 'agent-performance.jsonl')).mtimeMs;
  } catch { return 0; }
}

function cacheHit(projectRoot: string, nowMs: number): SkillsGetResponse | null {
  const entry = cache.get(projectRoot);
  if (!entry) return null;
  if (nowMs - entry.builtAtMs > CACHE_TTL_MS) return null;
  if (entry.jsonlMtimeMs !== jsonlMtime(projectRoot)) return null;
  return entry.payload;
}

/* ── handlers ──────────────────────────────────────────────────────────── */

export async function skillsGetHandler(projectRoot: string): Promise<SkillsGetResponse> {
  const nowMs = Date.now();
  const cached = cacheHit(projectRoot, nowMs);
  if (cached) return cached;
  try {
    const index = new SkillIndex(projectRoot);
    let effectiveness: SkillEffectivenessEntry[] = [];
    try {
      const signalIdx = buildSignalIndex(projectRoot);
      effectiveness = deriveEffectiveness(projectRoot, index, signalIdx, nowMs);
    } catch { /* leave empty on derivation failure */ }
    const payload: SkillsGetResponse = {
      index: index.getIndex(),
      suggestions: [],
      effectiveness,
    };
    cache.set(projectRoot, {
      payload,
      builtAtMs: nowMs,
      jsonlMtimeMs: jsonlMtime(projectRoot),
    });
    return payload;
  } catch {
    return { index: {}, suggestions: [], effectiveness: [] };
  }
}

export async function skillsBindHandler(projectRoot: string, body: SkillsBindRequest): Promise<SkillsBindResponse> {
  if (!body.agent_id || !AGENT_ID_RE.test(body.agent_id)) return { success: false, error: 'Invalid agent_id' };
  if (!body.skill || typeof body.skill !== 'string' || !AGENT_ID_RE.test(body.skill)) return { success: false, error: 'Invalid skill name' };
  try {
    const index = new SkillIndex(projectRoot);
    if (isCorrupt(projectRoot, index)) {
      return { success: false, error: 'Could not parse skill-index.json' };
    }
    if (body.enabled) {
      index.bind(body.agent_id, body.skill, { enabled: true, source: 'manual' });
    } else {
      const changed = index.disable(body.agent_id, body.skill);
      if (!changed) return { success: false, error: 'Skill not bound to agent' };
    }
    // Bust the effectiveness cache so the next GET reflects the new binding.
    cache.delete(projectRoot);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
