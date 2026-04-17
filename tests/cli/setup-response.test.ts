import { buildDashboardAdvisory } from '../../apps/cli/src/setup-response';

describe('buildDashboardAdvisory (issue #96)', () => {
  it('reports refreshed agent count on success', () => {
    const out = buildDashboardAdvisory({
      syncResult: { ok: true, mergedAgentCount: 4 },
      bootedInDegradedMode: false,
    });
    expect(out).toEqual(['Dashboard: refreshed with 4 agents.']);
  });

  it('uses singular "agent" when count is exactly 1', () => {
    const out = buildDashboardAdvisory({
      syncResult: { ok: true, mergedAgentCount: 1 },
      bootedInDegradedMode: false,
    });
    expect(out[0]).toBe('Dashboard: refreshed with 1 agent.');
  });

  it('surfaces the sync error message when refresh fails', () => {
    const out = buildDashboardAdvisory({
      syncResult: { ok: false, mergedAgentCount: 0, error: 'setAgentConfigs is not a function' },
      bootedInDegradedMode: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Dashboard refresh failed');
    expect(out[0]).toContain('setAgentConfigs is not a function');
    expect(out[0]).toContain('/mcp');
  });

  it('falls back to a generic failure message when no error text is provided', () => {
    const out = buildDashboardAdvisory({
      syncResult: { ok: false, mergedAgentCount: 0 },
      bootedInDegradedMode: false,
    });
    expect(out[0]).toBe('⚠ Dashboard refresh failed. Run `/mcp` reconnect to see agents.');
  });

  it('appends a degraded-mode note when ctx.bootedInDegradedMode is true', () => {
    const out = buildDashboardAdvisory({
      syncResult: { ok: true, mergedAgentCount: 3 },
      bootedInDegradedMode: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('refreshed with 3 agents');
    expect(out[1]).toContain('relay booted before config existed');
    expect(out[1]).toContain('/mcp');
  });

  it('combines failure + degraded-mode note when both apply', () => {
    const out = buildDashboardAdvisory({
      syncResult: { ok: false, mergedAgentCount: 0, error: 'boom' },
      bootedInDegradedMode: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Dashboard refresh failed: boom');
    expect(out[1]).toContain('relay booted before config existed');
  });

  it('emits an unknown-status advisory when syncResult is null', () => {
    const out = buildDashboardAdvisory({
      syncResult: null,
      bootedInDegradedMode: false,
    });
    expect(out).toEqual(['⚠ Dashboard refresh status unknown. Run `/mcp` reconnect to see agents.']);
  });
});
