import type { AgentData } from '@/lib/types';
import { agentColor, timeAgo } from '@/lib/utils';
import { navigate } from '@/lib/router';
import { NeuralAvatar } from './NeuralAvatar';

interface AgentRowProps {
  agent: AgentData;
}

export function AgentRow({ agent }: AgentRowProps) {
  const color = agentColor(agent.id);
  const s = agent.scores;
  const lastTime = agent.lastTask?.timestamp ? timeAgo(agent.lastTask.timestamp) : '—';

  return (
    <button
      onClick={() => { navigate('/agent/' + encodeURIComponent(agent.id)); }}
      className="group flex min-w-0 flex-1 flex-col items-center rounded-lg border [border-color:var(--border)] p-4 text-center transition hover:[border-color:color-mix(in_oklch,var(--accent)_30%,transparent)] hover:bg-accent/10"
      style={{ background: 'var(--surface-elev)' }}
    >
      {/* Avatar with portal glow */}
      <div className="relative mb-3">
        {/* Ambient halo */}
        <div
          className="absolute -inset-3 rounded-full opacity-30 blur-xl transition group-hover:opacity-50"
          style={{ background: color }}
        />
        <NeuralAvatar
          agentId={agent.id}
          size={112}
          animate={agent.online}
          signals={agent.scores.signals}
          accuracy={agent.scores.accuracy}
          uniqueness={agent.scores.uniqueness}
          impact={agent.scores.impactScore}
        />
      </div>

      {/* Agent name */}
      <span className="font-mono text-xs font-semibold" style={{ color: 'var(--text)' }}>{agent.id}</span>

      {/* Badge */}
      <span
        className="mt-1 rounded-sm px-1.5 py-0.5 font-mono text-[9px] font-semibold"
        style={agent.native ? { color: 'var(--idle)', background: 'color-mix(in oklch, var(--idle) 10%, transparent)' } : { color: 'var(--success)', background: 'color-mix(in oklch, var(--success) 10%, transparent)' }}
      >
        {agent.native ? 'NATIVE' : 'RELAY'}
      </span>

      {/* Model */}
      <span className="mt-1 text-[10px]" style={{ color: 'var(--text-dim)' }}>{agent.model.split('/').pop()}</span>

      {/* Metrics */}
      <div className="mt-2 font-mono text-[10px]">
        {s.signals > 0 ? (
          <>
            <div className="flex items-center justify-center gap-1.5">
              <span style={{ color: 'var(--success)' }}>{Math.round(s.accuracy * 100)}% acc</span>
              <span style={{ color: 'var(--text-dim)' }}>·</span>
              <span className="text-unique">{Math.round(s.uniqueness * 100)}% uniq</span>
            </div>
            <div className="mt-0.5" style={{ color: 'var(--text-dim)' }}>{s.signals} signals</div>
          </>
        ) : (
          <span style={{ color: 'color-mix(in oklch, var(--text-dim) 50%, transparent)' }}>no signals yet</span>
        )}
      </div>

      {/* Last activity */}
      <span className="mt-1 font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{lastTime}</span>
    </button>
  );
}
