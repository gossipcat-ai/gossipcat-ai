import { useEffect, useMemo, useRef, useState } from 'react';
import { NeuralAvatar } from './NeuralAvatar';
import { classifyPeerRelationship, edgeWidthFor } from '@/lib/edge-classification';
import { peerKey } from '@/lib/peer-relationships';
import { subscribe as subscribeAnimation } from '@/lib/animation-scheduler';
import type { AgentData, PeerRelationship, PeerRelationshipMap } from '@/lib/types';

interface AgentNetworkGraphProps {
  agents: AgentData[];
  peerRelationships: PeerRelationshipMap;
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  height?: number;
}

/** NeuralAvatar size bucket from signal count. */
function sizeFor(signals: number): number {
  if (signals >= 2000) return 84;
  if (signals >= 800) return 72;
  if (signals >= 200) return 60;
  return 48;
}

/** Layout position for a single agent in the stage. */
interface Position {
  x: number;
  y: number;
  /** 'center' = focused agent, 'peer' = peer of focused, 'fleet' = resting orbit, 'hidden' = non-peer when focused. */
  role: 'center' | 'peer' | 'fleet' | 'hidden';
  /** Angle from center in radians (-π/2 = top, 0 = right, π/2 = bottom, π = left).
   *  Used by the renderer to position the agent's name label radially OUTWARD
   *  from the avatar so labels never collide with avatars at smaller radii. */
  angle?: number;
}

/**
 * Resting layout: agents placed at a radius encoding accuracy.
 * Higher accuracy = closer to center (radius = (1 - accuracy) * maxRadius).
 * Agents are sorted alphabetically for stable angle assignment.
 */
function restingLayout(agents: AgentData[], width: number, height: number): Map<string, Position> {
  const center = { x: width / 2, y: height / 2 };
  // Tighter cushion (was 40) lets the chart fill more of the available canvas.
  const innerCushion = 24;
  const maxRadius = Math.max(80, Math.min(width, height) / 2 - innerCushion);

  const out = new Map<string, Position>();
  if (agents.length === 0) return out;

  // Sort by accuracy DESCENDING so the alphabetical-around-perimeter degenerate
  // case is replaced by a smarter walk: agents at similar radii get distributed
  // around the chart, not clumped at the same angle. Stable secondary sort by id
  // keeps the layout deterministic.
  const sorted = [...agents].sort((a, b) => {
    const da = b.scores?.accuracy ?? 0;
    const dc = a.scores?.accuracy ?? 0;
    if (da !== dc) return dc - da;
    return a.id.localeCompare(b.id);
  });
  const N = sorted.length;

  // Golden-angle stride (phyllotaxis). 137.50776° ≈ 2.39996 rad.
  // Equal-spaced angles (2π/N per step) put adjacent ranks at adjacent
  // angles — when two agents share a similar accuracy they also land at
  // similar radii, and the combination CLUSTERS them visually. The golden
  // angle guarantees that for any N, consecutive items in the walk land
  // far apart on the circle. So two agents with neighboring accuracies
  // (e.g. sonnet-reviewer 63% + haiku-researcher 64% — same radius band)
  // are placed on opposite sides of the chart instead of next to each
  // other. The result spreads the fleet evenly regardless of how the
  // accuracy distribution clumps.
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const agent = sorted[i];
    // 0 = at center (perfect accuracy), 1 = at maxRadius (zero accuracy).
    // Inner floor at 0.22*maxRadius so the highest-accuracy agent doesn't
    // visually merge with the orchestrator blackhole at the center.
    const acc = clamp(agent.scores?.accuracy ?? 0, 0, 1);
    const radius = Math.max(maxRadius * 0.22, (1 - acc) * maxRadius);

    // Anchor at -π/2 (top) for the first agent, then step by golden angle.
    const angle = -Math.PI / 2 + i * GOLDEN_ANGLE;

    out.set(agent.id, {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
      role: 'fleet',
      angle,
    });
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** Tiny seeded PRNG so the starfield is stable across renders.
 *  Mulberry32 — small, deterministic, no deps. */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface StarfieldProps {
  width: number;
  height: number;
  /** Agent positions on the stage. Stars within consumeRadius of any agent
   *  drift toward that agent, shrink + fade, then respawn elsewhere. */
  agentPositions: { x: number; y: number }[];
}

type Star = {
  x: number; y: number;
  baseR: number;   // born radius
  r: number;       // current radius (shrinks when consumed)
  baseO: number;   // born opacity (target when idle, before twinkle modulation)
  o: number;       // current opacity (after twinkle + consume effects)
  consumed: number | null; // index of agent consuming this star, or null
  phase: number;    // 0..2π — initial twinkle phase so each star blinks independently
  twinkleHz: number; // 0.2..1.2 cycles per second
};

/** Observatory-style starfield rendered behind the rings.
 *  ~120 stars; mix of 0.7px / 1.4px for depth. Agents passively
 *  "eat" nearby stars — within consumeRadius, a star drifts toward the
 *  agent, shrinks, fades, and respawns elsewhere. Subscribes to the
 *  shared AnimationScheduler so the loop respects prefers-reduced-motion. */
function Starfield({ width, height, agentPositions }: StarfieldProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const starsRef = useRef<Star[]>([]);
  const circlesRef = useRef<(SVGCircleElement | null)[]>([]);

  // Seed star positions once per width/height. Respawn handled in the tick.
  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const rand = seededRandom(7311);
    const count = 120;
    starsRef.current = Array.from({ length: count }, () => {
      const baseR = rand() < 0.82 ? 0.7 : 1.4;
      const baseO = 0.20 + rand() * 0.40; // brighter in dark mode (canvas is always dark now)
      return {
        x: rand() * width,
        y: rand() * height,
        baseR,
        r: baseR,
        baseO,
        o: baseO,
        consumed: null,
        phase: rand() * Math.PI * 2,
        twinkleHz: 0.2 + rand() * 1.0,
      };
    });
  }, [width, height]);

  // Animation loop — agents eat nearby stars.
  useEffect(() => {
    if (width <= 0 || height <= 0) return;
    const rand = seededRandom(919); // separate seed for respawn jitter
    const consumeRadius = 60; // px — slightly bigger than avatar visual radius
    const driftPerSec = 90;   // px per second toward agent when consumed
    const fadeRate = 1.5;     // opacity units per second when consumed
    const shrinkRate = 1.8;   // radius units per second when consumed

    // Wall-clock-ish elapsed time for twinkle phase. Accumulates deltas so
    // we don't depend on performance.now() (kept self-contained inside loop).
    let elapsedS = 0;
    const tick = (deltaMs: number) => {
      const dt = deltaMs / 1000;
      elapsedS += dt;
      const stars = starsRef.current;
      const circles = circlesRef.current;
      for (let i = 0; i < stars.length; i++) {
        const star = stars[i];

        // Detect first agent within consumeRadius. Sticky consumption (once
        // claimed, the star is being eaten by that agent until it disappears).
        if (star.consumed === null) {
          for (let a = 0; a < agentPositions.length; a++) {
            const dx = agentPositions[a].x - star.x;
            const dy = agentPositions[a].y - star.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < consumeRadius * consumeRadius) {
              star.consumed = a;
              break;
            }
          }
        }

        // Twinkle: idle stars softly modulate between 50% and 100% of baseO.
        // Consumed stars skip twinkle so the fade-to-zero reads cleanly.
        if (star.consumed === null) {
          const mod = 0.75 + 0.25 * Math.sin(elapsedS * star.twinkleHz * Math.PI * 2 + star.phase);
          star.o = star.baseO * mod;
        }

        if (star.consumed !== null) {
          const target = agentPositions[star.consumed];
          if (target) {
            const dx = target.x - star.x;
            const dy = target.y - star.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const move = Math.min(dist, driftPerSec * dt);
            star.x += (dx / dist) * move;
            star.y += (dy / dist) * move;
            star.o = Math.max(0, star.o - fadeRate * dt);
            star.r = Math.max(0, star.r - shrinkRate * dt);
          }
          // Respawn when fully consumed or arrived at agent.
          if (star.o <= 0.01 || star.r <= 0.1) {
            // Random respawn far from any agent.
            let nx = 0, ny = 0, safe = false;
            for (let tries = 0; tries < 8; tries++) {
              nx = rand() * width;
              ny = rand() * height;
              safe = true;
              for (const ap of agentPositions) {
                const ddx = ap.x - nx;
                const ddy = ap.y - ny;
                if (ddx * ddx + ddy * ddy < consumeRadius * consumeRadius * 1.5) {
                  safe = false;
                  break;
                }
              }
              if (safe) break;
            }
            star.x = nx;
            star.y = ny;
            star.r = star.baseR;
            star.o = star.baseO;
            star.consumed = null;
          }
        }

        // Direct DOM mutation — avoid React re-render storm for 120 stars * 60fps.
        const c = circles[i];
        if (c) {
          c.setAttribute('cx', String(star.x));
          c.setAttribute('cy', String(star.y));
          c.setAttribute('r', String(star.r));
          c.setAttribute('opacity', String(star.o));
        }
      }
    };

    const unsubscribe = subscribeAnimation(tick);
    return () => unsubscribe();
  }, [width, height, agentPositions]);

  const stars = starsRef.current;
  return (
    <svg
      ref={svgRef}
      width="100%"
      height={height}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      aria-hidden
    >
      {stars.map((s, i) => (
        <circle
          key={i}
          ref={(el) => { circlesRef.current[i] = el; }}
          cx={s.x}
          cy={s.y}
          r={s.r}
          fill="#F2EDE3"
          opacity={s.o}
        />
      ))}
    </svg>
  );
}

interface RingBandsProps {
  width: number;
  height: number;
  /** When true, suppress accuracy tick labels — used in focus mode where
   *  agent positions are driven by peer-distance, not accuracy. The rings
   *  themselves stay as decoration but the accuracy labels would mislead. */
  hideLabels?: boolean;
}

/** Concentric accuracy bands.
 *
 *  IMPORTANT: rings are at radii r = maxR * {1, 0.75, 0.5, 0.25}, but the
 *  accuracy VALUE at each ring is inverted because restingLayout maps
 *  radius = (1 - accuracy) * maxRadius — agents at maxR have accuracy 0%,
 *  agents at center have accuracy 100%. Each ring's label MUST express the
 *  accuracy value at that ring, not the radius fraction.
 */
function RingBands({ width, height, hideLabels = false }: RingBandsProps) {
  const cx = width / 2;
  const cy = height / 2;
  const innerCushion = 40;
  const maxR = Math.max(80, Math.min(width, height) / 2 - innerCushion);
  // Inner-to-outer rings. accLabel = accuracy value AT that ring.
  // Outer ring (r = maxR, full distance from center) = 0% accuracy.
  // Inner ring (r = maxR * 0.25, closest to center) = 75% accuracy.
  // Center bloom itself = 100% accuracy (no ring needed).
  const rings = [
    { r: maxR,        accLabel: '0%' },
    { r: maxR * 0.75, accLabel: '25%' },
    { r: maxR * 0.5,  accLabel: '50%' },
    { r: maxR * 0.25, accLabel: '75%' },
  ];
  return (
    <svg
      width="100%"
      height={height}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      aria-hidden
    >
      {rings.map(({ r, accLabel }) => (
        <g key={accLabel}>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="var(--border-strong)"
            strokeDasharray="2 4"
            opacity={0.5}
          />
          {/* Tick label just ABOVE the top of each ring (outside the arc)
              so it doesn't collide with avatar/name labels rendered at
              roughly the same y-coordinate inside the ring. */}
          {!hideLabels && (
            <text
              x={cx + 6}
              y={cy - r - 4}
              fontFamily="var(--font-mono)"
              fontSize="9"
              fill="var(--ink-3)"
              letterSpacing="0.06em"
            >
              {accLabel}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * Focus layout: selected agent at center; peers placed on an inner orbit
 * with distance inversely proportional to relationship strength (more rounds
 * = closer to center). Non-peers are positioned off-stage and tagged
 * 'hidden' so the renderer can fade them out.
 */
function focusLayout(
  selectedId: string,
  agentIds: string[],
  peerRelationships: PeerRelationshipMap,
  width: number,
  height: number,
): Map<string, Position> {
  const center = { x: width / 2, y: height / 2 };
  const out = new Map<string, Position>();
  out.set(selectedId, { x: center.x, y: center.y, role: 'center' });

  // Collect peers (anyone with a relationship entry to selectedId).
  const peers: Array<{ id: string; rel: PeerRelationship }> = [];
  for (const id of agentIds) {
    if (id === selectedId) continue;
    const rel = peerRelationships.get(peerKey(selectedId, id));
    if (rel) peers.push({ id, rel });
  }

  // Distance encoding: more rounds = closer to center. Normalize rounds
  // across the visible peer set so the strongest peer is always at maxRounds → 1.
  const maxRounds = Math.max(1, ...peers.map((p) => p.rel.rounds));
  const minOrbit = Math.max(120, Math.min(width, height) * 0.20);
  const maxOrbit = Math.min(width, height) * 0.42;

  // Stable angle: sort peers by id so positions don't shuffle between renders.
  const sortedPeers = peers.slice().sort((a, b) => a.id.localeCompare(b.id));
  const N = sortedPeers.length;
  for (let i = 0; i < N; i++) {
    const { id, rel } = sortedPeers[i];
    const angle = (i / Math.max(1, N)) * Math.PI * 2 - Math.PI / 2;
    const norm = rel.rounds / maxRounds; // 0..1, 1 = strongest
    const distance = maxOrbit - norm * (maxOrbit - minOrbit);
    out.set(id, {
      x: center.x + distance * Math.cos(angle),
      y: center.y + distance * Math.sin(angle),
      role: 'peer',
    });
  }

  // Non-peer agents (selected has no relationship with them) get a hidden
  // off-stage position so the CSS transition fades them out.
  for (const id of agentIds) {
    if (out.has(id)) continue;
    out.set(id, { x: center.x, y: center.y, role: 'hidden' });
  }

  return out;
}

export function AgentNetworkGraph({
  agents, peerRelationships, selectedAgentId, onSelectAgent, height = 420,
}: AgentNetworkGraphProps) {
  // Empty / single-agent states.
  if (agents.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center rounded-lg border"
        style={{ height, background: 'var(--stage-bg)', borderColor: 'var(--border)', color: 'var(--stage-text-dim)' }}
      >
        <div className="text-center">
          <div className="mb-2 h-section">
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

  return (
    <HubSpokeGraph
      agents={agents}
      peerRelationships={peerRelationships}
      selectedAgentId={selectedAgentId}
      onSelectAgent={onSelectAgent}
      height={height}
    />
  );
}

function HubSpokeGraph({
  agents, peerRelationships, selectedAgentId, onSelectAgent, height = 420,
}: AgentNetworkGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  // measuredHeight tracks the ACTUAL rendered card height (which stretches via
  // the equal-height flex row), separately from the `height` prop (which is
  // just the minimum floor). Centering the rings + stars + agents in the real
  // canvas requires this — otherwise the system lives in the top `height` px
  // and the bottom of the stretched card is empty.
  const [measuredHeight, setMeasuredHeight] = useState(height);

  // Resize observer keeps layout responsive in both dimensions.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      if (w > 0) setWidth(w);
      if (h > 0) setMeasuredHeight(h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Deterministic positions — no force simulation. Recomputed on selection /
  // size change. Each render returns the SAME Map structure when inputs match
  // (memoized below), so CSS transitions animate left/top smoothly.
  const positions = useMemo(() => {
    const ids = agents.map((a) => a.id);
    if (selectedAgentId && ids.includes(selectedAgentId)) {
      return focusLayout(selectedAgentId, ids, peerRelationships, width, measuredHeight);
    }
    return restingLayout(agents, width, measuredHeight);
  }, [agents, peerRelationships, selectedAgentId, width, measuredHeight]);

  // Spokes (only drawn in focus mode) — straight lines from center to each peer.
  const spokes = useMemo(() => {
    if (!selectedAgentId) return [];
    const selectedPos = positions.get(selectedAgentId);
    if (!selectedPos) return [];
    type Spoke = { peerId: string; x1: number; y1: number; x2: number; y2: number; cls: 'trust' | 'mixed' | 'catch'; width: number; rounds: number };
    const out: Spoke[] = [];
    for (const a of agents) {
      if (a.id === selectedAgentId) continue;
      const pos = positions.get(a.id);
      if (!pos || pos.role !== 'peer') continue;
      const rel = peerRelationships.get(peerKey(selectedAgentId, a.id));
      if (!rel) continue;
      const cls = classifyPeerRelationship(rel);
      if (!cls) continue;
      out.push({
        peerId: a.id, x1: selectedPos.x, y1: selectedPos.y, x2: pos.x, y2: pos.y,
        cls, width: edgeWidthFor(rel.rounds), rounds: rel.rounds,
      });
    }
    // Mixed behind trust behind catch.
    const ORDER: Record<Spoke['cls'], number> = { mixed: 0, trust: 1, catch: 2 };
    out.sort((a, b) => ORDER[a.cls] - ORDER[b.cls]);
    return out;
  }, [agents, peerRelationships, selectedAgentId, positions]);

  // Count summary for the header.
  const peerCount = selectedAgentId ? spokes.length : 0;

  // Agent positions for the starfield's eat-stars animation. Coordinates are
  // in the stage's coordinate space, same as restingLayout/focusLayout output.
  const agentPositionsForStars = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (const agent of agents) {
      const p = positions.get(agent.id);
      if (p) out.push({ x: p.x, y: p.y });
    }
    return out;
  }, [agents, positions]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-lg border"
      style={{
        // minHeight gives the stage a floor; height: 100% lets it grow to fill
        // the parent flex row when the sidebar is taller (fixes "space below"
        // when items-stretch makes the row equal-height).
        minHeight: height,
        height: '100%',
        // Always-dark stage regardless of overall theme — the observatory /
        // cosmic metaphor (agents as stars in an accuracy constellation) only
        // reads in the dark. Override stage-* tokens with literal dark values
        // so light-mode users still see the cosmic canvas.
        background: '#14120F',
        borderColor: '#2B2823',
        ['--stage-bg' as any]: '#14120F',
        ['--stage-text-dim' as any]: '#B8B0A1',
        ['--stage-grid' as any]: 'rgba(255,255,255,0.03)',
      }}
      onClick={() => onSelectAgent(null)}
    >
      {/* Starfield: observatory backdrop with eat-the-stars animation.
          Stars within ~60px of an agent drift in, shrink, fade, then respawn. */}
      <Starfield width={width} height={measuredHeight} agentPositions={agentPositionsForStars} />
      {/* Accuracy rings — rendered second (behind spokes/avatars, above stars).
          Hide labels in focus mode: positions are then driven by peer-
          distance, not accuracy, so the accuracy ticks would mislead. */}
      <RingBands width={width} height={measuredHeight} hideLabels={!!selectedAgentId} />

      {/* Header label — adapts to mode. */}
      <div
        className="absolute z-10 flex items-center gap-2 h-section"
        style={{
          top: 10,
          left: 12,
          pointerEvents: 'none',
          color: 'var(--stage-text-dim)',
          background: 'color-mix(in oklch, var(--stage-bg) 70%, transparent)',
          padding: '2px 6px',
          borderRadius: '3px',
        }}
      >
        {selectedAgentId ? (
          <>
            <span>Focus</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: '#F2EDE3' }}>{selectedAgentId}</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: '#F2EDE3' }}>{peerCount}</span>
            <span style={{ opacity: 0.7 }}>peer{peerCount === 1 ? '' : 's'}</span>
          </>
        ) : (
          <>
            <span>Fleet</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ color: '#F2EDE3' }}>{agents.length}</span>
            <span style={{ opacity: 0.7 }}>agents</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ opacity: 0.7 }}>click an avatar to focus</span>
          </>
        )}
      </div>

      {/* Accuracy-scope legend — explains the radial encoding. Sits just below
          the fleet-name overlay at the top-left. Per Step 4 review feedback,
          the legend must be in the attention path (top-left, not bottom-left).
          Only shown in resting mode — focus mode has its own edge legend. */}
      {!selectedAgentId && (
        <div
          className="absolute z-10 h-section"
          style={{
            top: 36,
            left: 12,
            fontSize: '10px',
            color: 'var(--stage-text-dim)',
            background: 'color-mix(in oklch, var(--stage-bg) 70%, transparent)',
            padding: '2px 6px',
            borderRadius: '3px',
            pointerEvents: 'none',
          }}
        >
          closer to center = higher accuracy · spoke color = agent identity
        </div>
      )}

      {/* Spokes in focus mode only. SVG layer sits above the background. */}
      <svg width="100%" height={measuredHeight} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        {spokes.map((s) => {
          // Trim line endpoints to avatar radius so spokes meet the circumference.
          const selectedAgent = agents.find((a) => a.id === selectedAgentId);
          const peerAgent = agents.find((a) => a.id === s.peerId);
          if (!selectedAgent || !peerAgent) return null;
          const sr = sizeFor(selectedAgent.scores.signals) / 2;
          const pr = sizeFor(peerAgent.scores.signals) / 2;
          const dx = s.x2 - s.x1;
          const dy = s.y2 - s.y1;
          const len = Math.max(1, Math.hypot(dx, dy));
          const ux = dx / len;
          const uy = dy / len;
          const sx = s.x1 + ux * sr;
          const sy = s.y1 + uy * sr;
          const tx = s.x2 - ux * pr;
          const ty = s.y2 - uy * pr;
          const stroke = s.cls === 'trust' ? 'var(--success)' : s.cls === 'mixed' ? 'var(--warn)' : 'var(--danger)';
          const dash = s.cls === 'mixed' ? '8,2' : undefined;
          return (
            <line
              key={s.peerId}
              x1={sx} y1={sy} x2={tx} y2={ty}
              stroke={stroke}
              strokeWidth={s.width}
              strokeDasharray={dash}
              strokeLinecap="round"
              style={{
                // Dimmer spokes on the cosmic dark canvas — bright stroke
                // saturates against the starfield. 0.55 reads as energy flow,
                // 0.9 read as neon.
                opacity: 0.55,
                transition: 'opacity 200ms cubic-bezier(0.4,0,0.2,1)',
              }}
            />
          );
        })}
      </svg>

      {/* Legend only in focus mode — resting state has no edges to legend. */}
      {selectedAgentId && (
        <div
          className="absolute z-10 flex flex-col gap-1 rounded font-mono text-[10px]"
          style={{ bottom: 10, left: 12, color: 'var(--stage-text-dim)', pointerEvents: 'none' }}
        >
          <LegendRow stroke="var(--success)" label="Trust" />
          <LegendRow stroke="var(--warn)" label="Mixed" dash="8,2" />
          <LegendRow stroke="var(--danger)" label="Caught" />
        </div>
      )}

      {/* Center black hole — the gravitational locus of the fleet.
          Represents the orchestrator: every agent is in orbit around it,
          stars get pulled toward it (via the agent-eat animation), the
          consensus locus collapses here. Visual: dark disc + accretion-
          disk glow + outer halo, all on the center of the measured canvas.
          Resting mode only; in focus mode the selected agent becomes the
          gravitational center via the existing center glow ring. */}
      {!selectedAgentId && measuredHeight > 0 && (
        <div
          className="absolute z-[1] -translate-x-1/2 -translate-y-1/2"
          style={{
            left: width / 2,
            top: measuredHeight / 2,
            pointerEvents: 'none',
          }}
        >
          <svg width="56" height="56" viewBox="0 0 56 56" style={{ display: 'block' }} aria-hidden>
            {/* Outer accretion halo — terracotta glow */}
            <circle cx="28" cy="28" r="26" fill="none" stroke="var(--accent)" strokeWidth="0.6" opacity="0.35" />
            <circle cx="28" cy="28" r="22" fill="none" stroke="var(--accent)" strokeWidth="0.4" opacity="0.25" />
            {/* Event horizon — cream ring on the edge of the disc */}
            <circle cx="28" cy="28" r="12" fill="none" stroke="#F2EDE3" strokeWidth="1.1" opacity="0.75" />
            {/* The disc itself — actual blackhole, swallows whatever the rest is */}
            <circle cx="28" cy="28" r="9" fill="#000" />
            {/* Inner accretion glow rim */}
            <circle cx="28" cy="28" r="9" fill="none" stroke="var(--accent)" strokeWidth="0.5" opacity="0.6" />
          </svg>
          <div
            className="font-mono"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: '9px',
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--stage-text-dim)',
              whiteSpace: 'nowrap',
              opacity: 0.7,
            }}
          >
            orchestrator
          </div>
        </div>
      )}

      {/* Agent nodes — absolutely positioned, transition-animated. */}
      {agents.map((a) => {
        const pos = positions.get(a.id);
        if (!pos) return null;
        const size = sizeFor(a.scores.signals);
        const isCenter = pos.role === 'center';
        const isHidden = pos.role === 'hidden';
        const isPeer = pos.role === 'peer';
        // Resting: full opacity. Center: full + glow ring. Peer: full. Hidden: 0.
        const opacity = isHidden ? 0 : 1;
        const labelColor = isCenter ? '#F2EDE3' : 'var(--stage-text-dim)';
        // Position label RADIALLY OUTWARD from the avatar based on the layout
        // angle. This prevents the universal "label below avatar" collision
        // where two stacked agents have the upper agent's label landing on
        // top of the lower agent. Top-half agents (angle in [-π, 0]) get the
        // label above; bottom-half get it below; left/right shift inline.
        const angle = pos.angle ?? Math.PI / 2; // default: below (no angle = center)
        const labelDist = size / 2 + 14; // gap between avatar edge and label baseline
        const labelDx = Math.cos(angle) * labelDist;
        const labelDy = Math.sin(angle) * labelDist;
        // Anchor the label so its inner edge (toward the center) lines up with
        // the avatar — horizontal labels read left-or-right of avatar; vertical
        // labels (top/bottom) stay center-anchored.
        const labelAnchor: 'left' | 'right' | 'center' =
          Math.abs(Math.cos(angle)) > 0.7
            ? Math.cos(angle) > 0 ? 'left' : 'right'
            : 'center';
        return (
          <button
            key={a.id}
            type="button"
            onClick={(ev) => { ev.stopPropagation(); onSelectAgent(a.id); }}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{
              left: pos.x, top: pos.y,
              opacity,
              pointerEvents: isHidden ? 'none' : 'auto',
              border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
              transition: 'left 320ms cubic-bezier(0.4,0,0.2,1), top 320ms cubic-bezier(0.4,0,0.2,1), opacity 200ms cubic-bezier(0.4,0,0.2,1)',
            }}
            aria-label={`Select agent ${a.id}`}
            title={a.id}
          >
            <div
              className="rounded-full"
              style={{
                width: size, height: size,
                // Focus-mode center: blackhole-style accretion halo (cream
                // event horizon + soft accent glow), not a bright terracotta
                // ring. Coherent with the resting-mode orchestrator blackhole.
                boxShadow: isCenter
                  ? `0 0 0 1.5px rgba(242, 237, 227, 0.45), 0 0 0 6px rgba(201, 112, 86, 0.18), 0 0 28px -4px rgba(201, 112, 86, 0.35)`
                  : undefined,
                transition: 'box-shadow 200ms cubic-bezier(0.4,0,0.2,1)',
              }}
            >
              <NeuralAvatar
                agentId={a.id}
                signals={a.scores.signals}
                accuracy={a.scores.accuracy}
                uniqueness={a.scores.uniqueness}
                impact={a.scores.impactScore}
                size={size}
              />
            </div>
            <div
              className="absolute font-mono text-[10px] font-bold uppercase tracking-wider"
              style={{
                left: '50%',
                top: '50%',
                transform: `translate(calc(-50% + ${labelDx}px), calc(-50% + ${labelDy}px))${
                  labelAnchor === 'left' ? ' translateX(calc(50% + 4px))'
                  : labelAnchor === 'right' ? ' translateX(calc(-50% - 4px))'
                  : ''
                }`,
                color: labelColor,
                textAlign: labelAnchor === 'right' ? 'right' : labelAnchor === 'left' ? 'left' : 'center',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
                transition: 'color 200ms cubic-bezier(0.4,0,0.2,1), transform 320ms cubic-bezier(0.4,0,0.2,1)',
              }}
            >
              {a.id}
            </div>
            {/* Round count under peer name in focus mode — quick relationship-strength signal. */}
            {isPeer && (
              <div
                className="font-mono text-[9px]"
                style={{
                  color: 'var(--stage-text-dim)',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  marginTop: 2,
                }}
              >
                {(() => {
                  const rel = peerRelationships.get(peerKey(selectedAgentId ?? '', a.id));
                  return rel ? `${rel.rounds} round${rel.rounds === 1 ? '' : 's'}` : '';
                })()}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Edge legend swatch — short stroke sample + label. */
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
