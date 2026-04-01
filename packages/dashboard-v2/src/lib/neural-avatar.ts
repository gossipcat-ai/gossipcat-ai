// NeuralAvatar Engine — Redesigned with crab-language-quality rendering
// Transparent background, particles, strong glows, 7-layer draw pipeline

export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

class SeededRNG {
  private s: number;
  constructor(seed: number) { this.s = seed; }
  next(): number { this.s = (this.s * 1103515245 + 12345) & 0x7fffffff; return (this.s % 10000) / 10000; }
  range(min: number, max: number): number { return min + this.next() * (max - min); }
  int(min: number, max: number): number { return Math.floor(this.range(min, max + 1)); }
}

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
  const h = hashString(agentId), hue = h % 360, sat = 70 + (h >> 8) % 15;
  return {
    primary: hslToHex(hue, sat, 60 + (h >> 16) % 10),
    secondary: hslToHex(hue, Math.min(95, sat + 10), 78 + (h >> 16) % 8),
  };
}

function rgba(hex: string, a: number): string {
  return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${Math.max(0, Math.min(1, a))})`;
}

// ---- Types ----

interface RawNode { x: number; y: number; size: number; brightness: number; }

interface AnimNode {
  x: number; y: number; originX: number; originY: number;
  baseSize: number; size: number;
  brightness: number; currentBrightness: number;
  phase: number; breathSpeed: number; breathDepth: number;
  driftAngle: number; driftSpeed: number; driftRadius: number;
  glimpsePhase: number; glimpseSpeed: number; glimpseIntensity: number;
}

interface Connection {
  from: number; to: number; strength: number;
  pulsePhase: number; pulseSpeed: number;
}

interface Pulse {
  connIdx: number; progress: number; speed: number;
  brightness: number; forward: boolean; trailLength: number;
}

interface Particle {
  orbitRadius: number; orbitAngle: number; orbitSpeed: number;
  size: number; twinkleSpeed: number; twinklePhase: number;
}

// ---- 6 Topology Generators ----

function topoHub(s: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = s / 2, cy = s / 2, nd: RawNode[] = [];
  const core = Math.max(2, Math.floor(n * 0.3));
  for (let i = 0; i < core; i++) {
    const a = rng.next() * Math.PI * 2, d = rng.range(2, s * 0.06);
    nd.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(1.8, 2.8), brightness: rng.range(0.8, 1) });
  }
  const arms = rng.int(3, 5), rem = n - core;
  for (let arm = 0; arm < arms; arm++) {
    const ba = (arm / arms) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const cnt = Math.floor(rem / arms) + (arm === 0 ? rem % arms : 0);
    for (let i = 0; i < cnt; i++) {
      const t = (i + 1) / cnt, dist = s * 0.08 + t * s * 0.32;
      nd.push({ x: cx + Math.cos(ba + rng.range(-0.15, 0.15) * (1 + t)) * dist, y: cy + Math.sin(ba + rng.range(-0.15, 0.15) * (1 + t)) * dist, size: rng.range(1, 2.2) * (1 - t * 0.3), brightness: rng.range(0.5, 0.85) * (1 - t * 0.15) });
    }
  }
  return nd;
}

function topoSpiral(s: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = s / 2, cy = s / 2, nd: RawNode[] = [];
  const arms = rng.int(2, 3), perArm = Math.floor(n / arms);
  for (let arm = 0; arm < arms; arm++) {
    const ba = (arm / arms) * Math.PI * 2, cnt = perArm + (arm === 0 ? n % arms : 0);
    for (let i = 0; i < cnt; i++) {
      const t = i / perArm, a = ba + t * Math.PI * 2.5 + rng.range(-0.1, 0.1), d = 3 + t * s * 0.36;
      nd.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(1, 2.2) * (1 - t * 0.3), brightness: rng.range(0.5, 1) * (1 - t * 0.1) });
    }
  }
  return nd;
}

function topoCluster(s: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = s / 2, cy = s / 2, nd: RawNode[] = [];
  const cc = rng.int(3, 4), centers: { x: number; y: number }[] = [];
  for (let c = 0; c < cc; c++) { const a = rng.next() * Math.PI * 2, d = rng.range(s * 0.1, s * 0.25); centers.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d }); }
  for (let i = 0; i < n; i++) { const ctr = centers[i % cc], a = rng.next() * Math.PI * 2, d = rng.range(2, s * 0.09); nd.push({ x: ctr.x + Math.cos(a) * d, y: ctr.y + Math.sin(a) * d, size: rng.range(1, 2.2), brightness: rng.range(0.5, 1) }); }
  return nd;
}

function topoStar(s: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = s / 2, cy = s / 2, nd: RawNode[] = [{ x: cx, y: cy, size: 2.8, brightness: 1.0 }];
  const rays = rng.int(5, 7), rem = n - 1, perRay = Math.floor(rem / rays);
  for (let r = 0; r < rays; r++) { const ba = (r / rays) * Math.PI * 2, cnt = perRay + (r === 0 ? rem % rays : 0); for (let i = 0; i < cnt; i++) { const t = (i + 1) / cnt; nd.push({ x: cx + Math.cos(ba + rng.range(-0.06, 0.06)) * t * s * 0.38, y: cy + Math.sin(ba + rng.range(-0.06, 0.06)) * t * s * 0.38, size: rng.range(0.8, 1.8) * (1 - t * 0.3), brightness: rng.range(0.5, 0.9) * (1 - t * 0.15) }); } }
  return nd;
}

function topoChain(s: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = s / 2, cy = s / 2, nd: RawNode[] = [];
  const main = Math.floor(n * 0.7);
  for (let i = 0; i < main; i++) { const t = i / (main - 1); nd.push({ x: cx + (t - 0.5) * s * 0.65, y: cy + Math.sin(t * Math.PI * 1.8) * s * 0.18 + rng.range(-2, 2), size: rng.range(1.2, 2.2) * (0.7 + 0.3 * Math.sin(t * Math.PI)), brightness: rng.range(0.5, 1) }); }
  for (let i = 0; i < n - main; i++) { const par = nd[rng.int(0, main - 1)]; nd.push({ x: par.x + Math.cos(rng.next() * Math.PI * 2) * rng.range(5, s * 0.08), y: par.y + Math.sin(rng.next() * Math.PI * 2) * rng.range(5, s * 0.08), size: rng.range(0.7, 1.5), brightness: rng.range(0.4, 0.7) }); }
  return nd;
}

function topoMesh(s: number, rng: SeededRNG, n: number): RawNode[] {
  const cx = s / 2, cy = s / 2, nd: RawNode[] = [];
  const cols = Math.ceil(Math.sqrt(n * 1.2)), sp = s * 0.65 / cols;
  const ox = cx - (cols - 1) * sp / 2, oy = cy - (cols - 1) * sp / 2;
  let p = 0;
  for (let r = 0; r < cols && p < n; r++) for (let c = 0; c < cols && p < n; c++) {
    const x = ox + c * sp + rng.range(-sp * 0.3, sp * 0.3), y = oy + r * sp + rng.range(-sp * 0.3, sp * 0.3);
    if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) < s * 0.4) { nd.push({ x, y, size: rng.range(1, 2), brightness: rng.range(0.5, 0.9) }); p++; }
  }
  while (nd.length < n) { const a = rng.next() * Math.PI * 2, d = rng.range(4, s * 0.35); nd.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, size: rng.range(1, 1.8), brightness: rng.range(0.5, 0.8) }); }
  return nd;
}

type TopoFn = (s: number, rng: SeededRNG, n: number) => RawNode[];
const TOPOLOGIES: TopoFn[] = [topoHub, topoSpiral, topoCluster, topoStar, topoChain, topoMesh];

// ---- Engine ----

export class OrbAvatarEngine {
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private color: AvatarColors;
  private nodes: AnimNode[] = [];
  private connections: Connection[] = [];
  private pulses: Pulse[] = [];
  private particles: Particle[] = [];
  private time = 0;
  private glowIntensity: number;
  private pulseRate: number;

  constructor(canvas: HTMLCanvasElement, agentId: string, evolution = 0.15) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D context');
    this.ctx = ctx;
    this.size = canvas.width / 2;
    this.color = colorFromAgent(agentId);

    const evo = Math.max(0, Math.min(1, evolution));
    this.glowIntensity = 1.0 + evo * 0.8;
    this.pulseRate = 0.12 + evo * 0.15;

    const seed = hashString(agentId);
    const rng = new SeededRNG(seed);
    const topoFn = TOPOLOGIES[seed % TOPOLOGIES.length];
    const nodeCount = Math.round(5 + evo * 7);
    const sizeRatio = this.size / 160; // topology generators target ~160px

    const rawNodes = topoFn(this.size, rng, nodeCount);

    const nodeSizeBoost = 1.7; // bigger nodes than crab-language default
    this.nodes = rawNodes.map(n => ({
      x: n.x, y: n.y, originX: n.x, originY: n.y,
      baseSize: n.size * sizeRatio * nodeSizeBoost,
      size: n.size * sizeRatio * nodeSizeBoost,
      brightness: n.brightness,
      currentBrightness: n.brightness,
      phase: rng.next() * Math.PI * 2,
      breathSpeed: rng.range(0.8, 2.5),
      breathDepth: rng.range(0.35, 0.6),
      driftAngle: rng.next() * Math.PI * 2,
      driftSpeed: rng.range(0.2, 0.6),
      driftRadius: rng.range(0.6, 2.0),
      glimpsePhase: rng.next() * Math.PI * 2,
      glimpseSpeed: rng.range(0.1, 0.35),
      glimpseIntensity: rng.range(0.4, 0.9),
    }));

    // Connections — generous like crab-language
    const maxDist = this.size * (0.16 + evo * 0.19);
    const connDens = 0.3 + evo * 0.5;
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const dx = this.nodes[i].originX - this.nodes[j].originX;
        const dy = this.nodes[i].originY - this.nodes[j].originY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < maxDist && rng.next() < (1 - dist / maxDist) * connDens) {
          this.connections.push({
            from: i, to: j,
            strength: (1 - dist / maxDist) * (0.5 + evo * 0.5),
            pulsePhase: rng.next() * Math.PI * 2,
            pulseSpeed: rng.range(0.3, 0.8),
          });
        }
      }
    }

    // Particles — twinkling ambient dots (like crab-language)
    const pCount = Math.round(8 + evo * 25);
    for (let i = 0; i < pCount; i++) {
      this.particles.push({
        orbitRadius: 10 + rng.next() * this.size * 0.42,
        orbitAngle: rng.next() * Math.PI * 2,
        orbitSpeed: (rng.next() - 0.5) * 0.003,
        size: 0.3 + rng.next() * 0.5,
        twinkleSpeed: rng.range(1, 4),
        twinklePhase: rng.next() * Math.PI * 2,
      });
    }

    this.time = rng.next() * 100;
  }

  update(dt: number): void {
    this.time += dt;

    // Spawn pulses
    if (this.connections.length > 0 && Math.random() < dt * this.pulseRate) {
      if (this.pulses.length < 6) {
        const idx = Math.floor(Math.random() * this.connections.length);
        this.pulses.push({
          connIdx: idx, progress: 0,
          speed: 0.004 + Math.random() * 0.012,
          brightness: 0.5 + Math.random() * 0.5,
          forward: Math.random() > 0.5,
          trailLength: 0.12 + Math.random() * 0.08,
        });
      }
    }

    // Update pulses
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      this.pulses[i].progress += this.pulses[i].speed;
      if (this.pulses[i].progress > 1) this.pulses.splice(i, 1);
    }

    // Node animation — breathing, drift, glimpsing
    for (const n of this.nodes) {
      const breath = Math.sin(this.time * n.breathSpeed + n.phase);
      n.size = n.baseSize * (1 + breath * n.breathDepth);
      n.x = n.originX + Math.cos(this.time * n.driftSpeed + n.driftAngle) * n.driftRadius;
      n.y = n.originY + Math.sin(this.time * n.driftSpeed * 0.7 + n.driftAngle) * n.driftRadius;
      const glimpse = Math.pow(Math.max(0, Math.sin(this.time * n.glimpseSpeed + n.glimpsePhase)), 8);
      n.currentBrightness = n.brightness + glimpse * n.glimpseIntensity;
    }

    // Particle orbits
    for (const p of this.particles) { p.orbitAngle += p.orbitSpeed; }
  }

  draw(): void {
    const { ctx, size, color, nodes, connections, pulses, particles, time } = this;
    const cx = size / 2, cy = size / 2;
    const gi = this.glowIntensity;

    // 1. Clear + ring background + subtle ambient
    ctx.clearRect(0, 0, size, size);

    // Ring background — dark disc with breathing colored ring border
    const ringBreath = 0.7 + 0.3 * Math.sin(time * 0.5);
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,10,16,0.7)'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(color.primary, 0.15 + 0.12 * ringBreath);
    ctx.lineWidth = 1.5; ctx.stroke();

    // Minimal ambient — almost none
    const bgBreath = 0.9 + 0.1 * Math.sin(time * 0.3);
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.35);
    bg.addColorStop(0, rgba(color.primary, 0.015 * gi * bgBreath));
    bg.addColorStop(1, 'transparent');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // 2. Particles — tiny twinkling dots
    for (const p of particles) {
      const px = cx + Math.cos(p.orbitAngle) * p.orbitRadius;
      const py = cy + Math.sin(p.orbitAngle) * p.orbitRadius;
      const twinkle = 0.4 + 0.6 * Math.pow((Math.sin(time * p.twinkleSpeed + p.twinklePhase) + 1) / 2, 2);
      ctx.beginPath();
      ctx.arc(px, py, p.size * (0.8 + twinkle * 0.4), 0, Math.PI * 2);
      ctx.fillStyle = rgba(color.primary, twinkle * 0.12);
      ctx.fill();
    }

    // 3. Connections — thick and visible
    for (const c of connections) {
      const f = nodes[c.from], t = nodes[c.to];
      const connBreath = 0.7 + 0.3 * Math.sin(time * c.pulseSpeed + c.pulsePhase);
      const alpha = (c.strength * 0.6 + 0.3) * connBreath;
      ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = rgba(color.primary, alpha);
      ctx.lineWidth = (1.2 + c.strength * 1.8) * (0.85 + connBreath * 0.15);
      ctx.stroke();
    }

    // 4. Pulses — glowing dots with trails
    for (const p of pulses) {
      const c = connections[p.connIdx];
      if (!c) continue;
      const f = nodes[c.from], t = nodes[c.to];
      const prog = p.forward ? p.progress : 1 - p.progress;
      const headX = f.x + (t.x - f.x) * prog;
      const headY = f.y + (t.y - f.y) * prog;

      // Trail
      const trailSteps = 6;
      for (let s = trailSteps; s >= 0; s--) {
        const tp = prog - (s / trailSteps) * p.trailLength;
        if (tp < 0) continue;
        const tx = f.x + (t.x - f.x) * tp;
        const ty = f.y + (t.y - f.y) * tp;
        const fade = 1 - s / trailSteps;
        ctx.beginPath(); ctx.arc(tx, ty, 0.8 + fade * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = rgba(color.secondary, p.brightness * fade * 0.5);
        ctx.fill();
      }

      // Head bloom
      const bloom = ctx.createRadialGradient(headX, headY, 0, headX, headY, 10);
      bloom.addColorStop(0, rgba(color.secondary, p.brightness * 0.6));
      bloom.addColorStop(0.3, rgba(color.primary, p.brightness * 0.2));
      bloom.addColorStop(1, 'transparent');
      ctx.fillStyle = bloom;
      ctx.fillRect(headX - 12, headY - 12, 24, 24);

      // Bright core
      ctx.beginPath(); ctx.arc(headX, headY, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = rgba('#ffffff', p.brightness * 0.5);
      ctx.fill();
    }

    // 5. Node halos — subtle, tight
    for (const n of nodes) {
      const b = n.currentBrightness;
      const breathGlow = 0.85 + 0.15 * Math.sin(time * n.breathSpeed * 0.5 + n.phase);
      const hr = n.size * 3;
      const hg = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, hr);
      hg.addColorStop(0, rgba(color.primary, b * 0.12 * breathGlow));
      hg.addColorStop(1, 'transparent');
      ctx.fillStyle = hg;
      ctx.beginPath(); ctx.arc(n.x, n.y, hr, 0, Math.PI * 2); ctx.fill();
    }

    // 6. Nodes — FULL opacity, bright and solid
    for (const n of nodes) {
      const b = n.currentBrightness;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.size, 0, Math.PI * 2);
      ctx.fillStyle = rgba(color.primary, Math.min(1, b * 1.2));
      ctx.fill();
    }

    // 7. Hot cores — bright white centers
    for (const n of nodes) {
      if (n.size > 1.0) {
        const b = n.currentBrightness;
        const coreGlow = 0.7 + 0.3 * Math.sin(time * n.breathSpeed + n.phase + 1);
        ctx.beginPath(); ctx.arc(n.x, n.y, n.size * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = rgba('#ffffff', Math.min(1, b * 0.6 * coreGlow));
        ctx.fill();
      }
    }
  }
}
