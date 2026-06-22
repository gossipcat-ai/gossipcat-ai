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
  data_integrity: [/data.?corrupt/i, /\bintegrity\b/i, /\bconsistency\b/i, /idempoten/i, /non.?atomic/i, /\bcontradict/i, /scope.?mismatch/i],
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
  // Game-design review vocabulary added 2026-06-22. The security/correctness buckets
  // above leave player-feel and visual-clarity findings uncategorized (a Forbidden Brew
  // gaze-cue consensus round logged ~8 "category resolution failed" misses on
  // unity-playtester's UX prose). These two buckets cover game-feel/activation and
  // legibility/observation findings. Patterns kept game-specific to avoid colliding with
  // security review vocab (e.g. "ring buffer" matches neither — only "world-space ring/cue").
  game_feel: [/game.?feel/i, /\bsticky\b/i, /\bsluggish\b/i, /\bsnappy\b/i, /\bjuice\b/i, /input.?trap/i, /mis.?fire/i, /mis.?trigger/i, /\bdwell\b/i, /auto.?fire/i, /\bhysteresis\b/i],
  legibility: [/legibilit/i, /readab(le|ility)/i, /\bvisibility\b/i, /\bocclu(de|sion)/i, /\breticle\b/i, /\bcrosshair\b/i, /world.?space.?(ring|cue)/i, /\bgaze\b/i, /billboard/i, /screenshot/i],
};

/**
 * Canonical allowlist of category keys, derived from CATEGORY_PATTERNS so the
 * two sources can never drift. Used by parse-findings and parseCrossReviewResponse
 * to reject agent-supplied category strings that aren't real categories — without
 * this guard, an agent typo would land in `categoryStrengths[<typo>]` and poison
 * scoring permanently (see spec 2026-05-20-category-resolution-fix.md PART F).
 */
export const VALID_CATEGORIES: ReadonlySet<string> = new Set(Object.keys(CATEGORY_PATTERNS));

export function isValidCategory(c: string | undefined): c is string {
  return typeof c === 'string' && VALID_CATEGORIES.has(c);
}

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
