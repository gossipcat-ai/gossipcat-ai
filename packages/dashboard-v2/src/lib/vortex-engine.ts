// Vortex NeuralAvatar engine — canvas-based living entity with 12 topological variants.
//
// Each agent gets a deterministic variant from its ID hash, and the entity
// evolves with the agent's metrics:
//   signals    → size, particle count, core growth, shape emergence
//   accuracy   → brightness (glow, particle alpha, core intensity)
//   uniqueness → nova event rate (matter pulses from deep space)
//   impact     → rotation speed, trail length, core glow radius
//
// Metrics compound with experience — an elder who earned 70% accuracy
// shines brighter than a newborn who just happens to have 70%.
//
// Variants (12):
//   0  Spiral Galaxy   — 2 curved arms
//   1  Saturn Ring     — single dense belt
//   2  Triple Belt     — 3 distinct orbital rings
//   3  Binary Cores    — 2 counter-rotating clusters
//   4  Chaotic Swarm   — random eccentric tilted orbits
//   5  Pulsar Jets     — 2 opposing beam cones + faint disk
//   6  Nebula Cloud    — diffuse non-orbital cloud
//   7  Cometary Tail   — asymmetric elongated tail
//   8  Gyroscope       — 3 tilted orthogonal orbital planes
//   9  Maelstrom       — inward-spiraling sink
//   10 Ouroboros       — flowing ring with directional current
//   11 Double Helix    — 2 intertwining strands

function avHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

class AvRNG {
  private s: number;
  constructor(seed: number) { this.s = seed; }
  next(): number {
    this.s = (this.s * 1103515245 + 12345) & 0x7fffffff;
    return (this.s % 10000) / 10000;
  }
  range(a: number, b: number): number { return a + this.next() * (b - a); }
}

function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

// Maps 0-5000 signals → 0-1.4 for size/complexity.
// Power 0.55 curve against 2000-base so 600 already feels substantial.
//   50 → 0.13   (newborn)
//   200 → 0.31  (fledgling)
//   600 → 0.55  (adolescent)
//   1000 → 0.71 (mature)
//   2000 → 1.0  (elder)
//   5000 → 1.40 (ascended, capped)
function expTier(signals: number): number {
  const s = Math.max(0, signals);
  return Math.min(1.4, Math.pow(s / 2000, 0.55));
}

interface Particle {
  baseRadius: number;
  angle: number;
  angularVelocity: number;
  size: number;
  brightness: number;
  wobblePhase: number;
  wobbleSpeed: number;
  ellipX: number;
  ellipY: number;
  orbitTilt: number;
  binaryCore: number;
  chaosX: number;
  chaosY: number;
  chaosDriftPhase: number;
  chaosDriftSpeed: number;
  // Variant-specific fields
  jetSide?: number;
  jetProgress?: number;
  jetSpread?: number;
  jetSpeed?: number;
  isDisk?: boolean;
  isNebula?: boolean;
  driftAngle?: number;
  driftSpeed?: number;
  driftPhase?: number;
  isComet?: boolean;
  cometTailDist?: number;
  cometPerp?: number;
  cometT?: number;
  gyroPlane?: number;
  gyroTilt?: number;
  gyroAxis?: 'x' | 'y' | 'z';
  isMaelstrom?: boolean;
  ouroT?: number;
  isHelix?: boolean;
  helixStrand?: number;
  helixT?: number;
  helixSpeed?: number;
  _fadeMul?: number;
}

interface BinaryCenter { x: number; y: number; }

export class VortexEngine {
  private ctx: CanvasRenderingContext2D;
  private size: number;
  private accuracy: number;
  private uniqueness: number;
  private impact: number;
  private colorHex: string;
  private time = 0;

  public variant: number;
  private scale: number;
  private exp: number;
  private particles: Particle[] = [];
  private baseRotation: number;

  // Variant-specific state
  private armSeeds?: number[];
  private binaryCenters?: BinaryCenter[];
  private jetAxis?: number;
  private tailAngle?: number;

  constructor(
    canvas: HTMLCanvasElement,
    agentId: string,
    signals: number,
    accuracy: number,
    uniqueness: number,
    colorHex: string,
    impact = 0.5,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    this.ctx = ctx;
    this.size = canvas.width / 2;
    this.accuracy = Math.max(0, Math.min(1, accuracy));
    this.uniqueness = Math.max(0, Math.min(1, uniqueness));
    this.impact = Math.max(0, Math.min(1, impact));
    this.colorHex = colorHex;

    const hash = avHash(agentId);
    this.variant = hash % 12;
    const rng = new AvRNG(hash);
    const exp = expTier(signals);
    this.exp = exp;
    this.scale = 0.2 + exp * 0.95;

    const baseParticleCount = Math.max(3, Math.round(4 + exp * 180));

    this._buildVariant(rng, baseParticleCount);
    this.baseRotation = rng.next() * Math.PI * 2;
  }

  private _buildVariant(rng: AvRNG, baseParticleCount: number): void {
    const variant = this.variant;

    if (variant === 0) {
      // Spiral Galaxy
      const armCount = 2;
      this.armSeeds = [];
      for (let a = 0; a < armCount; a++) {
        this.armSeeds.push(rng.next() * Math.PI * 2);
      }
      for (let i = 0; i < baseParticleCount; i++) {
        const armIdx = i % armCount;
        const t = rng.next();
        const armAngle = this.armSeeds[armIdx] + t * Math.PI * 2.4;
        const jitter = rng.range(-0.04, 0.04) * Math.PI * 2;
        const finalAngle = armAngle + jitter;
        const radius = (0.08 + t * 0.38) * this.size * this.scale;
        this.particles.push(this._mkParticle(rng, radius, finalAngle, 1, 1));
      }
    } else if (variant === 1) {
      // Saturn Ring
      for (let i = 0; i < baseParticleCount; i++) {
        const radius = rng.range(0.34, 0.42) * this.size * this.scale;
        const angle = rng.next() * Math.PI * 2;
        this.particles.push(this._mkParticle(rng, radius, angle, 1, 1));
      }
    } else if (variant === 2) {
      // Triple Belt
      const belts = [0.16, 0.28, 0.42];
      for (let i = 0; i < baseParticleCount; i++) {
        const beltIdx = i % 3;
        const radius = (belts[beltIdx] + rng.range(-0.015, 0.015)) * this.size * this.scale;
        const angle = rng.next() * Math.PI * 2;
        this.particles.push(this._mkParticle(rng, radius, angle, 1, 1));
      }
    } else if (variant === 3) {
      // Binary Cores
      const sep = 0.18 * this.size * this.scale;
      this.binaryCenters = [
        { x: -sep, y: 0 },
        { x: sep, y: 0 },
      ];
      for (let i = 0; i < baseParticleCount; i++) {
        const coreIdx = i % 2;
        const radius = rng.range(0.04, 0.22) * this.size * this.scale;
        const angle = rng.next() * Math.PI * 2;
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.binaryCore = coreIdx;
        p.angularVelocity *= (coreIdx === 0 ? 1 : -1);
        this.particles.push(p);
      }
    } else if (variant === 4) {
      // Chaotic Swarm
      for (let i = 0; i < baseParticleCount; i++) {
        const radius = rng.range(0.05, 0.32) * this.size * this.scale;
        const angle = rng.next() * Math.PI * 2;
        const ellipX = rng.range(0.7, 1.3);
        const ellipY = rng.range(0.7, 1.3);
        const p = this._mkParticle(rng, radius, angle, ellipX, ellipY);
        p.orbitTilt = rng.range(0, Math.PI);
        this.particles.push(p);
      }
    } else if (variant === 5) {
      // Pulsar Jets
      this.jetAxis = rng.next() * Math.PI * 2;
      const jetCount = Math.floor(baseParticleCount * 0.7);
      const diskCount = baseParticleCount - jetCount;
      for (let i = 0; i < jetCount; i++) {
        const side = i % 2 === 0 ? 1 : -1;
        const progress = rng.next();
        const spread = rng.range(-0.18, 0.18);
        const p = this._mkParticle(rng, progress * 0.44 * this.size * this.scale, 0, 1, 1);
        p.jetSide = side;
        p.jetProgress = progress;
        p.jetSpread = spread;
        p.jetSpeed = rng.range(0.15, 0.35) * 0.001;
        p.size = rng.range(0.6, 1.4);
        this.particles.push(p);
      }
      for (let i = 0; i < diskCount; i++) {
        const radius = rng.range(0.35, 0.42) * this.size * this.scale;
        const angle = rng.next() * Math.PI * 2;
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.isDisk = true;
        p.brightness *= 0.35;
        this.particles.push(p);
      }
    } else if (variant === 6) {
      // Nebula Cloud
      for (let i = 0; i < baseParticleCount; i++) {
        const angle = rng.next() * Math.PI * 2;
        const radius = rng.range(0.05, 0.45) * this.size * this.scale;
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.isNebula = true;
        p.driftAngle = rng.next() * Math.PI * 2;
        p.driftSpeed = rng.range(0.0006, 0.0014);
        p.driftPhase = rng.next() * Math.PI * 2;
        p.size = rng.range(0.8, 2.2);
        p.brightness *= 0.6;
        this.particles.push(p);
      }
    } else if (variant === 7) {
      // Cometary Tail
      this.tailAngle = rng.next() * Math.PI * 2;
      const headR = 0.1 * this.size * this.scale;
      const headCount = Math.floor(baseParticleCount * 0.3);
      for (let i = 0; i < headCount; i++) {
        const radius = rng.range(0, headR);
        const angle = rng.next() * Math.PI * 2;
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.size = rng.range(0.8, 1.8);
        this.particles.push(p);
      }
      const tailCount = baseParticleCount - headCount;
      for (let i = 0; i < tailCount; i++) {
        const t = rng.next();
        const tailDist = headR + t * 0.26 * this.size * this.scale;
        const perpSpread = (1 - t * 0.5) * rng.range(-0.05, 0.05) * this.size * this.scale;
        const p = this._mkParticle(rng, 0, 0, 1, 1);
        p.isComet = true;
        p.cometTailDist = tailDist;
        p.cometPerp = perpSpread;
        p.cometT = t;
        p.brightness *= (1 - t * 0.6);
        p.size = (1 - t * 0.5) * rng.range(0.6, 1.2);
        this.particles.push(p);
      }
    } else if (variant === 8) {
      // Gyroscope
      for (let i = 0; i < baseParticleCount; i++) {
        const planeIdx = i % 3;
        const radius = rng.range(0.3, 0.42) * this.size * this.scale;
        const angle = rng.next() * Math.PI * 2;
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.gyroPlane = planeIdx;
        p.gyroAxis = planeIdx === 0 ? 'z' : planeIdx === 1 ? 'x' : 'y';
        this.particles.push(p);
      }
    } else if (variant === 9) {
      // Maelstrom
      for (let i = 0; i < baseParticleCount; i++) {
        const radius = rng.range(0.06, 0.42) * this.size * this.scale;
        const spiralTightness = 4;
        const angle = (radius / (0.42 * this.size * this.scale)) * spiralTightness * Math.PI + rng.range(-0.2, 0.2);
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.isMaelstrom = true;
        this.particles.push(p);
      }
    } else if (variant === 10) {
      // Ouroboros
      for (let i = 0; i < baseParticleCount; i++) {
        const t = i / baseParticleCount;
        const radius = rng.range(0.35, 0.40) * this.size * this.scale;
        const angle = t * Math.PI * 2 + rng.range(-0.03, 0.03);
        const p = this._mkParticle(rng, radius, angle, 1, 1);
        p.ouroT = t;
        this.particles.push(p);
      }
    } else {
      // Double Helix (variant 11)
      for (let i = 0; i < baseParticleCount; i++) {
        const strandIdx = i % 2;
        const t = rng.next();
        const p = this._mkParticle(rng, 0, 0, 1, 1);
        p.isHelix = true;
        p.helixStrand = strandIdx;
        p.helixT = t;
        p.helixSpeed = rng.range(0.3, 0.6) * 0.001;
        this.particles.push(p);
      }
    }
  }

  private _mkParticle(rng: AvRNG, radius: number, angle: number, ellipX: number, ellipY: number): Particle {
    const baseVelocity = 0.0008 + (0.42 * this.size - radius) * 0.00004;
    const chaosAngle = rng.next() * Math.PI * 2;
    const chaosRadius = rng.range(0.05, 0.3) * this.size;
    return {
      baseRadius: radius,
      angle,
      angularVelocity: baseVelocity * (rng.next() > 0.5 ? 1 : 0.85),
      size: rng.range(0.5, 1.8),
      brightness: rng.range(0.4, 1),
      wobblePhase: rng.next() * Math.PI * 2,
      wobbleSpeed: rng.range(0.5, 1.2),
      ellipX,
      ellipY,
      orbitTilt: 0,
      binaryCore: 0,
      chaosX: Math.cos(chaosAngle) * chaosRadius,
      chaosY: Math.sin(chaosAngle) * chaosRadius,
      chaosDriftPhase: rng.next() * Math.PI * 2,
      chaosDriftSpeed: rng.range(0.0003, 0.0008),
    };
  }

  update(dt: number): void {
    this.time += dt;
  }

  draw(): void {
    const { ctx, size, time, accuracy, uniqueness, impact, colorHex, variant } = this;
    const cx = size / 2;
    const cy = size / 2;
    ctx.clearRect(0, 0, size, size);

    // Metric compounding with experience
    const experienceMul = 0.4 + this.exp * 0.6;
    const effectiveAcc = accuracy * experienceMul;
    const effectiveUniq = uniqueness * experienceMul;
    const effectiveImp = impact * experienceMul;

    const brightMul = 0.2 + effectiveAcc * 0.8;
    const rotMul = 0.3 + effectiveImp * 1.9;
    const novaRate = effectiveUniq;

    // Structure factor — shape emerges with experience
    const structureFactor = Math.min(1, Math.max(0, (this.exp - 0.15) * 1.8));
    const chaosFactor = 1 - structureFactor;

    // Background — subtle event horizon tint
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.45);
    bg.addColorStop(0, rgba(colorHex, 0.05 * brightMul));
    bg.addColorStop(0.4, rgba(colorHex, 0.015));
    bg.addColorStop(1, 'transparent');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // Spiral arm guide curves (variant 0 only)
    if (variant === 0 && this.armSeeds) {
      const globalRot = time * 0.0005 * rotMul;
      for (const armSeed of this.armSeeds) {
        const baseA = armSeed + globalRot;
        ctx.beginPath();
        for (let t = 0; t < 1; t += 0.02) {
          const a = baseA + t * Math.PI * 2.4;
          const r = (0.08 + t * 0.38) * size * this.scale;
          const x = cx + Math.cos(a) * r;
          const y = cy + Math.sin(a) * r;
          if (t === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba(colorHex, 0.12 * brightMul);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Particles
    for (const p of this.particles) {
      const rWobble = Math.sin(time * p.wobbleSpeed * 0.001 + p.wobblePhase) * 1.2;
      const r = p.baseRadius + rWobble;
      const a = p.angle + time * p.angularVelocity * rotMul;

      let x: number;
      let y: number;

      if (variant === 3 && this.binaryCenters) {
        const bc = this.binaryCenters[p.binaryCore];
        x = cx + bc.x + Math.cos(a) * r;
        y = cy + bc.y + Math.sin(a) * r;
      } else if (variant === 4) {
        const tiltCos = Math.cos(p.orbitTilt);
        const tiltSin = Math.sin(p.orbitTilt);
        const localX = Math.cos(a) * r * p.ellipX;
        const localY = Math.sin(a) * r * p.ellipY;
        x = cx + localX * tiltCos - localY * tiltSin;
        y = cy + localX * tiltSin + localY * tiltCos;
      } else if (variant === 5 && p.jetSide !== undefined && !p.isDisk && this.jetAxis !== undefined) {
        const jetTravel = ((p.jetProgress! + time * p.jetSpeed! * rotMul) % 1);
        const dist = jetTravel * 0.44 * size * this.scale;
        const perpAngle = this.jetAxis + Math.PI / 2;
        x = cx + Math.cos(this.jetAxis) * dist * p.jetSide + Math.cos(perpAngle) * p.jetSpread! * dist;
        y = cy + Math.sin(this.jetAxis) * dist * p.jetSide + Math.sin(perpAngle) * p.jetSpread! * dist;
        p._fadeMul = Math.sin(jetTravel * Math.PI) * 0.9 + 0.1;
      } else if (variant === 6 && p.isNebula) {
        const drift = time * p.driftSpeed! * rotMul;
        const wiggle = Math.sin(drift + p.driftPhase!) * 2;
        x = cx + Math.cos(p.angle + drift * 0.3) * r + Math.cos(p.driftAngle!) * wiggle;
        y = cy + Math.sin(p.angle + drift * 0.3) * r + Math.sin(p.driftAngle!) * wiggle;
      } else if (variant === 7 && p.isComet && this.tailAngle !== undefined) {
        const tailFlow = ((p.cometT! + time * 0.0003 * rotMul) % 1);
        const dist = p.cometTailDist! + tailFlow * 0.06 * size * this.scale;
        const perpAngle = this.tailAngle + Math.PI / 2;
        x = cx + Math.cos(this.tailAngle) * dist + Math.cos(perpAngle) * p.cometPerp!;
        y = cy + Math.sin(this.tailAngle) * dist + Math.sin(perpAngle) * p.cometPerp!;
      } else if (variant === 8 && p.gyroAxis) {
        const planeRot = time * 0.0001 * rotMul;
        if (p.gyroAxis === 'z') {
          x = cx + Math.cos(a) * r;
          y = cy + Math.sin(a) * r * 0.3;
        } else if (p.gyroAxis === 'x') {
          x = cx + Math.cos(a) * r * 0.3 + Math.sin(planeRot) * r * 0.1;
          y = cy + Math.sin(a) * r;
        } else {
          x = cx + Math.sin(a + planeRot) * r * 0.6;
          y = cy + Math.cos(a + planeRot) * r * 0.8;
        }
      } else if (variant === 9) {
        const sink = ((time * 0.0005 * rotMul + p.wobblePhase) % 1);
        const currentR = r * (1 - sink * 0.85);
        x = cx + Math.cos(a) * currentR;
        y = cy + Math.sin(a) * currentR;
        p._fadeMul = 1 - sink;
      } else if (variant === 10 && p.ouroT !== undefined) {
        const flowT = (p.ouroT + time * 0.0003 * rotMul) % 1;
        const flowAngle = flowT * Math.PI * 2;
        x = cx + Math.cos(flowAngle) * r;
        y = cy + Math.sin(flowAngle) * r;
        const headProximity = Math.cos(flowT * Math.PI * 2) * 0.5 + 0.5;
        p._fadeMul = 0.3 + headProximity * 0.9;
      } else if (variant === 11 && p.helixT !== undefined) {
        const helixT = (p.helixT + time * p.helixSpeed! * rotMul) % 1;
        const yPos = (helixT - 0.5) * 0.65 * size * this.scale;
        const phaseOffset = p.helixStrand === 0 ? 0 : Math.PI;
        const xAmp = 0.15 * size * this.scale;
        const xPos = Math.sin(helixT * Math.PI * 3 + phaseOffset) * xAmp;
        x = cx + xPos;
        y = cy + yPos;
        p._fadeMul = 0.4 + (Math.cos(helixT * Math.PI * 3 + phaseOffset) + 1) / 2 * 0.6;
      } else {
        x = cx + Math.cos(a) * r * p.ellipX;
        y = cy + Math.sin(a) * r * p.ellipY;
      }

      // Chaos → structure blend
      if (chaosFactor > 0.01) {
        const drift = time * p.chaosDriftSpeed;
        const driftX = Math.cos(drift + p.chaosDriftPhase) * 2;
        const driftY = Math.sin(drift * 1.13 + p.chaosDriftPhase) * 2;
        const chaosX = cx + p.chaosX + driftX;
        const chaosY = cy + p.chaosY + driftY;
        x = chaosX * chaosFactor + x * structureFactor;
        y = chaosY * chaosFactor + y * structureFactor;
      }

      const fadeMul = p._fadeMul !== undefined ? p._fadeMul : 1;

      // Motion trail — only for orbital variants when structure is mostly formed
      if (variant <= 4 && structureFactor > 0.5) {
        const trailSteps = 2 + Math.floor(impact * 3);
        for (let ts = 0; ts < trailSteps; ts++) {
          const backStep = p.angularVelocity * rotMul * (ts + 1) * 80;
          const ta = a - backStep;
          let tx: number;
          let ty: number;
          if (variant === 3 && this.binaryCenters) {
            const bc = this.binaryCenters[p.binaryCore];
            tx = cx + bc.x + Math.cos(ta) * r;
            ty = cy + bc.y + Math.sin(ta) * r;
          } else if (variant === 4) {
            const tiltCos = Math.cos(p.orbitTilt);
            const tiltSin = Math.sin(p.orbitTilt);
            const lx = Math.cos(ta) * r * p.ellipX;
            const ly = Math.sin(ta) * r * p.ellipY;
            tx = cx + lx * tiltCos - ly * tiltSin;
            ty = cy + lx * tiltSin + ly * tiltCos;
          } else {
            tx = cx + Math.cos(ta) * r * p.ellipX;
            ty = cy + Math.sin(ta) * r * p.ellipY;
          }
          const trailAlpha = (1 - ts / trailSteps) * 0.3 * p.brightness * brightMul * structureFactor;
          ctx.beginPath();
          ctx.arc(tx, ty, p.size * (1 - ts * 0.25), 0, Math.PI * 2);
          ctx.fillStyle = rgba(colorHex, trailAlpha);
          ctx.fill();
        }
      } else if (variant === 6 && p.isNebula) {
        // Nebula — soft glow halo per particle
        const haloR = p.size * 3;
        const halo = ctx.createRadialGradient(x, y, 0, x, y, haloR);
        halo.addColorStop(0, rgba(colorHex, p.brightness * brightMul * 0.4));
        halo.addColorStop(1, 'transparent');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, haloR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Head
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = rgba(colorHex, p.brightness * brightMul * fadeMul);
      ctx.fill();
    }

    // Uniqueness → nova events
    if (novaRate > 0.05) {
      const novaCount = 3;
      for (let i = 0; i < novaCount; i++) {
        const phase = (time * 0.0007 * novaRate + i * 0.33) % 1;
        if (phase > 0.5) continue;
        const startAngle = (i * 1.618 * Math.PI + time * 0.0001) % (Math.PI * 2);
        const startR = size * 0.5 * (1 - phase * 1.6);
        if (startR < 3) continue;
        const nx = cx + Math.cos(startAngle) * startR;
        const ny = cy + Math.sin(startAngle) * startR;
        const alpha = phase < 0.2 ? phase / 0.2 : 1 - (phase - 0.2) / 0.3;
        const r = 5 + (1 - phase) * 4;
        const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, r);
        g.addColorStop(0, rgba('#ffffff', alpha * 0.95));
        g.addColorStop(0.3, rgba(colorHex, alpha * 0.7));
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(nx, ny, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Central singularity (skipped for binary variant)
    if (variant !== 3) {
      const pulse = 0.9 + 0.1 * Math.sin(time * 0.003);
      const coreR = (1 + this.exp * 9 + accuracy * 2) * this.scale;
      const glow = Math.min(coreR * (3 + impact * 2), size * 0.4);
      const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glow);
      coreGrad.addColorStop(0, rgba('#ffffff', 0.95 * pulse * brightMul));
      coreGrad.addColorStop(0.2, rgba(colorHex, 0.75 * pulse * brightMul));
      coreGrad.addColorStop(0.5, rgba(colorHex, 0.2 * brightMul));
      coreGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = coreGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, glow, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, coreR * pulse, 0, Math.PI * 2);
      ctx.fillStyle = rgba('#ffffff', 0.95);
      ctx.fill();
    } else if (this.binaryCenters) {
      for (const bc of this.binaryCenters) {
        const x = cx + bc.x;
        const y = cy + bc.y;
        const coreR = (0.8 + this.exp * 5 + accuracy * 1.5) * this.scale;
        const glow = Math.min(coreR * 3.5, size * 0.22);
        const g = ctx.createRadialGradient(x, y, 0, x, y, glow);
        g.addColorStop(0, rgba('#ffffff', 0.9 * brightMul));
        g.addColorStop(0.3, rgba(colorHex, 0.6 * brightMul));
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, glow, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, coreR, 0, Math.PI * 2);
        ctx.fillStyle = rgba('#ffffff', 0.9);
        ctx.fill();
      }
    }
  }
}
