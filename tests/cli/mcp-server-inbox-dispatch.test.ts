/**
 * Behavioral tests for the `gossipcat inbox` argv-dispatch branch of the
 * published bundle (dist-mcp/mcp-server.js). Mirrors
 * mcp-server-code-dispatch.test.ts: spawn the exact artifact, assert the inbox
 * handler runs and the MCP server never boots (no .gossip/mcp.log, no relay).
 *
 * Skipped when the bundle is missing — run `npm run build:mcp` first.
 */
import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { ClaudeInbox, inboxDirFor } from '@gossip/relay/dashboard/claude-inbox';

const BUNDLE_PATH = resolve(__dirname, '..', '..', 'dist-mcp', 'mcp-server.js');

function runBundle(args: string[], cwd: string, timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, [BUNDLE_PATH, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.stdin.end();
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`bundle hung: ${args.join(' ')}`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolveP({ code, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const describeOrSkip = existsSync(BUNDLE_PATH) ? describe : describe.skip;

describeOrSkip('dist-mcp/mcp-server.js — `inbox` subcommand dispatch', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gossipcat-inbox-dispatch-'));
    mkdirSync(join(root, '.gossip'), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('`inbox wait --timeout 1` exits 2 on timeout without booting the MCP server', async () => {
    const res = await runBundle(['inbox', 'wait', '--timeout', '1'], root);
    expect(res.code).toBe(2);
    expect(res.stderr).not.toContain('unknown subcommand');
    expect(existsSync(join(root, '.gossip', 'mcp.log'))).toBe(false);
    expect(existsSync(join(root, '.gossip', 'relay.port'))).toBe(false);
  });

  it('`inbox wait` delivers a queued message, fenced, and exits 0', async () => {
    const inbox = new ClaudeInbox(inboxDirFor(root));
    const e = inbox.append('chat-x', 'hello from the dashboard');
    const res = await runBundle(['inbox', 'wait', '--timeout', '5'], root);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('UNTRUSTED_DASHBOARD_MESSAGE');
    expect(res.stdout).toContain('hello from the dashboard');
    expect(res.stdout).toContain('chat_id "chat-x"');
    expect(inbox.get(e.id)?.status).toBe('delivered');
    expect(existsSync(join(root, '.gossip', 'mcp.log'))).toBe(false);
  });

  it('`inbox bogus` is a usage error (exit 1), not the unknown-subcommand path', async () => {
    const res = await runBundle(['inbox', 'bogus'], root);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Usage: gossipcat inbox');
  });
});
