import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter, forceLink, forceManyBody, forceSimulation,
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
  source: GraphNode | string;
  target: GraphNode | string;
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
  agents, peerRelationships, selectedAgentId, onSelectAgent, height = 580,
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
  agents, peerRelationships, selectedAgentId, onSelectAgent, height = 580, sizeFor,
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
    return { nodes, links };
  }, [agents, peerRelationships]);

  // (Re-)build force simulation on width/nodes/links change.
  useEffect(() => {
    const sim = forceSimulation<GraphNode, GraphLink>(nodes)
      .force('link', forceLink<GraphNode, GraphLink>(links).id((d) => d.id).distance(120).strength(0.4))
      .force('charge', forceManyBody<GraphNode>().strength(-400))
      .force('center', forceCenter(width / 2, height / 2))
      .alpha(1).alphaMin(0.01).alphaDecay(0.05);
    simRef.current = sim;
    sim.stop();
    // Manual ticking via the shared scheduler — keeps frame budget unified.
    const unsubscribe = subscribe(() => {
      if (sim.alpha() < sim.alphaMin()) return;
      sim.tick();
      forceRender((n) => n + 1);
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
      <svg width="100%" height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {links.map((l, i) => {
          const s = l.source as GraphNode;
          const t = l.target as GraphNode;
          if (s.x == null || s.y == null || t.x == null || t.y == null) return null;
          // Mid-perpendicular Bezier control point — 40px fixed offset, clockwise normal.
          const mx = (s.x + t.x) / 2;
          const my = (s.y + t.y) / 2;
          const dx = t.x - s.x;
          const dy = t.y - s.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          // Clockwise normal: rotate (dx, dy) by -90°.
          const nx = dy / len;
          const ny = -dx / len;
          const cx = mx + nx * 40;
          const cy = my + ny * 40;
          const d = `M ${s.x},${s.y} Q ${cx},${cy} ${t.x},${t.y}`;
          const stroke = l.cls === 'trust' ? 'var(--success)' : l.cls === 'mixed' ? 'var(--warn)' : 'var(--danger)';
          const dash = l.cls === 'catch' ? '5,3' : l.cls === 'mixed' ? '8,2' : undefined;
          return (
            <path
              key={i}
              d={d}
              stroke={stroke}
              strokeWidth={l.width}
              strokeDasharray={dash}
              fill="none"
              opacity={selectedAgentId == null || s.id === selectedAgentId || t.id === selectedAgentId ? 0.85 : 0.25}
              style={{ transition: 'opacity 200ms cubic-bezier(0.4,0,0.2,1)' }}
            />
          );
        })}
      </svg>
      {nodes.map((n) => {
        if (n.x == null || n.y == null) return null;
        const size = sizeFor(n.agent.scores.signals);
        const isSelected = n.id === selectedAgentId;
        const isDimmed = selectedAgentId != null && !isSelected;
        return (
          <button
            key={n.id}
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onSelectAgent(n.id); }}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full transition"
            style={{
              left: n.x, top: n.y, width: size, height: size,
              opacity: isDimmed ? 0.4 : 1,
              boxShadow: isSelected ? `0 0 0 3px var(--accent)` : undefined,
              border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
            }}
            aria-label={`Select agent ${n.agent.id}`}
            title={n.agent.id}
          >
            <NeuralAvatar
              agentId={n.agent.id}
              signals={n.agent.scores.signals}
              accuracy={n.agent.scores.accuracy}
              uniqueness={n.agent.scores.uniqueness}
              impact={n.agent.scores.impactScore}
              size={size}
            />
          </button>
        );
      })}
    </div>
  );
}
