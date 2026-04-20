/**
 * Memory-query buffer — Option 1 attribution for native-agent memory_query
 * observability. See project_memory_query_observability.md.
 */
import {
  recordMemoryQueryAttribution,
  hasMemoryQuery,
  MEMORY_QUERY_TOOLS,
  sweepExpiredAgents,
  _resetMemoryQueryBuffer,
} from '@gossip/relay/memory-query-buffer';

describe('memory-query-buffer', () => {
  beforeEach(() => {
    _resetMemoryQueryBuffer();
  });

  it('records a memory_query call and returns true within the window', () => {
    const start = Date.now();
    recordMemoryQueryAttribution('opus-implementer', 'memory_query', start + 100);
    expect(hasMemoryQuery('opus-implementer', start, start + 1000)).toBe(true);
  });

  it('returns false when the call is outside the requested window', () => {
    const start = Date.now();
    recordMemoryQueryAttribution('opus-implementer', 'gossip_remember', start - 5000);
    expect(hasMemoryQuery('opus-implementer', start, start + 1000)).toBe(false);
  });

  it('returns false for a different agent', () => {
    const start = Date.now();
    recordMemoryQueryAttribution('agent-a', 'memory_query', start + 50);
    expect(hasMemoryQuery('agent-b', start, start + 1000)).toBe(false);
  });

  it('ignores tools that are not memory queries', () => {
    const start = Date.now();
    recordMemoryQueryAttribution('agent-x', 'file_read', start + 10);
    recordMemoryQueryAttribution('agent-x', 'self_identity', start + 20);
    expect(hasMemoryQuery('agent-x', start, start + 1000)).toBe(false);
  });

  it('drops oldest entries when per-agent cap is exceeded', () => {
    const base = Date.now() - 1000;
    // Insert 300 entries — cap is 256.
    for (let i = 0; i < 300; i++) {
      recordMemoryQueryAttribution('agent-cap', 'memory_query', base + i);
    }
    // Earliest entries should be evicted: anything before base+44 is gone
    // (300 - 256 = 44 dropped from the head).
    expect(hasMemoryQuery('agent-cap', base, base + 44)).toBe(false);
    // Most recent retained entries should still be visible.
    expect(hasMemoryQuery('agent-cap', base + 44, base + 300)).toBe(true);
  });

  it('prunes entries older than the 5-minute retention window on insert', () => {
    const now = Date.now();
    // Stale entry from 6 minutes ago — should be pruned by the next insert.
    recordMemoryQueryAttribution('agent-prune', 'memory_query', now - 6 * 60 * 1000);
    // Fresh entry triggers the prune pass.
    recordMemoryQueryAttribution('agent-prune', 'memory_query', now);
    // The stale entry's window is no longer queryable.
    expect(hasMemoryQuery('agent-prune', now - 7 * 60 * 1000, now - 5 * 60 * 1000 - 1)).toBe(false);
    // The fresh entry is still there.
    expect(hasMemoryQuery('agent-prune', now - 100, now + 1000)).toBe(true);
  });

  it('exposes both memory_query and gossip_remember as recognised tools', () => {
    expect(MEMORY_QUERY_TOOLS.has('memory_query')).toBe(true);
    expect(MEMORY_QUERY_TOOLS.has('gossip_remember')).toBe(true);
    expect(MEMORY_QUERY_TOOLS.has('file_read')).toBe(false);
  });

  it('isolates agents under interleaved inserts', () => {
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      recordMemoryQueryAttribution('agent-a', 'memory_query', t0 + i * 2);
      recordMemoryQueryAttribution('agent-b', 'gossip_remember', t0 + i * 2 + 1);
    }
    // Both agents see their own hits.
    expect(hasMemoryQuery('agent-a', t0, t0 + 1000)).toBe(true);
    expect(hasMemoryQuery('agent-b', t0, t0 + 1000)).toBe(true);
    // Narrow window to a slot only agent-a wrote (even offsets): hits agent-a, not agent-b.
    expect(hasMemoryQuery('agent-a', t0, t0 + 1)).toBe(true);
    expect(hasMemoryQuery('agent-b', t0, t0 + 1)).toBe(false);
  });

  it('hasMemoryQuery exclusive upper bound — entry at untilMs is excluded', () => {
    const at = Date.now();
    recordMemoryQueryAttribution('agent-edge', 'memory_query', at);
    // Query with untilMs === at: half-open [at, at) excludes the exact point.
    expect(hasMemoryQuery('agent-edge', at - 1, at)).toBe(false);
    // Query with untilMs === at+1 includes it.
    expect(hasMemoryQuery('agent-edge', at - 1, at + 1)).toBe(true);
  });

  it('native-tasks integration pattern: record during task window, observe on completion', () => {
    // Simulates the shape of apps/cli/src/handlers/native-tasks.ts:handleNativeRelay.
    // Agent dispatch starts at startedAt; mid-task the agent calls gossip_remember
    // which fires recordMemoryQueryAttribution; on completion the handler checks the buffer
    // using the same [startedAt, now+2000) window.
    const startedAt = Date.now();
    recordMemoryQueryAttribution('opus-implementer', 'gossip_remember', startedAt + 50);
    const observed = hasMemoryQuery('opus-implementer', startedAt, Date.now() + 2000);
    expect(observed).toBe(true);

    // Sibling agent never invoked the tool — window returns false cleanly.
    expect(hasMemoryQuery('sonnet-reviewer', startedAt, Date.now() + 2000)).toBe(false);

    // An earlier task's memoryQueryCalled does not bleed into a fresh task's window.
    const laterTaskStart = Date.now() + 3000;
    expect(hasMemoryQuery('opus-implementer', laterTaskStart, laterTaskStart + 2000)).toBe(false);
  });

  it('sweepExpiredAgents drops dead keys from the outer Map', () => {
    const longAgo = Date.now() - 10 * 60 * 1000; // older than 5-min retention
    recordMemoryQueryAttribution('agent-gone', 'memory_query', longAgo);
    // Before sweep: even though the single entry is older than retention, the
    // agent key exists in the Map (prune-on-insert only fires on subsequent writes).
    expect(hasMemoryQuery('agent-gone', longAgo - 1, longAgo + 1)).toBe(true);
    sweepExpiredAgents(Date.now());
    // After sweep the key is gone — query returns false because entries is undefined.
    expect(hasMemoryQuery('agent-gone', longAgo - 1, longAgo + 1)).toBe(false);
  });
});
