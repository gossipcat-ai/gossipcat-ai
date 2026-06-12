/**
 * auto-signal-dedup.ts — append-time dedup for once-per-task auto-signals.
 *
 * Audit 6eed37aa f9. Both pipeline emitters (emitCompletionSignals in
 * completion-signals.ts and emitImplSignals in signal-helpers.ts) fire a fixed
 * set of signals exactly once per task. A crash/retry between the signal append
 * and `nativeTaskMap.delete(task_id)` (apps/cli/src/handlers/native-tasks.ts)
 * re-runs the whole emission for the same task, double-counting it in scoring.
 * The MCP record/bulk paths already dedup by findingId; these auto-emissions
 * had no guard.
 *
 * This lives in its own module (not inside completion-signals.ts) so the
 * helper depends ONLY on performance-reader's read helpers — keeping it out of
 * the completion-signals ↔ dispatch-pipeline import cycle.
 */
import { join } from 'path';
import { readJsonlWithRotated, parseJsonlLines } from './performance-reader';
import type { PerformanceSignal } from './consensus-types';

function tripleKey(agentId: string, taskId: string, signal: string): string {
  return `${agentId} ${taskId} ${signal}`;
}

/**
 * Drop any signal whose (agentId, taskId, signal) triple already exists on disk
 * (or repeats within the incoming batch). Intentionally NOT pushed into
 * WRITER_INTERNAL.appendSignals — consensus-type signals legitimately repeat
 * per finding and are deduped elsewhere by findingId. Per-task emission
 * frequency is low, so an O(file) read per emit is acceptable (no index built).
 *
 * Returns the signals that should actually be written, plus the skipped count.
 * Fail-open: if the read throws, returns the input batch unchanged (better to
 * risk a rare double-count than to silently drop a real signal); the failure
 * is logged to stderr so an inert dedup is diagnosable.
 *
 * Key constraints (consensus f7d8b67a f14): the triple omits `counterpartId`,
 * so a future multi-peer batch caller would collapse distinct peers' signals —
 * do not route multi-peer batches through this. It also ignores retraction
 * tombstones, so a retracted signal type can never be legitimately re-emitted
 * via the deduped emitters — do not route retractable consensus signals here.
 */
export function dedupeOncePerTaskSignals<T extends PerformanceSignal>(
  projectRoot: string,
  signals: readonly T[],
): { kept: T[]; skipped: number } {
  if (signals.length === 0) return { kept: [], skipped: 0 };
  try {
    const filePath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
    const raw = readJsonlWithRotated(filePath);
    const existing = new Set<string>();
    if (raw) {
      const lines = raw.trim().split('\n').filter(Boolean);
      const rows = parseJsonlLines<PerformanceSignal>(lines, filePath);
      for (const r of rows) {
        if (
          r &&
          typeof r.agentId === 'string' &&
          typeof r.taskId === 'string' &&
          typeof r.signal === 'string'
        ) {
          existing.add(tripleKey(r.agentId, r.taskId, r.signal));
        }
      }
    }
    const seenInBatch = new Set<string>();
    const kept: T[] = [];
    let skipped = 0;
    for (const s of signals) {
      const key = tripleKey(s.agentId, s.taskId, s.signal);
      if (existing.has(key) || seenInBatch.has(key)) {
        skipped++;
        continue;
      }
      seenInBatch.add(key);
      kept.push(s);
    }
    return { kept, skipped };
  } catch (err) {
    process.stderr.write(
      `[gossipcat] auto-signal dedup read failed (fail-open, batch passes undeduped): ${(err as Error).message}\n`,
    );
    return { kept: [...signals], skipped: 0 };
  }
}
