/**
 * Sanctioned re-export of the Symbol that gates appendSignal(s) access.
 *
 * Do NOT re-export from packages/orchestrator/src/index.ts.
 * Do NOT import WRITER_INTERNAL from anywhere other than signal-helpers.ts.
 *
 * Consensus rounds 78bc92ef-23464bde and fb3ea8fc-6e674462 established this
 * boundary. The Step 4 parity test (tests/orchestrator/completion-signals-parity.test.ts)
 * enforces that WRITER_INTERNAL is only imported in:
 *   - packages/orchestrator/src/_writer-internal.ts (this file)
 *   - packages/orchestrator/src/signal-helpers.ts
 *   - packages/orchestrator/src/performance-writer.ts (class definition)
 */
export { _WRITER_INTERNAL_FOR_HELPERS_ONLY as WRITER_INTERNAL } from './performance-writer';
