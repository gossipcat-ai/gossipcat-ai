import type { AgentData, PeerRelationship, PeerRelationshipMap } from '@/lib/types';
import { NeuralAvatar } from './NeuralAvatar';
import { peerKey } from '@/lib/peer-relationships';
import { setAgentParam } from '@/lib/url-agent-param';

interface GraphRailProps {
  selectedAgent: AgentData | null;
  agents: AgentData[];
  peerRelationships: PeerRelationshipMap;
  height?: number; // matches the AgentNetworkGraph stage height (default 420)
}

export function GraphRail({ selectedAgent, agents, peerRelationships, height = 420 }: GraphRailProps) {
  return (
    <aside
      className="flex-shrink-0 overflow-y-auto rounded-lg border"
      style={{ width: 320, minHeight: height, background: 'var(--surface-elev)', borderColor: 'var(--border)' }}
      aria-label={selectedAgent ? `Agent detail: ${selectedAgent.id}` : 'Fleet summary'}
    >
      {selectedAgent ? (
        <AgentDetail agent={selectedAgent} peerRelationships={peerRelationships} agents={agents} />
      ) : (
        <FleetSummary agents={agents} peerRelationships={peerRelationships} />
      )}
    </aside>
  );
}

function FleetSummary({ agents, peerRelationships }: { agents: AgentData[]; peerRelationships: PeerRelationshipMap }) {
  // Top 3 by accuracy (signals > 0 to exclude no-data agents).
  const topPerformers = [...agents]
    .filter((a) => a.scores.signals > 0)
    .sort((a, b) => b.scores.accuracy - a.scores.accuracy)
    .slice(0, 3);

  // Recent 5 hallucination catches across the fleet (from peer relationships).
  const recentCatches: Array<{ pair: [string, string]; catches: number; ts: string }> = [];
  for (const [k, rel] of peerRelationships.entries()) {
    if (rel.hallucinationsCaught > 0) {
      const [a, b] = k.split('::');
      recentCatches.push({ pair: [a, b], catches: rel.hallucinationsCaught, ts: rel.lastInteraction });
    }
  }
  // Sort by parsed timestamp, not lexicographic. Defense-in-depth in case
  // `lastInteraction` ever ships a non-ISO format.
  recentCatches.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const top5Catches = recentCatches.slice(0, 5);

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-2 h-section">
        Fleet at a glance
      </div>
      <p className="mb-4 font-mono text-[12px]" style={{ color: 'var(--text-faint)' }}>
        Click a node to see detail.
      </p>

      <Section label="Top performers" tone="success">
        {topPerformers.length === 0 ? (
          <EmptyRow text="No agent has logged a signal yet." />
        ) : (
          topPerformers.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setAgentParam(a.id)}
              className="group flex w-full items-center gap-2 rounded px-2 py-2 text-left transition hover:[background:color-mix(in_oklch,var(--accent)_8%,transparent)]"
              style={{ cursor: 'pointer' }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12px] font-semibold" style={{ color: 'var(--text)' }}>{a.id}</div>
                <div className="mt-0.5 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>{Math.round(a.scores.accuracy * 100)}% accuracy · {a.scores.signals} signals</div>
              </div>
              <span className="opacity-0 transition group-hover:opacity-100 font-mono text-[11px]" style={{ color: 'var(--accent)' }}>→</span>
            </button>
          ))
        )}
      </Section>

      {/* Weekly trends section deferred — historical-delta data lands in Phase 1b PR5.
          Hidden rather than rendered-as-placeholder so the fleet summary doesn't
          carry a visible "unfinished" hole in production UI. */}

      <Section label="Recent hallucination catches" tone="danger">
        {top5Catches.length === 0 ? (
          <EmptyRow text="No catches in the active window." />
        ) : (
          top5Catches.map((c) => (
            <div key={`${c.pair[0]}::${c.pair[1]}`} className="rounded px-2 py-2">
              <div className="font-mono text-[12px]" style={{ color: 'var(--text)' }}>
                <span style={{ color: 'var(--danger)' }}>◆</span> {c.pair[0]} ↔ {c.pair[1]}
              </div>
              <div className="mt-0.5 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {c.catches} caught · {timeAgo(c.ts)}
              </div>
            </div>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ label, tone, children }: { label: string; tone: 'success' | 'muted' | 'danger'; children: React.ReactNode }) {
  const toneColor = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : 'var(--text-faint)';
  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] font-bold uppercase tracking-wider" style={{ color: toneColor }}>
        <span style={{ width: 4, height: 4, borderRadius: '50%', background: toneColor, display: 'inline-block' }} />
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-2 py-1.5 font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>{text}</div>;
}

/** Naive time-ago for the rail. ISO timestamp → "3h ago" / "2d ago". */
function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function AgentDetail({ agent, peerRelationships, agents }: { agent: AgentData; peerRelationships: PeerRelationshipMap; agents: AgentData[] }) {
  // Status pill: benched > native (always ready) > offline > online.
  // Native (Claude Code subagent) agents don't have a relay WebSocket and
  // therefore no meaningful online/offline state — they're dispatched on
  // demand by the orchestrator and are always available. Showing "OFFLINE"
  // for them was misleading (a false signal that the agent was unhealthy).
  const status: { label: string; color: string } = agent.scores.bench.state === 'benched'
    ? { label: 'BENCHED', color: 'var(--danger)' }
    : agent.native
      ? { label: 'READY', color: 'var(--success)' }
      : !agent.online
        ? { label: 'OFFLINE', color: 'var(--ink-3)' }
        : { label: 'ONLINE', color: 'var(--success)' };

  // Top 3 peers by total interaction count.
  const peers: Array<{ other: string; rel: PeerRelationship; total: number }> = [];
  for (const other of agents) {
    if (other.id === agent.id) continue;
    const rel = peerRelationships.get(peerKey(agent.id, other.id));
    if (!rel) continue;
    const total = rel.confirmed + rel.disputed + rel.hallucinationsCaught;
    peers.push({ other: other.id, rel, total });
  }
  peers.sort((a, b) => b.total - a.total);
  const topPeers = peers.slice(0, 3);

  return (
    <div className="flex h-full flex-col">
      {/* Status pill — top gradient strip */}
      <div
        className="flex items-center gap-1.5 px-4 py-2 h-section"
        style={{ color: status.color, borderBottom: '1px solid var(--border)', background: `color-mix(in oklch, ${status.color} 6%, transparent)` }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: status.color, display: 'inline-block' }} />
        {status.label}
      </div>

      {/* Identity */}
      <div className="flex items-center gap-3 px-4 pt-4">
        <NeuralAvatar agentId={agent.id} signals={agent.scores.signals} accuracy={agent.scores.accuracy} uniqueness={agent.scores.uniqueness} impact={agent.scores.impactScore} size={48} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14px] font-semibold" style={{ color: 'var(--ink)' }}>{agent.id}</div>
          <div className="truncate font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>{agent.model}</div>
        </div>
      </div>

      {/* Mini stats grid */}
      <div className="mx-4 mt-4 grid grid-cols-2 gap-2">
        <Stat label="Accuracy" value={`${Math.round(agent.scores.accuracy * 100)}%`} />
        <Stat label="Reliability" value={agent.scores.taskCompletionRate == null ? '—' : `${Math.round(agent.scores.taskCompletionRate * 100)}%`} />
        <Stat label="Signals" value={agent.scores.signals.toLocaleString()} />
        <Stat label="Impact" value={`${Math.round(agent.scores.impactScore * 100)}%`} />
      </div>

      {/* Top peer relationships */}
      <div className="mt-4 px-4">
        <div className="mb-1.5 h-section">
          Top peers
        </div>
        {topPeers.length === 0 ? (
          <EmptyRow text="No cross-review history yet." />
        ) : (
          <div className="space-y-1">
            {topPeers.map(({ other, rel }) => (
              <div key={other} className="rounded px-2 py-1.5" style={{ background: 'color-mix(in oklch, var(--surface) 50%, transparent)' }}>
                <div className="truncate font-mono text-[12px]" style={{ color: 'var(--ink)' }}>{other}</div>
                <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
                  {rel.confirmed > 0 && <span><span style={{ color: 'var(--success)' }}>✓</span> {rel.confirmed}</span>}
                  {rel.disputed > 0 && <span><span style={{ color: 'var(--warn)' }}>≠</span> {rel.disputed}</span>}
                  {rel.hallucinationsCaught > 0 && <span><span style={{ color: 'var(--danger)' }}>◆</span> {rel.hallucinationsCaught}</span>}
                  <span style={{ opacity: 0.6 }}>· {rel.rounds} rounds</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Skills */}
      {agent.skills.length > 0 && (
        <div className="mt-4 px-4">
          <div className="mb-1.5 h-section">
            Skills <span style={{ color: 'var(--ink)', fontWeight: 700 }}>{agent.skills.length}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {agent.skills.slice(0, 6).map((s) => (
              <span key={s} className="rounded-sm border px-1.5 py-0.5 font-mono text-[11px]" style={{ borderColor: 'var(--border)', color: 'var(--ink-3)' }}>{s}</span>
            ))}
          </div>
        </div>
      )}

      {/* Action footer — sticky bottom. Keyboard hints visual-only this PR. */}
      <div className="mt-auto flex flex-col gap-1.5 border-t p-3" style={{ borderColor: 'var(--border)' }}>
        <ActionButton label="Open dispatch log" kbd="⏎" href={`/agent/${encodeURIComponent(agent.id)}`} />
        <ActionButton label="View skill graph" kbd="G" href={`/agent/${encodeURIComponent(agent.id)}#skills`} disabled={agent.skills.length === 0} />
        <ActionButton label="Dispatch consensus" kbd="⌘D" href="#" disabled />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded px-2 py-1.5" style={{ background: 'color-mix(in oklch, var(--surface) 50%, transparent)' }}>
      <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>{label}</div>
      <div className="mt-0.5 font-mono text-[16px] font-medium tabular-nums" style={{ color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

function ActionButton({ label, kbd, href, disabled }: { label: string; kbd: string; href: string; disabled?: boolean }) {
  return (
    <a
      href={disabled ? undefined : `/dashboard${href}`}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : undefined}
      className="flex items-center justify-between rounded px-2 py-2 font-mono text-[12px] transition"
      style={{ background: disabled ? 'transparent' : 'color-mix(in oklch, var(--surface) 50%, transparent)', color: disabled ? 'var(--text-faint)' : 'var(--text)', pointerEvents: disabled ? 'none' : 'auto', opacity: disabled ? 0.5 : 1 }}
    >
      <span>{label}</span>
      <kbd className="rounded border px-1 py-0.5 font-mono text-[10px]" style={{ borderColor: 'var(--border)', background: 'var(--surface-sunk)', color: 'var(--text-dim)' }}>{kbd}</kbd>
    </a>
  );
}
