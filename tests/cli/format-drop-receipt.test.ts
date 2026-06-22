/**
 * PR3: formatDropReceipt helper — extracted from mcp-server-sdk.ts to make
 * the drop-receipt shape a single-sourced pipeline invariant.
 * Output must be byte-identical with the prior inline template.
 */
import { formatDropReceipt } from '../../apps/cli/src/format-drop-receipt';

describe('formatDropReceipt', () => {
  it('returns null for empty array', () => {
    expect(formatDropReceipt([])).toBeNull();
  });

  it('formats a single entry with agent/finding/id', () => {
    const out = formatDropReceipt([{ agentId: 'x', findingId: 'f1', finding: 'test' }]);
    expect(out).toContain('⚠️ 1 hallucination_caught');
    expect(out).toContain('x:f1');
    expect(out).toContain('finding="test"');
  });

  it('lists multiple entries one per line', () => {
    const out = formatDropReceipt([
      { agentId: 'a', findingId: 'f1', finding: 'one' },
      { agentId: 'b', findingId: 'f2', finding: 'two' },
    ]);
    expect(out!.split('\n').filter(l => l.includes('finding='))).toHaveLength(2);
  });

  it('uses ? when findingId missing', () => {
    const out = formatDropReceipt([{ agentId: 'x', finding: 'y' }]);
    expect(out).toContain('x:?');
  });
});
