// NeuralAvatar Engine — Glowing Orb with distinct topologies
// Each agent gets a unique constellation shape based on ID hash

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ---- Seeded RNG ----

class SeededRNG {
  private s: number;
  constructor(seed: number) { this.s = seed; }
  next(): number { this.s = (this.s * 1103515245 + 12345) & 0x7fffffff; return (this.s % 10000) / 10000; }
  range(min: number, max: number): number { return min + this.next() * (max - min); }
  int(min: number, max: number): number { return Math.floor(this.range(min, max + 1)); }
}

// ---- Color ----

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100, ln = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const v = ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export interface AvatarColors { primary: string; secondary: string; }

export function colorFromAgent(agentId: string): AvatarColors {
  const h = hashString(agentId), hue = h % 360, sat = 65 + (h >> 8) % 20;
  return {
    primary: hslToHex(hue, sat, 65 + (h >> 16) % 10),
    secondary: hslToHex((hue + 30) % 360, Math.min(95, sat + 15), 75 + (h >> 16) % 12),
  };
}

function rgba(hex: string, a: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${Math.max(0, Math.min(1, a))})`;
}

// ---- Node types ----

interface RawNode { x: number; y: number; size: number; brightness: number; }

interface OrbNode {
  x: number; y: number; originX: number; originY: number;
  size: number; baseSize: number; brightness: number;
  phase: number; breathSpeed: number;
  driftAngle: number; driftSpeed: number; driftRadius: number;
}

interface OrbConnection { from: number; to: number; strength: number; }

interface Pulse {
  connIdx: number; progress: number; speed: number;
  brightness: number; forward: boolean;
}

// ---- 6 Topology Generators ----

function topoHub(size: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = size / 2, cy = size / 2, nodes: RawNode[] = [];
  const core = Math.max(2, Math.floor(n * 0.3));
  for (let i = 0; i < core; i++) {
    const a = rng.next() * Math.PI * 2, d = rng.range(2, size * 0.08);
    nodes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(2, 3.5), brightness: rng.range(0.7, 1) });
  }
  const arms = rng.int(3, 5), rem = n - core;
  for (let arm = 0; arm < arms; arm++) {
    const ba = (arm / arms) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const cnt = Math.floor(rem / arms) + (arm === 0 ? rem % arms : 0);
    for (let i = 0; i < cnt; i++) {
      const t = (i + 1) / cnt, dist = size * 0.08 + t * size * 0.32;
      const a = ba + rng.range(-0.2, 0.2) * (1 + t);
      nodes.push({ x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist, size: rng.range(1, 2.8) * (1 - t * 0.3), brightness: rng.range(0.4, 0.8) * (1 - t * 0.2) });
    }
  }
  return nodes;
}

function topoSpiral(size: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = size / 2, cy = size / 2, nodes: RawNode[] = [];
  const arms = rng.int(2, 3), perArm = Math.floor(n / arms);
  for (let arm = 0; arm < arms; arm++) {
    const ba = (arm / arms) * Math.PI * 2;
    const cnt = perArm + (arm === 0 ? n % arms : 0);
    for (let i = 0; i < cnt; i++) {
      const t = i / perArm;
      const a = ba + t * Math.PI * 2.5 + rng.range(-0.12, 0.12);
      const d = 3 + t * size * 0.36;
      nodes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(1.2, 3) * (1 - t * 0.3), brightness: rng.range(0.4, 0.9) * (1 - t * 0.15) });
    }
  }
  return nodes;
}

function topoCluster(size: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = size / 2, cy = size / 2, nodes: RawNode[] = [];
  const cc = rng.int(3, 4);
  const centers: { x: number; y: number }[] = [];
  for (let c = 0; c < cc; c++) {
    const a = rng.next() * Math.PI * 2, d = rng.range(size * 0.1, size * 0.25);
    centers.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d });
  }
  for (let i = 0; i < n; i++) {
    const ctr = centers[i % cc];
    const a = rng.next() * Math.PI * 2, d = rng.range(2, size * 0.1);
    nodes.push({ x: ctr.x + Math.cos(a) * d, y: ctr.y + Math.sin(a) * d, size: rng.range(1.2, 2.8), brightness: rng.range(0.4, 0.9) });
  }
  return nodes;
}

function topoStar(size: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = size / 2, cy = size / 2, nodes: RawNode[] = [];
  nodes.push({ x: cx, y: cy, size: 3.5, brightness: 1.0 });
  const rays = rng.int(5, 7), rem = n - 1, perRay = Math.floor(rem / rays);
  for (let r = 0; r < rays; r++) {
    const ba = (r / rays) * Math.PI * 2;
    const cnt = perRay + (r === 0 ? rem % rays : 0);
    for (let i = 0; i < cnt; i++) {
      const t = (i + 1) / cnt, a = ba + rng.range(-0.06, 0.06), d = t * size * 0.38;
      nodes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(1, 2.2) * (1 - t * 0.3), brightness: rng.range(0.4, 0.8) * (1 - t * 0.2) });
    }
  }
  return nodes;
}

function topoChain(size: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = size / 2, cy = size / 2, nodes: RawNode[] = [];
  const main = Math.floor(n * 0.6);
  for (let i = 0; i < main; i++) {
    const t = i / (main - 1);
    const x = cx + (t - 0.5) * size * 0.65;
    const y = cy + Math.sin(t * Math.PI * 1.8) * size * 0.18 + rng.range(-3, 3);
    nodes.push({ x, y, size: rng.range(1.5, 3) * (0.7 + 0.3 * Math.sin(t * Math.PI)), brightness: rng.range(0.5, 0.9) });
  }
  for (let i = 0; i < n - main; i++) {
    const par = nodes[rng.int(0, main - 1)];
    const a = rng.next() * Math.PI * 2, d = rng.range(6, size * 0.1);
    nodes.push({ x: par.x + Math.cos(a) * d, y: par.y + Math.sin(a) * d, size: rng.range(0.9, 2), brightness: rng.range(0.3, 0.6) });
  }
  return nodes;
}

function topoMesh(size: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = size / 2, cy = size / 2, nodes: RawNode[] = [];
  const cols = Math.ceil(Math.sqrt(n * 1.2)), sp = size * 0.65 / cols;
  const ox = cx - (cols - 1) * sp / 2, oy = cy - (cols - 1) * sp / 2;
  let p = 0;
  for (let r = 0; r < cols && p < n; r++) {
    for (let c = 0; c < cols && p < n; c++) {
      const x = ox + c * sp + rng.range(-sp * 0.3, sp * 0.3);
      const y = oy + r * sp + rng.range(-sp * 0.3, sp * 0.3);
      const dx = x - cx, dy = y - cy;
      if (Math.sqrt(dx * dx + dy * dy) < size * 0.4) {
        nodes.push({ x, y, size: rng.range(1.3, 2.6), brightness: rng.range(0.45, 0.85) });
        p++;
      }
    }
  }
  while (nodes.length < n) {
    const a = rng.next() * Math.PI * 2, d = rng.range(4, size * 0.35);
    nodes.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(1.2, 2.2), brightness: rng.range(0.4, 0.7) });
  }
  return nodes;
}

type TopoFn = (size: number, rng: SeededRNG, n: number) => RawNode[];
const TOPOLOGIES: TopoFn[] = [topoHub, topoSpiral, topoCluster, topoStar, topoChain, topoMesh];

// ---- Engine ----

export class OrbAvatarEngine {
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private color: AvatarColors;
  private nodes: OrbNode[] = [];
  private connections: OrbConnection[] = [];
  private pulses: Pulse[] = [];
  private time = 0;

  constructor(canvas: HTMLCanvasElement, agentId: string) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    this.ctx = ctx;
    this.size = canvas.width / 2;
    this.color = colorFromAgent(agentId);

    const seed = hashString(agentId);
    const rng = new SeededRNG(seed);
    const sc = this.size / 64;
    const topoFn = TOPOLOGIES[seed % TOPOLOGIES.length];
    const nodeCount = rng.int(8, 14);

    const rawNodes = topoFn(this.size, rng, nodeCount);

    this.nodes = rawNodes.map(n => ({
      x: n.x, y: n.y, originX: n.x, originY: n.y,
      size: n.size * sc, baseSize: n.size * sc,
      brightness: n.brightness,
      phase: rng.next() * Math.PI * 2,
      breathSpeed: rng.range(0.4, 1.5),
      driftAngle: rng.next() * Math.PI * 2,
      driftSpeed: rng.range(0.1, 0.4),
      driftRadius: rng.range(0.3, 1.2) * sc,
    }));

    // Build connections
    const maxDist = this.size * 0.35;
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const dx = this.nodes[i].originX - this.nodes[j].originX;
        const dy = this.nodes[i].originY - this.nodes[j].originY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < maxDist && rng.next() < (1 - dist / maxDist) * 0.7) {
          this.connections.push({ from: i, to: j, strength: 1 - dist / maxDist });
        }
      }
    }

    this.time = rng.next() * 100;
  }

  update(dt: number): void {
    this.time += dt;

    // Spawn pulses along connections
    if (this.connections.length > 0 && Math.random() < dt * 0.15) {
      if (this.pulses.length < 6) {
        const idx = Math.floor(Math.random() * this.connections.length);
        this.pulses.push({
          connIdx: idx, progress: 0,
          speed: 0.008 + Math.random() * 0.015,
          brightness: 0.5 + Math.random() * 0.5,
          forward: Math.random() > 0.5,
        });
      }
    }

    // Update pulses
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      this.pulses[i].progress += this.pulses[i].speed;
      if (this.pulses[i].progress > 1) this.pulses.splice(i, 1);
    }

    // Node breathing + drift
    for (const n of this.nodes) {
      const breath = Math.sin(this.time * n.breathSpeed + n.phase);
      n.size = n.baseSize * (1 + breath * 0.3);
      n.x = n.originX + Math.cos(this.time * n.driftSpeed + n.driftAngle) * n.driftRadius;
      n.y = n.originY + Math.sin(this.time * n.driftSpeed * 0.7 + n.driftAngle) * n.driftRadius;
    }
  }

  draw(): void {
    const { ctx, size, color, nodes, connections, pulses, time } = this;
    const cx = size / 2, cy = size / 2, sc = size / 64;
    ctx.clearRect(0, 0, size, size);

    // Background disc
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15,15,22,0.8)'; ctx.fill();

    // Ambient glow
    const bgBreath = 0.85 + 0.15 * Math.sin(time * 0.3);
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.45);
    bg.addColorStop(0, rgba(color.primary, 0.2 * bgBreath));
    bg.addColorStop(0.4, rgba(color.primary, 0.06 * bgBreath));
    bg.addColorStop(1, 'transparent');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, size, size);

    // Connections
    for (const c of connections) {
      const f = nodes[c.from], t = nodes[c.to];
      const connBreath = 0.7 + 0.3 * Math.sin(time * 0.5 + c.from);
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = rgba(color.primary, c.strength * 0.35 * connBreath);
      ctx.lineWidth = (0.5 + c.strength * 0.5) * sc; ctx.stroke();
    }

    // Pulses travelling along connections
    for (const p of pulses) {
      const c = connections[p.connIdx];
      if (!c) continue;
      const f = nodes[c.from], t = nodes[c.to];
      const prog = p.forward ? p.progress : 1 - p.progress;
      const px = f.x + (t.x - f.x) * prog;
      const py = f.y + (t.y - f.y) * prog;
      const fade = 1 - Math.abs(p.progress - 0.5) * 2; // fade at edges

      // Pulse glow
      const pg = ctx.createRadialGradient(px, py, 0, px, py, 6 * sc);
      pg.addColorStop(0, rgba(color.secondary, p.brightness * fade * 0.5));
      pg.addColorStop(1, 'transparent');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, 6 * sc, 0, Math.PI * 2); ctx.fill();

      // Pulse core
      ctx.beginPath(); ctx.arc(px, py, 1.5 * sc, 0, Math.PI * 2);
      ctx.fillStyle = rgba('#ffffff', p.brightness * fade * 0.6); ctx.fill();
    }

    // Node halos
    for (const n of nodes) {
      const breath = 0.8 + 0.2 * Math.sin(time * n.breathSpeed * 0.5 + n.phase);
      const b = n.brightness * breath;
      const hg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.size * 4);
      hg.addColorStop(0, rgba(color.primary, b * 0.25));
      hg.addColorStop(1, 'transparent');
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(n.x, n.y, n.size * 4, 0, Math.PI * 2); ctx.fill();
    }

    // Nodes
    for (const n of nodes) {
      const breath = 0.8 + 0.2 * Math.sin(time * n.breathSpeed + n.phase);
      const b = n.brightness * breath;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color.primary, b); ctx.fill();
      // Hot core on larger nodes
      if (n.baseSize > 1.5 * sc) {
        ctx.beginPath(); ctx.arc(n.x, n.y, n.size * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = rgba('#ffffff', b * 0.4); ctx.fill();
      }
    }

    // Center core glow
    const coreBreath = 0.9 + 0.1 * Math.sin(time * 0.4);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.12);
    core.addColorStop(0, rgba(color.secondary, 0.4 * coreBreath));
    core.addColorStop(0.5, rgba(color.primary, 0.12 * coreBreath));
    core.addColorStop(1, 'transparent');
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(cx, cy, size * 0.12, 0, Math.PI * 2); ctx.fill();

    // Center dot
    ctx.beginPath(); ctx.arc(cx, cy, 1.2 * sc, 0, Math.PI * 2);
    ctx.fillStyle = rgba('#ffffff', 0.5 * coreBreath); ctx.fill();
  }
}
