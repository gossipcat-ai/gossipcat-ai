/**
 * Issue #697 — fail-closed guard on `gossip_signals` record: the orchestrator
 * (and reserved agent ids like `_system`) must never receive a scoring-class
 * signal.
 *
 * HANDBOOK invariant #14: the orchestrator stream carries PRECONDITIONS
 * (operational, auto-fired, never scored). Operator-authored process failures
 * go through `operational_lesson`. Nothing enforced that on the manual record
 * surface — 8 `hallucination_caught` rows landed against `agent_id:
 * 'orchestrator'`, pinning its accuracy to 0.00 and opening its circuit
 * breaker (see project_orchestrator_dispatch_weight_anomaly memory).
 *
 * Contract under test:
 *   (a) a scoring signal (e.g. `hallucination_caught`) against `orchestrator`
 *       is REJECTED, and the error names `operational_lesson`;
 *   (b) `operational_lesson` against `orchestrator` SUCCEEDS (it's the
 *       intended escape hatch);
 *   (c) a scoring signal against a normal agent id (e.g. `sonnet-reviewer`)
 *       SUCCEEDS — no over-reach onto real agents;
 *   (d) a scoring signal against a reserved id (`_system`) is REJECTED, but
 *       `_project` — the one reserved-looking id that is NOT reserved — is
 *       NOT protected by this guard (control case).
 *
 * Imports the real predicates (`isReservedAgentId`, `isOperationalRecordSignal`)
 * so the replica gate below cannot silently diverge from what they return. A
 * source-grep guard at the bottom pins the handler wiring in
 * mcp-server-sdk.ts, matching the existing pattern in
 * operational-lesson-id.test.ts / design-split-finding-id.test.ts (the full
 * MCP server handler is not directly invokable from a unit test — it awaits
 * `boot()` and a live `ctx`).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { isReservedAgentId } from '../../apps/cli/src/reserved-ids';
import { isOperationalRecordSignal } from '../../apps/cli/src/handlers/operational-lesson-id';

const HANDLER_SRC = join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts');

/**
 * Replica of the handler's orchestrator/reserved-agent guard
 * (mcp-server-sdk.ts, `action === 'record'` branch, immediately after the
 * signals-empty check). Returns the error text on rejection, null on pass —
 * built from the SAME imported predicates the handler uses, so this cannot
 * pass here while the real gate diverges.
 */
function guard(s: { signal: string; agent_id: string }): string | null {
  const protectedAgent = s.agent_id === 'orchestrator' || isReservedAgentId(s.agent_id);
  if (protectedAgent && !isOperationalRecordSignal(s.signal)) {
    return `Error: agent_id "${s.agent_id}" cannot receive scoring-class signal "${s.signal}" — the orchestrator/reserved stream carries operational signals only. Use signal:"operational_lesson" with finding_id "session:<sessionId>:<slug>" to record a process failure. (issue #697, HANDBOOK invariant #14)`;
  }
  return null;
}

describe('orchestrator/reserved-agent scoring guard (issue #697)', () => {
  it('rejects a scoring signal (hallucination_caught) against agent_id "orchestrator"', () => {
    const err = guard({ signal: 'hallucination_caught', agent_id: 'orchestrator' });
    expect(err).not.toBeNull();
    expect(err).toContain('operational_lesson');
    expect(err).toContain('orchestrator');
    expect(err).toContain('issue #697');
  });

  it('rejects disagreement against agent_id "orchestrator" too (not just hallucination_caught)', () => {
    const err = guard({ signal: 'disagreement', agent_id: 'orchestrator' });
    expect(err).not.toBeNull();
    expect(err).toContain('operational_lesson');
  });

  it('allows operational_lesson against agent_id "orchestrator"', () => {
    expect(guard({ signal: 'operational_lesson', agent_id: 'orchestrator' })).toBeNull();
  });

  it('allows design_split against agent_id "orchestrator" (issue #696, orchestrator as a named side)', () => {
    expect(guard({ signal: 'design_split', agent_id: 'orchestrator' })).toBeNull();
  });

  it('allows a scoring signal against a normal agent id (no over-reach)', () => {
    expect(guard({ signal: 'hallucination_caught', agent_id: 'sonnet-reviewer' })).toBeNull();
  });

  it('rejects a scoring signal against a reserved id (_system)', () => {
    const err = guard({ signal: 'hallucination_caught', agent_id: '_system' });
    expect(err).not.toBeNull();
    expect(err).toContain('operational_lesson');
  });

  it('allows operational_lesson against a reserved id (_system)', () => {
    expect(guard({ signal: 'operational_lesson', agent_id: '_system' })).toBeNull();
  });

  it('control: "_project" is NOT a protected id — a scoring signal against it passes', () => {
    expect(isReservedAgentId('_project')).toBe(false);
    expect(guard({ signal: 'hallucination_caught', agent_id: '_project' })).toBeNull();
  });
});

describe('gossip_signals handler wiring — guard is present and fires early (issue #697)', () => {
  const src = readFileSync(HANDLER_SRC, 'utf-8');

  it('checks the protected-agent condition using isReservedAgentId and the orchestrator literal', () => {
    expect(src).toContain("s.agent_id === 'orchestrator' || isReservedAgentId(s.agent_id)");
  });

  it('gates on isOperationalRecordSignal, not a hand-rolled signal list', () => {
    expect(src).toContain('!isOperationalRecordSignal(s.signal)');
  });

  it('the rejection message names operational_lesson and the session finding_id shape', () => {
    expect(src).toContain('cannot receive scoring-class signal');
    expect(src).toContain('Use signal:"operational_lesson" with finding_id "session:<sessionId>:<slug>"');
    expect(src).toContain('issue #697, HANDBOOK invariant #14');
  });

  it('the guard runs BEFORE the try block that emits/persists signals', () => {
    const guardIdx = src.indexOf('Orchestrator/reserved-agent scoring guard');
    const noSignalsIdx = src.indexOf('No signals to record. Provide a signals array.');
    const tryIdx = src.indexOf('const { emitConsensusSignals: emitRecordConsensusSignals');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(noSignalsIdx).toBeGreaterThan(-1);
    expect(tryIdx).toBeGreaterThan(-1);
    // Guard comes after the empty-signals check and before signals are formatted/persisted.
    expect(guardIdx).toBeGreaterThan(noSignalsIdx);
    expect(guardIdx).toBeLessThan(tryIdx);
  });
});
