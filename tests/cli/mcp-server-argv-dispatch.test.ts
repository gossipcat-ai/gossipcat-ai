/**
 * Integration test for the argv-dispatch shim at the top of
 * `apps/cli/src/mcp-server-sdk.ts` — i.e. the shim that makes the
 * published `gossipcat` binary (which is `dist-mcp/mcp-server.js`)
 * route `hook --run` / `--help` / unknown / no-arg invocations
 * correctly instead of always booting the MCP server.
 *
 * Spawns the built bundle (`dist-mcp/mcp-server.js`) with `node` so we
 * test the exact artifact users install from npm.
 *
 * If the bundle is missing the test is skipped with a hint to run
 * `npm run build:mcp` first.
 *
 * Covers the bug from
 * `project_bootstrap_hook_command_dispatch_bug.md`:
 *   - `gossipcat hook --run` MUST NOT boot a second MCP server.
 *   - It must read .gossip/bootstrap.md, print it, exit 0, no .gossip/mcp.log
 *     spam, no stdin hang.
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const BUNDLE_PATH = resolve(__dirname, '..', '..', 'dist-mcp', 'mcp-server.js');

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runBundle(args: string[], opts: { cwd?: string; timeoutMs?: number; killAfterMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [BUNDLE_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    // Close stdin so the bundle doesn't hang reading MCP stdio.
    child.stdin.end();

    const timeoutMs = opts.timeoutMs ?? 10_000;
    const killAfterMs = opts.killAfterMs;
    let killTimer: NodeJS.Timeout | undefined;
    if (killAfterMs !== undefined) {
      killTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* */ }
      }, killAfterMs);
    }
    const hardTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      reject(new Error(`bundle did not exit within ${timeoutMs}ms (args=${args.join(' ')})`));
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(hardTimer);
      resolveP({ code, signal, stdout, stderr });
    });
    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      clearTimeout(hardTimer);
      reject(err);
    });
  });
}

const describeOrSkip = existsSync(BUNDLE_PATH) ? describe : describe.skip;

describeOrSkip('dist-mcp/mcp-server.js argv dispatch shim', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length) {
      const dir = created.pop()!;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('`hook --run` with a bootstrap fixture exits 0, prints content, no .gossip/mcp.log spam', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-argv-shim-'));
    created.push(root);
    mkdirSync(join(root, '.gossip'), { recursive: true });
    const bootstrapPath = join(root, '.gossip', 'bootstrap.md');
    writeFileSync(bootstrapPath, '# fixture bootstrap\nHELLO_FIXTURE_TOKEN\n');

    const res = await runBundle(['hook', '--run'], { cwd: root, timeoutMs: 8_000 });

    expect(res.code).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.stdout).toContain('HELLO_FIXTURE_TOKEN');
    // The hook path must NOT trigger the stderr redirect (which would
    // create .gossip/mcp.log). The shim runs BEFORE that block.
    expect(existsSync(join(root, '.gossip', 'mcp.log'))).toBe(false);
  });

  it('`hook` with no subcommand prints usage to stderr and exits 2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-argv-shim-'));
    created.push(root);
    const res = await runBundle(['hook'], { cwd: root, timeoutMs: 8_000 });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Usage: gossipcat hook --run');
  });

  it('`--help` exits 0 with usage on stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-argv-shim-'));
    created.push(root);
    const res = await runBundle(['--help'], { cwd: root, timeoutMs: 8_000 });
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain('usage');
    expect(res.stdout).toContain('gossipcat hook --run');
  });

  it('unknown subcommand exits 2 with an error on stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-argv-shim-'));
    created.push(root);
    const res = await runBundle(['nosuchcommand'], { cwd: root, timeoutMs: 8_000 });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("unknown subcommand 'nosuchcommand'");
  });

  it('no args → MCP server boots (stderr redirect activates); SIGTERM after 1.5s ends it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gossipcat-argv-shim-'));
    created.push(root);
    // No bootstrap fixture; we just verify the server starts and keeps running
    // until SIGTERM. Closing stdin would cause the stdio transport to exit, so
    // we must send SIGTERM explicitly. The runBundle helper closes stdin
    // unconditionally though, so the stdio transport will end almost
    // immediately — that's still a "MCP server booted" signal (it processed
    // stdio close, didn't exit 2 from the shim).
    const res = await runBundle([], { cwd: root, timeoutMs: 8_000, killAfterMs: 2_000 });
    // Critical assertion: shim did NOT short-circuit with exit code 2.
    expect(res.code).not.toBe(2);
    // And the heavy-import path was taken — .gossip/mcp.log exists.
    expect(existsSync(join(root, '.gossip', 'mcp.log'))).toBe(true);
  });
});
