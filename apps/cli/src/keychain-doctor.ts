/**
 * Keychain doctor — detects stale/placeholder API-key entries that may linger
 * in a user's real keychain (e.g. from an OLD test that wrote test placeholders
 * to the real 'gossip-mesh' service). Pure + dependency-light: it receives a
 * getKey accessor so it is backend-agnostic and trivially unit-testable.
 */

export interface KeychainDoctorWarning {
  service: string;
  reason: string;
  redactedValue: string;
}

const KNOWN_PLACEHOLDERS = new Set([
  'okey-xyz',
  'gkey-abc',
  'test-key-123',
  'old-key',
  'new-key',
  'gossip-mesh-test',
]);

const MIN_PLAUSIBLE_LENGTH = 16;

/** Show at most the first 4 chars, never the full secret. */
function redact(value: string): string {
  if (value.length === 0) return '<empty>';
  if (value.length <= 4) return '<short>';
  return `${value.slice(0, 4)}…`;
}

function staleReason(value: string): string | null {
  if (KNOWN_PLACEHOLDERS.has(value) || value.startsWith('test-')) {
    return 'matches known test placeholder';
  }
  if (value.length < MIN_PLAUSIBLE_LENGTH) {
    return `implausibly short (${value.length} chars) for a real key`;
  }
  return null;
}

export async function detectStaleKeychainEntries(
  getKey: (service: string) => Promise<string | null>,
  services: string[],
): Promise<KeychainDoctorWarning[]> {
  const warnings: KeychainDoctorWarning[] = [];
  for (const service of services) {
    const value = await getKey(service);
    if (value == null || value.length === 0) continue; // missing keys handled elsewhere
    const reason = staleReason(value);
    if (reason) {
      warnings.push({ service, reason, redactedValue: redact(value) });
    }
  }
  return warnings;
}
