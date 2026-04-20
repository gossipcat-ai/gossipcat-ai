/**
 * Formats the hallucination_caught drop receipt appended to gossip_signals
 * responses when signals are dropped for missing categories.
 *
 * Extracted from mcp-server-sdk.ts to keep the output shape a reusable,
 * single-source concept (DropCounter). Consumers must not rebuild the string
 * inline — byte-identical output is a pipeline invariant (consensus
 * 3edbdec8-02684caa:sonnet-reviewer:f3).
 */
export interface DroppedEntry {
  agentId: string;
  findingId?: string;
  finding: string;
  reason?: string;
}

export function formatDropReceipt(drops: readonly DroppedEntry[]): string | null {
  if (drops.length === 0) return null;
  const lines = drops.map(d =>
    `  ${d.agentId}:${d.findingId ?? '?'} finding="${d.finding.slice(0, 60)}"`
  );
  return `\n\n⚠️ ${drops.length} hallucination_caught signal(s) dropped (no category could be derived):\n${lines.join('\n')}`;
}
