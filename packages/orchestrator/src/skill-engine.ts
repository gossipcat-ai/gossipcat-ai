/**
 * SkillEngine — manages the full skill lifecycle per agent:
 * LLM-driven skill file generation, baseline snapshots, lazy migration,
 * effectiveness evaluation (checkEffectiveness), and verdict resolution wiring.
 *
 * Originally named SkillGenerator; renamed in the checkEffectiveness branch
 * once the class grew beyond generation into a full lifecycle engine.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { join, resolve } from 'path';
import { ILLMProvider } from './llm-client';
import { PerformanceReader } from './performance-reader';
import { LLMMessage } from '@gossip/types';
import { ConsensusSignal } from './consensus-types';
import { normalizeSkillName } from './skill-name';
import {
  resolveVerdict,
  TIMEOUT_MS,
  type SkillSnapshot,
  type VerdictResult,
  type VerdictStatus,
} from './check-effectiveness';

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const KNOWN_CATEGORIES = new Set([
  'trust_boundaries', 'injection_vectors', 'input_validation', 'concurrency',
  'resource_exhaustion', 'type_safety', 'error_handling', 'data_integrity',
  'severity_calibration', 'citation_grounding',
]);

/** Default keywords per category for contextual skill activation */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  trust_boundaries: ['auth', 'authentication', 'authorization', 'session', 'cookie', 'token', 'path', 'traversal', 'injection', 'middleware', 'permission', 'role', 'privilege', 'acl'],
  injection_vectors: ['injection', 'xss', 'sql', 'sanitize', 'escape', 'template', 'eval', 'exec', 'html', 'uri', 'command'],
  input_validation: ['validation', 'schema', 'zod', 'parse', 'sanitize', 'input', 'form', 'request', 'coerce', 'transform'],
  concurrency: ['race condition', 'concurrent', 'mutex', 'lock', 'atomic', 'parallel', 'deadlock', 'semaphore'],
  resource_exhaustion: ['memory', 'leak', 'unbounded', 'growth', 'limit', 'cap', 'timeout', 'pool', 'cache', 'backpressure', 'buffer', 'queue', 'throttle'],
  type_safety: ['type guard', 'generic', 'cast', 'assertion', 'narrowing', 'discriminated', 'satisfies'],
  error_handling: ['error handling', 'catch', 'throw', 'exception', 'retry', 'fallback', 'recovery', 'graceful'],
  data_integrity: ['data integrity', 'migration', 'serialize', 'deserialize', 'corrupt', 'consistency', 'invariant', 'transaction', 'rollback', 'idempotent'],
  severity_calibration: ['severity', 'critical', 'high', 'medium', 'low', 'impact', 'risk', 'priority', 'triage', 'cvss'],
  // Citation grounding — fabrication-class failures: cited file/line/symbol does not match repo state.
  // Gate for this is a skill bind + signal category, not the consensus-engine verifyCitations AND-gate
  // (which only fires on keyword+regex dual-match, rarely in practice).
  citation_grounding: ['cite', 'citation', 'line number', 'anchor', 'file path', 'reference', 'fabricat', 'hallucin', 'verify', 'does not exist', 'no such'],
};

const REQUIRED_SECTIONS = ['## Iron Law', '## When This Skill Activates', '## Methodology', '## Key Patterns', '## Anti-Patterns', '## Quality Gate'];

const BUNDLED_TEMPLATE = `---
name: systematic-debugging
description: Use when encountering any bug or unexpected behavior
---

# Systematic Debugging

## Iron Law

NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST.

## When This Skill Activates

- Test failures, bugs, unexpected behavior

## Methodology

1. Read error messages carefully — they often contain the solution
2. Reproduce consistently — if not reproducible, gather more data
3. Check recent changes — git diff, recent commits
4. Form hypothesis and verify with evidence
5. Fix the root cause, not the symptom

## Key Patterns

- Stack traces — read bottom-up, find the first project file
- Error messages — search codebase for the exact string
- State mutations — trace where the value changed unexpectedly

## Anti-Patterns

- **"Just one quick fix"** — Quick fixes mask root causes. Investigate before patching.
- **"I know what's wrong"** — Verify with evidence before acting. Assumptions cause regressions.

## Quality Gate

- [ ] Root cause identified with evidence
- [ ] Fix addresses root cause, not symptom
- [ ] Tests verify the fix
`;

export class SkillEngine {
  private techStackCache: string | null | undefined = undefined; // undefined = not yet computed

  constructor(
    private llm: ILLMProvider,
    private perfReader: PerformanceReader,
    private projectRoot: string,
  ) {}

  async generate(agentId: string, category: string): Promise<{ path: string; content: string }> {
    if (!SAFE_NAME.test(agentId)) {
      throw new Error(`Invalid agent_id: "${agentId}". Must be lowercase alphanumeric with hyphens/underscores.`);
    }
    if (!KNOWN_CATEGORIES.has(category)) {
      throw new Error(`Unknown category: "${category}". Known: ${[...KNOWN_CATEGORIES].join(', ')}`);
    }

    const template = this.loadTemplate();
    const findings = this.loadCategoryFindings(category);
    const scores = this.perfReader.getScores();
    const agentScoreData = scores.get(agentId);
    const agentCatScore = agentScoreData?.categoryStrengths[category] ?? 0;
    const peerScores: string[] = [];
    for (const [id, s] of scores) {
      if (id === agentId) continue;
      const catVal = s.categoryStrengths[category];
      if (catVal !== undefined && catVal > 0.5) {
        peerScores.push(`${id}: ${catVal.toFixed(2)}`);
      }
    }

    let projectContext = '';
    const bootstrapPath = join(this.projectRoot, '.gossip', 'bootstrap.md');
    if (existsSync(bootstrapPath)) {
      projectContext = readFileSync(bootstrapPath, 'utf-8').slice(0, 1500);
    }

    // Analyze project tech stack so skills are tailored, not generic (memoized)
    if (this.techStackCache === undefined) {
      this.techStackCache = await this.detectTechStack();
    }
    const techStack = this.techStackCache;
    if (techStack) {
      projectContext += `\n\n<tech_stack>\n${techStack}\n</tech_stack>`;
    }

    const totalDispatches = agentScoreData?.totalSignals ?? 0;
    const categoryConfirmations = findings.filter(f => f.agentId === agentId).length;
    const baselineRate = totalDispatches > 0 ? categoryConfirmations / totalDispatches : 0;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a senior prompt engineer who builds skill files for AI code review agents. Your skills are injected into agent system prompts at dispatch time — every word costs tokens and shapes behavior. You write concise, opinionated methodology that changes how an agent thinks about a specific class of problems.

Your output quality is measured by:
1. **Relevance** — every check must apply to THIS project's tech stack. Generic checklists are waste.
2. **Specificity** — cite actual project file paths and patterns, not abstract examples.
3. **Behavioral impact** — Iron Laws and Anti-Patterns should catch the exact mistakes this agent has made before.
4. **Token efficiency** — shorter is better. Agents have limited context windows.

Study this reference skill — it represents the quality bar:

<reference_skill>
${template}
</reference_skill>`,
      },
      {
        role: 'user',
        content: `Generate a skill file for agent "${agentId}" to improve its "${category}" review performance.

<project_context>
${projectContext || 'No project context available.'}
</project_context>

<findings_in_category>
${findings.length > 0 ? findings.slice(0, 20).map(f => `- [${f.agentId}] ${f.evidence}`).join('\n') : 'No findings yet in this category.'}
</findings_in_category>

<agent_performance>
Agent: ${agentId}
Current ${category} score: ${agentCatScore.toFixed(2)}
Peer scores: ${peerScores.length > 0 ? peerScores.join(', ') : 'no peer data'}
</agent_performance>

Output a skill markdown file with this exact structure:

1. YAML frontmatter with fields: name, category (${category}), agent (${agentId}), generated, effectiveness (0.0), baseline_rate (${baselineRate.toFixed(3)}), baseline_dispatches (${totalDispatches}), version (1), mode (contextual), keywords ([${(CATEGORY_KEYWORDS[category] || [category]).join(', ')}])
2. ## Iron Law — one absolute rule (MUST/NEVER language)
3. ## When This Skill Activates — task patterns that trigger it
4. ## Methodology — 5-8 step checklist, actionable not vague
5. ## Key Patterns — important code patterns to look for
6. ## Anti-Patterns — bullet list, each: **"Thought"** — Reality explanation
7. ## Quality Gate — pre-report checklist with checkboxes

Requirements:
- Write with authority — MUST, NEVER, NO EXCEPTIONS
- Keep under 150 lines
- CRITICAL: Tailor ALL content to the project's actual tech stack (see <tech_stack>). Only include checks relevant to technologies the project uses. If the project has no SQL database, do NOT mention SQL injection. If no HTML rendering, do NOT mention XSS. Generic security checklists waste agent prompt tokens.
- Reference actual project file paths and patterns from findings and context
- Use bullet lists instead of markdown tables for Anti-Patterns (tables render poorly in agent prompts)`,
      },
    ];

    const response = await this.llm.generate(messages, { temperature: 0.3 });
    const content = response.text || '';

    // Strip markdown code fences if LLM wrapped the output
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```\w*\n/, '').replace(/\n```\s*$/, '').trim();
    }

    this.validateSkillContent(cleaned);

    // Snapshot baseline counters at bind time — Tasks 7/8 read these for effectiveness checks
    const lifetime = this.perfReader.getCountersSince(agentId, category, 0);
    const baseline_accuracy_correct = lifetime.correct;
    const baseline_accuracy_hallucinated = lifetime.hallucinated;
    const bound_at = new Date().toISOString();

    cleaned = this.injectSnapshotFields(cleaned, { baseline_accuracy_correct, baseline_accuracy_hallucinated, bound_at });

    const skillName = normalizeSkillName(category);
    const skillDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, `${skillName}.md`);
    writeFileSync(skillPath, cleaned);

    return { path: skillPath, content: cleaned };
  }

  /**
   * Post-processes LLM-generated skill content to inject or overwrite snapshot fields
   * in the YAML frontmatter. This ensures spec compliance regardless of LLM output.
   */
  private injectSnapshotFields(
    content: string,
    snapshot: { baseline_accuracy_correct: number; baseline_accuracy_hallucinated: number; bound_at: string },
  ): string {
    const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
    if (!fmMatch) return content;

    let fm = fmMatch[2];
    const rest = content.slice(fmMatch[0].length);

    // Remove any pre-existing snapshot fields the LLM may have emitted
    fm = fm
      .replace(/^baseline_accuracy_correct:.*\n?/m, '')
      .replace(/^baseline_accuracy_hallucinated:.*\n?/m, '')
      .replace(/^baseline_correct:.*\n?/m, '')
      .replace(/^baseline_hallucinated:.*\n?/m, '')
      .replace(/^bound_at:.*\n?/m, '')
      .replace(/^migration_count:.*\n?/m, '')
      .replace(/^status:.*\n?/m, '');

    // Ensure effectiveness is present as a number
    if (!fm.match(/^effectiveness:/m)) {
      fm = fm.trimEnd() + '\neffectiveness: 0.0';
    }

    // Append snapshot fields
    fm = fm.trimEnd() +
      `\nbaseline_accuracy_correct: ${snapshot.baseline_accuracy_correct}` +
      `\nbaseline_accuracy_hallucinated: ${snapshot.baseline_accuracy_hallucinated}` +
      `\nbound_at: ${snapshot.bound_at}` +
      `\nmigration_count: 0` +
      `\nstatus: pending`;

    return `---\n${fm}\n---${rest}`;
  }

  private validateSkillContent(content: string): void {
    if (!content.match(/^---\n[\s\S]*?\n---/)) {
      throw new Error('Generated skill missing frontmatter. LLM output did not follow the required format.');
    }
    for (const section of REQUIRED_SECTIONS) {
      if (!content.includes(section)) {
        throw new Error(`Generated skill missing required section: "${section}". LLM output did not follow the required format.`);
      }
    }
    const lines = content.split('\n').length;
    if (lines > 200) {
      throw new Error(`Generated skill is ${lines} lines (max 200). LLM output too verbose.`);
    }
    // Validate keywords presence for contextual activation
    if (!content.match(/keywords:(\s*\[|\s*\n\s*-)/)) {
      throw new Error('Generated skill missing keywords in frontmatter. Contextual activation requires keywords.');
    }
  }

  private loadTemplate(): string {
    const userDir = join(this.projectRoot, '.gossip', 'skill-templates');
    if (existsSync(userDir)) {
      const files = readdirSync(userDir).filter(f => f.endsWith('.md'));
      if (files.length > 0) {
        return readFileSync(join(userDir, files[0]), 'utf-8');
      }
    }

    const home = process.env.HOME || process.env.USERPROFILE || '';
    const cacheBase = join(home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'superpowers');
    if (existsSync(cacheBase)) {
      try {
        const versions = readdirSync(cacheBase).sort().reverse();
        for (const ver of versions) {
          const skillPath = join(cacheBase, ver, 'skills', 'systematic-debugging', 'SKILL.md');
          if (existsSync(skillPath)) {
            const realPath = realpathSync(skillPath);
            if (realPath.startsWith(resolve(cacheBase))) {
              return readFileSync(realPath, 'utf-8');
            }
          }
        }
      } catch { /* cache not readable */ }
    }

    return BUNDLED_TEMPLATE;
  }

  /**
   * Use LLM to analyze the project's tech stack from package.json and structure.
   * Returns a concise summary of what the project uses and what it does NOT use,
   * so the skill generator can tailor content accordingly.
   */
  private async detectTechStack(): Promise<string | null> {
    const inputs: string[] = [];

    // Gather package.json(s) — root + workspace packages
    const pkgPaths = [join(this.projectRoot, 'package.json')];
    try {
      const packagesDir = join(this.projectRoot, 'packages');
      if (existsSync(packagesDir)) {
        for (const dir of readdirSync(packagesDir)) {
          const p = join(packagesDir, dir, 'package.json');
          if (existsSync(p)) pkgPaths.push(p);
        }
      }
    } catch { /* skip */ }

    for (const p of pkgPaths.slice(0, 5)) { // cap at 5 packages
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf-8'));
        const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
        if (deps.length > 0) {
          inputs.push(`${p.replace(this.projectRoot + '/', '')}: ${deps.join(', ')}`);
        }
      } catch { /* skip */ }
    }

    // Source directory listing
    try {
      const srcDirs = ['src', 'packages', 'apps', 'lib'].filter(d => existsSync(join(this.projectRoot, d)));
      inputs.push(`Source dirs: ${srcDirs.join(', ') || 'root'}`);
    } catch { /* skip */ }

    if (inputs.length === 0) return null;

    try {
      const messages: LLMMessage[] = [{
        role: 'user',
        content: `Analyze this project's tech stack from its dependencies and structure. Output a concise summary (max 10 lines) covering:
1. Primary language and runtime (e.g., TypeScript + Node.js)
2. Frameworks and libraries actually used (e.g., WebSocket, Express, React)
3. Data storage (e.g., PostgreSQL, Redis, file-based JSON) — or "none" if no database
4. What the project does NOT use that is commonly assumed (e.g., "No SQL database", "No HTML rendering", "No GraphQL")

This summary will be used to filter security skill content — irrelevant checks waste agent prompt tokens.

<project_deps>
${inputs.join('\n')}
</project_deps>`,
      }];

      const response = await this.llm.generate(messages, { temperature: 0 });
      return response.text?.trim().slice(0, 1000) || null;
    } catch {
      // Fallback: return raw dependency list if LLM fails
      return inputs.join('\n').slice(0, 500);
    }
  }

  private loadCategoryFindings(category: string): Array<{ agentId: string; evidence: string }> {
    const filePath = join(this.projectRoot, '.gossip', 'agent-performance.jsonl');
    if (!existsSync(filePath)) return [];
    try {
      return readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter((s): s is ConsensusSignal =>
          s !== null && s.type === 'consensus' && s.signal === 'category_confirmed' && s.category === category
        )
        .map(s => ({ agentId: s.agentId, evidence: s.evidence || '' }));
    } catch { return []; }
  }

  // ---------------------------------------------------------------------------
  // Skill effectiveness evaluation (Task 7)
  // ---------------------------------------------------------------------------

  /**
   * Reads the skill file for (agentId, category), fetches live counters from
   * PerformanceReader, runs resolveVerdict, and writes back any state changes
   * (status, effectiveness, inconclusive epoch fields) atomically.
   *
   * Role is passed via opts.role — the caller (collect.ts, Task 9) provides it
   * from the agent registry. This avoids wiring a registry getter into the
   * constructor and keeps the class dependencies minimal.
   */
  async checkEffectiveness(
    agentId: string,
    category: string,
    opts?: { role?: string },
  ): Promise<VerdictResult> {
    if (!SAFE_NAME.test(agentId)) {
      return { status: 'pending', shouldUpdate: false };
    }
    const skillPath = this.resolveSkillPath(agentId, category);
    if (!existsSync(skillPath)) {
      return { status: 'pending', shouldUpdate: false };
    }

    const raw = readFileSync(skillPath, 'utf-8');
    const { frontmatter: rawFrontmatter, body } = this.parseSkillFile(raw);

    // Lazy migration: pre-existing skill files may lack the snapshot fields
    const nowMs = Date.now();
    const { frontmatter, mutated } = this.migrateIfNeeded(
      rawFrontmatter,
      agentId,
      category,
      nowMs,
    );
    if (mutated) {
      this.writeSkillFileFromParts(skillPath, frontmatter, body);
    }

    const snapshot: SkillSnapshot = {
      baseline_accuracy_correct: this.safeNumber(
        frontmatter.baseline_accuracy_correct ?? frontmatter.baseline_correct ?? 0,
        0,
      ),
      baseline_accuracy_hallucinated: this.safeNumber(
        frontmatter.baseline_accuracy_hallucinated ?? frontmatter.baseline_hallucinated ?? 0,
        0,
      ),
      bound_at: String(frontmatter.bound_at ?? new Date(nowMs).toISOString()),
      status: (frontmatter.status as VerdictStatus) ?? 'pending',
      migration_count: this.safeNumber(frontmatter.migration_count ?? 0, 0),
      inconclusive_at:
        typeof frontmatter.inconclusive_at === 'string' ? frontmatter.inconclusive_at : undefined,
      inconclusive_strikes:
        frontmatter.inconclusive_strikes != null
          ? (Number.isFinite(Number(frontmatter.inconclusive_strikes)) ? Number(frontmatter.inconclusive_strikes) : undefined)
          : undefined,
    };

    const anchorMs = snapshot.inconclusive_at
      ? new Date(snapshot.inconclusive_at).getTime()
      : new Date(snapshot.bound_at).getTime();
    const delta = this.perfReader.getCountersSince(agentId, category, anchorMs);
    const verdict = resolveVerdict(snapshot, delta, nowMs, opts);

    if (verdict.shouldUpdate && verdict.newSnapshotFields) {
      const merged: Record<string, unknown> = { ...frontmatter, ...verdict.newSnapshotFields };
      if (verdict.effectiveness !== undefined) {
        merged.effectiveness = verdict.effectiveness;
      }
      this.writeSkillFileFromParts(skillPath, merged, body);
    }

    return verdict;
  }

  /**
   * Lazily migrates pre-existing skill files that lack the snapshot fields
   * introduced by the checkEffectiveness redesign.
   *
   * - Snapshots current counters as the baseline when `baseline_correct` is
   *   missing (giving migrated skills a fair window from migration time).
   * - Resets `bound_at` to now when it is more than 90 days old (preventing
   *   immediate insufficient_evidence timeout for old skills).
   * - Refuses to re-fire when `migration_count >= 1` (idempotency guard).
   */
  private migrateIfNeeded(
    frontmatter: Record<string, unknown>,
    agentId: string,
    category: string,
    nowMs: number,
  ): { frontmatter: Record<string, unknown>; mutated: boolean } {
    const migration_count = Number(frontmatter.migration_count ?? 0);
    if (migration_count >= 2) return { frontmatter, mutated: false };

    const updates: Record<string, unknown> = {};

    // Step 1: rename v1 fields if present
    if (frontmatter.baseline_correct != null && frontmatter.baseline_accuracy_correct == null) {
      updates.baseline_accuracy_correct = frontmatter.baseline_correct;
      updates.baseline_accuracy_hallucinated = frontmatter.baseline_hallucinated ?? 0;
    }

    // Step 3: snapshot lifetime if no baseline at all (v0 case)
    const renamedHere = updates.baseline_accuracy_correct != null;
    const alreadyV2 = frontmatter.baseline_accuracy_correct != null;
    if (!renamedHere && !alreadyV2) {
      const lifetime = this.perfReader.getCountersSince(agentId, category, 0);
      updates.baseline_accuracy_correct = lifetime.correct;
      updates.baseline_accuracy_hallucinated = lifetime.hallucinated;
    }

    // Step 4: stale bound_at reset
    const boundAt = frontmatter.bound_at as string | undefined;
    if (!boundAt || (nowMs - new Date(boundAt).getTime()) > TIMEOUT_MS) {
      updates.bound_at = new Date(nowMs).toISOString();
      updates.migration_reason = 'v2_stale_baseline_reset';
    }

    updates.migration_count = 2;
    return { frontmatter: { ...frontmatter, ...updates }, mutated: true };
  }

  /**
   * Returns the canonical path for a skill file given agentId and category.
   * Uses the same normalizeSkillName logic as generate().
   */
  private resolveSkillPath(agentId: string, category: string): string {
    const skillName = normalizeSkillName(category);
    return join(this.projectRoot, '.gossip', 'agents', agentId, 'skills', `${skillName}.md`);
  }

  /**
   * Splits a skill file into its frontmatter key-value map and the body text
   * (everything after the closing ---).
   *
   * Handles simple scalar YAML (strings, numbers, inline arrays) — sufficient
   * for the snapshot fields we write and read. Does NOT need a full YAML parser
   * because the frontmatter schema is well-defined and written by this module.
   */
  private parseSkillFile(raw: string): {
    frontmatter: Record<string, string | number>;
    body: string;
  } {
    const match = raw.match(/^---\n([\s\S]*?)\n---(\n[\s\S]*)?$/);
    if (!match) {
      return { frontmatter: {}, body: raw };
    }

    const fmText = match[1];
    const body = match[2] ?? '';

    const frontmatter: Record<string, string | number> = {};
    for (const line of fmText.split('\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const rawVal = line.slice(colon + 1).trim();
      if (!key) continue;
      // Quoted strings preserve their string-ness even when the contents
      // would otherwise parse as a number — `version: "1.0"` must stay a
      // string. Strip surrounding quotes and unescape `\"` BEFORE the
      // numeric-coercion check.
      if (rawVal.length >= 2 && rawVal.startsWith('"') && rawVal.endsWith('"')) {
        frontmatter[key] = rawVal.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        continue;
      }
      // Preserve numeric values as numbers so YAML round-trips correctly
      const asNum = Number(rawVal);
      if (rawVal !== '' && !isNaN(asNum) && !rawVal.startsWith('[')) {
        frontmatter[key] = asNum;
      } else {
        frontmatter[key] = rawVal;
      }
    }

    return { frontmatter, body };
  }

  /**
   * Safely converts a value to a number, returning fallback if the result is not
   * finite (NaN, Infinity). Guards against corrupted frontmatter from manual edits.
   */
  private safeNumber(value: unknown, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Serialises a single frontmatter value to its YAML scalar form.
   *
   * - number / boolean: bare scalar via String(v) — round-trips through the
   *   parser's Number()/literal coercion.
   * - null / undefined: empty string (parser drops empty values gracefully).
   * - inline arrays already in `[a, b, c]` form: passed through unchanged
   *   for backward compat with existing skill files (the parser recognises
   *   the leading `[`).
   * - everything else (strings): wrapped in double quotes with `"` and `\`
   *   internal escaping. This is the actual fix for the deferred TODO —
   *   without quoting, a string value containing `:`, `#`, a leading `-`,
   *   or other YAML-meaningful characters would corrupt the next read.
   *   Quoting also pins the type so future fields like `version: "1.0"`
   *   stay strings instead of being silently coerced to Number 1.0.
   */
  private serializeYamlValue(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    const s = String(v);
    // Backward compat: existing skill files written by the old serializer
    // have inline arrays as `[a, b, c]`. The parser checks `startsWith('[')`
    // to skip the numeric-coercion branch, so we keep that shape unquoted.
    if (s.startsWith('[') && s.endsWith(']')) return s;
    // Quote everything else, escaping `\` and `"` so the parser's
    // un-escape pass round-trips cleanly.
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  /**
   * Serialises frontmatter + body back to a skill file and writes it atomically.
   * Preserves all existing frontmatter fields; only updated fields in the map
   * will change value.
   *
   * Atomicity: writes to a sibling tmp file then renames into place. The
   * rename is atomic on POSIX filesystems within a single mount, so a
   * crash mid-write leaves either the old contents intact or the new
   * contents fully present — never a torn file. The tmp file is cleaned
   * up on the failure path.
   */
  private writeSkillFileFromParts(
    skillPath: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): void {
    const fmLines = Object.entries(frontmatter).map(
      ([k, v]) => `${k}: ${this.serializeYamlValue(v)}`,
    );
    const content = `---\n${fmLines.join('\n')}\n---${body}`;

    // Atomic write: write to a sibling tmp, then rename into place.
    // tmp must live in the same directory so rename(2) is a single inode
    // operation rather than a cross-device copy+unlink.
    const tmpPath = `${skillPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      writeFileSync(tmpPath, content, 'utf-8');
      renameSync(tmpPath, skillPath);
    } catch (err) {
      // Best-effort tmp cleanup — never mask the original error.
      try { unlinkSync(tmpPath); } catch { /* tmp already gone */ }
      throw err;
    }
  }
}
