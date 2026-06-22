/**
 * Unit tests for isParallelHeadRaceWriteIntent — the predicate behind the
 * issue #434 hard guard that blocks two+ native write-intent tasks in
 * mode:'parallel' (they share .git/HEAD in process.cwd() and clobber each
 * other's branch). Design consensus 974a1bb2-de854fb4.
 *
 * The predicate is what makes the guard safe to ship: it must catch the
 * dangerous implementer/sequential case WITHOUT firing on legitimate parallel
 * review/consensus dispatch (reviewers omit write_mode and don't end in
 * `-implementer`), and must exclude the safe modes (worktree isolates, scoped
 * does no agent git).
 */

import { isParallelHeadRaceWriteIntent } from '../../apps/cli/src/handlers/dispatch';

describe('isParallelHeadRaceWriteIntent', () => {
  it('matches explicit write_mode:"sequential" (any agent)', () => {
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'sonnet-implementer', write_mode: 'sequential' })).toBe(true);
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'some-custom-writer', write_mode: 'sequential' })).toBe(true);
  });

  it('matches an implementer (by -implementer suffix) with omitted write_mode', () => {
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'opus-implementer' })).toBe(true);
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'sonnet-implementer', write_mode: undefined })).toBe(true);
  });

  it('does NOT match read-only reviewers with omitted write_mode (parallel review is safe)', () => {
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'sonnet-reviewer' })).toBe(false);
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'haiku-researcher', write_mode: undefined })).toBe(false);
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'gemini-tester' })).toBe(false);
  });

  it('does NOT match safe write modes: worktree (own .git) and scoped (no agent git)', () => {
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'opus-implementer', write_mode: 'worktree' })).toBe(false);
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'opus-implementer', write_mode: 'scoped' })).toBe(false);
  });

  it('suffix match is exact: a non-suffixed implementer-ish name with omitted write_mode does NOT match', () => {
    // invariant #10 is suffix-only; a name that merely contains "implementer"
    // mid-string is not gated (consistent with IMPLEMENTER_PERMANENT_DEFAULTS).
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'implementer-helper' })).toBe(false);
    expect(isParallelHeadRaceWriteIntent({ agent_id: 'my-impl' })).toBe(false);
  });

  it('guard threshold semantics: a mixed batch counts only write-intent natives', () => {
    // Mirrors the handler's `nativeTasks.filter(isParallelHeadRaceWriteIntent).length >= 2`.
    const batch = [
      { agent_id: 'opus-implementer' },                          // write-intent (default impl)
      { agent_id: 'sonnet-implementer', write_mode: 'sequential' }, // write-intent (explicit)
      { agent_id: 'sonnet-reviewer' },                            // not (reviewer)
      { agent_id: 'opus-implementer', write_mode: 'worktree' },   // not (safe)
    ];
    expect(batch.filter(isParallelHeadRaceWriteIntent).length).toBe(2);

    const safeBatch = [
      { agent_id: 'sonnet-reviewer' },
      { agent_id: 'haiku-researcher' },
      { agent_id: 'opus-implementer', write_mode: 'worktree' },
    ];
    expect(safeBatch.filter(isParallelHeadRaceWriteIntent).length).toBe(0);
  });
});
