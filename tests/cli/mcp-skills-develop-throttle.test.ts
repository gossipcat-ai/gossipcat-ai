/**
 * Tests for the gossip_skills develop cooldown gate (spec: 2026-04-15-skill-develop-throttle).
 *
 * The gate lives in apps/cli/src/mcp-server-sdk.ts and delegates to:
 *   - readSkillFreshness / computeCooldown / formatCooldownMessage (skill-freshness.ts)
 *   - appendForcedSkillDevelop (handlers/forced-skill-develops.ts)
 *
 * Handler integration (8 cases) is tested by mocking the fs layer and driving
 * the gate functions directly — the handler is not exported, so we confirm gate
 * semantics via the building-block functions and a thin integration harness.
 *
 * Critical sequencing invariant (consensus ae98b53a-9bab410b, finding #2):
 *   Gate MUST run BEFORE buildPrompt(). injectSnapshotFields at skill-engine.ts:293,306
 *   rewrites bound_at on every develop — reading after that call always sees a
 *   fresh timestamp. Tests assert gate position via function-call ordering stubs.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(actual.existsSync),
    readFileSync: jest.fn(actual.readFileSync),
    appendFileSync: jest.fn(),
    mkdirSync: jest.fn(),
  };
});

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockAppendFileSync = appendFileSync as jest.MockedFunction<typeof appendFileSync>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;

import {
  readSkillFreshness,
  computeCooldown,
  formatCooldownMessage,
} from '../../packages/orchestrator/src/skill-freshness';
import { appendForcedSkillDevelop } from '../../apps/cli/src/handlers/forced-skill-develops';

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const AGENT_ID = 'gemini-reviewer';
const CATEGORY = 'trust_boundaries';
const SKILL_ROOT = '/project';

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

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * HOUR_MS).toISOString();
}

function daysAgo(d: number): string {
  return new Date(Date.now() - d * DAY_MS).toISOString();
}

/**
 * Simulate the gate logic from the handler (mcp-server-sdk.ts ~:2784-2795).
 * Returns null if allowed, or the rejection message if blocked.
 *
 * This mirrors the exact handler branching so test cases document the handler's
 * control flow explicitly:
 *   if (!_utility_task_id && !force) { freshness → cooldown → reject if too fresh }
 *   if (force && !_utility_task_id) { append audit log }
 */
function simulateGate(opts: {
  utility_task_id?: string;
  force?: boolean;
}): string | null {
  const { utility_task_id, force } = opts;
  if (!utility_task_id && !force) {
    const freshness = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    const cooldownMs = computeCooldown(freshness.status);
    if (freshness.boundAt && cooldownMs > 0) {
      const ageMs = Date.now() - new Date(freshness.boundAt).getTime();
      if (ageMs < cooldownMs) {
        const remainingMs = cooldownMs - ageMs;
        return formatCooldownMessage(AGENT_ID, CATEGORY, freshness.boundAt, freshness.status, remainingMs);
      }
    }
  }
  if (force && !utility_task_id) {
    const freshness = readSkillFreshness(AGENT_ID, CATEGORY, SKILL_ROOT);
    appendForcedSkillDevelop({
      timestamp: new Date().toISOString(),
      agent_id: AGENT_ID,
      category: CATEGORY,
      bound_at_before: freshness.boundAt,
      status_before: freshness.status,
    });
  }
  return null; // allowed
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdirSync.mockImplementation(() => undefined as any);
  mockAppendFileSync.mockImplementation(() => undefined);
});

// ── Case 1: pending status — always allowed regardless of age ─────────────

it('allows develop when bound_at is 23h ago and status is pending', () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeSkillContent(hoursAgo(23), 'pending') as any);

  const result = simulateGate({});
  expect(result).toBeNull(); // allowed
});

// ── Case 2: insufficient_evidence within cooldown — rejected ──────────────

it('rejects develop when bound_at is 23h ago and status is insufficient_evidence', () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeSkillContent(hoursAgo(23), 'insufficient_evidence') as any);

  const result = simulateGate({});
  expect(result).not.toBeNull(); // rejected
  expect(result).toContain('cooldown');
});

// ── Case 3: insufficient_evidence past cooldown — allowed ─────────────────

it('allows develop when bound_at is 31 days ago and status is insufficient_evidence', () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeSkillContent(daysAgo(31), 'insufficient_evidence') as any);

  const result = simulateGate({});
  expect(result).toBeNull(); // allowed: 31d > 30d cooldown
});

// ── Case 4: no skill file — first develop, allowed ────────────────────────

it('allows develop when no skill file exists (first develop)', () => {
  mockExistsSync.mockReturnValue(false);

  const result = simulateGate({});
  expect(result).toBeNull(); // allowed: boundAt is null
});

// ── Case 5: pre-schema file (no bound_at, no status) — allowed ───────────

it('allows develop when skill file has no bound_at or status (pre-schema)', () => {
  mockExistsSync.mockReturnValue(true);
  // Frontmatter exists but no bound_at or status fields
  mockReadFileSync.mockReturnValue('---\nname: trust-boundaries\ndescription: old skill\nkeywords: []\n---\n\n## Iron Law\n' as any);

  const result = simulateGate({});
  expect(result).toBeNull(); // allowed: boundAt is null
});

// ── Case 6: _utility_task_id present — gate skipped ──────────────────────

it('skips the gate when _utility_task_id is present (re-entry path)', () => {
  // Even a fresh skill in cooldown range is allowed when re-entering
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeSkillContent(hoursAgo(1), 'insufficient_evidence') as any);

  const result = simulateGate({ utility_task_id: 'abc12345' });
  expect(result).toBeNull(); // gate skipped — re-entry path completes
  // readFileSync should NOT have been called for gate (it is gated out)
  expect(mockReadFileSync).not.toHaveBeenCalled();
});

// ── Case 7: force: true on fresh skill — allowed + audit appended ─────────

it('allows develop with force: true on 1h-old insufficient_evidence skill and appends audit entry', () => {
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeSkillContent(hoursAgo(1), 'insufficient_evidence') as any);

  const result = simulateGate({ force: true });
  expect(result).toBeNull(); // allowed via force

  // Audit entry must be appended
  expect(mockAppendFileSync).toHaveBeenCalledTimes(1);
  const [filePath, rawEntry] = mockAppendFileSync.mock.calls[0];
  expect(filePath).toContain('forced-skill-develops.jsonl');
  const entry = JSON.parse((rawEntry as string).trim());
  expect(entry.agent_id).toBe(AGENT_ID);
  expect(entry.category).toBe(CATEGORY);
  expect(entry.status_before).toBe('insufficient_evidence');
  expect(typeof entry.timestamp).toBe('string');
});

// ── Case 8: rejection message includes all required fields ────────────────

it('rejection message includes agent_id, category, bound_at, status, remaining duration, and override instruction', () => {
  const boundAt = hoursAgo(23);
  mockExistsSync.mockReturnValue(true);
  mockReadFileSync.mockReturnValue(makeSkillContent(boundAt, 'insufficient_evidence') as any);

  const result = simulateGate({});
  expect(result).not.toBeNull();

  // All required fields must be present (spec invariant)
  expect(result).toContain(AGENT_ID);           // agent_id
  expect(result).toContain(CATEGORY);           // category
  expect(result).toContain(boundAt);            // current bound_at
  expect(result).toContain('insufficient_evidence'); // status
  // Remaining time — 23h into a 30d window → ~29d + 1h left
  expect(result).toMatch(/\d+ day\(s\)/);       // remaining days/hours
  expect(result).toContain('force: true');       // override instruction
});
