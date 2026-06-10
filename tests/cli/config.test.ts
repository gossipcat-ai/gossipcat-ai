import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validateConfig, findConfigPath, configToAgentConfigs, loadClaudeSubagents, VALID_MAIN_PROVIDERS } from '../../apps/cli/src/config';
import { CREATE_PROVIDER_CASES } from '../../packages/orchestrator/src/llm-client';

describe('Config Validation', () => {
  it('accepts valid config', () => {
    const config = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: {
        arch: { provider: 'anthropic', model: 'claude', skills: ['typescript'] }
      }
    });
    expect(config.main_agent.provider).toBe('anthropic');
  });

  it('rejects missing main_agent', () => {
    expect(() => validateConfig({})).toThrow('main_agent');
  });

  it('rejects missing main_agent.provider', () => {
    expect(() => validateConfig({ main_agent: { model: 'x' } })).toThrow('provider');
  });

  it('rejects invalid provider', () => {
    expect(() => validateConfig({ main_agent: { provider: 'invalid', model: 'x' } })).toThrow('Invalid main_agent provider');
  });

  it('rejects agent with no skills', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'anthropic', model: 'claude', skills: [] } }
    })).toThrow('at least one skill');
  });

  it('accepts config without agents (main agent only)', () => {
    const config = validateConfig({ main_agent: { provider: 'anthropic', model: 'claude' } });
    expect(config.agents).toBeUndefined();
  });

  it('accepts utility_model with native provider and valid model', () => {
    const config = validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'haiku' },
    });
    expect(config.utility_model?.provider).toBe('native');
    expect(config.utility_model?.model).toBe('haiku');
  });

  it('accepts utility_model with native provider and fable tier', () => {
    const config = validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'fable' },
    });
    expect(config.utility_model?.provider).toBe('native');
    expect(config.utility_model?.model).toBe('fable');
  });

  it('rejects native utility_model with invalid model tier', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'native', model: 'gpt-4' },
    })).toThrow('native');
  });

  it('accepts utility_model with relay provider (existing behavior)', () => {
    const config = validateConfig({
      main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
      utility_model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
    });
    expect(config.utility_model?.provider).toBe('anthropic');
  });

  // Schema↔runtime alignment regression — VALID_PROVIDERS in config.ts must
  // accept every value the gossip_setup Zod enum accepts, otherwise some
  // values pass schema but fail validateConfig (or vice versa). The
  // documented zero-config token on Claude Code host is "none"; "native" is
  // valid only for utility_model and per-agent overrides (NOT main_agent).
  it('accepts main_provider "none" (Claude Code host zero-config)', () => {
    const config = validateConfig({
      main_agent: { provider: 'none', model: 'native' },
    });
    expect(config.main_agent.provider).toBe('none');
  });

  it('rejects main_provider "native" (regression: createProvider has no native branch)', () => {
    // 'native' as main_agent.provider would reach createProvider() in
    // packages/orchestrator/src/llm-client.ts which has no `case 'native'`,
    // throwing "Unknown provider: native" at boot. validateConfig must catch
    // this at config-load time. 'native' remains valid for utility_model and
    // per-agent overrides where the design supports it.
    expect(() => validateConfig({
      main_agent: { provider: 'native', model: 'sonnet' },
    })).toThrow('Invalid main_agent provider "native"');
  });

  it('accepts main_provider "local"', () => {
    const config = validateConfig({
      main_agent: { provider: 'local', model: 'llama3' },
    });
    expect(config.main_agent.provider).toBe('local');
  });

  // Parity check between schema (validateConfig) and runtime (createProvider).
  // Captures the original drift bug as a permanent regression test: every
  // provider that validateConfig accepts for main_agent MUST be a provider
  // that createProvider knows how to construct. If a future change adds a
  // provider to one list but not the other, this test fails immediately.
  it('main_agent providers form a subset of createProvider runtime cases', () => {
    // VALID_MAIN_PROVIDERS comes from apps/cli/src/config.ts (schema-side).
    // CREATE_PROVIDER_CASES comes from packages/orchestrator/src/llm-client.ts
    // (runtime-side, kept aligned with the createProvider switch). Importing
    // both ensures this test fails the moment either source-of-truth drifts —
    // no third hardcoded list to forget to update.
    for (const p of VALID_MAIN_PROVIDERS) {
      expect(CREATE_PROVIDER_CASES).toContain(p);
    }
    // And the schema must actually accept each one (smoke test).
    for (const p of VALID_MAIN_PROVIDERS) {
      const config = validateConfig({ main_agent: { provider: p, model: 'x' } });
      expect(config.main_agent.provider).toBe(p);
    }
  });
});

describe('configToAgentConfigs (issue #522 — base_url carry-through)', () => {
  it('carries base_url from config through to AgentConfig', () => {
    const config = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: {
        deepseek: {
          provider: 'openai',
          model: 'deepseek-chat',
          skills: ['typescript'],
          base_url: 'https://api.deepseek.com/v1',
        },
      },
    });
    const [ac] = configToAgentConfigs(config);
    expect(ac.id).toBe('deepseek');
    expect(ac.provider).toBe('openai');
    expect(ac.base_url).toBe('https://api.deepseek.com/v1');
  });

  it('leaves base_url undefined when not configured (defaults preserved)', () => {
    const config = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'] } },
    });
    const [ac] = configToAgentConfigs(config);
    expect(ac.base_url).toBeUndefined();
  });

  it('validateConfig accepts a valid https base_url', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], base_url: 'https://api.deepseek.com/v1' } },
    })).not.toThrow();
  });

  it('validateConfig rejects a non-http(s) base_url scheme', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], base_url: 'ftp://nope' } },
    })).toThrow('base_url must use http or https');
  });
});

describe('key_ref — per-agent keychain service (issue #522)', () => {
  let stderrSpy: jest.SpyInstance;
  beforeEach(() => {
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('configToAgentConfigs carries key_ref through to AgentConfig', () => {
    const config = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: {
        ds: { provider: 'deepseek', model: 'deepseek-chat', skills: ['typescript'], key_ref: 'deepseek' },
      },
    });
    const [ac] = configToAgentConfigs(config);
    expect(ac.key_ref).toBe('deepseek');
  });

  it('leaves key_ref undefined when not configured (byte-identical default)', () => {
    const config = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'] } },
    });
    const [ac] = configToAgentConfigs(config);
    expect(ac.key_ref).toBeUndefined();
  });

  it('accepts a valid custom key_ref service name', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: 'my-custom-key_1' } },
    })).not.toThrow();
  });

  it('rejects a key_ref that fails the service-name allowlist regex', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: 'has spaces!' } },
    })).toThrow('invalid key_ref');
  });

  it('rejects a key_ref longer than 32 chars (regex cap)', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: 'a'.repeat(33) } },
    })).toThrow('invalid key_ref');
  });

  it('does NOT echo the raw key_ref value in the throw (no secret leak)', () => {
    // If an operator pastes an actual API key (which fails the regex), the
    // error must mask it — never print the secret verbatim. #522 consensus a5953983.
    const secret = 'sk-proj-' + 'A1b2C3d4'.repeat(6); // realistic, fails the regex
    let msg = '';
    try {
      validateConfig({
        main_agent: { provider: 'anthropic', model: 'claude' },
        agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: secret } },
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('invalid key_ref');
    expect(msg).not.toContain(secret);
    expect(msg).toContain(`(${secret.length} chars)`); // masked form names the length only
  });

  it('WARNS (does not throw) when key_ref names a different well-known provider', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: 'anthropic' } },
    })).not.toThrow();
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(out).toMatch(/key_ref "anthropic" names a known provider/);
  });

  it('does NOT warn when key_ref equals the agent provider', () => {
    validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: 'openai' } },
    });
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(out).not.toMatch(/names a known provider/);
  });

  it('WARNS (does not throw) when key_ref looks like a secret (sk- prefix)', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'openai', model: 'gpt-4', skills: ['x'], key_ref: 'sk-abc123' } },
    })).not.toThrow();
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(out).toMatch(/looks like a secret/);
  });

  it('accepts provider:"deepseek" as a first-class provider', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude' },
      agents: { a: { provider: 'deepseek', model: 'deepseek-chat', skills: ['x'] } },
    })).not.toThrow();
  });

  it('accepts main_agent.provider:"deepseek"', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'deepseek', model: 'deepseek-chat' },
    })).not.toThrow();
  });
});

describe('findConfigPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no config files exist', () => {
    expect(findConfigPath(tmpDir)).toBeNull();
  });

  it('finds gossip.agents.json when present', () => {
    const filePath = join(tmpDir, 'gossip.agents.json');
    writeFileSync(filePath, '{}');
    expect(findConfigPath(tmpDir)).toBe(filePath);
  });

  it('prefers .gossip/config.json over gossip.agents.json', () => {
    const gossipDir = join(tmpDir, '.gossip');
    mkdirSync(gossipDir, { recursive: true });
    const preferredPath = join(gossipDir, 'config.json');
    writeFileSync(preferredPath, '{}');
    writeFileSync(join(tmpDir, 'gossip.agents.json'), '{}');
    expect(findConfigPath(tmpDir)).toBe(preferredPath);
  });

  it('falls back to gossip.agents.json when .gossip/config.json is absent', () => {
    const filePath = join(tmpDir, 'gossip.agents.json');
    writeFileSync(filePath, '{}');
    expect(findConfigPath(tmpDir)).toBe(filePath);
  });
});

describe('loadClaudeSubagents — fable tier allowlist', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `gossip-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, '.claude', 'agents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does NOT skip a .claude/agents/*.md with model: fable — loads as anthropic/claude-fable-5', () => {
    writeFileSync(
      join(tmpDir, '.claude', 'agents', 'fable-agent.md'),
      `---\nname: Fable Agent\nmodel: fable\ndescription: A fable-tier agent\n---\nYou are a fable agent.\n`,
    );
    const agents = loadClaudeSubagents(tmpDir);
    const fable = agents.find(a => a.name === 'Fable Agent');
    expect(fable).toBeDefined();
    expect(fable?.provider).toBe('anthropic');
    expect(fable?.model).toBe('claude-fable-5');
  });

  it('still skips an .md with a genuinely unknown model tier', () => {
    writeFileSync(
      join(tmpDir, '.claude', 'agents', 'bogus-agent.md'),
      `---\nname: Bogus Agent\nmodel: gpt-9\ndescription: unknown tier\n---\nbody\n`,
    );
    const agents = loadClaudeSubagents(tmpDir);
    expect(agents.find(a => a.name === 'Bogus Agent')).toBeUndefined();
  });
});

describe('maxToolTurns config plumbing (fix/per-agent-turn-cap)', () => {
  it('carries maxToolTurns through configToAgentConfigs', () => {
    const cfg = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { x: { provider: 'anthropic', model: 'claude-sonnet-4-6', skills: ['typescript'], maxToolTurns: 25 } },
    });
    const ac = configToAgentConfigs(cfg).find(a => a.id === 'x');
    expect(ac?.maxToolTurns).toBe(25);
  });

  it('rejects a non-integer / out-of-range maxToolTurns', () => {
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { x: { provider: 'anthropic', model: 'claude-sonnet-4-6', skills: ['typescript'], maxToolTurns: 0 } },
    })).toThrow(/maxToolTurns/);
    expect(() => validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { x: { provider: 'anthropic', model: 'claude-sonnet-4-6', skills: ['typescript'], maxToolTurns: 99 } },
    })).toThrow(/maxToolTurns/);
  });

  it('accepts a config with no maxToolTurns (default path)', () => {
    const cfg = validateConfig({
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { x: { provider: 'anthropic', model: 'claude-sonnet-4-6', skills: ['typescript'] } },
    });
    expect(configToAgentConfigs(cfg).find(a => a.id === 'x')?.maxToolTurns).toBeUndefined();
  });
});
