/**
 * SkillGenerator — generates superpowers-quality skill files per agent
 * based on competency gaps. Uses LLM with reference templates.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { ILLMProvider } from './llm-client';
import { PerformanceReader } from './performance-reader';
import { LLMMessage } from '@gossip/types';
import { ConsensusSignal } from './consensus-types';
import { normalizeSkillName } from './skill-name';

const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const KNOWN_CATEGORIES = new Set([
  'trust_boundaries', 'injection_vectors', 'input_validation', 'concurrency',
  'resource_exhaustion', 'type_safety', 'error_handling', 'data_integrity',
  'severity_calibration',
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
};

const REQUIRED_SECTIONS = ['## Iron Law', '## When This Skill Activates', '## Methodology', '## Anti-Patterns', '## Quality Gate'];

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

## Anti-Patterns

| Thought | Reality |
|---------|---------|
| "Just one quick fix" | Quick fixes mask root causes |
| "I know what's wrong" | Verify before acting |

## Quality Gate

- [ ] Root cause identified with evidence
- [ ] Fix addresses root cause, not symptom
- [ ] Tests verify the fix
`;

export class SkillGenerator {
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
      projectContext = readFileSync(bootstrapPath, 'utf-8').slice(0, 2000);
    }

    const totalDispatches = agentScoreData?.totalSignals ?? 0;
    const categoryConfirmations = findings.filter(f => f.agentId === agentId).length;
    const baselineRate = totalDispatches > 0 ? categoryConfirmations / totalDispatches : 0;

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `You are a prompt engineer specializing in AI agent skill files. You produce structured, opinionated methodology documents that dramatically improve an agent's performance on specific review tasks.

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

1. YAML frontmatter with fields: name, category (${category}), agent (${agentId}), generated, effectiveness (0.0), baseline_rate (${baselineRate.toFixed(3)}), baseline_dispatches (${totalDispatches}), post_skill_dispatches (0), version (1), mode (contextual), keywords ([${(CATEGORY_KEYWORDS[category] || [category]).join(', ')}])
2. ## Iron Law — one absolute rule (MUST/NEVER language)
3. ## When This Skill Activates — task patterns that trigger it
4. ## Methodology — 5-8 step checklist, actionable not vague
5. ## Key Patterns — important code patterns to look for
6. ## Anti-Patterns — table with columns "Thought" and "Reality"
7. ## Quality Gate — pre-report checklist with checkboxes

Requirements:
- Write with authority — MUST, NEVER, NO EXCEPTIONS
- Keep under 150 lines
- Methodology must be universal (works on any codebase)
- Key Patterns can include project-specific examples from findings`,
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

    const skillName = normalizeSkillName(category);
    const skillDir = join(this.projectRoot, '.gossip', 'agents', agentId, 'skills');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, `${skillName}.md`);
    writeFileSync(skillPath, cleaned);

    return { path: skillPath, content: cleaned };
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
    if (!content.match(/keywords:\s*\[/)) {
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
}
