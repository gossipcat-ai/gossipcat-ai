import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { OverviewData, AgentData, TasksData, ConsensusData, MemoryFile, MemoryData } from '@/lib/types';

export interface DashboardState {
  overview: OverviewData | null;
  agents: AgentData[] | null;
  tasks: TasksData | null;
  consensus: ConsensusData | null;
  memories: MemoryFile[] | null;
  loading: boolean;
  error: string | null;
}

export function useDashboardData() {
  const [state, setState] = useState<DashboardState>({
    overview: null, agents: null, tasks: null, consensus: null, memories: null,
    loading: true, error: null,
  });

  const refresh = useCallback(async () => {
    try {
      const [overview, agents, tasks, consensus] = await Promise.all([
        api<OverviewData>('overview'),
        api<AgentData[]>('agents'),
        api<TasksData>('tasks?limit=50'),
        api<ConsensusData>('consensus'),
      ]);

      // Fetch memories for top agents + _project
      const agentIds = agents.slice(0, 5).map((a) => a.id).concat(['_project']);
      const memoryResults = await Promise.allSettled(
        agentIds.map((id) => api<MemoryData>(`knowledge/${id}`))
      );
      const allMemories: MemoryFile[] = [];
      for (const result of memoryResults) {
        if (result.status === 'fulfilled' && result.value.knowledge) {
          for (const k of result.value.knowledge) {
            allMemories.push(k);
          }
        }
      }
      allMemories.sort((a, b) => (b.filename > a.filename ? 1 : -1));
      const memories = allMemories.slice(0, 20);

      setState({ overview, agents, tasks, consensus, memories, loading: false, error: null });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { ...state, refresh };
}
