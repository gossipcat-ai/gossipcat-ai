/**
 * verify-ledger-background — next-session ledger auto-verify guardrail (Option B).
 *
 * Spec: docs/specs/2026-05-14-next-session-ledger-autoverify.md
 *
 * Responsibilities:
 *   1. parseNextSessionBullets(content)   — extract bullets from a `## Open ...` section.
 *      Classifies each as memory-backed (with [link](path)), free-form prose, or numeric.
 *   2. readLedgerIndex(...)               — load `.gossip/next-session-index.json` and validate
 *      its `ledgerMtime` AND `ledgerContentHash` against the live ledger. Both must match,
 *      otherwise the cache is stale and the caller should trigger refresh.
 *   3. writeLedgerIndex(...)              — best-effort, non-atomic write of the sidecar.
 *   4. runLedgerVerification(...)         — bounded-concurrency (default 3) walk over bullets,
 *      delegating each verification to an injected verifier callback. Tests pass a mock.
 *
 * Background verification (haiku dispatch + git subprocess) never blocks the bootstrap
 * critical path. Bootstrap calls `triggerBackgroundVerification()` which uses `setImmediate`
 * + a fire-and-forget Promise. Synchronous fs reads required for cache validation
 * (`statSync`, `existsSync`, `readFileSync`, `JSON.parse`) DO run on the hot path —
 * bounded by file size, unavoidable for the mtime+hash check.
 *
 * Bootstrap directly reads the sidecar via readLedgerIndex; on a hit it splices verdicts
 * into the ledger text. On a miss/stale, every bullet gets `[UNVERIFIED]` and the background
 * job is scheduled. The dispatcher itself does NOT modify next-session.md — the sidecar is
 * the only side-effect.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import {
  resolveProseBullet,
  type ProseResolverIndex,
} from './prose-bullet-resolver';

export type LedgerVerdict =
  | 'FRESH'
  | 'STALE'
  | 'CONTRADICTED'
  | 'INCONCLUSIVE'
  | 'PROSE-ONLY'
  | 'UNVERIFIABLE';

export interface ParsedBullet {
  /** The bullet text without the leading "- " marker, trimmed. */
  text: string;
  /** Index of the bullet within the parsed section (stable across runs given identical input). */
  index: number;
  /** Stable hash of `text` — primary key in the sidecar. */
  hash: string;
  /** Memory file path if a `[label](path.md)` link was detected; else undefined. */
  backingFile?: string;
  /** True if the bullet has no memory link AND no obvious numeric claim (pure prose). */
  proseOnly: boolean;
  /** Numeric-claim hint: extracted number + noun the bullet is about (e.g., 4 + "worktree"). */
  numericClaim?: { n: number; noun: string };
  /** Multi-candidate memory files when the prose-resolver returned `ambiguous`. Surfaced in PROSE-ONLY details so the orchestrator can pick. */
  ambiguousCandidates?: readonly string[];
}

export interface LedgerIndexEntry {
  bulletHash: string;
  verdict: LedgerVerdict;
  details: string;
  checkedAt: string;
}

export interface LedgerIndex {
  ledgerMtime: number;
  ledgerContentHash: string;
  entries: LedgerIndexEntry[];
}

export const LEDGER_INDEX_FILENAME = 'next-session-index.json';

/**
 * SHA-256 truncated to 64 bits (16 hex chars). Sufficient for cache invalidation and
 * accidental drift detection; NOT for adversarial integrity (birthday-attack collision
 * space is ~4B). Cheap, deterministic, no deps.
 */
export function hashContent(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/**
 * Find the line number (0-based) in `content` where the "## Open ..." section starts.
 * Returns -1 when no such heading is found (fall-back: scan the whole document).
 *
 * Shared by `parseNextSessionBullets` and `annotateLedgerText` so both operate on the
 * same section boundary, preventing bullet-cursor misalignment when there are bullets
 * above the Open heading (e.g. in a "## Shipped this session" block).
 */
export function findOpenSectionLine(content: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s{0,3}#{1,4}\s+Open[^\n]*$/.test(lines[i])) return i;
  }
  return -1;
}

/**
 * Extract bullets from a "## Open for next session" (or close cousin) block.
 *
 * Recognized bullet shapes:
 *   - `- [label](path/to/memory.md) — description`              → memory-backed
 *   - `- Continue work on something`                            → free-form prose
 *   - `- Clean up "4 merged-but-locked worktree branches"`      → numeric (worktree)
 *
 * Lines that are not bullets (headings, blank lines) are skipped. Indented
 * continuation lines are folded into the parent bullet.
 */
export interface ParseNextSessionOptions {
  /**
   * Optional prose-bullet resolver context. When provided, bullets that have
   * no explicit `[label](path.md)` link AND no numeric claim are run through
   * `resolveProseBullet`; a single confident match populates `backingFile`
   * and clears `proseOnly`. Ambiguous / none results leave `proseOnly` true.
   *
   * Callers that want the cheap parse (no fs access) simply omit this arg.
   */
  proseResolver?: {
    index: ProseResolverIndex;
    agentIds: readonly string[];
  };
}

export function parseNextSessionBullets(
  content: string,
  opts: ParseNextSessionOptions = {},
): ParsedBullet[] {
  if (!content) return [];

  // Try to locate the "Open for next session" block; fall back to scanning the
  // whole document if no header is found (some ledgers are bullet-only).
  const openIdx = content.search(/^\s{0,3}#{1,4}\s+Open[^\n]*$/im);
  const body = openIdx === -1 ? content : content.slice(openIdx);
  const lines = body.split('\n');

  const bullets: ParsedBullet[] = [];
  let current: string | null = null;
  const flush = () => {
    if (current == null) return;
    const text = current.trim();
    if (text.length === 0) { current = null; return; }
    const index = bullets.length;
    const hash = hashContent(text);

    // Memory link detection: prefer `[label](path)` with .md extension or path-like.
    let backingFile: string | undefined;
    const linkMatch = text.match(/\[[^\]]+\]\(([^)\s]+\.md)\)/);
    if (linkMatch) backingFile = linkMatch[1];

    // Numeric claim detection — keep tight; only patterns we know how to verify live.
    let numericClaim: ParsedBullet['numericClaim'] | undefined;
    const worktreeMatch = text.match(/\b(\d+)\s+(?:merged-but-locked\s+)?worktrees?(?:\s+branch(?:es)?)?\b/i);
    if (worktreeMatch) numericClaim = { n: parseInt(worktreeMatch[1], 10), noun: 'worktree' };

    let proseOnly = !backingFile && !numericClaim;

    // POST-PASS: prose-only bullets get a fuzzy memory-slug match attempt.
    // Single confident match → populate backingFile, clear proseOnly.
    // Ambiguous / none → leave proseOnly true (orchestrator surfaces candidates).
    let ambiguousCandidates: readonly string[] | undefined;
    if (proseOnly && opts.proseResolver) {
      const res = resolveProseBullet(text, opts.proseResolver.index, opts.proseResolver.agentIds);
      if (res.kind === 'matched') {
        backingFile = res.backingFile;
        proseOnly = false;
      } else if (res.kind === 'ambiguous') {
        ambiguousCandidates = res.candidates.map((c) => c.file);
      }
    }

    bullets.push({ text, index, hash, backingFile, proseOnly, numericClaim, ambiguousCandidates });
    current = null;
  };

  for (const raw of lines) {
    const bulletStart = /^\s{0,3}[-*]\s+(.*)$/.exec(raw);
    if (bulletStart) {
      flush();
      current = bulletStart[1];
      continue;
    }
    // Heading terminates the block once we've consumed at least one bullet.
    if (/^\s{0,3}#{1,6}\s/.test(raw) && bullets.length > 0) { flush(); break; }
    // Continuation: indented line under current bullet.
    if (current != null && /^\s{2,}\S/.test(raw)) {
      current += ' ' + raw.trim();
      continue;
    }
    // Blank line ends a bullet.
    if (/^\s*$/.test(raw)) { flush(); continue; }
  }
  flush();
  return bullets;
}

/** Resolve the sidecar path. Exposed for tests. */
export function ledgerIndexPath(projectRoot: string): string {
  return join(projectRoot, '.gossip', LEDGER_INDEX_FILENAME);
}

function isLedgerIndex(x: unknown): x is LedgerIndex {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.ledgerMtime === 'number'
    && typeof o.ledgerContentHash === 'string'
    && Array.isArray(o.entries)
    && o.entries.every((e: unknown) =>
      e !== null && typeof e === 'object'
      && typeof (e as Record<string, unknown>).bulletHash === 'string'
      && typeof (e as Record<string, unknown>).verdict === 'string'
      && typeof (e as Record<string, unknown>).details === 'string'
      && typeof (e as Record<string, unknown>).checkedAt === 'string');
}

/**
 * Load the sidecar AND validate it against the live ledger. Returns null on:
 *   - missing sidecar
 *   - parse error
 *   - mtime mismatch
 *   - content-hash mismatch
 * The caller should treat null as a cold cache (annotate UNVERIFIED + trigger refresh).
 */
export function readLedgerIndex(
  projectRoot: string,
  liveLedgerContent: string,
  liveLedgerMtime: number,
): LedgerIndex | null {
  const path = ledgerIndexPath(projectRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
  if (!isLedgerIndex(parsed)) return null;
  // BOTH checks required per user decision #2.
  if (parsed.ledgerMtime !== liveLedgerMtime) return null;
  if (parsed.ledgerContentHash !== hashContent(liveLedgerContent)) return null;
  return parsed;
}

/** Write the sidecar. Creates `.gossip/` if missing. Best-effort; swallows write errors. */
export function writeLedgerIndex(projectRoot: string, index: LedgerIndex): void {
  const path = ledgerIndexPath(projectRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(index, null, 2));
  } catch {
    // Best-effort — cache failure must never break bootstrap or session_save.
  }
}

/** A verifier returns an entry for a single bullet. Pluggable so tests can mock. */
export type BulletVerifier = (b: ParsedBullet) => Promise<LedgerIndexEntry>;

/**
 * Bounded-concurrency dispatcher. Walks bullets, runs verifier with at most
 * `concurrency` in-flight calls, returns entries in original bullet order.
 *
 * Simple in-file semaphore — no external deps (user decision #6).
 */
export async function runLedgerVerification(
  bullets: ParsedBullet[],
  verifier: BulletVerifier,
  concurrency = 3,
): Promise<LedgerIndexEntry[]> {
  const cap = Math.max(1, concurrency | 0);
  const results: LedgerIndexEntry[] = new Array(bullets.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < cap; w++) {
    workers.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= bullets.length) return;
        try {
          results[i] = await verifier(bullets[i]);
        } catch (err) {
          results[i] = {
            bulletHash: bullets[i].hash,
            verdict: 'INCONCLUSIVE',
            details: `verifier threw: ${(err as Error).message || String(err)}`.slice(0, 500),
            checkedAt: new Date().toISOString(),
          };
        }
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Default verifier — does NOT call out to gossip_verify_memory directly because
 * that tool is a two-phase orchestrator-side dispatch (the orchestrator must
 * launch Agent()). In-process we can only honor the deterministic verdicts:
 *   - PROSE-ONLY  → bullets without a memory link and without a numeric claim
 *   - UNVERIFIABLE → numeric-claim bullets when no live counter is available
 *   - INCONCLUSIVE → memory-linked bullets (orchestrator must run gossip_verify_memory
 *                     explicitly; the cache surfaces this fact transparently)
 *
 * For numeric claims with a known live reader (currently: worktree count), the
 * verifier returns FRESH/STALE based on actual count vs claimed N.
 *
 * Tests inject their own verifier to exercise full code paths.
 */
export function defaultVerifierFactory(
  liveCounters: { worktree?: () => number | null } = {},
): BulletVerifier {
  return async (b) => {
    const now = new Date().toISOString();
    if (b.numericClaim && b.numericClaim.noun === 'worktree' && liveCounters.worktree) {
      const live = liveCounters.worktree();
      if (live != null) {
        const verdict: LedgerVerdict = live === b.numericClaim.n ? 'FRESH' : 'STALE';
        return {
          bulletHash: b.hash,
          verdict,
          details: `live worktree count: ${live} (claim: ${b.numericClaim.n})`,
          checkedAt: now,
        };
      }
    }
    if (b.numericClaim) {
      return { bulletHash: b.hash, verdict: 'UNVERIFIABLE', details: 'no live counter for numeric claim', checkedAt: now };
    }
    if (b.proseOnly) {
      const details = b.ambiguousCandidates && b.ambiguousCandidates.length > 0
        ? `multiple confident matches: ${b.ambiguousCandidates.join(', ')}`
        : 'free-form bullet, no backing memory link';
      return { bulletHash: b.hash, verdict: 'PROSE-ONLY', details, checkedAt: now };
    }
    // Memory-linked bullet: in-process we cannot dispatch the haiku verifier;
    // mark INCONCLUSIVE so the orchestrator knows to call gossip_verify_memory.
    return {
      bulletHash: b.hash,
      verdict: 'INCONCLUSIVE',
      details: `memory-backed; orchestrator should run gossip_verify_memory(${basename(b.backingFile ?? '')})`,
      checkedAt: now,
    };
  };
}

/**
 * Fire-and-forget background trigger used by bootstrap.ts. Returns immediately;
 * verification runs on `setImmediate` so the bootstrap call site is never blocked.
 */
export function triggerBackgroundVerification(
  projectRoot: string,
  liveLedgerContent: string,
  liveLedgerMtime: number,
  bullets: ParsedBullet[],
  verifier: BulletVerifier,
): void {
  setImmediate(() => {
    runLedgerVerification(bullets, verifier, 3)
      .then((entries) => {
        writeLedgerIndex(projectRoot, {
          ledgerMtime: liveLedgerMtime,
          ledgerContentHash: hashContent(liveLedgerContent),
          entries,
        });
      })
      .catch(() => { /* swallow; sidecar stays cold */ });
  });
}

/** Render an annotation prefix from a verdict. Pure — used by bootstrap. */
export function annotationPrefix(verdict: LedgerVerdict, details?: string): string {
  switch (verdict) {
    case 'FRESH': return '';
    case 'STALE': return details ? `[STALE — ${details}] ` : '[STALE] ';
    case 'CONTRADICTED': return details ? `[CONTRADICTED — ${details}] ` : '[CONTRADICTED] ';
    case 'INCONCLUSIVE': return '[UNVERIFIED] ';
    case 'PROSE-ONLY': return '[PROSE-ONLY] ';
    case 'UNVERIFIABLE': return '[UNVERIFIABLE] ';
  }
}

/**
 * Inject annotations into the raw ledger text. Walks bullets in the SAME order
 * as parseNextSessionBullets() produces them, so verdict-by-hash lookups stay
 * in sync. Bullets without a matching entry get `[UNVERIFIED]`.
 *
 * Uses `findOpenSectionLine` to skip any bullets that appear BEFORE the
 * `## Open ...` heading (e.g. in a "## Shipped this session" block), preventing
 * bullet-cursor misalignment when the ledger has multi-section structure.
 *
 * Per user decision #1: STALE bullets are annotated inline, NEVER stripped.
 */
export function annotateLedgerText(
  raw: string,
  bullets: ParsedBullet[],
  entriesByHash: Map<string, LedgerIndexEntry>,
): string {
  if (bullets.length === 0) return raw;
  const lines = raw.split('\n');
  // Start the cursor only from the Open-section line so bullets before that
  // heading (e.g. "## Shipped") do not consume slots and misalign annotations.
  const openLineStart = findOpenSectionLine(raw);
  const startLine = openLineStart === -1 ? 0 : openLineStart;
  let bulletCursor = 0;
  for (let i = startLine; i < lines.length; i++) {
    if (bulletCursor >= bullets.length) break;
    const m = /^(\s{0,3}[-*]\s+)(.*)$/.exec(lines[i]);
    if (!m) continue;
    const b = bullets[bulletCursor++];
    // Only annotate if the rendered bullet text starts with the parsed text —
    // continuation lines were folded in parse but raw text keeps original layout.
    const restOfBullet = m[2];
    const entry = entriesByHash.get(b.hash);
    const verdict: LedgerVerdict = entry?.verdict ?? 'INCONCLUSIVE';
    const prefix = annotationPrefix(verdict, entry?.details);
    if (!prefix) continue; // FRESH → leave untouched
    lines[i] = `${m[1]}${prefix}${restOfBullet}`;
  }
  return lines.join('\n');
}

/** Convenience: read live ledger mtime; returns 0 on stat failure. */
export function ledgerMtime(ledgerPath: string): number {
  try { return statSync(ledgerPath).mtimeMs; } catch { return 0; }
}
