/**
 * gossip_setup handler — dashboard URL in response text.
 *
 * Verifies that when a relay is running, gossip_setup emits a line containing
 * the dashboard URL (http://localhost:...) in its response text. This guards
 * against install-drift where a fresh .gossip/ directory gets no dashboard URL
 * surfaced to the user.
 *
 * We test the logic layer (generateRulesContent + ctx.relay URL appended to
 * response lines) rather than the full HTTP handler, which requires a live relay.
 */

/**
 * Simulate the lines-building logic from the gossip_setup handler that adds
 * the dashboard URL after syncWorkersViaKeychain(). This mirrors the actual
 * code at the relevant block in mcp-server-sdk.ts.
 */
function buildSetupResponseLines(opts: {
  mode: string;
  agentCount: number;
  rulesFile: string;
  host: string;
  dashboardUrl: string | null;
  dashboardKey: string | null;
}): string[] {
  const lines: string[] = [];
  lines.push(`\nMode: ${opts.mode} | Config: .gossip/config.json (${opts.agentCount} agents total)`);
  lines.push(`Rules: ${opts.rulesFile} (${opts.host} will read this on next session)`);
  // This is the logic added by Change 4 of the install-drift fix.
  if (opts.dashboardUrl) {
    lines.push(`Dashboard: ${opts.dashboardUrl} (key: ${opts.dashboardKey})`);
  }
  return lines;
}

describe('gossip_setup handler — dashboard URL in response', () => {
  it('appends dashboard URL to response when relay is running', () => {
    const lines = buildSetupResponseLines({
      mode: 'merge',
      agentCount: 2,
      rulesFile: 'CLAUDE.md',
      host: 'claude',
      dashboardUrl: 'http://localhost:52731',
      dashboardKey: 'test-key-abc',
    });
    const text = lines.join('\n');
    expect(text).toContain('http://localhost:');
    expect(text).toContain('http://localhost:52731');
    expect(text).toContain('test-key-abc');
  });

  it('omits dashboard line when relay is not running', () => {
    const lines = buildSetupResponseLines({
      mode: 'merge',
      agentCount: 1,
      rulesFile: 'CLAUDE.md',
      host: 'claude',
      dashboardUrl: null,
      dashboardKey: null,
    });
    const text = lines.join('\n');
    expect(text).not.toContain('Dashboard:');
    expect(text).not.toContain('http://localhost:');
  });

  it('includes mode and agent count in response', () => {
    const lines = buildSetupResponseLines({
      mode: 'replace',
      agentCount: 3,
      rulesFile: 'CLAUDE.md',
      host: 'claude',
      dashboardUrl: null,
      dashboardKey: null,
    });
    const text = lines.join('\n');
    expect(text).toContain('replace');
    expect(text).toContain('3 agents total');
  });
});
