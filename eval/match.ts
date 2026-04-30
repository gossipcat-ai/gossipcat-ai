/**
 * eval/match.ts — finding↔ground-truth matcher.
 *
 * Implements the rubric in docs/specs/2026-04-29-curated-eval-suite.md §
 * "Scoring rubric":
 *
 *   match(finding, gt):
 *     if finding.file != gt.file: return 0
 *     if finding.line outside gt.line_range ± 5: return 0.5  // near miss
 *     if token_similarity(finding.summary, gt.summary) > 0.6: return 1
 *     if same category: return 0.7
 *     return 0.3
 *
 * `tokenSimilarity` is Jaccard on lowercased word-tokens after stopword strip.
 * Fancier NLP is explicitly out of scope at N=30.
 */

export interface FindingShape {
  /** Path the finding cites. May be undefined if the agent emitted no anchor. */
  file?: string;
  /** Single line or range start. */
  line?: number;
  /** Free-text description of the finding. */
  summary: string;
  /** Severity bucket if the agent provided one. */
  severity?: string;
  /** Category bucket (concurrency, type_safety, etc) if the agent provided one. */
  category?: string;
}

export interface GroundTruthShape {
  id: string;
  file: string;
  line_range: [number, number];
  summary: string;
  severity: string;
  category: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with', 'when', 'where', 'which', 'who', 'why', 'how',
]);

/** Jaccard similarity over lowercased word-tokens after stopword strip. */
export function tokenSimilarity(a: string, b: string): number {
  const tok = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const raw of s.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (raw.length === 0) continue;
      if (STOPWORDS.has(raw)) continue;
      out.add(raw);
    }
    return out;
  };
  const sa = tok(a);
  const sb = tok(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Normalize a path for cross-OS comparison (forward slashes, no leading ./). */
function normPath(p: string | undefined): string {
  if (!p) return '';
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * Returns a match score in [0, 1] per the rubric.
 *
 * Edge cases:
 * - Missing finding.file → 0 (no anchor, can't match by file).
 * - Missing finding.line → treat as out-of-range → 0.5 fallback (near-miss tier).
 * - Empty summary → tokenSimilarity returns 0, falls through to category check.
 */
export function match(finding: FindingShape, gt: GroundTruthShape): number {
  const ff = normPath(finding.file);
  const gf = normPath(gt.file);
  if (!ff || ff !== gf) return 0;

  const [lo, hi] = gt.line_range;
  const fLine = finding.line;
  const inRange = typeof fLine === 'number' && fLine >= lo - 5 && fLine <= hi + 5;
  if (!inRange) return 0.5;

  if (tokenSimilarity(finding.summary, gt.summary) > 0.6) return 1;
  if (finding.category && gt.category && finding.category === gt.category) return 0.7;
  return 0.3;
}

/**
 * Best-match score for a finding against a list of ground truths.
 * Returns the highest match() result (and the matched gt id, if any).
 */
export function bestMatch(
  finding: FindingShape,
  truths: GroundTruthShape[],
): { score: number; gtId: string | null } {
  let best = 0;
  let bestId: string | null = null;
  for (const gt of truths) {
    const s = match(finding, gt);
    if (s > best) {
      best = s;
      bestId = gt.id;
    }
  }
  return { score: best, gtId: bestId };
}
