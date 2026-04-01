import { useCallback } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { TopBar } from '@/components/TopBar';
import { FindingsMetrics } from '@/components/FindingsMetrics';
import { TeamSection } from '@/components/TeamSection';
import { TasksSection } from '@/components/TasksSection';
import { RecentMemories } from '@/components/RecentMemories';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { DashboardEvent } from '@/lib/types';

export function App() {
  const { authed, login, error } = useAuth();
  const { overview, agents, tasks, consensus, memories, loading, refresh } = useDashboardData();

  const handleWsEvent = useCallback((_event: DashboardEvent) => {
    refresh();
  }, [refresh]);

  useWebSocket(handleWsEvent);

  if (authed === null) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!authed) {
    return <AuthGate onLogin={login} error={error} />;
  }

  if (loading || !overview || !consensus) {
    return (
      <div className="min-h-screen bg-background">
        <TopBar />
        <div className="flex items-center justify-center py-20 text-muted-foreground">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-6">
        <FindingsMetrics overview={overview} consensus={consensus} />
        {agents && <TeamSection agents={agents} />}
        {tasks && <TasksSection tasks={tasks} />}
        {memories && <RecentMemories memories={memories} />}
      </main>
    </div>
  );
}
