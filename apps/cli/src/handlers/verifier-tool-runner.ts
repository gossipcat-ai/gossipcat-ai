/**
 * Verifier tool execution for consensus Phase-2 cross-review.
 *
 * Extracted from the inline closure in `collect.ts` so the rooting behavior is
 * unit-testable (issue #710). Phase-1 relay dispatch already anchors agents at
 * `resolutionRoots[0]` via `toolServer.assignRoot` (PR #328); Phase 2 did not,
 * so cross-reviewers read the repo root while the findings under review
 * described a sibling review worktree — producing confident-but-wrong
 * refutations ("symbol does not exist", "file only has N lines").
 *
 * When `effectiveRoots` is empty every code path here is byte-identical to the
 * pre-#710 behavior.
 */
import { FileTools, GitTools, Sandbox, formatSkillNotFound, formatSkillPayload, recordSkillPull } from '@gossip/tools';
import { resolveServableSkill } from '@gossip/orchestrator';
import type { MemorySearcher, SkillQueryResult } from '@gossip/orchestrator';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type VerifierToolRunner = (
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * Per-reviewer, per-round cap on `skill_query` (issue #728). Mirrors the relay
 * value in `WorkerAgent.TOOL_CALL_BUDGETS.skill_query` — the prompt advertises
 * at most a handful of on-demand names, so two pulls covers the realistic case
 * while a confused reviewer cannot burn its 7 verification turns on skill
 * fetches. Over-budget calls return an error STRING (never throw) so the
 * remaining turns stay available for file evidence.
 */
export const VERIFIER_SKILL_QUERY_BUDGET = 2;

/**
 * Raw-argument length cap, mirroring the relay `skill_query` zod schema
 * (`packages/tools/src/tool-schemas.ts`). The engine-driven path has no zod
 * gate in front of it — the arguments come straight off an LLM tool call — so
 * the bound is enforced here before the string reaches `normalizeSkillName`.
 */
export const MAX_SKILL_QUERY_NAME_LENGTH = 256;

/** Resolve one on-demand skill for a cross-reviewer. */
export type VerifierSkillResolver = (agentId: string, skill: string) => SkillQueryResult;

/** Read-only file access for cross-reviewers, anchored at the review root. */
export interface VerifierFileAccess {
  /** Resolve an agent-cited path, preferring the review worktree copy. */
  resolveToolPath(filePath: string): Promise<string>;
  fileRead(args: Record<string, unknown>): Promise<string>;
  fileGrep(args: Record<string, unknown>): Promise<string>;
}

export interface VerifierFileAccessOptions {
  fileTools: FileTools;
  projectRoot: string;
  /** Validated resolution roots; `[0]` is the review worktree when present. */
  effectiveRoots: readonly string[];
  /** Defaults to stderr. Injected in tests to assert observability lines. */
  log?: (line: string) => void;
}

export interface VerifierToolRunnerOptions extends VerifierFileAccessOptions {
  memory: MemorySearcher;
  /** Reuse an access built by the caller so both Phase-2 tool loops agree. */
  access?: VerifierFileAccess;
  /** Injection seam for tests — the ROOT choice is the behavior under test. */
  makeGitTools?: (root: string) => GitTools;
  /**
   * On-demand skill resolution for `skill_query`. Defaults to
   * `resolveServableSkill` against `projectRoot` — the SAME resolver +
   * quarantine predicate the relay tool uses. Injected only in tests; a caller
   * must not substitute a resolver with different advertisement semantics.
   */
  skillResolver?: VerifierSkillResolver;
}

/**
 * Canonical form of a root for prefix comparison. Mirrors
 * `FileTools.rankByResolutionRoots`: on darwin a `/tmp/...` root and a
 * `/private/tmp/...` resolved path never match without this.
 */
function canonicalRoot(path: string): string {
  const abs = resolve(path);
  try {
    return existsSync(abs) ? realpathSync(abs) : abs;
  } catch {
    return abs;
  }
}

/**
 * Case-insensitive filesystems need case-folded path compares. Mirrors
 * `Sandbox.validatePath` so this module and the terminal sandbox gate agree
 * on what "inside a root" means.
 */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function fold(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

function isInsideRoot(absPath: string, root: string): boolean {
  const a = fold(absPath);
  const r = fold(root);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

export function buildVerifierFileAccess(opts: VerifierFileAccessOptions): VerifierFileAccess {
  const { fileTools } = opts;
  const effectiveRoots = opts.effectiveRoots ?? [];
  const log = opts.log ?? ((line: string) => { process.stderr.write(line); });
  const projectRoot = canonicalRoot(opts.projectRoot);
  const sandbox = new Sandbox(opts.projectRoot);
  const declaredRoots = effectiveRoots.filter(Boolean).map(canonicalRoot);
  const reviewRoot: string | undefined = declaredRoots[0];

  /** True when an absolute citation already points inside a declared root. */
  const isInsideDeclaredRoot = (filePath: string): boolean => {
    if (!isAbsolute(filePath)) return false;
    const abs = canonicalRoot(filePath);
    return declaredRoots.some(r => isInsideRoot(abs, r));
  };

  /**
   * Map a cited path onto the review worktree when that copy actually exists.
   * Returns undefined when there is no review root, when the path already
   * points inside a declared root, or when the worktree has no such file (the
   * caller then falls back to project-root resolution).
   */
  const remapToReviewRoot = (filePath: string): string | undefined => {
    if (!reviewRoot) return undefined;
    let candidate: string;
    if (isAbsolute(filePath)) {
      if (isInsideDeclaredRoot(filePath)) return undefined;
      const abs = canonicalRoot(filePath);
      const rel = relative(projectRoot, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
      candidate = join(reviewRoot, rel);
    } else {
      candidate = join(reviewRoot, filePath);
    }
    return existsSync(candidate) ? candidate : undefined;
  };

  /**
   * Project-root fallback. With a review root declared the tools are anchored
   * at the worktree, so a project-root file must be handed over as an absolute
   * path or it would re-resolve against the worktree and vanish.
   */
  const asProjectRootPath = (filePath: string): string =>
    reviewRoot ? resolve(projectRoot, filePath) : filePath;

  // Resolve short file paths (e.g. "cross-reviewer-selection.ts") to full
  // project-relative paths. LLMs often cite just the filename without the
  // directory prefix. Disambiguation rules when multiple matches exist:
  //   1. Prefer the review worktree copy when the file exists there (#710)
  //   2. Else prefer a match whose absolute path starts with any effectiveRoots entry
  //   3. Else prefer paths inside projectRoot over paths outside
  //   4. On ambiguity, emit a stderr warning with the chosen + all candidates
  const resolveToolPath = async (filePath: string): Promise<string> => {
    if (!filePath) return filePath;
    // A citation already inside a declared root is authoritative — return it
    // untouched. Routing it onward would send a SIBLING review root through a
    // projectRoot-only `validatePath` (which throws) and into the basename
    // search below, silently substituting an unrelated same-basename file
    // from the project root.
    if (isInsideDeclaredRoot(filePath)) return filePath;
    const remapped = remapToReviewRoot(filePath);
    if (remapped) return remapped;
    // Try as-is next — if Sandbox validates it AND the resolved file actually
    // exists, the citation is a usable project-root path. The existence check is
    // load-bearing (#711): `Sandbox.validatePath` walks up to the deepest EXISTING
    // ancestor, so it succeeds for ANY non-escaping relative path whether or not
    // the file is there. Without it a bare-filename citation short-circuits here,
    // file_read reports "File not found", and the short-name search below is
    // unreachable for in-root relative citations.
    try {
      const validated = sandbox.validatePath(filePath);
      if (existsSync(validated)) return asProjectRootPath(filePath);
    } catch { /* outside root */ }
    // Search via file_search for the bare filename, passing resolutionRoots so
    // fileSearch ranks matches inside a resolution root ahead of stray duplicates.
    const fileName = filePath.split('/').pop() ?? filePath;
    try {
      const searchResult = await fileTools.fileSearch({ pattern: fileName, resolutionRoots: effectiveRoots });
      const candidates = searchResult.split('\n').map(s => s.trim()).filter(s => s && s !== 'No files found');
      if (candidates.length === 0) return filePath;
      const resolved = candidates[0];
      if (candidates.length > 1) {
        log(`[consensus] ambiguous filename resolution for "${fileName}": chose "${resolved}" among [${candidates.join(', ')}]\n`);
      }
      return remapToReviewRoot(resolved) ?? asProjectRootPath(resolved);
    } catch { /* search failed */ }
    return filePath; // return original, let fileRead produce a clear error
  };

  return {
    resolveToolPath,
    fileRead: (args) => fileTools.fileRead(args as any, reviewRoot),
    fileGrep: (args) => fileTools.fileGrep(args as any, reviewRoot),
  };
}

function timestamp(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * Build the `verifierToolRunner` callback handed to ConsensusEngine. Tools are
 * anchored at `effectiveRoots[0]` when roots are declared: file_read/file_grep
 * accept (and resolve against) the review worktree, and git_log reports the
 * worktree's branch history rather than the project root's.
 */
export function buildVerifierToolRunner(opts: VerifierToolRunnerOptions): VerifierToolRunner {
  const access = opts.access ?? buildVerifierFileAccess(opts);
  const log = opts.log ?? ((line: string) => { process.stderr.write(line); });
  const effectiveRoots = opts.effectiveRoots ?? [];
  const gitRoot = effectiveRoots.length > 0 ? effectiveRoots[0] : opts.projectRoot;
  const makeGitTools = opts.makeGitTools ?? ((root: string) => new GitTools(root));
  const gitTools = makeGitTools(gitRoot);
  const { fileTools, memory } = opts;
  const skillResolver: VerifierSkillResolver =
    opts.skillResolver ?? ((agentId, skill) => resolveServableSkill(agentId, skill, opts.projectRoot));
  // One runner is built per collect round, so this map IS the per-reviewer,
  // per-round budget ledger.
  const skillQueryCalls = new Map<string, number>();

  /**
   * `skill_query` — hand a cross-reviewer the raw markdown of one of its own
   * bound skills (issue #728). The agentId comes from the engine's TaskEntry,
   * never from the tool arguments, so an agent cannot pull a peer's local
   * skill. Unknown and quarantined resolve to the SAME not-found message so a
   * reviewer cannot probe which of its skills the effectiveness pipeline
   * suppressed.
   */
  const runSkillQuery = (agentId: string, args: Record<string, unknown>): string => {
    const used = skillQueryCalls.get(agentId) ?? 0;
    if (used >= VERIFIER_SKILL_QUERY_BUDGET) {
      return `Error: skill_query per-round budget exhausted (${VERIFIER_SKILL_QUERY_BUDGET} calls). The markdown from your earlier skill_query call is in this conversation — re-read it instead of calling again.`;
    }
    // Charged before validation, mirroring the relay budget gate: a malformed
    // call still consumes a slot so a broken loop cannot retry for free.
    skillQueryCalls.set(agentId, used + 1);

    const raw = typeof args.skill === 'string' ? args.skill : '';
    if (!raw.trim()) return 'skill_query requires a non-empty skill name.';
    if (raw.length > MAX_SKILL_QUERY_NAME_LENGTH) {
      return `skill_query skill name exceeds ${MAX_SKILL_QUERY_NAME_LENGTH} characters.`;
    }

    let resolution: SkillQueryResult;
    try {
      resolution = skillResolver(agentId, raw);
    } catch {
      // A resolver failure is a not-found from the reviewer's point of view;
      // never surface an internal stack into the tool response.
      resolution = { canonicalName: '', skill: null };
    }
    if (!resolution.skill) return formatSkillNotFound(resolution.canonicalName, agentId);

    // Observability: successful pulls only. `runtime: 'relay'` still applies —
    // this IS the relay/LLM reviewer path — but `phase: 'cross_review'` (issue
    // #730) now distinguishes it from Phase-1 task pulls that share the same
    // runtime tag. `attributed` is true because the identity is the engine's,
    // not a self-attested argument.
    recordSkillPull(opts.projectRoot, {
      agentId,
      skill: resolution.canonicalName,
      resolvedPath: resolution.skill.path,
      runtime: 'relay',
      attributed: true,
      phase: 'cross_review',
    });
    return formatSkillPayload(resolution.canonicalName, resolution.skill);
  };

  return async (agentId, toolName, args) => {
    const toolStart = Date.now();
    try {
      let result: string;
      switch (toolName) {
        case 'file_read': {
          const resolvedPath = await access.resolveToolPath((args as any).path);
          result = await access.fileRead({ ...args, path: resolvedPath });
          break;
        }
        case 'file_grep': {
          const grepPath = (args as any).path ? await access.resolveToolPath((args as any).path) : undefined;
          result = await access.fileGrep({ ...args, ...(grepPath ? { path: grepPath } : {}) });
          break;
        }
        case 'file_search':
          result = await fileTools.fileSearch({
            ...(args as any),
            resolutionRoots: effectiveRoots,
          });
          break;
        case 'memory_query': {
          const results = memory.search(agentId, (args as any).query ?? '', 5);
          result = results.length ? results.map(r => `[${r.source}] ${r.name}: ${r.snippets.join(' | ')}`).join('\n---\n') : 'No memory results found.';
          break;
        }
        case 'git_log': result = await gitTools.gitLog(args as any); break;
        case 'skill_query': result = runSkillQuery(agentId, args); break;
        default: result = `Unknown tool: ${toolName}`;
      }
      const argSummary = toolName === 'file_read' ? (args as any).path
        : toolName === 'file_grep' ? `"${(args as any).pattern}" in ${(args as any).path ?? '.'}`
        : toolName === 'file_search' ? (args as any).pattern
        : toolName === 'memory_query' ? `"${(args as any).query}"`
        // The raw skill argument is model-controlled: strip everything outside
        // the normalized alphabet so it cannot forge a second observability
        // line, and bound its length.
        : toolName === 'skill_query' ? String((args as any).skill ?? '').replace(/[^\w.-]/g, '').slice(0, 64)
        : '';
      log(`${timestamp()} 🤝 [consensus] 🔧 ${agentId} tool_call: ${toolName}(${argSummary}) → ${result.length}B (${Date.now() - toolStart}ms)\n`);
      return result;
    } catch (e) {
      log(`${timestamp()} 🤝 [consensus] 🔧 ${agentId} tool_call: ${toolName}(${JSON.stringify(args).slice(0, 200)}) → ERROR: ${(e as Error).message} (${Date.now() - toolStart}ms)\n`);
      return `Tool error: ${(e as Error).message}`;
    }
  };
}
