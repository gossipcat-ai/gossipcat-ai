/**
 * TaskPage — deep-linkable full-page task detail view.
 *
 * Fetches enriched task detail from /dashboard/api/tasks/:id on mount so that
 * deep-linked URLs work without prior navigation to the Tasks list. Falls back
 * to the prop task if the fetch is in-flight or unavailable.
 */
import { renderMarkdown, renderFindingMarkdown, agentColor, taskKindFromAgentId, formatDuration, timeAgo } from '@/lib/utils';
import { normaliseStatus, STATUS_META, STATUS_ICON } from '@/lib/task-status';
import type { TaskItem, TasksData, TaskDetail } from '@/lib/types';
import { navigate, href } from '@/lib/router';

interface TaskPageProps {
  taskId: string;
  tasks: TasksData | null;
}

// ──────────────────────────────────────────────
// Status chip — semantic per DESIGN.md
// ──────────────────────────────────────────────
function StatusChip({ status }: { status: string }) {
  const key = normaliseStatus(status);
  const meta = STATUS_META[key];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold ${meta.iconBox} ${meta.text}`}
      style={meta.textStyle}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className={meta.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}
      >
        {STATUS_ICON[key]}
      </svg>
      {meta.label}
    </span>
  );
}

// ──────────────────────────────────────────────
// Breadcrumb
// ──────────────────────────────────────────────
function Breadcrumb({ taskId }: { taskId: string }) {
  return (
    <nav className="mb-4 flex items-center gap-1.5 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }} aria-label="Breadcrumb">
      <button
        onClick={() => navigate('/tasks')}
        className="transition hover:underline"
        style={{ color: 'var(--ink-2)' }}
      >
        Tasks
      </button>
      <span aria-hidden>›</span>
      <span style={{ color: 'var(--ink-3)' }}>{taskId.slice(0, 8)}</span>
    </nav>
  );
}

// ──────────────────────────────────────────────
// Lifecycle timeline — 2-node hairline CSS
// dispatched → completed (or failed)
// ──────────────────────────────────────────────
interface TimelineProps {
  task: TaskItem;
}

function LifecycleTimeline({ task }: TimelineProps) {
  const key = normaliseStatus(task.status);
  // Dispatched node always uses createdAt (dispatch time); fall back to timestamp
  // only for tasks loaded from older data that lack createdAt.
  const dispatched = new Date(task.createdAt ?? task.timestamp);
  // For terminal tasks timestamp IS the completion time; for running tasks there is no end.
  const isRunning = key === 'running';
  const completedMs = !isRunning ? new Date(task.timestamp).getTime() : null;

  const formatTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const isFailed = key === 'failed';

  // Terminal node label + color
  const endLabel = isFailed ? 'Failed' : isRunning ? 'Running…' : 'Completed';
  const endColor = isFailed ? 'var(--bad)' : isRunning ? 'var(--info)' : 'var(--ok)';
  const endBorder = isFailed ? 'var(--bad)' : isRunning ? 'var(--info)' : 'var(--ok)';

  return (
    <div className="flex items-start gap-0" aria-label="Task lifecycle timeline">
      {/* Dispatched node */}
      <div className="flex flex-col items-center" style={{ minWidth: 120 }}>
        <div
          className="h-3 w-3 rounded-full border-2"
          style={{ borderColor: 'var(--ink-3)', background: 'var(--surface)' }}
        />
        <div className="mt-1 font-mono text-[10px] font-semibold" style={{ color: 'var(--ink-2)' }}>
          Dispatched
        </div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
          {formatTime(dispatched)}
        </div>
      </div>

      {/* Connecting line */}
      <div
        className="mt-1.5 flex-1"
        style={{ height: 2, background: isFailed ? 'color-mix(in oklch, var(--bad) 30%, transparent)' : 'var(--border)', minWidth: 40 }}
        aria-hidden
      />

      {/* Terminal node */}
      <div className="flex flex-col items-center" style={{ minWidth: 120 }}>
        <div
          className="h-3 w-3 rounded-full border-2"
          style={{
            borderColor: endBorder,
            background: isFailed ? 'color-mix(in oklch, var(--bad) 15%, transparent)' : 'var(--surface)',
          }}
        />
        <div className="mt-1 font-mono text-[10px] font-semibold" style={{ color: endColor }}>
          {endLabel}
        </div>
        <div className="font-mono text-[10px]" style={{ color: 'var(--ink-3)' }}>
          {completedMs ? formatTime(new Date(completedMs)) : '—'}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Section header — small-caps Geist per DESIGN.md
// ──────────────────────────────────────────────
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3
      className="mb-3 h-section pb-2"
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      {children}
    </h3>
  );
}

// ──────────────────────────────────────────────
// Key-value row
// ──────────────────────────────────────────────
function KVRow({ label, children, dimmed = false }: { label: string; children: React.ReactNode; dimmed?: boolean }) {
  return (
    <div className="flex items-start gap-4 py-1.5 border-b border-border/20 last:border-0">
      <span
        className="w-32 shrink-0 font-mono text-[11px]"
        style={{ color: 'var(--ink-3)' }}
      >
        {label}
      </span>
      <span
        className="flex-1 font-mono text-[11px]"
        style={{ color: dimmed ? 'color-mix(in oklch, var(--ink-3) 60%, transparent)' : 'var(--ink-2)' }}
      >
        {children}
      </span>
    </div>
  );
}

// ──────────────────────────────────────────────
// Not-found frame (task absent from task-graph.jsonl)
// ──────────────────────────────────────────────
function TaskNotFound({ taskId }: { taskId: string }) {
  return (
    <div>
      <Breadcrumb taskId={taskId} />
      <div
        className="rounded-lg border p-8 text-center"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div className="font-mono text-sm font-semibold" style={{ color: 'var(--ink-2)' }}>
          Task not found
        </div>
        <div className="mt-2 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          <code
            className="rounded px-1"
            style={{ fontFamily: 'JetBrains Mono, monospace', background: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)' }}
          >
            {taskId}
          </code>
        </div>
        <div className="mt-4 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          No task with this ID exists in task-graph.jsonl.{' '}
          <button
            onClick={() => navigate('/tasks')}
            className="underline transition hover:opacity-80"
            style={{ color: 'var(--info)' }}
          >
            Back to Tasks list
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Error frame — non-404 fetch failure
// ──────────────────────────────────────────────
function TaskLoadError({ taskId }: { taskId: string }) {
  return (
    <div>
      <Breadcrumb taskId={taskId} />
      <div
        className="rounded-lg border p-8 text-center"
        style={{ borderColor: 'var(--bad)', background: 'color-mix(in oklch, var(--bad) 6%, var(--surface))' }}
      >
        <div className="font-mono text-sm font-semibold" style={{ color: 'var(--bad)' }}>
          Failed to load task
        </div>
        <div className="mt-2 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          <code
            className="rounded px-1"
            style={{ fontFamily: 'JetBrains Mono, monospace', background: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)' }}
          >
            {taskId}
          </code>
        </div>
        <div className="mt-4 font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
          The server returned an error or the response was malformed.{' '}
          <button
            onClick={() => navigate('/tasks')}
            className="underline transition hover:opacity-80"
            style={{ color: 'var(--info)' }}
          >
            Back to Tasks list
          </button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Context section — wired to backend enrichment
// ──────────────────────────────────────────────

/** Dimmed "○ none" placeholder for genuinely absent data. */
function AbsentValue() {
  return (
    <span style={{ color: 'color-mix(in oklch, var(--ink-3) 50%, transparent)' }}>○ none</span>
  );
}

interface ContextSectionProps {
  detail: TaskDetail | null;
  loading: boolean;
}

function ContextSection({ detail, loading }: ContextSectionProps) {
  if (loading) {
    return (
      <div className="space-y-0">
        {(['consensus round', 'sibling tasks', 'round findings', 'signals'] as const).map((label) => (
          <KVRow key={label} label={label} dimmed>
            <span
              className="inline-block h-3 w-24 rounded animate-pulse"
              style={{ background: 'color-mix(in oklch, var(--border) 60%, transparent)' }}
              aria-label="loading"
            />
          </KVRow>
        ))}
      </div>
    );
  }

  const consensusId = detail?.consensusId;
  const siblings = detail?.siblingTaskIds ?? [];
  const siblingsTruncated = detail?.siblingsTruncated ?? false;
  const signalCount = detail?.signalCount ?? 0;
  const findingCount = detail?.findingCount ?? 0;

  return (
    <div className="space-y-0">
      {/* Consensus round */}
      <KVRow label="consensus round">
        {consensusId ? (
          <a
            href={href(`/consensus/${encodeURIComponent(consensusId)}`)}
            className="transition hover:underline"
            style={{ color: 'var(--info)', fontFamily: 'JetBrains Mono, monospace' }}
          >
            {consensusId}
          </a>
        ) : (
          <AbsentValue />
        )}
      </KVRow>

      {/* Sibling tasks */}
      <KVRow label="sibling tasks">
        {siblings.length > 0 ? (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            <span style={{ color: 'var(--ink-2)' }}>{siblings.length}{siblingsTruncated ? '+' : ''}</span>
            {siblings.slice(0, 5).map((sid) => (
              <a
                key={sid}
                href={href(`/tasks/${encodeURIComponent(sid)}`)}
                className="transition hover:underline"
                style={{ color: 'var(--info)', fontFamily: 'JetBrains Mono, monospace' }}
              >
                {sid.slice(0, 8)}
              </a>
            ))}
            {siblings.length > 5 && (
              <span style={{ color: 'var(--ink-3)' }}>+{siblings.length - 5} more</span>
            )}
          </span>
        ) : (
          <AbsentValue />
        )}
      </KVRow>

      {/* Round findings (count of implementation-findings rows for this consensus round) */}
      <KVRow label="round findings">
        {findingCount > 0 ? (
          <span style={{ color: 'var(--ink-2)' }}>{findingCount}</span>
        ) : (
          <AbsentValue />
        )}
      </KVRow>

      {/* Signals */}
      <KVRow label="signals">
        {signalCount > 0 ? (
          <a
            href={href('/signals')}
            className="transition hover:underline"
            style={{ color: 'var(--info)' }}
          >
            {signalCount}
          </a>
        ) : (
          <AbsentValue />
        )}
      </KVRow>
    </div>
  );
}

// ──────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────
import { useState, useEffect } from 'react';

export function TaskPage({ taskId, tasks }: TaskPageProps) {
  // Prop task used as fast initial render (if already loaded in the session).
  const propTask: TaskItem | undefined = tasks?.items.find((t) => t.taskId === taskId);

  // Fetch enriched detail from the backend.
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailNotFound, setDetailNotFound] = useState(false);
  // detailError is set on non-404 failures (500, malformed JSON, network error).
  const [detailError, setDetailError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetailLoading(true);
    setDetailNotFound(false);
    setDetailError(false);
    setDetail(null);

    fetch(`/dashboard/api/tasks/${encodeURIComponent(taskId)}`)
      .then(async (res) => {
        if (res.status === 404) {
          if (!cancelled) setDetailNotFound(true);
          return;
        }
        if (!res.ok) {
          // Non-404 server error — flag as error so we don't show an infinite skeleton.
          if (!cancelled) setDetailError(true);
          return;
        }
        const body = await res.json().catch(() => null);
        if (!cancelled) {
          // Runtime shape guard before casting.
          if (body && typeof body === 'object' && 'taskId' in body) {
            setDetail(body as TaskDetail);
          } else {
            // Malformed JSON or unexpected shape.
            setDetailError(true);
          }
        }
      })
      .catch(() => {
        // Network failure — flag error so the skeleton resolves.
        if (!cancelled) setDetailError(true);
      })
      .finally(() => { if (!cancelled) setDetailLoading(false); });

    return () => { cancelled = true; };
  }, [taskId]);

  // Resolve which task record to render from.
  // Prefer the fetched detail; fall back to the prop task while loading.
  const taskOrUndefined: TaskItem | undefined = detail ?? propTask;

  // Not found: API returned 404 and no prop task to fall back to.
  if (!detailLoading && detailNotFound && !taskOrUndefined) {
    return <TaskNotFound taskId={taskId} />;
  }

  // Non-404 error (500 / malformed JSON / network) with no prop task fallback — show error frame.
  if (!detailLoading && detailError && !taskOrUndefined) {
    return <TaskLoadError taskId={taskId} />;
  }

  // Loading has finished but we still have no task record — shouldn't normally happen,
  // but guard it to prevent an infinite skeleton.
  if (!detailLoading && !taskOrUndefined) {
    return <TaskNotFound taskId={taskId} />;
  }

  // Fetch is in-flight and we have no prop task to show yet — show skeleton.
  if (detailLoading && !taskOrUndefined) {
    return (
      <div>
        <Breadcrumb taskId={taskId} />
        <div
          className="rounded-lg border p-8 text-center font-mono text-[11px]"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--ink-3)' }}
        >
          <span
            className="inline-block h-3 w-32 rounded animate-pulse"
            style={{ background: 'color-mix(in oklch, var(--border) 60%, transparent)' }}
          />
        </div>
      </div>
    );
  }

  // At this point all early-return guards have passed — task is guaranteed to exist.
  const task: TaskItem = taskOrUndefined!;
  const key = normaliseStatus(task.status);
  const kind = taskKindFromAgentId(task.agentId);
  const totalTokens = (task.inputTokens ?? 0) + (task.outputTokens ?? 0);

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Breadcrumb taskId={taskId} />

      {/* ── Header card ── */}
      <div
        className="rounded-lg border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {/* Row 1: status + kind + full ID */}
        <div className="flex flex-wrap items-center gap-3">
          <StatusChip status={task.status} />
          {kind && (
            <span
              className={`rounded-sm border border-border/40 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${kind.cls}`}
              style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', ...kind.clsStyle }}
            >
              {kind.label}
            </span>
          )}
          {/* Full UUID in JetBrains Mono */}
          <code
            className="rounded px-2 py-0.5 text-[11px]"
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              color: 'var(--ink-2)',
              background: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)',
            }}
          >
            {task.taskId}
          </code>
        </div>

        {/* Row 2: agent identity dot + name → /agent/:id */}
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <a
            href={href(`/agent/${encodeURIComponent(task.agentId)}`)}
            className="inline-flex items-center gap-2 font-mono text-xs transition hover:opacity-80"
            style={{ color: 'var(--ink-2)' }}
          >
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: agentColor(task.agentId) }}
            />
            {task.agentId}
          </a>

          {/* Token split */}
          {totalTokens > 0 && (
            <span className="font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
              <span style={{ color: 'var(--ink-2)' }}>{(task.inputTokens ?? 0).toLocaleString()}</span>
              {' '}in /{' '}
              <span style={{ color: 'var(--ink-2)' }}>{(task.outputTokens ?? 0).toLocaleString()}</span>
              {' '}out tokens
            </span>
          )}

          {/* Duration */}
          {task.duration != null && (
            <span className="font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
              {formatDuration(task.duration)}
            </span>
          )}

          {/* Timestamp */}
          <span className="font-mono text-[11px]" style={{ color: 'var(--ink-3)' }}>
            {timeAgo(task.timestamp)}
          </span>
        </div>

        {/* Row 3: lifecycle timeline */}
        <div className="mt-5">
          <LifecycleTimeline task={task} />
        </div>
      </div>

      {/* ── Context section ── */}
      <div
        className="rounded-lg border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <SectionHeader>context</SectionHeader>
        <ContextSection detail={detail} loading={detailLoading} />
      </div>

      {/* ── Task prompt ── */}
      <div
        className="rounded-lg border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <SectionHeader>task</SectionHeader>
        <div
          className="task-md rounded-md border border-border/40 p-3 text-xs leading-relaxed overflow-x-auto"
          style={{
            background: 'color-mix(in oklch, var(--surface) 40%, transparent)',
            color: 'color-mix(in oklch, var(--ink) 90%, transparent)',
          }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(task.task) }}
        />
      </div>

      {/* ── Result ── */}
      <div
        className="rounded-lg border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <SectionHeader>result</SectionHeader>
        {task.result ? (
          <div
            className="finding-md rounded-md border border-border/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [&_.cite-file]:rounded [&_.cite-file]:bg-[color-mix(in_oklch,var(--cite-file)_10%,transparent)] [&_.cite-file]:px-1 [&_.cite-file]:text-[var(--cite-file)] [&_.cite-fn]:rounded [&_.cite-fn]:bg-[color-mix(in_oklch,var(--cite-fn)_10%,transparent)] [&_.cite-fn]:px-1 [&_.cite-fn]:text-[var(--cite-fn)] [&_.inline-code]:rounded [&_.inline-code]:bg-[color-mix(in_oklch,var(--surface-sunk)_40%,transparent)] [&_.inline-code]:px-1 [&_.inline-code-block]:my-2 [&_.inline-code-block]:block [&_.inline-code-block]:rounded [&_.inline-code-block]:bg-[color-mix(in_oklch,var(--surface-sunk)_30%,transparent)] [&_.inline-code-block]:p-2"
            style={{
              background: 'color-mix(in oklch, var(--surface) 40%, transparent)',
              color: 'color-mix(in oklch, var(--ink) 90%, transparent)',
            }}
            dangerouslySetInnerHTML={{ __html: renderFindingMarkdown(task.result) }}
          />
        ) : (
          <div
            className="rounded-md border border-border/40 p-5 text-center font-mono text-xs"
            style={{
              background: 'color-mix(in oklch, var(--surface) 40%, transparent)',
              color: 'var(--ink-3)',
            }}
          >
            {key === 'running' ? (
              <span style={{ color: 'var(--info)' }}>Task is still running…</span>
            ) : key === 'failed' ? (
              <span style={{ color: 'var(--bad)' }}>Task failed — no result recorded.</span>
            ) : (
              <span>No result recorded.</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
