/**
 * key-command.test.ts — unit tests for the `gossipcat key` subcommand logic.
 *
 * runKeyCommand is pure + DI: all I/O (keychain, secret prompt, stdout/stderr)
 * is injected via a fake KeyCommandIO so these tests never touch a real OS
 * keychain or stdin. The load-bearing security property — the secret key value
 * must NEVER appear in any out()/err() line — is asserted explicitly.
 */

import { runKeyCommand, KeyCommandIO } from '../../apps/cli/src/key-command';

interface FakeIO extends KeyCommandIO {
  store: Map<string, string>;
  outLines: string[];
  errLines: string[];
  readSecretCalls: number;
}

function makeIO(opts: {
  secret?: string;
  seed?: Record<string, string>;
} = {}): FakeIO {
  const store = new Map<string, string>(Object.entries(opts.seed ?? {}));
  const outLines: string[] = [];
  const errLines: string[] = [];
  const io: FakeIO = {
    store,
    outLines,
    errLines,
    readSecretCalls: 0,
    async setKey(provider, key) { store.set(provider, key); },
    async getKey(provider) { return store.get(provider) ?? null; },
    async readSecret() { io.readSecretCalls++; return opts.secret ?? ''; },
    out(line) { outLines.push(line); },
    err(line) { errLines.push(line); },
  };
  return io;
}

/** Assert a secret value never leaked into any captured output line. */
function assertNoLeak(io: FakeIO, secret: string) {
  for (const line of [...io.outLines, ...io.errLines]) {
    expect(line).not.toContain(secret);
  }
}

describe('runKeyCommand', () => {
  describe('set', () => {
    it('stores a key and confirms by provider name only (no secret leak)', async () => {
      const secret = 'sk-realkey-abc123-do-not-print';
      const io = makeIO({ secret });
      const code = await runKeyCommand(['set', 'deepseek'], io);

      expect(code).toBe(0);
      expect(io.store.get('deepseek')).toBe(secret);
      expect(io.outLines.join('\n')).toContain('deepseek');
      assertNoLeak(io, secret);
    });

    it('returns 2 and does not store when the secret is empty/whitespace', async () => {
      const io = makeIO({ secret: '   \n\t ' });
      const code = await runKeyCommand(['set', 'deepseek'], io);

      expect(code).toBe(2);
      expect(io.store.has('deepseek')).toBe(false);
      expect(io.errLines.join('\n').toLowerCase()).toContain('empty');
    });

    it('returns 2 with usage when no provider is given', async () => {
      const io = makeIO({ secret: 'sk-whatever' });
      const code = await runKeyCommand(['set'], io);

      expect(code).toBe(2);
      expect(io.errLines.join('\n')).toContain('key set <provider>');
      // readSecret must not run without a provider
      expect(io.readSecretCalls).toBe(0);
    });

    it('rejects an invalid provider name BEFORE reading the secret', async () => {
      const io = makeIO({ secret: 'sk-should-never-be-read' });
      const code = await runKeyCommand(['set', 'bad/provider!'], io);

      expect(code).toBe(2);
      expect(io.readSecretCalls).toBe(0); // validation gates the prompt
      expect(io.errLines.join('\n').toLowerCase()).toContain('invalid');
      expect(io.store.has('bad/provider!')).toBe(false);
    });
  });

  describe('list', () => {
    it('marks present providers with ✓ and absent with ·, never printing values', async () => {
      const secret = 'sk-deepseek-secret-value';
      const io = makeIO({ seed: { deepseek: secret } });
      const code = await runKeyCommand(['list'], io);

      expect(code).toBe(0);
      const out = io.outLines.join('\n');
      expect(out).toMatch(/✓\s+deepseek/);
      expect(out).toMatch(/·\s+openai/);
      assertNoLeak(io, secret);
    });
  });

  describe('unknown', () => {
    it('returns 2 with usage for an unknown subcommand', async () => {
      const io = makeIO();
      const code = await runKeyCommand(['frobnicate'], io);

      expect(code).toBe(2);
      const err = io.errLines.join('\n');
      expect(err).toContain('key set <provider>');
      expect(err).toContain('key list');
    });

    it('returns 2 with usage when no subcommand is given', async () => {
      const io = makeIO();
      const code = await runKeyCommand([], io);

      expect(code).toBe(2);
      expect(io.errLines.join('\n')).toContain('key list');
    });
  });
});
