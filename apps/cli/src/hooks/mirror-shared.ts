/**
 * Shared library for the three activity-mirror hooks (spec
 * `docs/specs/2026-06-14-dashboard-cc-activity-mirror-v2.md` §Component 1 +
 * §Security + §Consensus-hardening P1#4).
 *
 * Every helper here is FAIL-OPEN: a missing relay, missing/invalid auth key, or
 * any thrown error results in a silent no-op (no POST), never a crash. These
 * hooks run on EVERY user turn / tool call; they must never freeze or fail a
 * turn (probe fact Q4 — hooks block until exit, so the POST is delegated to a
 * DETACHED, time-bounded `curl`).
 */
import { openSync, fstatSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import type { MirrorRole } from './mirror-scrub';

/** Basename of the persisted dashboard-auth file under `.gossip/`. */
const AUTH_FILE_NAME = 'dashboard-auth.json';
/** Sticky relay port file under `.gossip/`. */
const RELAY_PORT_FILE = 'relay.port';
/** Bound on how much of the auth file we read (it is tiny — key + sessions). */
const AUTH_MAX_READ = 64 * 1024;
/** curl wall-clock budget — the POST must never freeze a turn (Q4). */
const CURL_MAX_TIME = '2';

/** One frame as submitted in the POST body. */
export interface MirrorFramePayload {
  role: MirrorRole;
  text: string;
}

/**
 * Read the dashboard auth key from `.gossip/dashboard-auth.json`, P1#4 hardened.
 *
 * Hardening (consensus P1#4):
 *   - SINGLE open()+fstat() — NOT stat-then-read (avoids the TOCTOU window where
 *     the file is swapped between the stat and the read).
 *   - Permission check `(mode & 0o077) === 0` — reject any group/other-readable
 *     file. The key is a bearer credential; if anyone but the owner can read it
 *     we refuse to use it (fail-open → no POST).
 *   - Tolerate the atomic-rename race with `DashboardAuth.persist()` (auth.ts
 *     writes a `.tmp` then renames): any ENOENT / parse failure → fail-open.
 *
 * Returns the 32-hex key string, or null on ANY problem (missing file, bad
 * perms, parse error, unexpected shape). Null means "no POST" — never throw.
 */
export function readDashboardKey(cwd: string): string | null {
  const path = join(cwd, '.gossip', AUTH_FILE_NAME);
  let fd: number | null = null;
  try {
    // Single open — the fd is the stable handle the fstat + read both operate
    // on, so a rename between the two cannot swap the bytes out from under us.
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    // Reject group/other-readable. 0o077 = group+other rwx bits.
    if ((st.mode & 0o077) !== 0) return null;
    if (st.size <= 0 || st.size > AUTH_MAX_READ) return null;

    const buf = Buffer.alloc(st.size);
    const n = readSync(fd, buf, 0, st.size, 0);
    const raw = buf.toString('utf8', 0, n);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const key = (parsed as { key?: unknown }).key;
    // Key is randomBytes(16).toString('hex') — exactly 32 lowercase hex chars.
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/.test(key)) return null;
    return key;
  } catch {
    // ENOENT (no relay ever started, or mid-rename), EACCES, JSON parse error —
    // all fail-open: no key → no POST.
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/**
 * Locate the relay's listening port. Mirrors the sticky-port precedence used by
 * the rest of the CLI (env wins, else the `.gossip/relay.port` sticky file).
 * We do NOT probe-bind here (that would race the live relay we are trying to
 * reach); we just read the recorded port. Returns null when absent/invalid →
 * fail-open (no relay → no POST).
 */
export function readRelayPort(cwd: string): number | null {
  const envRaw = process.env['GOSSIP_RELAY_PORT'];
  if (envRaw !== undefined && envRaw !== '') {
    const n = parseInt(envRaw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 65535) return n;
  }
  let fd: number | null = null;
  try {
    fd = openSync(join(cwd, '.gossip', RELAY_PORT_FILE), 'r');
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    const v = parseInt(buf.toString('utf8', 0, n).trim(), 10);
    if (!Number.isFinite(v) || v < 1 || v > 65535) return null;
    return v;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

/** Minimal stdin-pipe handle used to feed curl's `--config -` directives. */
export interface SpawnStdin {
  write(chunk: string): void;
  end(): void;
}

/** Minimal spawned-child handle the seam returns. */
export interface SpawnChild {
  unref(): void;
  /** Writable stdin pipe (present when stdio[0] is 'pipe'). */
  stdin?: SpawnStdin | null;
}

export interface PostMirrorOptions {
  cwd: string;
  /** Frames to coalesce into a single POST (batching — spec §Batching). */
  frames: MirrorFramePayload[];
  /** Optional dashboard chat_id parsed from a channel wrapper. */
  chatId?: string;
  /** Optional CC session_id so the relay can resolve a terminal turn's stream. */
  sessionId?: string;
  /** Test seam: capture the spawn argv + stdin instead of running curl. */
  spawnImpl?: (cmd: string, args: string[], opts: SpawnOpts) => SpawnChild;
}

interface SpawnOpts {
  detached: boolean;
  /** stdin piped (config directives), stdout/stderr discarded. */
  stdio: ['pipe', 'ignore', 'ignore'];
}

/**
 * Fire a NON-BLOCKING, time-bounded mirror POST. Spawns `curl --config -` as a
 * DETACHED, unref'd child so the hook process can exit immediately without
 * waiting on the HTTP round-trip (Q4 — never freeze a turn). Reads the relay
 * port + auth key fresh from disk; no-ops silently when either is absent.
 *
 * trust_boundaries (consensus 4a4b2087 HIGH): the bearer key is NEVER placed on
 * curl's argv (argv is world-visible via `ps`/`/proc`). Instead we pipe a curl
 * config file over the child's STDIN (`--config -`); the Authorization header —
 * and every other directive — is read from the pipe, so the key lives only in
 * the in-memory pipe: never argv, never disk.
 *
 * Returns true if a POST was dispatched, false if it was a no-op (no relay / no
 * key / no frames). Never throws.
 */
export function postMirror(opts: PostMirrorOptions): boolean {
  try {
    if (!opts.frames || opts.frames.length === 0) return false;
    const port = readRelayPort(opts.cwd);
    if (port === null) return false;
    const key = readDashboardKey(opts.cwd);
    if (key === null) return false;

    const body: { chat_id?: string; session_id?: string; frames: MirrorFramePayload[] } = {
      frames: opts.frames,
    };
    if (opts.chatId) body.chat_id = opts.chatId;
    if (opts.sessionId) body.session_id = opts.sessionId;

    const url = `http://127.0.0.1:${port}/dashboard/api/bridge/mirror`;
    // Only safe, non-secret directives go on argv. `--config -` tells curl to
    // read the rest of its directives (including the bearer header) from stdin.
    const args = ['--config', '-'];

    const doSpawn = opts.spawnImpl ?? defaultSpawn;
    const child = doSpawn('curl', args, { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });

    // curl config-file syntax: one `key = "value"` per line. Double-quoted
    // values let curl handle the JSON body verbatim. Key (32-hex, validated by
    // readDashboardKey) and url (numeric port) contain no `"` to escape.
    const config = buildCurlConfig({ url, key, body: JSON.stringify(body) });
    if (child.stdin) {
      child.stdin.write(config);
      child.stdin.end();
    }
    // unref so the parent (the hook) can exit without waiting on curl.
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the curl `--config -` directive block. The bearer key is delivered HERE
 * (over stdin), never on argv. JSON-encode the body so embedded quotes/newlines
 * cannot break out of the double-quoted config value.
 */
export function buildCurlConfig(input: { url: string; key: string; body: string }): string {
  return [
    'silent',
    'show-error',
    `max-time = ${CURL_MAX_TIME}`,
    'request = "POST"',
    'header = "Content-Type: application/json"',
    `header = "Authorization: Bearer ${input.key}"`,
    `data-binary = ${JSON.stringify(input.body)}`,
    `url = ${JSON.stringify(input.url)}`,
    '',
  ].join('\n');
}

function defaultSpawn(cmd: string, args: string[], opts: SpawnOpts): SpawnChild {
  return spawn(cmd, args, opts) as unknown as SpawnChild;
}

/** Resolve the cwd a hook should anchor its `.gossip/` lookups to. */
export function resolveCwd(payloadCwd: unknown): string {
  if (typeof payloadCwd === 'string' && payloadCwd.length > 0) return payloadCwd;
  return process.cwd();
}

/**
 * Read all of stdin to a string (the CC hook payload arrives on stdin as JSON).
 * Resolves to '' on EOF with no data. Never rejects — a read error resolves ''
 * so the caller fail-opens.
 */
export function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    try {
      const stdin = process.stdin;
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => { data += chunk; });
      stdin.on('end', () => resolve(data));
      stdin.on('error', () => resolve(data));
      // If stdin is a TTY (no piped payload), resolve empty immediately.
      if (stdin.isTTY) resolve('');
    } catch {
      resolve('');
    }
  });
}

/** Parse a hook stdin payload to an object, or null on any error. */
export function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}
