/**
 * Tests for apps/cli/src/handlers/skill-develop-audit.ts.
 *
 * Spec: docs/specs/2026-04-15-skill-develop-upstream-freshness.md
 * Consensus: 5e870813-dfa340e8
 *
 * Covers:
 *   1. Gate-pass entry written with gated: false, source: "mcp"
 *   2. Gate-block entry written with gated: true, gate_reason populated, source: "mcp"
 *   3. force: true entry written with gated: false, forced: true
 *   4. auto_collect entry written with source: "auto_collect"
 *   5. Legacy path (.gossip/forced-skill-develops.jsonl) also receives entries
 *   6. Audit log round-trip: write → read back → validate schema
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock fs to capture appendFileSync calls and optionally delegate to real impl
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    appendFileSync: jest.fn(actual.appendFileSync),
    mkdirSync: jest.fn(actual.mkdirSync),
  };
});

const mockAppendFileSync = appendFileSync as jest.MockedFunction<typeof appendFileSync>;
const mockMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>;

import { appendSkillDevelopAudit, SkillDevelopAuditEntry } from '../../apps/cli/src/handlers/skill-develop-audit';

const AGENT_ID = 'gemini-reviewer';
const CATEGORY = 'trust_boundaries';
const TIMESTAMP = '2026-04-15T19:00:00.000Z';

function baseEntry(overrides: Partial<SkillDevelopAuditEntry> = {}): SkillDevelopAuditEntry {
  return {
    timestamp: TIMESTAMP,
    agent_id: AGENT_ID,
    category: CATEGORY,
    bound_at_before: '2026-04-15T08:00:00.000Z',
    status_before: 'pending',
    gated: false,
    gate_reason: null,
    forced: false,
    source: 'mcp',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMkdirSync.mockImplementation(() => undefined as any);
  mockAppendFileSync.mockImplementation(() => undefined);
});

// ── Test 1: gate-pass entry (mcp, not forced) ─────────────────────────────

it('writes gate-pass audit entry with gated: false, source: "mcp"', () => {
  appendSkillDevelopAudit(baseEntry());

  expect(mockAppendFileSync).toHaveBeenCalled();
  // Expect canonical audit file was written
  const canonicalCall = mockAppendFileSync.mock.calls.find(
    ([path]) => String(path).includes('skill-develop-audit.jsonl'),
  );
  expect(canonicalCall).toBeDefined();
  const entry = JSON.parse((canonicalCall![1] as string).trim());
  expect(entry.gated).toBe(false);
  expect(entry.gate_reason).toBeNull();
  expect(entry.forced).toBe(false);
  expect(entry.source).toBe('mcp');
  expect(entry.agent_id).toBe(AGENT_ID);
  expect(entry.category).toBe(CATEGORY);
});

// ── Test 2: gate-block entry ──────────────────────────────────────────────

it('writes gate-block audit entry with gated: true and gate_reason populated', () => {
  appendSkillDevelopAudit(baseEntry({
    gated: true,
    gate_reason: 'insufficient_evidence',
    source: 'mcp',
  }));

  const canonicalCall = mockAppendFileSync.mock.calls.find(
    ([path]) => String(path).includes('skill-develop-audit.jsonl'),
  );
  expect(canonicalCall).toBeDefined();
  const entry = JSON.parse((canonicalCall![1] as string).trim());
  expect(entry.gated).toBe(true);
  expect(entry.gate_reason).toBe('insufficient_evidence');
  expect(entry.forced).toBe(false);
});

// ── Test 3: force: true entry ─────────────────────────────────────────────

it('writes force-bypass entry with gated: false, forced: true', () => {
  appendSkillDevelopAudit(baseEntry({
    gated: false,
    gate_reason: null,
    forced: true,
    source: 'mcp',
  }));

  const canonicalCall = mockAppendFileSync.mock.calls.find(
    ([path]) => String(path).includes('skill-develop-audit.jsonl'),
  );
  expect(canonicalCall).toBeDefined();
  const entry = JSON.parse((canonicalCall![1] as string).trim());
  expect(entry.forced).toBe(true);
  expect(entry.gated).toBe(false);
});

// ── Test 4: auto_collect source ───────────────────────────────────────────

it('writes auto-develop entry with source: "auto_collect"', () => {
  appendSkillDevelopAudit(baseEntry({ source: 'auto_collect' }));

  const canonicalCall = mockAppendFileSync.mock.calls.find(
    ([path]) => String(path).includes('skill-develop-audit.jsonl'),
  );
  expect(canonicalCall).toBeDefined();
  const entry = JSON.parse((canonicalCall![1] as string).trim());
  expect(entry.source).toBe('auto_collect');
});

// ── Test 5: legacy alias dual-write ──────────────────────────────────────

it('also writes to legacy forced-skill-develops.jsonl for one-release backwards compat', () => {
  appendSkillDevelopAudit(baseEntry());

  const legacyCall = mockAppendFileSync.mock.calls.find(
    ([path]) => String(path).includes('forced-skill-develops.jsonl'),
  );
  expect(legacyCall).toBeDefined();

  // Both calls should contain the same JSON payload
  const canonicalCall = mockAppendFileSync.mock.calls.find(
    ([path]) => String(path).includes('skill-develop-audit.jsonl'),
  );
  expect(canonicalCall![1]).toBe(legacyCall![1]);
});

// ── Test 6: round-trip write → read back → validate schema ───────────────

describe('audit log round-trip', () => {
  const testDir = join(tmpdir(), `gossip-audit-roundtrip-${Date.now()}`);

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('writes to real filesystem and entries are valid JSONL with all required fields', () => {
    // Use real fs for this test
    mockAppendFileSync.mockImplementation(
      (...args: Parameters<typeof appendFileSync>) => {
        (jest.requireActual('fs') as typeof import('fs')).appendFileSync(...args);
      },
    );
    mockMkdirSync.mockImplementation((...args) => {
      (jest.requireActual('fs') as typeof import('fs')).mkdirSync(
        args[0] as import('fs').PathLike,
        args[1] as import('fs').MakeDirectoryOptions,
      );
      return undefined;
    });

    // Override process.cwd() to use our temp dir
    const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(testDir);

    appendSkillDevelopAudit(baseEntry({ source: 'mcp', gated: false }));
    appendSkillDevelopAudit(baseEntry({ source: 'auto_collect', gated: false }));
    appendSkillDevelopAudit(baseEntry({ gated: true, gate_reason: 'insufficient_evidence' }));

    cwdSpy.mockRestore();

    const auditPath = join(testDir, '.gossip', 'skill-develop-audit.jsonl');
    const lines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    const entries = lines.map(l => JSON.parse(l));

    // Validate required schema fields on all entries
    for (const entry of entries) {
      expect(typeof entry.timestamp).toBe('string');
      expect(entry.agent_id).toBe(AGENT_ID);
      expect(entry.category).toBe(CATEGORY);
      expect(typeof entry.gated).toBe('boolean');
      expect(typeof entry.forced).toBe('boolean');
      expect(['mcp', 'auto_collect']).toContain(entry.source);
    }

    // Validate source field round-trips correctly
    expect(entries[0].source).toBe('mcp');
    expect(entries[1].source).toBe('auto_collect');
    expect(entries[2].gated).toBe(true);
    expect(entries[2].gate_reason).toBe('insufficient_evidence');
  });
});
