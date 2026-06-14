import { useCallback, useEffect, useState } from 'react';
import { useEventStream, type DashboardEvent } from '@/lib/useEventStream';
import { StatusDot } from '@/components/chat/ChatPrimitives';
import { ActivitySparkline } from '@/components/chat/ActivitySparkline';
import { SignalsByAgent } from '@/components/chat/SignalsByAgent';
import type { UseBridgeResult } from '@/lib/useBridge';
import type { SignalActivityResponse } from '@/lib/types';
import { api } from '@/lib/api';

/**
 * SessionRail — right-side rail for ChatPage operator command surface.
 *
 * Shows:
 *  1. Connection — StatusDot (live/connecting/offline/error) + chat_id in
 *     font-mono + one-liner copy.
 *  2. Session info (from /dashboard/api/session):
 *     - Working dir: `projectName · branch` (conditional — only when gitBranch
 *       is a non-empty string; absent on old relays or detached HEAD).
 *     - Tasks: active task count (always shown, 0 is fine).
 *  3. Activity feed — last ~6 SSE DashboardEvents (task.completed /
 *     consensus.completed) via useEventStream with mono timestamps.
 *     Empty state: "no recent activity" when stream is empty.
 *
 * DATA SOURCES (no fabricated data):
 *  - status, chatId     → passed from useBridgeContext() in ChatPage
 *  - gitBranch, projectName, activeTasks → GET /dashboard/api/session (fetch
 *    once on mount; graceful degradation on failure / 404 / old relay)
 *  - events             → useEventStream (SSE /dashboard/api/events)
 *
 * DESIGN.md conformance:
 *  - .h-section small-caps Geist section labels ("session", "activity")
 *  - hairline --border card; --surface-elev background; --r-lg radius
 *  - StatusDot semantic colors (--ok/--warn/--bad/--idle)
 *  - font-mono for chat_id, branch, counts (JetBrains Mono via --font-mono)
 *  - --ink-3 / --ink-4 for secondary / decorative text
 *  - prefers-reduced-motion honored by StatusDot animate-pulse
 *  - No --accent in the rail (owned by ChatPage's Send button)
 *  - No new colors, shadows, or fonts beyond DESIGN.md spec
 */

const MAX_EVENTS = 6;

interface SessionInfo {
  gitBranch: string | null;
  projectName: string | null;
  activeTasks: number;
}

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
  const [session, setSession] = useState<SessionInfo>({
    gitBranch: null,
    projectName: null,
    activeTasks: 0,
  });
  // null = loading/failed (omit row); number = real data (show even if 0).
  const [signalTotal, setSignalTotal] = useState<number | null>(null);
  // null = loading/failed; [] = no agents (graceful). Retained from same fetch as signalTotal.
  const [signalAgents, setSignalAgents] = useState<SignalActivityResponse['agents'] | null>(null);

  // Fetch session info once on mount. Gracefully degrades on any error
  // (network failure, 404 from old relay, missing git). The branch row is
  // conditionally rendered only when gitBranch is a non-empty string.
  useEffect(() => {
    const controller = new AbortController();
    api<{ gitBranch: string | null; projectName: string; activeTasks: number }>(
      'dashboard/api/session',
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        setSession({
          gitBranch: data.gitBranch ?? null,
          projectName: data.projectName ?? null,
          activeTasks: typeof data.activeTasks === 'number' ? data.activeTasks : 0,
        });
      })
      .catch(() => {
        // Intentionally silenced — old relay (no endpoint) or network error;
        // defaults (null/0) keep the rail usable.
      });
    return () => controller.abort();
  }, []);

  // Fetch 24h signal activity once on mount. Omit row on any failure.
  useEffect(() => {
    const controller = new AbortController();
    api<SignalActivityResponse>('signal-activity')
      .then((data) => {
        if (controller.signal.aborted) return;
        // total:0 is valid data — show "0 · 24h". Only omit on fetch failure.
        if (typeof data.total === 'number') {
          setSignalTotal(data.total);
          // Retain agents array for per-agent breakdown (same fetch, no second call).
          setSignalAgents(Array.isArray(data.agents) ? data.agents : []);
        }
      })
      .catch(() => {
        // Silenced — graceful degradation: row is omitted (signalTotal stays null).
      });
    return () => controller.abort();
  }, []);

  const onEvent = useCallback((e: DashboardEvent) => {
    setEvents((prev) => {
      // Prepend new event, keep the most recent MAX_EVENTS.
      const next = [e, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEventStream(onEvent);

  const showWorkingDir =
    typeof session.gitBranch === 'string' && session.gitBranch.length > 0;

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
      {/* ── Section 1: Session ── */}
      <section>
        <h2
          className="h-section"
          style={{ marginBottom: '12px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}
        >
          session
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {/* Status dot */}
          <StatusDot status={status} compact={false} />

          {/* chat_id */}
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

          {/* Working dir — only when gitBranch resolved (non-null, non-empty) */}
          {showWorkingDir && (
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
              title="directory the gossipcat relay was launched in (worktree dispatches may differ)"
            >
              <span
                className="text-[11px]"
                style={{ color: 'var(--ink-4)', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
              >
                working dir
              </span>
              <span
                className="font-mono text-[11px]"
                style={{ color: 'var(--ink-3)', wordBreak: 'break-all' }}
              >
                {session.projectName} · {session.gitBranch}
              </span>
            </div>
          )}

          {/* Active tasks — always shown */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
            <span
              className="text-[11px]"
              style={{ color: 'var(--ink-4)', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
            >
              tasks
            </span>
            <span
              className="font-mono text-[11px]"
              style={{ color: 'var(--ink-3)' }}
            >
              {session.activeTasks} active
            </span>
          </div>

          {/* 24h signal count + per-agent breakdown — only rendered when endpoint returned valid data */}
          {signalTotal !== null && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                <span
                  className="text-[11px]"
                  style={{ color: 'var(--ink-4)', fontVariant: 'small-caps', letterSpacing: '0.04em' }}
                >
                  signals
                </span>
                <span
                  className="font-mono text-[11px]"
                  style={{ color: 'var(--ink-3)' }}
                >
                  {signalTotal} · 24h
                </span>
              </div>
              {/* Per-agent breakdown — uses same fetched data, no second network call */}
              {signalAgents !== null && signalAgents.length > 0 && (
                <SignalsByAgent agents={signalAgents} />
              )}
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

        {/* Fleet signal-volume sparkline (7d). Renders only when ≥2 data points. */}
        <ActivitySparkline />

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
