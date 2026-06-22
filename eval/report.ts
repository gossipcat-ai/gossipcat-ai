/**
 * eval/report.ts — Markdown leaderboard + McNemar 2x2 table.
 *
 * McNemar's χ² (spec § "McNemar paired before/after"):
 *
 *   χ² = (b - c)² / (b + c)
 *
 * where on a paired before/after run:
 *   b = cases that passed before but failed after (regression)
 *   c = cases that failed before but passed after (improvement)
 *
 * We do NOT compute p-values — operator interprets, or pipes χ² into jstat
 * if available downstream.
 */

import { SuiteScores } from './score';

/** Render a per-agent leaderboard as Markdown. */
export function formatLeaderboard(scores: SuiteScores): string {
  const rows = Object.values(scores.perAgent).sort((a, b) => b.f1 - a.f1);
  if (rows.length === 0) {
    return `# Eval Suite Run \`${scores.runId}\`\n\n_No agent results — empty run._\n`;
  }
  const header = `# Eval Suite Run \`${scores.runId}\`\n\n${scores.cases.length} case(s) evaluated across ${rows.length} agent(s).\n\n`;
  const table: string[] = [
    '| Agent | Cases | Precision | Recall | F1 | Σ matched | Σ findings | Σ truths |',
    '|-------|-------|-----------|--------|----|-----------|------------|----------|',
  ];
  for (const r of rows) {
    table.push(
      `| ${r.agentId} | ${r.casesEvaluated} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} | ${r.f1.toFixed(3)} | ${r.matchedWeight.toFixed(2)} | ${r.findingWeight.toFixed(2)} | ${r.truthWeight.toFixed(2)} |`
    );
  }
  return header + table.join('\n') + '\n';
}

export interface PairedOutcome {
  caseId: string;
  /** Did the agent "pass" this case? Operator-defined threshold (default F1≥0.5). */
  pass: boolean;
}

export interface McNemarResult {
  a: number; // before pass, after pass
  b: number; // before pass, after fail (regression)
  c: number; // before fail, after pass (improvement)
  d: number; // before fail, after fail
  chiSquared: number;
  /** Smaller of b, c — exact-test guidance from spec ("|b-c| ≥ ~7" rule of thumb). */
  discordant: number;
}

/**
 * Compute McNemar contingency from paired case outcomes.
 *
 * `before` and `after` must be the same set of caseIds — an asymmetric pair
 * is silently restricted to the intersection.
 */
export function mcNemar(before: PairedOutcome[], after: PairedOutcome[]): McNemarResult {
  const beforeMap = new Map(before.map(o => [o.caseId, o.pass]));
  const afterMap = new Map(after.map(o => [o.caseId, o.pass]));
  let a = 0, b = 0, c = 0, d = 0;
  for (const [cid, bp] of beforeMap) {
    if (!afterMap.has(cid)) continue;
    const ap = afterMap.get(cid)!;
    if (bp && ap) a++;
    else if (bp && !ap) b++;
    else if (!bp && ap) c++;
    else d++;
  }
  const denom = b + c;
  const chiSquared = denom === 0 ? 0 : ((b - c) ** 2) / denom;
  const discordant = Math.min(b, c);
  return { a, b, c, d, chiSquared, discordant };
}

/** Render McNemar 2x2 + χ² as a Markdown block. */
export function formatMcNemar(before: PairedOutcome[], after: PairedOutcome[]): string {
  const r = mcNemar(before, after);
  return [
    '## McNemar paired before/after',
    '',
    '|                   | After: pass | After: fail |',
    '|-------------------|-------------|-------------|',
    `| **Before: pass**  | ${r.a}            | ${r.b} (regression) |`,
    `| **Before: fail**  | ${r.c} (improved)   | ${r.d}            |`,
    '',
    `χ² = (b - c)² / (b + c) = (${r.b} - ${r.c})² / (${r.b + r.c}) = **${r.chiSquared.toFixed(3)}**`,
    '',
    r.b + r.c < 7
      ? '_Discordant pair count <7 — effect-size below detection floor at α=0.05._'
      : '_Operator: interpret χ² with df=1; |b-c| ≥ 7 ≈ p<0.05 at N≈30._',
    '',
  ].join('\n');
}
