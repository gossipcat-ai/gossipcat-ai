import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from 'fs';
import { resolve, join, relative } from 'path';
import { execFileSync } from 'child_process';
import { AgentConfig, parseWorktreePorcelain, GIT_ENV } from '@gossip/orchestrator';

export interface GossipConfig {
  main_agent: {
    provider: string;
    model: string;
  };
  utility_model?: {
    provider: string;
    model: string;
  };
  /**
   * Sandbox enforcement level for write-mode tasks.
   * - "off":   no prompt sanitization, no post-task audit
   * - "warn":  sanitize prompts, run audit, record signals, but accept results
   * - "block": sanitize prompts, run audit, reject results from tasks that
   *            wrote outside their declared scope/worktree boundary
   * Default: "warn"
   */
  sandboxEnforcement?: 'off' | 'warn' | 'block';
  /**
   * Consensus-engine configuration. Issue #126 / PR-B.
   */
  consensus?: {
    /**
     * When true, ConsensusEngine calls `git worktree list -z --porcelain`
     * once per round() and merges all passing paths through
     * validateResolutionRoot alongside explicit resolutionRoots. Default
     * false (no behavior change for default installs).
     */
    autoDiscoverWorktrees?: boolean;
    /**
     * When false, the round-close open-findings auto-resolver is skipped.
     * Read directly in collect.ts; absent ⇒ enabled (default-on).
     */
    autoResolveOnRoundClose?: boolean;
    /**
     * Layer B opt-in (issue #437, spec 2026-06-09). Seeds the
     * GOSSIP_WORKTREE_AUTO_REVERT runtime-flag default on load; the env var
     * overrides (env → config → registry default '0'). When the effective flag
     * is OFF (the default), a detected isolation leak is preserved + reported
     * but NOT destructively reverted from the parent checkout.
     */
    worktreeAutoRevert?: boolean;
    /**
     * Layer A extra exclusions (issue #437, spec 2026-06-09). Operator-supplied
     * STRING globs matched against repo-relative dirty paths, UNIONED with the
     * built-in `.gossip/`/`.claude/` prefixes (which are never removable).
     * Wildcard-only (`**`/`*`) and traversal (`../`) entries are rejected by
     * validateConfig.
     */
    orchestratorOwnedGlobs?: string[];
    /**
     * Issue #520. Operator-declared external repo roots (and worktree `/*` globs)
     * that citations + scoped writes may resolve into. Each entry is absolute or
     * relative to the project root; a trailing `/*` expands to present subdirs.
     * Realpath'd + validated at load (resolveSiblingRoots). Default absent ⇒
     * single-repo installs unchanged. Declaring a root bypasses ONLY the
     * git-common-dir + worktree-list gates, never the other security gates.
     */
    siblingRoots?: string[];
    /**
     * Enable the line-anchored staleness heuristic in the findings resolver.
     * When true, a finding whose cited identifier is still present in the file
     * but NOT at the cited line (present_elsewhere) is auto-resolved as
     * `stale_anchor`. Default false (opt-in) per the rollout plan — do NOT
     * flip to true until the false-resolve safety brake is implemented.
     */
    resolverLineAnchored?: boolean;
  };
  agents?: Record<string, {
    provider: string;
    model: string;
    preset?: string;
    skills: string[];
    native?: boolean;
    /** Custom API base URL for OpenAI-compatible endpoints (e.g. DeepSeek).
     *  Validated in validateConfig; carried through configToAgentConfigs. #522 */
    base_url?: string;
    /** Keychain SERVICE NAME this agent resolves its API key from. Defaults to
     *  `provider` when omitted. A service NAME, never the key itself — the key
     *  stays in the OS keychain. Validated against /^[a-zA-Z0-9_-]{1,32}$/ in
     *  validateConfig; carried through configToAgentConfigs. #522 */
    key_ref?: string;
    /** Per-agent override for the WorkerAgent tool-turn budget (default 15). */
    maxToolTurns?: number;
  }>;
}

export function findConfigPath(projectRoot?: string): string | null {
  const root = projectRoot || process.cwd();
  const candidates = [
    resolve(root, '.gossip', 'config.json'),
    resolve(root, 'gossip.agents.json'),
    resolve(root, 'gossip.agents.yaml'),
    resolve(root, 'gossip.agents.yml'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadConfig(configPath: string): GossipConfig {
  const raw = readFileSync(configPath, 'utf-8');

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse config at ${configPath}. The gossipcat config file must be valid JSON (tried .gossip/config.json and gossip.agents.json legacy path).`);
  }

  return validateConfig(parsed);
}

// Keep this list aligned with the `main_provider` Zod enum in
// apps/cli/src/mcp-server-sdk.ts (around the gossip_setup tool definition).
// "none" is the documented zero-config token on Claude Code host — see the
// describe() string on the Zod enum and the `provider === 'none'` branch in
// the orchestrator-bootstrap path that prints "Native Claude Code orchestration
// enabled". Drift between these two lists means some values pass schema but
// fail validateConfig (or vice versa) — that is a hard-to-diagnose user-facing
// bug. If you change one, change the other.
export const VALID_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'openclaw', 'google', 'local', 'native', 'none'];

// Upper bound for per-agent maxToolTurns. Enforced both here (validateConfig,
// runtime load of .gossip/config.json) and in the gossip_setup Zod schema
// (apps/cli/src/mcp-server-sdk.ts) — import this constant in both so the two
// guards cannot drift apart.
export const MAX_TOOL_TURNS_CEILING = 100;

// Keychain SERVICE-NAME allowlist for `agent.key_ref`. Mirrors the
// VALID_PROVIDERS regex in apps/cli/src/keychain.ts:8 — a key_ref is read by
// Keychain.getKey(service) and MUST pass the same validateProvider gate, so a
// config that validates here can always be resolved by the keychain. A positive
// allowlist (NOT a blocklist of bad chars). #522.
const KEY_REF_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

// Well-known provider service names. A key_ref naming one of these that differs
// from the agent's own provider is very likely an operator typo (the agent would
// authenticate with the wrong key), so validateConfig WARNS — not a hard error,
// because a shared custom service name across providers is a legitimate use. #522
const WELL_KNOWN_KEY_SERVICES = ['anthropic', 'openai', 'deepseek', 'openclaw', 'google'];

// Subset for `main_agent.provider`: 'native' is excluded because the main
// agent must be able to invoke a real LLM (the orchestrator that dispatches
// other agents and runs lens/overlap detection). Several callsites
// (apps/cli/src/mcp-server-sdk.ts ~line 721 GossipPublisher init, and
// apps/cli/src/chat.ts ~line 158 LensGenerator init) call
// `createProvider(config.main_agent.provider, ...)` directly — and
// `createProvider` in packages/orchestrator/src/llm-client.ts has no
// `case 'native'`, so a config with `main_agent.provider: 'native'` would
// throw "Unknown provider: native" at boot. 'native' remains valid for
// `utility_model.provider` and `agents[*].provider` where it's design-correct.
export const VALID_MAIN_PROVIDERS = VALID_PROVIDERS.filter(p => p !== 'native');

const CLAUDE_MODEL_MAP: Record<string, { provider: string; model: string }> = {
  opus:   { provider: 'anthropic', model: 'claude-opus-4-6' },
  sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  haiku:  { provider: 'anthropic', model: 'claude-haiku-4-5' },
  fable:  { provider: 'anthropic', model: 'claude-fable-5' },
};

export function validateConfig(raw: any): GossipConfig {
  if (!raw.main_agent) throw new Error('Config missing "main_agent" field');
  if (!raw.main_agent.provider) throw new Error('Config missing "main_agent.provider"');
  if (!raw.main_agent.model) throw new Error('Config missing "main_agent.model"');

  if (!VALID_MAIN_PROVIDERS.includes(raw.main_agent.provider)) {
    throw new Error(
      `Invalid main_agent provider "${raw.main_agent.provider}". Must be one of: ${VALID_MAIN_PROVIDERS.join(', ')}. ` +
      `Note: 'native' is valid only for utility_model and per-agent overrides, not for main_agent.`
    );
  }

  if (raw.consensus !== undefined) {
    if (typeof raw.consensus !== 'object' || raw.consensus === null) {
      throw new Error('Config "consensus" must be an object');
    }
    if (
      raw.consensus.autoDiscoverWorktrees !== undefined &&
      typeof raw.consensus.autoDiscoverWorktrees !== 'boolean'
    ) {
      throw new Error('Config "consensus.autoDiscoverWorktrees" must be a boolean');
    }
    if (
      raw.consensus.autoResolveOnRoundClose !== undefined &&
      typeof raw.consensus.autoResolveOnRoundClose !== 'boolean'
    ) {
      throw new Error('Config "consensus.autoResolveOnRoundClose" must be a boolean');
    }
    if (
      raw.consensus.worktreeAutoRevert !== undefined &&
      typeof raw.consensus.worktreeAutoRevert !== 'boolean'
    ) {
      throw new Error('Config "consensus.worktreeAutoRevert" must be a boolean');
    }
    if (
      raw.consensus.resolverLineAnchored !== undefined &&
      typeof raw.consensus.resolverLineAnchored !== 'boolean'
    ) {
      throw new Error('Config "consensus.resolverLineAnchored" must be a boolean');
    }
    if (raw.consensus.orchestratorOwnedGlobs !== undefined) {
      const globs = raw.consensus.orchestratorOwnedGlobs;
      if (!Array.isArray(globs)) {
        throw new Error('Config "consensus.orchestratorOwnedGlobs" must be an array of strings');
      }
      for (const g of globs) {
        if (typeof g !== 'string' || g.length === 0) {
          throw new Error('Config "consensus.orchestratorOwnedGlobs" entries must be non-empty strings');
        }
        // Defense-in-depth on the pattern itself (spec §8.2 item 3): a
        // wildcard-only entry would suppress ALL detection; a `../` entry is a
        // traversal smell even though the match target is bounded to
        // repo-relative strings.
        if (g === '**' || g === '*') {
          throw new Error(
            `Config "consensus.orchestratorOwnedGlobs" entry "${g}" is wildcard-only and would suppress all isolation detection`,
          );
        }
        if (g.includes('../')) {
          throw new Error(
            `Config "consensus.orchestratorOwnedGlobs" entry "${g}" contains a traversal segment ("../") and is rejected`,
          );
        }
      }
    }
    if (raw.consensus.siblingRoots !== undefined) {
      const roots = raw.consensus.siblingRoots;
      if (!Array.isArray(roots)) {
        throw new Error('Config "consensus.siblingRoots" must be an array of strings');
      }
      for (const p of roots) {
        if (typeof p !== 'string' || p.length === 0) {
          throw new Error('Config "consensus.siblingRoots" entries must be non-empty strings');
        }
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f]/.test(p)) {
          throw new Error('Config "consensus.siblingRoots" entry contains a control character');
        }
        // A bare wildcard would declare "trust everything" — reject. A trailing
        // `/*` glob on a concrete parent is allowed and expanded at load.
        if (p === '*' || p === '**' || p === '/*') {
          throw new Error(`Config "consensus.siblingRoots" entry "${p}" is wildcard-only and would over-trust`);
        }
      }
    }
  }

  if (raw.sandboxEnforcement !== undefined) {
    const valid = ['off', 'warn', 'block'];
    if (!valid.includes(raw.sandboxEnforcement)) {
      throw new Error(
        `Invalid sandboxEnforcement "${raw.sandboxEnforcement}". Must be one of: ${valid.join(', ')}`
      );
    }
  }

  if (raw.utility_model) {
    if (!raw.utility_model.provider) throw new Error('Config "utility_model" missing provider');
    if (!raw.utility_model.model) throw new Error('Config "utility_model" missing model');
    if (!VALID_PROVIDERS.includes(raw.utility_model.provider)) {
      throw new Error(
        `Invalid utility_model provider "${raw.utility_model.provider}". Must be one of: ${VALID_PROVIDERS.join(', ')}`
      );
    }
    if (raw.utility_model.provider === 'native') {
      const validNativeModels = Object.keys(CLAUDE_MODEL_MAP);
      if (!validNativeModels.includes(raw.utility_model.model)) {
        throw new Error(
          `Invalid native utility_model model "${raw.utility_model.model}". Must be one of: ${validNativeModels.join(', ')}`
        );
      }
    }
  }

  if (raw.agents) {
    for (const [id, agent] of Object.entries(raw.agents as Record<string, any>)) {
      if (!agent.provider) throw new Error(`Agent "${id}" missing provider`);
      if (!VALID_PROVIDERS.includes(agent.provider)) {
        throw new Error(`Agent "${id}" has invalid provider "${agent.provider}"`);
      }
      if (!agent.skills || !Array.isArray(agent.skills) || agent.skills.length === 0) {
        throw new Error(`Agent "${id}" must have at least one skill`);
      }
      if (agent.base_url) {
        try {
          const { protocol } = new URL(agent.base_url);
          if (protocol !== 'http:' && protocol !== 'https:') {
            throw new Error(`Agent "${id}" base_url must use http or https scheme`);
          }
        } catch (e: any) {
          if (e.message.includes(id)) throw e;
          throw new Error(`Agent "${id}" has invalid base_url: ${agent.base_url}`);
        }
      }
      // #522: key_ref is a keychain SERVICE NAME, never a key. It must pass the
      // same allowlist the keychain enforces on reads, so a validated config is
      // always resolvable. Two non-fatal warnings catch common operator mistakes.
      if (agent.key_ref !== undefined) {
        if (typeof agent.key_ref !== 'string' || !KEY_REF_PATTERN.test(agent.key_ref)) {
          // Do NOT echo the raw value: if an operator pasted an actual API key
          // (which fails the pattern), printing it verbatim would leak the
          // secret into logs / crash reporters. Show only a short masked prefix.
          const masked =
            typeof agent.key_ref === 'string' ? `${agent.key_ref.slice(0, 4)}…(${agent.key_ref.length} chars)` : typeof agent.key_ref;
          throw new Error(
            `Agent "${id}" has invalid key_ref [${masked}]. A key_ref is a keychain ` +
            `service NAME and must match /^[a-zA-Z0-9_-]{1,32}$/ (never the key itself).`
          );
        }
        // Cross-provider WARNING: a key_ref that names a different well-known
        // provider than the agent's own is probably a typo — the agent would
        // read the wrong key. Legitimate for a shared custom service, hence warn.
        if (
          WELL_KNOWN_KEY_SERVICES.includes(agent.key_ref) &&
          agent.key_ref !== agent.provider
        ) {
          process.stderr.write(
            `[gossipcat] warning: agent "${id}" key_ref "${agent.key_ref}" names a known ` +
            `provider different from its provider "${agent.provider}" — it will authenticate ` +
            `with the "${agent.key_ref}" keychain key. Set key_ref to "${agent.provider}" if unintended.\n`
          );
        }
        // Secret-looking WARNING: catches an operator pasting the raw key into
        // the service-name field. (The regex above already blocks spaces and
        // 'sk-...' lengths >32, but warn on the borderline cases that pass it.)
        if (
          agent.key_ref.length > 40 ||
          /\s/.test(agent.key_ref) ||
          agent.key_ref.startsWith('sk-')
        ) {
          process.stderr.write(
            `[gossipcat] warning: agent "${id}" key_ref looks like a secret, not a service ` +
            `name. key_ref must be a keychain SERVICE NAME; store the key via the keychain ` +
            `and reference its service name here.\n`
          );
        }
      }
      // Per-agent tool-turn budget override. Optional; when present must be a
      // positive integer within a sane bound (a runaway cap wastes quota).
      if (agent.maxToolTurns !== undefined) {
        const n = agent.maxToolTurns;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_TOOL_TURNS_CEILING) {
          throw new Error(`Agent "${id}" has invalid maxToolTurns (${JSON.stringify(n)}); must be an integer in [1, ${MAX_TOOL_TURNS_CEILING}]`);
        }
      }
    }
  }

  return raw as GossipConfig;
}

/**
 * #520. Resolve `consensus.siblingRoots` into canonical absolute directory paths:
 * expand trailing `/*` globs against the on-disk parent, then validate each entry
 * (exists, is a directory, realpath, ownership) FAIL-FAST — a bad entry throws at
 * boot, never a silent drop. Returns [] when no siblingRoots are configured.
 */
export function resolveSiblingRoots(config: GossipConfig, projectRoot: string): string[] {
  const declared = config.consensus?.siblingRoots ?? [];
  if (declared.length === 0) return [];
  const out: string[] = [];
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const validateDir = (abs: string): string => {
    let st;
    try { st = statSync(abs); } catch (e) {
      throw new Error(`Config "consensus.siblingRoots": "${abs}" does not resolve to directory: ${(e as Error).message}`);
    }
    if (!st.isDirectory()) throw new Error(`Config "consensus.siblingRoots": "${abs}" is not a directory`);
    if (uid != null && st.uid !== uid) {
      throw new Error(`Config "consensus.siblingRoots": "${abs}" owner uid mismatch (file=${st.uid}, current=${uid})`);
    }
    try { return realpathSync(abs); } catch (e) {
      throw new Error(`Config "consensus.siblingRoots": realpath failed for "${abs}": ${(e as Error).message}`);
    }
  };
  let rootReal = projectRoot;
  try { rootReal = realpathSync(projectRoot); } catch { /* keep */ }
  const isInsideProject = (abs: string): boolean => {
    const rel = relative(rootReal, abs);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
  };
  // v2 (#520): enumerate a declared repo's real worktree checkouts from git so
  // path-carrying cites resolve regardless of where `git worktree add` put the
  // tree. Fail-soft: a non-git dir / git absent / parse error yields [] (the
  // declared root itself is still a valid root). The returned paths are realpath'd
  // by parseWorktreePorcelain; each is independently validateDir-gated by the caller.
  const enumerateWorktrees = (repoRoot: string): string[] => {
    try {
      // Harden git: neutralize global/system config (GIT_ENV, shared with
      // validateResolutionRoot) AND clear any inherited GIT_DIR/GIT_WORK_TREE so
      // `git -C <repoRoot>` enumerates the declared sibling, not an outer repo
      // (consensus f65b8bc3 deepseek:f1 + sonnet:f13).
      const env: Record<string, string | undefined> = { ...process.env, ...GIT_ENV };
      delete env.GIT_DIR;
      delete env.GIT_WORK_TREE;
      const stdout = execFileSync('git', ['-C', repoRoot, 'worktree', 'list', '-z', '--porcelain'], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'ignore'], env,
      });
      return parseWorktreePorcelain(stdout, { includeLocked: true });
    } catch {
      return [];
    }
  };
  for (const entry of declared) {
    if (entry.endsWith('/*')) {
      // Validate the glob parent (stat + isDirectory + uid + realpath) before
      // listing it — the children are individually validateDir'd below, but the
      // parent itself must pass the same ownership/realpath gate so a swapped
      // symlink parent can't redirect the listing (consensus 318a16c1, sonnet:f16).
      const parentReal = validateDir(resolve(projectRoot, entry.slice(0, -2)));
      let names: string[];
      try { names = readdirSync(parentReal); } catch (e) {
        throw new Error(`Config "consensus.siblingRoots": glob parent "${parentReal}" not readable: ${(e as Error).message}`);
      }
      for (const name of names) {
        const childAbs = join(parentReal, name);
        let childStat;
        try { childStat = statSync(childAbs); } catch { continue; } // broken symlink / vanished entry — skip, don't crash boot
        if (childStat.isDirectory()) {
          const canonical = validateDir(childAbs);
          if (isInsideProject(canonical)) {
            throw new Error(`Config "consensus.siblingRoots": "${canonical}" is inside the project root — siblingRoots are for EXTERNAL repos; use a normal scope instead`);
          }
          out.push(canonical);
        }
      }
    } else {
      const canonical = validateDir(resolve(projectRoot, entry));
      if (isInsideProject(canonical)) {
        throw new Error(`Config "consensus.siblingRoots": "${canonical}" is inside the project root — siblingRoots are for EXTERNAL repos; use a normal scope instead`);
      }
      out.push(canonical);
      // v2: also admit the declared repo's checked-out worktrees (primary path).
      for (const wt of enumerateWorktrees(canonical)) {
        let wtCanonical: string;
        try { wtCanonical = validateDir(wt); } catch { continue; } // vanished / uid-mismatch → skip, don't fail boot
        if (isInsideProject(wtCanonical)) continue; // worktrees inside projectRoot are not external siblings — skip
        out.push(wtCanonical);
      }
    }
  }
  return [...new Set(out)]; // dedup by canonical path (parseWorktreePorcelain + validateDir both realpath)
}

export function configToAgentConfigs(config: GossipConfig): AgentConfig[] {
  return Object.entries(config.agents || {}).map(([id, agent]) => ({
    id,
    provider: agent.provider as AgentConfig['provider'],
    model: agent.model,
    preset: agent.preset,
    skills: agent.skills,
    native: agent.native,
    // #522: carry base_url through so DeepSeek / OpenAI-compatible agents reach
    // their configured endpoint instead of defaulting to api.openai.com.
    base_url: agent.base_url,
    // #522: carry the keychain service name through so the resolver reads the
    // per-agent key (key_ref ?? provider) at both resolution sites.
    key_ref: agent.key_ref,
    maxToolTurns: agent.maxToolTurns,
  }));
}

// ── Claude Code subagent loading ─────────────────────────────────────────

export interface ClaudeSubagent {
  id: string;
  name: string;
  provider: string;
  model: string;
  description: string;
  instructions: string;
  source: string; // file path
}

/**
 * Load Claude Code subagent definitions from .claude/agents/*.md.
 * Returns agent configs + full instructions for each.
 * Skips agents whose IDs already exist in `existingIds` to avoid duplicates.
 */
export function loadClaudeSubagents(projectRoot?: string, existingIds?: Set<string>): ClaudeSubagent[] {
  const root = projectRoot || process.cwd();
  const agentsDir = join(root, '.claude', 'agents');

  if (!existsSync(agentsDir)) return [];

  let files: string[];
  try {
    files = readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }

  const agents: ClaudeSubagent[] = [];
  for (const file of files) {
    const filePath = join(agentsDir, file);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter) continue;

      const fm = frontmatter[1];
      const name = fm.match(/^name:\s*(.+)/m)?.[1]?.trim();
      const modelKey = fm.match(/^model:\s*(.+)/m)?.[1]?.trim()?.toLowerCase();
      const description = fm.match(/^description:\s*(.+)/m)?.[1]?.trim() || '';

      if (!name || !modelKey) continue;

      const mapped = CLAUDE_MODEL_MAP[modelKey];
      if (!mapped) {
        process.stderr.write(`[gossipcat] Skipping .claude/agents/${file}: unknown model "${modelKey}" (expected: opus, sonnet, haiku, fable)\n`);
        continue;
      }

      const id = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
      if (existingIds?.has(id)) continue;

      // Instructions = everything after the frontmatter
      const instructions = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();

      agents.push({
        id,
        name,
        provider: mapped.provider,
        model: mapped.model,
        description,
        instructions,
        source: filePath,
      });
    } catch {
      // Skip unreadable files
    }
  }

  return agents;
}

/** Convert Claude subagents to gossipcat AgentConfig format */
export function claudeSubagentsToConfigs(subagents: ClaudeSubagent[]): AgentConfig[] {
  return subagents.map(sa => ({
    id: sa.id,
    provider: sa.provider as AgentConfig['provider'],
    model: sa.model,
    role: sa.description || sa.name,
    skills: inferSkills(sa.description, sa.name),
    native: true,
  }));
}

export function inferSkills(description: string, name: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const skills: string[] = [];
  if (/prompt|llm|ai|agent/.test(text)) skills.push('prompt_engineering');
  if (/security|vulnerab|owasp/.test(text)) skills.push('security_audit');
  if (/review|audit|code quality/.test(text)) skills.push('code_review');
  if (/test|qa/.test(text)) skills.push('testing');
  if (/typescript|ts\b/.test(text)) skills.push('typescript');
  if (/react|frontend|ui/.test(text)) skills.push('frontend');
  if (/backend|api|server/.test(text)) skills.push('backend');
  if (/architect/.test(text)) skills.push('architecture');
  // Always add a general skill
  if (skills.length === 0) skills.push('general');
  return skills;
}
