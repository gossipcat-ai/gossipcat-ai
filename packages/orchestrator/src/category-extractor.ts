/**
 * CategoryExtractor — extracts finding categories from confirmed finding text.
 * Pure function, no side effects. Categories are predefined via regex patterns.
 */

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  // Web-auth vocabulary added 2026-04-26 after a sibling orchestrator hit 7/31
  // uncategorized findings on a Clerk-auth review. CSRF / sec-fetch / samesite /
  // origin-header are auth-boundary concerns and belong with the existing
  // authenticat/authoriz/credential keywords rather than a separate bucket.
  trust_boundaries: [/trust.?boundar/i, /authenticat/i, /authoriz/i, /impersonat/i, /identity/i, /credential/i, /\bcsrf\b/i, /sec.?fetch/i, /samesite/i, /origin.?header/i, /\bcors\b/i, /\bjwt\b/i, /session.?fixation/i],
  injection_vectors: [/inject/i, /sanitiz/i, /escape/i, /\bxss\b/i, /sql.?inject/i, /prompt.?inject/i],
  input_validation: [/validat/i, /input.?check/i, /type.?guard/i, /\bschema\b/i, /malform/i],
  concurrency: [/race.?condition/i, /deadlock/i, /\batomic\b/i, /concurrent/i, /\bmutex\b/i, /\btoctou\b/i],
  resource_exhaustion: [/\bdos\b/i, /unbounded/i, /memory.?leak/i, /exhaust/i, /\btimeout\b/i, /infinite.?loop/i],
  type_safety: [/type.?safe/i, /typescript/i, /type.?narrow/i, /\bany\[?\]?\b/i, /type.?assert/i, /type.?guard/i],
  error_handling: [/error.?handl/i, /\bexception\b/i, /\bfallback\b/i, /try.?catch/i, /unhandled/i],
  data_integrity: [/data.?corrupt/i, /\bintegrity\b/i, /\bconsistency\b/i, /idempoten/i, /non.?atomic/i],
  // Fabrication-class failures: agent cites code that does not match repo state.
  // Kept in sync with DEFAULT_KEYWORDS.citation_grounding in skill-loader.ts —
  // both tables drive contextual activation and must agree.
  citation_grounding: [/\bcite\b/i, /citation/i, /fabricat/i, /hallucin/i, /\bverify\b/i, /does not exist/i],
  // Phase 1 dev-quality extensions (consensus 09693c51-184246e5). Vocabulary
  // disjoint from the security buckets above. Word boundaries on log/monitor
  // to avoid backlog/catalog/dialog/monitor-thread false-positives.
  observability: [/observability/i, /\blog(ging)?\b/i, /\bmetric/i, /tracing/i, /telemetry/i, /\bmonitor(ing)?\b/i, /dashboard/i, /stderr/i],
  cli_ergonomics: [/\bcli\b/i, /\bflag\b/i, /help text/i, /error message/i, /\busage\b/i, /\bprompt\b/i, /banner/i, /spinner/i],
  performance: [/\blatency/i, /slow/i, /performance/i, /\bn\+1\b/i, /uncached/i, /readFileSync/i, /synchronous/i, /hot path/i],
  testing: [/\btest(s|ing)?\b/i, /coverage/i, /\bmock\b/i, /\bfixture\b/i, /\bunit test/i, /integration test/i, /\be2e\b/i, /test suite/i],
};

export function extractCategories(findingText: string): string[] {
  const matched = new Set<string>();
  for (const [category, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(findingText)) {
        matched.add(category);
        break;
      }
    }
  }
  return Array.from(matched);
}
