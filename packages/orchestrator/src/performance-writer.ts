// packages/orchestrator/src/performance-writer.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { PerformanceSignal } from './consensus-types';

const VALID_CONSENSUS_SIGNALS = new Set([
  'agreement', 'disagreement', 'unverified', 'unique_confirmed',
  'unique_unconfirmed', 'new_finding', 'hallucination_caught',
  'category_confirmed', 'consensus_verified', 'signal_retracted',
  'consensus_round_retracted',
  'task_timeout', 'task_empty',
]);

const VALID_IMPL_SIGNALS = new Set([
  'impl_test_pass', 'impl_test_fail', 'impl_peer_approved', 'impl_peer_rejected',
]);

const VALID_META_SIGNALS = new Set([
  'task_completed', 'task_tool_turns', 'format_compliance',
]);

/**
 * Sentinel agentId used on round-level tombstone rows. Not a real agent —
 * readers must skip `agentId === '_system'` rows from any per-agent
 * aggregation. See docs/specs/2026-04-17-consensus-round-retraction.md.
 */
const SYSTEM_SENTINEL_AGENT_ID = '_system';

function validateSignal(signal: PerformanceSignal): void {
  if (!signal || typeof signal !== 'object') {
    throw new Error('Signal validation failed: signal must be an object');
  }
  if (typeof signal.agentId !== 'string' || signal.agentId.length === 0) {
    throw new Error('Signal validation failed: agentId must be a non-empty string');
  }
  if (typeof signal.taskId !== 'string' || signal.taskId.length === 0) {
    throw new Error('Signal validation failed: taskId must be a non-empty string');
  }
  if (typeof signal.timestamp !== 'string' || !isFinite(new Date(signal.timestamp).getTime())) {
    throw new Error('Signal validation failed: timestamp must be a valid ISO-8601 string');
  }

  switch (signal.type) {
    case 'consensus':
      if (!VALID_CONSENSUS_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown consensus signal "${signal.signal}"`);
      }
      break;
    case 'impl':
      if (!VALID_IMPL_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown impl signal "${signal.signal}"`);
      }
      break;
    case 'meta':
      if (!VALID_META_SIGNALS.has(signal.signal)) {
        throw new Error(`Signal validation failed: unknown meta signal "${signal.signal}"`);
      }
      break;
    default:
      throw new Error(`Signal validation failed: unknown type "${(signal as any).type}"`);
  }
}

export class PerformanceWriter {
  private readonly filePath: string;

  constructor(projectRoot: string) {
    const dir = join(projectRoot, '.gossip');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'agent-performance.jsonl');
  }

  appendSignal(signal: PerformanceSignal): void {
    validateSignal(signal);
    appendFileSync(this.filePath, JSON.stringify(signal) + '\n');
  }

  appendSignals(signals: PerformanceSignal[]): void {
    if (signals.length === 0) return;
    for (const s of signals) validateSignal(s);
    const data = signals.map(s => JSON.stringify(s)).join('\n') + '\n';
    appendFileSync(this.filePath, data);
  }

  /**
   * Append a round-level retraction tombstone.
   *
   * Tombstone row uses the `_system` sentinel as `agentId`. Readers must
   * filter `agentId === '_system'` out of per-agent aggregation; signal
   * scoring uses `consensus_id` to drop every signal whose `findingId`
   * starts with `<consensus_id>:`. Idempotence is a reader concern — extra
   * rows from duplicate retractions are harmless audit data that the
   * reader's `retractedConsensusIds: Set<string>` dedupes.
   *
   * See docs/specs/2026-04-17-consensus-round-retraction.md.
   */
  recordConsensusRoundRetraction(consensusId: string, reason: string): void {
    const row: any = {
      type: 'consensus',
      signal: 'consensus_round_retracted',
      agentId: SYSTEM_SENTINEL_AGENT_ID,
      // taskId is required by validateSignal. Mirror consensus_id so
      // the tombstone is structurally addressable without inventing a
      // second identifier.
      taskId: consensusId,
      consensus_id: consensusId,
      reason,
      retracted_at: new Date().toISOString(),
      timestamp: new Date().toISOString(),
      evidence: `Consensus round ${consensusId} retracted: ${reason}`,
    };
    validateSignal(row as PerformanceSignal);
    appendFileSync(this.filePath, JSON.stringify(row) + '\n');
  }
}
