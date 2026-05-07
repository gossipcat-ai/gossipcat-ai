/**
 * Covers the pure-logic helper `shouldShowProgressBar` and `TERMINAL_STATUSES`
 * exported from `SkillCard.tsx`.
 *
 * Progress bar visibility rules:
 *   - Renders for non-terminal statuses (pending, inconclusive, or no status)
 *     when postBindSignals and minEvidence are defined.
 *   - Does NOT render for terminal statuses (passed, failed, silent_skill,
 *     insufficient_evidence, flagged_for_manual_review) regardless of data.
 *   - Does NOT render when postBindSignals is undefined.
 *   - Does NOT render when minEvidence is undefined or 0.
 *
 * Full React rendering needs jsdom + @testing-library/react (not yet wired for
 * dashboard-v2; see useTheme.test.ts for precedent). The gate logic is the
 * highest-regression-risk surface, so we cover it here with pure function tests.
 */

import {
  shouldShowProgressBar,
  TERMINAL_STATUSES,
} from '../../packages/dashboard-v2/src/lib/skill-card-logic';
import type { SkillStatus } from '../../packages/dashboard-v2/src/lib/types';

describe('TERMINAL_STATUSES', () => {
  it('contains passed', () => expect(TERMINAL_STATUSES.has('passed')).toBe(true));
  it('contains failed', () => expect(TERMINAL_STATUSES.has('failed')).toBe(true));
  it('contains silent_skill', () => expect(TERMINAL_STATUSES.has('silent_skill')).toBe(true));
  it('contains insufficient_evidence', () => expect(TERMINAL_STATUSES.has('insufficient_evidence')).toBe(true));
  it('contains flagged_for_manual_review', () => expect(TERMINAL_STATUSES.has('flagged_for_manual_review')).toBe(true));
  it('does NOT contain pending', () => expect(TERMINAL_STATUSES.has('pending')).toBe(false));
  it('does NOT contain inconclusive', () => expect(TERMINAL_STATUSES.has('inconclusive')).toBe(false));
});

describe('shouldShowProgressBar', () => {
  // ── Shows for non-terminal statuses ──────────────────────────────────────
  it('returns true for status=pending with valid postBindSignals + minEvidence', () => {
    expect(shouldShowProgressBar('pending', 50, 120)).toBe(true);
  });

  it('returns true for status=inconclusive with valid data', () => {
    expect(shouldShowProgressBar('inconclusive', 50, 120)).toBe(true);
  });

  it('returns true when status is undefined (no status set)', () => {
    expect(shouldShowProgressBar(undefined, 50, 120)).toBe(true);
  });

  it('returns true even when postBindSignals=0 (zero signals is a valid count)', () => {
    expect(shouldShowProgressBar('pending', 0, 120)).toBe(true);
  });

  it('returns true when postBindSignals exceeds minEvidence (>100% fill)', () => {
    expect(shouldShowProgressBar('pending', 200, 80)).toBe(true);
  });

  // ── Does NOT show for terminal statuses ──────────────────────────────────
  const terminalStatuses: SkillStatus[] = [
    'passed',
    'failed',
    'silent_skill',
    'insufficient_evidence',
    'flagged_for_manual_review',
  ];

  for (const s of terminalStatuses) {
    it(`returns false for terminal status=${s}`, () => {
      expect(shouldShowProgressBar(s, 50, 120)).toBe(false);
    });
  }

  // ── Missing data guards ───────────────────────────────────────────────────
  it('returns false when postBindSignals is undefined', () => {
    expect(shouldShowProgressBar('pending', undefined, 120)).toBe(false);
  });

  it('returns false when minEvidence is undefined', () => {
    expect(shouldShowProgressBar('pending', 50, undefined)).toBe(false);
  });

  it('returns false when minEvidence is 0 (division-by-zero guard)', () => {
    expect(shouldShowProgressBar('pending', 50, 0)).toBe(false);
  });
});
