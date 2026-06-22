import { useState, useEffect, useCallback, useRef } from 'react';
import { api, isUnauthorizedError } from '@/lib/api';
import { formatFetchError } from '@/lib/fetchError';
import type { OverviewData, AgentData, TasksData, ConsensusData, ConsensusReportsData, MemoryFile, FleetTrendResponse, SignalActivityResponse } from '@/lib/types';
import type { SkillsApiResponse } from '@gossip/types';

/**
 * Polling interval for /api/agents and friends. Backs the "Team page updates
 * after gossip_setup without a full page reload" contract:
 * setAgentConfigs (server.ts:455) pushes new configs into ctx, but the SPA
 * needs to actually fetch them. 5s balances freshness vs request volume —
 * dropped from 10s as part of issue #96 so fresh-install users don't stare
 * at an empty Team page for up to 10 seconds after running gossip_setup.
 */
const REFRESH_INTERVAL_MS = 5_000;

interface MemoryApiResponse { knowledge: MemoryFile[] }

export interface DashboardState {
  overview: OverviewData | null;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  consensus: ConsensusData | null;
  consensusReports: ConsensusReportsData | null;
  fleetTrend: FleetTrendResponse | null;
  /**
   * 24h per-agent signal-activity histogram from the flat signal log. Backs
   * the Overview ActivityWaterfall heatmap + "Signals · 24h" counter, which
   * previously under-reported because they were sourced from gated consensus
   * runs. Null while the first poll is in flight.
   */
  signalActivity: SignalActivityResponse | null;
  /**
   * Step 9.5 — per-skill post-bind effectiveness curves. Drives the
   * SkillGraduationGrid sparklines + skill-count subtitle. Null while
   * the first poll is in flight.
   */
  skills: SkillsApiResponse | null;
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

/**
 * Wraps an api() call with an endpoint label so that when Promise.all rejects,
 * the error message names the failing endpoint and HTTP status (e.g.
 * "overview: HTTP 500", "consensus: network error") instead of a bare
 * "Failed to fetch" that gives the user zero diagnostic context.
 *
 * Only used for the core endpoints that do NOT have .catch() fallbacks — the
 * optional endpoints (fleet-trend, skills, etc.) already swallow their errors
 * and return safe defaults.
 */
async function namedFetch<T>(endpoint: string, path: string): Promise<T> {
  try {
    return await api<T>(path);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(formatFetchError(endpoint, raw));
  }
}

/**
 * @param onUnauthorized Called when a core fetch returns 401 — wired by App to
 * the auth recheck so a dead session (e.g. relay restarted, cookie expired)
 * sends the user back to AuthGate instead of an error card / infinite spinner
 * (issue #548 item 3b).
 */
export function useDashboardData(onUnauthorized?: () => void) {
  const [state, setState] = useState<DashboardState>({
    overview: null, agents: null, tasks: null, consensus: null, consensusReports: null,
    fleetTrend: null,
    signalActivity: null,
    skills: null,
    nativeMemories: null, gossipMemories: null, memories: null,
    loading: true, error: null,
  });
  // In-flight guard: prevents piling up overlapping requests if one poll is
  // slower than REFRESH_INTERVAL_MS (e.g., cold native-memory read on a
  // project with thousands of auto-memory files). Skipping is safe — the next
  // tick fires a fresh request.
  const inFlight = useRef(false);
  // Keep the latest onUnauthorized in a ref so refresh stays a stable callback
  // (empty dep array) — the polling interval below depends on refresh identity.
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [overview, agents, tasks, consensus, consensusReports, fleetTrend, signalActivity, skills, nativeResp, gossipResp] = await Promise.all([
        // Core endpoints: no .catch() — a failure here rejects the whole Promise.all
        // so the catch block below can set error with a named-endpoint message.
        namedFetch<OverviewData>('overview', 'overview'),
        namedFetch<AgentData[]>('agents', 'agents'),
        namedFetch<TasksData>('tasks', 'tasks?limit=2000'),
        // pageSize=50 matches api-consensus MAX_PAGE_SIZE so header aggregates
        // (confirmedTotal/disputedTotal/unverifiedTotal in App.tsx:383-385) cover
        // the full round history instead of the first 10 runs.
        namedFetch<ConsensusData>('consensus', 'consensus?pageSize=500'),
        // pageSize=200 (was 5) — Step 6 useSeverityCounts needs recent reports
        // to derive per-agent severity distributions for the card gauge/strip.
        api<ConsensusReportsData>('consensus-reports?page=1&pageSize=200').catch(() => ({ reports: [] })),
        // Fleet trend — 7-day window for AreaSparkline in AgentCardBig.
        api<FleetTrendResponse>('fleet-trend?days=7').catch(() => ({ days: 7, points: [] })),
        // 24h per-agent signal-activity histogram from the flat signal log —
        // backs the ActivityWaterfall heatmap so manual/single-dispatch signals
        // appear (consensus-runs feed is gated to ≥2 agents & ≥3 signals).
        api<SignalActivityResponse>('signal-activity').catch(() => ({ agents: [], total: 0, generatedAt: '' })),
        // Step 9.5 — per-skill effectiveness curves for SkillGraduationGrid.
        // Server-side 60s cache keyed on agent-performance.jsonl mtime — the
        // 5s poll just refreshes the cache stamp, not the curve derivation.
        api<SkillsApiResponse>('skills').catch(() => ({ index: {}, suggestions: [], effectiveness: [] })),
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
        fleetTrend,
        signalActivity,
        skills,
        nativeMemories,
        gossipMemories,
        memories: nativeMemories, // deprecated legacy alias
        loading: false, error: null,
      });
    } catch (err) {
      // A 401 means the session died (relay restart, expired cookie). Hand off
      // to the auth recheck instead of rendering an error card — it lands the
      // user back at AuthGate. Skip setting the error string so we don't flash
      // a stale "unauthorized" card during the transition.
      if (isUnauthorizedError(err)) {
        onUnauthorizedRef.current?.();
        setState((s) => ({ ...s, loading: false }));
      } else {
        setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
      }
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
