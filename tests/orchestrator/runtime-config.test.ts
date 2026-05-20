/**
 * Tests for runtime-config.ts — file-backed runtime flag store.
 * Spec: docs/specs/2026-05-21-runtime-config-store.md
 */

import * as fs from 'fs';
import * as path from 'path';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

// ── Test isolation helpers ────────────────────────────────────────────────
// We need process.cwd() to point at our temp dir for every test, and we need
// the module's in-memory cache to be flushed between tests. The cache is
// module-level, so we use jest.resetModules() to get a fresh module for
// tests that care about isolation.

let workDir: string;
let prevCwd: string;

// Fresh import of the module under test (bypasses module cache).
async function freshImport() {
  jest.resetModules();
  return import('../../packages/orchestrator/src/runtime-config');
}

function writeFlags(flags: Record<string, string>): void {
  const gossipDir = path.join(workDir, '.gossip');
  mkdirSync(gossipDir, { recursive: true });
  writeFileSync(path.join(gossipDir, 'runtime-flags.json'), JSON.stringify(flags, null, 2));
}

function readAuditLines(): any[] {
  const auditPath = path.join(workDir, '.gossip', 'config-changes.jsonl');
  if (!fs.existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  prevCwd = process.cwd();
  workDir = mkdtempSync(path.join(tmpdir(), 'gossip-runtime-cfg-'));
  mkdirSync(path.join(workDir, '.gossip'), { recursive: true });
  process.chdir(workDir);
  // Clean env.
  delete process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'];
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(workDir, { recursive: true, force: true });
  delete process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'];
  jest.resetModules();
});

// ── Precedence ────────────────────────────────────────────────────────────

it('precedence: env-set returns env value', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '0' });
  process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'] = '1';
  const { getRuntimeFlag } = await freshImport();
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('1');
});

it('precedence: env-unset + file-set returns file value', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '1' });
  delete process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'];
  const { getRuntimeFlag } = await freshImport();
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('1');
});

it('precedence: neither env nor file returns registry default', async () => {
  // No file, no env.
  const { getRuntimeFlag } = await freshImport();
  // Registry default for GOSSIP_NATIVE_WORKTREE_MANAGED is '0'.
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('0');
});

it('precedence: explicit defaultValue used when env and file both absent', async () => {
  const { getRuntimeFlag } = await freshImport();
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', 'fallback')).toBe('fallback');
});

// ── Empty-string env semantics ────────────────────────────────────────────

it('empty-string env: getRuntimeFlag returns file value, not empty string', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '1' });
  process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'] = '';
  const { getRuntimeFlag } = await freshImport();
  // Empty string env → treated as unset → file value '1'.
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('1');
});

it('empty-string env: getRuntimeFlagBool returns false (empty-string is falsy)', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '1' });
  process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'] = '';
  const { getRuntimeFlagBool } = await freshImport();
  // Empty env → treated as unset → falls to file '1' → bool true.
  // Wait — the spec says "empty string env treated as unset". So the value
  // returned by getRuntimeFlag is '1' (from file), and getRuntimeFlagBool('1') = true.
  // But the spec also says: "getRuntimeFlagBool returns false for empty-string env
  // regardless of file". Re-reading spec §Empty-string env:
  //   "getRuntimeFlagBool returns false for empty-string env REGARDLESS of file."
  // This is the regression test. So the behavior MUST be:
  //   env='' → getRuntimeFlagBool = false (NOT true from file).
  //
  // This means getRuntimeFlagBool has to check env directly for empty-string
  // BEFORE delegating to getRuntimeFlag. Let's verify the spec wording:
  // "getRuntimeFlagBool('X') returns false" when env='' even if file has '1'.
  //
  // Actually re-reading the spec more carefully:
  // "Empty-string env is treated as unset. This preserves semantics where
  //  process.env.X === '1' falses on export X= ... Without this rule, an empty-
  //  string export would silently fall through to a file "1" and re-enable a flag."
  //
  // So the empty-string is treated as UNSET, meaning we fall through to the FILE.
  // If file has '1', we get true. But then the spec says the test is:
  // "getRuntimeFlagBool returns false" — the point is when there's NO file either.
  //
  // Let me re-read the test plan:
  // "process.env.X = '' returns file value (or default), NOT empty string.
  //  getRuntimeFlagBool returns false."
  //
  // This reads as: when env='', getRuntimeFlagBool returns false.
  // But also: when env='', getRuntimeFlag returns file value.
  // These are contradictory unless getRuntimeFlagBool evaluates the EMPTY STRING
  // directly (before falling through to file).
  //
  // The key insight: getRuntimeFlagBool checks if raw env IS empty string as a
  // special case. Empty string → false, regardless of file. This is the
  // "explicit disable" semantics for bool flags: export X= means "force off".
  //
  // We implement this below in a dedicated test with the current module behavior.
  // If the current implementation falls through, this test will catch it.
  expect(getRuntimeFlagBool('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe(false);
});

it('empty-string env: getRuntimeFlagBool returns false even with no file', async () => {
  process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'] = '';
  const { getRuntimeFlagBool } = await freshImport();
  expect(getRuntimeFlagBool('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe(false);
});

// ── Atomic write ──────────────────────────────────────────────────────────

it('atomic write: setRuntimeFlag survives write-then-parse round-trip', async () => {
  const { setRuntimeFlag, getRuntimeFlag, reloadRuntimeFlags } = await freshImport();
  await setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '1', 'user', 'test round-trip');
  reloadRuntimeFlags();
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('1');
});

it('atomic write: .tmp file is removed after successful write', async () => {
  const { setRuntimeFlag } = await freshImport();
  await setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '1', 'user', 'cleanup test');
  const tmpPath = path.join(workDir, '.gossip', 'runtime-flags.json.tmp');
  expect(fs.existsSync(tmpPath)).toBe(false);
});

// ── Concurrent writes ─────────────────────────────────────────────────────

it('concurrent setRuntimeFlag: no torn JSON, 2 ordered audit entries', async () => {
  const { setRuntimeFlag } = await freshImport();

  await Promise.all([
    setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '1', 'agent', 'concurrent A'),
    setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '0', 'user', 'concurrent B'),
  ]);

  // The flags file must be valid JSON.
  const flagsContent = readFileSync(path.join(workDir, '.gossip', 'runtime-flags.json'), 'utf8');
  expect(() => JSON.parse(flagsContent)).not.toThrow();

  // Exactly 2 audit entries.
  const lines = readAuditLines();
  expect(lines.length).toBe(2);
  expect(lines[0].action).toBe('set');
  expect(lines[1].action).toBe('set');
});

// ── Registry write-gate ───────────────────────────────────────────────────

it('registry write-gate: unknown key is rejected', async () => {
  const { setRuntimeFlag } = await freshImport();
  await expect(setRuntimeFlag('GOSSIP_UNKNOWN_FLAG_XYZ' as any, '1', 'user', 'test'))
    .rejects.toThrow(/not in the runtime flag registry/);
});

it('registry write-gate: non-boolean value rejected for boolean-typed key', async () => {
  const { setRuntimeFlag } = await freshImport();
  await expect(setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', 'yes', 'user', 'test'))
    .rejects.toThrow(/boolean/);
});

it('registry write-gate: unsetRuntimeFlag is a no-op for key not in file', async () => {
  const { unsetRuntimeFlag } = await freshImport();
  // Should not throw.
  await expect(unsetRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', 'user', 'test')).resolves.toBeUndefined();
  // No audit entry written (key wasn't in file).
  expect(readAuditLines().length).toBe(0);
});

// ── GOSSIP_* prefix filter ────────────────────────────────────────────────

it('prefix filter: getRuntimeFlag returns undefined for non-GOSSIP_ key', async () => {
  // Even if the env or file has it, the filter must block it.
  process.env['GOSSIPCAT_HTTP_TOKEN'] = 'secret';
  const { getRuntimeFlag } = await freshImport();
  expect(getRuntimeFlag('GOSSIPCAT_HTTP_TOKEN')).toBeUndefined();
  delete process.env['GOSSIPCAT_HTTP_TOKEN'];
});

it('prefix filter: getRuntimeFlag returns undefined for arbitrary non-GOSSIP_ key', async () => {
  const { getRuntimeFlag } = await freshImport();
  expect(getRuntimeFlag('PATH')).toBeUndefined();
  expect(getRuntimeFlag('NODE_ENV')).toBeUndefined();
});

it('prefix filter: setRuntimeFlag throws for non-GOSSIP_ key', async () => {
  const { setRuntimeFlag } = await freshImport();
  await expect(setRuntimeFlag('GOSSIPCAT_HTTP_TOKEN' as any, 'x', 'user', 'test'))
    .rejects.toThrow(/GOSSIP_/);
});

// ── Audit log ─────────────────────────────────────────────────────────────

it('audit log: entries append, never overwrite; 2 set calls → 2 entries', async () => {
  const { setRuntimeFlag } = await freshImport();
  await setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '1', 'user', 'first');
  await setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '0', 'agent', 'second');

  const lines = readAuditLines();
  expect(lines.length).toBe(2);
  expect(lines[0].newValue).toBe('1');
  expect(lines[1].newValue).toBe('0');
});

it('audit log: entry has all required fields', async () => {
  const { setRuntimeFlag } = await freshImport();
  await setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '1', 'agent', 'dogfood test');

  const [entry] = readAuditLines();
  expect(typeof entry.ts).toBe('string');
  expect(entry.action).toBe('set');
  expect(entry.key).toBe('GOSSIP_NATIVE_WORKTREE_MANAGED');
  expect(entry.oldValue).toBeNull(); // first set — was not in file
  expect(entry.newValue).toBe('1');
  expect(entry.source).toBe('agent');
  expect(entry.reason).toBe('dogfood test');
  expect(typeof entry.sessionId).toBe('string');
});

it('audit log: unset records oldValue correctly', async () => {
  const { setRuntimeFlag, unsetRuntimeFlag } = await freshImport();
  await setRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', '1', 'user', 'setup');
  await unsetRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED', 'user', 'cleanup');

  const lines = readAuditLines();
  expect(lines.length).toBe(2);
  expect(lines[1].action).toBe('unset');
  expect(lines[1].oldValue).toBe('1');
  expect(lines[1].newValue).toBeNull();
});

// ── Source attribution (listRuntimeFlags) ────────────────────────────────

it('listRuntimeFlags: env-set key shows from: "env"', async () => {
  process.env['GOSSIP_NATIVE_WORKTREE_MANAGED'] = '1';
  const { listRuntimeFlags } = await freshImport();
  const flags = listRuntimeFlags();
  const entry = flags.find((f) => f.key === 'GOSSIP_NATIVE_WORKTREE_MANAGED');
  expect(entry?.from).toBe('env');
  expect(entry?.value).toBe('1');
});

it('listRuntimeFlags: file-only key shows from: "file"', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '1' });
  const { listRuntimeFlags } = await freshImport();
  const flags = listRuntimeFlags();
  const entry = flags.find((f) => f.key === 'GOSSIP_NATIVE_WORKTREE_MANAGED');
  expect(entry?.from).toBe('file');
  expect(entry?.value).toBe('1');
});

it('listRuntimeFlags: unset key shows from: "default"', async () => {
  const { listRuntimeFlags } = await freshImport();
  const flags = listRuntimeFlags();
  const entry = flags.find((f) => f.key === 'GOSSIP_NATIVE_WORKTREE_MANAGED');
  expect(entry?.from).toBe('default');
  expect(entry?.value).toBe('0'); // registry default
});

// ── Reload ────────────────────────────────────────────────────────────────

it('reloadRuntimeFlags: first getRuntimeFlag returns cached, after reload returns new value', async () => {
  const { getRuntimeFlag, reloadRuntimeFlags } = await freshImport();

  // First read — cache is empty, loads from file (no file → default '0').
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('0');

  // Hand-edit file out-of-band.
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '1' });

  // Without reload, still returns cached value.
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('0');

  // After reload, returns new file value.
  reloadRuntimeFlags();
  expect(getRuntimeFlag('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe('1');
});

// ── getRuntimeFlagBool ────────────────────────────────────────────────────

it('getRuntimeFlagBool: "1" is truthy', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '1' });
  const { getRuntimeFlagBool } = await freshImport();
  expect(getRuntimeFlagBool('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe(true);
});

it('getRuntimeFlagBool: "true" is truthy', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: 'true' });
  const { getRuntimeFlagBool } = await freshImport();
  expect(getRuntimeFlagBool('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe(true);
});

it('getRuntimeFlagBool: "0" is falsy', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: '0' });
  const { getRuntimeFlagBool } = await freshImport();
  expect(getRuntimeFlagBool('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe(false);
});

it('getRuntimeFlagBool: "false" is falsy', async () => {
  writeFlags({ GOSSIP_NATIVE_WORKTREE_MANAGED: 'false' });
  const { getRuntimeFlagBool } = await freshImport();
  expect(getRuntimeFlagBool('GOSSIP_NATIVE_WORKTREE_MANAGED')).toBe(false);
});
