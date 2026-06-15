/**
 * Unit tests for the activity-mirror shared lib
 * (apps/cli/src/hooks/mirror-shared.ts): auth-key read fail-open (P1#4) +
 * non-blocking detached/unref'd curl spawn (Q4). No real network.
 */
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readDashboardKey, readRelayPort, postMirror } from '../../apps/cli/src/hooks/mirror-shared';

const VALID_KEY = 'a'.repeat(32);

function freshProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-shared-'));
  // .gossip dir
  require('fs').mkdirSync(join(dir, '.gossip'), { recursive: true });
  return dir;
}

function writeAuth(dir: string, body: string, mode = 0o600): void {
  const p = join(dir, '.gossip', 'dashboard-auth.json');
  writeFileSync(p, body, { mode });
  chmodSync(p, mode);
}

describe('readDashboardKey — P1#4 hardening', () => {
  let dir: string;
  beforeEach(() => { dir = freshProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads a valid 0600 key', () => {
    writeAuth(dir, JSON.stringify({ version: 1, key: VALID_KEY, sessions: [] }), 0o600);
    expect(readDashboardKey(dir)).toBe(VALID_KEY);
  });

  it('fails open (null) when the file is missing', () => {
    expect(readDashboardKey(dir)).toBeNull();
  });

  it('fails open when the file is group/other-readable (reject (mode & 0o077) !== 0)', () => {
    writeAuth(dir, JSON.stringify({ version: 1, key: VALID_KEY, sessions: [] }), 0o644);
    expect(readDashboardKey(dir)).toBeNull();
  });

  it('fails open on a parse error', () => {
    writeAuth(dir, '{ not valid json', 0o600);
    expect(readDashboardKey(dir)).toBeNull();
  });

  it('fails open when the key is not 32-hex', () => {
    writeAuth(dir, JSON.stringify({ version: 1, key: 'TOO-SHORT', sessions: [] }), 0o600);
    expect(readDashboardKey(dir)).toBeNull();
  });
});

describe('readRelayPort', () => {
  let dir: string;
  beforeEach(() => { dir = freshProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads a valid sticky port', () => {
    writeFileSync(join(dir, '.gossip', 'relay.port'), '63007');
    expect(readRelayPort(dir)).toBe(63007);
  });

  it('returns null when absent', () => {
    expect(readRelayPort(dir)).toBeNull();
  });

  it('returns null for an out-of-range value', () => {
    writeFileSync(join(dir, '.gossip', 'relay.port'), '99999');
    expect(readRelayPort(dir)).toBeNull();
  });
});

describe('postMirror — non-blocking detached spawn (Q4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshProject();
    writeFileSync(join(dir, '.gossip', 'relay.port'), '63007');
    writeAuth(dir, JSON.stringify({ version: 1, key: VALID_KEY, sessions: [] }), 0o600);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('spawns curl --config - detached+unref, stdin piped (never freezes a turn)', () => {
    let spawned: { cmd: string; args: string[]; opts: any } | null = null;
    let unrefed = false;
    let stdinChunks = '';
    let stdinEnded = false;
    const ok = postMirror({
      cwd: dir,
      frames: [{ role: 'user', text: 'hello' }],
      spawnImpl: (cmd, args, opts) => {
        spawned = { cmd, args, opts };
        return {
          unref: () => { unrefed = true; },
          stdin: { write: (c: string) => { stdinChunks += c; }, end: () => { stdinEnded = true; } },
        };
      },
    });
    expect(ok).toBe(true);
    expect(spawned).not.toBeNull();
    expect(spawned!.cmd).toBe('curl');
    // Only safe directives on argv — `--config -` reads the rest from stdin.
    expect(spawned!.args).toEqual(['--config', '-']);
    expect(spawned!.opts.detached).toBe(true);
    expect(spawned!.opts.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(unrefed).toBe(true);
    expect(stdinEnded).toBe(true);
    // max-time directive lives in the piped config, not argv.
    expect(stdinChunks).toContain('max-time = 2');
  });

  it('delivers the bearer key ONLY via stdin config — never on argv (HIGH 4a4b2087)', () => {
    let args: string[] = [];
    let stdinChunks = '';
    postMirror({
      cwd: dir,
      frames: [{ role: 'user', text: 'hi' }],
      spawnImpl: (_c, a) => {
        args = a;
        return { unref() {}, stdin: { write: (c: string) => { stdinChunks += c; }, end() {} } };
      },
    });
    // The key (and the literal 'Bearer') must NOT appear anywhere in argv.
    const argvJoined = args.join(' ');
    expect(argvJoined).not.toContain(VALID_KEY);
    expect(argvJoined).not.toContain('Bearer');
    // The key is delivered over the stdin config pipe instead.
    expect(stdinChunks).toContain(`header = "Authorization: Bearer ${VALID_KEY}"`);
    // Body carries the frames (also piped, not on argv).
    const m = stdinChunks.match(/data-binary = (".*")/);
    expect(m).not.toBeNull();
    const body = JSON.parse(JSON.parse(m![1]));
    expect(body.frames[0]).toEqual({ role: 'user', text: 'hi' });
  });

  it('no-ops (no spawn) when there is no relay port', () => {
    rmSync(join(dir, '.gossip', 'relay.port'));
    let called = false;
    const ok = postMirror({
      cwd: dir,
      frames: [{ role: 'user', text: 'x' }],
      spawnImpl: () => { called = true; return { unref() {} }; },
    });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it('no-ops when there is no auth key', () => {
    rmSync(join(dir, '.gossip', 'dashboard-auth.json'));
    let called = false;
    const ok = postMirror({
      cwd: dir,
      frames: [{ role: 'user', text: 'x' }],
      spawnImpl: () => { called = true; return { unref() {} }; },
    });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it('no-ops on an empty frame list', () => {
    let called = false;
    const ok = postMirror({
      cwd: dir,
      frames: [],
      spawnImpl: () => { called = true; return { unref() {} }; },
    });
    expect(ok).toBe(false);
    expect(called).toBe(false);
  });

  it('includes chat_id and session_id in the body when provided', () => {
    let stdinChunks = '';
    postMirror({
      cwd: dir,
      chatId: 'cid',
      sessionId: 'sid',
      frames: [{ role: 'activity', text: '🔧 Bash · ls' }],
      spawnImpl: () => ({ unref() {}, stdin: { write: (c: string) => { stdinChunks += c; }, end() {} } }),
    });
    const m = stdinChunks.match(/data-binary = (".*")/);
    const body = JSON.parse(JSON.parse(m![1]));
    expect(body.chat_id).toBe('cid');
    expect(body.session_id).toBe('sid');
  });
});
