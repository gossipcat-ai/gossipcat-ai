// packages/orchestrator/src/runtime-config.ts
//
// File-backed runtime config store for behavioral feature gates.
// Spec: docs/specs/2026-05-21-runtime-config-store.md
//
// Precedence (getRuntimeFlag):
//   1. process.env[key]  — if set and non-empty
//   2. .gossip/runtime-flags.json — file-backed, AI-mutable layer
//   3. registry default  — hard-coded fallback
//
// Only GOSSIP_* keys are served. getRuntimeFlag('GOSSIPCAT_HTTP_TOKEN') returns
// undefined regardless of env or file content (credential leak prevention,
// consensus 62f5b655:f7).
//
// Reads do not lock. Writes use the advisory-lock infrastructure from
// file-lock.ts and an atomic .tmp + rename + read-back validation pattern.
// Audit log: .gossip/config-changes.jsonl (append-only, appendFileSync).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { RUNTIME_FLAG_REGISTRY, type RuntimeFlagSpec } from './runtime-config-schema';

/**
 * Structural type for a runtime-flag registry. Tests can declare their own
 * registries conforming to this shape and inject via the default-arg seam on
 * every public function.
 *
 * See docs/superpowers/specs/2026-05-21-runtime-config-di-refactor-design.md.
 */
export type RuntimeFlagRegistry = Record<string, RuntimeFlagSpec>;

// ── Constants ──────────────────────────────────────────────────────────────

const FLAGS_FILE = path.join('.gossip', 'runtime-flags.json');
const AUDIT_FILE = path.join('.gossip', 'config-changes.jsonl');
const LOCK_SUFFIX = '.runtime-flags.lock';

// Re-use a session ID across the process lifetime for audit log attribution.
const SESSION_ID = randomUUID();

// ── In-memory cache ────────────────────────────────────────────────────────

// null = not yet loaded; Record<string,string> = cached content.
let _cache: Record<string, string> | null = null;

// Coercion-failure warnings are emitted once per key per session to avoid spam.
const _coercionWarned = new Set<string>();

// ── Internal helpers ───────────────────────────────────────────────────────

/** Absolute path to the flags file, rooted at cwd. */
function flagsFilePath(): string {
  return path.resolve(process.cwd(), FLAGS_FILE);
}

/** Absolute path to the audit log, rooted at cwd. */
function auditFilePath(): string {
  return path.resolve(process.cwd(), AUDIT_FILE);
}

/**
 * Read and parse the flags file. Returns an empty object on missing/corrupt
 * file (corrupt is logged). Does NOT update _cache — callers decide whether
 * to assign the result.
 */
function readFlagsFile(filePath: string): Record<string, string> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Validate: all values must be strings.
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') {
          result[k] = v;
        }
      }
      return result;
    }
    process.stderr.write(`[gossipcat] runtime-flags.json is not a plain object — treating as empty\n`);
    return {};
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return {};
    }
    // Non-ENOENT: permission error, corrupt FS, etc. Fail loud so the caller
    // (boot-time loader) can surface the problem rather than silently losing state.
    throw new Error(`[gossipcat] failed to read runtime-flags.json: ${err?.message}`);
  }
}

/**
 * Ensure the cache is populated. Called by every read path.
 * Thread-safe: JS is single-threaded; await is the only yield point and
 * there are none in this function.
 */
function ensureLoaded(registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY): Record<string, string> {
  if (_cache === null) {
    _cache = readFlagsFile(flagsFilePath());
    // Warn about keys present in file but not in registry (back-compat for
    // removed keys — we log but do not drop them).
    for (const key of Object.keys(_cache)) {
      if (!(key in registry)) {
        process.stderr.write(`[gossipcat] runtime-flags.json: unknown key "${key}" (not in registry; ignored for reads)\n`);
      }
    }
  }
  return _cache;
}

/**
 * The GOSSIP_* prefix filter. Returns true when the key is allowed through
 * the read/write API. Prevents credential-key leakage (see spec §Precedence).
 */
function isGossipKey(key: string): boolean {
  return key.startsWith('GOSSIP_');
}

/** Retrieve the registry spec for a key, or undefined if not registered. */
function getSpec(
  key: string,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): RuntimeFlagSpec | undefined {
  return registry[key];
}

// ── Public read API ────────────────────────────────────────────────────────

/**
 * Get the effective string value for a flag key.
 *
 * Precedence: env (non-empty) > file > defaultValue > registry default.
 * Returns undefined for non-GOSSIP_* keys (prefix filter).
 */
export function getRuntimeFlag(
  key: string,
  defaultValue?: string,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): string | undefined {
  if (!isGossipKey(key)) return undefined;

  // 1. env — only if set AND non-empty.
  const envVal = process.env[key];
  if (envVal !== undefined && envVal !== '') {
    return envVal;
  }

  // 2. file-backed cache.
  const cache = ensureLoaded(registry);
  if (Object.prototype.hasOwnProperty.call(cache, key)) {
    return cache[key];
  }

  // 3. explicit defaultValue (caller override).
  if (defaultValue !== undefined) {
    return defaultValue;
  }

  // 4. registry default.
  const spec = getSpec(key, registry);
  return spec?.default;
}

/**
 * Get the effective boolean value for a flag key.
 * Truthy: '1' | 'true' (case-insensitive). Any other string, including '',
 * returns false.
 *
 * Empty-string env edge case: env='' is treated as an EXPLICIT disable for
 * boolean flags. `export X=` in shell means "force off". So even if the file
 * has '1', an empty-string env returns false. This is the regression guard
 * for the migration footgun (spec §Empty-string env semantics).
 *
 * Contrast with getRuntimeFlag: that function treats '' as unset and falls
 * through to file value. The bool helper has the explicit-disable semantics.
 */
export function getRuntimeFlagBool(
  key: string,
  defaultValue?: boolean,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): boolean {
  if (!isGossipKey(key)) return defaultValue ?? false;

  // Explicit empty-string env → false regardless of file.
  const envVal = process.env[key];
  if (envVal === '') return false;

  const raw = getRuntimeFlag(key, undefined, registry);
  if (raw === undefined) {
    return defaultValue ?? false;
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Get the effective integer value for a flag key.
 * Falls back to defaultValue (or registry default) on parse failure or
 * bounds violation. Logs a one-time warning per key per session on coercion
 * failure.
 */
export function getRuntimeFlagInt(
  key: string,
  defaultValue?: number,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): number {
  const spec = getSpec(key, registry);
  const fallback = defaultValue ?? (spec?.default !== undefined ? parseInt(spec.default, 10) : 0);

  const raw = getRuntimeFlag(key, undefined, registry);
  if (raw === undefined) return fallback;

  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    if (!_coercionWarned.has(key)) {
      _coercionWarned.add(key);
      process.stderr.write(`[gossipcat] getRuntimeFlagInt("${key}"): "${raw}" is not a valid integer; using fallback ${fallback}\n`);
    }
    return fallback;
  }

  if (spec?.type === 'integer') {
    if (parsed < spec.min) {
      if (!_coercionWarned.has(key)) {
        _coercionWarned.add(key);
        process.stderr.write(`[gossipcat] getRuntimeFlagInt("${key}"): ${parsed} < min ${spec.min}; using fallback ${fallback}\n`);
      }
      return fallback;
    }

    if (parsed > spec.max) {
      if (!_coercionWarned.has(key)) {
        _coercionWarned.add(key);
        process.stderr.write(`[gossipcat] getRuntimeFlagInt("${key}"): ${parsed} > max ${spec.max}; using fallback ${fallback}\n`);
      }
      return fallback;
    }
  }

  return parsed;
}

// ── Audit log ──────────────────────────────────────────────────────────────

interface AuditEntry {
  ts: string;
  action: 'set' | 'unset';
  key: string;
  oldValue: string | null;
  newValue: string | null;
  source: 'user' | 'agent';
  reason: string;
  sessionId: string;
}

function appendAudit(entry: AuditEntry): void {
  const auditPath = auditFilePath();
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err: any) {
    process.stderr.write(`[gossipcat] audit log write failed: ${err?.message}\n`);
  }
}

// ── Write-time validation ──────────────────────────────────────────────────

/**
 * Validate that `value` is compatible with the registered type for `key`.
 * Returns null on success, or an error string on failure.
 */
function validateValue(
  key: string,
  value: string,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): string | null {
  const spec = getSpec(key, registry);
  if (!spec) return `key "${key}" is not in the runtime flag registry`;

  if (spec.type === 'boolean') {
    if (value !== '0' && value !== '1' && value.toLowerCase() !== 'true' && value.toLowerCase() !== 'false') {
      return `key "${key}" is boolean — expected '0', '1', 'true', or 'false'; got "${value}"`;
    }
  } else if (spec.type === 'integer') {
    const n = parseInt(value, 10);
    if (isNaN(n)) return `key "${key}" is integer — "${value}" is not parseable`;
    if (n < spec.min) return `key "${key}": ${n} < min ${spec.min}`;
    if (n > spec.max) return `key "${key}": ${n} > max ${spec.max}`;
  }
  // 'string' type: any non-empty string is valid.
  if (spec.type === 'string' && value === '') {
    return `key "${key}" is string type — empty string is not allowed`;
  }

  return null;
}

// ── Public write API ───────────────────────────────────────────────────────

/**
 * Set a runtime flag. Validates key (must be in registry) and value (type +
 * range per registry). Writes atomically under advisory lock. Appends audit log.
 * Throws on validation failure or if lock cannot be acquired.
 */
export async function setRuntimeFlag(
  key: string,
  value: string,
  source: 'user' | 'agent',
  reason: string,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): Promise<void> {
  if (!isGossipKey(key)) {
    throw new Error(`setRuntimeFlag: key "${key}" does not start with GOSSIP_ and cannot be stored`);
  }
  const validationError = validateValue(key, value, registry);
  if (validationError) {
    throw new Error(`setRuntimeFlag: ${validationError}`);
  }

  const filePath = flagsFilePath();
  const projectRoot = path.resolve(process.cwd(), '.gossip', '..');

  const result = await _withRuntimeLock(projectRoot, async () => {
    // Read current state under lock.
    const current = readFlagsFile(filePath);
    const oldValue = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : null;

    // Mutate.
    current[key] = value;

    // Atomic write: .tmp + rename + read-back validation.
    const tmpPath = filePath + '.tmp';
    const serialized = JSON.stringify(current, null, 2);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, serialized, 'utf8');

    // Read-back validation.
    try {
      const readBack = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      if (typeof readBack !== 'object' || readBack === null || readBack[key] !== value) {
        fs.unlinkSync(tmpPath);
        throw new Error('read-back validation failed after atomic write');
      }
    } catch (parseErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw parseErr;
    }

    // Rename (atomic on POSIX). Guard against partial failures (e.g. cross-device
    // rename on some edge-case FS) by cleaning up tmp on error.
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw renameErr;
    }

    // Invalidate cache.
    _cache = current;

    // Audit log.
    appendAudit({
      ts: new Date().toISOString(),
      action: 'set',
      key,
      oldValue,
      newValue: value,
      source,
      reason,
      sessionId: SESSION_ID,
    });
  });

  if (result === null) {
    throw new Error(`setRuntimeFlag: could not acquire advisory lock for "${key}" — try again`);
  }
}

/**
 * Remove a key from the flags file. No-op if the key is not present in the
 * file (env-set values are untouched). Appends audit log on actual removal.
 */
export async function unsetRuntimeFlag(
  key: string,
  source: 'user' | 'agent',
  reason: string,
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): Promise<void> {
  if (!isGossipKey(key)) {
    throw new Error(`unsetRuntimeFlag: key "${key}" does not start with GOSSIP_`);
  }
  if (!getSpec(key, registry)) {
    throw new Error(`unsetRuntimeFlag: key "${key}" is not in the runtime flag registry`);
  }

  const filePath = flagsFilePath();
  const projectRoot = path.resolve(process.cwd(), '.gossip', '..');

  const result = await _withRuntimeLock(projectRoot, async () => {
    const current = readFlagsFile(filePath);
    const oldValue = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : null;

    if (oldValue === null) {
      // Key not in file — no-op (still update cache to match).
      _cache = current;
      return;
    }

    delete current[key];

    const tmpPath = filePath + '.tmp';
    const serialized = JSON.stringify(current, null, 2);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpPath, serialized, 'utf8');

    // Read-back validation.
    try {
      const readBack = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
      if (typeof readBack !== 'object' || readBack === null) {
        fs.unlinkSync(tmpPath);
        throw new Error('read-back validation failed after atomic write');
      }
      if (Object.prototype.hasOwnProperty.call(readBack, key)) {
        fs.unlinkSync(tmpPath);
        throw new Error(`read-back shows key "${key}" still present after delete`);
      }
    } catch (parseErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw parseErr;
    }

    // Rename (atomic on POSIX). Clean up tmp on any failure.
    try {
      fs.renameSync(tmpPath, filePath);
    } catch (renameErr) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw renameErr;
    }
    _cache = current;

    appendAudit({
      ts: new Date().toISOString(),
      action: 'unset',
      key,
      oldValue,
      newValue: null,
      source,
      reason,
      sessionId: SESSION_ID,
    });
  });

  if (result === null) {
    throw new Error(`unsetRuntimeFlag: could not acquire advisory lock for "${key}" — try again`);
  }
}

// ── List and reload ────────────────────────────────────────────────────────

export interface RuntimeFlagEntry {
  key: string;
  value: string;
  from: 'env' | 'file' | 'default';
  default: string;
  description: string;
}

/**
 * List all registry keys with their current effective value and source.
 */
export function listRuntimeFlags(
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): RuntimeFlagEntry[] {
  const cache = ensureLoaded(registry);
  return Object.entries(registry).map(([key, spec]) => {
    const envVal = process.env[key];
    const fileVal = Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : undefined;

    let value: string;
    let from: 'env' | 'file' | 'default';

    if (envVal !== undefined && envVal !== '') {
      value = envVal;
      from = 'env';
    } else if (fileVal !== undefined) {
      value = fileVal;
      from = 'file';
    } else {
      value = spec.default;
      from = 'default';
    }

    return {
      key,
      value,
      from,
      default: spec.default,
      description: spec.description,
    };
  });
}

/**
 * Discard in-memory cache and re-read the file. Call this after hand-editing
 * .gossip/runtime-flags.json outside the tool, or when testing.
 */
export function reloadRuntimeFlags(
  registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY,
): void {
  _cache = null;
  ensureLoaded(registry);
}

// ── Advisory lock (runtime-flags variant) ─────────────────────────────────
//
// withResolverLock hardcodes '.resolver.lock'. We need '.runtime-flags.lock'.
// This is a local reimplementation of the same semantics (O_CREAT|O_EXCL spin-
// lock with stale detection) using a different lock filename. The constants and
// logic mirror file-lock.ts exactly to keep the two implementations auditable
// against each other.

const RT_LOCK_WAIT_MS = 5_000;
const RT_LOCK_POLL_MS = 100;
const RT_STALE_LOCK_MS = 10 * 60_000;

async function _withRuntimeLock<T>(
  projectRoot: string,
  fn: () => Promise<T> | T,
): Promise<T | null> {
  const lockFile = path.join(projectRoot, '.gossip', LOCK_SUFFIX);
  try { fs.mkdirSync(path.dirname(lockFile), { recursive: true }); } catch { /* best-effort */ }

  const deadline = Date.now() + RT_LOCK_WAIT_MS;
  let fd: number | null = null;

  while (true) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      const meta = { pid: process.pid, started_at: new Date().toISOString() };
      fs.writeSync(fd, JSON.stringify(meta));
      break;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    // Check for stale lock.
    try {
      const raw = fs.readFileSync(lockFile, 'utf8');
      const meta = JSON.parse(raw) as { pid?: number; started_at?: string };
      const startedMs = meta.started_at ? new Date(meta.started_at).getTime() : NaN;
      const ageMs = Number.isFinite(startedMs) ? Date.now() - startedMs : Infinity;
      if (ageMs > RT_STALE_LOCK_MS || !meta) {
        try {
          fs.unlinkSync(lockFile);
          process.stderr.write(`[gossipcat] runtime-flags lock was stale (pid=${meta?.pid ?? '?'}); breaking\n`);
        } catch { /* race */ }
        continue;
      }
    } catch { /* lock file disappeared between the two reads */ }

    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, RT_LOCK_POLL_MS));
  }

  try {
    return await fn();
  } finally {
    try { fs.closeSync(fd!); } catch { /* ignore */ }
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}
