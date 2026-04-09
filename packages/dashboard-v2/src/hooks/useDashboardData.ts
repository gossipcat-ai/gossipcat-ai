import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { OverviewData, AgentData, TasksData, ConsensusData, ConsensusReportsData, MemoryFile, MemoryData } from '@/lib/types';

export interface DashboardState {
  overview: OverviewData | null;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  consensus: ConsensusData | null;
  consensusReports: ConsensusReportsData | null;
  memories: MemoryFile[] | null;
  loading: boolean;
  error: string | null;
}

export function useDashboardData() {
  const [state, setState] = useState<DashboardState>({
    overview: null, agents: null, tasks: null, consensus: null, consensusReports: null, memories: null,
    loading: true, error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const [overview, agents, tasks, consensus, consensusReports] = await Promise.all([
        api<OverviewData>('overview'),
        api<AgentData[]>('agents'),
        api<TasksData>('tasks?limit=50'),
        // pageSize=50 matches api-consensus MAX_PAGE_SIZE so header aggregates
        // (confirmedTotal/disputedTotal/unverifiedTotal in App.tsx:383-385) cover
        // the full round history instead of the first 10 runs.
        api<ConsensusData>('consensus?pageSize=50'),
        api<ConsensusReportsData>('consensus-reports?page=1&pageSize=5').catch(() => ({ reports: [] })),
      ]);

      // Fetch memories for top agents + _project
      const agentIds = agents.slice(0, 5).map((a) => a.id).concat(['_project']);
      const memoryResults = await Promise.allSettled(
        agentIds.map((id) => api<MemoryData>(`memory/${id}`))
      );
      const allMemories: MemoryFile[] = [];
      for (let idx = 0; idx < memoryResults.length; idx++) {
        const result = memoryResults[idx];
        const ownerId = agentIds[idx];
        if (result.status === 'fulfilled' && result.value.knowledge) {
          for (const k of result.value.knowledge) {
            allMemories.push({ ...k, agentId: ownerId });
          }
        }
      }
      allMemories.sort((a, b) => (b.filename > a.filename ? 1 : -1));
      const memories = allMemories.slice(0, 20);

      setState({ overview, agents, tasks, consensus, consensusReports, memories, loading: false, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, refresh };
}
