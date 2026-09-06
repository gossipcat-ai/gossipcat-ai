// tests/tools/truncate-verifier-tool-result.test.ts
//
// Unit coverage for `truncateVerifierToolResult` — the shared truncation
// helper introduced in #749 to close a SECOND, independent hand-rolled
// truncation loop in apps/cli/src/handlers/collect.ts (the legacy two-phase
// consensus path) that had drifted from the byte-aware fix #731 already
// applied to packages/orchestrator/src/consensus-engine.ts's `runToolCalls`.
//
// Both call sites now delegate to this one function, so a future edit can't
// silently re-introduce the raw `slice(0, 8000)` bug in either loop without
// also breaking this test.
import { truncateVerifierToolResult, truncateToBytes, TRUNCATION_MARKER } from '../../packages/tools/src/truncate';

describe('truncateVerifierToolResult (#731 / #749 shared truncation helper)', () => {
  it('passes through output at or under the byte cap unchanged', () => {
    const out = 'y'.repeat(100);
    expect(truncateVerifierToolResult(out, 16384)).toBe(out);
  });

  it('truncates output over the byte cap and appends exactly one TRUNCATION_MARKER', () => {
    const out = 'x'.repeat(20_000);
    const result = truncateVerifierToolResult(out, 16384);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(16384);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(result.split(TRUNCATION_MARKER)).toHaveLength(2);
  });

  it('strips a pre-existing TRUNCATION_MARKER before re-cutting instead of duplicating it', () => {
    const budget = 16384 - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    const alreadyTruncated = truncateToBytes('z'.repeat(budget + 5000), budget) + TRUNCATION_MARKER;
    expect(Buffer.byteLength(alreadyTruncated, 'utf8')).toBeLessThanOrEqual(16384);

    const result = truncateVerifierToolResult(alreadyTruncated, 16384);
    // Re-truncating an already-truncated, in-budget payload is a no-op — the
    // whole point of the marker-strip is to make this function idempotent.
    expect(result).toBe(alreadyTruncated);
    expect(result.split(TRUNCATION_MARKER)).toHaveLength(2);
  });

  it('never splits a multi-byte UTF-8 character at the cut boundary (surrogate-pair-splitting regression, #731)', () => {
    // Build a payload where a 4-byte emoji straddles the OLD buggy cutoff
    // (char-based slice(0, 8000)) as well as an arbitrary smaller cap, so a
    // char-counting truncation would corrupt it either way.
    const prefix = 'a'.repeat(7998);
    const emoji = '😀'; // 4-byte UTF-8 sequence, 2 UTF-16 code units
    const out = prefix + emoji + 'b'.repeat(5000);

    const result = truncateVerifierToolResult(out, 8000);
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(8000);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    // No replacement character (U+FFFD) — a split multi-byte sequence would
    // decode to one via the old raw Buffer#slice-then-toString('utf8') path.
    expect(result).not.toContain('�');
  });

  it('returns just the marker when the budget cannot fit any content', () => {
    const tiny = Buffer.byteLength(TRUNCATION_MARKER, 'utf8') - 1;
    const result = truncateVerifierToolResult('x'.repeat(100), tiny);
    expect(result).toBe(TRUNCATION_MARKER);
  });
});
