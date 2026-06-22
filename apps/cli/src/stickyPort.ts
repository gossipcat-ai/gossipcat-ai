// Sticky per-project port selection.
//
// Motivation: running multiple parallel gossipcat instances on one machine used
// to fight over hardcoded ports (24420 relay, 24421 HTTP MCP). Both now use
// pickStickyPort (env → sticky file → OS-assigned) so parallel instances
// yield gracefully to collisions. Letting the OS assign every boot would
// break dashboard bookmarks and MCP client configs across restarts — sticky
// port files give each project a stable port that survives reboots.
//
// Policy (see pickStickyPort):
//   1. Env var wins unconditionally (no sticky read, no fallback).
//   2. Else read <project>/.gossip/<file> and probe-bind that port.
//   3. Else port 0 (OS picks a free one).
// After a successful listen() the caller writes the bound port back via
// writeStickyPort(), so the next boot re-uses it when possible.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { createServer } from 'net';

export const RELAY_STICKY_FILE = join('.gossip', 'relay.port');
export const HTTP_MCP_STICKY_FILE = join('.gossip', 'http-mcp.port');

function stickyPath(filename: string): string {
  return join(process.cwd(), filename);
}

/** Read a persisted port number from the sticky file, or null if absent/invalid. */
export function readStickyPort(filename: string): number | null {
  const p = stickyPath(filename);
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
    return n;
  } catch {
    return null;
  }
}

/** Write the actual bound port back to the sticky file (best-effort). */
export function writeStickyPort(filename: string, port: number): void {
  if (!Number.isFinite(port) || port < 1 || port > 65535) return;
  const p = stickyPath(filename);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, String(port), 'utf-8');
  } catch {
    /* best-effort */
  }
}

/**
 * Probe whether a TCP port is bindable on `host` (default 127.0.0.1).
 * Briefly opens a listener, then closes it. Returns true if the bind
 * succeeded, false otherwise (EADDRINUSE, EACCES, etc.).
 *
 * Note: there is a tiny TOCTOU window between probe and the real listen,
 * but that's fine — the caller still has an EADDRINUSE handler as a safety
 * net, and losing a race just means we fall back to port 0.
 */
export function probePort(port: number, host: string = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch { /* ignore */ }
      resolve(ok);
    };
    srv.once('error', () => done(false));
    try {
      srv.listen(port, host, () => {
        srv.close(() => done(true));
      });
    } catch {
      done(false);
    }
  });
}

export interface StickyPortResult {
  /** The port to pass to the listener (0 means OS-assigned). */
  port: number;
  /** Where the port came from. Used by gossip_status to surface a (sticky) hint. */
  source: 'env' | 'sticky' | 'auto';
}

/**
 * Pick a port following the env → sticky → auto policy.
 *
 * @param envVar        Name of the env var that overrides everything.
 * @param stickyFile    Project-relative sticky file path (e.g. `.gossip/relay.port`).
 * @param probeHost     Host to probe-bind on when validating the sticky port.
 */
export async function pickStickyPort(
  envVar: string,
  stickyFile: string,
  probeHost: string = '127.0.0.1',
): Promise<StickyPortResult> {
  // 1. Env var wins unconditionally.
  const envRaw = process.env[envVar];
  if (envRaw !== undefined && envRaw !== '') {
    const envPort = parseInt(envRaw, 10);
    if (Number.isFinite(envPort) && envPort >= 0 && envPort <= 65535) {
      return { port: envPort, source: 'env' };
    }
  }

  // 2. Sticky file → probe.
  const sticky = readStickyPort(stickyFile);
  if (sticky !== null) {
    const free = await probePort(sticky, probeHost);
    if (free) return { port: sticky, source: 'sticky' };
  }

  // 3. OS-assigned.
  return { port: 0, source: 'auto' };
}
