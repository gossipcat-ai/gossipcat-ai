// @gossip:impact-adjacent:signal-pipeline
/**
 * Tests for warn rate-limiting in parseJsonlLines — torn-line warnings are
 * throttled to one per source file per WARN_RATE_LIMIT_WINDOW_MS so a hot
 * re-read loop (e.g. a 25-agent consensus round doing per-completion
 * dispatch-weight lookups) does not flood mcp.log with identical lines.
 *
 * Fix for consensus 4ee5ced2-b654497a (f1, MEDIUM).
 */

import {
  parseJsonlLines,
  __resetWarnRateLimiterForTests,
} from '../../packages/orchestrator/src/performance-reader';

const WINDOW_MS = 60_000;

// A torn file: one valid object line plus one unparseable line so dropped > 0.
const TORN_LINES = ['{"ok":1}', '{ not json'];

describe('parseJsonlLines — warn rate-limiting (f1)', () => {
  let warnSpy: jest.SpyInstance;
  let nowMs: number;
  const now = () => nowMs;

  function tornWarnCalls(): unknown[][] {
    return warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('unparseable JSONL line(s)'),
    );
  }

  beforeEach(() => {
    __resetWarnRateLimiterForTests();
    nowMs = 1_000_000;
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('emits exactly one warn for two rapid reads of the same torn source', () => {
    const src = '/tmp/agent-performance.jsonl';

    const first = parseJsonlLines<{ ok: number }>(TORN_LINES, src, now);
    nowMs += 5; // milliseconds later — still inside the window
    const second = parseJsonlLines<{ ok: number }>(TORN_LINES, src, now);

    // Parsing/return is unaffected: the one valid object survives each read.
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain('dropped 1 unparseable JSONL line(s)');
    expect(warns[0][0]).toContain('agent-performance.jsonl');
  });

  it('warns again after the window elapses and reports the suppressed count', () => {
    const src = '/tmp/agent-performance.jsonl';

    parseJsonlLines(TORN_LINES, src, now); // emit #1
    // Three reads inside the window are suppressed but counted.
    for (let i = 0; i < 3; i++) {
      nowMs += 10;
      parseJsonlLines(TORN_LINES, src, now);
    }
    // Cross the window boundary — next read warns again.
    nowMs += WINDOW_MS;
    parseJsonlLines(TORN_LINES, src, now);

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(2);
    expect(warns[1][0]).toContain('suppressed 3 similar warn(s) since last warn');
  });

  it('reports the peak dropped count among suppressed reads', () => {
    const src = '/tmp/peak/agent-performance.jsonl';
    const tornN = (n: number) => ['{"ok":1}', ...Array.from({ length: n }, () => '{ torn')];

    parseJsonlLines(tornN(10), src, now); // emit #1: dropped 10
    nowMs += 5;
    parseJsonlLines(tornN(50), src, now); // suppressed, peak 50
    nowMs += 5;
    parseJsonlLines(tornN(2), src, now); // suppressed, peak stays 50
    nowMs += WINDOW_MS;
    parseJsonlLines(tornN(2), src, now); // emit #2: current dropped 2, reports peak

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(2);
    expect(warns[1][0]).toContain('dropped 2 unparseable JSONL line(s)');
    expect(warns[1][0]).toContain('suppressed 2 similar warn(s) since last warn, max dropped=50');
  });

  it('reports suppressed count accurately after a long silence past the window', () => {
    const src = '/tmp/gap/agent-performance.jsonl';

    parseJsonlLines(TORN_LINES, src, now); // emit #1
    nowMs += 5;
    parseJsonlLines(TORN_LINES, src, now); // suppressed at t≈0
    nowMs += 10 * WINDOW_MS; // long silence — suppression happened far in the past
    parseJsonlLines(TORN_LINES, src, now); // emit #2

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(2);
    // The message claims "since last warn", which stays accurate however long the
    // gap is — it must NOT claim a fixed recency window like "in the last 60s".
    expect(warns[1][0]).toContain('suppressed 1 similar warn(s) since last warn');
    expect(warns[1][0]).not.toContain('in the last');
  });

  it('rate-limits different source files independently', () => {
    const a = '/tmp/a/a.jsonl';
    const b = '/tmp/b/b.jsonl';

    parseJsonlLines(TORN_LINES, a, now); // emit for a
    parseJsonlLines(TORN_LINES, b, now); // emit for b — different key, not throttled
    nowMs += 5;
    parseJsonlLines(TORN_LINES, a, now); // suppressed (a, in-window)
    parseJsonlLines(TORN_LINES, b, now); // suppressed (b, in-window)

    const warns = tornWarnCalls();
    expect(warns).toHaveLength(2);
    // Distinct basenames make the per-file assertions discriminating.
    expect(warns.map((c) => c[0])).toEqual([
      expect.stringContaining('a.jsonl'),
      expect.stringContaining('b.jsonl'),
    ]);
  });

  it('does not change dropped-line filtering: torn lines stay excluded from results', () => {
    const src = '/tmp/filter/agent-performance.jsonl';
    const lines = ['{"keep":1}', 'null', '{ broken', '{"keep":2}'];

    const out = parseJsonlLines<{ keep: number }>(lines, src, now);

    // Both torn rows (the syntax error and the literal null) are excluded; the
    // two valid objects survive.
    expect(out).toEqual([{ keep: 1 }, { keep: 2 }]);
    const warns = tornWarnCalls();
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain('dropped 2 unparseable JSONL line(s)');
  });

  it('does not warn for a clean source (no dropped lines)', () => {
    const src = '/tmp/clean/agent-performance.jsonl';
    const out = parseJsonlLines<{ ok: number }>(['{"ok":1}', '{"ok":2}'], src, now);
    expect(out).toHaveLength(2);
    expect(tornWarnCalls()).toHaveLength(0);
  });
});
