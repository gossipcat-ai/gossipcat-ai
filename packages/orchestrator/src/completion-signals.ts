/**
 * emitCompletionSignals — shared helper for native and relay task completion.
 *
 * Fixes the signal-pipeline drift that caused native agents to be invisible
 * in performance analytics (consensus 23687227-1462428b, bugs f1/f4/f8/f10/f11/f15).
 *
 * Both paths (apps/cli/src/handlers/native-tasks.ts and
 * packages/orchestrator/src/dispatch-pipeline.ts) previously duplicated
 * signal emission prose with divergent behaviour:
 *   - Native: missing finding_dropped_format, missing diagnostic_codes, no
 *     memoryQueryCalled threading, no effectiveStart fallback (f11), no
 *     perfReader-weighted memory (f9), no worktree cleanup on error (f13).
 *   - Relay: complete, but duplicated.
 *
 * This module is the single source of truth for task-completion signals.
 * Call it from BOTH paths after the result is obtained.
 */

import { PerformanceWriter } from './performance-writer';
import { detectFormatCompliance } from './dispatch-pipeline';
import type { MetaSignal, PipelineSignal } from './consensus-types';

export interface CompletionSignalInput {
  agentId: string;
  taskId: string;
  result: string;
  /**
   * Measured wall-clock duration in milliseconds.
   * Pass null when timing is genuinely unknown (then we emit 0 with
   * metadata.estimated:true so downstream scorers can filter it).
   */
  elapsedMs: number | null;
  /**
   * Number of tool calls the agent made.
   * Omit (leave undefined) for native agents where tool-call count is
   * unobservable from gossipcat — this preserves the F16 skip contract:
   * we NEVER emit task_tool_turns with value:null or value:0 for native
   * agents because that would make downstream scorers treat them as
   * never-using-tools and fire spurious skill-gap alerts.
   */
  toolCalls?: number;
  /**
   * Whether the agent called memory_query during this task.
   * Threaded from TaskEntry.memoryQueryCalled (relay) or
   * NativeTaskInfo.memoryQueryCalled (native, after f8 thread).
   */
  memoryQueryCalled?: boolean;
}

/**
 * Emit task_completed, (conditionally) task_tool_turns, format_compliance,
 * and (when drops > 0) finding_dropped_format signals.
 *
 * Contract:
 * - Never throws — single try/catch writes to process.stderr on failure.
 * - Never emits task_tool_turns when toolCalls is undefined (F16 preserve).
 * - Always emits format_compliance with diagnostic_codes in metadata.
 * - Emits task_completed with value:0 + metadata.estimated:true when
 *   elapsedMs is null (bug f11: server-side startedAt is always present so
 *   null should be rare, but we must not suppress the signal entirely).
 */
export function emitCompletionSignals(projectRoot: string, input: CompletionSignalInput): void {
  try {
    const { agentId, taskId, result, elapsedMs, toolCalls, memoryQueryCalled } = input;
    const now = new Date().toISOString();
    const compliance = detectFormatCompliance(result ?? '');

    const signals: (MetaSignal | PipelineSignal)[] = [];

    // ── task_completed ────────────────────────────────────────────────────
    // Bug f11: previous native path skipped emission when elapsed === null.
    // Fix: always emit — use value 0 + estimated:true when null so the
    // event lands in the time-series even if its duration isn't meaningful.
    {
      const durationValue = elapsedMs !== null ? elapsedMs : 0;
      const meta: MetaSignal = {
        type: 'meta',
        signal: 'task_completed',
        agentId,
        taskId,
        value: durationValue,
        ...(elapsedMs === null ? { metadata: { estimated: true } } : {}),
        timestamp: now,
      };
      signals.push(meta);
    }

    // ── task_tool_turns ───────────────────────────────────────────────────
    // F16: only emit when toolCalls is defined. Native agents don't pass it
    // so this block is skipped — zero tool-call data is BETTER than false data.
    if (toolCalls !== undefined) {
      signals.push({
        type: 'meta',
        signal: 'task_tool_turns',
        agentId,
        taskId,
        value: toolCalls,
        ...(memoryQueryCalled !== undefined ? { metadata: { memoryQueryCalled } } : {}),
        timestamp: now,
      } as MetaSignal);
    }

    // ── format_compliance ─────────────────────────────────────────────────
    // Bug f4: native path was missing diagnostic_codes in metadata.
    signals.push({
      type: 'meta',
      signal: 'format_compliance',
      agentId,
      taskId,
      value: compliance.formatCompliant ? 1 : 0,
      metadata: {
        findingCount: compliance.findingCount,
        citationCount: compliance.citationCount,
        tags_total: compliance.tags_total,
        tags_accepted: compliance.tags_accepted,
        tags_dropped_unknown_type: compliance.tags_dropped_unknown_type,
        tags_dropped_short_content: compliance.tags_dropped_short_content,
        diagnostic_codes: compliance.diagnostics.map(d => d.code),
      },
      timestamp: now,
    } as MetaSignal);

    // ── finding_dropped_format (pipeline) ─────────────────────────────────
    // Bug f1: native path never emitted this — zero type:pipeline entries in
    // agent-performance.jsonl for native agents. This is the event that would
    // have caught the drop-gate bug in-session.
    const droppedTotal = compliance.tags_dropped_unknown_type + compliance.tags_dropped_short_content;
    if (droppedTotal > 0) {
      signals.push({
        type: 'pipeline',
        signal: 'finding_dropped_format',
        agentId,
        taskId,
        value: droppedTotal,
        metadata: {
          tags_total: compliance.tags_total,
          tags_accepted: compliance.tags_accepted,
          tags_dropped_unknown_type: compliance.tags_dropped_unknown_type,
          tags_dropped_short_content: compliance.tags_dropped_short_content,
          diagnostic_codes: compliance.diagnostics.map(d => d.code),
        },
        timestamp: now,
      } as PipelineSignal);
    }

    const writer = new PerformanceWriter(projectRoot);
    writer.appendSignals(signals);
  } catch (err) {
    process.stderr.write(`[gossipcat] emitCompletionSignals failed: ${(err as Error).message}\n`);
  }
}
