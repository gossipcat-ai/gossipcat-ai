import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkDistMcpStaleness,
  resetStalenessCache,
  formatStalenessWarning,
  renderStalenessBanner,
} from '@gossip/orchestrator';

function setMtime(path: string, secondsAgo: number): void {
  const now = Date.now() / 1000;
  utimesSync(path, now - secondsAgo, now - secondsAgo);
}

function makeRepo(testDir: string, layout: { withSrc: boolean; withBundle: boolean }): string {
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  if (layout.withBundle) {
    mkdirSync(join(testDir, 'dist-mcp'), { recursive: true });
    writeFileSync(join(testDir, 'dist-mcp', 'mcp-server.js'), '// bundle');
  }
  if (layout.withSrc) {
    mkdirSync(join(testDir, 'packages', 'orchestrator', 'src'), { recursive: true });
    mkdirSync(join(testDir, 'apps', 'cli', 'src'), { recursive: true });
    writeFileSync(join(testDir, 'packages', 'orchestrator', 'src', 'a.ts'), '// orch');
    writeFileSync(join(testDir, 'apps', 'cli', 'src', 'b.ts'), '// cli');
  }
  return testDir;
}

describe('checkDistMcpStaleness', () => {
  const baseDir = join(tmpdir(), `gossip-staleness-${Date.now()}`);
  let counter = 0;

  beforeEach(() => {
    resetStalenessCache();
    delete process.env.GOSSIPCAT_SUPPRESS_STALENESS;
  });

  afterAll(() => { rmSync(baseDir, { recursive: true, force: true }); });

  function fresh(): string { return join(baseDir, `case-${++counter}`); }

  it('returns stale=true when src is newer than bundle', () => {
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: true });
    const bundle = join(dir, 'dist-mcp', 'mcp-server.js');
    setMtime(bundle, 3600); // bundle 1h old
    setMtime(join(dir, 'apps', 'cli', 'src', 'b.ts'), 3600); // b.ts same age as bundle
    setMtime(join(dir, 'packages', 'orchestrator', 'src', 'a.ts'), 60); // a.ts is newest

    const r = checkDistMcpStaleness(bundle);
    expect(r.stale).toBe(true);
    expect(r.deltaMs).toBeGreaterThan(0);
    expect(r.newestSrc).toContain('a.ts');
    expect(r.skipped).toBe(null);
  });

  it('returns stale=false with negative deltaMs when bundle is newer than all src', () => {
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: true });
    const bundle = join(dir, 'dist-mcp', 'mcp-server.js');
    setMtime(join(dir, 'packages', 'orchestrator', 'src', 'a.ts'), 3600);
    setMtime(join(dir, 'apps', 'cli', 'src', 'b.ts'), 3600);
    setMtime(bundle, 60);

    const r = checkDistMcpStaleness(bundle);
    expect(r.stale).toBe(false);
    expect(r.deltaMs).toBeLessThan(0);
    expect(r.skipped).toBe(null);
  });

  it('short-circuits to skipped=installed when src dirs do not exist', () => {
    const dir = makeRepo(fresh(), { withSrc: false, withBundle: true });
    const bundle = join(dir, 'dist-mcp', 'mcp-server.js');

    const r = checkDistMcpStaleness(bundle);
    expect(r.stale).toBe(false);
    expect(r.skipped).toBe('installed');
  });

  it('returns skipped=no-bundle when bundle file is missing', () => {
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: false });
    const r = checkDistMcpStaleness(join(dir, 'dist-mcp', 'mcp-server.js'));
    expect(r.stale).toBe(false);
    expect(r.skipped).toBe('no-bundle');
  });

  it('returns skipped=suppressed when GOSSIPCAT_SUPPRESS_STALENESS=1', () => {
    process.env.GOSSIPCAT_SUPPRESS_STALENESS = '1';
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: true });
    const r = checkDistMcpStaleness(join(dir, 'dist-mcp', 'mcp-server.js'));
    expect(r.skipped).toBe('suppressed');
  });

  it('returns skipped=no-bundle when called with no bundlePath and cache is empty', () => {
    const r = checkDistMcpStaleness();
    expect(r.skipped).toBe('no-bundle');
  });

  it('picks newest across BOTH src roots, not just the first', () => {
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: true });
    const bundle = join(dir, 'dist-mcp', 'mcp-server.js');
    setMtime(bundle, 3600);
    setMtime(join(dir, 'packages', 'orchestrator', 'src', 'a.ts'), 1800); // older
    setMtime(join(dir, 'apps', 'cli', 'src', 'b.ts'), 60); // newer — in second root

    const r = checkDistMcpStaleness(bundle);
    expect(r.stale).toBe(true);
    expect(r.newestSrc).toContain('b.ts');
  });

  it('ignores .test.ts and .d.ts files during walk', () => {
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: true });
    const bundle = join(dir, 'dist-mcp', 'mcp-server.js');
    // All production .ts files older than bundle
    setMtime(bundle, 1800);
    setMtime(join(dir, 'packages', 'orchestrator', 'src', 'a.ts'), 3600);
    setMtime(join(dir, 'apps', 'cli', 'src', 'b.ts'), 3600);

    // Fresh .test.ts and .d.ts would be newer — should be ignored
    writeFileSync(join(dir, 'packages', 'orchestrator', 'src', 'a.test.ts'), '// test');
    writeFileSync(join(dir, 'packages', 'orchestrator', 'src', 'a.d.ts'), '// dts');

    const r = checkDistMcpStaleness(bundle);
    expect(r.stale).toBe(false);
  });

  it('caches result across calls (second call ignores arg)', () => {
    const dir = makeRepo(fresh(), { withSrc: true, withBundle: true });
    const bundle = join(dir, 'dist-mcp', 'mcp-server.js');
    setMtime(bundle, 3600);
    setMtime(join(dir, 'packages', 'orchestrator', 'src', 'a.ts'), 60);

    const first = checkDistMcpStaleness(bundle);
    const second = checkDistMcpStaleness(); // no arg
    expect(second).toBe(first); // same object reference = cached
  });
});

describe('formatStalenessWarning + renderStalenessBanner', () => {
  it('returns null when not stale', () => {
    expect(formatStalenessWarning({ stale: false, deltaMs: 0, skipped: null })).toBe(null);
    expect(renderStalenessBanner({ stale: false, deltaMs: 0, skipped: null })).toBe('');
  });

  it('returns null when skipped', () => {
    expect(formatStalenessWarning({ stale: true, deltaMs: 1000, skipped: 'installed' })).toBe(null);
  });

  it('formats with minute granularity under an hour', () => {
    const msg = formatStalenessWarning({ stale: true, deltaMs: 5 * 60 * 1000, skipped: null });
    expect(msg).toContain('5m older');
  });

  it('formats with hour granularity under a day', () => {
    const msg = formatStalenessWarning({ stale: true, deltaMs: 3 * 60 * 60 * 1000, skipped: null });
    expect(msg).toContain('3.0h older');
  });

  it('renders banner as blockquote markdown', () => {
    const banner = renderStalenessBanner({ stale: true, deltaMs: 60 * 60 * 1000, skipped: null });
    expect(banner).toMatch(/^> ⚠ \*\*Bundle staleness:\*\*/);
    expect(banner).toContain('npm run build:mcp');
  });
});
