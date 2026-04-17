/**
 * Cross-round finding dedupe key — content-anchored.
 *
 * Consensus round IDs are fresh per round, so `finding_id` (shape
 * `<consensusId>:<agentId>:fN`) varies even when two rounds rediscover
 * the same bug. Exact finding_id dedup at signal-record time can't catch
 * cross-round duplicates. This helper computes a stable hash over
 * (agentId, normalized file path, normalized first 32 chars of content,
 * category) that absorbs line-drift and whitespace noise while still
 * distinguishing distinct bugs.
 *
 * Design reference: docs/specs/2026-04-17-cross-round-dedupe-key.md.
 *
 * Returns `null` when the finding has no file citation (dedup disabled
 * for that signal) or when the normalized content is shorter than 32
 * chars (safer than colliding short strings into the same key).
 */

import { createHash } from 'crypto';

// Kept in sync with ANCHOR_PATTERN in parse-findings.ts:31. Duplicated here
// rather than re-exported so this module can be consumed without pulling in
// the parse-findings surface when it lands on the CLI side.
const ANCHOR_PATTERN = /[\w./-]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|md|json|yaml|yml|toml|sh):\d+/;

const MIN_NORMALIZED_CONTENT_LENGTH = 32;

export interface DedupeKeyInput {
  /** Finding author. Required — no cross-agent dedup. */
  agentId: string;
  /**
   * Finding body — the text inside `<agent_finding>...</agent_finding>`
   * or a serialized evidence field. The first file citation (via
   * ANCHOR_PATTERN) anchors the location; the first 32 chars anchor
   * identity. Empty / undefined → null key.
   */
  content?: string;
  /**
   * Optional second text source (e.g. separate `evidence` column when
   * the caller splits finding body from evidence). Scanned for a
   * citation when `content` has none, and concatenated into the
   * normalized first-32-chars window when needed. Keeps behavior sane
   * for legacy signals that only populate `evidence`.
   */
  evidence?: string;
  /**
   * Skill-gap category (`concurrency`, `input_validation`, etc.). Empty
   * string when absent — legacy signals missing category hash into a
   * single bucket rather than being excluded from dedup entirely.
   */
  category?: string;
}

/**
 * Normalize a file path for use inside the hash input. We lowercase, trim,
 * and keep the forward-slash form. Absolute paths (`/abs/pkg/foo.ts`) are
 * stripped to the tail starting at the first recognizable package segment —
 * best-effort: agents cite files in many shapes (repo-relative, worktree-
 * absolute, CI-absolute). For the common case where one review cites
 * `pkg/foo.ts:12` and another cites `/repo/pkg/foo.ts:18`, we want the
 * normalized forms to converge.
 */
function normalizeFilePath(citation: string): string {
  // citation arrives as `path:line`. Drop the line suffix; dedup key spans
  // line drift.
  const pathOnly = citation.replace(/:\d+$/, '');
  const lowered = pathOnly.toLowerCase().trim();

  // If the path starts with '/' treat it as absolute and strip to the first
  // occurrence of a common repo marker ('packages/', 'apps/', 'src/',
  // 'tests/'). If none match, keep the last two segments.
  if (lowered.startsWith('/')) {
    const markers = ['packages/', 'apps/', 'src/', 'tests/', 'docs/'];
    for (const m of markers) {
      const idx = lowered.indexOf(m);
      if (idx >= 0) return lowered.slice(idx);
    }
    const parts = lowered.split('/').filter(Boolean);
    if (parts.length >= 2) return parts.slice(-2).join('/');
    return lowered;
  }
  return lowered;
}

function normalizeContent(content: string): string {
  return content.toLowerCase().replace(/\s+/g, ' ').trim();
}

function firstCitation(text: string): string | null {
  const m = text.match(ANCHOR_PATTERN);
  return m ? m[0] : null;
}

/**
 * Compute the dedupe key for an incoming signal. Returns null when dedup
 * should be disabled (no citation, or normalized content too short).
 *
 * SHA-256 over: `${agentId}\x00${normalizedFilePath}\x00${first32NormalizedContent}\x00${category ?? ''}`.
 * NULs are safe inside hash input — sha256 is length-prefixed internally;
 * the separator only needs to avoid overlap between adjacent fields.
 */
export function computeDedupeKey(signal: DedupeKeyInput): string | null {
  const agentId = (signal.agentId ?? '').trim();
  if (!agentId) return null;

  const contentSources = [signal.content ?? '', signal.evidence ?? ''].filter(
    s => s.length > 0,
  );
  if (contentSources.length === 0) return null;

  // Prefer the primary content for citation extraction; fall back to evidence.
  let citation: string | null = null;
  for (const s of contentSources) {
    citation = firstCitation(s);
    if (citation) break;
  }
  if (!citation) return null;

  const normalizedPath = normalizeFilePath(citation);

  // Concatenate sources with a space so the first-32 window can bridge short
  // content into evidence. Both are normalized together.
  const normalized = normalizeContent(contentSources.join(' '));
  if (normalized.length < MIN_NORMALIZED_CONTENT_LENGTH) return null;

  const head = normalized.slice(0, MIN_NORMALIZED_CONTENT_LENGTH);
  const category = (signal.category ?? '').toLowerCase();

  const hash = createHash('sha256');
  hash.update(agentId);
  hash.update('\x00');
  hash.update(normalizedPath);
  hash.update('\x00');
  hash.update(head);
  hash.update('\x00');
  hash.update(category);
  return hash.digest('hex');
}

export const DEDUPE_KEY_INTERNALS = {
  MIN_NORMALIZED_CONTENT_LENGTH,
  ANCHOR_PATTERN,
  normalizeFilePath,
  normalizeContent,
} as const;
