import type { AgentData } from '@/lib/types';
import { agentInitials, agentColor, timeAgo } from '@/lib/utils';

interface AgentRowProps {
  agent: AgentData;
  onClick: () => void;
}

export function AgentRow({ agent, onClick }: AgentRowProps) {
  const color = agentColor(agent.id);
  const s = agent.scores;
  const lastTaskId = agent.lastTask
    ? agent.lastTask.task.match(/task[_-]?([a-f0-9]{4,8})/i)?.[0] ?? '—'
    : '—';
  const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '—';

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-4 rounded-md border border-border bg-card p-3 text-left transition hover:border-primary/30 hover:bg-accent"
    >
      <div
        className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border-2"
        style={{ borderColor: color, color }}
      >
        <span className="font-mono text-sm font-bold">{agentInitials(agent.id)}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-foreground">{agent.id}</span>
          <span className={`inline-block h-2 w-2 rounded-full ${agent.online ? 'bg-confirmed shadow-[0_0_6px_rgba(52,211,153,0.5)]' : 'bg-muted-foreground/30'}`} />
          <span className="font-mono text-xs text-muted-foreground">{agent.online ? 'ONLINE' : 'OFFLINE'}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{agent.provider}/{agent.model}</div>
        <div className="mt-1 flex items-center gap-3 font-mono text-xs">
          <span className="text-confirmed">Acc: {Math.round(s.accuracy * 100)}%</span>
          <span className="text-primary">Rel: {Math.round(s.reliability * 100)}%</span>
          <span className="text-unique">Uniq: {Math.round(s.uniqueness * 100)}%</span>
        </div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          Last: <span className="text-foreground/70">{lastTaskId}</span> · {lastTime}
        </div>
      </div>
    </button>
  );
}
