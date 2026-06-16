/**
 * Unit tests for `classifyShimSubcommand` — the pure routing helper exported
 * from apps/cli/src/mcp-server-sdk.ts.
 *
 * These tests verify that the published binary's argv shim correctly routes
 * `code` to the code-launch handler (rather than the unknown-subcommand
 * rejection at exit 2) without spawning the actual bundle.
 *
 * Covers the bug where PR #586's `gossipcat code` wrapper was unreachable for
 * every npm-installed user because mcp-server-sdk.ts had no `code` branch.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { readFileSync } = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolve } = require('path');

// ── Source-text assertions (no module import needed) ────────────────────────
// Same pattern as key-shim-boot-gate.test.ts — read the source directly to
// lock in structural invariants without triggering the IIFE side-effects.
describe('argv shim source — code branch present', () => {
  const SRC: string = readFileSync(
    resolve(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
    'utf-8',
  );

  it('IIFE derives route from classifyShimSubcommand (no duplicate raw-string routing)', () => {
    // After the refactor the IIFE uses `const kind = classifyShimSubcommand(sub)`
    // and branches on `kind`, not on raw `sub` strings — ensuring the helper is
    // the single source of routing truth and cannot silently diverge.
    expect(SRC).toMatch(/classifyShimSubcommand\(sub\)/);
    // The kind-based code branch must be present in the IIFE.
    expect(SRC).toMatch(/if \(kind === 'code'\)/);
  });

  it('the `code` branch returns true so the async handler owns the process', () => {
    // "return true" must appear in the code branch context.
    expect(SRC).toMatch(/if \(kind === 'code'\)[\s\S]{0,800}return true;/);
  });

  it('the `code` branch imports code-launch and calls runCodeCommand', () => {
    expect(SRC).toMatch(/runCodeCommand/);
    expect(SRC).toMatch(/['"]\.\/code-launch['"]/);
  });

  it('exports classifyShimSubcommand', () => {
    expect(SRC).toMatch(/export function classifyShimSubcommand/);
  });

  it('help text includes gossipcat code [args...]', () => {
    expect(SRC).toMatch(/gossipcat code \[args\.\.\.\]/);
  });

  it('`code` kind-branch appears BEFORE the unknown-subcommand rejection in the IIFE', () => {
    const codeIdx = SRC.indexOf("if (kind === 'code')");
    const unknownIdx = SRC.indexOf("unknown subcommand");
    expect(codeIdx).toBeGreaterThan(-1);
    expect(unknownIdx).toBeGreaterThan(-1);
    expect(codeIdx).toBeLessThan(unknownIdx);
  });
});

// ── classifyShimSubcommand unit tests ───────────────────────────────────────
// The IIFE in mcp-server-sdk.ts runs at module load time and reads
// process.argv, potentially calling process.exit. We use jest.isolateModules
// with a safe argv fixture so the IIFE falls through harmlessly (no-args →
// return false) while we still get access to the exported helper.
describe('classifyShimSubcommand', () => {
  let classify: (sub: string | undefined) => string;

  beforeAll(() => {
    const savedArgv = process.argv;
    const savedEnv = process.env.GOSSIPCAT_MCP_NO_MAIN;
    // Patch argv to a safe no-subcommand state BEFORE the module is loaded,
    // so the IIFE falls through (no-args → return false, no process.exit).
    // Set GOSSIPCAT_MCP_NO_MAIN=1 to prevent main() from booting the MCP server.
    process.argv = ['node', 'mcp-server.js'];
    process.env.GOSSIPCAT_MCP_NO_MAIN = '1';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../apps/cli/src/mcp-server-sdk') as typeof import('../../apps/cli/src/mcp-server-sdk');
      classify = mod.classifyShimSubcommand;
    });
    process.argv = savedArgv;
    if (savedEnv === undefined) {
      delete process.env.GOSSIPCAT_MCP_NO_MAIN;
    } else {
      process.env.GOSSIPCAT_MCP_NO_MAIN = savedEnv;
    }
  });

  it('routes "code" → "code" (not "unknown")', () => {
    expect(classify('code')).toBe('code');
  });

  it('routes undefined → "server" (MCP boot)', () => {
    expect(classify(undefined)).toBe('server');
  });

  it('routes "mcp" alias → "server" (back-compat)', () => {
    expect(classify('mcp')).toBe('server');
  });

  it('routes "hook" → "hook"', () => {
    expect(classify('hook')).toBe('hook');
  });

  it('routes "key" → "key"', () => {
    expect(classify('key')).toBe('key');
  });

  it('routes "help" → "help"', () => {
    expect(classify('help')).toBe('help');
  });

  it('routes "--help" → "help"', () => {
    expect(classify('--help')).toBe('help');
  });

  it('routes "-h" → "help"', () => {
    expect(classify('-h')).toBe('help');
  });

  it('routes bogus subcommand → "unknown"', () => {
    expect(classify('bogus')).toBe('unknown');
  });

  it('routes "setup" → "unknown" (source-only command)', () => {
    expect(classify('setup')).toBe('unknown');
  });
});

// ── resolveHookAction unit tests ────────────────────────────────────────────
// The dist-mcp shim's `hook` branch must dispatch each mirror decision to its
// async handler module — NOT fall through to the synchronous bootstrap
// runHook(). This regression-tests the bug where the bundled binary sent every
// non-usage decision (incl. mirror-prompt|mirror-stop|mirror-tool) to runHook().
describe('resolveHookAction', () => {
  let resolveAction: (
    decision: string,
  ) => { action: string; module?: string; fn?: string };

  beforeAll(() => {
    const savedArgv = process.argv;
    const savedEnv = process.env.GOSSIPCAT_MCP_NO_MAIN;
    process.argv = ['node', 'mcp-server.js'];
    process.env.GOSSIPCAT_MCP_NO_MAIN = '1';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('../../apps/cli/src/mcp-server-sdk') as typeof import('../../apps/cli/src/mcp-server-sdk');
      resolveAction = mod.resolveHookAction as typeof resolveAction;
    });
    process.argv = savedArgv;
    if (savedEnv === undefined) {
      delete process.env.GOSSIPCAT_MCP_NO_MAIN;
    } else {
      process.env.GOSSIPCAT_MCP_NO_MAIN = savedEnv;
    }
  });

  it('maps "run" → synchronous bootstrap hook', () => {
    expect(resolveAction('run')).toEqual({ action: 'run' });
  });

  it('maps "usage" → usage', () => {
    expect(resolveAction('usage')).toEqual({ action: 'usage' });
  });

  it('maps "mirror-prompt" → async runMirrorPromptHook (NOT runHook)', () => {
    expect(resolveAction('mirror-prompt')).toEqual({
      action: 'mirror',
      module: './hooks/mirror-prompt',
      fn: 'runMirrorPromptHook',
    });
  });

  it('maps "mirror-stop" → async runMirrorStopHook (NOT runHook)', () => {
    expect(resolveAction('mirror-stop')).toEqual({
      action: 'mirror',
      module: './hooks/mirror-stop',
      fn: 'runMirrorStopHook',
    });
  });

  it('maps "mirror-tool" → async runMirrorToolHook (NOT runHook)', () => {
    expect(resolveAction('mirror-tool')).toEqual({
      action: 'mirror',
      module: './hooks/mirror-tool',
      fn: 'runMirrorToolHook',
    });
  });

  it('no mirror decision resolves to the bootstrap run action (the bug)', () => {
    for (const d of ['mirror-prompt', 'mirror-stop', 'mirror-tool']) {
      expect(resolveAction(d).action).toBe('mirror');
      expect(resolveAction(d).action).not.toBe('run');
    }
  });
});

// ── Source-text assertions — hook branch dispatches mirror subcommands ───────
// Locks the dist-mcp shim's `hook` branch structure so the async/fail-open
// lifecycle (return true, no premature exit) cannot silently regress.
describe('argv shim source — hook branch mirror dispatch', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathMod = require('path');
  const SRC: string = fs.readFileSync(
    pathMod.resolve(__dirname, '..', '..', 'apps', 'cli', 'src', 'mcp-server-sdk.ts'),
    'utf-8',
  );

  it('exports resolveHookAction', () => {
    expect(SRC).toMatch(/export function resolveHookAction/);
  });

  it('the hook branch derives its action from resolveHookAction', () => {
    expect(SRC).toMatch(/if \(kind === 'hook'\)[\s\S]{0,400}resolveHookAction\(decision\)/);
  });

  it("the hook branch's mirror path returns true so the async handler owns the process", () => {
    // The mirror dispatch must `return true` (like code/key) so the synchronous
    // IIFE does NOT exit(0) before the async handler resolves. We anchor on the
    // dynamic-import of the resolved mirror module followed by `return true`.
    expect(SRC).toMatch(/await import\(mirrorModule\)[\s\S]*?return true;/);
  });

  it('usage message lists the mirror subcommands', () => {
    expect(SRC).toMatch(/Usage: gossipcat hook --run \| mirror-prompt \| mirror-stop \| mirror-tool/);
  });
});
