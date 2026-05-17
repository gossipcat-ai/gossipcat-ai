/**
 * gossip_status `slim:true` parameter tests.
 *
 * Verifies the slim flag's two contracts:
 *   1. Type-guard: non-boolean inputs are coerced to false (no throw).
 *   2. Handbook gate: when slim=true, the "## Project Handbook" section is
 *      omitted from the assembled response text.
 *
 * Mirrors the inline-resolver test pattern used by handbook-resolver.test.ts —
 * the slim guard + handbook builder are extracted as pure helpers so tests
 * don't need to boot the full MCP server.
 *
 * If the production code in mcp-server-sdk.ts changes its slim coercion or
 * its handbook-injection branch, update the mirrors below to match.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── Inline mirrors of production logic ─────────────────────────────────────

/** Mirror of gossip_status's type-guard at mcp-server-sdk.ts (slim coercion). */
function coerceSlim(args: unknown): boolean {
  return typeof (args as { slim?: unknown })?.slim === 'boolean'
    ? (args as { slim: boolean }).slim
    : false;
}

/**
 * Mirror of gossip_status's handbook injection branch — returns the
 * `handbookSection` string that would be appended to the response.
 * When slim=true the section is the empty string (block skipped entirely).
 */
function buildHandbookSection(opts: { slim: boolean; cwd: string }): string {
  let handbookSection = '';
  if (!opts.slim) {
    const handbookCandidates = [path.join(opts.cwd, 'docs', 'HANDBOOK.md')];
    try {
      const handbookPath = handbookCandidates.find(p => fs.existsSync(p)) ?? handbookCandidates[0];
      const stat = fs.statSync(handbookPath);
      const HANDBOOK_CAP_BYTES = 24 * 1024;
      let body = fs.readFileSync(handbookPath, 'utf-8');
      const truncated = body.length > HANDBOOK_CAP_BYTES;
      if (truncated) body = body.slice(0, HANDBOOK_CAP_BYTES);
      handbookSection =
        '\n─────────────────────────────────\n' +
        '## Project Handbook (auto-loaded from docs/HANDBOOK.md)\n\n' +
        body.trim() +
        (truncated
          ? `\n\n[handbook truncated at ${HANDBOOK_CAP_BYTES / 1024}KB — full file at docs/HANDBOOK.md, ${stat.size} bytes total]`
          : '');
    } catch { /* missing file — section stays empty */ }
  }
  return handbookSection;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('gossip_status — slim coercion (type-guard)', () => {
  it('returns false when slim is omitted', () => {
    expect(coerceSlim({})).toBe(false);
  });

  it('returns false when slim is undefined', () => {
    expect(coerceSlim({ slim: undefined })).toBe(false);
  });

  it('returns true when slim is the literal boolean true', () => {
    expect(coerceSlim({ slim: true })).toBe(true);
  });

  it('returns false when slim is the literal boolean false', () => {
    expect(coerceSlim({ slim: false })).toBe(false);
  });

  it('does NOT throw when slim is a non-boolean string — coerces to false', () => {
    expect(() => coerceSlim({ slim: 'true' })).not.toThrow();
    expect(coerceSlim({ slim: 'true' })).toBe(false);
  });

  it('does NOT throw when slim is a number — coerces to false', () => {
    expect(coerceSlim({ slim: 1 })).toBe(false);
  });

  it('does NOT throw when slim is null — coerces to false', () => {
    expect(coerceSlim({ slim: null })).toBe(false);
  });
});

describe('gossip_status — handbook section is gated by slim', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gossip-status-slim-'));
    const docs = path.join(tmpRoot, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'HANDBOOK.md'), '# Test Handbook\n\nOperator wisdom.', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('includes "## Project Handbook" by default (slim omitted/false)', () => {
    const out = buildHandbookSection({ slim: false, cwd: tmpRoot });
    expect(out).toContain('## Project Handbook');
    expect(out).toContain('Operator wisdom.');
  });

  it('skips the handbook section entirely when slim=true', () => {
    const out = buildHandbookSection({ slim: true, cwd: tmpRoot });
    expect(out).toBe('');
    expect(out).not.toContain('## Project Handbook');
  });

  it('produces a non-trivial byte savings when slim=true (≥ ~21KB on large handbooks)', () => {
    // Write a ~24KB handbook to mimic real-world dimensions
    const big = 'x'.repeat(24 * 1024);
    fs.writeFileSync(path.join(tmpRoot, 'docs', 'HANDBOOK.md'), big, 'utf-8');
    const full = buildHandbookSection({ slim: false, cwd: tmpRoot });
    const trimmed = buildHandbookSection({ slim: true, cwd: tmpRoot });
    expect(full.length - trimmed.length).toBeGreaterThanOrEqual(21 * 1024);
  });
});
