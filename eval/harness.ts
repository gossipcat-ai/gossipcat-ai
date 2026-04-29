/**
 * eval/harness.ts — load cases, dispatch consensus at parent_sha, score.
 *
 * Anti-contamination contract (spec § "Anti-contamination"):
 *   1. The dispatched prompt MUST be the case `prompt` field plus the file
 *      list — NEVER the `ground_truth` block. We strip ground_truth from the
 *      object passed to the dispatch layer in `prepareDispatchCase`.
 *   2. Run results are written to eval/.runs/<runId>/<caseId>.json.
 *
 * Checkout strategy:
 *   - Each case freezes a `parent_sha` (state before the bug was caught).
 *   - The harness checks out parent_sha in a worktree-scoped manner, runs
 *     consensus, restores HEAD on completion. To stay safe in concurrent
 *     environments we operate against an explicit worktree path provided by
 *     the caller; if absent, we run against process.cwd() and best-effort
 *     restore.
 *
 * MVP note (PR A): This harness wires dispatch via the MainAgent API. If the
 * caller's environment can't reach a relay/orchestrator (no API key, sandbox,
 * etc.) we still emit a structured run file with empty `byAgent` so the
 * scoring + reporting paths are exercised end-to-end. That's the "score may
 * be 0/0 but proves wiring" path called out in the spec § "Phasing".
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { execFileSync } from 'child_process';

import { FindingShape, GroundTruthShape } from './match';
import { CaseRun, scoreSuite, SuiteScores } from './score';

export interface EvalCase {
  id: string;
  title: string;
  parent_sha: string;
  fix_sha?: string;
  fix_pr?: number;
  scope: { files: string[] };
  ground_truth: GroundTruthShape[];
  prompt: string;
  notes?: string;
  /** Original yaml path on disk — for traceability in run files. */
  sourcePath: string;
}

/** What we hand to the dispatch layer — `ground_truth` is GONE. */
export interface DispatchableCase {
  id: string;
  title: string;
  parent_sha: string;
  scope: { files: string[] };
  prompt: string;
  notes?: string;
}

export interface RunOptions {
  /** Working tree to operate on. Defaults to process.cwd(). */
  worktreeRoot?: string;
  /** Output directory for run JSON. Defaults to <worktreeRoot>/eval/.runs. */
  outDir?: string;
  /** Agent IDs to dispatch. Empty array → no dispatch, harness still scores. */
  agents?: string[];
  /**
   * Optional injection point — caller can supply a custom dispatcher (e.g. for
   * tests, or to wire into an already-running MainAgent). Receives the
   * sanitized DispatchableCase plus agent IDs and returns a per-agent finding
   * map. If omitted, the harness runs the default MainAgent dispatch path.
   */
  dispatcher?: (sanitized: DispatchableCase, agents: string[]) => Promise<Record<string, FindingShape[]>>;
  /**
   * Skip git checkout entirely. Useful in tests where we just want to validate
   * the prompt/sanitization path. Default: false.
   */
  skipCheckout?: boolean;
}

/** Load a single yaml case file. Tailored to the `eval/cases/*.yaml` schema. */
export function loadCase(yamlPath: string): EvalCase {
  const raw = readFileSync(yamlPath, 'utf-8');
  return parseCaseYaml(raw, yamlPath);
}

/** Load all cases matching a glob-ish filter. Supports `eval/cases/*.yaml` shape. */
export function loadCases(globPath: string, baseDir?: string): EvalCase[] {
  const base = baseDir || process.cwd();
  const out: EvalCase[] = [];

  // Minimal glob: we only honor a trailing `*.yaml` pattern. Anything else is
  // treated as a literal file path. The full-glob job belongs to the CLI layer
  // where the shell already expanded paths.
  if (globPath.endsWith('*.yaml') || globPath.endsWith('*.yml')) {
    const dir = isAbsolute(globPath) ? dirname(globPath) : resolve(base, dirname(globPath));
    if (!existsSync(dir)) return out;
    const ext = globPath.endsWith('.yml') ? '.yml' : '.yaml';
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(ext)) continue;
      out.push(loadCase(join(dir, name)));
    }
    return out;
  }

  const p = isAbsolute(globPath) ? globPath : resolve(base, globPath);
  if (existsSync(p)) out.push(loadCase(p));
  return out;
}

/** Strip ground_truth from an EvalCase. The single anti-contamination chokepoint. */
export function prepareDispatchCase(c: EvalCase): DispatchableCase {
  return {
    id: c.id,
    title: c.title,
    parent_sha: c.parent_sha,
    scope: { files: [...c.scope.files] },
    prompt: c.prompt,
    ...(c.notes ? { notes: c.notes } : {}),
  };
}

/** Build the natural-language prompt that goes to each reviewer agent. */
export function buildDispatchPrompt(d: DispatchableCase): string {
  const fileList = d.scope.files.map(f => `- ${f}`).join('\n');
  return `Eval case: ${d.title}\n\n${d.prompt}\n\nScope (review only these files):\n${fileList}\n`;
}

export interface RunCaseResult {
  caseId: string;
  runId: string;
  parent_sha: string;
  agents: string[];
  byAgent: Record<string, FindingShape[]>;
  outPath: string;
  /** Set when something went wrong but we still emitted a placeholder run file. */
  warning?: string;
}

function gitOk(args: string[], cwd: string): { ok: boolean; out: string; err?: string } {
  try {
    const out = execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    return { ok: true, out };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, out: '', err };
  }
}

export async function runCase(
  c: EvalCase,
  agents: string[],
  opts: RunOptions = {},
): Promise<RunCaseResult> {
  const root = opts.worktreeRoot ? resolve(opts.worktreeRoot) : process.cwd();
  const outDir = opts.outDir ? resolve(opts.outDir) : join(root, 'eval', '.runs');
  const runId = process.env.GOSSIP_EVAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(outDir, runId);
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true });
  const outPath = join(runDir, `${c.id}.json`);

  const sanitized = prepareDispatchCase(c);

  let restoreRef: string | undefined;
  let warning: string | undefined;
  if (!opts.skipCheckout) {
    const head = gitOk(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    if (head.ok) restoreRef = head.out.trim() === 'HEAD'
      ? gitOk(['rev-parse', 'HEAD'], root).out.trim()
      : head.out.trim();
    const co = gitOk(['checkout', c.parent_sha], root);
    if (!co.ok) {
      warning = `git checkout ${c.parent_sha} failed: ${co.err}`;
    }
  }

  let byAgent: Record<string, FindingShape[]> = {};
  try {
    if (agents.length > 0) {
      const dispatcher = opts.dispatcher || defaultDispatcher;
      byAgent = await dispatcher(sanitized, agents);
    }
  } catch (e) {
    warning = (warning ? warning + '; ' : '') + `dispatcher threw: ${e instanceof Error ? e.message : String(e)}`;
    byAgent = {};
  } finally {
    if (!opts.skipCheckout && restoreRef) {
      gitOk(['checkout', restoreRef], root);
    }
  }

  const result: RunCaseResult = {
    caseId: c.id,
    runId,
    parent_sha: c.parent_sha,
    agents,
    byAgent,
    outPath,
    ...(warning ? { warning } : {}),
  };

  // Run file includes ground_truth so scoring is reproducible offline. The
  // anti-contamination contract is about what reaches the *agent*, not what
  // gets written to disk after the run is complete.
  writeFileSync(outPath, JSON.stringify({
    runId,
    caseId: c.id,
    parent_sha: c.parent_sha,
    sourcePath: relative(root, c.sourcePath),
    agents,
    byAgent,
    groundTruth: c.ground_truth,
    warning,
    timestamp: new Date().toISOString(),
  }, null, 2));

  return result;
}

/** Run multiple cases sequentially and emit a SuiteScores. */
export async function runSuite(
  cases: EvalCase[],
  agents: string[],
  opts: RunOptions = {},
): Promise<{ scores: SuiteScores; results: RunCaseResult[] }> {
  const results: RunCaseResult[] = [];
  const runs: CaseRun[] = [];
  // Pin a single runId across the suite so all cases write to the same dir.
  const runId = process.env.GOSSIP_EVAL_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
  const prevEnv = process.env.GOSSIP_EVAL_RUN_ID;
  process.env.GOSSIP_EVAL_RUN_ID = runId;
  try {
    for (const c of cases) {
      const r = await runCase(c, agents, opts);
      results.push(r);
      runs.push({
        caseId: c.id,
        groundTruth: c.ground_truth,
        byAgent: r.byAgent,
      });
    }
  } finally {
    if (prevEnv === undefined) delete process.env.GOSSIP_EVAL_RUN_ID;
    else process.env.GOSSIP_EVAL_RUN_ID = prevEnv;
  }
  return { scores: scoreSuite(runId, runs), results };
}

/**
 * Default dispatcher — best-effort wire-up to a running MainAgent. If any of
 * the prerequisites are missing (no .gossip/config.json, no API keys, etc.)
 * we return an empty per-agent map and let the harness emit a placeholder
 * run. The CLI layer is the right place to surface "no agents reachable"
 * loudly; the harness must stay headless to keep tests cheap.
 */
async function defaultDispatcher(
  sanitized: DispatchableCase,
  agents: string[],
): Promise<Record<string, FindingShape[]>> {
  if (agents.length === 0) return {};
  // Lazy-load to avoid pulling the orchestrator into unit tests of the harness.
  const { MainAgent } = await import('@gossip/orchestrator');
  const { RelayServer } = await import('@gossip/relay');
  const { ToolServer } = await import('@gossip/tools');
  const { findConfigPath, loadConfig, configToAgentConfigs } = await import('../apps/cli/src/config');
  const { Keychain } = await import('../apps/cli/src/keychain');

  const cfgPath = findConfigPath();
  if (!cfgPath) return {};
  const config = loadConfig(cfgPath);
  const keychain = new Keychain();
  const relay = new RelayServer({ port: 0 });
  await relay.start();
  const toolServer = new ToolServer({ relayUrl: relay.url, projectRoot: process.cwd() });
  await toolServer.start();
  const mainKey = await keychain.getKey(config.main_agent.provider);
  const mainAgent = new MainAgent({
    provider: config.main_agent.provider,
    model: config.main_agent.model,
    apiKey: mainKey || undefined,
    relayUrl: relay.url,
    agents: configToAgentConfigs(config),
    projectRoot: process.cwd(),
    toolServer: {
      assignScope: (agentId: string, scope: string) => toolServer.assignScope(agentId, scope),
      assignRoot: (agentId: string, root: string) => toolServer.assignRoot(agentId, root),
      releaseAgent: (agentId: string) => toolServer.releaseAgent(agentId),
    },
  });

  try {
    await mainAgent.start();
    const prompt = buildDispatchPrompt(sanitized);
    const tasks = agents.map(agentId => ({ agentId, task: prompt }));
    const { taskIds } = await mainAgent.dispatchParallel(tasks, { consensus: true });
    const { results } = await mainAgent.collect(taskIds, 300_000);

    const out: Record<string, FindingShape[]> = {};
    const { parseAgentFindingsStrict } = await import('../packages/orchestrator/src/parse-findings');
    for (const r of results || []) {
      const text = (r as { result?: string; agentId: string }).result || '';
      const aid = (r as { agentId: string }).agentId;
      const parsed = parseAgentFindingsStrict(text, { idPrefix: aid });
      out[aid] = parsed.findings.map(f => ({
        summary: f.content,
        severity: f.severity,
        category: f.category,
      }));
    }
    return out;
  } finally {
    await mainAgent.stop();
    await toolServer.stop();
    await relay.stop();
  }
}

// ── YAML-ish parser ──────────────────────────────────────────────────────────
//
// A full YAML lib would be a runtime dep; the case schema is constrained
// enough that we hand-roll a focused parser. Supports:
//   - top-level scalar keys (string, number)
//   - nested objects (one level: scope, ground_truth items)
//   - sequences of mappings (ground_truth: \n - id: ... \n line_range: [a, b])
//   - sequences of scalars (scope.files)
//   - block scalars `|` and `>` for prompt/notes
// Anything beyond that throws — keep cases simple.

interface RawCaseObject {
  [k: string]: unknown;
}

function parseCaseYaml(raw: string, sourcePath: string): EvalCase {
  const lines = raw.split(/\r?\n/);
  // Strip a trailing blank line so the parser doesn't try to read past EOF.
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const obj = parseBlock(lines, 0, 0).value as RawCaseObject;

  const required = ['id', 'title', 'parent_sha', 'scope', 'ground_truth', 'prompt'];
  for (const k of required) {
    if (!(k in obj)) throw new Error(`Eval case ${sourcePath} missing required field: ${k}`);
  }

  const scope = obj.scope as { files: unknown };
  if (!scope || !Array.isArray(scope.files)) {
    throw new Error(`Eval case ${sourcePath}: scope.files must be an array`);
  }

  const groundTruthRaw = obj.ground_truth;
  if (!Array.isArray(groundTruthRaw)) {
    throw new Error(`Eval case ${sourcePath}: ground_truth must be an array (use [] for negative cases)`);
  }
  const groundTruth: GroundTruthShape[] = groundTruthRaw.map((g, i) => {
    if (typeof g !== 'object' || g === null) {
      throw new Error(`Eval case ${sourcePath}: ground_truth[${i}] must be an object`);
    }
    const gt = g as Record<string, unknown>;
    const lr = gt.line_range;
    if (!Array.isArray(lr) || lr.length !== 2 || typeof lr[0] !== 'number' || typeof lr[1] !== 'number') {
      throw new Error(`Eval case ${sourcePath}: ground_truth[${i}].line_range must be [number, number]`);
    }
    return {
      id: String(gt.id),
      file: String(gt.file),
      line_range: [lr[0], lr[1]],
      summary: String(gt.summary),
      severity: String(gt.severity),
      category: String(gt.category),
    };
  });

  return {
    id: String(obj.id),
    title: String(obj.title),
    parent_sha: String(obj.parent_sha),
    fix_sha: obj.fix_sha === undefined ? undefined : String(obj.fix_sha),
    fix_pr: obj.fix_pr === undefined ? undefined : Number(obj.fix_pr),
    scope: { files: scope.files.map(String) },
    ground_truth: groundTruth,
    prompt: String(obj.prompt),
    notes: obj.notes === undefined ? undefined : String(obj.notes),
    sourcePath,
  };
}

interface ParseFrame {
  value: unknown;
  /** Next line index after the block consumed. */
  next: number;
}

function indentOf(s: string): number {
  let i = 0;
  while (i < s.length && s[i] === ' ') i++;
  return i;
}

function isBlankOrComment(s: string): boolean {
  const t = s.trim();
  return t === '' || t.startsWith('#');
}

function parseBlock(lines: string[], start: number, indent: number): ParseFrame {
  // Determines whether the block at `indent` is a mapping or a sequence by
  // peeking at the first non-blank line.
  let i = start;
  while (i < lines.length && isBlankOrComment(lines[i])) i++;
  if (i >= lines.length) return { value: {}, next: i };
  const peek = lines[i];
  const peekIndent = indentOf(peek);
  if (peekIndent < indent) return { value: {}, next: i };

  if (peek.trim().startsWith('- ')) {
    return parseSequence(lines, i, peekIndent);
  }
  return parseMapping(lines, i, peekIndent);
}

function parseMapping(lines: string[], start: number, indent: number): ParseFrame {
  const obj: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const ln = lines[i];
    if (isBlankOrComment(ln)) { i++; continue; }
    const ind = indentOf(ln);
    if (ind < indent) break;
    if (ind > indent) {
      // Should have been consumed as a child block — defensive fallback.
      i++;
      continue;
    }
    const trimmed = ln.slice(indent);
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) throw new Error(`Expected mapping key at line ${i + 1}: "${ln}"`);
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1);
    const restTrim = rest.trim();

    if (restTrim === '|' || restTrim === '>') {
      // Block scalar
      const collected: string[] = [];
      i++;
      // Find the indent of the first content line.
      let blockIndent = -1;
      while (i < lines.length) {
        const cl = lines[i];
        if (cl.trim() === '') { collected.push(''); i++; continue; }
        const ci = indentOf(cl);
        if (ci <= indent) break;
        if (blockIndent === -1) blockIndent = ci;
        if (ci < blockIndent) break;
        collected.push(cl.slice(blockIndent));
        i++;
      }
      const text = restTrim === '|'
        ? collected.join('\n').replace(/\n+$/, '\n')
        : collected.join(' ').replace(/\s+/g, ' ').trim();
      obj[key] = text;
      continue;
    }

    if (restTrim === '') {
      // Nested block — could be mapping or sequence, defer.
      const child = parseBlock(lines, i + 1, indent + 2);
      obj[key] = child.value;
      i = child.next;
      continue;
    }

    obj[key] = parseScalar(restTrim);
    i++;
  }
  return { value: obj, next: i };
}

function parseSequence(lines: string[], start: number, indent: number): ParseFrame {
  const arr: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const ln = lines[i];
    if (isBlankOrComment(ln)) { i++; continue; }
    const ind = indentOf(ln);
    if (ind < indent) break;
    if (ind > indent) { i++; continue; }
    const trimmed = ln.slice(indent);
    if (!trimmed.startsWith('- ')) break;
    const itemHead = trimmed.slice(2);
    const itemHeadTrim = itemHead.trim();
    // Sequence-of-mappings: the dash carries the first key:value of the mapping.
    if (itemHeadTrim.includes(':') && !itemHeadTrim.startsWith('[') && !itemHeadTrim.startsWith('"')) {
      // Simulate a mapping block where the first key starts at indent+2.
      // Consume the first line as `key: value` then continue parsing further
      // keys at indent+2 until indent drops back.
      const obj: Record<string, unknown> = {};
      const colonIdx = itemHead.indexOf(':');
      const k = itemHead.slice(0, colonIdx).trim();
      const v = itemHead.slice(colonIdx + 1).trim();
      if (v === '') {
        const child = parseBlock(lines, i + 1, indent + 4);
        obj[k] = child.value;
        i = child.next;
      } else {
        obj[k] = parseScalar(v);
        i++;
      }
      // Continue collecting sibling keys at indent+2.
      while (i < lines.length) {
        const cl = lines[i];
        if (isBlankOrComment(cl)) { i++; continue; }
        const ci = indentOf(cl);
        if (ci !== indent + 2) break;
        const ct = cl.slice(indent + 2);
        const cIdx = ct.indexOf(':');
        if (cIdx === -1) break;
        const ck = ct.slice(0, cIdx).trim();
        const cv = ct.slice(cIdx + 1).trim();
        if (cv === '') {
          const cb = parseBlock(lines, i + 1, indent + 4);
          obj[ck] = cb.value;
          i = cb.next;
        } else {
          obj[ck] = parseScalar(cv);
          i++;
        }
      }
      arr.push(obj);
      continue;
    }
    // Sequence of scalars.
    arr.push(parseScalar(itemHeadTrim));
    i++;
  }
  return { value: arr, next: i };
}

function parseScalar(raw: string): unknown {
  if (raw === '') return '';
  if (raw === 'null' || raw === '~') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  // Inline flow array: [a, b]
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(s => parseScalar(s.trim()));
  }
  // Quoted strings
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Number
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  return raw;
}
