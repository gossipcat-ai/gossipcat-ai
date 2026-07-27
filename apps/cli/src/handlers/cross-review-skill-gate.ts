/**
 * Severity-conditional cross-review skill injection for the `gossip_collect`
 * consensus path (issue #666).
 *
 * `gossip_collect`'s two-phase branch builds its own `ConsensusEngine`, so it
 * does not inherit the `getAgentSkillsContent` wiring that `DispatchPipeline`
 * hands to `ConsensusCoordinator`. Injecting skills there unconditionally costs
 * ~43KB per agent per round, which the operator decision on #666 accepted only
 * for rounds that actually verify a critical/high-severity finding.
 *
 * This module computes that gate from the Phase-1 agent outputs and returns
 * either the shared resolver (gate open) or `undefined` (gate closed). When it
 * returns `undefined` the caller must omit `getAgentSkillsContent` entirely, so
 * the ungated prompt stays byte-identical to today's.
 */

import {
  parseAgentFindingsStrict,
  crossReviewSkillGateSeverity,
  createAgentSkillsContentResolver,
  type SkillIndex,
} from '@gossip/orchestrator';

/** The subset of a collect result row the gate reads. */
export interface Phase1ResultLike {
  status?: string;
  result?: unknown;
}

export interface GatedCrossReviewSkillsConfig {
  /** Phase-1 results as merged by handleCollect (relay + native). */
  results: readonly Phase1ResultLike[];
  registryGet: (agentId: string) => { skills?: string[] } | null | undefined;
  projectRoot: string;
  getSkillIndex?: () => SkillIndex | null | undefined;
  /** Observability sink. Defaults to stderr, matching the other `[consensus]` lines. */
  log?: (line: string) => void;
}

/**
 * Returns the `getAgentSkillsContent` callback when the Phase-1 findings under
 * review contain at least one `critical`/`high` severity, else `undefined`.
 *
 * Always logs one auditable line naming the verdict and the triggering severity.
 */
export function buildGatedCrossReviewSkillsResolver(
  config: GatedCrossReviewSkillsConfig,
): ((agentId: string, task: string) => string | undefined) | undefined {
  const findings = collectPhase1Findings(config.results);
  const triggeringSeverity = crossReviewSkillGateSeverity(findings);
  const log = config.log ?? ((line: string) => { process.stderr.write(line); });

  log(
    `[consensus] cross-review skills_injected: ${triggeringSeverity !== null} ` +
    `(severity_gate=${triggeringSeverity ?? 'none'}, phase1_findings=${findings.length})\n`,
  );

  if (triggeringSeverity === null) return undefined;

  return createAgentSkillsContentResolver({
    registryGet: config.registryGet,
    projectRoot: config.projectRoot,
    getSkillIndex: config.getSkillIndex,
  });
}

/**
 * Parse `<agent_finding>` tags out of every completed Phase-1 result. Rows that
 * are not completed, or whose `result` is not a string, contribute nothing —
 * result payloads cross an LLM boundary and are never assumed well-shaped.
 */
function collectPhase1Findings(
  results: readonly Phase1ResultLike[] | null | undefined,
): Array<{ severity?: unknown }> {
  if (!Array.isArray(results)) return [];
  const findings: Array<{ severity?: unknown }> = [];
  for (const row of results) {
    if (!row || typeof row !== 'object') continue;
    if (row.status !== 'completed' || typeof row.result !== 'string') continue;
    findings.push(...parseAgentFindingsStrict(row.result).findings);
  }
  return findings;
}
