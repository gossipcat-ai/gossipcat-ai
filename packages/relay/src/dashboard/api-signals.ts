import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SignalEntry {
  type: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  taskId?: string;
  evidence?: string;
  finding?: string;
  timestamp: string;
}

export interface RoundRetractionEntry {
  consensus_id: string;
  reason: string;
  retracted_at: string;
}

export interface SignalsResponse {
  items: SignalEntry[];
  total: number;
  offset: number;
  limit: number;
  /**
   * Round-level retraction tombstones, returned in their own channel so
   * they don't corrupt per-agent SignalEntry rendering (tombstones have
   * agentId='_system' sentinel, not a real agent). Every row with the
   * same consensus_id is preserved so admin views can see duplicate
   * retractions with different reasons.
   */
  roundRetractions?: RoundRetractionEntry[];
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function signalsHandler(projectRoot: string, query?: URLSearchParams): Promise<SignalsResponse> {
  const agentFilter = query?.get('agent') ?? null;
  const limit = Math.min(Math.max(parseInt(query?.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(query?.get('offset') ?? '', 10) || 0, 0);

  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return { items: [], total: 0, offset, limit };

  const all: SignalEntry[] = [];
  const roundRetractions: RoundRetractionEntry[] = [];
  try {
    const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'consensus') continue;
        // Route round-retraction tombstones into their own channel and drop
        // `_system` sentinel rows from per-agent signal rendering.
        if (entry.signal === 'consensus_round_retracted' || entry.agentId === '_system') {
          if (entry.signal === 'consensus_round_retracted' && typeof entry.consensus_id === 'string') {
            roundRetractions.push({
              consensus_id: entry.consensus_id,
              reason: typeof entry.reason === 'string' ? entry.reason : '',
              retracted_at: typeof entry.retracted_at === 'string' ? entry.retracted_at : (entry.timestamp || ''),
            });
          }
          continue;
        }
        if (agentFilter && entry.agentId !== agentFilter) continue;
        all.push(entry);
      } catch { /* skip malformed */ }
    }
  } catch { return { items: [], total: 0, offset, limit }; }

  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return { items: all.slice(offset, offset + limit), total: all.length, offset, limit, roundRetractions };
}
