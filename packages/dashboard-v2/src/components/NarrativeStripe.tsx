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
    // Narrow via discriminated union — all three terminal variants in
    // DashboardEvent expose `taskId`, so no cast is needed.
    if (event.type === 'consensus_complete' || event.type === 'task_completed' || event.type === 'task_failed') {
      if (event.taskId !== activeTaskId) return;
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
        background: 'color-mix(in oklch, var(--info) 8%, transparent)',
        borderColor: 'color-mix(in oklch, var(--info) 30%, transparent)',
        color: 'var(--text)',
        animation: 'beat-pulse-narrative calc(var(--beat) * 2) ease-in-out infinite',
      }}
    >
      <span
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: 'var(--info)', boxShadow: '0 0 6px var(--info)' }}
      />
      <span style={{ color: 'var(--text-dim)' }}>Round in flight</span>
      <span className="font-bold" style={{ color: 'var(--info)' }}>{shortId}</span>
      {activeAgentId && (
        <span style={{ color: 'var(--text-dim)' }}>
          → <span style={{ color: 'var(--text)' }}>{activeAgentId}</span>
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          // Scroll the consensus rounds section into view if it exists.
          // The actual per-round drill-in is deferred to a future PR.
          const el = document.getElementById('consensus-rounds-section');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
        className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] transition hover:[background:color-mix(in_oklch,var(--info)_12%,transparent)]"
        style={{ color: 'var(--text-faint)', cursor: 'pointer' }}
      >
        watch ↓
      </button>
    </div>
  );
}
