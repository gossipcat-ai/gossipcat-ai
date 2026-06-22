import { useCallback, useEffect, useState } from 'react';
import { useEventStream, type DashboardEvent } from '@/lib/useEventStream';
import { StatusDot } from '@/components/chat/ChatPrimitives';
import { ActivitySparkline } from '@/components/chat/ActivitySparkline';
import { SignalsByAgent } from '@/components/chat/SignalsByAgent';
import type { UseBridgeResult } from '@/lib/useBridge';
import { api } from '@/lib/api';
import { agentColor } from '@/lib/utils';

/**
 * SessionRail — right-side rail for ChatPage.
 *
 * Sections (top → bottom, flex column, full height):
 *   1. SESSION INFO (~44px compact strip): status dot, chat_id, branch, tasks count, signals.
 *      Slim — avoids duplicating the info-bar in ChatPage.
 *   2. WORKING AGENTS (flex-none): compact cards for each active dispatch from /api/active-tasks.
 *      Per-agent identity dot (agentColor) + name + live pulse + task label truncated.
 *      Polls every 5 s — same cadence as ActiveTasksBanner.
 *      Empty: "No agents dispatched" context line.
 *   3. ACTIVITY FEED (flex:1, overflow-y:auto): scrolling list of SSE events.
 *      Compact rows: timestamp · icon · event label, 200ms ease-out enter.
 *      Empty: "No recent activity — fleet idle" (keep the frame, never blank void).
 *
 * DATA SOURCES (no fabricated data):
 *   - status, chatId      → passed from useBridgeContext() in ChatPage
 *   - gitBranch, activeTasks → GET /api/session (fetch once on mount)
 *   - signalTotal         → GET /api/signal-activity (fetch once on mount)
 *   - activeTasks list    → GET /api/active-tasks (poll 5 s)
 *   - events              → useEventStream (SSE /api/events)
 *
 * DESIGN.md conformance:
 *   - .h-section small-caps Geist section labels
 *   - hairline --border card; --r-lg radius; chat-surface dark tokens
 *   - StatusDot semantic colors (--ok/--warn/--bad/--idle)
 *   - JetBrains Mono for timestamps, IDs, counts
 *   - Per-agent identity color in dot ONLY; chrome stays neutral
 *   - Working pulse: animate-pulse + prefers-reduced-motion:animate-none
 *   - 200ms ease-out enter for activity rows
 *   - No --accent in rail (owned by ChatPage Send button)
 */

const MAX_EVENTS = 20;
const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

interface SessionInfo {
  gitBranch: string | null;
  projectName: string | null;
  activeTasks: number;
}

interface ActiveTask {
  taskId: string;
  agentId: string;
  task: string;
  startedAt: string;
}

interface AgentScoreEntry {
  id: string;
  scores: {
    agreements: number;
    uniqueFindings: number;
    hallucinations: number;
    disagreements: number;
  };
}

// ── Utility: event type → icon + label ─────────────────────────────────────

const EVENT_ICONS: Record<string, string> = {
  'task.completed': '✓',
  'consensus.completed': '◈',
};

function formatEventLabel(event: DashboardEvent): string {
  const { type, payload } = event;
  if (type === 'task.completed') {
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    return agentId ? `task · ${agentId}` : 'task completed';
  }
  if (type === 'consensus.completed') {
    const id = typeof payload.consensusId === 'string'
      ? payload.consensusId.slice(0, 8)
      : '';
    return id ? `consensus ${id}` : 'consensus done';
  }
  return type;
}

function timeShortFromTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function elapsedShort(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (ms < 0) return '0s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

// ── Working agents section ──────────────────────────────────────────────────

function WorkingAgents({ tasks }: { tasks: ActiveTask[] }) {
  const now = Date.now();
  const live = tasks.filter(
    (t) => now - new Date(t.startedAt).getTime() < STALE_MS,
  );

  return (
    <section>
      <h2
        className="h-section"
        style={{
          marginBottom: '8px',
          borderBottom: '1px solid var(--border)',
          paddingBottom: '6px',
        }}
      >
        agents
      </h2>

      {live.length === 0 ? (
        <p
          className="text-[11px]"
          style={{ color: 'var(--ink-3)', margin: 0, lineHeight: 1.5 }}
        >
          No agents dispatched — fleet idle
        </p>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          {live.map((t) => (
            <WorkingAgentRow key={t.taskId} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkingAgentRow({ task }: { task: ActiveTask }) {
  const color = agentColor(task.agentId);
  return (
    <li
      className="agent-working-row"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
        padding: '6px 8px',
        borderRadius: 'var(--r-md)',
        background: 'color-mix(in srgb, var(--surface) 30%, transparent)',
        border: '1px solid var(--border)',
        transition: 'background 100ms ease-out',
      }}
    >
      {/* Identity dot (agent color) + live pulse — ONLY identity color here */}
      <span
        className="agent-working-dot shrink-0 mt-[3px]"
        style={{ '--dot-color': color } as React.CSSProperties}
        aria-hidden
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Agent name + elapsed */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span
            className="font-mono text-[11px] font-medium truncate"
            style={{ color: 'var(--ink-2)' }}
          >
            {task.agentId}
          </span>
          <span
            className="font-mono text-[10px] shrink-0 tabular-nums"
            style={{ color: 'var(--ink-3)' }}
          >
            {elapsedShort(task.startedAt)}
          </span>
        </div>
        {/* Task label — truncated */}
        {task.task && (
          <span
            className="text-[11px] block truncate"
            style={{ color: 'var(--ink-3)', marginTop: '1px', lineHeight: 1.4 }}
            title={task.task}
          >
            {task.task}
          </span>
        )}
      </div>
    </li>
  );
}

// ── Activity feed section ───────────────────────────────────────────────────

function ActivityFeed({ events }: { events: DashboardEvent[] }) {
  return (
    <section
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
      }}
    >
      <h2
        className="h-section shrink-0"
        style={{
          borderBottom: '1px solid var(--border)',
          paddingBottom: '6px',
        }}
      >
        activity
      </h2>

      {/* design QA F7: context line sits directly under the header (not below
          the sparkline) so the empty state reads in one glance, no eye-hop. */}
      {events.length === 0 && (
        <p
          className="text-[11px] shrink-0"
          style={{ color: 'var(--ink-3)', margin: '0 0 2px', lineHeight: 1.5 }}
        >
          No recent activity — fleet idle
        </p>
      )}

      {/* Fleet signal-volume sparkline (7d). Renders only when ≥2 data points. */}
      <div className="shrink-0">
        <ActivitySparkline />
      </div>

      {events.length > 0 && (
        <ul
          aria-label="Recent activity"
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {events.map((e) => (
            <ActivityEventRow key={e.id} event={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityEventRow({ event }: { event: DashboardEvent }) {
  const icon = EVENT_ICONS[event.type] ?? '·';
  const label = formatEventLabel(event);
  const time = timeShortFromTs(event.ts);

  return (
    <li
      className="activity-event-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '4px 6px',
        borderRadius: 'var(--r-sm)',
        transition: 'background 100ms ease-out',
      }}
    >
      {/* Timestamp — mono small */}
      {time && (
        <span
          className="font-mono text-[10px] shrink-0 tabular-nums"
          style={{ color: 'var(--ink-3)' }}
          aria-hidden
        >
          {time}
        </span>
      )}
      {/* Icon */}
      <span
        className="font-mono text-[10px] shrink-0"
        style={{ color: 'var(--info)', minWidth: '10px', textAlign: 'center' }}
        aria-hidden
      >
        {icon}
      </span>
      {/* Label */}
      <span
        className="text-[11px] truncate"
        style={{ color: 'var(--ink-2)', lineHeight: 1.4 }}
      >
        {label}
      </span>
    </li>
  );
}

// ── SessionRail ─────────────────────────────────────────────────────────────

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
  const [signalTotal, setSignalTotal] = useState<number | null>(null);
  const [agentScores, setAgentScores] = useState<AgentScoreEntry[] | null>(null);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  // Tick state for elapsed timer updates
  const [, setTick] = useState(0);

  // Fetch session info once on mount.
  useEffect(() => {
    const controller = new AbortController();
    api<{ gitBranch: string | null; projectName: string; activeTasks: number }>('session')
      .then((data) => {
        if (controller.signal.aborted) return;
        setSession({
          gitBranch: data.gitBranch ?? null,
          projectName: data.projectName ?? null,
          activeTasks: typeof data.activeTasks === 'number' ? data.activeTasks : 0,
        });
      })
      .catch(() => { /* graceful degradation */ });
    return () => controller.abort();
  }, []);

  // Fetch 24h signal total once on mount.
  useEffect(() => {
    const controller = new AbortController();
    api<{ total: number }>('signal-activity')
      .then((data) => {
        if (controller.signal.aborted) return;
        if (typeof data.total === 'number') setSignalTotal(data.total);
      })
      .catch(() => { /* graceful degradation */ });
    return () => controller.abort();
  }, []);

  // Fetch per-agent polarity scores once on mount.
  useEffect(() => {
    const controller = new AbortController();
    api<AgentScoreEntry[]>('agents')
      .then((data) => {
        if (controller.signal.aborted) return;
        if (Array.isArray(data)) {
          const filtered = data.filter(
            (a): a is AgentScoreEntry =>
              typeof a === 'object' &&
              a !== null &&
              typeof a.id === 'string' &&
              typeof a.scores === 'object' &&
              a.scores !== null,
          );
          setAgentScores(filtered);
        }
      })
      .catch(() => { /* graceful degradation */ });
    return () => controller.abort();
  }, []);

  // Poll active tasks every 5 s — same cadence as ActiveTasksBanner.
  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const data = await api<{ tasks: ActiveTask[] }>('active-tasks');
        if (!cancelled) setActiveTasks(data.tasks || []);
      } catch { /* graceful degradation */ }
    };
    void fetchTasks();
    const interval = setInterval(() => { void fetchTasks(); }, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Tick elapsed timers once per second while tasks are running.
  useEffect(() => {
    if (activeTasks.length === 0) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [activeTasks.length]);

  const onEvent = useCallback((e: DashboardEvent) => {
    setEvents((prev) => {
      const next = [e, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEventStream(onEvent);

  const showWorkingDir =
    typeof session.gitBranch === 'string' && session.gitBranch.length > 0;

  return (
    <aside
      className="chat-surface"
      style={{
        width: '100%',
        minWidth: 0,
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-lg)',
        padding: '14px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        alignSelf: 'stretch',
        overflow: 'hidden',
      }}
      aria-label="Session info and live activity"
    >
      {/* ── Compact session strip ── */}
      <section className="shrink-0">
        <h2
          className="h-section"
          style={{
            marginBottom: '8px',
            borderBottom: '1px solid var(--border)',
            paddingBottom: '6px',
          }}
        >
          session
        </h2>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          {/* Status dot */}
          <StatusDot status={status} compact />

          {/* chat_id — truncated */}
          {chatId && (
            <span
              className="font-mono text-[10px] truncate"
              style={{ color: 'var(--ink-3)' }}
              title={chatId}
            >
              {chatId}
            </span>
          )}

          {/* Working dir + branch */}
          {showWorkingDir && (
            <span
              className="font-mono text-[10px] truncate"
              style={{ color: 'var(--ink-3)' }}
              title={`${session.projectName} · ${session.gitBranch}`}
            >
              {session.projectName} · {session.gitBranch}
            </span>
          )}

          {/* Tasks + signals inline */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <span className="font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
              <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{session.activeTasks}</span>
              {' '}tasks
            </span>
            {signalTotal !== null && (
              <span className="font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
                <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{signalTotal}</span>
                {' '}signals · 24h
              </span>
            )}
          </div>

          {/* Per-agent polarity breakdown */}
          {agentScores !== null && agentScores.length > 0 && (
            <SignalsByAgent agents={agentScores} />
          )}
        </div>
      </section>

      {/* ── Working agents ── */}
      <div className="shrink-0">
        <WorkingAgents tasks={activeTasks} />
      </div>

      {/* ── Activity feed (fills remaining height) ── */}
      <ActivityFeed events={events} />
    </aside>
  );
}
