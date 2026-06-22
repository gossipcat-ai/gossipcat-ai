import { join } from 'path';
import { readJsonlWithRotated } from '@gossip/orchestrator';

/**
 * Per-agent 24h signal-activity histogram, sourced from the FLAT signal log
 * (`.gossip/agent-performance.jsonl`) rather than from gated consensus runs.
 *
 * Why this exists: the Overview waterfall previously derived its heatmap from
 * the /api/consensus runs feed, which is gated to ≥2 agents & ≥3 signals
 * (api-consensus.ts). Manually-recorded signals and single-dispatch signals
 * never reach that feed, so the heatmap + "Signals · 24h" counter under-reported
 * to zero while the Signal stream (api-signals.ts) showed activity. This handler
 * mirrors the api-signals inclusion rules so the numbers agree.
 */
export interface SignalActivityResponse {
  agents: { id: string; buckets: number[] }[];
  total: number;
  generatedAt: string;
}

const HOURS = 24;
const HOUR_MS = 3600_000;

export async function signalActivityHandler(projectRoot: string): Promise<SignalActivityResponse> {
  const now = Date.now();
  const cutoff = now - HOURS * HOUR_MS;
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');

  // Per-agent length-24 bucket arrays, lazily created on first sighting.
  const byAgent = new Map<string, number[]>();

  try {
    const raw = readJsonlWithRotated(perfPath);
    // readJsonlWithRotated returns '' (never null) when both the live and
    // rotated logs are absent/unreadable; '' is falsy so this also covers an
    // existing-but-empty file. Either way there is nothing to bucket.
    if (!raw) return { agents: [], total: 0, generatedAt: new Date(now).toISOString() };
    const lines = raw.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Same inclusion rules as the Signal stream (api-signals.ts) so the
        // counters agree: only consensus-type rows, drop round-retraction
        // tombstones and the `_system` sentinel.
        if (entry.type !== 'consensus') continue;
        if (entry.signal === 'consensus_round_retracted' || entry.agentId === '_system') continue;
        if (typeof entry.agentId !== 'string' || !entry.agentId) continue;

        const ts = Date.parse(entry.timestamp);
        if (Number.isNaN(ts) || ts < cutoff || ts > now) continue;

        // 0 = oldest hour in the window, 23 = current hour.
        const idx = Math.min(HOURS - 1, Math.floor((ts - cutoff) / HOUR_MS));
        let row = byAgent.get(entry.agentId);
        if (!row) {
          row = new Array(HOURS).fill(0);
          byAgent.set(entry.agentId, row);
        }
        row[idx] += 1;
      } catch { /* skip malformed */ }
    }
  } catch {
    return { agents: [], total: 0, generatedAt: new Date().toISOString() };
  }

  let total = 0;
  const agents: { id: string; buckets: number[] }[] = [];
  for (const [id, buckets] of byAgent) {
    for (const c of buckets) total += c;
    agents.push({ id, buckets });
  }

  return { agents, total, generatedAt: new Date(now).toISOString() };
}
