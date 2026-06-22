/**
 * Regression test for issue #545 — gossip_verify_memory / gossip_plan re-entry
 * failed with `INCONCLUSIVE: unknown _utility_task_id`.
 *
 * Root cause: dispatch paths stashed re-entry data and scheduled eviction at
 * `UTILITY_RESULT_TTL_MS` (24h) regardless of which result map the result lands
 * in. verify_memory and gossip_plan results go to `ctx.nativeResultMap`, swept
 * at `NATIVE_TASK_TTL_MS` (2h). The stash was evicted after 2h but the
 * re-entry code expected the result to still be alive for 24h — a 22h window
 * where the stash was gone but the result was not.
 *
 * The principle: EACH stash's TTL must equal its result map's TTL.
 * - verify_memory  → ctx.nativeResultMap → NATIVE_TASK_TTL_MS (2h)
 * - gossip_plan    → ctx.nativeResultMap → NATIVE_TASK_TTL_MS (2h)
 * - skill_develop  → ctx.nativeUtilityResultMap → UTILITY_RESULT_TTL_MS (24h)
 * - session_summary → ctx.nativeResultMap → NATIVE_TASK_TTL_MS (2h)
 *
 * The verify_memory tool wrapper cannot be driven end-to-end under jest: its
 * dispatch branch does `await import('./handlers/verify-memory.js')` and the
 * test harness has no `.js`→`.ts` module mapper (the existing fixture suite
 * documents this and tests the pure handler functions instead). So this suite
 * guards the eviction MECHANICS at the source level — the same drift-guard
 * pattern used by the `utility-task task.created log-hygiene` suite in
 * native-utility.test.ts. The exported TTL constant values are also asserted at
 * runtime so future edits to the literals flip this red.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { UTILITY_RESULT_TTL_MS } from '../../apps/cli/src/handlers/native-tasks';
import { NATIVE_TASK_TTL_MS } from '../../apps/cli/src/mcp-context';

const MCP_SRC = resolve(__dirname, '../../apps/cli/src/mcp-server-sdk.ts');
const source = readFileSync(MCP_SRC, 'utf8');

const OLD_STASH_TTL_MS = 120_000 + 30_000; // the buggy 150s eviction mark

/**
 * Extract the body of the `setTimeout(() => { ... }, <delay>).unref()` block
 * that contains the given stash-map delete call. Returns the matched block text
 * plus the delay expression so tests can assert both the contents and the TTL.
 *
 * The interior regex explicitly rejects any nested `setTimeout(` so the match
 * cannot span across two adjacent eviction blocks. Each match must be <500 chars
 * (verified by assertion inside the helper) to catch runaway captures early.
 */
function evictionBlockFor(stashMap: string): { block: string; delay: string } {
  const interior = `((?:(?!setTimeout\\()[\\s\\S])*?${stashMap}\\.delete(?:(?!setTimeout\\()[\\s\\S])*?)`;
  const re = new RegExp(
    `setTimeout\\(\\(\\)\\s*=>\\s*\\{${interior}\\}\\s*,\\s*([A-Za-z0-9_ +]+?)\\)\\.unref\\(\\)`,
    'g'
  );
  const matches = [...source.matchAll(re)];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one eviction block deleting ${stashMap}, found ${matches.length}`
    );
  }
  const block = matches[0][1];
  const delay = matches[0][2].trim();
  if (block.length >= 500) {
    throw new Error(
      `eviction block for ${stashMap} is suspiciously wide (${block.length} chars >= 500) — likely spanning multiple eviction sites`
    );
  }
  return { block, delay };
}

describe('gossip stash eviction TTL — per-map alignment (issue #545)', () => {
  it('exports a 24h UTILITY_RESULT_TTL_MS from native-tasks', () => {
    expect(UTILITY_RESULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    // Must be far longer than the buggy 150s mark so a slow re-entry survives.
    expect(UTILITY_RESULT_TTL_MS).toBeGreaterThan(OLD_STASH_TTL_MS);
  });

  it('exports a 2h NATIVE_TASK_TTL_MS from mcp-context', () => {
    expect(NATIVE_TASK_TTL_MS).toBe(2 * 60 * 60 * 1000);
  });

  it('mcp-server-sdk imports UTILITY_RESULT_TTL_MS from native-tasks', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bUTILITY_RESULT_TTL_MS\b[^}]*\}\s*from\s*'\.\/handlers\/native-tasks'/
    );
  });

  it('mcp-server-sdk imports NATIVE_TASK_TTL_MS from mcp-context', () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bNATIVE_TASK_TTL_MS\b[^}]*\}\s*from\s*'\.\/mcp-context'/
    );
  });

  it('_pendingVerifyData stash eviction uses NATIVE_TASK_TTL_MS (verify_memory → nativeResultMap, 2h)', () => {
    const { block, delay } = evictionBlockFor('_pendingVerifyData');
    expect(delay).toBe('NATIVE_TASK_TTL_MS');
    expect(block).toContain('_utilityGuardSnapshots.delete');
  });

  it('_pendingPlanData stash eviction uses NATIVE_TASK_TTL_MS (gossip_plan → nativeResultMap, 2h)', () => {
    const { block, delay } = evictionBlockFor('_pendingPlanData');
    expect(delay).toBe('NATIVE_TASK_TTL_MS');
    expect(block).toContain('_utilityGuardSnapshots.delete');
  });

  it('_pendingSkillData stash eviction uses UTILITY_RESULT_TTL_MS (skill_develop → nativeUtilityResultMap, 24h)', () => {
    const { block, delay } = evictionBlockFor('_pendingSkillData');
    expect(delay).toBe('UTILITY_RESULT_TTL_MS');
    expect(block).toContain('_utilityGuardSnapshots.delete');
  });

  it('_pendingSessionData stash eviction uses NATIVE_TASK_TTL_MS (session_summary → nativeResultMap, 2h)', () => {
    const { block, delay } = evictionBlockFor('_pendingSessionData');
    expect(delay).toBe('NATIVE_TASK_TTL_MS');
    expect(block).toContain('_utilityGuardSnapshots.delete');
  });

  it('the buggy STASH_TTL_MS = UTILITY_TTL_MS + 30_000 eviction is no longer scheduled', () => {
    // Guard against a regression that reintroduces the 150s eviction mark.
    expect(source).not.toMatch(
      /const STASH_TTL_MS = UTILITY_TTL_MS \+ 30_000;\s*setTimeout/
    );
  });
});
