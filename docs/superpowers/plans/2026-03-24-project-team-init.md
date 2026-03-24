# Project-Aware Team Initialization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user opens gossipcat in a new project directory, auto-detect the project type from signals + user's first message, propose a tailored agent team from a catalog of 19 archetypes, and support team evolution as the project changes.

**Architecture:** An archetype catalog (JSON data) defines 19 project types with role compositions and detection signals. A `ProjectInitializer` scans the directory, checks available API keys, sends signals + user message + catalog to the LLM, which picks the best archetype and generates a config. A `TeamManager` handles adding/removing/modifying agents mid-session. Both integrate into `MainAgent.handleMessageCognitive()` via the existing tool-calling system.

**Tech Stack:** TypeScript, Jest, existing `ILLMProvider`, `ToolExecutor`, `AgentRegistry`

**Spec:** `docs/superpowers/specs/2026-03-24-project-team-init-design.md`

---

## Decisions from spec review

1. Archetype catalog is data (JSON), not code
2. LLM picks archetype + customizes — handles edge cases
3. First message triggers init — hybrid (prompted, not forced)
4. Team changes always require user approval
5. Original task re-processed after init via `pendingTask`
6. `keyProvider` callback bridges CLI keychain to orchestrator
7. In-flight task protection before agent removal
8. Skip option on reject — chat without agents
9. Signal summaries only sent to LLM, user confirmation first
10. `create-team` superseded, `setup-wizard` coexists

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `data/archetypes.json` | **Create** | 19 archetype definitions with signals |
| `packages/orchestrator/src/archetype-catalog.ts` | **Create** | Load catalog, score signals, match archetypes |
| `packages/orchestrator/src/project-initializer.ts` | **Create** | Scan directory, propose team via LLM, write config |
| `packages/orchestrator/src/team-manager.ts` | **Create** | Add/remove/modify agents, skill gap → team suggestion |
| `packages/orchestrator/src/types.ts` | **Modify** | Add ProjectConfig, Archetype, TeamChangeAction types |
| `packages/orchestrator/src/tool-definitions.ts` | **Modify** | Add init_project, update_team tool schemas |
| `packages/orchestrator/src/tool-router.ts` | **Modify** | Add handlers for init_project, update_team |
| `packages/orchestrator/src/main-agent.ts` | **Modify** | Add keyProvider, detect missing config, pendingTask |
| `packages/orchestrator/src/index.ts` | **Modify** | Export new modules |
| `tests/orchestrator/archetype-catalog.test.ts` | **Create** | Signal matching tests |
| `tests/orchestrator/project-initializer.test.ts` | **Create** | Init flow tests |
| `tests/orchestrator/team-manager.test.ts` | **Create** | Team evolution tests |

---

## Task 1: Types

**Files:**
- Modify: `packages/orchestrator/src/types.ts`

- [ ] **Step 1: Add new types**

```typescript
// Append to packages/orchestrator/src/types.ts

// ── Project Team Init Types ──────────────────────────────────────────────

/** Project metadata stored in .gossip/config.json */
export interface ProjectConfig {
  description: string;
  archetype: string;
  initialized: string; // ISO timestamp
}

/** An archetype role definition */
export interface ArchetypeRole {
  preset: string;
  focus: string;
}

/** Signal patterns for archetype detection */
export interface ArchetypeSignals {
  keywords: string[];
  files: string[];
  packages: string[];
}

/** A single archetype from the catalog */
export interface Archetype {
  name: string;
  description: string;
  roles: ArchetypeRole[];
  signals: ArchetypeSignals;
}

/** Action for team modification */
export interface TeamChangeAction {
  action: 'add' | 'remove' | 'modify';
  agentId?: string;
  config?: Partial<AgentConfig>;
  reason?: string;
}

/** Detected project signals from directory scan */
export interface ProjectSignals {
  language?: string;
  framework?: string;
  dependencies: string[];
  directories: string[];
  files: string[];
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc -b 2>&1 | grep -v consensus-engine.security | grep -v consensus-engine.dos | head -5`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add packages/orchestrator/src/types.ts
git commit -m "feat(types): add ProjectConfig, Archetype, TeamChangeAction for project team init"
```

---

## Task 2: Archetype catalog

**Files:**
- Create: `data/archetypes.json`
- Create: `packages/orchestrator/src/archetype-catalog.ts`
- Create: `tests/orchestrator/archetype-catalog.test.ts`

- [ ] **Step 1: Create archetypes.json with all 19 archetypes**

Create `data/archetypes.json` with the full catalog. Each entry has: name, description, roles (preset + focus), signals (keywords, files, packages). See spec for the 19 archetypes:
- solo-builder, full-stack, api-backend, frontend-craft, mobile-app, data-research, llm-ai-app, game-dev, security-ops, systems-infra, devops-platform, migration-rewrite, docs-content, monorepo-enterprise, ecommerce-fintech, realtime-collab, hardware-embedded, open-source-lib, blockchain-web3

Each archetype's `signals.keywords` should include words a user might say in their project description (e.g., game-dev has `["game", "player", "score", "snake", "puzzle", "render"]`). These are used for user-message keyword boosting.

- [ ] **Step 2: Write failing tests for ArchetypeCatalog**

```typescript
// tests/orchestrator/archetype-catalog.test.ts
import { ArchetypeCatalog } from '../../packages/orchestrator/src/archetype-catalog';

describe('ArchetypeCatalog', () => {
  let catalog: ArchetypeCatalog;

  beforeAll(() => {
    catalog = new ArchetypeCatalog();
  });

  it('should load all 19 archetypes', () => {
    expect(catalog.getAll()).toHaveLength(19);
  });

  it('should get archetype by id', () => {
    const gamedev = catalog.get('game-dev');
    expect(gamedev).toBeDefined();
    expect(gamedev!.name).toBe('Game Development');
    expect(gamedev!.roles.length).toBeGreaterThan(0);
  });

  // Signal scoring: directory signals only (weight 1x)
  it('should score game-dev highest for game directory signals', () => {
    const scores = catalog.scoreSignals({
      dependencies: ['phaser', 'typescript'],
      directories: ['assets', 'levels'],
      files: ['tsconfig.json'],
    });
    expect(scores[0].id).toBe('game-dev');
  });

  it('should score api-backend highest for API signals', () => {
    const scores = catalog.scoreSignals({
      dependencies: ['express', 'prisma', 'jsonwebtoken'],
      directories: [],
      files: ['Dockerfile', 'tsconfig.json'],
    });
    expect(scores[0].id).toBe('api-backend');
  });

  it('should score blockchain-web3 for solidity signals', () => {
    const scores = catalog.scoreSignals({
      dependencies: ['hardhat', 'ethers'],
      directories: ['contracts'],
      files: ['hardhat.config.ts'],
    });
    expect(scores[0].id).toBe('blockchain-web3');
  });

  it('should return zero scores for no signals', () => {
    const scores = catalog.scoreSignals({ dependencies: [], directories: [], files: [] });
    expect(scores.every(s => s.score === 0)).toBe(true);
  });

  // User message keyword boosting (weight 3x)
  it('should boost scores based on user message keywords', () => {
    // Empty directory but user says "game"
    const scores = catalog.scoreWithMessage(
      { dependencies: [], directories: [], files: [] },
      'I want to build a snake game in TypeScript',
    );
    expect(scores[0].id).toBe('game-dev');
    expect(scores[0].score).toBeGreaterThan(0);
  });

  it('should let user message override directory signals', () => {
    // Directory looks like API (express), but user says "game"
    const scores = catalog.scoreWithMessage(
      { dependencies: ['express'], directories: [], files: [] },
      'I want to build a multiplayer game with this server',
    );
    expect(scores[0].id).toBe('game-dev');
  });

  // Top candidates for LLM
  it('should return top 3 candidates when scores exist', () => {
    const top = catalog.getTopCandidates(
      { dependencies: ['react', 'next'], directories: ['pages'], files: ['tsconfig.json'] },
      'build a web app',
    );
    expect(top.length).toBe(3);
    expect(top[0].score).toBeGreaterThanOrEqual(top[1].score);
  });

  it('should return all 19 when all scores are zero', () => {
    const top = catalog.getTopCandidates(
      { dependencies: [], directories: [], files: [] },
      '',  // empty message too
    );
    expect(top.length).toBe(19);
  });
});
```

- [ ] **Step 3: Implement ArchetypeCatalog**

```typescript
// packages/orchestrator/src/archetype-catalog.ts
import { Archetype, ProjectSignals } from './types';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export class ArchetypeCatalog {
  private archetypes: Map<string, Archetype> = new Map();

  constructor(catalogPath?: string) {
    const path = catalogPath ?? resolve(__dirname, '..', '..', '..', 'data', 'archetypes.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Archetype>;
    for (const [id, arch] of Object.entries(raw)) {
      this.archetypes.set(id, arch);
    }
  }

  get(id: string): Archetype | undefined { return this.archetypes.get(id); }
  getAll(): Array<{ id: string } & Archetype> {
    return Array.from(this.archetypes.entries()).map(([id, a]) => ({ id, ...a }));
  }

  /**
   * Score archetypes against directory signals only (1x weight).
   * Used as the base score before user message boosting.
   */
  scoreSignals(signals: ProjectSignals): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];
    for (const [id, arch] of this.archetypes) {
      let score = 0;
      // Package/dependency matches (strongest directory signal)
      for (const dep of signals.dependencies) {
        if (arch.signals.packages.some(p => dep.toLowerCase().includes(p.toLowerCase()))) score += 3;
      }
      // Directory pattern matches
      for (const dir of signals.directories) {
        if (arch.signals.files.some(f => {
          const pattern = f.replace(/\*/g, '').replace(/\//g, '');
          return pattern && dir.toLowerCase().includes(pattern.toLowerCase());
        })) score += 2;
      }
      // File pattern matches
      for (const file of signals.files) {
        if (arch.signals.files.some(f => {
          const pattern = f.replace(/\*/g, '');
          return pattern && file.toLowerCase().includes(pattern.toLowerCase());
        })) score += 1;
      }
      results.push({ id, score });
    }
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Score archetypes with user message keyword boosting (3x weight).
   * User intent always wins over directory signals.
   */
  scoreWithMessage(signals: ProjectSignals, userMessage: string): Array<{ id: string; score: number }> {
    const baseScores = this.scoreSignals(signals);
    const words = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 2);

    for (const entry of baseScores) {
      const arch = this.archetypes.get(entry.id)!;
      for (const word of words) {
        if (arch.signals.keywords.some(k => k.toLowerCase() === word)) {
          entry.score += 3; // 3x weight for user message keywords
        }
      }
    }

    return baseScores.sort((a, b) => b.score - a.score);
  }

  /**
   * Get top archetype candidates for the LLM.
   * Returns top 3 if scores exist, ALL 19 if no signals detected.
   */
  getTopCandidates(
    signals: ProjectSignals,
    userMessage: string,
  ): Array<{ id: string; score: number; archetype: Archetype }> {
    const scores = this.scoreWithMessage(signals, userMessage);
    const hasSignals = scores.some(s => s.score > 0);

    const candidates = hasSignals ? scores.slice(0, 3) : scores;
    return candidates.map(s => ({
      ...s,
      archetype: this.archetypes.get(s.id)!,
    }));
  }
}
```

**Key design: Hybrid scoring (pre-filter for bad LLMs, full menu for no signals)**
- `scoreSignals()` — directory-only scoring (1x weight)
- `scoreWithMessage()` — adds user message keyword boosting (3x weight, user intent wins)
- `getTopCandidates()` — returns top 3 if any score > 0, returns ALL 19 if no signals (empty dir + vague message → LLM gets full menu)

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator/archetype-catalog.test.ts --verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add data/archetypes.json packages/orchestrator/src/archetype-catalog.ts tests/orchestrator/archetype-catalog.test.ts
git commit -m "feat(orchestrator): add archetype catalog with hybrid scoring (signals + user intent)"
```

---

## Task 3: Project Initializer

**Files:**
- Create: `packages/orchestrator/src/project-initializer.ts`
- Create: `tests/orchestrator/project-initializer.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/project-initializer.test.ts
import { ProjectInitializer } from '../../packages/orchestrator/src/project-initializer';

describe('ProjectInitializer', () => {
  const mockLlm = { generate: jest.fn() };
  const mockKeyProvider = jest.fn();
  let initializer: ProjectInitializer;

  beforeEach(() => {
    jest.clearAllMocks();
    initializer = new ProjectInitializer({
      llm: mockLlm as any,
      projectRoot: '/tmp/test-project',
      keyProvider: mockKeyProvider,
    });
  });

  it('should scan directory for signals', async () => {
    const signals = await initializer.scanDirectory('/tmp/test-project');
    expect(signals).toBeDefined();
    expect(signals.dependencies).toBeDefined();
    expect(signals.directories).toBeDefined();
    expect(signals.files).toBeDefined();
  });

  it('should generate team proposal from LLM', async () => {
    mockKeyProvider.mockResolvedValue('test-key');
    mockLlm.generate.mockResolvedValueOnce({
      text: JSON.stringify({
        archetype: 'game-dev',
        main_agent: { provider: 'google', model: 'gemini-2.5-pro' },
        agents: [
          { id: 'gemini-impl', provider: 'google', model: 'gemini-2.5-pro', preset: 'implementer', skills: ['typescript', 'game_logic'] },
        ],
      }),
    });

    const proposal = await initializer.proposeTeam('build a snake game in TypeScript', { dependencies: [], directories: [], files: [] });
    expect(proposal.archetype).toBe('game-dev');
    expect(proposal.agents.length).toBeGreaterThan(0);
  });

  it('should return skip result when no API keys available', async () => {
    mockKeyProvider.mockResolvedValue(null);
    const proposal = await initializer.proposeTeam('build something', { dependencies: [], directories: [], files: [] });
    expect(proposal.error).toContain('No API keys');
  });

  it('should build signal summary without exposing file contents', () => {
    const summary = initializer.buildSignalSummary({
      language: 'TypeScript',
      dependencies: ['express', 'prisma'],
      directories: ['src', 'tests'],
      files: ['package.json', 'tsconfig.json'],
    });
    expect(summary).toContain('express');
    expect(summary).toContain('TypeScript');
    expect(summary).not.toContain('scripts'); // no file contents
  });
});
```

- [ ] **Step 2: Implement ProjectInitializer**

The class uses the **hybrid approach** — signal pre-filter + LLM customization:

- `scanDirectory(root)` — checks for package.json (extracts dep names only), Cargo.toml, go.mod, etc. Bounded to 2 levels. No symlinks (lstatSync). Returns `ProjectSignals`.
- `proposeTeam(userMessage, signals)` — the core hybrid flow:
  1. Check available keys via `keyProvider` → if none, return error
  2. Load `ArchetypeCatalog`, call `getTopCandidates(signals, userMessage)`
  3. This returns **top 3** archetypes if signals exist, or **all 19** if no signals (empty dir + vague message)
  4. Send candidates + signal summary + user message to LLM
  5. LLM picks/blends archetype, adjusts roles, assigns models from available providers
  6. Parse JSON response into team proposal
  7. If user message is too vague AND no signals → LLM should return `[CHOICES]` asking "what kind of project?"
- `buildSignalSummary(signals)` — formats signals as human-readable text (dep names, dirs, files — no file contents). Shown to user for confirmation before sending to LLM.
- `writeConfig(proposal, projectRoot)` — writes `.gossip/config.json` with `project` block.
- `pendingTask: string | null` — stores original user message for re-processing after init.
- `pendingProposal: object | null` — stores the LLM's proposal for use in handleChoice after user approves.

**LLM prompt includes:**
```
You are configuring an agent team for a software project.

Project description: "{userMessage}"
Detected signals: {signalSummary}
Available API keys: {providers}

Candidate archetypes (pick one, blend, or customize):
{candidateArchetypes as JSON}

Based on the project, choose the best archetype and customize it:
- Adjust roles for this specific project
- Add project-specific skills beyond the defaults
- Assign models from available providers (strongest → hardest role)
- If the description is too vague to decide, respond with a [CHOICES] block

Respond with JSON: { archetype, main_agent: {provider, model}, agents: [{id, provider, model, preset, skills}] }
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator/project-initializer.test.ts --verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/project-initializer.ts tests/orchestrator/project-initializer.test.ts
git commit -m "feat(orchestrator): add ProjectInitializer with directory scanning and team proposal"
```

---

## Task 4: Team Manager

**Files:**
- Create: `packages/orchestrator/src/team-manager.ts`
- Create: `tests/orchestrator/team-manager.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/team-manager.test.ts
import { TeamManager } from '../../packages/orchestrator/src/team-manager';

describe('TeamManager', () => {
  const mockRegistry = {
    register: jest.fn(),
    get: jest.fn(),
    getAll: jest.fn().mockReturnValue([
      { id: 'gemini-impl', preset: 'implementer', skills: ['typescript'] },
    ]),
    remove: jest.fn(),
  };
  const mockPipeline = {
    getActiveTasks: jest.fn().mockReturnValue([]),
  };

  let manager: TeamManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = new TeamManager({
      registry: mockRegistry as any,
      pipeline: mockPipeline as any,
      projectRoot: '/tmp/test',
    });
  });

  it('should propose adding an agent with CHOICES confirmation', () => {
    const result = manager.proposeAdd({
      id: 'gemini-sec', provider: 'google', model: 'gemini-2.5-pro',
      preset: 'reviewer', skills: ['security_audit'],
    });
    expect(result.choices).toBeDefined();
    expect(result.text).toContain('gemini-sec');
  });

  it('should block removal when agent has active tasks', () => {
    mockPipeline.getActiveTasks.mockReturnValueOnce([{ id: 'task-1' }]);
    const result = manager.proposeRemove('gemini-impl');
    expect(result.choices).toBeDefined();
    expect(result.choices!.options.length).toBeGreaterThan(1); // wait + force + cancel
  });

  it('should allow removal when agent has no active tasks', () => {
    const result = manager.proposeRemove('gemini-impl');
    expect(result.choices).toBeDefined();
    expect(result.text).toContain('Remove');
  });

  it('should return error for unknown agent removal', () => {
    mockRegistry.get.mockReturnValueOnce(undefined);
    const result = manager.proposeRemove('nonexistent');
    expect(result.text).toContain('not found');
  });

  it('should detect skill gap', () => {
    const suggestion = manager.detectSkillGap('security_audit');
    expect(suggestion).toBeDefined();
    expect(suggestion!.text).toContain('security');
  });
});
```

- [ ] **Step 2: Implement TeamManager**

The class:
- `proposeAdd(config)` — returns `ToolResult` with `[CHOICES]` confirmation
- `proposeRemove(agentId)` — checks active tasks, returns appropriate `[CHOICES]`
- `proposeModify(agentId, changes)` — returns `[CHOICES]` confirmation
- `applyAdd(config)` — registers agent, writes config (does NOT start worker — caller handles that)
- `applyRemove(agentId)` — removes from registry, updates config
- `detectSkillGap(requiredSkill)` — checks registry, returns suggestion if no agent has the skill
- `detectScopeChange(conversationHistory, projectDescription)` — compares recent conversation topics against `project.description`, returns suggestion to re-evaluate team if significant divergence detected. Lightweight — only called when routing fails.
- All config writes are to `.gossip/config.json`, preserving existing fields

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator/team-manager.test.ts --verbose`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/team-manager.ts tests/orchestrator/team-manager.test.ts
git commit -m "feat(orchestrator): add TeamManager with add/remove/modify and skill gap detection"
```

---

## Task 5: Tool definitions + tool router handlers

**Files:**
- Modify: `packages/orchestrator/src/tool-definitions.ts`
- Modify: `packages/orchestrator/src/tool-router.ts`
- Modify: `tests/orchestrator/tool-router.test.ts`

- [ ] **Step 1: Add init_project and update_team to tool schemas**

```typescript
// Add to TOOL_SCHEMAS in tool-definitions.ts
init_project: {
  description: 'Initialize project with a tailored agent team based on project type',
  requiredArgs: ['description'],
  optionalArgs: ['archetype'],
},
update_team: {
  description: 'Add, remove, or modify an agent in the team (requires confirmation)',
  requiredArgs: ['action'],
  optionalArgs: ['agent_id', 'preset', 'skills'],
},
```

- [ ] **Step 2: Add init_project and update_team tool descriptions to buildToolSystemPrompt**

Add to the system prompt string:
```
init_project(description: string, archetype?: string)
  Initialize this project with a tailored agent team. The system will scan the
  directory, detect project signals, and propose a team. Use when no agents are
  configured or user wants to re-initialize.

update_team(action: "add" | "remove" | "modify", agent_id?: string, preset?: string, skills?: string[])
  Modify the agent team. Always requires user confirmation.
```

- [ ] **Step 3: Add handlers to ToolExecutor**

In `tool-router.ts`, add to the switch in `execute()`:
```typescript
case 'init_project': return this.handleInitProject(toolCall.args);
case 'update_team': return this.handleUpdateTeam(toolCall.args);
```

Implement `handleInitProject`:
- Get `ProjectInitializer` from config (new field on `ToolExecutorConfig`)
- Call `initializer.scanDirectory()`
- Call `initializer.proposeTeam(description, signals)`
- Store `initializer.pendingTask = description`
- Return proposal with `[CHOICES]`

Implement `handleUpdateTeam`:
- Get `TeamManager` from config
- Route by action: add → `proposeAdd`, remove → `proposeRemove`, modify → `proposeModify`
- Return result with `[CHOICES]`

- [ ] **Step 4: Write tests for new handlers**

Add to `tests/orchestrator/tool-router.test.ts`:
- `init_project proposes team based on description`
- `update_team add returns CHOICES confirmation`
- `update_team remove checks active tasks`

- [ ] **Step 5: Run all tests**

Run: `npx jest --testPathIgnorePatterns="consensus-e2e|cognitive-e2e|interactive-session|consensus-engine.security|consensus-engine.dos" --verbose 2>&1 | tail -10`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/tool-definitions.ts packages/orchestrator/src/tool-router.ts tests/orchestrator/tool-router.test.ts
git commit -m "feat(orchestrator): add init_project and update_team tool handlers"
```

---

## Task 6: MainAgent integration

**Files:**
- Modify: `packages/orchestrator/src/main-agent.ts`
- Modify: `tests/orchestrator/cognitive-orchestration.test.ts`

- [ ] **Step 1: Add keyProvider to MainAgentConfig**

```typescript
export interface MainAgentConfig {
  // ... existing fields ...
  keyProvider?: (provider: string) => Promise<string | null>;
}
```

- [ ] **Step 2: Initialize ProjectInitializer and TeamManager in constructor**

```typescript
private projectInitializer: ProjectInitializer;
private teamManager: TeamManager;

// In constructor:
this.projectInitializer = new ProjectInitializer({
  llm: this.llm,
  projectRoot: this.projectRoot,
  keyProvider: config.keyProvider ?? (async () => null),
});
this.teamManager = new TeamManager({
  registry: this.registry,
  pipeline: this.pipeline,
  projectRoot: this.projectRoot,
});

// Pass to toolExecutor config:
this.toolExecutor = new ToolExecutor({
  ...existingConfig,
  initializer: this.projectInitializer,
  teamManager: this.teamManager,
});
```

- [ ] **Step 3: Detect missing config in handleMessageCognitive**

At the top of `handleMessageCognitive`, before the LLM call:

```typescript
// Check if project is configured
if (this.registry.getAll().length === 0) {
  // No agents — trigger init flow
  const signals = await this.projectInitializer.scanDirectory(this.projectRoot);
  const text = typeof userMessage === 'string' ? userMessage : /* extract text */;
  this.projectInitializer.pendingTask = text;
  const proposal = await this.projectInitializer.proposeTeam(text, signals);
  if (proposal.error) {
    return { text: proposal.error, status: 'error' };
  }
  return {
    text: proposal.text,
    choices: proposal.choices,
    status: 'done',
  };
}
```

- [ ] **Step 4: Handle init approval in handleChoice**

Add to handleChoice, after existing pending state checks:

```typescript
// Project init approval
if (this.projectInitializer.pendingTask) {
  if (choiceValue === 'accept_team') {
    // Write config, start workers, re-process original task
    await this.projectInitializer.writeConfig(/* stored proposal */, this.projectRoot);
    await this.syncWorkers(async (provider) => {
      const key = this.config.keyProvider?.(provider);
      return key ?? null;
    });
    const task = this.projectInitializer.pendingTask;
    this.projectInitializer.pendingTask = null;
    return this.handleMessageCognitive(task); // Re-process original message
  }
  if (choiceValue === 'skip_setup') {
    this.projectInitializer.pendingTask = null;
    return { text: 'No agents configured. You can chat directly or run /init later.', status: 'done' };
  }
  if (choiceValue === 'modify_team') {
    this.projectInitializer.pendingTask = null;
    return { text: 'Describe what you\'d like to change and I\'ll create a new proposal.', status: 'done' };
  }
  if (choiceValue === 'manual_setup') {
    this.projectInitializer.pendingTask = null;
    return { text: 'Run `gossipcat setup` in your terminal to manually configure agents with the setup wizard.', status: 'done' };
  }
}

// Team update approval
if (this.teamManager.pendingAction) {
  // Similar pattern: apply change, sync workers if needed
}
```

- [ ] **Step 5: Add stopWorker method**

```typescript
async stopWorker(agentId: string): Promise<void> {
  const worker = this.workers.get(agentId);
  if (worker) {
    await worker.stop();
    this.workers.delete(agentId);
  }
}
```

- [ ] **Step 6: Write integration tests**

Add to `tests/orchestrator/cognitive-orchestration.test.ts`:
- `should trigger init flow when no agents configured`
- `should re-process original task after init approval`
- `should allow skip when user rejects team`
- `should handle update_team approval`

- [ ] **Step 7: Run full test suite**

Run: `npx jest --testPathIgnorePatterns="consensus-e2e|cognitive-e2e|interactive-session|consensus-engine.security|consensus-engine.dos" 2>&1 | tail -5`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add packages/orchestrator/src/main-agent.ts tests/orchestrator/cognitive-orchestration.test.ts
git commit -m "feat(orchestrator): integrate project init + team manager into MainAgent"
```

---

## Task 7: CLI integration + exports

**Files:**
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `apps/cli/src/mcp-server-sdk.ts`
- Modify: `apps/cli/src/chat.ts`

- [ ] **Step 1: Add exports**

```typescript
// Append to packages/orchestrator/src/index.ts
export { ArchetypeCatalog } from './archetype-catalog';
export { ProjectInitializer } from './project-initializer';
export type { ProjectInitializerConfig } from './project-initializer';
export { TeamManager } from './team-manager';
export type { TeamManagerConfig } from './team-manager';
```

- [ ] **Step 2: Pass keyProvider from MCP server**

In `apps/cli/src/mcp-server-sdk.ts`, when creating MainAgent, add:
```typescript
keyProvider: async (provider: string) => keychain.getKey(provider),
```

- [ ] **Step 3: Pass keyProvider from chat.ts**

Same pattern in `apps/cli/src/chat.ts` MainAgent construction.

- [ ] **Step 4: Add /init command to chat**

In the chat commands object:
```typescript
async init(args: string) {
  const description = args.trim() || undefined;
  process.stdout.write(`${c.dim}  scanning project...${c.reset}`);
  // Trigger init by calling handleMessage — cognitive mode will detect no agents
  const response = await mainAgent.handleMessage(
    description || 'initialize this project',
  );
  process.stdout.write('\r\x1b[K');
  console.log(`\n${response.text}\n`);
  if (response.choices) {
    // render choices via @clack/prompts
  }
},
```

- [ ] **Step 5: Build and test**

Run: `npx tsc -b 2>&1 | grep -v consensus-engine.security | grep -v consensus-engine.dos | head -5`
Run: `npx jest --testPathIgnorePatterns="consensus-e2e|cognitive-e2e|interactive-session|consensus-engine.security|consensus-engine.dos" 2>&1 | tail -5`

- [ ] **Step 6: Rebuild MCP bundle**

Run: `npx esbuild apps/cli/src/mcp-server-sdk.ts --bundle --platform=node --target=node22 --outfile=dist-mcp/mcp-server.js --external:ws --external:@modelcontextprotocol/sdk --tsconfig=tsconfig.json`

- [ ] **Step 7: Commit**

```bash
git add packages/orchestrator/src/index.ts apps/cli/src/mcp-server-sdk.ts apps/cli/src/chat.ts
git commit -m "feat(cli): integrate project team init into MCP server and interactive chat"
```

---

## Task 8: E2E test

**Files:**
- Create: `tests/orchestrator/project-init-e2e.test.ts`

- [ ] **Step 1: Write E2E test with real LLM**

Test the full flow:
1. Create a temp directory with a `package.json` containing game dependencies
2. Construct MainAgent pointing to that directory with no `.gossip/config.json`
3. Call `handleMessage("build a snake game")` in cognitive mode
4. Verify the response proposes a team with game-dev archetype
5. Verify the response includes `[CHOICES]` for approval
6. Clean up temp directory

- [ ] **Step 2: Run E2E test**

Run: `npx jest tests/orchestrator/project-init-e2e.test.ts --testTimeout=120000 --verbose`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add tests/orchestrator/project-init-e2e.test.ts
git commit -m "test(orchestrator): add project team init E2E test with real LLM"
```
