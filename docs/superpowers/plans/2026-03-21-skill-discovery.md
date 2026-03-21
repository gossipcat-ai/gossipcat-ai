# Skill Discovery System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable agents to report skill gaps, the orchestrator to detect unmatched skills at dispatch time, and the system to auto-generate skeleton skills when patterns emerge.

**Architecture:** Six components — `suggest_skill` tool, skill catalog, gap tracker with skeleton generation, improved security audit skill, setup wizard workflow rules, and worker agent skill awareness. No architectural changes to existing relay/orchestrator/tool-server patterns.

**Tech Stack:** TypeScript, Jest, JSONL for append-only gap log, JSON for skill catalog.

**Spec:** `docs/superpowers/specs/2026-03-21-skill-discovery-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `packages/tools/src/skill-tools.ts` | **NEW** — SkillTools class: `suggestSkill()` appends to JSONL gap log |
| `packages/tools/src/definitions.ts` | **EDIT** — Add `SKILL_TOOLS` to `ALL_TOOLS` so LLMs see the tool |
| `packages/tools/src/tool-server.ts` | **EDIT** — Wire SkillTools, pass `callerId` from envelope |
| `packages/tools/src/index.ts` | **EDIT** — Export SkillTools and SKILL_TOOLS |
| `packages/orchestrator/src/default-skills/catalog.json` | **NEW** — Skill index with keywords for matching |
| `packages/orchestrator/src/skill-gap-tracker.ts` | **NEW** — Read gap log, threshold check, skeleton generation |
| `packages/orchestrator/src/skill-catalog.ts` | **NEW** — Load catalog, match task text against keywords, produce warnings |
| `packages/orchestrator/src/types.ts` | **EDIT** — Add `warnings: string[]` to `DispatchPlan` |
| `packages/orchestrator/src/task-dispatcher.ts` | **EDIT** — Catalog check after decompose, populate warnings |
| `packages/orchestrator/src/worker-agent.ts` | **EDIT** — Skill awareness in system prompt |
| `packages/orchestrator/src/index.ts` | **EDIT** — Export SkillGapTracker, SkillCatalog |
| `apps/cli/src/skill-catalog-check.ts` | **NEW** — Lightweight keyword-match for MCP low-level dispatch path |
| `apps/cli/src/mcp-server-sdk.ts` | **EDIT** — Catalog check on dispatch, surface suggestions in collect |
| `packages/orchestrator/src/default-skills/security-audit.md` | **EDIT** — Add 4 DoS/resource categories |
| `apps/cli/src/setup-wizard.ts` | **EDIT** — Add workflow rules section to generated gossipcat.md |
| `tests/tools/skill-tools.test.ts` | **NEW** — Tests for suggest_skill tool |
| `tests/orchestrator/skill-gap-tracker.test.ts` | **NEW** — Tests for gap tracking + skeleton gen |
| `tests/orchestrator/skill-catalog.test.ts` | **NEW** — Tests for catalog matching + warnings |

---

### Task 1: `suggest_skill` Tool — SkillTools Class

**Files:**
- Create: `packages/tools/src/skill-tools.ts`
- Test: `tests/tools/skill-tools.test.ts`

- [ ] **Step 1: Write failing test for suggestSkill**

```typescript
// tests/tools/skill-tools.test.ts
import { SkillTools } from '@gossip/tools';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillTools', () => {
  const testDir = join(tmpdir(), `gossip-skill-tools-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  let skillTools: SkillTools;

  beforeEach(() => {
    mkdirSync(gossipDir, { recursive: true });
    skillTools = new SkillTools(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates gap log file and appends suggestion', async () => {
    const result = await skillTools.suggestSkill({
      skill_name: 'dos_resilience',
      reason: 'WebSocket has no maxPayload',
      task_context: 'Reviewing relay server',
    }, 'gemini-reviewer');

    expect(result).toContain('Suggestion noted');
    expect(result).toContain('dos_resilience');
    expect(existsSync(gapLogPath)).toBe(true);

    const lines = readFileSync(gapLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe('suggestion');
    expect(entry.skill).toBe('dos_resilience');
    expect(entry.reason).toBe('WebSocket has no maxPayload');
    expect(entry.agent).toBe('gemini-reviewer');
    expect(entry.timestamp).toBeDefined();
  });

  it('appends multiple suggestions to same file', async () => {
    await skillTools.suggestSkill(
      { skill_name: 'a', reason: 'r1', task_context: 'c1' }, 'agent-1'
    );
    await skillTools.suggestSkill(
      { skill_name: 'b', reason: 'r2', task_context: 'c2' }, 'agent-2'
    );

    const lines = readFileSync(gapLogPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).skill).toBe('a');
    expect(JSON.parse(lines[1]).skill).toBe('b');
  });

  it('creates .gossip directory if it does not exist', async () => {
    rmSync(gossipDir, { recursive: true, force: true });
    const freshTools = new SkillTools(testDir);

    await freshTools.suggestSkill(
      { skill_name: 'x', reason: 'y', task_context: 'z' }, 'agent-1'
    );
    expect(existsSync(gapLogPath)).toBe(true);
  });

  it('defaults agent to "unknown" when callerId not provided', async () => {
    await skillTools.suggestSkill(
      { skill_name: 'test', reason: 'reason', task_context: 'ctx' }
    );
    const entry = JSON.parse(readFileSync(gapLogPath, 'utf-8').trim());
    expect(entry.agent).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/tools/skill-tools.test.ts --no-coverage`
Expected: FAIL — `Cannot find module '@gossip/tools'` or `SkillTools is not exported`

- [ ] **Step 3: Implement SkillTools class**

```typescript
// packages/tools/src/skill-tools.ts
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface SuggestSkillArgs {
  skill_name: string;
  reason: string;
  task_context: string;
}

export interface GapSuggestion {
  type: 'suggestion';
  skill: string;
  reason: string;
  agent: string;
  task_context: string;
  timestamp: string;
}

export interface GapResolution {
  type: 'resolution';
  skill: string;
  skeleton_path: string;
  triggered_by: number;
  timestamp: string;
}

export type GapEntry = GapSuggestion | GapResolution;

export class SkillTools {
  private readonly gapLogPath: string;

  constructor(projectRoot: string) {
    const gossipDir = join(projectRoot, '.gossip');
    if (!existsSync(gossipDir)) {
      mkdirSync(gossipDir, { recursive: true });
    }
    this.gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  }

  async suggestSkill(args: SuggestSkillArgs, callerId?: string): Promise<string> {
    const entry: GapSuggestion = {
      type: 'suggestion',
      skill: args.skill_name,
      reason: args.reason,
      agent: callerId || 'unknown',
      task_context: args.task_context,
      timestamp: new Date().toISOString(),
    };

    appendFileSync(this.gapLogPath, JSON.stringify(entry) + '\n');

    return `Suggestion noted: '${args.skill_name}'. Continue with your current skills.`;
  }
}
```

- [ ] **Step 4: Export SkillTools from package index**

In `packages/tools/src/index.ts`, add:
```typescript
export { SkillTools } from './skill-tools';
export type { SuggestSkillArgs, GapSuggestion, GapResolution, GapEntry } from './skill-tools';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/tools/skill-tools.test.ts --no-coverage`
Expected: 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/tools/src/skill-tools.ts packages/tools/src/index.ts tests/tools/skill-tools.test.ts
git commit -m "feat(tools): add SkillTools class for suggest_skill gap logging"
```

---

### Task 2: Register `suggest_skill` in Tool Definitions and ToolServer

**Files:**
- Modify: `packages/tools/src/definitions.ts:137-138`
- Modify: `packages/tools/src/tool-server.ts:1-7,22-31,45-57,81-111`

- [ ] **Step 1: Add SKILL_TOOLS to definitions.ts**

Append before the `ALL_TOOLS` line in `packages/tools/src/definitions.ts`:

```typescript
export const SKILL_TOOLS: ToolDefinition[] = [
  {
    name: 'suggest_skill',
    description: 'Suggest a skill that would help with the current task. Non-blocking — logs the suggestion and you keep working.',
    parameters: {
      type: 'object',
      properties: {
        skill_name: { type: 'string', description: 'Skill name using underscores (e.g. "dos_resilience")' },
        reason: { type: 'string', description: 'Why you need this skill' },
        task_context: { type: 'string', description: 'What you were doing when you noticed the gap' }
      },
      required: ['skill_name', 'reason', 'task_context']
    }
  }
];

export const ALL_TOOLS: ToolDefinition[] = [...FILE_TOOLS, ...SHELL_TOOLS, ...GIT_TOOLS, ...SKILL_TOOLS];
```

Replace the existing `ALL_TOOLS` line. Update the export in `packages/tools/src/index.ts` to include `SKILL_TOOLS`.

- [ ] **Step 2: Wire SkillTools into ToolServer**

In `packages/tools/src/tool-server.ts`:

1. Add import: `import { SkillTools } from './skill-tools';`
2. Add property: `private skillTools: SkillTools;`
3. In constructor, add: `this.skillTools = new SkillTools(config.projectRoot);`
4. Change `handleToolRequest` to pass `envelope.sid` to executeTool:
```typescript
result = await this.executeTool(toolName, args, envelope.sid);
```
5. Update `executeTool` signature and add case:
```typescript
async executeTool(name: string, args: Record<string, unknown>, callerId?: string): Promise<string> {
  switch (name) {
    // ... existing cases ...
    case 'suggest_skill':
      return this.skillTools.suggestSkill(
        args as { skill_name: string; reason: string; task_context: string },
        callerId
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
```

- [ ] **Step 3: Update index.ts export**

In `packages/tools/src/index.ts`, update the definitions export:
```typescript
export { ALL_TOOLS, FILE_TOOLS, SHELL_TOOLS, GIT_TOOLS, SKILL_TOOLS } from './definitions';
```

- [ ] **Step 4: Run all tools tests**

Run: `npx jest tests/tools/ --no-coverage`
Expected: All existing tests still pass + skill-tools tests pass

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src/definitions.ts packages/tools/src/tool-server.ts packages/tools/src/index.ts
git commit -m "feat(tools): register suggest_skill in definitions and tool-server"
```

---

### Task 3: Skill Catalog — catalog.json + Matching Logic

**Files:**
- Create: `packages/orchestrator/src/default-skills/catalog.json`
- Create: `packages/orchestrator/src/skill-catalog.ts`
- Test: `tests/orchestrator/skill-catalog.test.ts`

- [ ] **Step 1: Write failing test for SkillCatalog**

```typescript
// tests/orchestrator/skill-catalog.test.ts
import { SkillCatalog } from '@gossip/orchestrator';

describe('SkillCatalog', () => {
  const catalog = new SkillCatalog();

  it('loads catalog from default-skills directory', () => {
    const skills = catalog.listSkills();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.find(s => s.name === 'security_audit')).toBeDefined();
    expect(skills.find(s => s.name === 'code_review')).toBeDefined();
  });

  it('matches task text against skill keywords', () => {
    const matches = catalog.matchTask('review this WebSocket server for DoS vulnerabilities');
    const names = matches.map(m => m.name);
    expect(names).toContain('security_audit');
  });

  it('returns empty array for task with no keyword matches', () => {
    const matches = catalog.matchTask('hello world');
    expect(matches).toEqual([]);
  });

  it('checks skill coverage for an agent', () => {
    const agentSkills = ['code_review', 'debugging'];
    const warnings = catalog.checkCoverage(
      agentSkills,
      'review this code for security vulnerabilities and injection attacks'
    );
    // Agent has code_review but not security_audit — should warn
    expect(warnings.some(w => w.includes('security_audit'))).toBe(true);
  });

  it('returns no warnings when agent covers all matched skills', () => {
    const agentSkills = ['security_audit', 'code_review'];
    const warnings = catalog.checkCoverage(
      agentSkills,
      'review this code for security vulnerabilities'
    );
    expect(warnings).toEqual([]);
  });

  it('validates catalog against skill files', () => {
    const issues = catalog.validate();
    // All default skills should have catalog entries — no issues expected
    expect(issues).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/skill-catalog.test.ts --no-coverage`
Expected: FAIL — `SkillCatalog is not exported`

- [ ] **Step 3: Create catalog.json**

Write `packages/orchestrator/src/default-skills/catalog.json` with the full catalog from the spec (11 skills: security_audit, dos_resilience, code_review, testing, typescript, implementation, debugging, research, documentation, api_design, system_design).

Note: `dos_resilience` is in the catalog but has no `.md` file yet — it will be created by the gap tracker when agents suggest it. The `validate()` method should flag this as a warning but not an error.

- [ ] **Step 4: Implement SkillCatalog class**

```typescript
// packages/orchestrator/src/skill-catalog.ts
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

export interface CatalogEntry {
  name: string;
  description: string;
  keywords: string[];
  categories: string[];
}

interface CatalogData {
  version: number;
  skills: CatalogEntry[];
}

export class SkillCatalog {
  private entries: CatalogEntry[];
  private readonly skillsDir: string;

  constructor(catalogPath?: string) {
    const defaultPath = resolve(__dirname, 'default-skills', 'catalog.json');
    const raw = readFileSync(catalogPath || defaultPath, 'utf-8');
    const data: CatalogData = JSON.parse(raw);
    this.entries = data.skills;
    this.skillsDir = resolve(__dirname, 'default-skills');
  }

  listSkills(): CatalogEntry[] {
    return [...this.entries];
  }

  /** Match task text against skill keywords. Returns skills whose keywords appear in the text. */
  matchTask(taskText: string): CatalogEntry[] {
    const lower = taskText.toLowerCase();
    return this.entries.filter(entry =>
      entry.keywords.some(kw => lower.includes(kw.toLowerCase()))
    );
  }

  /**
   * Check if an agent's skills cover the skills matched by a task.
   * Returns warnings for unmatched skills.
   */
  checkCoverage(agentSkills: string[], taskText: string): string[] {
    const matched = this.matchTask(taskText);
    const warnings: string[] = [];
    for (const entry of matched) {
      if (!agentSkills.includes(entry.name)) {
        warnings.push(
          `Skill '${entry.name}' (${entry.description}) may be relevant but is not assigned to this agent. ` +
          `Add it to the agent's skills in gossip.agents.json.`
        );
      }
    }
    return warnings;
  }

  /** Validate catalog entries against actual .md files in default-skills/ */
  validate(): string[] {
    const issues: string[] = [];
    const mdFiles = readdirSync(this.skillsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', '').replace(/-/g, '_'));

    for (const file of mdFiles) {
      if (!this.entries.find(e => e.name === file)) {
        issues.push(`Skill file '${file}' has no catalog entry`);
      }
    }
    // Note: catalog entries without .md files are OK (e.g. dos_resilience
    // exists in catalog as a placeholder before the skill file is created)
    return issues;
  }
}
```

- [ ] **Step 5: Export from orchestrator index**

In `packages/orchestrator/src/index.ts`, add:
```typescript
export { SkillCatalog } from './skill-catalog';
export type { CatalogEntry } from './skill-catalog';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest tests/orchestrator/skill-catalog.test.ts --no-coverage`
Expected: 6 tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/default-skills/catalog.json packages/orchestrator/src/skill-catalog.ts packages/orchestrator/src/index.ts tests/orchestrator/skill-catalog.test.ts
git commit -m "feat(orchestrator): add SkillCatalog with keyword matching and validation"
```

---

### Task 4: Gap Tracker — Threshold Logic + Skeleton Generation

**Files:**
- Create: `packages/orchestrator/src/skill-gap-tracker.ts`
- Test: `tests/orchestrator/skill-gap-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/skill-gap-tracker.test.ts
import { SkillGapTracker } from '@gossip/orchestrator';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SkillGapTracker', () => {
  const testDir = join(tmpdir(), `gossip-gap-tracker-test-${Date.now()}`);
  const gossipDir = join(testDir, '.gossip');
  const gapLogPath = join(gossipDir, 'skill-gaps.jsonl');
  const skillsDir = join(gossipDir, 'skills');

  beforeEach(() => {
    mkdirSync(skillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeSuggestions(entries: Array<{ skill: string; agent: string; reason: string }>) {
    const lines = entries.map(e =>
      JSON.stringify({ type: 'suggestion', skill: e.skill, reason: e.reason, agent: e.agent, task_context: 'test', timestamp: new Date().toISOString() })
    ).join('\n') + '\n';
    writeFileSync(gapLogPath, lines);
  }

  it('returns empty when gap log does not exist', () => {
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.getPendingSkills()).toEqual([]);
  });

  it('does not trigger skeleton below threshold (2 suggestions, 1 agent)', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
  });

  it('does not trigger skeleton below threshold (3 suggestions, 1 agent)', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.shouldGenerate('dos_resilience')).toBe(false);
  });

  it('triggers skeleton at threshold (3 suggestions, 2 agents)', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    expect(tracker.shouldGenerate('dos_resilience')).toBe(true);
  });

  it('generates skeleton file with correct template', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'no maxPayload' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'no rate limiting' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'unbounded queue' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    const result = tracker.generateSkeleton('dos_resilience');

    expect(result.generated).toBe(true);
    expect(result.path).toBe(join(skillsDir, 'dos-resilience.md'));
    expect(existsSync(result.path!)).toBe(true);

    const content = readFileSync(result.path!, 'utf-8');
    expect(content).toContain('dos_resilience');
    expect(content).toContain('REVIEW AND EDIT BEFORE ASSIGNING');
    expect(content).toContain('no maxPayload');
    expect(content).toContain('no rate limiting');
  });

  it('appends resolution entry after generating skeleton', () => {
    writeSuggestions([
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r1' },
      { skill: 'dos_resilience', agent: 'agent-2', reason: 'r2' },
      { skill: 'dos_resilience', agent: 'agent-1', reason: 'r3' },
    ]);
    const tracker = new SkillGapTracker(testDir);
    tracker.generateSkeleton('dos_resilience');

    // Re-read — should now have resolution entry
    const tracker2 = new SkillGapTracker(testDir);
    expect(tracker2.shouldGenerate('dos_resilience')).toBe(false);
  });

  it('getSuggestionsSince filters by agent and time', () => {
    const now = Date.now();
    const lines = [
      JSON.stringify({ type: 'suggestion', skill: 'a', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now - 10000).toISOString() }),
      JSON.stringify({ type: 'suggestion', skill: 'b', reason: 'r', agent: 'agent-1', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
      JSON.stringify({ type: 'suggestion', skill: 'c', reason: 'r', agent: 'agent-2', task_context: 'c', timestamp: new Date(now + 1000).toISOString() }),
    ].join('\n') + '\n';
    writeFileSync(gapLogPath, lines);

    const tracker = new SkillGapTracker(testDir);
    const results = tracker.getSuggestionsSince('agent-1', now);
    expect(results).toHaveLength(1);
    expect(results[0].skill).toBe('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/orchestrator/skill-gap-tracker.test.ts --no-coverage`
Expected: FAIL

- [ ] **Step 3: Implement SkillGapTracker**

```typescript
// packages/orchestrator/src/skill-gap-tracker.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Types defined locally — no cross-package dependency on @gossip/tools.
// These mirror the JSONL schema written by SkillTools in @gossip/tools.

export interface GapSuggestion {
  type: 'suggestion';
  skill: string;
  reason: string;
  agent: string;
  task_context: string;
  timestamp: string;
}

export interface GapResolution {
  type: 'resolution';
  skill: string;
  skeleton_path: string;
  triggered_by: number;
  timestamp: string;
}

export type GapEntry = GapSuggestion | GapResolution;

const MAX_SCAN_LINES = 500;
const MAX_LOG_LINES = 5000;
const TRUNCATE_TO = 1000;

export class SkillGapTracker {
  private readonly gapLogPath: string;
  private readonly skillsDir: string;

  constructor(private projectRoot: string) {
    this.gapLogPath = join(projectRoot, '.gossip', 'skill-gaps.jsonl');
    this.skillsDir = join(projectRoot, '.gossip', 'skills');
  }

  /** Read the last N lines of the gap log, parsed as GapEntry[] */
  private readEntries(): GapEntry[] {
    if (!existsSync(this.gapLogPath)) return [];
    const content = readFileSync(this.gapLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const tail = lines.slice(-MAX_SCAN_LINES);
    return tail.map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    }).filter(Boolean) as GapEntry[];
  }

  /** Get all unresolved skill names that have pending suggestions */
  getPendingSkills(): string[] {
    const entries = this.readEntries();
    const resolved = new Set(
      entries.filter(e => e.type === 'resolution').map(e => e.skill)
    );
    const suggestions = entries.filter(
      (e): e is GapSuggestion => e.type === 'suggestion' && !resolved.has(e.skill)
    );
    return [...new Set(suggestions.map(s => s.skill))];
  }

  /** Check if a skill has reached the generation threshold */
  shouldGenerate(skillName: string): boolean {
    const entries = this.readEntries();
    const resolved = entries.some(e => e.type === 'resolution' && e.skill === skillName);
    if (resolved) return false;

    const suggestions = entries.filter(
      (e): e is GapSuggestion => e.type === 'suggestion' && e.skill === skillName
    );
    const uniqueAgents = new Set(suggestions.map(e => e.agent));
    return suggestions.length >= 3 && uniqueAgents.size >= 2;
  }

  /** Generate a skeleton skill file. Returns path if generated. */
  generateSkeleton(skillName: string): { generated: boolean; path?: string; message?: string } {
    if (!this.shouldGenerate(skillName)) {
      return { generated: false, message: `Threshold not met for '${skillName}'` };
    }

    const entries = this.readEntries();
    const suggestions = entries.filter(
      (e): e is GapSuggestion => e.type === 'suggestion' && e.skill === skillName
    );

    // Deduplicate reasons by agent
    const seen = new Map<string, string>();
    for (const s of suggestions) {
      if (!seen.has(s.agent)) seen.set(s.agent, s.reason);
    }

    const fileName = skillName.replace(/_/g, '-') + '.md';
    mkdirSync(this.skillsDir, { recursive: true });
    const filePath = join(this.skillsDir, fileName);

    const suggestedBy = [...seen.entries()]
      .map(([agent, reason]) => `- ${agent}: "${reason}"`)
      .join('\n');

    const content = `# ${skillName}

> Auto-generated from ${suggestions.length} agent suggestions. REVIEW AND EDIT BEFORE ASSIGNING TO AGENTS.

## Suggested By
${suggestedBy}

## What You Do
[TODO: Define what this skill covers]

## Approach
[TODO: Fill in your checklist — use the reasons above as starting points]

## Output Format
[TODO: Define expected output structure]

## Don't
[TODO: Add anti-patterns to avoid]
`;

    writeFileSync(filePath, content);

    // Append resolution entry
    const resolution: GapResolution = {
      type: 'resolution',
      skill: skillName,
      skeleton_path: `.gossip/skills/${fileName}`,
      triggered_by: suggestions.length,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this.gapLogPath, JSON.stringify(resolution) + '\n');

    // Truncate if too large
    this.truncateIfNeeded();

    return {
      generated: true,
      path: filePath,
      message: `Created draft skill '${skillName}' based on ${suggestions.length} agent suggestions. Review at .gossip/skills/${fileName} before assigning to agents.`,
    };
  }

  /** Get suggestions from a specific agent since a given timestamp */
  getSuggestionsSince(agentId: string, sinceMs: number): GapSuggestion[] {
    return this.readEntries().filter(
      (e): e is GapSuggestion =>
        e.type === 'suggestion' &&
        e.agent === agentId &&
        new Date(e.timestamp).getTime() >= sinceMs
    );
  }

  /** Check all pending skills and generate skeletons for any that hit threshold */
  checkAndGenerate(): string[] {
    const messages: string[] = [];
    for (const skill of this.getPendingSkills()) {
      const result = this.generateSkeleton(skill);
      if (result.generated && result.message) {
        messages.push(result.message);
      }
    }
    return messages;
  }

  private truncateIfNeeded(): void {
    if (!existsSync(this.gapLogPath)) return;
    const content = readFileSync(this.gapLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_LOG_LINES) {
      writeFileSync(this.gapLogPath, lines.slice(-TRUNCATE_TO).join('\n') + '\n');
    }
  }
}
```

- [ ] **Step 4: Export from orchestrator index**

In `packages/orchestrator/src/index.ts`, add:
```typescript
export { SkillGapTracker } from './skill-gap-tracker';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest tests/orchestrator/skill-gap-tracker.test.ts --no-coverage`
Expected: 7 tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/skill-gap-tracker.ts packages/orchestrator/src/index.ts tests/orchestrator/skill-gap-tracker.test.ts
git commit -m "feat(orchestrator): add SkillGapTracker with threshold-based skeleton generation"
```

---

### Task 5: Integrate Catalog Check into TaskDispatcher

**Files:**
- Modify: `packages/orchestrator/src/types.ts:35-39`
- Modify: `packages/orchestrator/src/task-dispatcher.ts`
- Modify: `tests/orchestrator/task-dispatcher.test.ts`

- [ ] **Step 1: Add `warnings` field to DispatchPlan**

In `packages/orchestrator/src/types.ts`, change `DispatchPlan`:
```typescript
export interface DispatchPlan {
  originalTask: string;
  subTasks: SubTask[];
  strategy: 'single' | 'parallel' | 'sequential';
  warnings?: string[];
}
```

- [ ] **Step 2: Write failing test for catalog warnings**

Append to `tests/orchestrator/task-dispatcher.test.ts`:
```typescript
it('returns warnings field in dispatch plan', async () => {
  const dispatcher = new TaskDispatcher(createMockLLM(), new AgentRegistry());
  const plan = await dispatcher.decompose('simple task');
  expect(plan.warnings).toBeDefined();
  expect(Array.isArray(plan.warnings)).toBe(true);
});

it('warns when required skill has no agent', async () => {
  const registry = new AgentRegistry();
  registry.register({ id: 'py', provider: 'local', model: 'qwen', skills: ['python'] });

  const dispatcher = new TaskDispatcher(createMockLLM(), registry);
  const plan = await dispatcher.decompose('simple task'); // needs 'typescript'
  dispatcher.assignAgents(plan);

  // typescript is required but no agent has it
  expect(plan.warnings.some(w => w.includes('typescript'))).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest tests/orchestrator/task-dispatcher.test.ts --no-coverage`
Expected: FAIL — `plan.warnings` is undefined

- [ ] **Step 4: Update TaskDispatcher to include warnings**

In `packages/orchestrator/src/task-dispatcher.ts`:

1. Import SkillCatalog: `import { SkillCatalog } from './skill-catalog';`
2. Add optional catalog to constructor:
```typescript
constructor(
  private llm: ILLMProvider,
  private registry: AgentRegistry,
  private catalog?: SkillCatalog
) {}
```
3. In `decompose()`, initialize `warnings: []` in the returned plan.
4. In `assignAgents()`, after assigning, check for unmatched skills:
```typescript
assignAgents(plan: DispatchPlan): DispatchPlan {
  for (const subTask of plan.subTasks) {
    const match = this.registry.findBestMatch(subTask.requiredSkills);
    if (match) {
      subTask.assignedAgent = match.id;
    } else {
      // Check if skill exists in catalog
      for (const skill of subTask.requiredSkills) {
        const hasAgent = this.registry.findBySkill(skill).length > 0;
        if (!hasAgent) {
          plan.warnings.push(
            `Skill '${skill}' is required but no agent has it assigned. ` +
            `Add it to an agent's skills in gossip.agents.json.`
          );
        }
      }
    }
  }
  return plan;
}
```

- [ ] **Step 5: Fix existing tests — add warnings to expected plans**

Update the fallback return in `decompose()` to include `warnings: []`.

- [ ] **Step 6: Run all task-dispatcher tests**

Run: `npx jest tests/orchestrator/task-dispatcher.test.ts --no-coverage`
Expected: All 9 tests PASS

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/types.ts packages/orchestrator/src/task-dispatcher.ts tests/orchestrator/task-dispatcher.test.ts
git commit -m "feat(orchestrator): catalog check in TaskDispatcher with warnings"
```

---

### Task 6: MCP Server — Catalog Check on Dispatch + Surface Suggestions in Collect

**Files:**
- Create: `apps/cli/src/skill-catalog-check.ts`
- Modify: `apps/cli/src/mcp-server-sdk.ts:144-164,204-236`

- [ ] **Step 1: Create skill-catalog-check.ts**

```typescript
// apps/cli/src/skill-catalog-check.ts
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface CatalogEntry {
  name: string;
  keywords: string[];
  description: string;
}

interface CatalogData {
  skills: CatalogEntry[];
}

/**
 * Lightweight keyword-match for the low-level dispatch path.
 * Scans task text for catalog keywords and warns if the assigned agent
 * doesn't have the matching skill.
 */
export function checkSkillCoverage(
  agentId: string,
  agentSkills: string[],
  taskText: string,
  projectRoot: string
): string[] {
  // Try to find catalog.json — bundled in orchestrator package
  const catalogPaths = [
    resolve(projectRoot, 'node_modules', '@gossip', 'orchestrator', 'dist', 'default-skills', 'catalog.json'),
    resolve(projectRoot, 'packages', 'orchestrator', 'src', 'default-skills', 'catalog.json'),
  ];

  let catalog: CatalogData | null = null;
  for (const p of catalogPaths) {
    if (existsSync(p)) {
      catalog = JSON.parse(readFileSync(p, 'utf-8'));
      break;
    }
  }
  if (!catalog) return [];

  const lower = taskText.toLowerCase();
  const warnings: string[] = [];

  for (const entry of catalog.skills) {
    const matched = entry.keywords.some(kw => lower.includes(kw.toLowerCase()));
    if (matched && !agentSkills.includes(entry.name)) {
      warnings.push(
        `Agent '${agentId}' may need skill '${entry.name}' (${entry.description}) for this task.`
      );
    }
  }

  return warnings;
}
```

- [ ] **Step 2: Integrate into MCP server dispatch handlers**

In `apps/cli/src/mcp-server-sdk.ts`, in the `gossip_dispatch` handler (after `loadSkills`):

```typescript
// After line 154 (const skillsContent = loadSkills(...)):
const { checkSkillCoverage } = await import('./skill-catalog-check');
const { configToAgentConfigs, loadConfig, findConfigPath } = await import('./config');
const cfgPath = findConfigPath();
const agentSkills = cfgPath
  ? configToAgentConfigs(loadConfig(cfgPath)).find(a => a.id === agent_id)?.skills || []
  : [];
const skillWarnings = checkSkillCoverage(agent_id, agentSkills, task, process.cwd());
```

Store `skillWarnings` on the task entry:
```typescript
const entry: any = { id: taskId, agentId: agent_id, task, status: 'running', startedAt: Date.now(), skillWarnings };
```

Do the same in `gossip_dispatch_parallel`.

- [ ] **Step 3: Surface suggestions and warnings in gossip_collect**

In `apps/cli/src/mcp-server-sdk.ts`, in the `gossip_collect` handler, after building the result string:

```typescript
// After line 228-230, where result strings are built:
const results = targets.map((t: any) => {
  const dur = t.completedAt ? `${t.completedAt - t.startedAt}ms` : 'running';
  let text: string;
  if (t.status === 'completed') text = `[${t.id}] ${t.agentId} (${dur}):\n${t.result}`;
  else if (t.status === 'failed') text = `[${t.id}] ${t.agentId} (${dur}): ERROR: ${t.error}`;
  else text = `[${t.id}] ${t.agentId}: still running...`;

  // Append skill warnings
  if (t.skillWarnings?.length) {
    text += `\n\n⚠️ Skill coverage gaps:\n${t.skillWarnings.map((w: string) => `  - ${w}`).join('\n')}`;
  }

  // Append skill suggestions from gap log
  if (t.status !== 'running') {
    try {
      const { SkillGapTracker } = await import('@gossip/orchestrator');
      const tracker = new SkillGapTracker(process.cwd());
      const suggestions = tracker.getSuggestionsSince(t.agentId, t.startedAt);
      if (suggestions.length) {
        text += `\n\n💡 Skills suggested by ${t.agentId}:\n` +
          suggestions.map((s: any) => `  - ${s.skill}: ${s.reason}`).join('\n');
      }
      // Check for skeleton generation
      const skeletonMessages = tracker.checkAndGenerate();
      if (skeletonMessages.length) {
        text += '\n\n📝 ' + skeletonMessages.join('\n📝 ');
      }
    } catch { /* orchestrator not available — skip */ }
  }

  return text;
});
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npx jest --no-coverage`
Expected: All 142+ tests pass

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/skill-catalog-check.ts apps/cli/src/mcp-server-sdk.ts
git commit -m "feat(mcp): catalog check on dispatch + surface suggestions in collect"
```

---

### Task 7: Worker Agent — Skill Awareness Prompt

**Files:**
- Modify: `packages/orchestrator/src/worker-agent.ts:46-53`

- [ ] **Step 1: Update worker system prompt**

In `packages/orchestrator/src/worker-agent.ts`, replace the system prompt at line 49-50:

```typescript
// Old:
content: `You are a skilled developer agent. Complete the assigned task using the available tools. Be concise and focused.${skillsContent || ''}${context ? `\n\nContext:\n${context}` : ''}`,

// New:
content: `You are a skilled developer agent. Complete the assigned task using the available tools. Be concise and focused.

If you encounter patterns or domains that your current skills don't cover adequately, call suggest_skill with the skill name and why you need it. This won't give you the skill now — it helps the system learn what skills are missing for future tasks.

Examples of when to suggest:
- You see WebSocket code but have no DoS/resilience checklist
- You see database queries but have no SQL optimization skill
- You see CI/CD config but have no deployment skill

Do not stop working to suggest skills. Note the gap, call suggest_skill, keep going with your best judgment.${skillsContent || ''}${context ? `\n\nContext:\n${context}` : ''}`,
```

- [ ] **Step 2: Run worker-agent tests**

Run: `npx jest tests/orchestrator/worker-agent.test.ts --no-coverage`
Expected: All existing tests pass

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/worker-agent.ts
git commit -m "feat(orchestrator): teach workers about suggest_skill tool"
```

---

### Task 8: Security Audit Skill — Add DoS/Resource Categories

**Files:**
- Modify: `packages/orchestrator/src/default-skills/security-audit.md`

- [ ] **Step 1: Append 4 new categories**

After item 8 in the `## Approach` section of `security-audit.md`, add:

```markdown
9. **DoS / Resource exhaustion** — Are there payload size limits on all inputs? Connection caps? Rate limiting on endpoints and tool execution? Unbounded queues, maps, or arrays that grow without TTL-based cleanup?
10. **Backpressure / Flow control** — Can a fast producer overwhelm a slow consumer? Are there timeouts on all async operations? TTL enforcement on messages? What happens when a buffer fills up — does it drop, block, or crash?
11. **WebSocket / Network** — Origin validation on upgrade requests? Message size limits (maxPayload)? Auth verification on reconnect? Connection rate limiting? Presence/identity spoofing via forged sender IDs?
12. **Resource cleanup** — Are timers cleared on shutdown? Connections closed? Maps and caches pruned with TTL? What happens to in-flight tasks when a worker disconnects mid-execution?
```

- [ ] **Step 2: Commit**

```bash
git add packages/orchestrator/src/default-skills/security-audit.md
git commit -m "feat(skills): add DoS, backpressure, WebSocket, resource cleanup categories to security-audit"
```

---

### Task 9: Setup Wizard — Workflow Rules

**Files:**
- Modify: `apps/cli/src/setup-wizard.ts:253-298`

- [ ] **Step 1: Add workflow rules section to generated gossipcat.md**

In `apps/cli/src/setup-wizard.ts`, in the template string that generates the gossipcat.md file (starting at line 253), append after the existing "Skills & agents" section:

```typescript
// After line 297 (`Skills auto-inject from agent config...`), add:

## When to Use Multi-Agent Dispatch (REQUIRED)

These tasks MUST use parallel multi-agent dispatch. Never use a single agent or Explore subagent.

| Task Type | Why Multi-Agent | Split Strategy |
|-----------|----------------|----------------|
| Security review | Different agents catch different vulnerability classes | Split by package |
| Code review | Cross-validation finds bugs single reviewers miss | Split by concern (logic, style, perf) |
| Bug investigation | Competing hypotheses tested in parallel | One agent per hypothesis |
| Architecture review | Multiple perspectives on trade-offs | Split by dimension (scale, security, DX) |

### Single agent is fine for:
- Quick lookups ("what does function X do?")
- Simple implementation tasks
- Running tests
- File reads / grep searches

### Pattern:
\`\`\`
gossip_dispatch_parallel(tasks: [
  {agent_id: "<reviewer>", task: "Review packages/relay/ for <concern>"},
  {agent_id: "<tester>", task: "Review packages/tools/ for <concern>"}
])
Agent(model: "sonnet", prompt: "Review packages/orchestrator/ for <concern>", run_in_background: true)
\`\`\`
Then synthesize all results — cross-reference findings, deduplicate, resolve conflicts.
```

- [ ] **Step 2: Also update the existing .claude/rules/gossipcat.md in this repo**

Apply the same workflow rules section to `.claude/rules/gossipcat.md` so our current project benefits immediately (not just future `gossipcat setup` runs).

- [ ] **Step 3: Run CLI tests**

Run: `npx jest tests/cli/ --no-coverage`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/setup-wizard.ts .claude/rules/gossipcat.md
git commit -m "feat(cli): add multi-agent workflow rules to setup wizard output"
```

---

### Task 10: .gitignore + Final Integration Test

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Verify .gossip/ is already gitignored**

Check `.gitignore` — `.gossip/` is already on line 10. The `skill-gaps.jsonl` file lives inside `.gossip/`, so it's already covered. No change needed.

- [ ] **Step 2: Run full test suite**

Run: `npx jest --no-coverage`
Expected: All tests pass (original 142 + new ~17 = ~159)

- [ ] **Step 3: Build MCP server to verify no compilation errors**

Run: `npm run build:mcp`
Expected: Build succeeds

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If any unstaged changes, add and commit
```

---

## Execution Order

Task 2 depends on Task 1 (creates the file Task 2 imports). Tasks 3, 4, 7, 8, 9 are independent of each other and can be parallelized. Tasks 5-6 depend on Tasks 3-4. Task 10 runs last.

```
Task 1 (SkillTools) → Task 2 (Register tool) ──┐
Task 3 (Catalog) ──────────────────────────────┼──→ Task 5 (TaskDispatcher) ──→ Task 10 (Integration)
Task 4 (Gap Tracker) ─────────────────────────┘    Task 6 (MCP Server) ──────→ Task 10
Task 7 (Worker prompt) ──────────────────────────────────────────────────────→ Task 10
Task 8 (Security skill) ─────────────────────────────────────────────────────→ Task 10
Task 9 (Setup wizard) ───────────────────────────────────────────────────────→ Task 10
```
