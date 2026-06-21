/**
 * TaskPage — deep-linkable full-page task detail view.
 *
 * Reads the task from the same tasks data TasksPage uses (passed as a prop).
 * Does NOT make any API call — that is Tranche 2.
 *
 * If the task ID is not in the loaded set (cold deep-link), renders a graceful
 * "not found" frame rather than crashing.
 */
import { renderMarkdown, renderFindingMarkdown, agentColor, taskKindFromAgentId, formatDuration, timeAgo } from '@/lib/utils';
import { normaliseStatus, STATUS_META, STATUS_ICON } from '@/lib/task-status';
import type { TaskItem, TasksData } from '@/lib/types';
import { navigate } from '@/lib/router';

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
  const dispatched = new Date(task.timestamp);
  const completedMs = task.duration != null ? new Date(dispatched.getTime() + task.duration).getTime() : null;

  const formatTime = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const isFailed = key === 'failed';
  const isRunning = key === 'running';

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
// Not-found frame (cold deep-link)
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
          Task not in the loaded list
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
          Open it from the{' '}
          <button
            onClick={() => navigate('/tasks')}
            className="underline transition hover:opacity-80"
            style={{ color: 'var(--info)' }}
          >
            Tasks list
          </button>{' '}
          first to load the session — direct task fetch arrives in a later update.
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────
// Main page
// ──────────────────────────────────────────────
import type React from 'react';

export function TaskPage({ taskId, tasks }: TaskPageProps) {
  // Find the task in the loaded set
  const task: TaskItem | undefined = tasks?.items.find((t) => t.taskId === taskId);

  if (!task) {
    return <TaskNotFound taskId={taskId} />;
  }

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
            href={`/dashboard/agent/${encodeURIComponent(task.agentId)}`}
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

      {/* ── Context section (Tranche 2 placeholders) ── */}
      <div
        className="rounded-lg border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <SectionHeader>context</SectionHeader>
        <div className="space-y-0">
          {/* Tranche 2: these will be wired to backend data */}
          <KVRow label="consensus round" dimmed>
            <span style={{ color: 'color-mix(in oklch, var(--ink-3) 50%, transparent)' }}>○ none</span>
            {/* TODO Tranche 2: wire to consensus round ID */}
          </KVRow>
          <KVRow label="sibling tasks" dimmed>
            <span style={{ color: 'color-mix(in oklch, var(--ink-3) 50%, transparent)' }}>○ none</span>
            {/* TODO Tranche 2: wire to parallel task siblings */}
          </KVRow>
          <KVRow label="findings" dimmed>
            <span style={{ color: 'color-mix(in oklch, var(--ink-3) 50%, transparent)' }}>○ none</span>
            {/* TODO Tranche 2: wire to implementation-findings.jsonl filtered by taskId */}
          </KVRow>
          <KVRow label="signals" dimmed>
            <span style={{ color: 'color-mix(in oklch, var(--ink-3) 50%, transparent)' }}>○ none</span>
            {/* TODO Tranche 2: wire to agent-performance.jsonl filtered by taskId */}
          </KVRow>
        </div>
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
