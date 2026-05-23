import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from 'd3-force';
import { NeuralAvatar } from './NeuralAvatar';
import { subscribe } from '@/lib/animation-scheduler';
import { classifyPeerRelationship, edgeWidthFor } from '@/lib/edge-classification';
import type { AgentData, PeerRelationshipMap } from '@/lib/types';

interface AgentNetworkGraphProps {
  agents: AgentData[];
  peerRelationships: PeerRelationshipMap;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  height?: number;
}

interface GraphNode extends SimulationNodeDatum {
  id: string;
  agent: AgentData;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  // We always construct links with resolved GraphNode references, never string
  // ids, so d3-force's mutation path (string→object) is never taken. Tightening
  // the union here lets the SVG render path drop its `as GraphNode` cast.
  source: GraphNode;
  target: GraphNode;
  cls: 'trust' | 'mixed' | 'catch';
  width: number;
  rounds: number;
}

/** NeuralAvatar size bucket from signal count. */
function sizeFor(signals: number): number {
  if (signals >= 2000) return 84;
  if (signals >= 800) return 72;
  if (signals >= 200) return 60;
  return 48;
}

export function AgentNetworkGraph({
  agents, peerRelationships, selectedAgentId, onSelectAgent, height = 420,
}: AgentNetworkGraphProps) {
  // Empty states — return early to avoid running force on zero/one nodes.
  if (agents.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center rounded-lg border"
        style={{ height, background: 'var(--stage-bg)', borderColor: 'var(--border)', color: 'var(--stage-text-dim)' }}
      >
        <div className="text-center">
          <div className="mb-2 font-mono text-sm font-bold uppercase tracking-widest" style={{ color: 'var(--text)' }}>
            No agents configured
          </div>
          <div className="font-mono text-xs">Run <code>gossip_setup</code> to spin up the fleet.</div>
        </div>
      </div>
    );
  }
  if (agents.length === 1) {
    const a = agents[0];
    return (
      <div
        className="flex h-full items-center justify-center rounded-lg border"
        style={{ height, background: 'var(--stage-bg)', borderColor: 'var(--border)' }}
      >
        <div className="text-center">
          <div className="inline-block">
            <NeuralAvatar agentId={a.id} signals={a.scores.signals} accuracy={a.scores.accuracy} uniqueness={a.scores.uniqueness} impact={a.scores.impactScore} size={sizeFor(a.scores.signals)} />
          </div>
          <div className="mt-3 font-mono text-xs" style={{ color: 'var(--stage-text-dim)' }}>
            Dispatch a task to see the network form.
          </div>
        </div>
      </div>
    );
  }

  // Force-layout + rendering branch — see ForceGraphInner below.
  return <ForceGraphInner agents={agents} peerRelationships={peerRelationships} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} height={height} sizeFor={sizeFor} />;
}

function ForceGraphInner({
  agents, peerRelationships, selectedAgentId, onSelectAgent, height = 420, sizeFor,
}: AgentNetworkGraphProps & { sizeFor: (signals: number) => number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<GraphNode, GraphLink> | null>(null);
  const [width, setWidth] = useState(800);
  const [, forceRender] = useState(0); // bump to re-render on tick

  // Resize observer to pick up container width.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build nodes + links from props. Re-runs when agents/relationships change.
  const { nodes, links } = useMemo(() => {
    const nodes: GraphNode[] = agents.map((agent) => ({ id: agent.id, agent }));
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const links: GraphLink[] = [];
    for (const [key, rel] of peerRelationships.entries()) {
      const [a, b] = key.split('::');
      const sourceNode = nodeById.get(a);
      const targetNode = nodeById.get(b);
      if (!sourceNode || !targetNode) continue;
      const cls = classifyPeerRelationship(rel);
      if (!cls) continue;
      links.push({ source: sourceNode, target: targetNode, cls, width: edgeWidthFor(rel.rounds), rounds: rel.rounds });
    }
    // Render order: mixed (background) → trust → catch (foreground). SVG paints in
    // array order, so later entries sit on top. Meaningful signals (catch + trust)
    // are now drawn over the visually-dominant "mixed" edges instead of being
    // buried under them.
    const ORDER: Record<GraphLink['cls'], number> = { mixed: 0, trust: 1, catch: 2 };
    links.sort((a, b) => ORDER[a.cls] - ORDER[b.cls]);
    return { nodes, links };
  }, [agents, peerRelationships]);

  // (Re-)build force simulation on width/nodes/links change.
  useEffect(() => {
    // Wider link distance + stronger charge = more spread, less clumping
    // for dense graphs (Phase 1b.1 polish — was 120/-400, felt cramped at 7+ agents).
    // forceCollide uses each node's visual radius (from sizeFor) + 6px gutter so
    // large-signal avatars (84px) never visually overlap. alphaDecay calmed from
    // 0.05 to 0.028 (just above d3 default 0.0228) so the wider layout has time
    // to actually settle — at 0.05 the simulation cooled in ~56 ticks, often
    // stranding nodes in a local minimum.
    const sim = forceSimulation<GraphNode, GraphLink>(nodes)
      .force('link', forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(200).strength(0.35))
      .force('charge', forceManyBody<GraphNode>().strength(-700))
      .force('collide', forceCollide<GraphNode>((d) => sizeFor(d.agent.scores.signals) / 2 + 6))
      .force('center', forceCenter(width / 2, height / 2))
      .alpha(1).alphaMin(0.01).alphaDecay(0.028);
    simRef.current = sim;
    sim.stop();
    // Manual ticking via the shared scheduler — keeps frame budget unified.
    // Clamping x/y after each tick keeps nodes inside the overflow-hidden
    // container — without this, narrow viewports + the 800px width fallback
    // can strand nodes off-screen with their click target unreachable.
    const pad = 50;
    const unsubscribe = subscribe(() => {
      if (sim.alpha() < sim.alphaMin()) return;
      sim.tick();
      for (const n of nodes) {
        if (n.x != null) n.x = Math.max(pad, Math.min(width - pad, n.x));
        if (n.y != null) n.y = Math.max(pad, Math.min(height - pad, n.y));
      }
      forceRender((v) => v + 1);
    });
    return () => {
      unsubscribe();
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links, width, height]);

  // Render nodes as absolutely-positioned divs + edges as one SVG overlay.
  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-lg border"
      style={{ height, background: 'var(--stage-bg)', borderColor: 'var(--border)' }}
      onClick={() => onSelectAgent(null)}
    >
      {/* Header label — gives the stage context for a first-time viewer. */}
      <div
        className="absolute z-10 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-widest"
        style={{ top: 10, left: 12, color: 'var(--stage-text-dim)', pointerEvents: 'none' }}
      >
        <span>Agent Network</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ color: 'var(--text)' }}>{agents.length}</span>
        <span style={{ opacity: 0.7 }}>agents</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span style={{ color: 'var(--text)' }}>{links.length}</span>
        <span style={{ opacity: 0.7 }}>edges</span>
      </div>
      <svg width="100%" height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {links.map((l) => {
          const s = l.source;
          const t = l.target;
          if (s.x == null || s.y == null || t.x == null || t.y == null) return null;
          // Offset endpoints by node radius so edges meet the avatar circumference,
          // not the center — avoids the "arrow stabbing through the icon" look.
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const ux = dx / len;
          const uy = dy / len;
          const sr = sizeFor(s.agent.scores.signals) / 2;
          const tr = sizeFor(t.agent.scores.signals) / 2;
          const sx = s.x + ux * sr;
          const sy = s.y + uy * sr;
          const tx = t.x - ux * tr;
          const ty = t.y - uy * tr;
          // Mid-perpendicular Bezier control point — 20px offset (Phase 1b.1 polish,
          // was 40px; tightened to reduce the parallel-arc fishbowl effect on dense graphs).
          const mx = (sx + tx) / 2;
          const my = (sy + ty) / 2;
          // Clockwise normal: rotate unit vector by -90°.
          const nx = uy;
          const ny = -ux;
          const cx = mx + nx * 20;
          const cy = my + ny * 20;
          const d = `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`;
          const stroke = l.cls === 'trust' ? 'var(--success)' : l.cls === 'mixed' ? 'var(--warn)' : 'var(--danger)';
          // Catch (red) is now solid — the strong --danger color carries the
          // signal on its own, and dropping the dash makes it visually distinct
          // from mixed (amber dashed). Previous "5,3 vs 8,2" dash pattern read
          // as the same broken line at the eye-level distances users actually
          // scan from.
          const dash = l.cls === 'mixed' ? '8,2' : undefined;
          // Edge opacity is theme-aware via --edge-opacity-* tokens — light
          // mode needs a higher floor (0.70) than dark (0.55) to clear WCAG
          // 1.4.11 for the deeper cream-mode stroke colors. Tokens override
          // in [data-theme="dark"] in globals.css.
          const isAdjacent = selectedAgentId == null || s.id === selectedAgentId || t.id === selectedAgentId;
          const opacityVar = selectedAgentId == null
            ? 'var(--edge-opacity-base)'
            : isAdjacent
              ? 'var(--edge-opacity-selected)'
              : 'var(--edge-opacity-dim)';
          return (
            <path
              key={`${s.id}::${t.id}`}
              d={d}
              stroke={stroke}
              strokeWidth={l.width}
              strokeDasharray={dash}
              fill="none"
              style={{ opacity: opacityVar, transition: 'opacity 200ms cubic-bezier(0.4,0,0.2,1)' }}
            />
          );
        })}
      </svg>
      {/* Edge legend — three rows in the bottom-left, anchored over the stage. */}
      <div
        className="absolute z-10 flex flex-col gap-1 rounded font-mono text-[10px]"
        style={{ bottom: 10, left: 12, color: 'var(--stage-text-dim)', pointerEvents: 'none' }}
      >
        <LegendRow stroke="var(--success)" label="Trust" />
        <LegendRow stroke="var(--warn)" label="Mixed" dash="8,2" />
        <LegendRow stroke="var(--danger)" label="Caught" />
      </div>
      {nodes.map((n) => {
        if (n.x == null || n.y == null) return null;
        const size = sizeFor(n.agent.scores.signals);
        const isSelected = n.id === selectedAgentId;
        const isDimmed = selectedAgentId != null && !isSelected;
        const label = n.agent.id;
        return (
          <button
            key={n.id}
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onSelectAgent(n.id); }}
            className="absolute -translate-x-1/2 -translate-y-1/2 transition"
            style={{
              left: n.x, top: n.y,
              opacity: isDimmed ? 0.4 : 1,
              border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
            }}
            aria-label={`Select agent ${n.agent.id}`}
            title={n.agent.id}
          >
            <div
              className="rounded-full"
              style={{
                width: size, height: size,
                boxShadow: isSelected ? `0 0 0 3px var(--accent)` : undefined,
              }}
            >
              <NeuralAvatar
                agentId={n.agent.id}
                signals={n.agent.scores.signals}
                accuracy={n.agent.scores.accuracy}
                uniqueness={n.agent.scores.uniqueness}
                impact={n.agent.scores.impactScore}
                size={size}
              />
            </div>
            <div
              className="mt-1 font-mono text-[10px] font-bold uppercase tracking-wider"
              style={{
                color: isSelected ? 'var(--text)' : 'var(--stage-text-dim)',
                textAlign: 'center',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Bottom-left legend swatch — short stroke sample + label. */
function LegendRow({ stroke, label, dash }: { stroke: string; label: string; dash?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <svg width="22" height="6" style={{ display: 'block' }}>
        <line x1="0" y1="3" x2="22" y2="3" stroke={stroke} strokeWidth="1.5" strokeDasharray={dash} />
      </svg>
      <span>{label}</span>
    </div>
  );
}
