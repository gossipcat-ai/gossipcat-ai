/**
 * Deterministic carry-forward merge for `.gossip/next-session.md` (issue #684).
 *
 * The session summarizer is instructed to emit ONLY items from the current
 * session under `## Open for next session`. Writing that section wholesale
 * therefore erases every backlog bullet a prior session left behind. This
 * module merges the previous ledger into the newly generated one at write
 * time — no LLM call, no filesystem access, so it is cheap and unit-testable.
 *
 * Contract:
 *   - New bullets keep their position and order; carried bullets are appended.
 *   - A carried bullet is dropped only on mechanical evidence: it duplicates a
 *     new bullet, or every issue/PR ref it names appears in the git log.
 *   - Everything else is carried forward unconditionally.
 */

/** Max total bullets retained in the ledger (new + carried). */
export const NEXT_SESSION_MAX_BULLETS = 30;

const OPEN_HEADING = /^##\s+Open\b/i;
const OPEN_FINDINGS_HEADING = /^##\s+Open\s+Findings\b/i;
const ANY_HEADING = /^#{1,6}\s/;
const BULLET_START = /^[-*]\s+\S/;
const CONTINUATION = /^\s+\S/;
const ISSUE_REF = /#(\d{1,6})(?!\d)/g;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'onto', 'over',
  'via', 'not', 'but', 'are', 'was', 'were', 'has', 'have', 'had', 'its',
  'per', 'out', 'off', 'all', 'any', 'one', 'two', 'now', 'new', 'old',
]);

/** Token-overlap ratio (over the shorter bullet) above which two bullets are the same item. */
const SIMILARITY_THRESHOLD = 0.6;
/** Below this token count, overlap ratio is too noisy — fall back to exact/containment only. */
const MIN_TOKENS_FOR_SIMILARITY = 3;
/** Shortest normalized text for which substring containment implies duplication. */
const MIN_CHARS_FOR_CONTAINMENT = 16;

interface Section {
  /** Index of the `## Open ...` heading line. */
  start: number;
  /** Exclusive index of the next heading line (or line count). */
  end: number;
}

function isLedgerHeading(line: string): boolean {
  return OPEN_HEADING.test(line) && !OPEN_FINDINGS_HEADING.test(line);
}

/** Locate the `## Open for next session` section, ignoring the appended `## Open Findings` table. */
function findLedgerSection(lines: string[]): Section | null {
  const start = lines.findIndex(isLedgerHeading);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADING.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

/**
 * Collect bullet blocks in [from, to). A block is a `- ` line plus any
 * following indented continuation lines, so multi-line bullets stay intact.
 */
function collectBullets(lines: string[], from: number, to: number): string[] {
  const bullets: string[] = [];
  let current: string[] | null = null;
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (BULLET_START.test(line.trimStart()) && !CONTINUATION.test(line)) {
      if (current) bullets.push(current.join('\n'));
      current = [line];
    } else if (current && CONTINUATION.test(line)) {
      current.push(line);
    } else if (current) {
      bullets.push(current.join('\n'));
      current = null;
    }
  }
  if (current) bullets.push(current.join('\n'));
  return bullets;
}

/** Parse the carry-forward candidates out of a previously written next-session.md. */
export function extractLedgerBullets(fileContent: string): string[] {
  const lines = fileContent.split('\n');
  const section = findLedgerSection(lines);
  if (!section) return [];
  return collectBullets(lines, section.start + 1, section.end);
}

function normalize(bullet: string): string {
  return bullet
    .replace(/^[\s]*[-*]\s+/, '')
    .toLowerCase()
    .replace(/`+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/[^a-z0-9#/. -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function issueRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(ISSUE_REF)) refs.add(m[1]);
  return refs;
}

function tokenize(normalized: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of normalized.split(/[\s/.]+/)) {
    const t = raw.replace(/^#/, '');
    if (t.length >= 3 && !STOPWORDS.has(t)) tokens.add(t);
  }
  return tokens;
}

/** Deterministic "same backlog item" test: shared issue ref, identical text, containment, or token overlap. */
export function bulletsMatch(a: string, b: string): boolean {
  const refsA = issueRefs(a);
  const refsB = issueRefs(b);
  for (const ref of refsA) if (refsB.has(ref)) return true;
  // Both sides name issues and none overlap — different items, however similar
  // the prose. Text similarity must not merge "#684 merge" into "#685 merge".
  if (refsA.size > 0 && refsB.size > 0) return false;

  const normA = normalize(a);
  const normB = normalize(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const shorter = normA.length <= normB.length ? normA : normB;
  const longer = shorter === normA ? normB : normA;
  if (shorter.length >= MIN_CHARS_FOR_CONTAINMENT && longer.includes(shorter)) return true;

  const tokensA = tokenize(normA);
  const tokensB = tokenize(normB);
  const minSize = Math.min(tokensA.size, tokensB.size);
  if (minSize < MIN_TOKENS_FOR_SIMILARITY) return false;
  let shared = 0;
  for (const t of tokensA) if (tokensB.has(t)) shared++;
  return shared / minSize >= SIMILARITY_THRESHOLD;
}

/**
 * Mechanical shipped-check: true only when the bullet names at least one
 * issue/PR ref AND every one of them appears in the git log text. A bullet
 * with no ref is never auto-dropped.
 */
export function isShippedPerGitLog(bullet: string, gitLogText: string): boolean {
  if (!gitLogText) return false;
  const refs = issueRefs(bullet);
  if (refs.size === 0) return false;
  const logRefs = issueRefs(gitLogText);
  for (const ref of refs) if (!logRefs.has(ref)) return false;
  return true;
}

function lastNonEmptyIndex(lines: string[], from: number, to: number): number {
  for (let i = to - 1; i >= from; i--) {
    if (lines[i].trim() !== '') return i;
  }
  return from - 1;
}

/**
 * Merge the previous ledger's open bullets into freshly generated
 * next-session.md content.
 *
 * Pure: no filesystem, no git, no LLM. Never throws — any unexpected shape in
 * `existingFileContent` results in `newContent` being returned unchanged
 * (fail-open, because next-session.md is bootstrap-continuity critical).
 */
export function mergeNextSessionLedger(
  existingFileContent: string,
  newContent: string,
  gitLogText: string,
  maxBullets: number = NEXT_SESSION_MAX_BULLETS,
): string {
  try {
    if (!existingFileContent || !existingFileContent.trim()) return newContent;
    const existingBullets = extractLedgerBullets(existingFileContent);
    if (existingBullets.length === 0) return newContent;

    const lines = newContent.split('\n');
    const section = findLedgerSection(lines);
    const newBullets = section ? collectBullets(lines, section.start + 1, section.end) : [];

    const carried: string[] = [];
    for (const bullet of existingBullets) {
      if (isShippedPerGitLog(bullet, gitLogText)) continue;
      if (newBullets.some(n => bulletsMatch(n, bullet))) continue;
      if (carried.some(c => bulletsMatch(c, bullet))) continue;
      carried.push(bullet);
    }
    if (carried.length === 0) return newContent;

    const room = Math.max(0, maxBullets - newBullets.length);
    const kept = carried.slice(0, room);
    const truncated = carried.length - kept.length;

    const insertion: string[] = [];
    for (const bullet of kept) insertion.push(...bullet.split('\n'));
    if (truncated > 0) {
      if (insertion.length > 0) insertion.push('');
      insertion.push(`_(+${truncated} older items truncated)_`);
    }
    if (insertion.length === 0) return newContent;

    if (!section) {
      const body = newContent.endsWith('\n') ? newContent : `${newContent}\n`;
      return `${body}\n## Open for next session\n\n${insertion.join('\n')}\n`;
    }

    const insertAt = lastNonEmptyIndex(lines, section.start + 1, section.end) + 1;
    lines.splice(insertAt, 0, ...insertion);
    return lines.join('\n');
  } catch {
    return newContent;
  }
}
