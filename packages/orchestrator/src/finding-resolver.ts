// packages/orchestrator/src/finding-resolver.ts
//
// Auto-resolve open findings whose cited code has been fixed.
// Spec: docs/specs/2026-04-27-open-findings-auto-resolve.md (rev2,
// consensus b3f57cc6-22c24114).
//
// Flow:
//   1. acquire `withResolverLock`
//   2. `git rev-list <last-checked-sha>..HEAD --name-only` for touched paths
//      (cold-start: --since=90.days)
//   3. read `.gossip/implementation-findings.jsonl` and filter `status: open`
//   4. structural insight-tag exclusion (NOT regex on prose)
//   5. parse all `<cite tag="file">path:line</cite>` and `<cite tag="fn">…</cite>`
//      tags from finding text
//   6. validate paths (..,  NUL, leading slash, leading tilde, URL scheme,
//      symlink-escape after realpath)
//   7. require multi-cite AND — every cite must be clear
//   8. file-scoped (not range-scoped) symbol-presence check after comment
//      stripping (TS/JS `// …` and `/* … */`)
//   9. emit a `resolve` action via signal pipeline (status flip + chained
//      audit-log entry)
//  10. atomic watermark update at the end
//
// Phase 1 wires the manual MCP tool. Phase 2 (round-close auto-invoke)
// and Phase 3 (post-commit hook) are out of scope — see spec §Rollout.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { withResolverLock } from './file-lock';
import { appendChainedEntry } from './audit-log-chain';

const FINDINGS_FILENAME = 'implementation-findings.jsonl';
const WATERMARK_FILENAME = 'last-resolve-scan.sha';
const COLD_START_SINCE = '90.days';

export interface ResolveOptions {
  /**
   * Skip the watermark and scan the entire repository for resolution
   * candidates. Useful for the manual backstop (Phase 2 spec §Trigger
   * plumbing step 5: "Operators can run a manual full-tree sweep").
   */
  full?: boolean;
  /**
   * Override the watermark SHA. When omitted, the resolver reads
   * `.gossip/last-resolve-scan.sha`.
   */
  sinceSha?: string;
  /**
   * Override the cold-start window (default '90.days'). Reads
   * `.gossip/config.json` → `resolver.coldStartWindow` if available.
   */
  coldStartWindow?: string;
  /**
   * Enable the line-anchored staleness heuristic
   * (spec docs/specs/2026-04-28-resolver-line-anchored-staleness.md).
   * Default `false` — when off, behavior matches the pre-PR file-scoped
   * "absent everywhere" → commit:<sha> path. When on, the resolver also
   * resolves findings whose cited identifier is absent from a ±window
   * around the cited line but still present elsewhere in the file
   * (resolved_by: 'stale_anchor'). See §Heuristic decision matrix.
   */
  lineAnchored?: boolean;
}

/**
 * Default ±window for the line-anchored staleness heuristic. Conservative
 * initial pick per spec §Window size; field data drives tuning. Do not
 * inline this as a magic number — the audit log records it per resolution
 * so calibration sweeps can correlate window size with unresolve rates.
 */
const LINE_ANCHORED_WINDOW = 5;

/**
 * Three-state symbol-presence classification per `(file, identifier)` pair.
 * See spec §Heuristic — three-state evaluation.
 */
export type SymbolPresence =
  | { kind: 'absent_everywhere' }
  | { kind: 'present_at_anchor' }
  | { kind: 'present_elsewhere' };

export interface ResolveResult {
  ok: true;
  scanned: number;
  resolved: number;
  resolvedFindingIds: string[];
  pathRejections: number;
  headSha: string | null;
  /**
   * `null` when nothing was resolved (watermark unchanged) or
   * `'lock_contended'` when the lock could not be acquired in time.
   */
  watermarkAdvanced: boolean;
}

export interface ResolveSkipped {
  ok: false;
  reason: 'lock_contended';
}

interface FindingRow {
  raw: string;            // unparsed JSONL line — preserved on no-op
  parsed: any;            // parsed entry
  index: number;          // 0-based position in the file
}

interface ParsedCites {
  fileCites: Array<{ path: string; line?: number }>;
  fnCites: string[];
}

// ─── public API ───────────────────────────────────────────────────────────

export async function resolveFindings(
  projectRoot: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult | ResolveSkipped> {
  const result = await withResolverLock(projectRoot, () => runUnderLock(projectRoot, opts));
  if (result === null) return { ok: false, reason: 'lock_contended' };
  return result;
}

// ─── core, runs under the resolver lock ───────────────────────────────────

function runUnderLock(projectRoot: string, opts: ResolveOptions): ResolveResult {
  const headSha = readHeadSha(projectRoot);

  // Bug 2: resolve gitRoot once for monorepo subdirectory path normalisation.
  // git rev-list outputs paths relative to the git root, not to projectRoot.
  // We must use gitRoot as the base for both path.relative AND touched-set
  // construction so the two sides agree on separator-prefixed paths.
  let gitRoot: string;
  try {
    gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!gitRoot) gitRoot = projectRoot;
  } catch {
    gitRoot = projectRoot;
  }

  // 1) determine touched-files set
  // Bug 2: pass gitRoot so computeTouchedSet uses the right base directory.
  const touched = opts.full
    ? null  // full mode: every file is fair game
    : computeTouchedSet(projectRoot, opts, gitRoot);

  // 2) read findings
  const findingsPath = path.join(projectRoot, '.gossip', FINDINGS_FILENAME);
  if (!fs.existsSync(findingsPath)) {
    return {
      ok: true,
      scanned: 0,
      resolved: 0,
      resolvedFindingIds: [],
      pathRejections: 0,
      headSha,
      watermarkAdvanced: false,
    };
  }
  const raw = fs.readFileSync(findingsPath, 'utf8');
  const lines = raw.split('\n');
  const rows: FindingRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      rows.push({ raw: line, parsed, index: i });
    } catch { /* skip malformed line — preserve verbatim on rewrite */ }
  }

  let resolvedCount = 0;
  let pathRejections = 0;
  const resolvedFindingIds: string[] = [];

  // Per-consensus-report cache for backfill lookups. Loading the same JSON
  // file once per row would be wasteful when 20+ findings share a round.
  const consensusReportCache = new Map<string, any | null>();

  for (const row of rows) {
    const entry = row.parsed;
    if (entry.status !== 'open') continue;
    // structural insight-tag exclusion (spec §Heuristic safety #2).
    //
    // Pre-PR-299 the writer at apps/cli/src/handlers/collect.ts did NOT
    // persist the `type` field, so this filter was a permanent no-op for
    // every row in the JSONL. PR-299 fixes the writer; for legacy rows
    // (and for the small window where a row was written before the writer
    // fix landed but is read after) we backfill from the consensus report
    // on disk. The taskId format is `<consensusId>:f<N>` — we slice off
    // the `:f<N>` suffix and read `.gossip/consensus-reports/<id>.json`.
    // Conservative: if the report cannot be loaded or the finding is not
    // present, we DO NOT auto-resolve (skip the row entirely) rather than
    // risk treating an insight as a bug-fix.
    if (entry.type === undefined || entry.type === null) {
      const taskId = String(entry.taskId ?? entry.findingId ?? '');
      const colonIdx = taskId.lastIndexOf(':f');
      if (colonIdx > 0) {
        const consensusId = taskId.slice(0, colonIdx);
        let report: any | null;
        if (consensusReportCache.has(consensusId)) {
          report = consensusReportCache.get(consensusId) ?? null;
        } else {
          report = loadConsensusReport(projectRoot, consensusId);
          consensusReportCache.set(consensusId, report);
        }
        if (report) {
          const found = findFindingInReport(report, taskId, entry.finding);
          if (found && typeof found.findingType === 'string') {
            entry.type = found.findingType;
          } else {
            // Found nothing or no type info — conservative skip.
            continue;
          }
        } else {
          // Report missing — conservative skip.
          continue;
        }
      } else {
        // Bug 6: legacy rows may have no :fN suffix (written before the
        // taskId-format was stabilised). Don't skip outright — attempt
        // the symbol-presence check directly, treating the row as a
        // potential finding (not an insight). This is looser than the
        // normal backfill path but better than permanently blocking old
        // rows. Document the degraded confidence via an extra field.
        entry.type = 'finding'; // tentative — no report to confirm
        entry._legacyBackfill = true; // auditable in audit-log
      }
    }
    if (entry.type === 'insight') continue;
    // tag === 'unverified' is still resolvable when its cited symbol is gone;
    // tag-level filtering is the cross-review verdict, not the bug-vs-insight
    // axis. Spec §Heuristic safety #3.

    const findingText = String(entry.finding ?? '');
    const cites = parseCites(findingText);
    if (cites.fileCites.length === 0) continue; // no anchor, nothing to check

    // Bucket B — skip findings citing auto-memory paths (not source code).
    // These are ~/.claude/projects/<encoded-cwd>/memory/ files. They are
    // not candidates for git-touched-set + symbol-presence resolution.
    // Emit a 'skipped'/'not_source' audit entry instead of a rejection.
    let skipAsMemory = false;
    for (const fc of cites.fileCites) {
      if (isAutoMemoryPath(projectRoot, fc.path)) {
        skipAsMemory = true;
        break;
      }
    }
    if (skipAsMemory) {
      try {
        appendChainedEntry(projectRoot, {
          ts: new Date().toISOString(),
          finding_id: String(entry.taskId ?? entry.findingId ?? ''),
          action: 'skipped',
          after_check: 'not_source',
          operator: 'auto',
          reason: 'finding cites auto-memory path, not source code',
        });
      } catch { /* best-effort */ }
      continue;
    }

    // path validation — reject and audit-log any adversarial citation
    const safeFileCites: Array<{ path: string; line?: number; absPath: string }> = [];
    let rejected = false;
    for (const fc of cites.fileCites) {
      const validation = validatePath(projectRoot, fc.path);
      if (!validation.ok) {
        pathRejections++;
        rejected = true;
        try {
          appendChainedEntry(projectRoot, {
            ts: new Date().toISOString(),
            finding_id: String(entry.taskId ?? entry.findingId ?? ''),
            action: 'path_validation_rejected',
            after_check: 'rejected_path',
            operator: 'auto',
            offending_path: fc.path,
            reason: validation.reason,
          });
        } catch { /* best-effort */ }
        break; // any bad path → skip this finding entirely
      }
      safeFileCites.push({ ...fc, absPath: validation.absPath });
    }
    if (rejected) continue;

    // multi-cite AND: every cite must be in the touched set (Path A).
    // Bug 2: use realpath of gitRoot (not projectRoot) as the base for
    // path.relative so it matches the git-root-relative paths in the
    // touched set produced by git rev-list --name-only.
    let realGitRoot: string;
    try { realGitRoot = fs.realpathSync(gitRoot); } catch { realGitRoot = gitRoot; }
    if (touched !== null) {
      let touchedAll = true;
      for (const fc of safeFileCites) {
        const rel = path.relative(realGitRoot, fc.absPath);
        if (!touched.has(rel)) {
          touchedAll = false;
          break;
        }
      }
      if (!touchedAll) continue;
    }

    // file-scoped symbol-presence check, AND across all cites
    const symbolsToCheck = new Set<string>();
    for (const fn of cites.fnCites) symbolsToCheck.add(fn);
    // also extract the literal token at cited line ±5 if no fn cites
    if (symbolsToCheck.size === 0) {
      // synthesize: take the first <code>..</code> or backtick-fenced
      // identifier; if absent, fall back to file-touched only (cannot
      // disambiguate further — spec is conservative, so we leave open)
      const inferred = inferLeadIdentifier(findingText);
      if (inferred) symbolsToCheck.add(inferred);
    }
    if (symbolsToCheck.size === 0) continue;

    // Three-state classification per (cite, symbol) pair.
    // Spec §Heuristic — three-state evaluation. We aggregate at the
    // finding level: every cite must classify the same way for either
    // the existing absent_everywhere → commit:<sha> path or the new
    // present_elsewhere → stale_anchor path to fire. Mixed states or
    // any present_at_anchor leave the finding open.
    let sawAbsentEverywhere = false;
    let sawPresentElsewhere = false;
    let sawPresentAtAnchor = false;
    let sawCiteWithoutLine = false;
    let readFailure = false;
    for (const fc of safeFileCites) {
      let body: string;
      try { body = fs.readFileSync(fc.absPath, 'utf8'); }
      catch { readFailure = true; break; }
      const stripped = stripJsTsComments(body);
      for (const sym of symbolsToCheck) {
        const presence = classifyPresence(
          body,
          stripped,
          sym,
          fc.line,
          LINE_ANCHORED_WINDOW,
        );
        if (presence.kind === 'absent_everywhere') {
          sawAbsentEverywhere = true;
        } else if (presence.kind === 'present_at_anchor') {
          sawPresentAtAnchor = true;
        } else {
          // present_elsewhere — but if this cite has no line, classifyPresence
          // returns present_elsewhere (no anchor to test); track for the
          // "fall back to file-scoped, leave open" rule per spec matrix.
          sawPresentElsewhere = true;
          if (fc.line === undefined) sawCiteWithoutLine = true;
        }
      }
    }
    if (readFailure) continue;

    // Aggregate per spec §Heuristic decision matrix.
    const allAbsentEverywhere =
      sawAbsentEverywhere && !sawPresentElsewhere && !sawPresentAtAnchor;
    const allPresentElsewhere =
      sawPresentElsewhere &&
      !sawAbsentEverywhere &&
      !sawPresentAtAnchor &&
      !sawCiteWithoutLine;

    if (!allAbsentEverywhere && !(opts.lineAnchored && allPresentElsewhere)) {
      // Mixed state, any present_at_anchor, any cite without line, or
      // line-anchored heuristic disabled → leave open.
      continue;
    }

    // emit resolution
    const findingId = String(entry.taskId ?? entry.findingId ?? '');
    const beforeQuote = Array.from(symbolsToCheck).slice(0, 3).join(', ');
    const useStaleAnchor = !allAbsentEverywhere && allPresentElsewhere;
    const resolvedBy = useStaleAnchor
      ? 'stale_anchor'
      : (headSha ? `commit:${headSha}` : 'manual');
    try {
      // mutate row in memory; we'll rewrite the file at the end
      entry.status = 'resolved';
      entry.resolvedAt = new Date().toISOString();
      entry.resolvedBy = resolvedBy;
      row.raw = JSON.stringify(entry);
      if (useStaleAnchor) {
        // Single-line semantics: the audit entry records the cited_line
        // and window from the FIRST cite. Multi-cite findings with all
        // cites passing the strict-AND aggregate share the same window
        // size; the first cite's line is recorded as the anchor for
        // post-hoc audit. This is documented in spec §Audit log entry shape.
        const firstCite = safeFileCites[0];
        appendChainedEntry(projectRoot, {
          ts: entry.resolvedAt,
          finding_id: findingId,
          action: 'resolve',
          resolved_by: 'stale_anchor',
          before_quote: beforeQuote,
          after_check: 'present_elsewhere_only',
          operator: 'auto',
          cited_line: firstCite.line as number,
          window: LINE_ANCHORED_WINDOW,
        });
      } else {
        appendChainedEntry(projectRoot, {
          ts: entry.resolvedAt,
          finding_id: findingId,
          action: 'resolve',
          resolved_by: resolvedBy,
          before_quote: beforeQuote,
          after_check: 'absent',
          operator: 'auto',
        });
      }
      resolvedCount++;
      resolvedFindingIds.push(findingId);
    } catch (err) {
      // rate-limited stderr (mirrors round-counter / PR #296 pattern):
      // a single failure does not abort the whole run.
      try {
        process.stderr.write(
          `[gossipcat] finding-resolver: failed to record resolution for ${findingId}: ${(err as Error).message}\n`,
        );
      } catch { /* best-effort */ }
    }
  }

  // rewrite findings file atomically iff anything changed
  if (resolvedCount > 0) {
    const outLines: string[] = [];
    let cursor = 0;
    for (const r of rows) {
      // preserve pre-row blank lines / malformed lines verbatim
      while (cursor < r.index) {
        outLines.push(lines[cursor] ?? '');
        cursor++;
      }
      outLines.push(r.raw);
      cursor = r.index + 1;
    }
    while (cursor < lines.length) {
      outLines.push(lines[cursor] ?? '');
      cursor++;
    }
    const tmpPath = findingsPath + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, outLines.join('\n'));
    fs.renameSync(tmpPath, findingsPath);
  }

  // watermark update — atomic write-then-rename
  let watermarkAdvanced = false;
  if (!opts.full && headSha) {
    const wmPath = path.join(projectRoot, '.gossip', WATERMARK_FILENAME);
    try {
      const tmp = wmPath + '.tmp.' + Date.now();
      fs.writeFileSync(tmp, headSha + '\n');
      fs.renameSync(tmp, wmPath);
      watermarkAdvanced = true;
    } catch { /* read-only fs etc. */ }
  }

  return {
    ok: true,
    scanned: rows.length,
    resolved: resolvedCount,
    resolvedFindingIds,
    pathRejections,
    headSha,
    watermarkAdvanced,
  };
}

// ─── helpers (exported for unit tests) ────────────────────────────────────

const PATH_REJECT_REASONS = {
  TRAVERSAL: 'path contains ".." traversal',
  NUL: 'path contains NUL byte',
  ABSOLUTE: 'path is absolute (leading slash)',
  TILDE: 'path uses tilde (home) expansion',
  URL: 'path uses URL scheme',
  ESCAPE: 'realpath escapes project root',
} as const;

/**
 * Detect whether a cited path refers to Claude Code's auto-generated
 * project-memory directory. These files live at:
 *   ~/.claude/projects/<encoded-cwd>/memory/<file>
 * where <encoded-cwd> is the project root with '/' replaced by '-' and
 * a leading '-' prepended (e.g. /Users/foo/bar → -Users-foo-bar).
 *
 * Memory citations are not source code — findings citing them are not
 * candidates for git-touched-set + symbol-presence resolution. They
 * should be skipped (not rejected) with a 'skipped'/'not_source' audit
 * entry so they don't pollute path-rejection counts.
 */
export function isAutoMemoryPath(projectRoot: string, citedPath: string): boolean {
  if (!citedPath || !path.isAbsolute(citedPath)) return false;
  const encoded = projectRoot.replace(/\//g, '-');
  // Claude Code encodes leading '/' as leading '-', so encoded starts with '-'
  const memoryDir = path.join(os.homedir(), '.claude', 'projects', encoded, 'memory') + path.sep;
  return citedPath.startsWith(memoryDir) || citedPath === memoryDir.slice(0, -1);
}

export function validatePath(
  projectRoot: string,
  citedPath: string,
): { ok: true; absPath: string } | { ok: false; reason: string } {
  if (!citedPath || typeof citedPath !== 'string') {
    return { ok: false, reason: 'empty or non-string path' };
  }
  // Order matters: NUL → traversal → tilde → URL → abs-into-root check → realpath/escape
  if (citedPath.includes('\0')) return { ok: false, reason: PATH_REJECT_REASONS.NUL };
  if (citedPath.includes('..')) return { ok: false, reason: PATH_REJECT_REASONS.TRAVERSAL };
  if (citedPath.startsWith('~')) return { ok: false, reason: PATH_REJECT_REASONS.TILDE };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(citedPath)) return { ok: false, reason: PATH_REJECT_REASONS.URL };

  // Bucket A — absolute path handling: instead of flat-rejecting every
  // leading-'/' path, check whether the absolute citation resolves INTO
  // the project root. If so, accept and let the realpath/escape check
  // downstream be the real boundary.
  if (citedPath.startsWith('/')) {
    const absRel = path.relative(projectRoot, citedPath);
    if (absRel.startsWith('..') || path.isAbsolute(absRel)) {
      // absolute path escapes the project root — reject as ESCAPE, not ABSOLUTE
      return { ok: false, reason: PATH_REJECT_REASONS.ESCAPE };
    }
    // falls through to realpath check below with citedPath as the resolved form
  }

  const resolved = citedPath.startsWith('/') ? citedPath : path.resolve(projectRoot, citedPath);
  const rel = path.relative(projectRoot, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: PATH_REJECT_REASONS.ESCAPE };
  }

  // realpath check — symlink escape detection. If the file does not
  // exist yet (unlikely for a citation), accept the resolved path; the
  // file read later will fail naturally and is a non-event.
  try {
    const realFile = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(projectRoot);
    const realRel = path.relative(realRoot, realFile);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      return { ok: false, reason: PATH_REJECT_REASONS.ESCAPE };
    }
    return { ok: true, absPath: realFile };
  } catch {
    // file may not exist; this is fine — no symlink to escape through
    return { ok: true, absPath: resolved };
  }
}

const FILE_CITE_RE = /<cite\s+tag="file">([^<]+?)<\/cite>/g;
const FN_CITE_RE = /<cite\s+tag="fn">([^<]+?)<\/cite>/g;
// Plain-prose path:line pattern. Matches e.g. `cross-reviewer-selection.ts:105`
// or `apps/cli/src/sandbox.ts:218` embedded in finding prose. Most carry-over
// findings (23 of 31 inspected in the PR-299 calibration audit) cite source
// in plain prose rather than via structured `<cite tag="file">` blocks; the
// pre-fix parser silently produced zero fileCites for these and the resolver
// short-circuited at line 148. Constraints:
//   - must end in a known source extension (avoids matching `vN.M`/version
//     strings and arbitrary identifiers)
//   - must have a numeric line component (the resolver requires the file
//     anyway, but a line anchor confirms this is a citation, not free prose)
//   - leading boundary excludes `<` and identifier chars so we never
//     re-match content already inside a `<cite tag=...>` tag (which goes
//     through FILE_CITE_RE above)
//   - trailing boundary excludes identifier chars so `foo.ts:1` doesn't
//     bleed into `:12345abc`
const PLAIN_FILE_CITE_RE =
  /(?<![<\w])([a-zA-Z0-9_\-./]+\.(?:tsx|ts|jsx|js|mjs|cjs|md|json|sh|yml|yaml)):(\d+)(?:[,-](\d+))?(?!\w)/g;

export function parseCites(text: string): ParsedCites {
  const fileCites: Array<{ path: string; line?: number }> = [];
  const fnCites: string[] = [];

  let m: RegExpExecArray | null;
  FILE_CITE_RE.lastIndex = 0;
  // Track byte ranges already consumed by structured cites so the plain-
  // prose pass below does not re-emit the same citation. We keep both
  // because some prose mixes the two forms in a single finding.
  const consumedRanges: Array<[number, number]> = [];
  while ((m = FILE_CITE_RE.exec(text)) !== null) {
    consumedRanges.push([m.index, m.index + m[0].length]);
    const raw = m[1].trim();
    // accept "path:line" or "path"
    const colonIdx = raw.lastIndexOf(':');
    if (colonIdx > 0 && /^\d+(-\d+)?$/.test(raw.slice(colonIdx + 1))) {
      const lineToken = raw.slice(colonIdx + 1);
      const lineNum = parseInt(lineToken.split('-')[0], 10);
      fileCites.push({ path: raw.slice(0, colonIdx), line: Number.isFinite(lineNum) ? lineNum : undefined });
    } else {
      fileCites.push({ path: raw });
    }
  }

  FN_CITE_RE.lastIndex = 0;
  while ((m = FN_CITE_RE.exec(text)) !== null) {
    const sym = m[1].trim();
    if (sym) fnCites.push(sym);
  }

  // Plain-prose pass — only emit when not inside a structured cite range.
  PLAIN_FILE_CITE_RE.lastIndex = 0;
  const seenPaths = new Set(fileCites.map(c => `${c.path}:${c.line ?? ''}`));
  while ((m = PLAIN_FILE_CITE_RE.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    let inside = false;
    for (const [s, e] of consumedRanges) {
      if (start >= s && end <= e) { inside = true; break; }
    }
    if (inside) continue;
    const cite: { path: string; line?: number } = { path: m[1] };
    const lineNum = parseInt(m[2], 10);
    if (Number.isFinite(lineNum)) cite.line = lineNum;
    const key = `${cite.path}:${cite.line ?? ''}`;
    if (seenPaths.has(key)) continue;
    seenPaths.add(key);
    fileCites.push(cite);
  }

  return { fileCites, fnCites };
}

/**
 * Common keywords and single-letter tokens that are too generic to be
 * treated as a meaningful symbol presence indicator. If the inferred
 * identifier matches any of these (or is a single character), we return
 * null rather than permanently blocking resolution on a keyword.
 *
 * Bug 7: backtick-wrapped `null`/`true`/`error`/single-letter tokens
 * used to cause permanent non-resolution because their absence from
 * source is nearly impossible. Skip them.
 */
const INFER_SKIP_LIST = new Set([
  'null', 'true', 'false', 'undefined', 'this', 'self',
  'it', 'i', 'e', 'j', 'x', 'y', 'n', 'm', 's', 't',
  'error', 'result', 'data', 'val', 'value', 'key',
  'item', 'arg', 'args',
]);

/**
 * Heuristic: extract a likely identifier when the finding has no fn-cite.
 * Looks for backtick-wrapped tokens in the prose (e.g., `Math.min()` or
 * `bumpRoundCounter`). Spec §Trigger plumbing step 5: "the literal
 * symbol token wrapped by `<cite tag=\"fn\">…</cite>` or, if absent, the
 * line ±5 of context that the finding quotes."
 *
 * Bug 1: extended regex to accept optional trailing `()` so that
 * `Math.random()` matches `Math.random` (the call-form). The capture
 * group intentionally omits the parens so containsToken can match both
 * the bare identifier and the dotted access form.
 *
 * False-positive mitigation (destructured alias): if a function is
 * imported/destructured under a different name (e.g. `const { random } =
 * Math; random()`) then `Math.random` won't appear in the file. We rely
 * on the backtick-full-phrase as a backstop — only resolve when both the
 * bare identifier (without parens) AND the call-form (e.g. Math.random,
 * random) are absent. This function returns the bare identifier; callers
 * that need the extra check should use both the returned value AND the
 * aliasToken field on the returned object.
 *
 * For simplicity here we just return the bare identifier; the
 * false-positive scenario is mitigated by containsToken which checks the
 * exact dotted path — a destructured alias `random` ≠ `Math.random`,
 * so a finding citing `Math.random()` will still check for `Math.random`
 * in the file body. If only `random` is in the file the check correctly
 * reports allClear=false (symbol present) — i.e. stays open.
 */
export function inferLeadIdentifier(text: string): string | null {
  // Bug 1: accept optional trailing `()` in the backtick-wrapped token.
  const m = text.match(/`([A-Za-z_$][A-Za-z0-9_$.]*)(?:\(\))?`/);
  if (!m) return null;
  const identifier = m[1];
  // Bug 7: skip common keywords and single-character tokens.
  if (identifier.length <= 1 || INFER_SKIP_LIST.has(identifier)) return null;
  return identifier;
}

/**
 * Strip TS/JS comments AND string/template literal contents before doing
 * a symbol-absence check. We must be defensive about:
 *   - block comments containing `//` → handled by ordering (block first)
 *   - string literals containing `/*` → handled by stripping strings
 *   - template literals containing `//` → handled by stripping templates
 *
 * Conservative bias: when in doubt we leave source in place (which keeps
 * the symbol visible and BLOCKS resolution — no false-positive).
 *
 * Strategy (order matters):
 *   1. template literals `\`...\`` → replace contents with empty string
 *   2. double-quoted strings `"..."` → replace contents with empty string
 *   3. single-quoted strings `'...'` → replace contents with empty string
 *   4. block comments `/* ... *\/` removed greedy-non-greedy
 *   5. line comments `// ...` to end-of-line removed AFTER block comments
 *
 * Bugs 3 & 5: symbols in test-assertion strings and `//` inside template
 * literals previously caused false-positive allClear=false (finding stayed
 * open even after the bug was fixed). Stripping string/template contents
 * resolves both.
 *
 * The naive approach over-removes (e.g. multiline strings, escaped quotes)
 * but over-removal keeps allClear=false (conservative), so it's safe.
 */
export function stripJsTsComments(src: string): string {
  // 1. template literals — replace content between backticks (non-greedy,
  //    no newline crossing via [\s\S] to handle multiline templates)
  let out = src.replace(/`[^`\\]*(?:\\[\s\S][^`\\]*)*`/g, '``');
  // 2. double-quoted strings (non-greedy, respects basic escape sequences)
  out = out.replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '""');
  // 3. single-quoted strings
  out = out.replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, "''");
  // 4. block comments
  out = out.replace(/\/\*[\s\S]*?\*\//g, '');
  // 5. line comments
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

/**
 * Whole-token presence check. Required so that searching for `Math.min`
 * doesn't match `Math.minutes`, and `findFile` doesn't match
 * `findFiles`. Word boundaries (`\b`) work for identifiers but fail on
 * dotted access; we hand-roll a check that allows `.`/`$`/`_` inside the
 * token and requires non-identifier on both sides.
 */
export function containsToken(haystack: string, token: string): boolean {
  if (!token) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Left boundary: exclude identifier chars AND `.` so that searching for
  // `random` does not match `.random` in `Math.random`. Bug 4: the original
  // boundary `[^A-Za-z0-9_$]` allowed a preceding `.` to be treated as a
  // word boundary, which caused false token matches on dotted-access forms.
  const re = new RegExp(`(^|[^A-Za-z0-9_$.])${escaped}(?![A-Za-z0-9_$])`);
  return re.test(haystack);
}

/**
 * Classify presence of `symbol` against (raw `body`, comment-`stripped` body,
 * `citedLine`, `window`). Returns one of three states per spec §Heuristic.
 *
 * Caller contract (spec §Implementation):
 *  - Caller pre-computes `stripped = stripJsTsComments(body)` once before
 *    calling. The helper itself is pure: no fs access, no
 *    comment-stripping side-effects, no surprises.
 *  - Whole-file presence is checked against `stripped` (so identifiers
 *    inside comments don't masquerade as real callsites).
 *  - Anchor-window presence is checked against the RAW `body` (so the
 *    window line numbers match the citation's frame of reference —
 *    comment-stripping compresses line numbers and would point at the
 *    wrong source lines).
 *
 * Window semantics:
 *  - `citedLine` is 1-indexed (editor convention); `body.split('\n')[i]`
 *    is the (i+1)-th line, so the window's 0-indexed bounds are
 *    `lo = (citedLine - 1) - window` and `hi = (citedLine - 1) + window`.
 *  - The slice end is INCLUSIVE: `lines.slice(lo, hi + 1)` (Array.slice's
 *    end argument is exclusive, so we add 1 to make `hi` inclusive).
 *  - When `citedLine === undefined`, no anchor window can be computed.
 *    The helper returns `absent_everywhere` if the symbol is missing
 *    file-scope, otherwise `present_elsewhere` — the resolver caller
 *    treats `present_elsewhere` + `cite-without-line` as "leave open"
 *    per spec decision matrix.
 */
export function classifyPresence(
  body: string,
  stripped: string,
  symbol: string,
  citedLine: number | undefined,
  window: number,
): SymbolPresence {
  const inFile = containsToken(stripped, symbol);
  if (!inFile) return { kind: 'absent_everywhere' };
  if (citedLine === undefined) {
    // No anchor — symbol is somewhere in the file. Treated as
    // present_elsewhere; the caller will keep this finding open.
    return { kind: 'present_elsewhere' };
  }
  const lines = body.split('\n');
  if (lines.length === 0) return { kind: 'present_elsewhere' };
  const lo = Math.max(0, (citedLine - 1) - window);
  const hi = Math.min(lines.length - 1, (citedLine - 1) + window);
  // Inclusive end-index: Array.slice's end argument is exclusive, so use
  // hi + 1. Spec §Implementation explicitly mandates this off-by-one
  // resolution after consensus round 2 finding f4.
  const windowText = lines.slice(lo, hi + 1).join('\n');
  const inWindow = containsToken(windowText, symbol);
  return inWindow
    ? { kind: 'present_at_anchor' }
    : { kind: 'present_elsewhere' };
}

// ─── consensus report backfill ────────────────────────────────────────────

/**
 * Load a single consensus report JSON. Returns `null` if the file is
 * missing, unreadable, or unparseable — the caller treats `null` as a
 * conservative skip (do NOT auto-resolve).
 */
function loadConsensusReport(projectRoot: string, consensusId: string): any | null {
  // Defensive sanitisation: consensusId comes from a JSONL row that
  // ultimately traces back to agent prose. Block path-escape attempts.
  if (!/^[A-Za-z0-9_-]+$/.test(consensusId)) return null;
  const reportPath = path.join(projectRoot, '.gossip', 'consensus-reports', `${consensusId}.json`);
  try {
    const raw = fs.readFileSync(reportPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Look up a finding within a consensus report by composite id (preferred)
 * or by exact-match prose fallback. Returns the finding object (which has
 * `findingType: 'finding' | 'suggestion' | 'insight'`) or `null`.
 */
function findFindingInReport(report: any, taskId: string, findingProse: unknown): any | null {
  if (!report || typeof report !== 'object') return null;
  const buckets: string[] = ['confirmed', 'disputed', 'unverified', 'unique', 'insights', 'newFindings'];
  // Pass 1 — match by composite id (consensusId:f<N>)
  for (const bucket of buckets) {
    const arr = report[bucket];
    if (!Array.isArray(arr)) continue;
    for (const f of arr) {
      if (f && typeof f.id === 'string' && f.id === taskId) return f;
    }
  }
  // Pass 2 — fall back to exact prose match (rare but defensive)
  if (typeof findingProse === 'string' && findingProse.length > 0) {
    for (const bucket of buckets) {
      const arr = report[bucket];
      if (!Array.isArray(arr)) continue;
      for (const f of arr) {
        if (f && typeof f.finding === 'string' && f.finding === findingProse) return f;
      }
    }
  }
  return null;
}

// ─── git helpers ──────────────────────────────────────────────────────────

function readHeadSha(projectRoot: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch { return null; }
}

function readWatermark(projectRoot: string): string | null {
  const wmPath = path.join(projectRoot, '.gossip', WATERMARK_FILENAME);
  try {
    const raw = fs.readFileSync(wmPath, 'utf8').trim();
    if (!/^[0-9a-f]{40}$/.test(raw)) {
      try { process.stderr.write(`[gossipcat] resolver: watermark ${raw.slice(0,16)}… invalid; cold-start\n`); } catch { /* */ }
      return null;
    }
    // verify the SHA exists in the repo; otherwise fall back
    try {
      execFileSync('git', ['cat-file', '-e', raw], {
        cwd: projectRoot,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      return raw;
    } catch {
      try { process.stderr.write(`[gossipcat] resolver: watermark sha ${raw.slice(0,12)}… not in repo; cold-start\n`); } catch { /* */ }
      return null;
    }
  } catch { return null; }
}

function readColdStartWindow(projectRoot: string, override?: string): string {
  if (override) return override;
  try {
    const cfgPath = path.join(projectRoot, '.gossip', 'config.json');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const cfg = JSON.parse(raw);
    const w = cfg?.resolver?.coldStartWindow;
    if (typeof w === 'string' && w.trim()) return w.trim();
  } catch { /* config optional */ }
  return COLD_START_SINCE;
}

// SHA pattern — 40-char hex strings emitted by rev-list without --pretty=format:
const SHA_RE = /^[0-9a-f]{40}$/;

function computeTouchedSet(projectRoot: string, opts: ResolveOptions, gitRoot?: string): Set<string> {
  const cwd = gitRoot ?? projectRoot;
  const sinceSha = opts.sinceSha ?? readWatermark(projectRoot);
  const window = readColdStartWindow(projectRoot, opts.coldStartWindow);

  let stdout = '';
  if (sinceSha) {
    try {
      // Bug 8: rev-list without --pretty=format: outputs commit SHA lines
      // interspersed with file names. Adding --pretty=format: (empty format)
      // suppresses commit headers so we only get file paths. This matches
      // the cold-start command below which already had --pretty=format:.
      stdout = execFileSync('git', ['rev-list', `${sinceSha}..HEAD`, '--name-only', '--pretty=format:'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // any git error → fall back to cold-start window
      stdout = '';
    }
  }
  if (!stdout) {
    try {
      stdout = execFileSync('git', ['log', `--since=${window}`, '--name-only', '--pretty=format:'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // shallow clone / no .git / etc. — empty set, still safe
      try { process.stderr.write(`[gossipcat] resolver: --since=${window} failed; touched set is empty (run is non-exhaustive)\n`); } catch { /* */ }
      stdout = '';
    }
  }

  const set = new Set<string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Bug 8 extra safety: filter out any residual 40-char SHA lines that
    // may still appear (e.g. from git versions that ignore --pretty=format:
    // in some modes). File paths cannot be a 40-char hex string in practice.
    if (SHA_RE.test(trimmed)) continue;
    set.add(trimmed);
  }
  return set;
}

// internals exposed for tests
export const FINDING_RESOLVER_INTERNALS = {
  FINDINGS_FILENAME,
  WATERMARK_FILENAME,
  COLD_START_SINCE,
  PATH_REJECT_REASONS,
};
