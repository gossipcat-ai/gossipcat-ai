/**
 * Behavioral tests for the `gossipcat code` argv-dispatch branch in
 * `apps/cli/src/mcp-server-sdk.ts` — specifically the code path that
 * launches Claude Code via `runCodeCommand`.
 *
 * Spawns the built bundle (`dist-mcp/mcp-server.js`) with `node`, just like
 * `mcp-server-argv-dispatch.test.ts` does, so we test the exact artifact
 * users install from npm.
 *
 * If the bundle is missing the test is skipped with a hint to run
 * `npm run build:mcp` first.
 *
 * Coverage goals:
 *   (a) `gossipcat code` does NOT print "unknown subcommand 'code'" and does NOT exit 2.
 *   (b) The code-launch handler is reached: stderr contains "[gossipcat code]"
 *       and/or "is not on your PATH" (because `claude` is removed from PATH),
 *       and the process exits non-zero from the code-launch path, NOT the unknown path.
 *   (c) The MCP server does NOT boot on the `code` path: no .gossip/mcp.log side-effect.
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { tmpdir } from 'os';

const BUNDLE_PATH = resolve(__dirname, '..', '..', 'dist-mcp', 'mcp-server.js');

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the bundle with a stripped PATH so `claude` is not available —
 * this forces the code-launch handler to hit its "not on PATH" error path,
 * which surfaces `[gossipcat code]` on stderr and exits non-zero.
 *
 * `PATH` is set to just the node bin directory so `node` itself is still
 * resolvable (required for dynamic imports inside the bundle) but `claude`
 * is absent.
 */
function runBundleNoClaudePath(
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolveP, reject) => {
    // Keep only the directory that contains the `node` binary so the bundle
    // can still spawn child processes via node, but `claude` is invisible.
    const nodeBinDir = dirname(process.execPath);
    const child = spawn(process.execPath, [BUNDLE_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: nodeBinDir,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    // Close stdin so the bundle doesn't hang reading MCP stdio.
    child.stdin.end();

    const timeoutMs = opts.timeoutMs ?? 15_000;
    const hardTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      reject(new Error(`bundle did not exit within ${timeoutMs}ms (args=${args.join(' ')})`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(hardTimer);
      resolveP({ code, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(hardTimer);
      reject(err);
    });
  });
}

const describeOrSkip = existsSync(BUNDLE_PATH) ? describe : describe.skip;

describeOrSkip('dist-mcp/mcp-server.js — `code` subcommand dispatch', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('(a) does NOT print "unknown subcommand \'code\'" and does NOT exit 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-code-dispatch-'));
    created.push(root);

    const res = await runBundleNoClaudePath(['code'], { cwd: root });

    expect(res.code).not.toBe(2);
    expect(res.stderr).not.toContain("unknown subcommand 'code'");
  });

  it('(b) reaches the code-launch handler: stderr contains [gossipcat code] and/or PATH error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-code-dispatch-'));
    created.push(root);

    const res = await runBundleNoClaudePath(['code'], { cwd: root });

    // The code-launch handler in code-launch.ts emits "[gossipcat code]" on stderr
    // whenever it starts up (for notes/warnings) and on the PATH error path.
    // With `claude` absent from PATH the "is not on your PATH" branch fires.
    const reachedCodeLaunch =
      res.stderr.includes('[gossipcat code]') ||
      res.stderr.includes('is not on your PATH');
    expect(reachedCodeLaunch).toBe(true);
  });

  it('(b) exits non-zero from the code-launch path (not the unknown-subcommand path)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-code-dispatch-'));
    created.push(root);

    const res = await runBundleNoClaudePath(['code'], { cwd: root });

    // Must exit non-zero (claude not on PATH → error)...
    expect(res.code).not.toBe(0);
    // ...but NOT via the unknown-subcommand exit-2 path.
    expect(res.stderr).not.toContain("unknown subcommand 'code'");
  });

  it('(c) MCP server does NOT boot on the code path — no .gossip/mcp.log side-effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-code-dispatch-'));
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });

    await runBundleNoClaudePath(['code'], { cwd: root });

    // The MCP server boot path writes .gossip/mcp.log as its first side-effect.
    // The `code` branch returns `true` from the IIFE, so the server never starts.
    expect(existsSync(join(root, '.gossip', 'mcp.log'))).toBe(false);
  });
});
