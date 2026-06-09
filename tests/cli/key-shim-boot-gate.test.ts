/**
 * Regression guard — key-shim-boot-gate.test.ts
 *
 * The `gossipcat key` subcommand runs inside the argv shim of mcp-server-sdk.ts
 * via a fire-and-forget async handler (top-level await is unavailable in the
 * CommonJS bundle). That handler returns synchronously while its work is still
 * pending, so module evaluation continues past the shim. If the MCP server boot
 * (`main()`) and the stderr→mcp.log redirect are NOT gated on the shim's
 * handled-flag, `gossipcat key set` would ALSO boot the MCP server, steal stdin
 * from the secret prompt, and redirect the prompt into mcp.log — silently
 * breaking the feature. These source-level assertions lock in the gate.
 *
 * Verified by reading source text only — no exec, no spawn.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

const SRC = readFileSync(
  resolve(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
  'utf-8',
);

describe('argv shim boot gate', () => {
  it('declares the handled-flag from the argv shim IIFE', () => {
    expect(SRC).toMatch(/const __argvShimHandled = \(\(\) =>/);
  });

  it('the `key` branch returns true so the async handler owns the process', () => {
    // The key branch must signal "handled" so the boot below is suppressed.
    expect(SRC).toMatch(/if \(sub === 'key'\)/);
    expect(SRC).toMatch(/return true;.*async handler owns the process|async handler owns the process[\s\S]*return true;/);
  });

  it('gates main() invocation on !__argvShimHandled (no boot when key handled)', () => {
    expect(SRC).toMatch(
      /process\.env\.GOSSIPCAT_MCP_NO_MAIN !== '1' && !__argvShimHandled[\s\S]*main\(\)\.catch/,
    );
  });

  it('gates the stderr→mcp.log redirect on !__argvShimHandled', () => {
    // Two blocks guard on the same condition; assert it appears at least twice.
    const matches = SRC.match(
      /process\.env\.GOSSIPCAT_MCP_NO_MAIN !== '1' && !__argvShimHandled/g,
    );
    expect(matches && matches.length).toBeGreaterThanOrEqual(2);
  });
});
