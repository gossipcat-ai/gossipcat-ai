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
import { timeAgo } from '@/lib/utils';
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
      <div className="flex flex-wrap gap-3">
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

function FindingsPage({ consensus }: { consensus: import('@/lib/types').ConsensusData }) {
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <a href="#/" className="font-mono text-xs text-muted-foreground hover:text-primary">← back</a>
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          All Consensus Runs <span className="text-primary">{consensus.runs.length}</span>
        </h2>
      </div>
      <div className="space-y-2">
        {consensus.runs.map((run, i) => {
          const c = run.counts;
          const runTotal = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);
          const barTotal = runTotal || 1;
          const segments = [
            { key: 'confirmed', count: c.agreement || 0, color: 'bg-confirmed', text: 'text-confirmed', label: 'confirmed' },
            { key: 'disputed', count: (c.disagreement || 0) + (c.hallucination || 0), color: 'bg-disputed', text: 'text-disputed', label: 'disputed' },
            { key: 'unverified', count: c.unverified || 0, color: 'bg-unverified', text: 'text-unverified', label: 'unverified' },
            { key: 'unique', count: (c.unique || 0) + (c.new || 0), color: 'bg-unique', text: 'text-unique', label: 'unique' },
          ];
          return (
            <div key={run.taskId + i} className="rounded-md border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm font-semibold text-foreground">{runTotal} findings</span>
                  <div className="flex gap-1.5">
                    {run.agents.map((a) => (
                      <span key={a} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {a.split('-').map(p => p[0]).join('').toUpperCase().slice(0, 2)}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{timeAgo(run.timestamp)}</span>
              </div>
              <div className="mt-2 flex gap-2">
                {segments.map((s) => s.count > 0 && (
                  <span key={s.key} className={`font-mono text-[10px] font-semibold ${s.text}`}>
                    {s.count} {s.label}
                  </span>
                ))}
              </div>
              <div className="mt-2 flex h-1.5 overflow-hidden rounded-sm">
                {segments.map((s) => s.count > 0 && (
                  <div key={s.key} className={`${s.color}`} style={{ width: `${(s.count / barTotal) * 100}%` }} />
                ))}
              </div>
              {run.signals.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-border pt-3">
                  {run.signals.filter(s => s.signal !== 'signal_retracted').map((sig, j) => {
                    const tagMap: Record<string, { label: string; cls: string }> = {
                      agreement: { label: 'CONFIRMED', cls: 'text-confirmed bg-confirmed/10' },
                      consensus_verified: { label: 'CONFIRMED', cls: 'text-confirmed bg-confirmed/10' },
                      disagreement: { label: 'DISPUTED', cls: 'text-disputed bg-disputed/10' },
                      hallucination_caught: { label: 'DISPUTED', cls: 'text-disputed bg-disputed/10' },
                      unverified: { label: 'UNVERIFIED', cls: 'text-unverified bg-unverified/10' },
                      unique_confirmed: { label: 'UNIQUE', cls: 'text-unique bg-unique/10' },
                      unique_unconfirmed: { label: 'UNIQUE', cls: 'text-unique bg-unique/10' },
                      new_finding: { label: 'NEW', cls: 'text-unique bg-unique/10' },
                    };
                    const tag = tagMap[sig.signal];
                    if (!tag) return null;
                    return (
                      <div key={j} className="flex items-start gap-2">
                        <span className={`shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-bold ${tag.cls}`}>{tag.label}</span>
                        <span className="text-xs text-muted-foreground">{(sig.evidence || '').slice(0, 150)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
  } else if (route === '#/findings' && consensus) {
    content = <FindingsPage consensus={consensus} />;
  } else {
    content = (
      <>
        <FindingsMetrics consensus={consensus} />
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
