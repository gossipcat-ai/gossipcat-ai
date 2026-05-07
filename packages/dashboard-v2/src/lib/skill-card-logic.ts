/**
 * Pure logic helpers for SkillCard that can be tested without React / jsdom.
 *
 * Exported from here so tests can import without compiling JSX.
 */
import type { SkillStatus } from './types';

export const TERMINAL_STATUSES = new Set<SkillStatus>([
  'passed',
  'failed',
  'silent_skill',
  'insufficient_evidence',
  'flagged_for_manual_review',
]);

/**
 * Returns true when the MIN_EVIDENCE progress bar should be rendered for a skill slot.
 * Non-terminal statuses (pending, inconclusive, undefined) show the bar;
 * terminal statuses do not — the gate has already fired.
 */
export function shouldShowProgressBar(
  status: SkillStatus | undefined,
  postBindSignals: number | undefined,
  minEvidence: number | undefined,
): boolean {
  const isNonTerminal = !status || !TERMINAL_STATUSES.has(status);
  return (
    isNonTerminal &&
    postBindSignals !== undefined &&
    minEvidence !== undefined &&
    minEvidence > 0
  );
}
