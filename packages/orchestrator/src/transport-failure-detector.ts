/**
 * transport-failure-detector.ts — Path 2 mitigation for the relay-worker
 * `resolutionRoots` plumbing gap.
 *
 * Spec: docs/specs/2026-04-29-relay-worker-resolution-roots.md.
 *
 * When a consensus round dispatches a relay-routed agent (gemini-reviewer,
 * gemini-tester, openclaw-agent, …) with `resolutionRoots: [...]`, the relay
 * worker process currently runs against `process.cwd() === projectRoot` —
 * NOT the dispatched worktree. The agent then emits findings of the shape
 * "files are not present in the provided worktree / empty diff / cannot be
 * read", and a downstream cross-reviewer correctly flags those as
 * `hallucination_caught`. The score hit lands on the model even though the
 * actual cause was a transport-layer omission (consensus 328adef4-087942f7,
 * 2026-04-29).
 *
 * This module intercepts `gossip_signals(action: "record")` BEFORE the
 * persistence path and rewrites qualifying `hallucination_caught` signals to
 * `transport_failure`. The rewrite has THREE preconditions and ALL must hold:
 *
 *   1. `signal.signal === 'hallucination_caught'`
 *   2. The agent is NOT a native subagent. Native agents run in-process with
 *      the orchestrator's cwd, so a "files not present" finding from a native
 *      agent is a real hallucination, not a transport failure.
 *   3. The consensus round was dispatched with `resolutionRoots`. Without
 *      `resolutionRoots`, there is no relay-side cwd divergence to blame —
 *      a "files not present" finding is just a finding.
 *   4. The finding text matches the transport-failure pattern.
 *
 * On match, every rewrite is appended to `.gossip/transport-rewrites.jsonl`
 * so operators can verify the heuristic is not over-triggering. The original
 * `signal: "hallucination_caught"` is preserved in the audit row, making the
 * rewrite reversible: a future `gossip_signals(action: "retract", ...)` can
 * walk the audit log and undo bad reclassifications without losing the
 * original signal class.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import type { ConsensusSignal } from './consensus-types';

/** Pattern from spec §"Path 2" tightened with a few additional phrasings the
 * model uses interchangeably. Case-insensitive. Order: longest alternative
 * first to avoid silently skipping subset matches in JS regex `|`. */
export const TRANSPORT_FAILURE_PATTERN =
  /files? (?:are )?(?:not present|missing)|empty diff|empty workspace|cannot be (?:read|located)|not (?:found|present) (?:on|in)(?: the)? (?:disk|filesystem|worktree)/i;

/**
 * Cite-anchor pattern. A real grounded hallucination almost always carries a
 * `<cite tag="file">path:line</cite>` anchor — the model claims to have read
 * the file. A relay-cwd transport failure CANNOT produce one because the
 * worker never actually loaded the file. Co-presence of a cite anchor
 * therefore vetoes the rewrite: prefer false-negative (preserve as
 * hallucination) over false-positive (silently exonerate a real
 * hallucination). See PR #327 sonnet review CRITICAL #1.
 */
export const CITE_ANCHOR_PATTERN =
  /<cite\s+tag=["']file["']\s*>[^<]+<\/cite>/i;

/**
 * Caller context required to evaluate the rewrite preconditions. The detector
 * is a pure function over this struct so unit tests can exercise every code
 * path without touching the filesystem or `.gossip/config.json`.
 */
export interface TransportFailureContext {
  /** True when the agent is a native Claude Code subagent (runs in-process,
   * sees the orchestrator's cwd). */
  isNativeAgent: boolean;
  /** True when the consensus round was dispatched with a non-empty
   * `resolutionRoots`. Looked up by the caller via `consensus_id` against the
   * persisted consensus report. */
  hadResolutionRoots: boolean;
  /** Finding text — usually the `finding` field, falling back to
   * `evidence` when callers consolidate the two before recording. */
  findingText: string;
}

/**
 * Pure detector. Returns `true` when ALL preconditions hold and the caller
 * SHOULD rewrite `signal: "hallucination_caught"` to
 * `signal: "transport_failure"` before persistence.
 *
 * Native agents and rounds without `resolutionRoots` are explicitly EXEMPT —
 * see module docstring.
 */
export function shouldRewriteToTransportFailure(
  signalName: string,
  ctx: TransportFailureContext,
): boolean {
  if (signalName !== 'hallucination_caught') return false;
  if (ctx.isNativeAgent) return false;
  if (!ctx.hadResolutionRoots) return false;
  if (!ctx.findingText) return false;
  if (!TRANSPORT_FAILURE_PATTERN.test(ctx.findingText)) return false;
  // Co-presence veto: if the finding carries a `<cite tag="file">…</cite>`
  // anchor, the agent at least *claims* to have read code. A relay transport
  // failure cannot synthesize a cite. Preserve as hallucination_caught.
  if (CITE_ANCHOR_PATTERN.test(ctx.findingText)) return false;
  return true;
}

/**
 * Audit-log row appended to `.gossip/transport-rewrites.jsonl` on every
 * rewrite. Schema is intentionally narrow — operators reading the file should
 * be able to map a row 1:1 to a (consensus_id, finding_id, agent_id) tuple
 * and reconstruct the original signal class. Excerpt is hard-capped at 200
 * chars to keep rotation predictable.
 */
export interface TransportRewriteAudit {
  ts: string;
  consensus_id: string | undefined;
  finding_id: string | undefined;
  agent_id: string;
  original_signal: 'hallucination_caught';
  rewritten_to: 'transport_failure';
  finding_excerpt: string;
}

/**
 * Append a rewrite audit row to `.gossip/transport-rewrites.jsonl`. Best
 * effort — failures are swallowed and surfaced via stderr so the record path
 * never throws to the MCP caller. Mirrors the established pattern in
 * signal-helpers.ts (every helper wraps appendSignal in try/catch).
 */
export function appendTransportRewrite(
  projectRoot: string,
  audit: TransportRewriteAudit,
): void {
  try {
    const filePath = join(projectRoot, '.gossip', 'transport-rewrites.jsonl');
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(audit) + '\n', 'utf-8');
  } catch (err) {
    process.stderr.write(
      `[gossipcat] appendTransportRewrite failed: ${(err as Error).message}\n`,
    );
  }
}

/**
 * Lookup helper: read the persisted consensus report at
 * `.gossip/consensus-reports/<consensus_id>.json` and return its
 * `resolutionRoots` array (empty if absent). Used by the
 * `gossip_signals(action: "record")` handler to evaluate
 * `hadResolutionRoots`.
 *
 * The handler can derive `consensus_id` from `finding_id` shapes
 * `<consensus_id>:fN` (bulk) and `<consensus_id>:<agent>:fN` (manual) — the
 * 17-character prefix `xxxxxxxx-xxxxxxxx`.
 */
export function lookupRoundResolutionRoots(
  projectRoot: string,
  consensusId: string,
): readonly string[] {
  try {
    const reportPath = join(
      projectRoot,
      '.gossip',
      'consensus-reports',
      `${consensusId}.json`,
    );
    if (!existsSync(reportPath)) return [];
    const raw = readFileSync(reportPath, 'utf-8');
    const parsed = JSON.parse(raw) as { resolutionRoots?: readonly string[] };
    return Array.isArray(parsed.resolutionRoots) ? parsed.resolutionRoots : [];
  } catch {
    return [];
  }
}

/**
 * Extract the 17-character `<consensus_id>` prefix from a `finding_id`. Both
 * canonical shapes are accepted:
 *   - `<consensus_id>:fN`              → bulk_from_consensus
 *   - `<consensus_id>:<agent>:fN`      → manual record
 *
 * Returns `undefined` when the input is malformed.
 */
export function extractConsensusId(findingId: string | undefined): string | undefined {
  if (!findingId) return undefined;
  const match = findingId.match(/^([0-9a-f]{8}-[0-9a-f]{8})(?::|$)/);
  return match ? match[1] : undefined;
}

/**
 * Caller-facing convenience: given a manually recorded consensus signal and a
 * resolver that knows whether the signal's agent is native, decide whether to
 * rewrite, append the audit row, and return the (possibly rewritten) signal.
 *
 * The native-agent check is injected as a callback so the orchestrator
 * package stays free of `apps/cli/.../mcp-context.ts` (which holds
 * `nativeAgentConfigs`). Callers in `apps/cli` thread the live
 * `nativeAgentConfigs` map through the closure.
 */
export function maybeRewriteHallucinationToTransportFailure(
  projectRoot: string,
  signal: ConsensusSignal,
  isNativeAgent: (agentId: string) => boolean,
): ConsensusSignal {
  if (signal.signal !== 'hallucination_caught') return signal;
  const consensusId =
    extractConsensusId(signal.findingId) ?? signal.consensusId ?? undefined;
  if (!consensusId) return signal;
  const roots = lookupRoundResolutionRoots(projectRoot, consensusId);
  // Coalesce both fields: callers can place transport text in either `finding`
  // or `evidence`. Concatenating preserves cite anchors that may live in only
  // one of the two and matches the pattern across either source.
  const findingText = `${signal.evidence ?? ''} ${(signal as { finding?: string }).finding ?? ''}`.trim();
  const ctx: TransportFailureContext = {
    isNativeAgent: isNativeAgent(signal.agentId),
    hadResolutionRoots: roots.length > 0,
    findingText,
  };
  if (!shouldRewriteToTransportFailure(signal.signal, ctx)) return signal;
  appendTransportRewrite(projectRoot, {
    ts: new Date().toISOString(),
    consensus_id: consensusId,
    finding_id: signal.findingId,
    agent_id: signal.agentId,
    original_signal: 'hallucination_caught',
    rewritten_to: 'transport_failure',
    finding_excerpt: (signal.evidence ?? '').slice(0, 200),
  });
  return {
    ...signal,
    signal: 'transport_failure',
  };
}
