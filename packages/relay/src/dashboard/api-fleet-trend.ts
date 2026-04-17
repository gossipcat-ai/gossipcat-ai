import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

export interface FleetTrendPoint {
  day: string; // ISO date YYYY-MM-DD
  agentId: string;
  accuracy: number;
  signals: number;
}

export interface FleetTrendResponse {
  days: number;
  points: FleetTrendPoint[];
}

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface CacheEntry { mtime: number; payload: FleetTrendResponse; }
const cache = new Map<string, CacheEntry>();

export async function fleetTrendHandler(projectRoot: string, query?: URLSearchParams): Promise<FleetTrendResponse> {
  const rawDays = parseInt(query?.get('days') ?? '', 10);
  const days = isNaN(rawDays) || rawDays < 1 ? DEFAULT_DAYS : Math.min(rawDays, MAX_DAYS);

  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return { days, points: [] };
  const mtime = statSync(perfPath).mtimeMs;
  const cacheKey = `${projectRoot}::${days}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.mtime === mtime) return cached.payload;

  const cutoff = Date.now() - days * DAY_MS;
  // per-agent per-day: {good, total} → accuracy = good/total
  const buckets = new Map<string, Map<string, { good: number; total: number }>>();

  try {
    const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type !== 'consensus' || !rec.agentId || rec.agentId === '_system' || !rec.timestamp) continue;
        const t = Date.parse(rec.timestamp);
        if (!Number.isFinite(t) || t < cutoff) continue;
        const day = new Date(t).toISOString().slice(0, 10);
        let byDay = buckets.get(rec.agentId);
        if (!byDay) { byDay = new Map(); buckets.set(rec.agentId, byDay); }
        let counts = byDay.get(day);
        if (!counts) { counts = { good: 0, total: 0 }; byDay.set(day, counts); }
        counts.total++;
        if (rec.signal === 'agreement' || rec.signal === 'unique_confirmed' || rec.signal === 'consensus_verified') counts.good++;
      } catch { /* skip */ }
    }
  } catch { return { days, points: [] }; }

  const points: FleetTrendPoint[] = [];
  for (const [agentId, byDay] of buckets) {
    for (const [day, c] of byDay) {
      if (c.total === 0) continue;
      points.push({ day, agentId, accuracy: c.good / c.total, signals: c.total });
    }
  }
  points.sort((a, b) => a.day.localeCompare(b.day) || a.agentId.localeCompare(b.agentId));

  const payload: FleetTrendResponse = { days, points };
  cache.set(cacheKey, { mtime, payload });
  return payload;
}
