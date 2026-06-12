import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseCoverageDegradedMessage } from '@gossip/orchestrator';

/**
 * Strict 8-8 hex consensus-id shape: `xxxxxxxx-xxxxxxxx`. The id reaches this
 * handler from a URL query parameter (untrusted), so we validate the decoded
 * value with a tight allowlist BEFORE joining it onto a filesystem path. This
 * prevents `..`, NUL bytes, or alternative separators from escaping the
 * `.gossip/consensus-reports/` directory.
 */
const SAFE_CONSENSUS_ID = /^[0-9a-f]{8}-[0-9a-f]{8}$/;

export type ModelFamily = 'sonnet' | 'gemini' | 'opus' | 'haiku' | 'other';

export type Verdict = 'confirmed' | 'disputed' | 'unverified' | 'unique';

export interface ConsensusFlowEdge {
  from: { family: ModelFamily; agentCount: number };
  to: { verdict: Verdict; count: number };
  weight: number;
}

export interface ConsensusFlowResponse {
  consensusId: string;
  timestamp: string;
  agentCount: number;
  modelFamilyToFindings: Array<{
    family: ModelFamily;
    agentIds: string[];
    agentCount: number;
  }>;
  familyToOutcome: ConsensusFlowEdge[];
  summary: {
    totalFindings: number;
    confirmed: number;
    disputed: number;
    unverified: number;
    unique: number;
    newFindings: number;
  };
  crossReviewAssignments?: Record<string, string[]>;
  crossReviewCoverage?: Array<{ findingId: string; assigned: number; targetK: number }>;
  partialReview?: boolean;
  coverageDegraded?: { expected: number; received: number; droppedAgents: string[] };
}

export interface ConsensusFlowError {
  error: string;
}

export function isValidConsensusId(id: string): boolean {
  return SAFE_CONSENSUS_ID.test(id);
}

function familyOf(agentId: string): ModelFamily {
  if (agentId.startsWith('sonnet-')) return 'sonnet';
  if (agentId.startsWith('gemini-')) return 'gemini';
  if (agentId.startsWith('opus-')) return 'opus';
  if (agentId.startsWith('haiku-')) return 'haiku';
  return 'other';
}

interface RawFinding {
  id?: string;
  originalAgentId?: string;
}

function tally(report: any, bucket: Verdict): RawFinding[] {
  const arr = report?.[bucket];
  return Array.isArray(arr) ? (arr as RawFinding[]) : [];
}

export function consensusFlowHandler(
  projectRoot: string,
  query: URLSearchParams | undefined,
): ConsensusFlowResponse | ConsensusFlowError {
  const consensusId = query?.get('consensusId')?.trim() ?? '';
  if (!consensusId) {
    return { error: 'consensusId query parameter is required' };
  }
  if (!isValidConsensusId(consensusId)) {
    return { error: `invalid consensusId shape (expected xxxxxxxx-xxxxxxxx hex)` };
  }

  // Trust boundary: `consensusId` has been allowlisted to `[0-9a-f]{8}-[0-9a-f]{8}`
  // BEFORE this `join` runs, so the path cannot escape the consensus-reports dir.
  const reportPath = join(projectRoot, '.gossip', 'consensus-reports', `${consensusId}.json`);
  if (!existsSync(reportPath)) {
    return { error: `consensus ${consensusId} not found` };
  }

  let report: any;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (e: any) {
    return { error: `failed to parse consensus report: ${e?.message ?? 'unknown error'}` };
  }

  // Buckets: ConsensusFinding[] each with originalAgentId. newFindings is
  // a separate shape (no `originalAgentId`, has `agentId`).
  const buckets: Record<Verdict, RawFinding[]> = {
    confirmed: tally(report, 'confirmed'),
    disputed: tally(report, 'disputed'),
    unverified: tally(report, 'unverified'),
    unique: tally(report, 'unique'),
  };
  const newFindings = Array.isArray(report?.newFindings) ? report.newFindings : [];

  const totalFindings =
    buckets.confirmed.length +
    buckets.disputed.length +
    buckets.unverified.length +
    buckets.unique.length +
    newFindings.length;

  // Build family -> agentIds map across all findings.
  const familyAgents = new Map<ModelFamily, Set<string>>();
  for (const verdict of ['confirmed', 'disputed', 'unverified', 'unique'] as Verdict[]) {
    for (const f of buckets[verdict]) {
      const agent = f.originalAgentId;
      if (!agent) continue;
      const fam = familyOf(agent);
      if (!familyAgents.has(fam)) familyAgents.set(fam, new Set());
      familyAgents.get(fam)!.add(agent);
    }
  }

  const modelFamilyToFindings = Array.from(familyAgents.entries()).map(([family, ids]) => ({
    family,
    agentIds: Array.from(ids).sort(),
    agentCount: ids.size,
  })).sort((a, b) => a.family.localeCompare(b.family));

  // Build (family, verdict) -> count edges.
  const edgeCounts = new Map<string, number>();
  for (const verdict of ['confirmed', 'disputed', 'unverified', 'unique'] as Verdict[]) {
    for (const f of buckets[verdict]) {
      const agent = f.originalAgentId;
      if (!agent) continue;
      const fam = familyOf(agent);
      const key = `${fam}::${verdict}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  const familyToOutcome: ConsensusFlowEdge[] = [];
  for (const [key, count] of edgeCounts) {
    const [fam, verdict] = key.split('::') as [ModelFamily, Verdict];
    const agentCount = familyAgents.get(fam)?.size ?? 0;
    familyToOutcome.push({
      from: { family: fam, agentCount },
      to: { verdict, count },
      weight: totalFindings > 0 ? count / totalFindings : 0,
    });
  }
  // Stable, predictable ordering for the frontend renderer.
  familyToOutcome.sort((a, b) => {
    if (a.from.family !== b.from.family) return a.from.family.localeCompare(b.from.family);
    return a.to.verdict.localeCompare(b.to.verdict);
  });

  const out: ConsensusFlowResponse = {
    consensusId,
    timestamp: typeof report?.timestamp === 'string' ? report.timestamp : '',
    agentCount: typeof report?.agentCount === 'number' ? report.agentCount : 0,
    modelFamilyToFindings,
    familyToOutcome,
    summary: {
      totalFindings,
      confirmed: buckets.confirmed.length,
      disputed: buckets.disputed.length,
      unverified: buckets.unverified.length,
      unique: buckets.unique.length,
      newFindings: newFindings.length,
    },
  };

  if (report?.crossReviewAssignments && typeof report.crossReviewAssignments === 'object') {
    out.crossReviewAssignments = report.crossReviewAssignments;
  }
  if (Array.isArray(report?.crossReviewCoverage)) {
    out.crossReviewCoverage = report.crossReviewCoverage;
  }
  // Degraded-mode flags now derive from the warnings channel (spec §4 — the
  // legacy report.partialReview / report.coverageDegraded fields were deleted in
  // PR-C). Old persisted reports still carry the legacy fields, so read the
  // warnings array FIRST and fall back to the legacy shape for back-compat.
  const warnings: Array<{ code?: unknown }> = Array.isArray(report?.warnings) ? report.warnings : [];
  const hasWarning = (code: string) => warnings.some(w => w && (w as any).code === code);

  if (hasWarning('partial_review') || report?.partialReview === true) out.partialReview = true;

  if (report?.coverageDegraded && typeof report.coverageDegraded === 'object') {
    out.coverageDegraded = report.coverageDegraded;
  } else {
    // PR-C reports carry only the warning, whose message is the deterministic
    // engine format produced by buildCoverageDegradedMessage. Parse via the
    // shared parseCoverageDegradedMessage so a template change is a one-file
    // edit that fails CI via the round-trip test.
    const cd = warnings.find(w => w && (w as any).code === 'coverage_degraded') as { message?: string } | undefined;
    if (cd && typeof cd.message === 'string') {
      const parsed = parseCoverageDegradedMessage(cd.message);
      if (parsed) {
        out.coverageDegraded = parsed;
      }
    }
  }

  return out;
}
