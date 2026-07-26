/**
 * Issue #668 — session-scoped `finding_id` for operator-authored process lessons.
 *
 * Contract under test (apps/cli/src/handlers/operational-lesson-id.ts):
 *   (a) the consensus-scoped shape `<8hex>-<8hex>:...` keeps working EXACTLY as
 *       before for consensus signals — this is the primary contract;
 *   (b) `operational_lesson` accepts `session:<sessionId>:<slug>` instead;
 *   (c) anything else is REJECTED with a message naming BOTH forms;
 *   (d) a path-unsafe component is REJECTED, never sanitized.
 *
 * Unlike the older replica-style tests in mcp-signals-finding-id.test.ts, these
 * import the real validator, so a change to the handler's logic cannot pass here
 * while breaking in production. A source-grep guard at the bottom pins the
 * handler wiring.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseOperationalFindingId,
  validateOperationalLessonSignal,
  isOperationalLessonSignal,
  FINDING_ID_FORMS_HELP,
  OPERATIONAL_LESSON_SIGNAL,
} from '../../apps/cli/src/handlers/operational-lesson-id';

const HANDLER_SRC = join(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts');

/** Replica of the handler's consensus gate — proves the two grammars compose. */
const FINDING_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}:/;

/**
 * Full two-stage gate exactly as mcp-server-sdk.ts runs it: the operational
 * validator first, then the untouched consensus-prefix check.
 */
function gate(s: { signal: string; agent_id: string; finding_id?: string; lesson?: string }): string | null {
  const opErr = validateOperationalLessonSignal(s);
  if (opErr) return opErr;
  if (isOperationalLessonSignal(s.signal)) return null;
  if (s.finding_id !== undefined && !FINDING_ID_PREFIX.test(s.finding_id)) {
    return `Error: malformed finding_id "${s.finding_id}" (agent: ${s.agent_id}). ${FINDING_ID_FORMS_HELP} See CLAUDE.md signal contract.`;
  }
  return null;
}

// ── 1. The new operational shape is ACCEPTED ────────────────────────────────

describe('operational finding_id — accepted shape', () => {
  it('accepts session:<sessionId>:<slug> on an operational_lesson', () => {
    expect(gate({
      signal: OPERATIONAL_LESSON_SIGNAL,
      agent_id: 'orchestrator',
      finding_id: 'session:2026-07-26-a38286c2:relay-window-expired',
      lesson: 'Four native relay windows expired, so merged work produced no cognitive summaries.',
    })).toBeNull();
  });

  it('accepts a UUID sessionId', () => {
    const parsed = parseOperationalFindingId('session:b2a68971-28f7-4465-a6a8-1e270bac6f34:branch-switched-under-reviewers');
    expect(parsed.kind).toBe('valid');
    expect(parsed).toMatchObject({ sessionId: 'b2a68971-28f7-4465-a6a8-1e270bac6f34', slug: 'branch-switched-under-reviewers' });
  });

  it('accepts underscores in both components', () => {
    expect(parseOperationalFindingId('session:s_1:worktree_dist_mcp_zod').kind).toBe('valid');
  });
});

// ── 2. The consensus shape still works UNCHANGED ────────────────────────────

describe('consensus finding_id — unchanged primary contract', () => {
  it.each([
    ['b81956b2-e0fa4ea4:f1'],
    ['b81956b2-e0fa4ea4:sonnet-reviewer:f1'],
    ['b81956b2-e0fa4ea4:gemini-reviewer:n2'],
  ])('still accepts %s on a consensus signal', (findingId) => {
    expect(gate({ signal: 'hallucination_caught', agent_id: 'sonnet-reviewer', finding_id: findingId })).toBeNull();
  });

  it('still accepts an ABSENT finding_id on a consensus signal', () => {
    expect(gate({ signal: 'agreement', agent_id: 'a' })).toBeNull();
  });

  it('a consensus id is never mistaken for the operational form', () => {
    expect(parseOperationalFindingId('b81956b2-e0fa4ea4:sonnet-reviewer:f1').kind).toBe('not_operational');
  });

  it('rejects the session-scoped form on a NON-operational signal', () => {
    const err = gate({ signal: 'agreement', agent_id: 'a', finding_id: 'session:s1:lesson' });
    expect(err).not.toBeNull();
    expect(err).toContain('only valid for signal "operational_lesson"');
  });
});

// ── 3. Malformed shapes are still REJECTED, naming BOTH forms ───────────────

describe('malformed finding_id — fail-closed, names both accepted forms', () => {
  it.each([
    ['f1'],
    ['deadbeef:f1'],
    ['zzzzzzzz-e0fa4ea4:f1'],
    ['garbage'],
  ])('rejects %s on a consensus signal', (findingId) => {
    const err = gate({ signal: 'hallucination_caught', agent_id: 'a', finding_id: findingId });
    expect(err).not.toBeNull();
    expect(err).toContain('malformed finding_id');
  });

  it('the rejection message names BOTH accepted forms', () => {
    const err = gate({ signal: 'hallucination_caught', agent_id: 'a', finding_id: 'garbage' })!;
    expect(err).toContain('<8hex>-<8hex>');
    expect(err).toContain('session:<sessionId>:<slug>');
  });

  it('rejects a session id with too few components', () => {
    const parsed = parseOperationalFindingId('session:only-one');
    expect(parsed.kind).toBe('invalid');
    expect(parsed).toMatchObject({ reason: expect.stringContaining('exactly 2 components') });
  });

  it('rejects a session id with too many components (no silent truncation)', () => {
    expect(parseOperationalFindingId('session:s1:slug:extra').kind).toBe('invalid');
  });

  it('rejects an operational_lesson with a consensus-scoped id', () => {
    const err = gate({
      signal: OPERATIONAL_LESSON_SIGNAL,
      agent_id: 'orchestrator',
      finding_id: 'a38286c2-11111111:orchestrator:f2',
      lesson: 'x',
    });
    expect(err).not.toBeNull();
    expect(err).toContain('requires a session-scoped finding_id');
  });

  it('rejects an operational_lesson with no finding_id at all', () => {
    const err = gate({ signal: OPERATIONAL_LESSON_SIGNAL, agent_id: 'orchestrator', lesson: 'x' });
    expect(err).not.toBeNull();
    expect(err).toContain('requires a finding_id');
  });
});

// ── 4. Path-unsafe components are REJECTED, not sanitized ───────────────────

describe('path safety — reject, never sanitize-and-continue', () => {
  const HOSTILE: Array<[string, string]> = [
    ['parent escape in slug', 'session:s1:../../etc/passwd'],
    ['parent escape in sessionId', 'session:../..:slug'],
    ['forward slash in slug', 'session:s1:a/b'],
    ['backslash in slug', 'session:s1:a\\b'],
    ['space in slug', 'session:s1:a b'],
    ['NUL byte in slug', 'session:s1:a\0b'],
    ['leading dot in slug', 'session:s1:.hidden'],
    ['uppercase in slug', 'session:s1:Slug'],
    ['empty slug', 'session:s1:'],
    ['empty sessionId', 'session::slug'],
    ['over-long slug', `session:s1:${'a'.repeat(64)}`],
  ];

  it.each(HOSTILE)('rejects %s', (_label, findingId) => {
    expect(parseOperationalFindingId(findingId).kind).toBe('invalid');
  });

  it.each(HOSTILE)('the full gate also rejects %s (no sanitized fallback)', (_label, findingId) => {
    const err = gate({
      signal: OPERATIONAL_LESSON_SIGNAL, agent_id: 'orchestrator', finding_id: findingId, lesson: 'x',
    });
    expect(err).not.toBeNull();
    expect(err).toContain('malformed finding_id');
  });

  it('names the offending component so the operator can fix it', () => {
    const err = gate({
      signal: OPERATIONAL_LESSON_SIGNAL, agent_id: 'orchestrator', finding_id: 'session:s1:../etc', lesson: 'x',
    })!;
    expect(err).toContain('<slug>');
    expect(err).toContain('not a safe path segment');
  });
});

// ── 5. lesson is REQUIRED on an operational lesson ──────────────────────────

describe('operational_lesson requires a lesson', () => {
  it.each([[undefined], [''], ['   ']])('rejects lesson=%p', (lesson) => {
    const err = gate({
      signal: OPERATIONAL_LESSON_SIGNAL,
      agent_id: 'orchestrator',
      finding_id: 'session:s1:slug',
      lesson: lesson as string | undefined,
    });
    expect(err).not.toBeNull();
    expect(err).toContain('requires a non-empty lesson');
  });

  it('does NOT require a lesson on consensus signals (back-compat)', () => {
    expect(gate({ signal: 'agreement', agent_id: 'a', finding_id: 'b81956b2-e0fa4ea4:f1' })).toBeNull();
  });
});

// ── 6. Handler wiring guard ─────────────────────────────────────────────────

describe('gossip_signals handler wiring', () => {
  const src = readFileSync(HANDLER_SRC, 'utf-8');

  it('runs the operational validator before the consensus prefix gate', () => {
    expect(src).toContain('const opErr = validateOperationalLessonSignal(s);');
    expect(src).toContain('if (isOperationalLessonSignal(s.signal)) continue;');
  });

  it('keeps the consensus prefix gate byte-identical', () => {
    expect(src).toContain('const FINDING_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{8}:/;');
    expect(src).toContain('!FINDING_ID_PREFIX.test(s.finding_id)');
    expect(src).toContain('malformed finding_id');
  });

  it('exposes operational_lesson and cross_cutting on the zod schema', () => {
    expect(src).toContain("'impl_peer_rejected', 'operational_lesson'");
    expect(src).toContain('cross_cutting: z.boolean().optional()');
  });
});
