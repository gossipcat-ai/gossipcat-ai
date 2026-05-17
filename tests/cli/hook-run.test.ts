/**
 * Unit tests for `gossipcat hook --run` (apps/cli/src/hook-run.ts).
 *
 * Covers the mtime-keyed sentinel logic from
 * docs/specs/2026-05-07-bootstrap-hook-trim.md:
 *   1. bootstrap missing → one-liner hint, exit 0 (no throw)
 *   2. bootstrap present, no sentinel → full content + sentinel created
 *   3. sentinel matches current mtime → short suppression line
 *   4. sentinel mtime differs (regen simulated) → full content + sentinel updated
 *   5. statSync throws → fail-open, full content emitted
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runHook } from '../../apps/cli/src/hook-run';

function makeTmpProject(): string {
  return mkdtempSync(join(tmpdir(), 'gossip-hook-run-'));
}

function makeSentinelPath(): string {
  // Use a unique tmp file path that doesn't exist yet.
  return join(tmpdir(), `gossipcat-hook-run-sentinel-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

interface Captured {
  out: string;
  write: (chunk: string) => void;
}

function captureWrite(): Captured {
  let out = '';
  return {
    get out() { return out; },
    write(chunk: string) { out += chunk; },
  } as Captured;
}

describe('runHook (gossipcat hook --run)', () => {
  const created: string[] = [];
  const sentinels: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    while (sentinels.length) {
      const f = sentinels.pop()!;
      try { rmSync(f, { force: true }); } catch { /* best-effort */ }
    }
  });

  it('bootstrap missing → prints one-liner hint and does not throw', () => {
    const root = makeTmpProject();
    created.push(root);
    const sentinel = makeSentinelPath();
    sentinels.push(sentinel);
    const cap = captureWrite();

    expect(() => runHook({ cwd: root, sentinelPath: sentinel, write: cap.write })).not.toThrow();

    expect(cap.out).toContain('[gossipcat] No bootstrap yet.');
    expect(cap.out).toContain('select:mcp__gossipcat__gossip_status');
    // Sentinel must NOT be created when bootstrap is absent.
    expect(existsSync(sentinel)).toBe(false);
  });

  it('bootstrap present, no sentinel → emits full content and writes sentinel with current mtime', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const bootstrapPath = join(root, '.gossip', 'bootstrap.md');
    writeFileSync(bootstrapPath, '# bootstrap v1\nhello world\n');

    const sentinel = makeSentinelPath();
    sentinels.push(sentinel);
    const cap = captureWrite();

    runHook({ cwd: root, sentinelPath: sentinel, write: cap.write });

    expect(cap.out).toContain('# bootstrap v1');
    expect(cap.out).toContain('hello world');
    expect(existsSync(sentinel)).toBe(true);
    const stored = readFileSync(sentinel, 'utf-8').trim();
    const expected = String(statSync(bootstrapPath).mtimeMs);
    expect(stored).toBe(expected);
  });

  it('sentinel matches current mtime → emits short suppression line only', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const bootstrapPath = join(root, '.gossip', 'bootstrap.md');
    writeFileSync(bootstrapPath, '# bootstrap v1\nfull body\n');

    const sentinel = makeSentinelPath();
    sentinels.push(sentinel);
    // Seed sentinel with the current mtime.
    writeFileSync(sentinel, String(statSync(bootstrapPath).mtimeMs), 'utf-8');

    const cap = captureWrite();
    runHook({ cwd: root, sentinelPath: sentinel, write: cap.write });

    expect(cap.out).toContain('[gossipcat: bootstrap already loaded');
    expect(cap.out).not.toContain('full body');
  });

  it('sentinel mtime differs (regen simulated) → emits full content and updates sentinel', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const bootstrapPath = join(root, '.gossip', 'bootstrap.md');
    writeFileSync(bootstrapPath, '# bootstrap v2\nregenerated\n');

    const sentinel = makeSentinelPath();
    sentinels.push(sentinel);
    // Seed sentinel with a stale mtime — guaranteed not to match.
    writeFileSync(sentinel, '0', 'utf-8');

    const cap = captureWrite();
    runHook({ cwd: root, sentinelPath: sentinel, write: cap.write });

    expect(cap.out).toContain('# bootstrap v2');
    expect(cap.out).toContain('regenerated');
    expect(cap.out).not.toContain('[gossipcat: bootstrap already loaded');

    const after = readFileSync(sentinel, 'utf-8').trim();
    const current = String(statSync(bootstrapPath).mtimeMs);
    expect(after).toBe(current);
    expect(after).not.toBe('0');
  });

  it('touching bootstrap after suppression re-fires full content (mtime advanced)', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const bootstrapPath = join(root, '.gossip', 'bootstrap.md');
    writeFileSync(bootstrapPath, 'initial content\n');

    const sentinel = makeSentinelPath();
    sentinels.push(sentinel);

    // Fire 1 — full
    runHook({ cwd: root, sentinelPath: sentinel, write: captureWrite().write });
    // Fire 2 — suppressed
    const cap2 = captureWrite();
    runHook({ cwd: root, sentinelPath: sentinel, write: cap2.write });
    expect(cap2.out).toContain('[gossipcat: bootstrap already loaded');

    // Simulate regen by bumping mtime forward by 5s.
    const now = Date.now() / 1000;
    utimesSync(bootstrapPath, now + 5, now + 5);

    const cap3 = captureWrite();
    runHook({ cwd: root, sentinelPath: sentinel, write: cap3.write });
    expect(cap3.out).toContain('initial content');
    expect(cap3.out).not.toContain('[gossipcat: bootstrap already loaded');
  });

  it('fail-open: even when sentinel path is unwritable, full content is emitted on first fire', () => {
    const root = makeTmpProject();
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const bootstrapPath = join(root, '.gossip', 'bootstrap.md');
    writeFileSync(bootstrapPath, 'content for failopen\n');

    // Use a sentinel path inside a non-existent directory to force writeFileSync to fail silently.
    const sentinel = join(tmpdir(), 'no-such-dir-xyz-' + Date.now(), 'sentinel');
    const cap = captureWrite();
    expect(() => runHook({ cwd: root, sentinelPath: sentinel, write: cap.write })).not.toThrow();
    expect(cap.out).toContain('content for failopen');
  });
});
