/**
 * `gossipcat key` subcommand — store/list provider API keys from the PUBLISHED
 * binary, without needing the source-repo setup wizard.
 *
 * PURE + DI: all side effects (keychain access, secret prompt, output) are
 * injected via KeyCommandIO so the logic is trivially unit-testable and never
 * touches a real keychain in tests. Mirrors the keychain-doctor.ts DI style.
 *
 * SECURITY: the secret key value is NEVER echoed/logged. Confirmations name the
 * provider only. There is intentionally NO MCP tool for this — routing a secret
 * through the LLM tool layer would be a trust-boundary violation.
 */
import { KEY_REQUIRING_PROVIDERS } from '@gossip/orchestrator';

const VALID_PROVIDERS = /^[a-zA-Z0-9_-]{1,32}$/;

export interface KeyCommandIO {
  setKey(provider: string, key: string): Promise<void>;
  getKey(provider: string): Promise<string | null>;
  readSecret(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE =
  'Usage:\n' +
  '  gossipcat key set <provider>   Store an API key in the OS keychain (service: gossip-mesh)\n' +
  '  gossipcat key list             Show which providers have a stored key';

/** args = everything AFTER `key`. Returns exit code (0 ok, 2 usage/error). */
export async function runKeyCommand(args: string[], io: KeyCommandIO): Promise<number> {
  const sub = args[0];

  if (sub === 'set') {
    const provider = args[1];
    if (!provider) {
      io.err(USAGE);
      return 2;
    }
    // Validate BEFORE reading the secret so a bad provider never prompts.
    if (!VALID_PROVIDERS.test(provider)) {
      io.err(`invalid provider name "${provider}" (allowed: letters, digits, _ and -, 1-32 chars)`);
      return 2;
    }
    const key = (await io.readSecret()).trim();
    if (key.length === 0) {
      io.err('no key provided (stdin was empty)');
      return 2;
    }
    await io.setKey(provider, key);
    io.out(`stored key for "${provider}" in the gossip-mesh keychain`);
    return 0;
  }

  if (sub === 'list') {
    for (const provider of KEY_REQUIRING_PROVIDERS) {
      const value = await io.getKey(provider);
      const present = typeof value === 'string' && value.length > 0;
      io.out(`  ${present ? '✓' : '·'} ${provider}`);
    }
    return 0;
  }

  io.err(USAGE);
  return 2;
}
