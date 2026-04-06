import { useEffect, useRef } from 'react';
import { VortexEngine } from '@/lib/vortex-engine';
import { agentColor } from '@/lib/utils';

interface NeuralAvatarProps {
  agentId: string;
  size?: number;
  /** Accepted but ignored — avatars always animate now. Kept for backwards-compat with callers. */
  animate?: boolean;
  /** Raw signal count (0-5000+). Controls size + complexity + shape emergence. */
  signals?: number;
  /** 0-1: controls brightness */
  accuracy?: number;
  /** 0-1: controls nova event rate */
  uniqueness?: number;
  /** 0-1: controls rotation speed + trail length */
  impact?: number;
}

export function NeuralAvatar({
  agentId,
  size = 64,
  signals = 0,
  accuracy = 0.5,
  uniqueness = 0.5,
  impact = 0.5,
}: NeuralAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<VortexEngine | null>(null);
  const rafRef = useRef<number>(0);
  const visibleRef = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = size * 2;
    canvas.height = size * 2;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(2, 2);

    const color = agentColor(agentId);
    const engine = new VortexEngine(canvas, agentId, signals, accuracy, uniqueness, color, impact);
    engineRef.current = engine;
    engine.draw();

    const loop = () => {
      if (visibleRef.current) {
        engine.update(16);
        engine.draw();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      engineRef.current = null;
    };
  }, [agentId, size, signals, accuracy, uniqueness, impact]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new IntersectionObserver(
      ([entry]) => { visibleRef.current = entry.isIntersecting; },
      { threshold: 0.1 },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
      }}
    />
  );
}
