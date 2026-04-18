/**
 * Memory-query buffer — Option 1 attribution for native-agent memory_query
 * observability. See project_memory_query_observability.md.
 */
import {
  recordMemoryQueryAttribution,
  hasMemoryQuery,
  MEMORY_QUERY_TOOLS,
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
});
