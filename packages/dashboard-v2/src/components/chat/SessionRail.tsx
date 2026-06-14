import { useCallback, useState } from 'react';
import { useEventStream, type DashboardEvent } from '@/lib/useEventStream';
import { StatusDot } from '@/components/chat/ChatPrimitives';
import type { UseBridgeResult } from '@/lib/useBridge';

/**
 * SessionRail — right-side rail for ChatPage operator command surface.
 *
 * Shows:
 *  1. Connection — StatusDot (live/connecting/offline/error) + chat_id in
 *     font-mono + one-liner copy.
 *  2. Activity feed — last ~6 SSE DashboardEvents (task.completed /
 *     consensus.completed) via useEventStream with mono timestamps.
 *     Empty state: "no recent activity" when stream is empty.
 *
 * DATA SOURCES (no fabricated data, no git branch):
 *  - status, chatId  → passed from useBridgeContext() in ChatPage
 *  - events          → useEventStream (SSE /dashboard/api/events)
 *
 * DESIGN.md conformance:
 *  - .h-section small-caps Geist section labels ("session", "activity")
 *  - hairline --border card; --surface-elev background; --r-lg radius
 *  - StatusDot semantic colors (--ok/--warn/--bad/--idle)
 *  - font-mono for chat_id and timestamps (JetBrains Mono via --font-mono)
 *  - --ink-3 / --ink-4 for secondary / decorative text
 *  - prefers-reduced-motion honored by StatusDot animate-pulse
 *  - No --accent except on the Send button (owned by ChatPage)
 *  - No new colors, shadows, or fonts beyond DESIGN.md spec
 */

const MAX_EVENTS = 6;

function formatEventLabel(event: DashboardEvent): string {
  const { type, payload } = event;
  if (type === 'task.completed') {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    return agentId ? `task completed → ${agentId}` : 'task completed';
  }
  if (type === 'consensus.completed') {
    const id = typeof payload.consensusId === 'string'
      ? payload.consensusId.slice(0, 8)
      : '';
    return id ? `consensus completed ${id}` : 'consensus completed';
  }
  return type;
}

function timeShortFromTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface SessionRailProps {
  status: UseBridgeResult['status'];
  chatId: string | null;
}

export function SessionRail({ status, chatId }: SessionRailProps) {
  const [events, setEvents] = useState<DashboardEvent[]>([]);

  const onEvent = useCallback((e: DashboardEvent) => {
    setEvents((prev) => {
      // Prepend new event, keep the most recent MAX_EVENTS.
      const next = [e, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEventStream(onEvent);

  return (
    <aside
      style={{
        width: '100%',
        minWidth: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        background: 'var(--surface-elev)',
        padding: '20px',
        display: 'flex',
        flexDirection: 'column',
        gap: '20px',
        alignSelf: 'stretch',
      }}
      aria-label="Session info"
    >
      {/* ── Section 1: Connection ── */}
      <section>
        <h2
          className="h-section"
          style={{ marginBottom: '12px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}
        >
          session
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <StatusDot status={status} compact={false} />

          {chatId && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span
                className="font-mono text-[11px]"
                style={{ color: 'var(--ink-3)', wordBreak: 'break-all' }}
              >
                {chatId}
              </span>
            </div>
          )}

          <p
            className="text-[12px]"
            style={{ color: 'var(--ink-3)', lineHeight: 1.5, margin: 0 }}
          >
            Same Claude Code session as your terminal.
          </p>
        </div>
      </section>

      {/* ── Section 2: Activity feed ── */}
      <section style={{ flex: 1, minHeight: 0 }}>
        <h2
          className="h-section"
          style={{ marginBottom: '12px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}
        >
          activity
        </h2>

        {events.length === 0 ? (
          <p
            className="text-[12px]"
            style={{ color: 'var(--ink-3)', margin: 0 }}
          >
            no recent activity
          </p>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            {events.map((e) => (
              <li
                key={e.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '2px',
                }}
              >
                <span
                  className="text-[12px]"
                  style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}
                >
                  {formatEventLabel(e)}
                </span>
                <span
                  className="font-mono text-[10px]"
                  style={{ color: 'var(--ink-4)' }}
                  aria-hidden
                >
                  {timeShortFromTs(e.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
