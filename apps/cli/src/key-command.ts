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
import type { KeyStoreInfo, KeyStoreKind } from './keychain';

const VALID_PROVIDERS = /^[a-zA-Z0-9_-]{1,32}$/;

export interface KeyCommandIO {
  /** Resolves to the store the key ACTUALLY landed in (keychain writes can fall back to file). */
  setKey(provider: string, key: string): Promise<KeyStoreKind>;
  getKey(provider: string): Promise<string | null>;
  /** Which store this invocation resolved to — reported to the operator, never guessed. */
  storeInfo(): KeyStoreInfo;
  readSecret(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

const USAGE =
  'Usage:\n' +
  '  gossipcat key set <provider>   Store an API key (OS keychain when available, else encrypted file)\n' +
  '  gossipcat key list             Show the resolved store and which providers have a stored key';

/**
 * Human-readable destination for a given store kind. The file case always names
 * the ABSOLUTE path so a relay-vs-CLI cwd mismatch is visible at a glance.
 */
function describeStore(kind: KeyStoreKind, info: KeyStoreInfo): string {
  return kind === 'keychain' ? `keychain (service ${info.service})` : `file ${info.path}`;
}

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
    // Report the destination setKey actually used — a failed keychain write
    // falls back to the encrypted file, and claiming "keychain" there is a lie.
    const written = await io.setKey(provider, key);
    io.out(`stored key for "${provider}" in ${describeStore(written, io.storeInfo())}`);
    return 0;
  }

  if (sub === 'list') {
    const info = io.storeInfo();
    io.out(
      info.kind === 'keychain'
        ? `(store: keychain  service ${info.service})`
        : `(store: file  ${info.path})`,
    );
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
