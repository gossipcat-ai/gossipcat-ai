import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { NeuralAvatar } from './NeuralAvatar';
import { TaskRow } from './TaskRow';
import { agentColor, timeAgo } from '@/lib/utils';
import type { AgentData, TasksData, ConsensusData, MemoryData, MemoryFile } from '@/lib/types';

interface AgentPageProps {
  agentId: string;
  agents: AgentData[];
  tasks: TasksData | null;
  consensus: ConsensusData | null;
}

export function AgentPage({ agentId, agents, tasks, consensus }: AgentPageProps) {
  const agent = agents.find(a => a.id === agentId);
  const [memories, setMemories] = useState<MemoryFile[]>([]);
  const [expandedMem, setExpandedMem] = useState<string | null>(null);

  useEffect(() => {
    api<MemoryData>(`memory/${agentId}`).then(data => {
      setMemories(data.knowledge || []);
    }).catch(() => setMemories([]));
  }, [agentId]);

  if (!agent) {
    return (
      <>
        <div className="mb-4">
          <a href="#/" className="font-mono text-xs text-muted-foreground hover:text-primary">← back</a>
        </div>
        <div className="py-20 text-center text-muted-foreground">Agent not found: {agentId}</div>
      </>
    );
  }

  const s = agent.scores;
  const color = agentColor(agent.id);

  // Filter tasks for this agent
  const agentTasks = tasks?.items.filter(t => t.agentId === agentId) || [];

  // Filter consensus runs this agent participated in
  const agentRuns = consensus?.runs.filter(r => r.agents.includes(agentId)) || [];

  const stats = [
    { label: 'Accuracy', value: `${Math.round(s.accuracy * 100)}%`, color: 'text-confirmed' },
    { label: 'Reliability', value: `${Math.round(s.reliability * 100)}%`, color: 'text-primary' },
    { label: 'Uniqueness', value: `${Math.round(s.uniqueness * 100)}%`, color: 'text-unique' },
    { label: 'Dispatch Weight', value: s.dispatchWeight.toFixed(2), color: 'text-foreground' },
    { label: 'Total Signals', value: String(s.signals), color: 'text-foreground' },
    { label: 'Agreements', value: String(s.agreements), color: 'text-confirmed' },
    { label: 'Disagreements', value: String(s.disagreements), color: 'text-disputed' },
    { label: 'Hallucinations', value: String(s.hallucinations), color: 'text-disputed' },
    { label: 'Total Tokens', value: agent.totalTokens.toLocaleString(), color: 'text-foreground' },
  ];

  return (
    <>
      {/* Back link */}
      <div className="mb-6">
        <a href="#/" className="font-mono text-xs text-muted-foreground hover:text-primary">← back to dashboard</a>
      </div>

      {/* Header */}
      <div className="mb-8 flex items-center gap-6">
        <div className="relative">
          <div className="absolute -inset-4 rounded-full opacity-20 blur-xl" style={{ background: color }} />
          <NeuralAvatar agentId={agent.id} size={160} animate={agent.online} evolution={Math.min(1, (s.signals || 0) / 200)} />
        </div>
        <div>
          <h1 className="font-mono text-2xl font-bold text-foreground">{agent.id}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{agent.provider}/{agent.model}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className={`rounded-sm px-2 py-0.5 font-mono text-[10px] font-semibold ${agent.native ? 'text-primary bg-primary/10' : 'text-confirmed bg-confirmed/10'}`}>
              {agent.native ? 'NATIVE' : 'RELAY'}
            </span>
            {agent.preset && (
              <span className="rounded-sm bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{agent.preset}</span>
            )}
          </div>
          {agent.lastTask && (
            <p className="mt-2 font-mono text-xs text-muted-foreground">
              Last active: {timeAgo(agent.lastTask.timestamp)}
            </p>
          )}
        </div>
      </div>

      {/* Metrics Grid */}
      <section className="mb-8">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">Metrics</h2>
        <div className="grid grid-cols-3 gap-3">
          {stats.map(st => (
            <div key={st.label} className="rounded-md border border-border bg-card p-3">
              <div className={`font-mono text-xl font-bold ${st.color}`}>{st.value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{st.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Skills */}
      {agent.skills.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
            Skills <span className="text-primary">{agent.skills.length}</span>
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {agent.skills.map(skill => (
              <span key={skill} className="rounded-sm border border-border bg-card px-2.5 py-1 font-mono text-xs text-muted-foreground">
                {skill}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Tasks */}
      <section className="mb-8">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Tasks <span className="text-primary">{agentTasks.length}</span>
        </h2>
        {agentTasks.length > 0 ? (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-border bg-card">
                  <th className="py-2 pl-4 pr-2 text-xs font-medium text-muted-foreground" style={{ width: 32 }}></th>
                  <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">ID</th>
                  <th className="py-2 pr-3 text-xs font-medium text-muted-foreground">Description</th>
                  <th className="py-2 pr-3 font-mono text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="py-2 pr-4 text-right font-mono text-xs font-medium text-muted-foreground">When</th>
                </tr>
              </thead>
              <tbody>
                {agentTasks.slice(0, 30).map(task => (
                  <TaskRow key={task.taskId} task={task} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">No tasks recorded.</div>
        )}
      </section>

      {/* Consensus Participation */}
      <section className="mb-8">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Consensus Runs <span className="text-primary">{agentRuns.length}</span>
        </h2>
        {agentRuns.length > 0 ? (
          <div className="space-y-2">
            {agentRuns.slice(0, 20).map((run, i) => {
              const c = run.counts;
              const total = (c.agreement || 0) + (c.disagreement || 0) + (c.hallucination || 0) + (c.unverified || 0) + (c.unique || 0) + (c.new || 0);
              const barTotal = total || 1;
              const segments = [
                { key: 'confirmed', count: c.agreement || 0, color: 'bg-confirmed', text: 'text-confirmed' },
                { key: 'disputed', count: (c.disagreement || 0) + (c.hallucination || 0), color: 'bg-disputed', text: 'text-disputed' },
                { key: 'unverified', count: c.unverified || 0, color: 'bg-unverified', text: 'text-unverified' },
                { key: 'unique', count: (c.unique || 0) + (c.new || 0), color: 'bg-unique', text: 'text-unique' },
              ];
              return (
                <div key={run.taskId + i} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm font-semibold text-foreground">{total} findings</span>
                    <span className="font-mono text-xs text-muted-foreground">{timeAgo(run.timestamp)}</span>
                  </div>
                  <div className="mt-1.5 flex gap-2">
                    {segments.map(s => s.count > 0 && (
                      <span key={s.key} className={`font-mono text-[10px] font-semibold ${s.text}`}>{s.count} {s.key}</span>
                    ))}
                  </div>
                  <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-sm">
                    {segments.map(s => s.count > 0 && (
                      <div key={s.key} className={s.color} style={{ width: `${(s.count / barTotal) * 100}%` }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">No consensus participation recorded.</div>
        )}
      </section>

      {/* Memory Files */}
      <section className="mb-8">
        <h2 className="mb-3 font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          Memory <span className="text-primary">{memories.length} files</span>
        </h2>
        {memories.length > 0 ? (
          <div className="space-y-1.5">
            {memories.map(mem => {
              const isOpen = expandedMem === mem.filename;
              const type = mem.frontmatter?.type || 'memory';
              const name = mem.frontmatter?.name || mem.filename.replace(/\.md$/, '');
              return (
                <div key={mem.filename} className="rounded-md border border-border bg-card">
                  <button
                    onClick={() => setExpandedMem(isOpen ? null : mem.filename)}
                    className="flex w-full items-center gap-2 p-3 text-left transition hover:bg-accent/50"
                  >
                    <span className={`font-mono text-xs ${isOpen ? 'text-primary' : 'text-muted-foreground'}`}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-muted-foreground">
                      {type}
                    </span>
                    <span className="truncate font-mono text-xs font-semibold text-foreground">{name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{mem.filename}</span>
                  </button>
                  {isOpen && (
                    <div className="border-t border-border px-4 py-3">
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
                        {mem.content}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted-foreground">No memory files.</div>
        )}
      </section>
    </>
  );
}
