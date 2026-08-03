/**
 * Pure formatter for the `gossip_status` "Quota health" banner lines.
 *
 * Extracted out of mcp-server-sdk.ts (mirrors the setup-response.ts pattern)
 * so the fall-through order between EXHAUSTED / SUSPECT / OK / NO QUOTA can
 * be unit-tested directly instead of only through the full gossip_status
 * handler. See issue #732.
 */

export interface QuotaProviderStateLike {
  exhaustedUntil?: number;
  reason?: string;
  consecutive429s?: number;
}

/**
 * Format a single "  Quota: <provider> — ..." banner line for one provider's
 * persisted quota-state entry.
 *
 * Fall-through order (first match wins):
 * 1. reason === 'no_quota' — a permanent zero-limit free-tier state (issue
 *    #732). This is checked FIRST and unconditionally on `reason`, whether or
 *    not the cooldown is still active — an EXPIRED no_quota cooldown must
 *    NOT fall through to SUSPECT or OK, since waiting never fixes it and a
 *    successful call (which would clear `reason`) hasn't happened.
 * 2. cooling && reason === 'spend_cap' — monthly spend cap, same rationale.
 * 3. cooling — ordinary short-lived rate-limit cooldown still active.
 * 4. consecutive429s >= 5 — cooldown expired but a long 429 streak preceded
 *    it with no successful call since; don't claim OK.
 * 5. otherwise — OK.
 */
export function formatQuotaLine(
  provider: string,
  state: QuotaProviderStateLike,
  now: number = Date.now(),
): string {
  const cooling = !!state.exhaustedUntil && state.exhaustedUntil > now;
  const consecutive = state.consecutive429s ?? 0;

  if (state.reason === 'no_quota') {
    const base = `  Quota: ${provider} — NO QUOTA on current plan (free-tier limit is 0 — enable billing; waiting will not fix this)`;
    return cooling ? base : `${base} — verify with a real call after enabling billing`;
  }
  if (cooling && state.reason === 'spend_cap') {
    // Monthly spend cap: a cooldown timer is meaningless to the user —
    // it only recovers when they raise the cap or the month rolls over.
    return `  Quota: ${provider} — EXHAUSTED (monthly spend cap — manage at https://ai.studio/spend)`;
  }
  if (cooling) {
    const cooldownSec = Math.ceil((state.exhaustedUntil! - now) / 1000);
    return `  Quota: ${provider} — EXHAUSTED (${cooldownSec}s cooldown)`;
  }
  if (consecutive >= 5) {
    // Cooldown expired but a long run of 429s preceded it and no
    // successful call has since reset the counter — do NOT claim OK.
    return `  Quota: ${provider} — SUSPECT (${consecutive} consecutive 429s before cooldown expiry — verify with a real call)`;
  }
  return `  Quota: ${provider} — OK`;
}
