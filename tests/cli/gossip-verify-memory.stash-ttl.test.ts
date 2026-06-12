/**
 * Regression test for issue #545 — gossip_verify_memory re-entry failed with
 * `INCONCLUSIVE: unknown _utility_task_id ... (not a verify_memory dispatch)`.
 *
 * Root cause: the dispatch path stashed re-entry data in the module-private
 * `_pendingVerifyData` map and scheduled an eviction after
 * `STASH_TTL_MS = UTILITY_TTL_MS + 30_000` = 150s. The documented 3-step
 * protocol (dispatch → run haiku Agent → gossip_relay → re-call with
 * `_utility_task_id`) routinely takes longer than 150s because the haiku agent
 * alone runs 1-3+ minutes. When the re-call arrived after 150s the stash was
 * already gone, so the re-entry guard returned INCONCLUSIVE even though the
 * relayed result was sitting healthy in `ctx.nativeResultMap` (utility results
 * have a 24h TTL by design).
 *
 * The fix aligns the stash eviction with `UTILITY_RESULT_TTL_MS` (24h) so the
 * stash outlives the slow re-entry, and evicts the guard snapshot on the same
 * schedule so it does not leak when re-entry never happens.
 *
 * The verify_memory tool wrapper cannot be driven end-to-end under jest: its
 * dispatch branch does `await import('./handlers/verify-memory.js')` and the
 * test harness has no `.js`→`.ts` module mapper (the existing fixture suite
 * documents this and tests the pure handler functions instead). So this suite
 * guards the eviction MECHANICS at the source level — the same drift-guard
 * pattern used by the `utility-task task.created log-hygiene` suite in
 * native-utility.test.ts. The exported TTL constant's value is also asserted at
 * runtime so a future edit to the literal flips this red.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { UTILITY_RESULT_TTL_MS } from '../../apps/cli/src/handlers/native-tasks';

const MCP_SRC = resolve(__dirname, '../../apps/cli/src/mcp-server-sdk.ts');
const source = readFileSync(MCP_SRC, 'utf8');

const OLD_STASH_TTL_MS = 120_000 + 30_000; // the buggy 150s eviction mark

/**
 * Extract the body of the `setTimeout(() => { ... }, <delay>).unref()` block
 * that contains the given stash-map delete call. Returns the matched block text
 * plus the delay expression so tests can assert both the contents and the TTL.
 */
function evictionBlockFor(stashMap: string): { block: string; delay: string } {
  const re = new RegExp(
    `setTimeout\\(\\(\\)\\s*=>\\s*\\{([\\s\\S]*?${stashMap}\\.delete[\\s\\S]*?)\\}\\s*,\\s*([A-Za-z0-9_ +]+?)\\)\\.unref\\(\\)`,
    'g'
  );
  const matches = [...source.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one eviction block deleting ${stashMap}, found ${matches.length}`
    );
  }
  return { block: matches[0][1], delay: matches[0][2].trim() };
}

describe('gossip_verify_memory — stash eviction TTL (issue #545)', () => {
  it('exports a 24h UTILITY_RESULT_TTL_MS from native-tasks', () => {
    expect(UTILITY_RESULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    // Must be far longer than the buggy 150s mark so a slow re-entry survives.
    expect(UTILITY_RESULT_TTL_MS).toBeGreaterThan(OLD_STASH_TTL_MS);
  });

  it('mcp-server-sdk imports UTILITY_RESULT_TTL_MS from native-tasks', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bUTILITY_RESULT_TTL_MS\b[^}]*\}\s*from\s*'\.\/handlers\/native-tasks'/
    );
  });

  it('verify_memory stash eviction uses UTILITY_RESULT_TTL_MS, not the old 150s STASH_TTL', () => {
    const { block, delay } = evictionBlockFor('_pendingVerifyData');
    expect(delay).toBe('UTILITY_RESULT_TTL_MS');
    // The buggy literal must be gone from the eviction scheduling.
    expect(delay).not.toMatch(/UTILITY_TTL_MS\s*\+\s*30_000/);
    // Same callback must evict the guard snapshot so it cannot leak when the
    // orchestrator never re-enters.
    expect(block).toContain('_utilityGuardSnapshots.delete');
  });

  it('the buggy STASH_TTL_MS = UTILITY_TTL_MS + 30_000 eviction is no longer scheduled for verify_memory', () => {
    // Guard against a regression that reintroduces the 150s eviction mark.
    // (gossip_plan historically shared this literal; the #545 fix removed it
    // from both — so the pattern must not appear next to a stash .delete.)
    expect(source).not.toMatch(
      /const STASH_TTL_MS = UTILITY_TTL_MS \+ 30_000;\s*setTimeout/
    );
  });
});
