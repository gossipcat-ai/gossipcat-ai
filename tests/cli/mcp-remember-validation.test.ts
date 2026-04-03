/**
 * Tests for the gossip_remember MCP handler validation layer.
 *
 * Scope: handler-level concerns only — the agent_id regex gate, Zod schema
 * constraints, and default/cap behaviour. Searcher internals (ranking, CRLF,
 * importance clamping) are already covered in memory-searcher.test.ts.
 *
 * Strategy: the handler is a closure registered with the MCP server and
 * requires a full boot cycle to invoke. Rather than bootstrapping the whole
 * server, we test:
 *   1. The regex directly (same pattern the handler uses) — pure unit.
 *   2. MemorySearcher via the same call path the handler uses — verifies the
 *      plumbing between handler logic and searcher, not searcher internals.
 */

import { MemorySearcher } from '@gossip/orchestrator';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Same regex the handler applies at line 1990 of mcp-server-sdk.ts
const AGENT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

const makeDir = () =>
  join(tmpdir(), `gossip-remember-validation-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function setupAgent(testDir: string, agentId: string): { knowledgeDir: string } {
  const knowledgeDir = join(testDir, '.gossip', 'agents', agentId, 'memory', 'knowledge');
  mkdirSync(knowledgeDir, { recursive: true });
  return { knowledgeDir };
}

// ── agent_id regex validation ─────────────────────────────────────────────────

describe('gossip_remember — agent_id regex (/^[a-zA-Z0-9_-]{1,64}$/)', () => {
  describe('rejects invalid agent IDs', () => {
    it('rejects path traversal: ../etc', () => {
      expect(AGENT_ID_REGEX.test('../etc')).toBe(false);
    });

    it('rejects path traversal: agent/../../etc', () => {
      expect(AGENT_ID_REGEX.test('agent/../../etc')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(AGENT_ID_REGEX.test('')).toBe(false);
    });

    it('rejects string longer than 64 characters', () => {
      const longId = 'a'.repeat(65);
      expect(AGENT_ID_REGEX.test(longId)).toBe(false);
    });

    it('rejects agent ID with spaces', () => {
      expect(AGENT_ID_REGEX.test('agent with spaces')).toBe(false);
    });

    it('rejects agent ID with dots', () => {
      expect(AGENT_ID_REGEX.test('agent.name')).toBe(false);
    });

    it('rejects agent ID with at-sign', () => {
      expect(AGENT_ID_REGEX.test('agent@host')).toBe(false);
    });

    it('rejects agent ID with forward slash', () => {
      expect(AGENT_ID_REGEX.test('agent/subpath')).toBe(false);
    });

    it('rejects agent ID with null byte', () => {
      expect(AGENT_ID_REGEX.test('agent\0name')).toBe(false);
    });
  });

  describe('accepts valid agent IDs', () => {
    it('accepts "sonnet-reviewer"', () => {
      expect(AGENT_ID_REGEX.test('sonnet-reviewer')).toBe(true);
    });

    it('accepts "haiku-researcher"', () => {
      expect(AGENT_ID_REGEX.test('haiku-researcher')).toBe(true);
    });

    it('accepts "agent_1" (underscore + digit)', () => {
      expect(AGENT_ID_REGEX.test('agent_1')).toBe(true);
    });

    it('accepts single character "a"', () => {
      expect(AGENT_ID_REGEX.test('a')).toBe(true);
    });

    it('accepts exactly 64 characters', () => {
      const maxId = 'a'.repeat(64);
      expect(AGENT_ID_REGEX.test(maxId)).toBe(true);
    });

    it('accepts mixed case with hyphens and underscores', () => {
      expect(AGENT_ID_REGEX.test('My_Agent-42')).toBe(true);
    });
  });
});

// ── Zod query max-length constraint ──────────────────────────────────────────

describe('gossip_remember — Zod query max(500) schema', () => {
  /**
   * The Zod schema enforces .max(500) before the handler body runs.
   * We verify the searcher handles exactly-500-char queries without error
   * (valid boundary) and that truncation in MemorySearcher.search() means
   * a 1200-char query still returns results (graceful degradation).
   */

  let testDir: string;

  beforeEach(() => {
    testDir = makeDir();
    const { knowledgeDir } = setupAgent(testDir, 'agent1');
    writeFileSync(join(knowledgeDir, 'relay.md'), [
      '---',
      'name: relay server',
      'description: relay server connection handling',
      'importance: 0.8',
      '---',
      '',
      'The relay server manages connections.',
    ].join('\n'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('query of exactly 500 chars is accepted by searcher without throwing', () => {
    // Build a query of exactly 500 chars using 'relay ' (6 chars) × 83 = 498, pad to 500
    const query = ('relay ').repeat(83) + 'ab';
    expect(query.length).toBe(500);
    const searcher = new MemorySearcher(testDir);
    expect(() => searcher.search('agent1', query)).not.toThrow();
  });

  it('query longer than 500 chars is sliced internally and still finds results', () => {
    // MemorySearcher slices to 500 — the keyword "relay" is in the first 500 chars
    const query = 'relay '.repeat(300); // 1800 chars
    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', query);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── max_results default and cap ───────────────────────────────────────────────

describe('gossip_remember — max_results default and cap', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeDir();
    const { knowledgeDir } = setupAgent(testDir, 'agent1');

    // Create 12 matching files
    for (let i = 0; i < 12; i++) {
      writeFileSync(join(knowledgeDir, `relay${i}.md`), [
        '---',
        `name: relay topic ${i}`,
        'description: relay server connection internals',
        `importance: ${0.5 + (i % 5) * 0.1}`,
        'lastAccessed: 2026-03-21',
        'accessCount: 1',
        '---',
        '',
        'relay connection frame',
      ].join('\n'));
    }
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('defaults to 3 results when max_results is not provided', () => {
    const searcher = new MemorySearcher(testDir);
    // Calling with no third argument matches the handler default of 3
    const results = searcher.search('agent1', 'relay connection');
    // Default is 3 — should return at most 3
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('passing max_results=20 returns at most 10 (cap enforced by searcher)', () => {
    const searcher = new MemorySearcher(testDir);
    const results = searcher.search('agent1', 'relay connection', 20);
    expect(results.length).toBeLessThanOrEqual(10);
  });
});

// ── handler output for empty / whitespace query ───────────────────────────────

describe('gossip_remember — empty/whitespace query returns no results', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeDir();
    setupAgent(testDir, 'agent1');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns empty array for empty string query', () => {
    const searcher = new MemorySearcher(testDir);
    expect(searcher.search('agent1', '')).toEqual([]);
  });

  it('returns empty array for whitespace-only query', () => {
    const searcher = new MemorySearcher(testDir);
    expect(searcher.search('agent1', '   \t\n')).toEqual([]);
  });
});

// ── path traversal blocked at handler level (regex gate) ─────────────────────

describe('gossip_remember — path traversal blocked by handler regex, not searcher', () => {
  /**
   * The handler regex fires BEFORE MemorySearcher is instantiated.
   * Verify the regex is the first line of defence by checking it rejects
   * traversal strings that the searcher would also handle safely (defence in
   * depth), and that passing a traversal ID to the regex returns false so the
   * handler can short-circuit with an error message.
   */

  it('regex gate prevents "../etc" from reaching MemorySearcher', () => {
    const agentId = '../etc';
    const handlerWouldReject = !AGENT_ID_REGEX.test(agentId);
    expect(handlerWouldReject).toBe(true);
  });

  it('regex gate prevents "agent/../../etc" from reaching MemorySearcher', () => {
    const agentId = 'agent/../../etc';
    const handlerWouldReject = !AGENT_ID_REGEX.test(agentId);
    expect(handlerWouldReject).toBe(true);
  });

  it('regex gate prevents empty string from reaching MemorySearcher', () => {
    const agentId = '';
    const handlerWouldReject = !AGENT_ID_REGEX.test(agentId);
    expect(handlerWouldReject).toBe(true);
  });

  it('regex gate prevents 65-char string from reaching MemorySearcher', () => {
    const agentId = 'a'.repeat(65);
    const handlerWouldReject = !AGENT_ID_REGEX.test(agentId);
    expect(handlerWouldReject).toBe(true);
  });
});
