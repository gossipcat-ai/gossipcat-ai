/**
 * eval/score.ts — Precision / Recall / F1 per agent, severity-weighted.
 *
 * Severity weights (spec §"Scoring rubric"): critical 4×, high 2×, medium 1×, low 0.5×.
 * - A missed `critical` ground truth costs 4× a missed `low`.
 * - A fabricated `critical` finding costs 4× a fabricated `low`.
 *
 * Precision = sum(match * w_finding) / sum(w_finding)
 * Recall    = sum(matched_gt_w) / sum(gt_w)
 * F1        = 2·P·R / (P+R)
 */

import { FindingShape, GroundTruthShape, bestMatch } from './match';

export interface CaseRun {
  caseId: string;
  /** Ground truths from the case yaml. Empty array == negative case. */
  groundTruth: GroundTruthShape[];
  /** Per-agent findings emitted in this run. */
  byAgent: Record<string, FindingShape[]>;
}

export interface AgentCaseScore {
  agentId: string;
  caseId: string;
  precision: number;
  recall: number;
  f1: number;
  /** Sum of severity-weighted match values. */
  matchedWeight: number;
  /** Sum of severity weights of all findings emitted. Used as precision denominator. */
  findingWeight: number;
  /** Sum of severity weights of all ground truths. Used as recall denominator. */
  truthWeight: number;
  /** Per-finding diagnostic: best match against any GT. */
  details: Array<{ finding: FindingShape; gtId: string | null; score: number }>;
}

export interface SuiteScores {
  runId: string;
  cases: CaseRun[];
  /** Aggregate per agent across all cases. */
  perAgent: Record<string, {
    agentId: string;
    precision: number;
    recall: number;
    f1: number;
    matchedWeight: number;
    findingWeight: number;
    truthWeight: number;
    casesEvaluated: number;
  }>;
  /** Per-(agent, case) breakdown. */
  perCase: AgentCaseScore[];
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 2,
  medium: 1,
  low: 0.5,
};

function severityWeight(sev: string | undefined): number {
  if (!sev) return 1;
  const w = SEVERITY_WEIGHT[sev.toLowerCase()];
  return typeof w === 'number' ? w : 1;
}

/** Score one (agent, case) pair. */
export function scoreAgentCase(
  agentId: string,
  caseId: string,
  findings: FindingShape[],
  truths: GroundTruthShape[],
): AgentCaseScore {
  const details: AgentCaseScore['details'] = [];
  let matchedWeight = 0;
  let findingWeight = 0;
  const matchedGtIds = new Set<string>();

  for (const f of findings) {
    const w = severityWeight(f.severity);
    findingWeight += w;
    const { score, gtId } = bestMatch(f, truths);
    matchedWeight += w * score;
    if (gtId && score >= 0.7) matchedGtIds.add(gtId);
    details.push({ finding: f, gtId, score });
  }

  let truthWeight = 0;
  let recallNumerator = 0;
  for (const gt of truths) {
    const w = severityWeight(gt.severity);
    truthWeight += w;
    if (matchedGtIds.has(gt.id)) recallNumerator += w;
  }

  // Precision conventions:
  //   - No findings emitted, no truths → P=1, R=1 (perfect "stayed silent" on negative case).
  //   - No findings emitted, truths exist → P=1 (vacuously), R=0.
  //   - Findings emitted, no truths (negative case fabrication) → P=0, R=1 (vacuous; no truths to miss).
  //     That double-credit on R is fine because F1 with P=0 still drops to 0.
  const precision = findingWeight === 0 ? 1 : matchedWeight / findingWeight;
  const recall = truthWeight === 0 ? 1 : recallNumerator / truthWeight;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    agentId,
    caseId,
    precision,
    recall,
    f1,
    matchedWeight,
    findingWeight,
    truthWeight,
    details,
  };
}

/** Aggregate per-agent across cases — micro-average over weights. */
export function scoreSuite(runId: string, cases: CaseRun[]): SuiteScores {
  const perCase: AgentCaseScore[] = [];
  const agentIds = new Set<string>();
  for (const c of cases) {
    for (const aid of Object.keys(c.byAgent)) agentIds.add(aid);
  }

  for (const c of cases) {
    for (const aid of agentIds) {
      const findings = c.byAgent[aid] || [];
      perCase.push(scoreAgentCase(aid, c.caseId, findings, c.groundTruth));
    }
  }

  const perAgent: SuiteScores['perAgent'] = {};
  for (const aid of agentIds) {
    let mw = 0, fw = 0, tw = 0, rNum = 0, n = 0;
    for (const sc of perCase) {
      if (sc.agentId !== aid) continue;
      mw += sc.matchedWeight;
      fw += sc.findingWeight;
      tw += sc.truthWeight;
      rNum += sc.recall * sc.truthWeight;
      n += 1;
    }
    const precision = fw === 0 ? 1 : mw / fw;
    const recall = tw === 0 ? 1 : rNum / tw;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perAgent[aid] = {
      agentId: aid,
      precision,
      recall,
      f1,
      matchedWeight: mw,
      findingWeight: fw,
      truthWeight: tw,
      casesEvaluated: n,
    };
  }

  return { runId, cases, perAgent, perCase };
}
