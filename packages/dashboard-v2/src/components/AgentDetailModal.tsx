import type { AgentData } from '@/lib/types';
import { agentInitials, agentColor } from '@/lib/utils';

interface AgentDetailModalProps {
  agent: AgentData;
  open: boolean;
  onClose: () => void;
}

export function AgentDetailModal({ agent, open, onClose }: AgentDetailModalProps) {
  if (!open) return null;
  const s = agent.scores;
  const color = agentColor(agent.id);

  const stats = [
    { label: 'Accuracy', value: `${Math.round(s.accuracy * 100)}%` },
    { label: 'Reliability', value: `${Math.round(s.reliability * 100)}%` },
    { label: 'Uniqueness', value: `${Math.round(s.uniqueness * 100)}%` },
    { label: 'Dispatch Weight', value: s.dispatchWeight.toFixed(2) },
    { label: 'Signals', value: String(s.signals) },
    { label: 'Agreements', value: String(s.agreements) },
    { label: 'Disagreements', value: String(s.disagreements) },
    { label: 'Hallucinations', value: String(s.hallucinations) },
    { label: 'Total Tokens', value: agent.totalTokens.toLocaleString() },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-4 border-b border-border pb-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full border-2" style={{ borderColor: color, color }}>
            <span className="font-mono text-lg font-bold">{agentInitials(agent.id)}</span>
          </div>
          <div>
            <h3 className="font-mono text-lg font-bold text-foreground">{agent.id}</h3>
            <p className="text-sm text-muted-foreground">{agent.provider}/{agent.model}</p>
            <p className="text-xs text-muted-foreground">{agent.preset ?? 'no preset'} · {agent.native ? 'native' : 'relay'}</p>
          </div>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {stats.map((stat) => (
            <div key={stat.label} className="rounded-md border border-border bg-background p-3">
              <div className="font-mono text-lg font-bold text-foreground">{stat.value}</div>
              <div className="text-xs text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
        {agent.skills.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 font-mono text-xs font-bold uppercase tracking-widest text-muted-foreground">Skills</h4>
            <div className="flex flex-wrap gap-1.5">
              {agent.skills.map((skill) => (
                <span key={skill} className="rounded-sm border border-border bg-background px-2 py-0.5 font-mono text-xs text-muted-foreground">
                  {skill}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
