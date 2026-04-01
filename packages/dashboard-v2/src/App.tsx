import { useCallback, useState, useEffect } from 'react';
import { AuthGate } from '@/components/AuthGate';
import { TopBar } from '@/components/TopBar';
import { FindingsMetrics } from '@/components/FindingsMetrics';
import { TeamSection } from '@/components/TeamSection';
import { TasksSection } from '@/components/TasksSection';
import { RecentMemories } from '@/components/RecentMemories';
import { AgentRow } from '@/components/AgentRow';
import { AgentDetailModal } from '@/components/AgentDetailModal';
import { TaskRow } from '@/components/TaskRow';
import { useAuth } from '@/hooks/useAuth';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useDashboardData } from '@/hooks/useDashboardData';
import type { DashboardEvent, AgentData } from '@/lib/types';

function useRoute() {
  const [route, setRoute] = useState(window.location.hash || '#/');
  useEffect(() => {
    const handler = () => setRoute(window.location.hash || '#/');
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);
  return route;
}

function TeamPage({ agents }: { agents: AgentData[] }) {
  const [selected, setSelected] = useState<AgentData | null>(null);
  const sorted = [...agents].sort((a, b) =>
    (b.scores?.dispatchWeight || 0) - (a.scores?.dispatchWeight || 0)
  );

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <a href="#/" className="font-mono text-xs text-muted-foreground hover:text-primary">← back</a>
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Team <span className="text-primary">{agents.length} agents</span>
        </h2>
      </div>
      <div className="space-y-2">
        {sorted.map((agent) => (
          <AgentRow key={agent.id} agent={agent} onClick={() => setSelected(agent)} />
        ))}
      </div>
      {selected && (
        <AgentDetailModal agent={selected} open={!!selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function TasksPage({ tasks }: { tasks: import('@/lib/types').TasksData }) {
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <a href="#/" className="font-mono text-xs text-muted-foreground hover:text-primary">← back</a>
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Tasks <span className="text-primary">{tasks.total}</span>
        </h2>
      </div>
      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="py-2 pl-4 pr-2 text-xs font-medium text-muted-foreground" style={{ width: 32 }}></th>
              <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">ID</th>
              <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">Agent</th>
              <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Description</th>
              <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">Duration</th>
              <th className="py-2 pr-4 text-right font-mono text-xs font-medium text-muted-foreground">When</th>
            </tr>
          </thead>
          <tbody>
            {tasks.items.map((task) => (
              <TaskRow key={task.taskId} task={task} />
            ))}
          </tbody>
        </table>
        {tasks.items.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">No tasks yet.</div>
        )}
      </div>
    </>
  );
}

function Dashboard() {
  const route = useRoute();
  const { overview, agents, tasks, consensus, memories, loading, refresh } = useDashboardData();

  const handleWsEvent = useCallback((_event: DashboardEvent) => {
    refresh();
  }, [refresh]);

  useWebSocket(handleWsEvent);

  if (loading || !overview || !consensus) {
    return (
      <div className="min-h-screen bg-background">
        <TopBar />
        <div className="flex items-center justify-center py-20 text-muted-foreground">Loading dashboard...</div>
      </div>
    );
  }

  let content;
  if (route === '#/team' && agents) {
    content = <TeamPage agents={agents} />;
  } else if (route === '#/tasks' && tasks) {
    content = <TasksPage tasks={tasks} />;
  } else {
    content = (
      <>
        <FindingsMetrics overview={overview} consensus={consensus} />
        {agents && <TeamSection agents={agents} />}
        {tasks && <TasksSection tasks={tasks} />}
        {memories && <RecentMemories memories={memories} />}
      </>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <TopBar />
      <main className="mx-auto max-w-6xl space-y-8 px-6 py-6">
        {content}
      </main>
    </div>
  );
}

export function App() {
  const { authed, login, error } = useAuth();

  if (authed === null) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">Loading...</div>;
  }

  if (!authed) {
    return <AuthGate onLogin={login} error={error} />;
  }

  return <Dashboard />;
}
