/**
 * Unit tests for packages/orchestrator/src/skill-freshness.ts.
 *
 * Covers: readSkillFreshness, computeCooldown, formatCooldownMessage.
 * File I/O is mocked at the fs boundary via jest.mock('fs').
 */
import { existsSync, readFileSync } from 'fs';

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
  };
});

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;

import {
  readSkillFreshness,
  computeCooldown,
  formatCooldownMessage,
} from '../../packages/orchestrator/src/skill-freshness';

const DAY_MS = 24 * 60 * 60 * 1_000;
const SKILL_ROOT = '/project';
const AGENT_ID = 'gemini-reviewer';
const CATEGORY = 'trust_boundaries';
const SKILL_PATH = `/project/.gossip/agents/${AGENT_ID}/skills/trust-boundaries.md`;

function makeSkillContent(boundAt: string | null, status: string | null): string {
  const fields = [
    'name: trust-boundaries',
    'description: test skill',
    'keywords: [trust]',
    boundAt ? `bound_at: ${boundAt}` : '',
    status ? `status: ${status}` : '',
  ].filter(Boolean).join('\n');
  return `---\n${fields}\n---\n\n## Iron Law\n`;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── readSkillFreshness — file missing ─────────────────────────────────────

describe('readSkillFreshness — file missing', () => {
  it('returns {boundAt: null, status: null} when skill file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const result = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    expect(result.boundAt).toBeNull();
    expect(result.status).toBeNull();
    expect(result.path).toBe(SKILL_PATH);
  });
});

// ── readSkillFreshness — file present ─────────────────────────────────────

describe('readSkillFreshness — file present', () => {
  it('parses boundAt and status correctly from frontmatter', () => {
    const boundAt = '2026-04-01T10:00:00.000Z';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeSkillContent(boundAt, 'insufficient_evidence') as any);

    const result = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    expect(result.boundAt).toBe(boundAt);
    expect(result.status).toBe('insufficient_evidence');
    expect(result.path).toBe(SKILL_PATH);
  });

  it('returns boundAt: null when bound_at field is absent (pre-schema file)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeSkillContent(null, 'pending') as any);

    const result = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    expect(result.boundAt).toBeNull();
    expect(result.status).toBe('pending');
  });

  it('returns status: null when status field is absent', () => {
    const boundAt = '2026-04-14T00:00:00.000Z';
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeSkillContent(boundAt, null) as any);

    const result = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    expect(result.boundAt).toBe(boundAt);
    expect(result.status).toBeNull();
  });

  it('returns both null when file has no frontmatter block', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('# Just some markdown\n\nNo frontmatter here.\n' as any);

    const result = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    expect(result.boundAt).toBeNull();
    expect(result.status).toBeNull();
  });
});

// ── computeCooldown — discriminated union ─────────────────────────────────

describe('computeCooldown', () => {
  // Spec test #11: null → pre_schema
  it('returns {kind: "pre_schema"} for null status (no status field in file)', () => {
    expect(computeCooldown(null)).toEqual({ kind: 'pre_schema' });
  });

  // Spec test #10: pending → no_cooldown
  it('returns {kind: "no_cooldown", status: "pending"} for pending (evidence still accumulating)', () => {
    expect(computeCooldown('pending')).toEqual({ kind: 'no_cooldown', status: 'pending' });
  });

  // Spec test #12: insufficient_evidence → cooldown 30d
  it('returns {kind: "cooldown", cooldownMs: 30d} for insufficient_evidence', () => {
    expect(computeCooldown('insufficient_evidence')).toEqual({
      kind: 'cooldown',
      status: 'insufficient_evidence',
      cooldownMs: 30 * DAY_MS,
    });
  });

  it('returns {kind: "cooldown", cooldownMs: 30d} for silent_skill', () => {
    expect(computeCooldown('silent_skill')).toEqual({
      kind: 'cooldown',
      status: 'silent_skill',
      cooldownMs: 30 * DAY_MS,
    });
  });

  it('returns {kind: "cooldown", cooldownMs: 60d} for inconclusive', () => {
    expect(computeCooldown('inconclusive')).toEqual({
      kind: 'cooldown',
      status: 'inconclusive',
      cooldownMs: 60 * DAY_MS,
    });
  });

  it('returns {kind: "cooldown", cooldownMs: Infinity} for passed (terminal state)', () => {
    expect(computeCooldown('passed')).toEqual({ kind: 'cooldown', status: 'passed', cooldownMs: Infinity });
  });

  it('returns {kind: "cooldown", cooldownMs: Infinity} for failed (terminal state)', () => {
    expect(computeCooldown('failed')).toEqual({ kind: 'cooldown', status: 'failed', cooldownMs: Infinity });
  });

  it('returns {kind: "no_cooldown"} for unknown/future status (forward-compatible)', () => {
    const r1 = computeCooldown('flagged_for_manual_review');
    expect(r1.kind).toBe('no_cooldown');
    const r2 = computeCooldown('some_future_status');
    expect(r2.kind).toBe('no_cooldown');
  });
});

// ── formatCooldownMessage ──────────────────────────────────────────────────

describe('formatCooldownMessage', () => {
  const BOUND_AT = '2026-04-14T12:00:00.000Z';

  it('includes agent_id, category, bound_at, status, remaining duration, and override instruction', () => {
    const remainingMs = 7 * DAY_MS;
    const msg = formatCooldownMessage(AGENT_ID, CATEGORY, BOUND_AT, 'insufficient_evidence', remainingMs);

    expect(msg).toContain(AGENT_ID);
    expect(msg).toContain(CATEGORY);
    expect(msg).toContain(BOUND_AT);
    expect(msg).toContain('insufficient_evidence');
    expect(msg).toContain('7 day(s)');
    expect(msg).toContain('force: true');
  });

  it('uses hours when remaining < 1 day', () => {
    const remainingMs = 3 * 60 * 60 * 1_000; // 3 hours
    const msg = formatCooldownMessage(AGENT_ID, CATEGORY, BOUND_AT, 'silent_skill', remainingMs);
    expect(msg).toContain('3 hour(s)');
  });

  it('shows terminal-state override note for passed status', () => {
    const msg = formatCooldownMessage(AGENT_ID, CATEGORY, BOUND_AT, 'passed', Infinity);
    expect(msg).toContain('terminal state');
    expect(msg).toContain('force: true');
  });

  it('shows terminal-state override note for failed status', () => {
    const msg = formatCooldownMessage(AGENT_ID, CATEGORY, BOUND_AT, 'failed', Infinity);
    expect(msg).toContain('terminal state');
  });
});
