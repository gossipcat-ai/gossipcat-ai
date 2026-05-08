/**
 * BM25 ranking for the memory sidecar index.
 *
 * Parameters: k1=1.5, b=0.75 (standard Okapi BM25 defaults).
 * Field weights: name=3, description=2, body=1 — mirrors the prior
 * String.includes weights in memory-searcher.ts. Weights are baked into
 * the term-frequency counts stored in MemoryIndexDoc.terms at index-build
 * time, so the scoring path here is a single BM25 formula per (term, doc).
 *
 * Status boost: additive only, default magnitude 0. `status: undefined` is
 * treated the same as `status: open` — no penalty for missing status.
 */

import type { MemoryIndex, MemoryIndexDoc } from './memory-index-sidecar';

const K1 = 1.5;
const B = 0.75;

export interface BM25Options {
  /** Additive score boost for status:open (and absent status). Default: 0. */
  openBoost?: number;
}

/**
 * Score a single document against a set of query terms using BM25.
 *
 * @param terms   - query token set (de-duplicated)
 * @param doc     - the candidate document
 * @param N       - total number of documents in the index
 * @param avgDl   - average document length across the index
 * @param postings - the index postings map (for df lookup)
 * @param options  - ranking options
 */
export function bm25Score(
  terms: string[],
  doc: MemoryIndexDoc,
  N: number,
  avgDl: number,
  postings: MemoryIndex['postings'],
  options: BM25Options = {},
): number {
  if (N === 0 || terms.length === 0) return 0;

  const dl = doc.length;
  // Avoid division-by-zero when avgDl is 0 (empty corpus)
  const normDl = avgDl > 0 ? dl / avgDl : 1;

  let score = 0;

  for (const term of terms) {
    const tf = doc.terms[term] ?? 0;
    if (tf === 0) continue;

    const posting = postings[term];
    const df = posting?.df ?? 0;
    if (df === 0) continue;

    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    // The +1 keeps IDF positive when df=N.
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

    // BM25 term weight
    const numerator = tf * (K1 + 1);
    const denominator = tf + K1 * (1 - B + B * normDl);
    score += idf * (numerator / denominator);
  }

  // Additive status boost: open or absent status → boost; shipped/closed → no change.
  const { openBoost = 0 } = options;
  if (openBoost > 0) {
    const status = doc.status;
    if (status === 'open' || status === undefined) {
      score += openBoost;
    }
  }

  return score;
}

/**
 * Rank all documents in the index against the query terms.
 * Returns filenames sorted by descending score, with score > 0 only.
 */
export function rankDocuments(
  terms: string[],
  index: MemoryIndex,
  options: BM25Options = {},
): Array<{ filename: string; score: number }> {
  if (terms.length === 0 || index.totalDocs === 0) return [];

  // Quick pre-filter: only score docs that contain at least one query term
  const candidateFilenames = new Set<string>();
  for (const term of terms) {
    const posting = index.postings[term];
    if (posting) {
      for (const filename of posting.docs) {
        candidateFilenames.add(filename);
      }
    }
  }

  const results: Array<{ filename: string; score: number }> = [];

  for (const filename of candidateFilenames) {
    const doc = index.docs[filename];
    if (!doc) continue;
    const score = bm25Score(
      terms,
      doc,
      index.totalDocs,
      index.avgDocLength,
      index.postings,
      options,
    );
    if (score > 0) {
      results.push({ filename, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}
