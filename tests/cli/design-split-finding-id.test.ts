/**
 * Issue #678 — `design_split` is the one signal that accepts BOTH `finding_id`
 * grammars.
 *
 * Contract under test:
 *   (a) consensus-scoped `<8hex>-<8hex>:...` — a split found inside a round;
 *   (b) session-scoped `session:<sessionId>:<slug>` — a split found in a
 *       PARALLEL dispatch, which has no consensus id (the issue notes this round
 *       had to mint a synthetic `<taskA>-<taskB>` pair to satisfy the validator);
 *   (c) anything matching NEITHER is still rejected — "accepts either" is not
 *       "accepts anything", and a malformed session id is rejected with the
 *       SESSION parse reason, not misdiagnosed as a bad consensus prefix;
 *   (d) `operational_lesson` stays session-ONLY — widening one signal must not
 *       widen the other.
 *
 * Imports the real validator, so handler logic changes cannot pass here while
 * breaking in production. Source-grep guards at the bottom pin the wiring that
 * unit tests cannot reach (zod enum, counterpart requirement, class stamp).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseOperationalFindingId,
  validateOperationalLessonSignal,
  isOperationalLessonSignal,
  isDesignSplitSignal,
  isOperationalRecordSignal,
  acceptsSessionScopedFindingId,
  FINDING_ID_FORMS_HELP,
  DESIGN_SPLIT_SIGNAL,
  OPERATIONAL_LESSON_SIGNAL,
} from '../../apps/cli/src/handlers/operational-lesson-id';

const HANDLER_SRC = join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts');
const FINDING_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}:/;

/** Replica of the handler's two-stage gate, including the #678 branch. */
function gate(s: { signal: string; agent_id: string; finding_id?: string; lesson?: string }): string | null {
  const opErr = validateOperationalLessonSignal(s);
  if (opErr) return opErr;
  if (isOperationalLessonSignal(s.signal)) return null;
  if (
    s.finding_id !== undefined &&
    acceptsSessionScopedFindingId(s.signal) &&
    parseOperationalFindingId(s.finding_id).kind === 'valid'
  ) return null;
  if (s.finding_id !== undefined && !FINDING_ID_PREFIX.test(s.finding_id)) {
    return `Error: malformed finding_id "${s.finding_id}" (agent: ${s.agent_id}). ${FINDING_ID_FORMS_HELP} See CLAUDE.md signal contract.`;
  }
  return null;
}

const split = (finding_id?: string) => ({
  signal: DESIGN_SPLIT_SIGNAL,
  agent_id: 'fable-reviewer',
  ...(finding_id === undefined ? {} : { finding_id }),
});

describe('design_split predicates', () => {
  it('identifies itself and is an operational record signal', () => {
    expect(isDesignSplitSignal(DESIGN_SPLIT_SIGNAL)).toBe(true);
    expect(isOperationalRecordSignal(DESIGN_SPLIT_SIGNAL)).toBe(true);
    expect(isOperationalRecordSignal(OPERATIONAL_LESSON_SIGNAL)).toBe(true);
  });

  it('does not bleed into the scoring signal names', () => {
    for (const name of ['agreement', 'disagreement', 'hallucination_caught', 'unique_confirmed']) {
      expect(isDesignSplitSignal(name)).toBe(false);
      expect(isOperationalRecordSignal(name)).toBe(false);
      expect(acceptsSessionScopedFindingId(name)).toBe(false);
    }
  });
});

describe('design_split accepts BOTH finding_id grammars', () => {
  it.each([
    ['b81956b2-e0fa4ea4:fable-reviewer:f1'],
    ['b81956b2-e0fa4ea4:f3'],
  ])('accepts the consensus-scoped %s', (findingId) => {
    expect(gate(split(findingId))).toBeNull();
  });

  it.each([
    ['session:2026-07-27-c0ffee01:conditioning-vs-independence'],
    ['session:b2a68971-28f7-4465-a6a8-1e270bac6f34:phase2-block-scope'],
  ])('accepts the session-scoped %s (parallel dispatch, no consensus id)', (findingId) => {
    expect(gate(split(findingId))).toBeNull();
  });

  it('accepts an absent finding_id (optional, same as other consensus signals)', () => {
    expect(gate(split())).toBeNull();
  });

  it('needs no lesson, unlike operational_lesson', () => {
    // The lesson requirement exists because a lesson card is the lesson
    // signal's entire payload. A split's payload is the two positions in
    // `finding`, so requiring `lesson` here would be cargo-culted.
    expect(gate(split('session:s1:tradeoff'))).toBeNull();
  });
});

describe('design_split still rejects malformed ids (fail-closed both ways)', () => {
  it.each([
    ['garbage'],
    ['f1'],
    ['deadbeef:f1'],
    ['zzzzzzzz-e0fa4ea4:f1'],
  ])('rejects %s — matches neither grammar', (findingId) => {
    const err = gate(split(findingId));
    expect(err).not.toBeNull();
    expect(err).toContain('malformed finding_id');
  });

  it.each([
    ['session:only-one'],
    ['session:s1:slug:extra'],
  ])('rejects the malformed session-scoped %s with the SESSION parse reason', (findingId) => {
    const err = gate(split(findingId));
    expect(err).not.toBeNull();
    expect(err).toContain('malformed finding_id');
    // Misdiagnosis guard: falling through to the consensus gate would say
    // "expected <8hex>-<8hex>", which sends the operator to fix the wrong half.
    expect(err).toMatch(/exactly 2 components|not a safe path segment/);
  });

  it.each([
    ['session:../etc:slug'],
    ['session:s1:../../escape'],
    ['session:S1:UPPER'],
  ])('rejects the path-unsafe %s — never sanitized', (findingId) => {
    expect(parseOperationalFindingId(findingId).kind).toBe('invalid');
    expect(gate(split(findingId))).toContain('not a safe path segment');
  });
});

describe('widening design_split does not widen anything else', () => {
  it('operational_lesson still REJECTS a consensus-scoped id', () => {
    const err = gate({
      signal: OPERATIONAL_LESSON_SIGNAL,
      agent_id: 'orchestrator',
      finding_id: 'a38286c2-11111111:orchestrator:f2',
      lesson: 'x',
    });
    expect(err).toContain('requires a session-scoped finding_id');
  });

  it('a scoring signal still REJECTS a session-scoped id', () => {
    const err = gate({ signal: 'hallucination_caught', agent_id: 'a', finding_id: 'session:s1:x' });
    expect(err).not.toBeNull();
    expect(err).toContain('only valid for signals');
  });

  it('the two grammars stay disjoint by first token', () => {
    // `session` is not 8 hex chars, so no consensus id can ever open with it.
    expect(FINDING_ID_PREFIX.test('session:s1:x')).toBe(false);
    expect(parseOperationalFindingId('b81956b2-e0fa4ea4:a:f1').kind).toBe('not_operational');
  });
});

// ── Source-grep guards for wiring unit tests cannot reach ───────────────────

describe('gossip_signals handler wiring', () => {
  const src = readFileSync(HANDLER_SRC, 'utf8');

  it('exposes design_split on the record zod enum', () => {
    expect(src).toContain("'operational_lesson', 'design_split'");
  });

  it('documents that it records both sides and scores neither', () => {
    expect(src).toContain('records BOTH sides and scores NEITHER');
    expect(src).toContain('counterpart_id is REQUIRED');
  });

  it('documents the resolution-time contract in the tool description', () => {
    // Without this the operator has no way to learn that resolving a split is a
    // second signal on the same finding_id rather than an edit to this row.
    expect(src).toContain('RESOLUTION IS A SEPARATE, LATER SIGNAL');
    expect(src).toContain('against the SAME finding_id');
  });

  it('requires counterpart_id — a one-sided split reads as a verdict', () => {
    expect(src).toContain("'impl_peer_rejected', 'design_split'");
  });

  it('stamps signal_class operational via the shared predicate', () => {
    expect(src).toContain("isOperationalRecordSignal(s.signal) ? 'operational' : undefined");
  });

  it('skips the consensus prefix gate only for a VALID session-scoped id', () => {
    expect(src).toContain('acceptsSessionScopedFindingId(s.signal) &&');
    expect(src).toContain("parseOperationalFindingId(s.finding_id).kind === 'valid'");
  });

  it('counts splits separately in the receipt, never as negative', () => {
    expect(src).toContain('else if (isDesignSplitSignal(s.signal)) {');
    // The split branch must precede the positive/negative classification, or
    // the conservative else-branch reclaims it as the "-1" from the issue.
    const splitIdx = src.indexOf('else if (isDesignSplitSignal(s.signal)) {');
    const posIdx = src.indexOf('else if (POSITIVE_SIGNALS.has(s.signal)) entry.pos++;');
    expect(splitIdx).toBeGreaterThan(-1);
    expect(posIdx).toBeGreaterThan(splitIdx);
    expect(src).toContain('design split${splits === 1 ? \'\' : \'s\'}, unscored');
  });

  it('credits the counterpart as unscored too', () => {
    expect(src).toContain('if (counterpart && counterpart !== s.agentId) ensureEntry(counterpart).splits++;');
  });
});
