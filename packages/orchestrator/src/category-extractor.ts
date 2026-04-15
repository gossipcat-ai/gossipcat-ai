/**
 * CategoryExtractor — extracts finding categories from confirmed finding text.
 * Pure function, no side effects. Categories are predefined via regex patterns.
 */

const CATEGORY_PATTERNS: Record<string, RegExp[]> = {
  trust_boundaries: [/trust.?boundar/i, /authenticat/i, /authoriz/i, /impersonat/i, /identity/i, /credential/i],
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
