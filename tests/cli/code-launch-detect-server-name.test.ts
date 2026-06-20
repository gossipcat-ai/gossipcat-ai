/**
 * Unit tests for `detectServerName` exported from apps/cli/src/code-launch.ts.
 *
 * Tests:
 *  (a) cwd .mcp.json with gossipcat entry + safe name → returns [name, false] AND
 *      cwd-source stderr line is emitted.
 *  (b) cwd + home both have gossipcat entries with DIFFERENT safe names → returns cwd
 *      name AND mismatch warning emitted.
 *  (c) only ~/.claude.json has gossipcat entry → returns home name, NO cwd-source warning.
 *  (d) cwd .mcp.json has a gossipcat entry with an UNSAFE name → fallback ["gossipcat", true].
 *  (b2) cwd + home have SAME name → cwd wins, cwd-source warning, NO mismatch.
 *
 * Strategy: detectServerName(cwd) reads <cwd>/.mcp.json and homedir()/.claude.json.
 * We control cwd by passing a temp directory. For home, we mock 'os' module via jest.mock.
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock 'os' module so homedir() returns a controllable path per test.
// homedirMock is captured by ref so individual tests can mutate its return value.
let homedirTarget = '';
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: jest.fn(() => homedirTarget),
  };
});

// Import after mock registration (jest.mock is hoisted, so this is fine)
import { detectServerName } from '../../apps/cli/src/code-launch';

/** A minimal .mcp.json with a gossipcat node mcp-server.js entry */
function mcpJsonContent(serverName: string): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: {
        command: 'node',
        args: ['dist-mcp/mcp-server.js'],
      },
    },
  });
}

/** A minimal ~/.claude.json with a gossipcat entry (npx form) */
function claudeJsonContent(serverName: string): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: {
        command: 'npx',
        args: ['gossipcat', 'mcp-serve'],
      },
    },
  });
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'gctest-'));
}

describe('detectServerName — trust-boundary observability', () => {
  let stderrLines: string[];
  let stderrSpy: jest.SpyInstance;
  let tmpDirs: string[];

  beforeEach(() => {
    stderrLines = [];
    tmpDirs = [];
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((msg: string | Uint8Array) => {
      stderrLines.push(typeof msg === 'string' ? msg : msg.toString());
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    for (const d of tmpDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tmpDirs = [];
  });

  function tmpDir(): string {
    const d = makeTmpDir();
    tmpDirs.push(d);
    return d;
  }

  it('(a) cwd .mcp.json gossipcat entry → returns [name, false] and cwd-source warning', () => {
    const cwdDir = tmpDir();
    const homeDir = tmpDir();
    writeFileSync(join(cwdDir, '.mcp.json'), mcpJsonContent('my-gossipcat'));
    homedirTarget = homeDir; // empty home — no .claude.json

    const result = detectServerName(cwdDir);

    expect(result).toEqual(['my-gossipcat', false]);

    const cwdWarn = stderrLines.find(l =>
      l.includes('cwd-local config') && l.includes('my-gossipcat')
    );
    expect(cwdWarn).toBeDefined();
    // Should NOT contain mismatch warning (home has no entry)
    const mismatch = stderrLines.find(l => l.includes('differs between'));
    expect(mismatch).toBeUndefined();
  });

  it('(b) cwd + home both have gossipcat entries with DIFFERENT names → cwd wins + mismatch warning', () => {
    const cwdDir = tmpDir();
    const homeDir = tmpDir();
    writeFileSync(join(cwdDir, '.mcp.json'), mcpJsonContent('repo-gossipcat'));
    writeFileSync(join(homeDir, '.claude.json'), claudeJsonContent('global-gossipcat'));
    homedirTarget = homeDir;

    const result = detectServerName(cwdDir);

    expect(result).toEqual(['repo-gossipcat', false]);

    // cwd-source warning must be present
    const cwdWarn = stderrLines.find(l =>
      l.includes('cwd-local config') && l.includes('repo-gossipcat')
    );
    expect(cwdWarn).toBeDefined();

    // mismatch warning must be present with both names
    const mismatch = stderrLines.find(l =>
      l.includes('differs between') &&
      l.includes('repo-gossipcat') &&
      l.includes('global-gossipcat')
    );
    expect(mismatch).toBeDefined();
  });

  it('(c) only ~/.claude.json has gossipcat entry → returns home name, NO cwd-source warning', () => {
    const cwdDir = tmpDir();
    const homeDir = tmpDir();
    // No .mcp.json in cwdDir — only home has the entry
    writeFileSync(join(homeDir, '.claude.json'), claudeJsonContent('home-only'));
    homedirTarget = homeDir;

    const result = detectServerName(cwdDir);

    expect(result).toEqual(['home-only', false]);

    // Must NOT emit cwd-source warning
    const cwdWarn = stderrLines.find(l => l.includes('cwd-local config'));
    expect(cwdWarn).toBeUndefined();
    // Must NOT emit mismatch warning
    const mismatch = stderrLines.find(l => l.includes('differs between'));
    expect(mismatch).toBeUndefined();
  });

  it('(d) cwd .mcp.json has unsafe server name → fallback ["gossipcat", true]', () => {
    const cwdDir = tmpDir();
    const homeDir = tmpDir();
    // Write .mcp.json with an unsafe server name (contains spaces + special chars)
    const unsafe = JSON.stringify({
      mcpServers: {
        'bad name; rm -rf /': {
          command: 'node',
          args: ['dist-mcp/mcp-server.js'],
        },
      },
    });
    writeFileSync(join(cwdDir, '.mcp.json'), unsafe);
    homedirTarget = homeDir;

    const result = detectServerName(cwdDir);

    expect(result).toEqual(['gossipcat', true]);

    // Should NOT emit cwd-source warning (name was rejected)
    const cwdWarn = stderrLines.find(l => l.includes('cwd-local config'));
    expect(cwdWarn).toBeUndefined();
    // Should emit unsafe-name warning
    const unsafeWarn = stderrLines.find(l => l.includes('unsafe characters'));
    expect(unsafeWarn).toBeDefined();
  });

  it('(b2) cwd + home have SAME name → cwd wins, cwd-source warning, NO mismatch', () => {
    const cwdDir = tmpDir();
    const homeDir = tmpDir();
    writeFileSync(join(cwdDir, '.mcp.json'), mcpJsonContent('shared-name'));
    writeFileSync(join(homeDir, '.claude.json'), claudeJsonContent('shared-name'));
    homedirTarget = homeDir;

    const result = detectServerName(cwdDir);

    expect(result).toEqual(['shared-name', false]);

    // cwd-source warning present
    const cwdWarn = stderrLines.find(l => l.includes('cwd-local config'));
    expect(cwdWarn).toBeDefined();
    // No mismatch warning (same name)
    const mismatch = stderrLines.find(l => l.includes('differs between'));
    expect(mismatch).toBeUndefined();
  });
});
