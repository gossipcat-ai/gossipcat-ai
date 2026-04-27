// packages/orchestrator/src/round-counter.ts
//
// In-memory per-round signal counter for Phase A system self-telemetry.
// Catches silent signal-loss bugs (like the historical 6-drop-gate bug) at
// the moment of loss rather than after the fact. TTL eviction is omitted in
// favour of explicit reset() — rounds complete in under a minute so memory
// pressure is negligible; test isolation is simpler with explicit cleanup.

const counts = new Map<string, number>();

/** Increment the signal count for `consensusId` by 1. */
export function bump(consensusId: string): void {
  counts.set(consensusId, (counts.get(consensusId) ?? 0) + 1);
}

/** Return the current signal count for `consensusId` (0 if never bumped). */
export function get(consensusId: string): number {
  return counts.get(consensusId) ?? 0;
}

/** Reset the counter for `consensusId`. Used in tests and explicit cleanup. */
export function reset(consensusId: string): void {
  counts.delete(consensusId);
}

/**
 * Derive a consensusId from a signal record. Returns the consensusId if
 * present, else extracts the prefix from a findingId that matches
 * `<8hex>-<8hex>:...`. Returns undefined when neither is available (meta,
 * impl, ad-hoc signals that don't belong to a consensus round).
 */
export function deriveConsensusId(record: {
  consensusId?: string;
  findingId?: string;
}): string | undefined {
  if (record.consensusId) return record.consensusId;
  if (typeof record.findingId === 'string') {
    const prefix = record.findingId.split(':')[0];
    // Validate canonical shape: <8hex>-<8hex>
    if (/^[0-9a-f]{8}-[0-9a-f]{8}$/.test(prefix)) return prefix;
  }
  return undefined;
}
