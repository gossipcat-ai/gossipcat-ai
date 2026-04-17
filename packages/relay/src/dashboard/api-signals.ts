import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface SignalEntry {
  type: string;
  signal: string;
  agentId: string;
  counterpartId?: string;
  taskId?: string;
  consensusId?: string;
  findingId?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  category?: string;
  source?: string;
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
  /**
   * Cursor for the next page: the timestamp of the last returned item.
   * Only set when more items exist beyond the current page. Clients pass
   * this back as `?cursor=<ts>` to retrieve strictly older rows.
   */
  nextCursor?: string;
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

type SourceBucket = 'manual' | 'impl' | 'meta' | 'auto-provisional';

const META_SIGNALS = new Set(['task_completed', 'tool_turns', 'format_compliance']);

function inferSource(entry: { signal?: string; source?: string }): SourceBucket {
  const raw = typeof entry.source === 'string' ? entry.source.toLowerCase() : '';
  if (raw === 'manual' || raw === 'impl' || raw === 'meta' || raw === 'auto-provisional') {
    return raw;
  }
  const sig = typeof entry.signal === 'string' ? entry.signal : '';
  if (sig.startsWith('impl_')) return 'impl';
  if (META_SIGNALS.has(sig)) return 'meta';
  return 'manual';
}

export async function signalsHandler(projectRoot: string, query?: URLSearchParams): Promise<SignalsResponse> {
  const agentFilter = query?.get('agent') ?? null;
  const counterpartFilter = query?.get('counterpart') ?? null;
  // Cap repeats to prevent memory/CPU DoS via 10000+ repeated ?signal= params.
  const signalFilters = (query?.getAll('signal') ?? []).slice(0, 50);
  const categoryFilter = query?.get('category') ?? null;
  const severityFilter = query?.get('severity') ?? null;
  const sinceFilter = query?.get('since') ?? null;
  const untilFilter = query?.get('until') ?? null;
  const consensusIdFilter = query?.get('consensus_id') ?? null;
  const findingIdFilter = query?.get('finding_id') ?? null;
  const sourceFilter = query?.get('source') ?? null;
  const cursor = query?.get('cursor') ?? null;

  const limit = Math.min(Math.max(parseInt(query?.get('limit') ?? '', 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(parseInt(query?.get('offset') ?? '', 10) || 0, 0);

  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return { items: [], total: 0, offset, limit };

  const all: SignalEntry[] = [];
  const roundRetractions: RoundRetractionEntry[] = [];
  const signalFilterSet = signalFilters.length ? new Set(signalFilters) : null;
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
        if (counterpartFilter && entry.counterpartId !== counterpartFilter) continue;
        if (signalFilterSet && !signalFilterSet.has(entry.signal)) continue;
        if (categoryFilter && entry.category !== categoryFilter) continue;
        if (severityFilter && entry.severity !== severityFilter) continue;
        if (sinceFilter && typeof entry.timestamp === 'string' && entry.timestamp < sinceFilter) continue;
        if (untilFilter && typeof entry.timestamp === 'string' && entry.timestamp >= untilFilter) continue;
        if (consensusIdFilter) {
          const cid = typeof entry.consensusId === 'string' ? entry.consensusId : '';
          if (!cid.startsWith(consensusIdFilter)) continue;
        }
        if (findingIdFilter) {
          const fid = typeof entry.findingId === 'string' ? entry.findingId : '';
          if (!fid.startsWith(findingIdFilter)) continue;
        }
        if (sourceFilter) {
          if (inferSource(entry) !== sourceFilter) continue;
        }
        all.push(entry);
      } catch { /* skip malformed */ }
    }
  } catch { return { items: [], total: 0, offset, limit }; }

  all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Cursor pagination: cursor is the timestamp of the last item from the prior
  // page. Return items strictly older than cursor. When cursor is omitted,
  // fall back to legacy offset-based slicing so existing callers keep working.
  let items: SignalEntry[];
  let nextCursor: string | undefined;
  if (cursor) {
    const filtered = all.filter((e) => e.timestamp < cursor);
    items = filtered.slice(0, limit);
    if (filtered.length > limit) nextCursor = items[items.length - 1]?.timestamp;
  } else {
    items = all.slice(offset, offset + limit);
    // Only emit nextCursor for cursor-style pagination (offset==0 implies the
    // caller is paging from the newest row).
    if (offset === 0 && all.length > limit) nextCursor = items[items.length - 1]?.timestamp;
  }

  const response: SignalsResponse = { items, total: all.length, offset, limit, roundRetractions };
  if (nextCursor) response.nextCursor = nextCursor;
  return response;
}
