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

// HTML-entity-encoded versions of `<agent_finding>` and related tokens. When
// an agent's output goes through a layer that HTML-escapes everything (e.g.
// a markdown renderer applied before raw parsing, or an upstream relay that
// sanitizes its own output for display), tags arrive as `&lt;agent_finding...&gt;`
// and the strict parser cannot see them. Those rounds silently produce zero
// findings. The producers in parseAgentFindingsStrict emit
// HTML_ENTITY_ENCODED_TAGS / HTML_ENTITY_MIXED_PAYLOAD diagnostics so the
// failure surfaces loudly instead of masquerading as "agent emitted nothing."
const HTML_ENTITY_OPEN_PATTERN = /&lt;agent_finding\b/gi;
const HTML_ENTITY_CLOSE_PATTERN = /&lt;\/agent_finding&gt;/gi;

/**
 * Schema-drift token buckets — see `docs/specs/2026-04-16-schema-drift-diagnostic.md`.
 *
 * Two non-overlapping sets so the diagnostic can distinguish legacy Phase-2
 * consensus verdict drift (high-signal: reviewer prompt teaches the wrong
 * format) from generic type invention (lower-signal: reviewer made up a type
 * name that doesn't match the schema).
 *
 * Membership is exhaustive by intent, not by enumeration: token lists are
 * curated from observed drift patterns. See consensus round `2c0c1e0b-66cf4919:f16`
 * for the split rationale.
 */
const PHASE2_VERDICT_TOKENS: ReadonlySet<string> = new Set([
  'confirmed',
  'disputed',
  'unique',
  'verdict',
]);

const INVENTED_TYPE_TOKENS: ReadonlySet<string> = new Set([
  'approval',
  'rejection',
  'concern',
  'risk',
  'recommendation',
  'observation',
  'critique',
  'bug',
  'issue',
  'warning',
]);

// Matches a `<type>value</type>` nested subtag. Used ONLY when
// `droppedMissingType > 0` — the nested-subtag drift mode hits the missing-
// type bucket because the parser looks for a `type="..."` attribute on the
// outer `<agent_finding>`, not a child tag. See consensus round
// `2c0c1e0b-66cf4919:f9`.
const NESTED_SUBTAG_PATTERN = /<type>\s*([a-z_]+)\s*<\/type>/gi;

/**
 * Escape HTML-significant characters in strings that are interpolated into
 * diagnostic messages. The parser runs orchestrator-side and must not import
 * from the dashboard package (backward dependency), so the helper is mirrored
 * here. Keep in sync with `packages/dashboard-v2/src/lib/sanitize.ts`.
 *
 * Design note: we considered promoting `escapeHtml` to a shared package
 * (`packages/common/` or similar) but the orchestrator has no other need for
 * HTML escaping and creating a new package for a 5-line helper is more churn
 * than it's worth. A second-order mirror is the right call until a third
 * consumer appears — at which point `packages/common/src/html.ts` becomes
 * the obvious home.
 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type FindingType = 'finding' | 'suggestion' | 'insight';
export type Severity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Structured diagnostic attached to a parse result when the raw agent output
 * exhibits a recognizable failure mode. Surfaced on `ConsensusReport.authorDiagnostics`
 * so the dashboard can render a banner explaining why a round has 0 findings
 * despite agents producing content.
 *
 * Discriminated union on `code`.
 *
 * **HTML_ENTITY_* (Phase 1)** — upstream layer HTML-escaped the agent output
 * before it reached the parser.
 *
 * **SCHEMA_DRIFT_* (Phase 2)** — reviewer instructions conflict with the
 * schema. Three failure modes:
 *   - `PHASE2_VERDICT_TOKENS`: reviewer emitted types matching legacy Phase-2
 *     consensus verdict format (`confirmed`, `disputed`, `unique`, `verdict`).
 *   - `INVENTED_TYPE_TOKENS`: reviewer emitted types not in the schema (e.g.
 *     `approval`, `risk`, `bug`) but not a Phase-2 verdict either. Fires only
 *     when PHASE2_VERDICT_TOKENS did NOT fire (Phase 2 takes precedence).
 *   - `NESTED_SUBTAGS`: reviewer emitted `<agent_finding><type>foo</type>...</agent_finding>`
 *     (child subtag) instead of the attribute form `<agent_finding type="foo">`.
 *
 * See `docs/specs/2026-04-16-schema-drift-diagnostic.md` for detection logic
 * and consensus rounds behind the split.
 */
export type ParseDiagnostic =
  | {
      code: 'HTML_ENTITY_ENCODED_TAGS';
      /** Short human-readable summary for the dashboard banner. */
      message: string;
      /** Count of `&lt;agent_finding` occurrences detected in the raw text. */
      entityTagCount: number;
    }
  | {
      code: 'HTML_ENTITY_MIXED_PAYLOAD';
      message: string;
      /** Count of raw `<agent_finding` tags (parsed) in the output. */
      rawTagCount: number;
      /** Count of `&lt;agent_finding` entity-encoded tags detected. */
      entityTagCount: number;
    }
  | {
      code: 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS';
      message: string;
      /**
       * Subset of `droppedUnknownType` keys that matched the
       * Phase-2 verdict token list (`confirmed`, `disputed`, `unique`, `verdict`).
       * Lowercased.
       */
      matchedTokens: string[];
    }
  | {
      code: 'SCHEMA_DRIFT_INVENTED_TYPE_TOKENS';
      message: string;
      /**
       * Subset of `droppedUnknownType` keys that matched the invented-type
       * token list (`approval`, `risk`, `bug`, etc.). Lowercased. Fires ONLY
       * when no PHASE2_VERDICT_TOKENS overlap exists — Phase-2 drift takes
       * precedence because it points to a specific upstream cause (legacy
       * reviewer prompt).
       */
      matchedTokens: string[];
    }
  | {
      code: 'SCHEMA_DRIFT_NESTED_SUBTAGS';
      message: string;
      /**
       * Nested `<type>value</type>` subtag values detected in the raw text
       * when `droppedMissingType > 0`. Lowercased. May contain duplicates if
       * the same subtag type appears multiple times.
       */
      subtagTypes: string[];
    };

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
  /**
   * Structured diagnostics describing recognizable parse failure modes in the
   * raw input. Empty when the parse is clean. Both HTML_ENTITY_* and
   * SCHEMA_DRIFT_* codes are emitted by this parser directly — see the
   * `ParseDiagnostic` union doc for failure mode descriptions.
   */
  diagnostics: ParseDiagnostic[];
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
  const diagnostics: ParseDiagnostic[] = [];
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

    // Type-enum validation MUST precede short-content validation. An invalid
    // type is a stricter contract violation than short content — if both apply,
    // the drop must be attributed to `tags_dropped_unknown_type` (or
    // `tags_dropped_missing_type`), not `tags_dropped_short_content`. Dashboard
    // drift detection uses these buckets to distinguish agent-prompt schema
    // regressions from mere verbosity issues; misattribution masks regressions.
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

    if (!content || content.length < MIN_FINDING_CONTENT) {
      droppedShortContent++;
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

  // Detect HTML-entity-encoded tags. These fire regardless of whether any raw
  // tags parsed: a mixed payload (some raw + some entity-encoded) is just as
  // diagnostic as a pure entity-encoded output, and callers need both signals
  // to distinguish upstream-pipeline bugs from agent output bugs.
  //
  // Matching is case-insensitive on the opening token because some renderers
  // emit `&LT;` in addition to the conventional lowercase form. Count only
  // opening occurrences (closing tags are redundant for detection and can
  // appear in prose discussing the tag syntax).
  const entityMatches = raw.match(HTML_ENTITY_OPEN_PATTERN);
  const entityTagCount = entityMatches ? entityMatches.length : 0;
  if (entityTagCount > 0) {
    if (rawTagCount === 0) {
      diagnostics.push({
        code: 'HTML_ENTITY_ENCODED_TAGS',
        message:
          `Output contains ${entityTagCount} HTML-entity-encoded <agent_finding> ` +
          `tag(s) (&lt;agent_finding...&gt;) and NO raw tags. The parser cannot ` +
          `recognize entity-encoded tags — this round silently produced 0 findings. ` +
          `Likely cause: an upstream layer HTML-escaped the agent output before ` +
          `it reached the parser (markdown renderer, sanitizer, or display-mode ` +
          `serialization).`,
        entityTagCount,
      });
    } else {
      diagnostics.push({
        code: 'HTML_ENTITY_MIXED_PAYLOAD',
        message:
          `Output contains ${rawTagCount} raw <agent_finding> tag(s) AND ` +
          `${entityTagCount} HTML-entity-encoded <agent_finding> tag(s). The ` +
          `entity-encoded tags are invisible to the parser — some of the agent's ` +
          `findings may have been silently dropped depending on which tags were ` +
          `entity-encoded.`,
        rawTagCount,
        entityTagCount,
      });
    }
  }
  // Suppress unused-variable in the close-pattern. Kept in source because it
  // documents the intended boundary for future diagnostics that want to count
  // entity-encoded closers independently of openers.
  void HTML_ENTITY_CLOSE_PATTERN;

  // --- Schema-drift diagnostics (Phase 2) -----------------------------------
  //
  // All three fire regardless of `rawTagCount` / accepted-findings count —
  // partial-drift (some valid, some drifted) is in scope per consensus round
  // `2c0c1e0b-66cf4919:f10`. The dashboard banners are dedup'd at render time,
  // not by the parser.
  //
  // Token interpolations into `message` strings are routed through `escapeHtml`
  // because the message is rendered via `dangerouslySetInnerHTML` downstream
  // (gemini-reviewer `2c0c1e0b-66cf4919:f1`). Even though `droppedUnknownType`
  // keys are already constrained by TYPE_ATTR_PATTERN (`[a-zA-Z]+`), and the
  // nested-subtag regex is `[a-z_]+`, escaping is applied defensively so a
  // future regex relaxation does not silently introduce an XSS sink.

  const unknownTypeKeys = Object.keys(droppedUnknownType);

  // Order matters: Phase-2 verdict precedence. When a single round has BOTH
  // verdict-token drops AND invented-token drops, we surface only the Phase-2
  // diagnostic — it points to a specific, well-known prompt regression
  // (legacy Phase-2 consensus verdict format) and is higher-signal than the
  // generic invented-type hint.
  const phase2Matches = unknownTypeKeys.filter(k => PHASE2_VERDICT_TOKENS.has(k));
  let phase2Fired = false;
  if (phase2Matches.length > 0) {
    phase2Fired = true;
    const tokenList = phase2Matches.map(escapeHtml).join(', ');
    diagnostics.push({
      code: 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS',
      message:
        `Reviewer emitted <agent_finding> tag type(s) [${tokenList}] that were ` +
        `dropped as unknown. These look like Phase-2 consensus verdicts, not ` +
        `Phase-1 finding types. The reviewer's instructions likely teach the ` +
        `legacy CONFIRMED/DISPUTED/UNIQUE format. Valid Phase-1 types are ` +
        `finding | suggestion | insight (handbook invariant #8).`,
      matchedTokens: phase2Matches,
    });
  }

  if (!phase2Fired) {
    const inventedMatches = unknownTypeKeys.filter(k => INVENTED_TYPE_TOKENS.has(k));
    if (inventedMatches.length > 0) {
      const tokenList = inventedMatches.map(escapeHtml).join(', ');
      diagnostics.push({
        code: 'SCHEMA_DRIFT_INVENTED_TYPE_TOKENS',
        message:
          `Reviewer emitted invented <agent_finding> tag type(s) [${tokenList}] ` +
          `that were dropped as unknown. Valid types are ` +
          `finding | suggestion | insight (handbook invariant #8). Check the ` +
          `reviewer's instructions for schema drift.`,
        matchedTokens: inventedMatches,
      });
    }
  }

  // Nested-subtag drift: the reviewer emitted `<agent_finding><type>finding</type>`
  // form instead of attribute form. These tags fail the TYPE_ATTR_PATTERN
  // check on the outer tag and land in `droppedMissingType`. We only scan
  // when `droppedMissingType > 0` because the regex scan is O(text length)
  // and most rounds have no missing-type drops.
  if (droppedMissingType > 0) {
    // Fresh regex per call — NESTED_SUBTAG_PATTERN is shared module-scope so
    // we must reset .lastIndex via a new instance.
    const subtagRe = new RegExp(NESTED_SUBTAG_PATTERN.source, NESTED_SUBTAG_PATTERN.flags);
    const subtagTypes: string[] = [];
    let subMatch: RegExpExecArray | null;
    while ((subMatch = subtagRe.exec(raw)) !== null) {
      subtagTypes.push(subMatch[1].toLowerCase());
    }
    if (subtagTypes.length > 0) {
      const escapedList = subtagTypes.map(escapeHtml).join(', ');
      diagnostics.push({
        code: 'SCHEMA_DRIFT_NESTED_SUBTAGS',
        message:
          `Reviewer emitted nested <type>...</type> subtag(s) [${escapedList}] ` +
          `inside <agent_finding> instead of using the attribute form ` +
          `<agent_finding type="...">. ${droppedMissingType} tag(s) were dropped ` +
          `for missing the type attribute. Handbook invariant #8 requires the ` +
          `attribute form.`,
        subtagTypes,
      });
    }
  }

  return {
    findings,
    droppedUnknownType,
    droppedShortContent,
    droppedMissingType,
    rawTagCount,
    diagnostics,
  };
}

export const PARSE_FINDINGS_LIMITS = {
  MAX_FINDING_CONTENT,
  MIN_FINDING_CONTENT,
} as const;
