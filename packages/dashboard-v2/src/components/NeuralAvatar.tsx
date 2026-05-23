import { useEffect, useRef } from 'react';
import { VortexEngine } from '@/lib/vortex-engine';
import { agentColor } from '@/lib/utils';
import { subscribe } from '@/lib/animation-scheduler';

interface NeuralAvatarProps {
  agentId: string;
  size?: number;
  /** When false, the vortex is rendered once and then frozen — used by offline agents.
   *  Defaults to true. Toggling at runtime resumes/pauses the per-frame draw. */
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
  animate = true,
  signals = 0,
  accuracy = 0.5,
  uniqueness = 0.5,
  impact = 0.5,
}: NeuralAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<VortexEngine | null>(null);
  const visibleRef = useRef(true);
  const animateRef = useRef(animate);
  // Mirror the prop into the ref so the subscriber closure (captured below)
  // sees fresh values without re-subscribing on every prop toggle.
  animateRef.current = animate;

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

    const unsubscribe = subscribe((deltaMs) => {
      if (visibleRef.current && animateRef.current) {
        engine.update(deltaMs);
        engine.draw();
      }
    });

    return () => {
      unsubscribe();
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
