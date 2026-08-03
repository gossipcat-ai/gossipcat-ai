/**
 * gossip_setup transactionality + config preservation + status resilience.
 *
 * Covers consensus 6eed37aa-dfba43ca findings:
 *  - f15 (MEDIUM): validateConfig must run BEFORE any native .claude/agents/<id>.md
 *    file is written, so a validation failure leaves no orphan phantom-subagent
 *    files and does not block re-registering the id as custom.
 *  - f16 (MEDIUM): the rebuilt config must preserve unknown top-level fields
 *    (consensus.siblingRoots, utility_model, autoDiscoverWorktrees, …) across a
 *    re-run in BOTH merge and replace modes.
 *  - f19 (LOW): gossip_status must not throw when .gossip/config.json is
 *    malformed — it renders a fix hint instead.
 *
 * The merge/preservation logic and the status fix-hint are tested as pure
 * functions (mergeSetupConfig / buildMalformedConfigHint), mirroring the
 * setup-response.test.ts precedent. The f15 ordering invariant — which is
 * inline in the giant gossip_setup handler — is guarded by source inspection,
 * the same technique used by install-packaging.test.ts for postinstall.js.
 */
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import {
  mergeSetupConfig,
  resolveMainAgent,
  buildMalformedConfigHint,
  flushStagedAgentFileWrites,
} from '../../apps/cli/src/setup-response';
import { validateConfig } from '../../apps/cli/src/config';

const PROJECT_ROOT = resolve(__dirname, '..', '..');

describe('mergeSetupConfig — top-level field preservation (f16)', () => {
  const mainAgent = { provider: 'anthropic', model: 'claude-opus-4-6' };

  it('preserves consensus.siblingRoots and utility_model in merge mode', () => {
    const existingConfig = {
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { 'old-agent': { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      consensus: { siblingRoots: ['../sibling-repo'] },
      utility_model: { provider: 'native', model: 'haiku' },
      autoDiscoverWorktrees: true,
    };
    const merged = mergeSetupConfig({
      existingConfig,
      mainAgent,
      existingAgents: existingConfig.agents,
      newAgents: { 'new-agent': { provider: 'anthropic', model: 'claude-sonnet-4-6' } },
    }) as typeof existingConfig & { agents: Record<string, unknown> };

    // Unknown/other top-level fields survive untouched.
    expect(merged.consensus).toEqual({ siblingRoots: ['../sibling-repo'] });
    expect(merged.utility_model).toEqual({ provider: 'native', model: 'haiku' });
    expect(merged.autoDiscoverWorktrees).toBe(true);
    // main_agent is overwritten from the request.
    expect(merged.main_agent).toEqual(mainAgent);
    // merge keeps the prior agent AND adds the new one.
    expect(Object.keys(merged.agents).sort()).toEqual(['new-agent', 'old-agent']);
  });

  it('preserves unrelated top-level fields in replace mode (empty existingAgents)', () => {
    const existingConfig = {
      main_agent: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      agents: { 'old-agent': { provider: 'anthropic', model: 'claude-haiku-4-5' } },
      consensus: { siblingRoots: ['../sibling-repo'], autoResolveOnRoundClose: true },
      orchestratorOwnedGlobs: ['.gossip/**'],
    };
    // replace mode passes existingAgents: {} (team replaced) but keeps the
    // existingConfig spread for other top-level fields.
    const merged = mergeSetupConfig({
      existingConfig,
      mainAgent,
      existingAgents: {},
      newAgents: { 'fresh-agent': { provider: 'anthropic', model: 'claude-opus-4-6' } },
    }) as typeof existingConfig & { agents: Record<string, unknown> };

    // The team is replaced — old agent is gone, only the fresh one remains.
    expect(Object.keys(merged.agents)).toEqual(['fresh-agent']);
    // Other top-level fields are still preserved in replace mode.
    expect(merged.consensus).toEqual({ siblingRoots: ['../sibling-repo'], autoResolveOnRoundClose: true });
    expect(merged.orchestratorOwnedGlobs).toEqual(['.gossip/**']);
  });

  it('produces a config that validateConfig accepts when inputs are valid', () => {
    const merged = mergeSetupConfig({
      existingConfig: { consensus: { siblingRoots: ['../x'] } },
      mainAgent,
      existingAgents: {},
      newAgents: {},
    });
    expect(() => validateConfig(merged)).not.toThrow();
  });
});

describe('resolveMainAgent — orchestrator preservation (#724)', () => {
  const existingNone = { main_agent: { provider: 'none', model: 'none' }, agents: {} };
  const existingAnthropic = { main_agent: { provider: 'anthropic', model: 'claude-opus-4-6' }, agents: {} };

  it('lets an explicit provider+model pair win over the existing config', () => {
    expect(resolveMainAgent({ provider: 'openai', model: 'gpt-4o' }, existingAnthropic))
      .toEqual({ provider: 'openai', model: 'gpt-4o' });
  });

  it('preserves the existing main_agent when both fields are omitted', () => {
    // The #724 regression: an omitted main_provider used to reset a deliberate
    // provider:"none" (native orchestration) back to google/gemini-2.5-pro.
    expect(resolveMainAgent({}, existingNone)).toEqual({ provider: 'none', model: 'none' });
    expect(resolveMainAgent({}, existingAnthropic)).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
  });

  it('preserves the existing main_agent in replace mode too', () => {
    // replace mode replaces the team, not the orchestrator choice — the handler
    // passes the same existingConfig in both modes (only existingAgents is
    // mode-gated), so preservation is mode-independent by construction.
    const replaceModeConfig = { ...existingAnthropic, agents: {} };
    expect(resolveMainAgent({}, replaceModeConfig)).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
  });

  it('defaults to none/none on a fresh setup with nothing to preserve', () => {
    expect(resolveMainAgent({}, {})).toEqual({ provider: 'none', model: 'none' });
    expect(resolveMainAgent({}, undefined)).toEqual({ provider: 'none', model: 'none' });
  });

  it('never resolves to the old hardcoded google/gemini-2.5-pro default', () => {
    for (const existing of [{}, existingNone, existingAnthropic]) {
      const resolved = resolveMainAgent({}, existing);
      expect(resolved.provider).not.toBe('google');
      expect(resolved.model).not.toBe('gemini-2.5-pro');
    }
  });

  it('ignores a malformed or invalid-provider main_agent and falls back to none/none', () => {
    // A corrupt orchestrator entry must not be preserved — otherwise gossip_setup
    // could never repair a config whose provider validateConfig rejects.
    expect(resolveMainAgent({}, { main_agent: { provider: 'native', model: 'sonnet' } }))
      .toEqual({ provider: 'none', model: 'none' });
    expect(resolveMainAgent({}, { main_agent: { provider: 'anthropic' } }))
      .toEqual({ provider: 'none', model: 'none' });
    expect(resolveMainAgent({}, { main_agent: 'anthropic/claude-opus-4-6' }))
      .toEqual({ provider: 'none', model: 'none' });
  });

  it('ignores a lone main_model and keeps the preserved pair, with a warning', () => {
    const resolved = resolveMainAgent({ model: 'gpt-4o' }, existingAnthropic);
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-opus-4-6');
    expect(resolved.warning).toContain('main_provider must be passed explicitly');
  });

  it('honors a lone main_provider when the preserved entry already uses it', () => {
    const resolved = resolveMainAgent({ provider: 'anthropic' }, existingAnthropic);
    expect(resolved).toEqual({ provider: 'anthropic', model: 'claude-opus-4-6' });
  });

  it('honors a lone main_provider "none" (its model is "none")', () => {
    expect(resolveMainAgent({ provider: 'none' }, existingAnthropic))
      .toEqual({ provider: 'none', model: 'none' });
  });

  it('refuses to guess a model when a lone main_provider switches provider', () => {
    const resolved = resolveMainAgent({ provider: 'openai' }, existingAnthropic);
    // No provider/model mismatch is written — the preserved pair is kept.
    expect(resolved.provider).toBe('anthropic');
    expect(resolved.model).toBe('claude-opus-4-6');
    expect(resolved.warning).toContain('main_model is required');
  });

  it('produces a config that validateConfig accepts for every resolution branch', () => {
    const cases = [
      resolveMainAgent({ provider: 'openai', model: 'gpt-4o' }, existingAnthropic),
      resolveMainAgent({}, existingAnthropic),
      resolveMainAgent({}, {}),
      resolveMainAgent({ model: 'gpt-4o' }, {}),
    ];
    for (const mainAgent of cases) {
      const merged = mergeSetupConfig({
        existingConfig: {},
        mainAgent: { provider: mainAgent.provider, model: mainAgent.model },
        existingAgents: {},
        newAgents: {},
      });
      expect(() => validateConfig(merged)).not.toThrow();
    }
  });
});

describe('gossip_setup schema — no hardcoded orchestrator default (#724)', () => {
  it('declares main_provider/main_model optional, not defaulted to google', () => {
    const source = readFileSync(resolve(PROJECT_ROOT, 'apps', 'cli', 'src', 'mcp-server-sdk.ts'), 'utf-8');
    expect(source).not.toContain(".default('google')");
    expect(source).not.toContain(".default('gemini-2.5-pro')");
    expect(source).toMatch(/main_provider: z\.enum\(MCP_MAIN_PROVIDER_ENUM\)\.optional\(\)/);
    expect(source).toMatch(/main_model: z\.string\(\)\.optional\(\)/);
    // The handler must route the request through the resolver, not straight
    // into mergeSetupConfig.
    expect(source).toContain('resolveMainAgent(');
    expect(source).not.toMatch(/mainAgent: \{ provider: main_provider, model: main_model \}/);
  });
});

describe('buildMalformedConfigHint — status resilience (f19)', () => {
  it('renders a fix-or-delete hint with the path and parse message', () => {
    const hint = buildMalformedConfigHint('/proj/.gossip/config.json', 'Unexpected token } in JSON');
    expect(hint).toContain('config.json is malformed');
    expect(hint).toContain('Unexpected token } in JSON');
    expect(hint).toContain('fix or delete /proj/.gossip/config.json');
  });
});

describe('gossip_setup handler — validate-before-write ordering (f15)', () => {
  let source: string;

  beforeAll(() => {
    source = readFileSync(resolve(PROJECT_ROOT, 'apps', 'cli', 'src', 'mcp-server-sdk.ts'), 'utf-8');
  });

  it('does not writeFileSync the native .md inside the agent loop', () => {
    // The loop must STAGE writes (pendingAgentFileWrites), not perform them. A
    // direct writeFileSync of `${agent.id}.md` inside the loop would re-introduce
    // the orphan-file leak on a validation failure.
    expect(source).toContain('pendingAgentFileWrites');
    // No writeFileSync of an `<id>.md` agent file may appear with the loop's
    // per-agent `${agent.id}.md` template — those are flushed post-validation.
    // (Matches the handler's actual inline-path shape, not a variable name.)
    expect(source).not.toMatch(/writeFileSync\(join\(root, '\.claude', 'agents', `\$\{agent\.id\}\.md`\)/);
  });

  it('stages custom-agent instructions.md instead of writing it in the loop (v2)', () => {
    // loop-transactionality v2: the custom branch must NOT writeFileSync
    // instructions.md inline — a validation failure would otherwise leave an
    // orphan .gossip/agents/<id>/instructions.md while config.json was never
    // written. It must push onto the staged array instead.
    expect(source).not.toMatch(/writeFileSync\(join\(instrDir, 'instructions\.md'\)/);
    // The instrDir write must be staged via pendingAgentFileWrites.
    const instrIdx = source.indexOf("join(instrDir, 'instructions.md')");
    expect(instrIdx).toBeGreaterThan(-1);
    const stageIdx = source.lastIndexOf('pendingAgentFileWrites.push', instrIdx + 200);
    expect(stageIdx).toBeGreaterThan(-1);
    expect(stageIdx).toBeLessThan(instrIdx);
  });

  it('flushes staged agent file writes only after validateConfig succeeds', () => {
    // Ordering guarantee: validateConfig(config) must appear in the source
    // BEFORE the flushStagedAgentFileWrites call. If validation fails it returns
    // early, so the flush never runs and no orphan file is written.
    const validateIdx = source.indexOf('validateConfig(config)');
    const flushIdx = source.indexOf('flushStagedAgentFileWrites(pendingAgentFileWrites');
    expect(validateIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(validateIdx);
  });

  it('guards the gossip_status agent-list loadConfig in try/catch (f19)', () => {
    // loadConfig in the agent-list section must be wrapped so a malformed
    // config.json renders buildMalformedConfigHint instead of throwing the
    // whole status tool.
    expect(source).toMatch(/try\s*{[\s\S]*?loadConfig\(configPath\)[\s\S]*?}\s*catch[\s\S]*?buildMalformedConfigHint/);
  });
});

describe('flushStagedAgentFileWrites — staged custom instructions.md (v2)', () => {
  const realFs = require('fs') as {
    mkdirSync: (dir: string, opts: { recursive: boolean }) => void;
    writeFileSync: (path: string, content: string, enc: 'utf-8') => void;
  };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gossip-setup-v2-'));
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
  });

  // Mirrors the handler's actual sequence: validateConfig, early-return on
  // throw, flushStagedAgentFileWrites only on success. Driving the staged
  // array through this REAL guard (not just asserting validateConfig throws)
  // is what makes the disk assertions meaningful.
  function validateThenFlush(
    config: unknown,
    staged: Array<{ dir: string; path: string; content: string }>,
  ): boolean {
    try {
      validateConfig(config as never);
    } catch {
      return false; // handler early-returns — flush never runs
    }
    flushStagedAgentFileWrites(staged, realFs);
    return true;
  }

  it('leaves NO instructions.md on disk when validateConfig fails (flush never runs)', () => {
    const instrDir = join(tmpDir, '.gossip', 'agents', 'custom-x');
    const instrPath = join(instrDir, 'instructions.md');
    const staged = [{ dir: instrDir, path: instrPath, content: 'You are custom-x.' }];

    // A config missing main_agent is rejected by validateConfig, so the flush
    // is never reached — even though the write was staged.
    const flushed = validateThenFlush({ agents: {} }, staged);

    expect(flushed).toBe(false);
    expect(existsSync(instrPath)).toBe(false);
    expect(existsSync(instrDir)).toBe(false);
  });

  it('writes the custom instructions.md (mkdir-ing its dir) on the success path', () => {
    const instrDir = join(tmpDir, '.gossip', 'agents', 'custom-y');
    const instrPath = join(instrDir, 'instructions.md');
    const mdDir = join(tmpDir, '.claude', 'agents');
    const mdPath = join(mdDir, 'native-z.md');

    flushStagedAgentFileWrites(
      [
        { dir: mdDir, path: mdPath, content: '---\nname: native-z\n---\nbody' },
        { dir: instrDir, path: instrPath, content: 'You are custom-y.' },
      ],
      realFs,
    );

    expect(existsSync(instrPath)).toBe(true);
    expect(readFileSync(instrPath, 'utf-8')).toBe('You are custom-y.');
    expect(existsSync(mdPath)).toBe(true);
  });
});
