/**
 * Relevance model for lesson auto-injection (issue #669).
 *
 * WHY THIS EXISTS AS ITS OWN MODULE — the first cut of #669 scored a card by
 * raw keyword overlap (`scoreMemoryKeywords`: +2 per word-boundary hit, +1 per
 * substring hit) against an absolute floor. That score grows monotonically with
 * TASK LENGTH, and the tokenizer filtered only on `w.length > 3` — no stopwords.
 * Three incidental function words ("with", "never", "must") reached the floor,
 * so the "relevance floor" was really a length threshold:
 *
 *   - a 1.2 KB pottery-studio newsletter with zero engineering vocabulary
 *     injected cards at scores 25 / 13 / 12 / 10;
 *   - a task yielding ≤2 keywords was capped at `2 × keywords.length` = 4 and
 *     could NEVER inject, however precisely it matched.
 *
 * Both directions are the same bug. The model below fixes it with four pieces:
 *
 *  1. STOPWORDS — function words and lesson-card template words are dropped
 *     from both sides. This is what kills the off-domain false positive: a
 *     pottery newsletter's entire overlap with an engineering card consists of
 *     words like `never must that first with before`.
 *
 *  2. DISTINCT-TERM MATCHING — a term contributes at most once, no matter how
 *     often it occurs. Raw hit counts are what let one padded card score 123
 *     against genuine cards at 43 and 33.
 *
 *  3. CORPUS-FREQUENCY DEMOTION — a term present in every card carries no
 *     signal. Weight decays linearly with document frequency over the cards
 *     actually scanned this dispatch. Linear (not log-IDF) because the corpus is
 *     tiny (single-digit card counts are normal) and log-IDF is unstable there.
 *
 *  4. SATURATING QUERY NORMALIZATION — the score is the fraction of the task's
 *     informative vocabulary the card covers, where the task is treated as
 *     having at most `LESSON_QUERY_SATURATION` distinct informative terms. Below
 *     saturation the measure is true coverage (so "Fix TOCTOU in relay." against
 *     a TOCTOU card scores 1.0); above it the denominator is constant, so long
 *     briefs are compared on informative-overlap mass rather than on length.
 *     This is the same length-saturation idea BM25 applies to documents.
 *
 * Plus one anti-starvation term: a card's score is diluted once its distinct
 * informative vocabulary exceeds `LESSON_CARD_TERM_REFERENCE`. A lesson card
 * written as prose tops out around 55 distinct informative terms; a card padded
 * into a keyword list to match every task exceeds that, and each of its terms is
 * then worth proportionally less. "A card that mentions everything is about
 * nothing."
 *
 * Measured on the real corpus (11 cards, 2026-07-26) — see
 * tests/orchestrator/lesson-relevance.test.ts:
 *   pottery newsletter (1.3 KB, off-domain)   top 0.025  → nothing injects
 *   dashboard/CSS brief (0.9 KB, off-domain)  top 0.050  → nothing injects
 *   "Fix TOCTOU in relay." + TOCTOU card      top 1.000  → injects
 *   4 real dispatch briefs (3.2–3.6 KB)       top 0.227–0.277 → inject
 */

import { LESSON_STOPWORDS } from './lesson-stopwords';

/**
 * Denominator saturation: distinct informative task terms beyond this count do
 * not further dilute coverage. 40 sits above every short/medium task and well
 * below a real 3.5 KB dispatch brief (~200 informative terms), which is exactly
 * the regime where a pure coverage ratio would collapse toward zero.
 */
export const LESSON_QUERY_SATURATION = 40;

/** Lower bound on the corpus-frequency weight, so a ubiquitous term is demoted, not erased. */
export const LESSON_DF_WEIGHT_FLOOR = 0.1;

/**
 * Smoothing pseudo-corpus for the document-frequency weight: demotion is
 * computed against `max(cardCount, LESSON_DF_MIN_CORPUS)`.
 *
 * Without it, "present in every card" is a claim made on as few as two samples.
 * A fresh agent with three near-identical cards would see every shared term
 * demoted to near zero and recall nothing — measured: six duplicate cards drove
 * a genuinely matching task from 0.31 to 0.11. Smoothing makes df demotion
 * proportional to the evidence for it.
 */
export const LESSON_DF_MIN_CORPUS = 10;

/**
 * Distinct informative terms a prose lesson card is expected to carry. Measured
 * across the real corpus: 20–56. Cards above this are diluted by
 * `REFERENCE / |terms|` — the anti-padding term.
 */
export const LESSON_CARD_TERM_REFERENCE = 60;

/**
 * A single incidental term is never enough. Without this, a 3-word task whose
 * one informative term happens to appear in some card scores a perfect 1.0.
 */
export const LESSON_MIN_DISTINCT_MATCHES = 2;

/** Absolute floor on the weighted overlap — two matches of low-value terms do not qualify. */
export const LESSON_MIN_WEIGHTED_OVERLAP = 1.2;

/**
 * Relevance floor. Off-domain controls measure 0.025 (pottery) and 0.050
 * (dashboard/CSS); real briefs measure 0.227–0.277 at the top and 0.186–0.259
 * at the second card. 0.12 sits ~2.4× above the highest off-domain control and
 * ~1.6× below the lowest genuine second card.
 */
export const LESSON_MIN_RELEVANCE = 0.12;

/**
 * Scoring-only cap on task text. Tokenisation is linear, but a spec-inlined
 * 250 KB task produced ~20k distinct keywords and dominated dispatch latency.
 * The head of a dispatch brief carries the subject; the tail is context.
 */
export const LESSON_MAX_SCORED_TASK_CHARS = 40_000;

/** Word-splitter shared with `extractMemoryKeywords` (agent-memory.ts). */
const WORD_SPLIT = /[\s,/.;:!?()\[\]{}*_~`"'<>|]+/;

/**
 * Distinct informative terms of `text`: lowercased, split on punctuation and
 * markdown emphasis, ≥4 chars, stopwords removed.
 */
export function lessonTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(WORD_SPLIT)) {
    if (w.length > 3 && !LESSON_STOPWORDS.has(w)) out.add(w);
  }
  return out;
}

export interface ScorableCard {
  /** Distinct informative terms of the card body. */
  terms: Set<string>;
}

export interface LessonRelevance {
  /** Coverage score in [0, ~1]. Compare against LESSON_MIN_RELEVANCE. */
  relevance: number;
  /** Sum of corpus-frequency weights over matched terms. */
  weightedOverlap: number;
  /** Number of distinct task terms found in the card. */
  matches: number;
}

/**
 * Score every card against one task. Corpus-frequency weights are computed over
 * `cards` — the candidate set actually scanned for this dispatch — so a term
 * every card shares is demoted without needing a global index.
 */
export function scoreLessonCards(
  taskText: string,
  cards: readonly ScorableCard[],
): LessonRelevance[] {
  if (cards.length === 0) return [];
  const n = Math.max(cards.length, LESSON_DF_MIN_CORPUS);

  const df = new Map<string, number>();
  for (const card of cards) {
    for (const t of card.terms) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const taskTerms = lessonTerms(taskText.slice(0, LESSON_MAX_SCORED_TASK_CHARS));
  const denominator = Math.min(taskTerms.size, LESSON_QUERY_SATURATION) || 1;

  return cards.map(card => {
    let weightedOverlap = 0;
    let matches = 0;
    // Iterate the smaller set — a short task against a long card, or the
    // reverse — so the cost is min(|T|, |C|) set lookups, not a regex per pair.
    const [probe, target] = taskTerms.size <= card.terms.size
      ? [taskTerms, card.terms]
      : [card.terms, taskTerms];
    for (const t of probe) {
      if (!target.has(t)) continue;
      matches++;
      weightedOverlap += Math.max(
        LESSON_DF_WEIGHT_FLOOR,
        1 - ((df.get(t) ?? 1) - 1) / n,
      );
    }
    const dilution = Math.min(1, LESSON_CARD_TERM_REFERENCE / Math.max(1, card.terms.size));
    return {
      relevance: (weightedOverlap / denominator) * dilution,
      weightedOverlap,
      matches,
    };
  });
}

/** Gate a scored card: all three thresholds must hold. */
export function clearsLessonFloor(r: LessonRelevance): boolean {
  return r.matches >= LESSON_MIN_DISTINCT_MATCHES
    && r.weightedOverlap >= LESSON_MIN_WEIGHTED_OVERLAP
    && r.relevance >= LESSON_MIN_RELEVANCE;
}
