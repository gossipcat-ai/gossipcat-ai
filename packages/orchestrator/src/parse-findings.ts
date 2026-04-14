/**
 * Strict parser for `<agent_finding>` tags emitted by agent output.
 *
 * Extracted from consensus-engine.ts so both call sites (cross-review prompt
 * builder + synthesize) share the same enum + counter behavior. Drift between
 * them previously caused findingIdx misalignment, which silently confirmed
 * the wrong finding when peers cross-reviewed.
 *
 * KEY INVARIANT: findingIdx is sequential across ACCEPTED findings only,
 * starting at 1. Dropped tags (unknown type, missing type, short content) do
 * NOT advance the counter — otherwise IDs would skip and break cross-review
 * matching (see project_cross_review_matching_regression.md).
 *
 * Type enum is intentionally narrow: only `finding`, `suggestion`, `insight`.
 * The match is case-INSENSITIVE on the type value so `type="FINDING"` is
 * accepted, but the attribute name and quote style stay strict (only
 * double-quoted, no whitespace around `=`, no single quotes) to match what
 * the existing consensus-engine regex accepts. Loosening these would change
 * which agent outputs parse.
 */

const MAX_FINDING_CONTENT = 8000;
const MIN_FINDING_CONTENT = 15;
const AGENT_FINDING_PATTERN = /<agent_finding\s+([^>]*)>([\s\S]*?)<\/agent_finding>/g;
// Captures the type value with case-insensitive matching on the value.
// Strict on syntax: lowercase attribute name, =, double-quoted value.
const TYPE_ATTR_PATTERN = /type="([a-zA-Z]+)"/;
const SEVERITY_ATTR_PATTERN = /severity="(critical|high|medium|low)"/;
const CATEGORY_ATTR_PATTERN = /category="([a-z_]+)"/;

const ANCHOR_PATTERN = /[\w./-]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|md|json|yaml|yml|toml|sh):\d+/;

const CANONICAL_TYPES: ReadonlySet<string> = new Set(['finding', 'suggestion', 'insight']);

export type FindingType = 'finding' | 'suggestion' | 'insight';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

export interface ParsedFinding {
  type: FindingType;
  severity: Severity | undefined;
  category: string | undefined;
  content: string;
  hasAnchor: boolean;
  /** 1-based sequential ID across ACCEPTED findings. Combined with idPrefix to form e.g. "agentId:f3". */
  findingIdx: number;
  /** Convenience: `${idPrefix}:f${findingIdx}` when idPrefix is supplied, else `f${findingIdx}`. */
  id: string;
  /** Raw attribute string (between `<agent_finding ` and `>`). Preserved for prompt rebuild. */
  attrs: string;
  /** True when the content was capped at MAX_FINDING_CONTENT. */
  truncated: boolean;
}

export interface ParseFindingsResult {
  findings: ParsedFinding[];
  /** Map of unknown type values → drop count. Keys are normalized to lowercase. */
  droppedUnknownType: Record<string, number>;
  /** Tags dropped because content was empty or under MIN_FINDING_CONTENT chars. */
  droppedShortContent: number;
  /** Tags dropped because no `type="..."` attribute was present at all. */
  droppedMissingType: number;
  /** Total raw `<agent_finding>` tags matched (before any drops). */
  rawTagCount: number;
}

export interface ParseFindingsOptions {
  /** Prefix for the `id` field. Typical use: pass the agentId so IDs become `agentId:fN`. */
  idPrefix?: string;
  /** Fired once per dropped tag with an unknown type. `body` is the raw tag content. */
  onUnknownType?: (type: string, body: string) => void;
  /**
   * Fired once per truncated tag (content > MAX_FINDING_CONTENT). The raw,
   * un-truncated length is passed so the caller can log proportionally.
   */
  onTruncated?: (rawLength: number) => void;
}

/**
 * Strict parser. Returns accepted findings + per-reason drop counters. Never
 * throws — malformed/unclosed tags are skipped silently (the regex match
 * simply doesn't fire on them).
 */
export function parseAgentFindingsStrict(
  raw: string,
  opts: ParseFindingsOptions = {},
): ParseFindingsResult {
  const findings: ParsedFinding[] = [];
  const droppedUnknownType: Record<string, number> = {};
  let droppedShortContent = 0;
  let droppedMissingType = 0;
  let rawTagCount = 0;

  // Fresh regex per call so .lastIndex never leaks across invocations.
  const pattern = new RegExp(AGENT_FINDING_PATTERN.source, AGENT_FINDING_PATTERN.flags);

  let findingIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    rawTagCount++;
    const attrs = match[1];
    let content = match[2].trim();

    if (!content || content.length < MIN_FINDING_CONTENT) {
      droppedShortContent++;
      continue;
    }

    const typeMatch = attrs.match(TYPE_ATTR_PATTERN);
    if (!typeMatch) {
      droppedMissingType++;
      continue;
    }

    const rawType = typeMatch[1];
    const normalizedType = rawType.toLowerCase();
    if (!CANONICAL_TYPES.has(normalizedType)) {
      droppedUnknownType[normalizedType] = (droppedUnknownType[normalizedType] ?? 0) + 1;
      if (opts.onUnknownType) {
        try {
          opts.onUnknownType(normalizedType, content);
        } catch {
          // Caller's logger should not break parsing.
        }
      }
      continue;
    }

    let truncated = false;
    if (content.length > MAX_FINDING_CONTENT) {
      const rawLen = content.length;
      content = content.slice(0, MAX_FINDING_CONTENT) + '\n…[truncated]';
      truncated = true;
      if (opts.onTruncated) {
        try {
          opts.onTruncated(rawLen);
        } catch {
          // Caller's logger should not break parsing.
        }
      }
    }

    const severityMatch = attrs.match(SEVERITY_ATTR_PATTERN);
    const categoryMatch = attrs.match(CATEGORY_ATTR_PATTERN);

    findingIdx++;
    const id = opts.idPrefix ? `${opts.idPrefix}:f${findingIdx}` : `f${findingIdx}`;

    findings.push({
      type: normalizedType as FindingType,
      severity: severityMatch?.[1] as Severity | undefined,
      category: categoryMatch?.[1],
      content,
      hasAnchor: ANCHOR_PATTERN.test(content),
      findingIdx,
      id,
      attrs,
      truncated,
    });
  }

  return {
    findings,
    droppedUnknownType,
    droppedShortContent,
    droppedMissingType,
    rawTagCount,
  };
}

export const PARSE_FINDINGS_LIMITS = {
  MAX_FINDING_CONTENT,
  MIN_FINDING_CONTENT,
} as const;
