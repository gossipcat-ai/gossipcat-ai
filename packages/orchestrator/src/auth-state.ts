/**
 * Auth-failure visibility surface (separate from QuotaTracker / quota-state.json).
 *
 * A 401/403 means a provider's API key was rejected — a "manual fix" condition,
 * NOT the "retry later" semantics of a 429 (which QuotaTracker owns). Conflating
 * the two in quota-state.json would be wrong: waiting never fixes a bad key.
 *
 * This module records auth rejections to `.gossip/auth-state.json` as a
 * best-effort side-record (never throws), so `gossip_status` can surface which
 * provider's key is bad. It is VISIBILITY ONLY — it adds no cooldown, gate, or
 * control-flow change. The 401/403 still throws and fails fast exactly as before.
 *
 * Self-healing: a later success clears the entry (clearAuthFailure), and reads
 * TTL-filter stale entries so a transient bad-key window can't wedge a session.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface AuthFailure {
  provider: string;
  status: number;
  at: number;
}

interface AuthStateFile {
  [provider: string]: { status: number; at: number };
}

const PROVIDER_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function statePath(projectRoot: string): string {
  return join(projectRoot, '.gossip', 'auth-state.json');
}

function readState(path: string): AuthStateFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AuthStateFile;
  } catch {
    return {};
  }
}

/**
 * Record a provider auth rejection (HTTP 401/403) as a best-effort side-record.
 * No-op when projectRoot is missing or provider fails validation. Never throws.
 * Merges into existing entries so other providers are preserved.
 */
export function recordAuthFailure(projectRoot: string | undefined, provider: string, status: number): void {
  if (!projectRoot) return;
  if (!PROVIDER_RE.test(provider)) return;
  try {
    const path = statePath(projectRoot);
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const existing = readState(path);
    existing[provider] = { status, at: Date.now() };
    writeFileSync(path, JSON.stringify(existing, null, 2));
  } catch { /* best-effort, never throw */ }
}

/**
 * Clear a provider's recorded auth failure (called on a later success).
 * No-op when projectRoot is missing or the entry is absent. Never throws.
 */
export function clearAuthFailure(projectRoot: string | undefined, provider: string): void {
  if (!projectRoot) return;
  try {
    const path = statePath(projectRoot);
    if (!existsSync(path)) return;
    const existing = readState(path);
    if (!(provider in existing)) return;
    delete existing[provider];
    writeFileSync(path, JSON.stringify(existing, null, 2));
  } catch { /* best-effort, never throw */ }
}

/**
 * Read recent auth failures within the TTL window (default 6h), newest first.
 * Returns [] on any error, missing file, or no projectRoot. TTL-filtering
 * prevents a stale bad-key window from wedging across sessions.
 */
export function readRecentAuthFailures(
  projectRoot: string | undefined,
  ttlMs = 6 * 60 * 60 * 1000,
): AuthFailure[] {
  if (!projectRoot) return [];
  try {
    const path = statePath(projectRoot);
    if (!existsSync(path)) return [];
    const state = readState(path);
    const now = Date.now();
    const out: AuthFailure[] = [];
    for (const [provider, entry] of Object.entries(state)) {
      if (!entry || typeof entry.at !== 'number' || typeof entry.status !== 'number') continue;
      if (now - entry.at <= ttlMs) out.push({ provider, status: entry.status, at: entry.at });
    }
    return out.sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}
