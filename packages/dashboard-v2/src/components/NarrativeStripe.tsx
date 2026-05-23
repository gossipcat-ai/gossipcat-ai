import { useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { DashboardEvent } from '@/lib/types';

/** Auto-hide after 60s if consensus_complete never arrives. */
const STRIPE_TIMEOUT_MS = 60_000;

/**
 * Thin live-update stripe — visible only when a consensus round is in
 * flight. Pulses at 2×beat (3.2s). Subscribes to the existing dashboard
 * WebSocket; tracks task_dispatched → consensus_complete pairs.
 *
 * Per Phase 1b spec §"NarrativeStripe": this is a presence indicator,
 * not a detail view. Click "watch" scrolls the consensus rounds section
 * into view (a real per-round drill-in is deferred).
 */
export function NarrativeStripe() {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const clear = () => {
    setActiveTaskId(null);
    setActiveAgentId(null);
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useWebSocket((event: DashboardEvent) => {
    if (event.type === 'task_dispatched') {
      setActiveTaskId(event.taskId);
      setActiveAgentId(event.agentId);
      if (timeoutRef.current != null) window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(clear, STRIPE_TIMEOUT_MS) as unknown as number;
      return;
    }
    if (event.type === 'consensus_complete' || event.type === 'task_completed' || event.type === 'task_failed') {
      if (event.type !== 'consensus_complete' && (event as { taskId?: string }).taskId !== activeTaskId) return;
      clear();
    }
  });

  useEffect(() => () => clear(), []);

  if (activeTaskId === null) return null;
  const shortId = activeTaskId.slice(0, 8);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 rounded-md border px-3 py-2 font-mono text-[11px]"
      style={{
        background: 'color-mix(in oklch, var(--accent) 8%, transparent)',
        borderColor: 'color-mix(in oklch, var(--accent) 30%, transparent)',
        color: 'var(--text)',
        animation: 'beat-pulse-narrative calc(var(--beat) * 2) ease-in-out infinite',
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }}
      />
      <span style={{ color: 'var(--text-dim)' }}>Round in flight</span>
      <span className="font-bold" style={{ color: 'var(--accent)' }}>{shortId}</span>
      {activeAgentId && (
        <span style={{ color: 'var(--text-dim)' }}>
          → <span style={{ color: 'var(--text)' }}>{activeAgentId}</span>
        </span>
      )}
      <span className="ml-auto" style={{ color: 'var(--text-faint)' }}>live</span>

      <style>{`
        @keyframes beat-pulse-narrative {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.72; }
        }
      `}</style>
    </div>
  );
}
