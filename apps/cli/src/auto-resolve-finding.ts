/**
 * Pure helper for auto-resolving implementation findings against recent git log.
 *
 * Extracted for testability + fix for GH #136: previously read `f.file`, which
 * is never written by the producer at handlers/collect.ts:659. The file path is
 * embedded in finding text as `<cite tag="file">path/to/foo.ts[:NN[-MM]]</cite>`.
 */

/**
 * Extract the file path (sans line numbers) from a finding's `<cite tag="file">` tag.
 * Returns '' when no cite tag is present.
 */
export function extractCitedFile(findingText: string | undefined | null): string {
  if (!findingText) return '';
  const m = /<cite\s+tag="file">([^:<]+?)(?::\d+(?:-\d+)?)?<\/cite>/.exec(findingText);
  return m?.[1] ?? '';
}

export interface FindingLike {
  status?: string;
  finding?: string;
  file?: string; // legacy field, usually absent
  resolvedAt?: string;
  [k: string]: unknown;
}

export interface AutoResolveResult {
  changed: boolean;
  finding: FindingLike;
}

/**
 * Decide whether a finding should be auto-resolved given a git log blob.
 *
 * A finding is auto-resolved when ALL of:
 *   - `status === 'open'`
 *   - a file basename is derivable (from `<cite tag="file">` or legacy `f.file`)
 *   - basename length > 2 AND appears in the git log verbatim
 *   - at least one content word (length > 5) from the finding text appears in the git log
 *
 * Returns a copy (never mutates the input) with `status`/`resolvedAt` set when changed.
 */
export function tryAutoResolveFinding(
  f: FindingLike,
  gitLog: string,
  now: () => string = () => new Date().toISOString()
): AutoResolveResult {
  if (!f || f.status !== 'open') return { changed: false, finding: f };

  // Prefer cite-tag extraction (current producer format). Fall back to legacy `f.file`.
  const citedPath = extractCitedFile(f.finding);
  const filePath = citedPath || (typeof f.file === 'string' ? f.file : '');
  const fileBase = filePath.split('/').pop() || '';

  if (!fileBase || fileBase.length <= 2) return { changed: false, finding: f };
  if (!gitLog.includes(fileBase)) return { changed: false, finding: f };

  const findingWords = (f.finding || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w: string) => w.length > 5)
    .slice(0, 3);
  const gitLogLower = gitLog.toLowerCase();
  const contentMatch =
    findingWords.length > 0 && findingWords.some((w: string) => gitLogLower.includes(w));

  if (!contentMatch) return { changed: false, finding: f };

  return {
    changed: true,
    finding: { ...f, status: 'resolved', resolvedAt: now() },
  };
}
