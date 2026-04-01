import type { AgentData } from '@/lib/types';
import { agentColor, timeAgo } from '@/lib/utils';
import { NeuralAvatar } from './NeuralAvatar';

interface AgentRowProps {
  agent: AgentData;
  onClick: () => void;
}

export function AgentRow({ agent, onClick }: AgentRowProps) {
  const color = agentColor(agent.id);
  const s = agent.scores;
  const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '—';

  return (
    <button
      onClick={onClick}
      className="group flex min-w-0 flex-1 flex-col items-center rounded-lg border border-border bg-card p-4 text-center transition hover:border-primary/30 hover:bg-accent"
    >
      {/* Avatar with portal glow */}
      <div className="relative mb-3">
        {/* Ambient halo */}
        <div
          className="absolute -inset-3 rounded-full opacity-30 blur-xl transition group-hover:opacity-50"
          style={{ background: color }}
        />
        <NeuralAvatar agentId={agent.id} size={112} animate={agent.online} evolution={Math.min(1, (agent.scores.signals || 0) / 200)} />
      </div>

      {/* Agent name */}
      <span className="font-mono text-xs font-semibold text-foreground">{agent.id}</span>

      {/* Badge */}
      <span className={`mt-1 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-semibold ${agent.native ? 'text-primary bg-primary/10' : 'text-confirmed bg-confirmed/10'}`}>
        {agent.native ? 'NATIVE' : 'RELAY'}
      </span>

      {/* Model */}
      <span className="mt-1 text-[10px] text-muted-foreground">{agent.model.split('/').pop()}</span>

      {/* Metrics */}
      <div className="mt-2 font-mono text-[10px]">
        {s.signals > 0 ? (
          <>
            <div className="flex items-center justify-center gap-1.5">
              <span className="text-confirmed">{Math.round(s.accuracy * 100)}% acc</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-unique">{Math.round(s.uniqueness * 100)}% uniq</span>
            </div>
            <div className="mt-0.5 text-muted-foreground">{s.signals} signals</div>
          </>
        ) : (
          <span className="text-muted-foreground/50">no signals yet</span>
        )}
      </div>

      {/* Last activity */}
      <span className="mt-1 font-mono text-[10px] text-muted-foreground">{lastTime}</span>
    </button>
  );
}
