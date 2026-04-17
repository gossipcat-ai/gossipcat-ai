import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '@/lib/api';
import type { OverviewData, AgentData, TasksData, ConsensusData, ConsensusReportsData, MemoryFile } from '@/lib/types';

/**
 * Polling interval for /api/agents and friends. Backs the "Team page updates
 * after gossip_setup without a full page reload" contract:
 * setAgentConfigs (server.ts:455) pushes new configs into ctx, but the SPA
 * needs to actually fetch them. 10s balances freshness vs request volume.
 */
const REFRESH_INTERVAL_MS = 10_000;

interface MemoryApiResponse { knowledge: MemoryFile[] }

export interface DashboardState {
  overview: OverviewData | null;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  consensus: ConsensusData | null;
  consensusReports: ConsensusReportsData | null;
  /**
   * Claude Code auto-memory (`~/.claude/projects/-<cwd>/memory/`). Flat list,
   * no 4-folder taxonomy. Separate from gossipMemories — callers MUST NOT merge
   * the two arrays (spec invariant: separation is the whole point).
   */
  nativeMemories: MemoryFile[] | null;
  /**
   * Gossipcat-owned memory store (`<projectRoot>/.gossip/memory/`). Renders
   * with the 4-folder taxonomy + status filter.
   */
  gossipMemories: MemoryFile[] | null;
  /**
   * @deprecated Legacy unified field; still populated with nativeMemories for
   * one release so callers that haven't migrated keep working. New code should
   * read `nativeMemories` and `gossipMemories` directly.
   */
  memories: MemoryFile[] | null;
  loading: boolean;
  error: string | null;
}

export function useDashboardData() {
  const [state, setState] = useState<DashboardState>({
    overview: null, agents: null, tasks: null, consensus: null, consensusReports: null,
    nativeMemories: null, gossipMemories: null, memories: null,
    loading: true, error: null,
  });
  // In-flight guard: prevents piling up overlapping requests if one poll is
  // slower than REFRESH_INTERVAL_MS (e.g., cold native-memory read on a
  // project with thousands of auto-memory files). Skipping is safe — the next
  // tick fires a fresh request.
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [overview, agents, tasks, consensus, consensusReports, nativeResp, gossipResp] = await Promise.all([
        api<OverviewData>('overview'),
        api<AgentData[]>('agents'),
        api<TasksData>('tasks?limit=50'),
        // pageSize=50 matches api-consensus MAX_PAGE_SIZE so header aggregates
        // (confirmedTotal/disputedTotal/unverifiedTotal in App.tsx:383-385) cover
        // the full round history instead of the first 10 runs.
        api<ConsensusData>('consensus?pageSize=50'),
        api<ConsensusReportsData>('consensus-reports?page=1&pageSize=5').catch(() => ({ reports: [] })),
        // Native + gossip stores are fetched in parallel and kept SEPARATE. The
        // taxonomy/status split only applies to gossip memories. Native memories
        // render flat. Spec: docs/specs/2026-04-15-session-save-native-vs-gossip-memory.md
        api<MemoryApiResponse>('native-memory').catch(() => ({ knowledge: [] as MemoryFile[] })),
        api<MemoryApiResponse>('gossip-memory').catch(() => ({ knowledge: [] as MemoryFile[] })),
      ]);

      // Stamp origin on each file so the unified MemoryFolders view can
      // dedupe by `${origin}/${filename}` and keep cross-store collisions
      // visible. Spec: docs/specs/2026-04-17-unified-memory-view.md.
      const nativeMemories = [...(nativeResp.knowledge || [])]
        .map((m) => ({ ...m, origin: 'native' as const }))
        .sort((a, b) => (b.filename > a.filename ? 1 : -1));
      const gossipMemories = [...(gossipResp.knowledge || [])]
        .map((m) => ({ ...m, origin: 'gossip' as const }))
        .sort((a, b) => (b.filename > a.filename ? 1 : -1));

      setState({
        overview, agents, tasks, consensus, consensusReports,
        nativeMemories,
        gossipMemories,
        memories: nativeMemories, // deprecated legacy alias
        loading: false, error: null,
      });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll every REFRESH_INTERVAL_MS so the Team page, tasks list, and consensus
  // history pick up post-boot mutations (gossip_setup adding agents, new tasks
  // being dispatched, consensus rounds completing) without a full page reload.
  // Separate useEffect keeps cleanup clean — the interval is owned here, not
  // tangled with the initial fetch above.
  useEffect(() => {
    const id = setInterval(() => { refresh(); }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { ...state, refresh };
}
