import { useEffect, useRef } from 'react';
import { OrbAvatarEngine } from '@/lib/neural-avatar';

interface NeuralAvatarProps {
  agentId: string;
  size?: number;
  animate?: boolean;
  /** 0-1: controls node count and complexity. For gossipcat: signals/200 */
  evolution?: number;
}

export function NeuralAvatar({ agentId, size = 64, animate = true, evolution = 0.15 }: NeuralAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OrbAvatarEngine | null>(null);
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

    const engine = new OrbAvatarEngine(canvas, agentId, evolution);
    engineRef.current = engine;
    engine.draw();

    // Always animate — even "offline" agents breathe, just dimmed
    const loop = () => {
      if (visibleRef.current) {
        engine.update(0.016);
        engine.draw();
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(rafRef.current);
      engineRef.current = null;
    };
  }, [agentId, size, animate, evolution]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const observer = new IntersectionObserver(
      ([entry]) => { visibleRef.current = entry.isIntersecting; },
      { threshold: 0.1 },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [animate]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="shrink-0"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        opacity: animate ? 1 : 0.4,
        transition: 'opacity 0.3s',
      }}
    />
  );
}
