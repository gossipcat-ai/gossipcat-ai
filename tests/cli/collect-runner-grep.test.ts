/**
 * Source-level grep regression: ensures scheduleSkillRunner remains wired into
 * BOTH the early-return (two-phase native-prompt) path AND the post-consensus
 * tail of handleCollect. A future refactor that drops the early-return call
 * silently re-introduces the production-common runner-bypass bug fixed by
 * consensus 4bd62d6c-46fd4e55. Cheap structural assertion — runs in
 * milliseconds, doesn't load the handler.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const collectSrc = readFileSync(
  join(__dirname, '../../apps/cli/src/handlers/collect.ts'),
  'utf8',
);

describe('handlers/collect.ts — scheduleSkillRunner wiring', () => {
  test('scheduleSkillRunner is invoked from BOTH the early-return path and the post-consensus tail', () => {
    const callMatches = collectSrc
      .split('\n')
      .filter((l) => /scheduleSkillRunner\s*\(/.test(l) && !l.includes('export function'))
      .length;
    expect(callMatches).toBeGreaterThanOrEqual(2);
  });

  test('scheduleSkillRunner appears within 5 lines BEFORE the early-return partial-output return', () => {
    const lines = collectSrc.split('\n');
    const earlyReturnIdx = lines.findIndex((l) =>
      l.includes("return { content: [{ type: 'text' as const, text: partialOutput }] };"),
    );
    expect(earlyReturnIdx).toBeGreaterThan(0);
    const window = lines.slice(Math.max(0, earlyReturnIdx - 5), earlyReturnIdx);
    expect(window.some((l) => /scheduleSkillRunner\s*\(/.test(l))).toBe(true);
  });
});
