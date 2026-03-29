# Dashboard Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local web dashboard to the relay server with auth, overview/agents tabs, WebSocket live events, and API routes that read from `.gossip/` files.

**Architecture:** Extend the existing `RelayServer` HTTP handler with dashboard routes. Auth uses a shared secret from `.gossip/dashboard-key` validated via POST (not GET — security fix). Dashboard is vanilla HTML/CSS/JS bundled into a single file by esbuild, served as static assets. WebSocket broadcasts `DashboardEvent` objects to connected dashboard clients on a separate upgrade path from agent connections.

**Tech Stack:** TypeScript (relay package), vanilla HTML/CSS/JS (dashboard client), esbuild (bundler), Jest (tests)

**Spec:** `docs/specs/2026-03-29-dashboard-design.md`

**Security fixes from agent review (applied throughout):**
- Auth must be POST not GET (secret in URL is a security issue)
- Key comparison must use `timingSafeEqual`
- `/dashboard/api/memory/:agentId` needs allowlist validation (path traversal)
- WebSocket needs upgrade-path splitting from agent connections
- Add empty-state handling for fresh projects (all APIs return gracefully)
- CSRF: use `SameSite=Strict` on session cookie

---

## File Structure

### New files (relay package)

| File | Responsibility |
|------|---------------|
| `packages/relay/src/dashboard/auth.ts` | Key generation, POST validation, session cookie management |
| `packages/relay/src/dashboard/routes.ts` | HTTP route handler — dispatches `/dashboard/*` requests |
| `packages/relay/src/dashboard/api-overview.ts` | `GET /dashboard/api/overview` — stat counts |
| `packages/relay/src/dashboard/api-agents.ts` | `GET /dashboard/api/agents` — agent scores + configs |
| `packages/relay/src/dashboard/api-skills.ts` | `GET /dashboard/api/skills` + `POST /dashboard/api/skills/bind` |
| `packages/relay/src/dashboard/api-memory.ts` | `GET /dashboard/api/memory/:agentId` — agent knowledge files |
| `packages/relay/src/dashboard/ws.ts` | Dashboard WebSocket manager — separate upgrade path |
| `packages/relay/src/dashboard/index.ts` | Re-exports |

### New files (dashboard client)

| File | Responsibility |
|------|---------------|
| `packages/dashboard/src/index.html` | SPA shell — tab nav, auth gate, containers |
| `packages/dashboard/src/style.css` | Deep purple theme — design tokens from spec |
| `packages/dashboard/src/app.js` | Tab routing, WebSocket client, API fetch helpers |
| `packages/dashboard/src/tabs/overview.js` | Overview tab — stat cards, agent scores, activity timeline |
| `packages/dashboard/src/tabs/agents.js` | Agents tab — per-agent detail cards |
| `packages/dashboard/package.json` | Package config |
| `packages/dashboard/build.js` | esbuild bundler → `dist-dashboard/index.html` |

### Modified files

| File | Change |
|------|--------|
| `packages/relay/src/server.ts` | Add dashboard config, route `/dashboard/*` to handler, split WebSocket upgrade path |
| `packages/relay/src/index.ts` | Re-export dashboard types |
| `packages/relay/package.json` | Add dependency on `@gossip/orchestrator` (for PerformanceReader, SkillIndex) |
| `package.json` | Add `packages/dashboard` to workspaces, add `build:dashboard` script |
| `jest.config.base.js` | Add `@gossip/dashboard` mapper (not needed for Phase 1 tests, but forward-looking) |

### Test files

| File | Tests |
|------|-------|
| `tests/relay/dashboard-auth.test.ts` | Key gen, POST auth, session cookies, timing-safe comparison, invalid keys |
| `tests/relay/dashboard-routes.test.ts` | Route dispatch, 404 handling, session guard, CORS |
| `tests/relay/dashboard-api.test.ts` | Overview, agents, skills, memory API responses + empty state |
| `tests/relay/dashboard-ws.test.ts` | WebSocket upgrade, event broadcast, reconnection |

---

## Task 1: Dashboard Auth Module

**Files:**
- Create: `packages/relay/src/dashboard/auth.ts`
- Test: `tests/relay/dashboard-auth.test.ts`

- [ ] **Step 1: Write failing tests for key generation and validation**

```typescript
// tests/relay/dashboard-auth.test.ts
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('DashboardAuth', () => {
  let projectRoot: string;
  let auth: DashboardAuth;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    auth = new DashboardAuth(projectRoot);
  });

  describe('key management', () => {
    it('generates a 32-char hex key on first init', () => {
      auth.init();
      const keyPath = join(projectRoot, '.gossip', 'dashboard-key');
      expect(existsSync(keyPath)).toBe(true);
      const key = readFileSync(keyPath, 'utf-8').trim();
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    });

    it('reuses existing key on subsequent inits', () => {
      auth.init();
      const key1 = auth.getKey();
      const auth2 = new DashboardAuth(projectRoot);
      auth2.init();
      expect(auth2.getKey()).toBe(key1);
    });

    it('regenerates key when forced', () => {
      auth.init();
      const key1 = auth.getKey();
      auth.regenerateKey();
      expect(auth.getKey()).not.toBe(key1);
      expect(auth.getKey()).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('session management', () => {
    it('creates a session token on valid key', () => {
      auth.init();
      const token = auth.createSession(auth.getKey());
      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
    });

    it('returns null on invalid key', () => {
      auth.init();
      const token = auth.createSession('wrong-key');
      expect(token).toBeNull();
    });

    it('validates session tokens', () => {
      auth.init();
      const token = auth.createSession(auth.getKey())!;
      expect(auth.validateSession(token)).toBe(true);
      expect(auth.validateSession('bogus')).toBe(false);
    });

    it('uses timing-safe comparison for key validation', () => {
      auth.init();
      // Different length keys should still not throw (hashed to fixed length)
      expect(auth.createSession('')).toBeNull();
      expect(auth.createSession('short')).toBeNull();
      expect(auth.createSession('a'.repeat(100))).toBeNull();
    });

    it('expires sessions after TTL', () => {
      jest.useFakeTimers();
      auth.init();
      const token = auth.createSession(auth.getKey())!;
      expect(auth.validateSession(token)).toBe(true);

      // Advance past 24h TTL
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      expect(auth.validateSession(token)).toBe(false);

      jest.useRealTimers();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-auth.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/auth`

- [ ] **Step 3: Implement DashboardAuth**

```typescript
// packages/relay/src/dashboard/auth.ts
import { randomBytes, timingSafeEqual, createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';

const KEY_LENGTH = 16; // 16 bytes = 32 hex chars
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface Session {
  token: string;
  expiresAt: number;
}

export class DashboardAuth {
  private keyPath: string;
  private key: string = '';
  private sessions: Map<string, Session> = new Map();

  constructor(private projectRoot: string) {
    this.keyPath = join(projectRoot, '.gossip', 'dashboard-key');
  }

  init(): void {
    if (existsSync(this.keyPath)) {
      this.key = readFileSync(this.keyPath, 'utf-8').trim();
      if (this.key.length === KEY_LENGTH * 2) return;
    }
    this.regenerateKey();
  }

  regenerateKey(): void {
    this.key = randomBytes(KEY_LENGTH).toString('hex');
    const dir = dirname(this.keyPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.keyPath, this.key + '\n', { mode: 0o600 });
    this.sessions.clear(); // invalidate all sessions
  }

  getKey(): string {
    return this.key;
  }

  /** Returns first 8 chars for display in CLI boot message */
  getKeyPrefix(): string {
    return this.key.slice(0, 8);
  }

  createSession(candidateKey: string): string | null {
    if (!candidateKey || typeof candidateKey !== 'string') return null;
    // Hash both to fixed length — avoids timing oracle from length comparison
    const a = createHash('sha256').update(candidateKey).digest();
    const b = createHash('sha256').update(this.key).digest();
    if (!timingSafeEqual(a, b)) return null;

    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { token, expiresAt: Date.now() + SESSION_TTL_MS });
    return token;
  }

  validateSession(token: string): boolean {
    if (!token || typeof token !== 'string') return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-auth.test.ts --no-coverage`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/auth.ts tests/relay/dashboard-auth.test.ts
git commit -m "feat(dashboard): auth module — key gen, timing-safe validation, session management"
```

---

## Task 2: Dashboard WebSocket Manager

**Files:**
- Create: `packages/relay/src/dashboard/ws.ts`
- Test: `tests/relay/dashboard-ws.test.ts`

- [ ] **Step 1: Write failing tests for WebSocket manager**

```typescript
// tests/relay/dashboard-ws.test.ts
import { DashboardWs, DashboardEvent } from '@gossip/relay/dashboard/ws';
import WebSocket from 'ws';

describe('DashboardWs', () => {
  let manager: DashboardWs;

  beforeEach(() => {
    manager = new DashboardWs();
  });

  it('tracks connected clients', () => {
    const mockWs = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    manager.addClient(mockWs);
    expect(manager.clientCount).toBe(1);
  });

  it('removes disconnected clients', () => {
    const mockWs = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    manager.addClient(mockWs);
    manager.removeClient(mockWs);
    expect(manager.clientCount).toBe(0);
  });

  it('broadcasts events to all connected clients', () => {
    const ws1 = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    const ws2 = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    manager.addClient(ws1);
    manager.addClient(ws2);

    const event: DashboardEvent = {
      type: 'task_dispatched',
      timestamp: new Date().toISOString(),
      data: { agentId: 'test', task: 'review code' },
    };
    manager.broadcast(event);

    const expected = JSON.stringify(event);
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
  });

  it('skips clients with non-OPEN readyState', () => {
    const ws1 = { readyState: WebSocket.OPEN, send: jest.fn() } as any;
    const ws2 = { readyState: WebSocket.CLOSED, send: jest.fn() } as any;
    manager.addClient(ws1);
    manager.addClient(ws2);

    manager.broadcast({
      type: 'task_completed',
      timestamp: new Date().toISOString(),
      data: {},
    });

    expect(ws1.send).toHaveBeenCalled();
    expect(ws2.send).not.toHaveBeenCalled();
  });

  it('handles send errors gracefully', () => {
    const ws1 = {
      readyState: WebSocket.OPEN,
      send: jest.fn(() => { throw new Error('broken pipe'); }),
    } as any;
    manager.addClient(ws1);

    // Should not throw
    expect(() => manager.broadcast({
      type: 'agent_connected',
      timestamp: new Date().toISOString(),
      data: { agentId: 'test' },
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-ws.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/ws`

- [ ] **Step 3: Implement DashboardWs**

```typescript
// packages/relay/src/dashboard/ws.ts
import { WebSocket } from 'ws';

export interface DashboardEvent {
  type: 'task_dispatched' | 'task_completed' | 'task_failed'
      | 'consensus_started' | 'consensus_complete'
      | 'skill_changed' | 'agent_connected' | 'agent_disconnected';
  timestamp: string;
  data: Record<string, unknown>;
}

export class DashboardWs {
  private clients: Set<WebSocket> = new Set();

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  broadcast(event: DashboardEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(payload); } catch { /* client gone */ }
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-ws.test.ts --no-coverage`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/ws.ts tests/relay/dashboard-ws.test.ts
git commit -m "feat(dashboard): WebSocket manager — broadcast events to dashboard clients"
```

---

## Task 3: Overview API Endpoint

**Files:**
- Create: `packages/relay/src/dashboard/api-overview.ts`
- Test: `tests/relay/dashboard-api.test.ts`

- [ ] **Step 1: Write failing tests for overview API**

```typescript
// tests/relay/dashboard-api.test.ts
import { overviewHandler } from '@gossip/relay/dashboard/api-overview';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Overview API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns zero counts for fresh project', async () => {
    const result = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0 });
    expect(result).toEqual({
      agentsOnline: 0,
      relayCount: 0,
      nativeCount: 0,
      consensusRuns: 0,
      totalFindings: 0,
      confirmedFindings: 0,
      totalSignals: 0,
    });
  });

  it('counts agents by type', async () => {
    const configs = [
      { id: 'a', provider: 'anthropic', model: 'm', skills: [], native: true },
      { id: 'b', provider: 'google', model: 'm', skills: [] },
      { id: 'c', provider: 'google', model: 'm', skills: [] },
    ];
    const result = await overviewHandler(projectRoot, { agentConfigs: configs as any, relayConnections: 2 });
    expect(result.agentsOnline).toBe(3);
    expect(result.nativeCount).toBe(1);
    expect(result.relayCount).toBe(2);
  });

  it('counts signals from agent-performance.jsonl', async () => {
    const signals = [
      { type: 'consensus', signal: 'agreement', agentId: 'a', evidence: 'x', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'agreement', agentId: 'b', evidence: 'y', timestamp: new Date().toISOString() },
      { type: 'consensus', signal: 'hallucination_caught', agentId: 'a', evidence: 'z', timestamp: new Date().toISOString() },
    ];
    writeFileSync(
      join(projectRoot, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );

    const result = await overviewHandler(projectRoot, { agentConfigs: [], relayConnections: 0 });
    expect(result.totalSignals).toBe(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/api-overview`

- [ ] **Step 3: Implement overviewHandler**

```typescript
// packages/relay/src/dashboard/api-overview.ts
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AgentConfigLike {
  id: string;
  native?: boolean;
}

interface OverviewContext {
  agentConfigs: AgentConfigLike[];
  relayConnections: number;
}

export interface OverviewResponse {
  agentsOnline: number;
  relayCount: number;
  nativeCount: number;
  consensusRuns: number;
  totalFindings: number;
  confirmedFindings: number;
  totalSignals: number;
}

export async function overviewHandler(projectRoot: string, ctx: OverviewContext): Promise<OverviewResponse> {
  const nativeCount = ctx.agentConfigs.filter(a => a.native).length;
  const relayCount = ctx.relayConnections;
  const agentsOnline = ctx.agentConfigs.length;

  let totalSignals = 0;
  let totalFindings = 0;
  let confirmedFindings = 0;
  let consensusRuns = 0;

  // Count signals
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (existsSync(perfPath)) {
    try {
      const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
      totalSignals = lines.length;
    } catch { /* empty */ }
  }

  // Count consensus runs from consensus-history.jsonl (flat file, per spec)
  const historyIndexPath = join(projectRoot, '.gossip', 'consensus-history.jsonl');
  if (existsSync(historyIndexPath)) {
    try {
      const lines = readFileSync(historyIndexPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          consensusRuns++;
          totalFindings += (entry.confirmed ?? 0) + (entry.disputed ?? 0)
            + (entry.unverified ?? 0) + (entry.unique ?? 0) + (entry.newFindings ?? 0);
          confirmedFindings += entry.confirmed ?? 0;
        } catch { /* skip malformed */ }
      }
    } catch { /* empty */ }
  }

  return { agentsOnline, relayCount, nativeCount, consensusRuns, totalFindings, confirmedFindings, totalSignals };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/api-overview.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): overview API — stat counts from .gossip files"
```

---

## Task 4: Agents API Endpoint

**Files:**
- Create: `packages/relay/src/dashboard/api-agents.ts`
- Modify: `tests/relay/dashboard-api.test.ts` (append)

- [ ] **Step 1: Write failing tests for agents API**

Append to `tests/relay/dashboard-api.test.ts`:

```typescript
import { agentsHandler } from '@gossip/relay/dashboard/api-agents';

describe('Agents API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns agent configs with default scores for fresh project', async () => {
    const configs = [
      { id: 'sonnet-reviewer', provider: 'anthropic' as const, model: 'claude-sonnet-4-6', preset: 'reviewer', skills: ['code_review'], native: true },
    ];
    const result = await agentsHandler(projectRoot, configs);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('sonnet-reviewer');
    expect(result[0].native).toBe(true);
    expect(result[0].scores.accuracy).toBe(0.5); // default
  });

  it('reads real scores from agent-performance.jsonl', async () => {
    const configs = [
      { id: 'agent-a', provider: 'anthropic' as const, model: 'm', skills: [] },
    ];
    // Write some signals to boost accuracy
    const signals = Array.from({ length: 5 }, () => ({
      type: 'consensus', signal: 'agreement', agentId: 'agent-a',
      evidence: 'x', timestamp: new Date().toISOString(),
    }));
    writeFileSync(
      join(projectRoot, '.gossip', 'agent-performance.jsonl'),
      signals.map(s => JSON.stringify(s)).join('\n') + '\n'
    );

    const result = await agentsHandler(projectRoot, configs);
    expect(result[0].scores.accuracy).toBeGreaterThan(0.5);
    expect(result[0].scores.agreements).toBe(5);
  });

  it('returns empty array when no agents configured', async () => {
    const result = await agentsHandler(projectRoot, []);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/api-agents`

- [ ] **Step 3: Implement agentsHandler**

```typescript
// packages/relay/src/dashboard/api-agents.ts
import { PerformanceReader, AgentScore } from '@gossip/orchestrator/performance-reader';

interface AgentConfigLike {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  native?: boolean;
}

export interface AgentResponse {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  native: boolean;
  skills: string[];
  scores: {
    accuracy: number;
    uniqueness: number;
    reliability: number;
    dispatchWeight: number;
    signals: number;
    agreements: number;
    disagreements: number;
    hallucinations: number;
  };
}

const DEFAULT_SCORE: AgentScore = {
  agentId: '', accuracy: 0.5, uniqueness: 0.5, reliability: 0.5,
  totalSignals: 0, agreements: 0, disagreements: 0, uniqueFindings: 0, hallucinations: 0,
};

export async function agentsHandler(projectRoot: string, configs: AgentConfigLike[]): Promise<AgentResponse[]> {
  const reader = new PerformanceReader(projectRoot);
  const scores = reader.getScores();

  return configs.map(config => {
    const score = scores.get(config.id) ?? { ...DEFAULT_SCORE, agentId: config.id };
    return {
      id: config.id,
      provider: config.provider,
      model: config.model,
      preset: config.preset,
      native: config.native ?? false,
      skills: config.skills,
      scores: {
        accuracy: score.accuracy,
        uniqueness: score.uniqueness,
        reliability: score.reliability,
        dispatchWeight: reader.getDispatchWeight(config.id),
        signals: score.totalSignals,
        agreements: score.agreements,
        disagreements: score.disagreements,
        hallucinations: score.hallucinations,
      },
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All 6 tests PASS (3 overview + 3 agents)

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/api-agents.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): agents API — scores from PerformanceReader"
```

---

## Task 5: Skills API Endpoints

**Files:**
- Create: `packages/relay/src/dashboard/api-skills.ts`
- Modify: `tests/relay/dashboard-api.test.ts` (append)

- [ ] **Step 1: Write failing tests for skills API**

Append to `tests/relay/dashboard-api.test.ts`:

```typescript
import { skillsGetHandler, skillsBindHandler } from '@gossip/relay/dashboard/api-skills';

describe('Skills API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  it('returns empty index for fresh project', async () => {
    const result = await skillsGetHandler(projectRoot);
    expect(result.index).toEqual({});
    expect(result.suggestions).toEqual([]);
  });

  it('returns skill index data when populated', async () => {
    // Write a skill-index.json
    writeFileSync(join(projectRoot, '.gossip', 'skill-index.json'), JSON.stringify({
      'agent-a': { code_review: { skill: 'code_review', enabled: true, source: 'config', version: 1, boundAt: '2026-01-01' } }
    }));

    const result = await skillsGetHandler(projectRoot);
    expect(result.index['agent-a']).toBeDefined();
    expect(result.index['agent-a']['code_review'].enabled).toBe(true);
  });

  it('toggles skill enabled state', async () => {
    // Seed a skill index
    writeFileSync(join(projectRoot, '.gossip', 'skill-index.json'), JSON.stringify({
      'agent-a': { code_review: { skill: 'code_review', enabled: true, source: 'config', version: 1, boundAt: '2026-01-01' } }
    }));

    const result = await skillsBindHandler(projectRoot, { agent_id: 'agent-a', skill: 'code_review', enabled: false });
    expect(result.success).toBe(true);

    // Verify it's actually disabled
    const updated = await skillsGetHandler(projectRoot);
    expect(updated.index['agent-a']['code_review'].enabled).toBe(false);
  });

  it('rejects invalid agent_id', async () => {
    const result = await skillsBindHandler(projectRoot, { agent_id: '../etc', skill: 'x', enabled: true });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/api-skills`

- [ ] **Step 3: Implement skills handlers**

```typescript
// packages/relay/src/dashboard/api-skills.ts
import { SkillIndex, SkillIndexData } from '@gossip/orchestrator/skill-index';

export interface SkillsGetResponse {
  index: SkillIndexData;
  suggestions: string[];
}

export interface SkillsBindRequest {
  agent_id: string;
  skill: string;
  enabled: boolean;
}

export interface SkillsBindResponse {
  success: boolean;
  error?: string;
}

// Allowlist: only alphanumeric, hyphens, underscores
const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export async function skillsGetHandler(projectRoot: string): Promise<SkillsGetResponse> {
  const index = new SkillIndex(projectRoot);
  return {
    index: index.getIndex(),
    suggestions: [], // Phase 2: wire to SkillGapTracker.getGapSuggestions()
  };
}

export async function skillsBindHandler(projectRoot: string, body: SkillsBindRequest): Promise<SkillsBindResponse> {
  if (!body.agent_id || !AGENT_ID_RE.test(body.agent_id)) {
    return { success: false, error: 'Invalid agent_id' };
  }
  if (!body.skill || typeof body.skill !== 'string') {
    return { success: false, error: 'Invalid skill name' };
  }

  try {
    const index = new SkillIndex(projectRoot);
    const changed = body.enabled
      ? index.enable(body.agent_id, body.skill)
      : index.disable(body.agent_id, body.skill);
    if (!changed) {
      return { success: false, error: 'Skill not bound to agent' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/api-skills.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): skills API — index read + bind/toggle with validation"
```

---

## Task 6: Memory API Endpoint

**Files:**
- Create: `packages/relay/src/dashboard/api-memory.ts`
- Modify: `tests/relay/dashboard-api.test.ts` (append)

- [ ] **Step 1: Write failing tests for memory API**

Append to `tests/relay/dashboard-api.test.ts`:

```typescript
import { memoryHandler } from '@gossip/relay/dashboard/api-memory';

describe('Memory API', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory'), { recursive: true });
  });

  it('returns empty data for agent with no memory', async () => {
    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.index).toBe('');
    expect(result.knowledge).toEqual([]);
    expect(result.tasks).toEqual([]);
  });

  it('reads MEMORY.md index', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory');
    writeFileSync(join(memDir, 'MEMORY.md'), '# Agent A Memory\n- [Skill review](skill-review.md)');

    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.index).toContain('Agent A Memory');
  });

  it('reads knowledge files with frontmatter', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory');
    writeFileSync(join(memDir, 'MEMORY.md'), '');
    writeFileSync(join(memDir, 'review.md'), '---\nname: review\ndescription: code review notes\nimportance: 3\n---\nSome content');

    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.knowledge).toHaveLength(1);
    expect(result.knowledge[0].filename).toBe('review.md');
    expect(result.knowledge[0].content).toContain('Some content');
  });

  it('reads tasks.jsonl', async () => {
    const memDir = join(projectRoot, '.gossip', 'agents', 'agent-a', 'memory');
    writeFileSync(join(memDir, 'MEMORY.md'), '');
    const task = { version: 1, taskId: 't1', task: 'review', skills: [], findings: 0, hallucinated: 0, scores: { relevance: 1, accuracy: 1, uniqueness: 0 }, warmth: 1, importance: 3, timestamp: '2026-01-01' };
    writeFileSync(join(memDir, 'tasks.jsonl'), JSON.stringify(task) + '\n');

    const result = await memoryHandler(projectRoot, 'agent-a');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe('t1');
  });

  it('rejects path traversal in agentId', async () => {
    await expect(memoryHandler(projectRoot, '../../../etc/passwd')).rejects.toThrow('Invalid agent ID');
  });

  it('rejects prototype-polluting agent IDs', async () => {
    await expect(memoryHandler(projectRoot, '__proto__')).rejects.toThrow('Invalid agent ID');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/api-memory`

- [ ] **Step 3: Implement memoryHandler**

```typescript
// packages/relay/src/dashboard/api-memory.ts
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const AGENT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DANGEROUS_IDS = new Set(['__proto__', 'constructor', 'prototype', '_project']);

interface KnowledgeFile {
  filename: string;
  frontmatter: Record<string, string>;
  content: string;
}

export interface MemoryResponse {
  index: string;
  knowledge: KnowledgeFile[];
  tasks: Record<string, unknown>[];
}

export async function memoryHandler(projectRoot: string, agentId: string): Promise<MemoryResponse> {
  if (!agentId || !AGENT_ID_RE.test(agentId) || DANGEROUS_IDS.has(agentId)) {
    throw new Error('Invalid agent ID');
  }

  const memDir = join(projectRoot, '.gossip', 'agents', agentId, 'memory');

  // Index
  let index = '';
  const indexPath = join(memDir, 'MEMORY.md');
  if (existsSync(indexPath)) {
    try { index = readFileSync(indexPath, 'utf-8'); } catch { /* empty */ }
  }

  // Knowledge files
  const knowledge: KnowledgeFile[] = [];
  if (existsSync(memDir)) {
    try {
      const files = readdirSync(memDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
      for (const filename of files) {
        try {
          const raw = readFileSync(join(memDir, filename), 'utf-8');
          const { frontmatter, content } = parseFrontmatter(raw);
          knowledge.push({ filename, frontmatter, content });
        } catch { /* skip unreadable */ }
      }
    } catch { /* empty dir */ }
  }

  // Tasks
  const tasks: Record<string, unknown>[] = [];
  const tasksPath = join(memDir, 'tasks.jsonl');
  if (existsSync(tasksPath)) {
    try {
      const lines = readFileSync(tasksPath, 'utf-8').trim().split('\n').filter(Boolean).slice(-200);
      for (const line of lines) {
        try { tasks.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    } catch { /* empty */ }
  }

  return { index, knowledge, tasks };
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; content: string } {
  if (!raw.startsWith('---')) return { frontmatter: {}, content: raw };
  const end = raw.indexOf('---', 3);
  if (end === -1) return { frontmatter: {}, content: raw };

  const fm: Record<string, string> = {};
  const fmBlock = raw.slice(3, end).trim();
  for (const line of fmBlock.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      fm[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { frontmatter: fm, content: raw.slice(end + 3).trim() };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-api.test.ts --no-coverage`
Expected: All 16 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/api-memory.ts tests/relay/dashboard-api.test.ts
git commit -m "feat(dashboard): memory API — knowledge files, tasks, path traversal guard"
```

---

## Task 7: Dashboard Route Handler

**Files:**
- Create: `packages/relay/src/dashboard/routes.ts`
- Create: `packages/relay/src/dashboard/index.ts`
- Test: `tests/relay/dashboard-routes.test.ts`

- [ ] **Step 1: Write failing tests for route handler**

```typescript
// tests/relay/dashboard-routes.test.ts
import { DashboardRouter } from '@gossip/relay/dashboard/routes';
import { DashboardAuth } from '@gossip/relay/dashboard/auth';
import { IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EventEmitter } from 'events';

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as any;
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = new EventEmitter() as any;
  res._status = 200;
  res._headers = {};
  res._body = '';
  res.writeHead = (code: number, headers?: Record<string, string>) => {
    res._status = code;
    if (headers) Object.assign(res._headers, headers);
    return res;
  };
  res.setHeader = (k: string, v: string) => { res._headers[k] = v; };
  res.end = (body?: string) => { res._body = body ?? ''; };
  return res;
}

describe('DashboardRouter', () => {
  let projectRoot: string;
  let auth: DashboardAuth;
  let router: DashboardRouter;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    auth = new DashboardAuth(projectRoot);
    auth.init();
    router = new DashboardRouter(auth, projectRoot, { agentConfigs: [], relayConnections: 0 });
  });

  it('returns 404 for non-dashboard routes', async () => {
    const req = mockReq('GET', '/other');
    const res = mockRes();
    const handled = await router.handle(req, res);
    expect(handled).toBe(false);
  });

  it('POST /dashboard/api/auth sets session cookie on valid key', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const body = JSON.stringify({ key: auth.getKey() });
    const res = mockRes();

    // Simulate body
    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    await handled;

    expect(res._status).toBe(200);
    expect(res._headers['Set-Cookie']).toContain('dashboard_session=');
    expect(res._headers['Set-Cookie']).toContain('HttpOnly');
    expect(res._headers['Set-Cookie']).toContain('SameSite=Strict');
  });

  it('POST /dashboard/api/auth rejects invalid key', async () => {
    const req = mockReq('POST', '/dashboard/api/auth');
    const body = JSON.stringify({ key: 'wrong' });
    const res = mockRes();

    const handled = router.handle(req, res);
    req.emit('data', Buffer.from(body));
    req.emit('end');
    await handled;

    expect(res._status).toBe(401);
  });

  it('API routes require valid session', async () => {
    const req = mockReq('GET', '/dashboard/api/overview');
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(401);
  });

  it('API routes work with valid session cookie', async () => {
    const token = auth.createSession(auth.getKey())!;
    const req = mockReq('GET', '/dashboard/api/overview', {
      cookie: `dashboard_session=${token}`,
    });
    const res = mockRes();
    await router.handle(req, res);
    expect(res._status).toBe(200);
    const body = JSON.parse(res._body);
    expect(body).toHaveProperty('agentsOnline');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-routes.test.ts --no-coverage`
Expected: FAIL — cannot resolve `@gossip/relay/dashboard/routes`

- [ ] **Step 3: Implement DashboardRouter**

```typescript
// packages/relay/src/dashboard/routes.ts
import { IncomingMessage, ServerResponse } from 'http';
import { DashboardAuth } from './auth';
import { overviewHandler } from './api-overview';
import { agentsHandler } from './api-agents';
import { skillsGetHandler, skillsBindHandler } from './api-skills';
import { memoryHandler } from './api-memory';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface AgentConfigLike {
  id: string;
  provider: string;
  model: string;
  preset?: string;
  skills: string[];
  native?: boolean;
}

interface DashboardContext {
  agentConfigs: AgentConfigLike[];
  relayConnections: number;
}

export class DashboardRouter {
  constructor(
    private auth: DashboardAuth,
    private projectRoot: string,
    private ctx: DashboardContext,
  ) {}

  /** Update live context (call when agents connect/disconnect) */
  updateContext(ctx: Partial<DashboardContext>): void {
    if (ctx.agentConfigs !== undefined) this.ctx.agentConfigs = ctx.agentConfigs;
    if (ctx.relayConnections !== undefined) this.ctx.relayConnections = ctx.relayConnections;
  }

  /**
   * Handle an HTTP request. Returns true if the route was handled, false otherwise.
   * Caller should only call this for URLs starting with /dashboard.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith('/dashboard')) return false;

    // Auth endpoint — no session required
    if (url === '/dashboard/api/auth' && req.method === 'POST') {
      return this.handleAuth(req, res);
    }

    // Serve static dashboard (SPA)
    if (url === '/dashboard' || url === '/dashboard/') {
      return this.serveDashboard(res);
    }

    // All other /dashboard/api/* routes require session
    if (url.startsWith('/dashboard/api/')) {
      const token = this.extractSessionToken(req);
      if (!token || !this.auth.validateSession(token)) {
        this.json(res, 401, { error: 'Unauthorized' });
        return true;
      }
      return this.handleApi(req, res, url);
    }

    // Static assets
    if (url.startsWith('/dashboard/assets/')) {
      return this.serveAsset(res, url);
    }

    this.json(res, 404, { error: 'Not found' });
    return true;
  }

  private async handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await readBody(req);
    try {
      const { key } = JSON.parse(body);
      const token = this.auth.createSession(key);
      if (!token) {
        this.json(res, 401, { error: 'Invalid key' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `dashboard_session=${token}; HttpOnly; SameSite=Strict; Path=/dashboard; Max-Age=86400`,
      });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      this.json(res, 400, { error: 'Invalid request body' });
    }
    return true;
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    try {
      if (url === '/dashboard/api/overview' && req.method === 'GET') {
        const data = await overviewHandler(this.projectRoot, this.ctx);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/agents' && req.method === 'GET') {
        const data = await agentsHandler(this.projectRoot, this.ctx.agentConfigs);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/skills' && req.method === 'GET') {
        const data = await skillsGetHandler(this.projectRoot);
        this.json(res, 200, data);
        return true;
      }

      if (url === '/dashboard/api/skills/bind' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const data = await skillsBindHandler(this.projectRoot, body);
        this.json(res, data.success ? 200 : 400, data);
        return true;
      }

      // Memory: /dashboard/api/memory/:agentId
      const memoryMatch = url.match(/^\/dashboard\/api\/memory\/([^/]+)$/);
      if (memoryMatch && req.method === 'GET') {
        try {
          const data = await memoryHandler(this.projectRoot, memoryMatch[1]);
          this.json(res, 200, data);
        } catch (err) {
          this.json(res, 400, { error: err instanceof Error ? err.message : 'Bad request' });
        }
        return true;
      }

      this.json(res, 404, { error: 'Unknown API endpoint' });
    } catch (err) {
      this.json(res, 500, { error: 'Internal server error' });
    }
    return true;
  }

  private serveDashboard(res: ServerResponse): boolean {
    const htmlPath = join(this.projectRoot, 'dist-dashboard', 'index.html');
    if (!existsSync(htmlPath)) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dashboard not built. Run: npm run build:dashboard');
      return true;
    }
    const html = readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  private serveAsset(res: ServerResponse, url: string): boolean {
    // No assets in Phase 1 — everything is bundled in index.html
    res.writeHead(404);
    res.end();
    return true;
  }

  private extractSessionToken(req: IncomingMessage): string | null {
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    const match = cookie.match(/dashboard_session=([^;]+)/);
    return match ? match[1] : null;
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

const MAX_BODY_SIZE = 8 * 1024; // 8 KB — ample for auth key and skill bind payloads

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
```

```typescript
// packages/relay/src/dashboard/index.ts
export { DashboardAuth } from './auth';
export { DashboardRouter } from './routes';
export { DashboardWs, type DashboardEvent } from './ws';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-routes.test.ts --no-coverage`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/dashboard/routes.ts packages/relay/src/dashboard/index.ts tests/relay/dashboard-routes.test.ts
git commit -m "feat(dashboard): route handler — auth, API dispatch, session cookie"
```

---

## Task 8: Wire Dashboard Into Relay Server

**Files:**
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/index.ts`
- Modify: `packages/relay/package.json`

- [ ] **Step 1: Write failing integration test**

Add to `tests/relay/dashboard-routes.test.ts`:

```typescript
import { RelayServer } from '@gossip/relay';
import http from 'http';

describe('RelayServer dashboard integration', () => {
  let server: RelayServer;
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
    server = new RelayServer({
      port: 0,
      dashboard: { projectRoot, agentConfigs: [] },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function request(path: string, options: http.RequestOptions = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}${path}`, options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(options.method === 'POST' ? (options as any)._body : undefined);
    });
  }

  it('serves /health as before', async () => {
    const { status, body } = await request('/health');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('ok');
  });

  it('returns 401 for unauthenticated API', async () => {
    const { status } = await request('/dashboard/api/overview');
    expect(status).toBe(401);
  });

  it('POST /dashboard/api/auth with valid key returns session cookie', async () => {
    const key = server.dashboardKeyPrefix; // exposed for CLI boot message
    // Get full key from file
    const fullKey = require('fs').readFileSync(join(projectRoot, '.gossip', 'dashboard-key'), 'utf-8').trim();
    const postBody = JSON.stringify({ key: fullKey });
    const { status, headers } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });
    expect(status).toBe(200);
    expect(headers['set-cookie']?.[0]).toContain('dashboard_session=');
  });

  it('full auth → cookie → API flow', async () => {
    const fullKey = require('fs').readFileSync(join(projectRoot, '.gossip', 'dashboard-key'), 'utf-8').trim();
    const postBody = JSON.stringify({ key: fullKey });

    // Step 1: Authenticate and get cookie
    const authRes = await new Promise<{ status: number; cookie: string }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postBody) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({
          status: res.statusCode!,
          cookie: (res.headers['set-cookie']?.[0] ?? '').split(';')[0],
        }));
      });
      req.on('error', reject);
      req.write(postBody);
      req.end();
    });
    expect(authRes.status).toBe(200);
    expect(authRes.cookie).toContain('dashboard_session=');

    // Step 2: Use cookie to call API
    const apiRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(`http://localhost:${server.port}/dashboard/api/overview`, {
        headers: { Cookie: authRes.cookie },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(apiRes.status).toBe(200);
    const data = JSON.parse(apiRes.body);
    expect(data).toHaveProperty('agentsOnline');
    expect(data).toHaveProperty('totalSignals');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/relay/dashboard-routes.test.ts --no-coverage`
Expected: FAIL — `RelayServer` doesn't accept `dashboard` config yet

- [ ] **Step 3: Modify RelayServer to integrate dashboard**

In `packages/relay/src/server.ts`, make these changes:

1. Add dashboard config to `RelayServerConfig`:

```typescript
export interface DashboardConfig {
  projectRoot: string;
  agentConfigs: Array<{ id: string; provider: string; model: string; preset?: string; skills: string[]; native?: boolean }>;
}

export interface RelayServerConfig {
  port: number;
  host?: string;
  authTimeoutMs?: number;
  apiKey?: string;
  dashboard?: DashboardConfig;  // NEW
}
```

2. Add imports and fields to `RelayServer`:

```typescript
import { DashboardAuth } from './dashboard/auth';
import { DashboardRouter } from './dashboard/routes';
import { DashboardWs } from './dashboard/ws';

// In class body:
private dashboardAuth: DashboardAuth | null = null;
private dashboardRouter: DashboardRouter | null = null;
private dashboardWs: DashboardWs | null = null;
private dashboardUpgrader: WebSocketServer | null = null; // single instance — avoids per-request leak
```

3. In `start()`, after `this.httpServer = createServer(...)` and before `this.wss = new WebSocketServer(...)`, init dashboard:

```typescript
if (this.config.dashboard) {
  this.dashboardAuth = new DashboardAuth(this.config.dashboard.projectRoot);
  this.dashboardAuth.init();
  this.dashboardWs = new DashboardWs();
  this.dashboardUpgrader = new WebSocketServer({ noServer: true });
  this.dashboardRouter = new DashboardRouter(
    this.dashboardAuth,
    this.config.dashboard.projectRoot,
    {
      agentConfigs: this.config.dashboard.agentConfigs,
      relayConnections: this.connectionManager.count,
    },
  );
}
```

4. Replace the existing `new WebSocketServer({ server: ... })` with upgrade-path splitting:

```typescript
this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });
this.wss.on('connection', this.handleConnection.bind(this));

this.httpServer.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  if (url === '/dashboard/ws' && this.dashboardWs && this.dashboardUpgrader) {
    // Dashboard WebSocket — validate session cookie before accepting
    const cookie = req.headers.cookie ?? '';
    const match = cookie.match(/dashboard_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token || !this.dashboardAuth?.validateSession(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.dashboardUpgrader.handleUpgrade(req, socket, head, (ws) => {
      this.dashboardWs!.addClient(ws);
      ws.on('close', () => this.dashboardWs!.removeClient(ws));
    });
  } else {
    // Agent WebSocket — existing logic
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req);
    });
  }
});
```

5. In the existing `handleConnection` method, add `this.updateDashboardConnectionCount()` after the `authenticated = true` line and inside the `cleanup` closure (after `this.connectionManager.unregister`). This keeps the dashboard relay count live.

6. Update `handleHttp` to delegate to dashboard:

```typescript
private handleHttp(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', connections: this.connectionManager.count }));
    return;
  }

  if (req.url?.startsWith('/dashboard') && this.dashboardRouter) {
    this.dashboardRouter.handle(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
}
```

6. Add public accessor for CLI boot message:

```typescript
get dashboardKeyPrefix(): string {
  return this.dashboardAuth?.getKeyPrefix() ?? '';
}

get dashboardUrl(): string {
  if (!this.dashboardAuth) return '';
  return `http://localhost:${this._port}/dashboard`;
}

/** Call from handleConnection cleanup to keep relay count current */
private updateDashboardConnectionCount(): void {
  this.dashboardRouter?.updateContext({ relayConnections: this.connectionManager.count });
}
```

- [ ] **Step 4: Update relay package.json and index.ts**

In `packages/relay/package.json`, add orchestrator dependency:

```json
"dependencies": {
  "@gossip/types": "*",
  "@gossip/orchestrator": "*",
  "ws": "^8.19.0"
}
```

In `packages/relay/src/index.ts`, add re-export:

```typescript
export { DashboardAuth, DashboardRouter, DashboardWs } from './dashboard';
export type { DashboardEvent } from './dashboard';
export type { DashboardConfig } from './server';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest tests/relay/dashboard-routes.test.ts --no-coverage`
Expected: All 9 tests PASS (5 unit + 4 integration)

- [ ] **Step 6: Run existing relay tests to verify no regression**

Run: `npx jest tests/relay/ --no-coverage`
Expected: All existing tests PASS (server.test.ts, connection-manager.test.ts, router.test.ts)

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/index.ts packages/relay/package.json
git commit -m "feat(dashboard): wire into relay server — upgrade-path split, dashboard config"
```

---

## Task 9: Dashboard Client — HTML Shell + CSS Theme

**Files:**
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/src/index.html`
- Create: `packages/dashboard/src/style.css`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@gossip/dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "node build.js"
  },
  "devDependencies": {
    "esbuild": "^0.27.4"
  }
}
```

- [ ] **Step 2: Create index.html — SPA shell with auth gate**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gossipcat Dashboard</title>
  <link rel="stylesheet" href="/dashboard/assets/style.css">
</head>
<body>
  <!-- Auth Gate -->
  <div id="auth-gate" class="auth-gate">
    <div class="auth-card">
      <h1>gossipcat</h1>
      <p class="auth-subtitle">Enter your dashboard key to continue</p>
      <form id="auth-form">
        <input type="password" id="auth-key" placeholder="Dashboard key" autocomplete="off" autofocus>
        <button type="submit">Unlock</button>
      </form>
      <p id="auth-error" class="auth-error" hidden>Invalid key. Check your terminal for the correct key.</p>
    </div>
  </div>

  <!-- Dashboard (hidden until authenticated) -->
  <div id="dashboard" class="dashboard" hidden>
    <nav class="nav">
      <div class="nav-brand">gossipcat</div>
      <div class="nav-tabs">
        <button class="nav-tab active" data-tab="overview">Overview</button>
        <button class="nav-tab" data-tab="agents">Agents</button>
        <button class="nav-tab" data-tab="consensus" disabled title="Phase 3">Consensus</button>
        <button class="nav-tab" data-tab="skills" disabled title="Phase 2">Skills</button>
        <button class="nav-tab" data-tab="memory" disabled title="Phase 4">Memory</button>
      </div>
      <div class="nav-status">
        <span id="ws-status" class="status-dot offline"></span>
        <span id="ws-label">Disconnected</span>
      </div>
    </nav>

    <main class="main">
      <div id="tab-overview" class="tab-content active"></div>
      <div id="tab-agents" class="tab-content"></div>
      <div id="tab-consensus" class="tab-content"></div>
      <div id="tab-skills" class="tab-content"></div>
      <div id="tab-memory" class="tab-content"></div>
    </main>
  </div>

  <script src="/dashboard/assets/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create style.css — deep purple theme**

```css
/* Design tokens from spec */
:root {
  --bg-primary: #09090f;
  --bg-card: linear-gradient(135deg, #1a1a2e, #16132e);
  --bg-nav: #12122a;
  --border: #2d2b55;
  --text-primary: #f8fafc;
  --text-secondary: #7c7c9e;
  --text-muted: #6b7280;
  --accent-primary: #a78bfa;
  --accent-secondary: #818cf8;
  --status-confirmed: #4ade80;
  --status-disputed: #ef4444;
  --status-unverified: #fbbf24;
  --status-unique: #6b7280;
  --status-new: #60a5fa;
  --radius-card: 10px;
  --radius-button: 6px;
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  min-height: 100vh;
}

/* Auth Gate */
.auth-gate {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.auth-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 2.5rem;
  text-align: center;
  max-width: 380px;
  width: 100%;
}

.auth-card h1 {
  color: var(--accent-primary);
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}

.auth-subtitle { color: var(--text-secondary); margin-bottom: 1.5rem; font-size: 0.875rem; }

.auth-card input {
  width: 100%;
  padding: 0.75rem 1rem;
  background: rgba(255,255,255,0.05);
  border: 1px solid var(--border);
  border-radius: var(--radius-button);
  color: var(--text-primary);
  font-size: 0.875rem;
  margin-bottom: 1rem;
  outline: none;
}
.auth-card input:focus { border-color: var(--accent-primary); }

.auth-card button {
  width: 100%;
  padding: 0.75rem;
  background: var(--accent-primary);
  color: #09090f;
  border: none;
  border-radius: var(--radius-button);
  font-weight: 600;
  font-size: 0.875rem;
  cursor: pointer;
}
.auth-card button:hover { opacity: 0.9; }

.auth-error { color: var(--status-disputed); font-size: 0.8rem; margin-top: 0.75rem; }

/* Nav */
.nav {
  display: flex;
  align-items: center;
  background: var(--bg-nav);
  border-bottom: 1px solid var(--border);
  padding: 0 1.5rem;
  height: 52px;
}

.nav-brand {
  color: var(--accent-primary);
  font-weight: 600;
  font-size: 1rem;
  margin-right: 2rem;
}

.nav-tabs { display: flex; gap: 0.25rem; flex: 1; }

.nav-tab {
  background: none;
  border: none;
  color: var(--text-secondary);
  padding: 0.5rem 1rem;
  font-size: 0.8125rem;
  cursor: pointer;
  border-radius: var(--radius-button);
}
.nav-tab:hover:not(:disabled) { color: var(--text-primary); background: rgba(255,255,255,0.05); }
.nav-tab.active { color: var(--accent-primary); background: rgba(167, 139, 250, 0.1); }
.nav-tab:disabled { opacity: 0.35; cursor: default; }

.nav-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.status-dot.online { background: var(--status-confirmed); }
.status-dot.offline { background: var(--status-disputed); }

/* Main */
.main { padding: 1.5rem; max-width: 1400px; margin: 0 auto; }

.tab-content { display: none; }
.tab-content.active { display: block; }

/* Cards */
.stat-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }

.stat-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 1.25rem;
}
.stat-card .label { font-size: 0.75rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
.stat-card .value { font-size: 1.75rem; font-weight: 700; margin-top: 0.25rem; }
.stat-card .detail { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.25rem; }

/* Panels */
.panels { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }

.panel {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 1.25rem;
}
.panel-title { font-size: 0.875rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-secondary); }

/* Agent Scores */
.agent-row {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.agent-row:last-child { border-bottom: none; }
.agent-name { font-weight: 500; min-width: 140px; font-size: 0.8125rem; }
.agent-badge {
  font-size: 0.625rem;
  padding: 0.125rem 0.375rem;
  border-radius: 3px;
  background: rgba(167, 139, 250, 0.15);
  color: var(--accent-primary);
  margin-left: 0.5rem;
}

.bar-group { display: flex; gap: 0.5rem; flex: 1; align-items: center; }
.bar-container {
  flex: 1;
  height: 6px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  overflow: hidden;
}
.bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }
.bar-fill.accuracy { background: var(--accent-primary); }
.bar-fill.uniqueness { background: var(--accent-secondary); }
.bar-fill.reliability { background: var(--status-confirmed); }
.bar-label { font-size: 0.625rem; color: var(--text-muted); min-width: 60px; }

.weight-badge {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--accent-primary);
  min-width: 40px;
  text-align: right;
}

/* Activity Timeline */
.timeline { max-height: 400px; overflow-y: auto; }
.timeline-entry {
  display: flex;
  gap: 0.75rem;
  padding: 0.375rem 0;
  font-size: 0.8125rem;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.timeline-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}
.timeline-dot.green { background: var(--status-confirmed); }
.timeline-dot.purple { background: var(--accent-primary); }
.timeline-dot.yellow { background: var(--status-unverified); }
.timeline-dot.red { background: var(--status-disputed); }
.timeline-time { color: var(--text-muted); font-size: 0.6875rem; min-width: 55px; }
.timeline-text { color: var(--text-secondary); }

/* Agents Tab */
.agent-cards { display: grid; gap: 1rem; }
.agent-detail-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 1.25rem;
}
.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}
.agent-meta { font-size: 0.75rem; color: var(--text-muted); }
.agent-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.75rem;
}
.agent-stat { text-align: center; }
.agent-stat .num { font-size: 1.25rem; font-weight: 700; }
.agent-stat .lbl { font-size: 0.6875rem; color: var(--text-secondary); }

/* Empty state */
.empty-state {
  text-align: center;
  padding: 3rem;
  color: var(--text-muted);
  font-size: 0.875rem;
}

/* Responsive */
@media (max-width: 768px) {
  .panels { grid-template-columns: 1fr; }
  .stat-cards { grid-template-columns: repeat(2, 1fr); }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/package.json packages/dashboard/src/index.html packages/dashboard/src/style.css
git commit -m "feat(dashboard): HTML shell + deep purple CSS theme"
```

---

## Task 10: Dashboard Client — App JS + Overview Tab

**Files:**
- Create: `packages/dashboard/src/app.js`
- Create: `packages/dashboard/src/tabs/overview.js`

- [ ] **Step 1: Create app.js — tab routing, auth, WebSocket, API helpers**

```javascript
// packages/dashboard/src/app.js

// ── API Helper ──────────────────────────────────────────────────────────────
async function api(path) {
  const res = await fetch(`/dashboard/api/${path}`);
  if (res.status === 401) {
    showAuth();
    throw new Error('Unauthorized');
  }
  return res.json();
}

// ── Auth ─────────────────────────────────────────────────────────────────────
const authGate = document.getElementById('auth-gate');
const dashboard = document.getElementById('dashboard');
const authForm = document.getElementById('auth-form');
const authError = document.getElementById('auth-error');

function showAuth() {
  authGate.hidden = false;
  dashboard.hidden = true;
}

function showDashboard() {
  authGate.hidden = true;
  dashboard.hidden = false;
  initDashboard();
}

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = document.getElementById('auth-key').value;
  try {
    const res = await fetch('/dashboard/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      authError.hidden = true;
      showDashboard();
    } else {
      authError.hidden = false;
    }
  } catch {
    authError.hidden = false;
  }
});

// ── Tab Routing ──────────────────────────────────────────────────────────────
const tabs = document.querySelectorAll('.nav-tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.disabled) return;
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    loadTab(tab.dataset.tab);
  });
});

// ── WebSocket ────────────────────────────────────────────────────────────────
let ws = null;
const wsStatus = document.getElementById('ws-status');
const wsLabel = document.getElementById('ws-label');
const eventListeners = [];

function onDashboardEvent(fn) { eventListeners.push(fn); }

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/dashboard/ws`);

  ws.onopen = () => {
    wsStatus.className = 'status-dot online';
    wsLabel.textContent = 'Connected';
  };

  ws.onclose = () => {
    wsStatus.className = 'status-dot offline';
    wsLabel.textContent = 'Disconnected';
    setTimeout(connectWs, 3000); // Reconnect after 3s
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      for (const fn of eventListeners) fn(event);
    } catch { /* ignore */ }
  };
}

// ── Tab Loading ──────────────────────────────────────────────────────────────
async function loadTab(name) {
  switch (name) {
    case 'overview': return renderOverview();
    case 'agents': return renderAgents();
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────
let initialized = false;
async function initDashboard() {
  if (initialized) return;
  initialized = true;
  connectWs();
  loadTab('overview');
}

// Try loading dashboard directly (cookie may already be valid)
api('overview').then(() => showDashboard()).catch(() => showAuth());

// Make helpers available to tab modules
window._dash = { api, onDashboardEvent };
```

- [ ] **Step 2: Create overview.js — stat cards, agent scores, activity timeline**

```javascript
// packages/dashboard/src/tabs/overview.js

async function renderOverview() {
  const container = document.getElementById('tab-overview');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const [overview, agents] = await Promise.all([
      window._dash.api('overview'),
      window._dash.api('agents'),
    ]);

    container.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="label">Agents Online</div>
          <div class="value">${overview.agentsOnline}</div>
          <div class="detail">${overview.relayCount} relay, ${overview.nativeCount} native</div>
        </div>
        <div class="stat-card">
          <div class="label">Consensus Runs</div>
          <div class="value">${overview.consensusRuns}</div>
        </div>
        <div class="stat-card">
          <div class="label">Total Findings</div>
          <div class="value">${overview.totalFindings}</div>
          <div class="detail">${overview.confirmedFindings} confirmed</div>
        </div>
        <div class="stat-card">
          <div class="label">Performance Signals</div>
          <div class="value">${overview.totalSignals}</div>
        </div>
      </div>

      <div class="panels">
        <div class="panel">
          <div class="panel-title">Agent Scores</div>
          <div id="agent-scores">
            ${agents.length === 0 ? '<div class="empty-state">No agents configured</div>' :
              agents
                .sort((a, b) => b.scores.dispatchWeight - a.scores.dispatchWeight)
                .map(a => `
                  <div class="agent-row">
                    <div class="agent-name">
                      ${a.id}
                      ${a.native ? '<span class="agent-badge">native</span>' : ''}
                    </div>
                    <div class="bar-group">
                      <div class="bar-label">acc</div>
                      <div class="bar-container"><div class="bar-fill accuracy" style="width:${(a.scores.accuracy * 100).toFixed(0)}%"></div></div>
                      <div class="bar-label">uniq</div>
                      <div class="bar-container"><div class="bar-fill uniqueness" style="width:${(a.scores.uniqueness * 100).toFixed(0)}%"></div></div>
                      <div class="bar-label">rel</div>
                      <div class="bar-container"><div class="bar-fill reliability" style="width:${(a.scores.reliability * 100).toFixed(0)}%"></div></div>
                    </div>
                    <div class="weight-badge">${a.scores.dispatchWeight.toFixed(2)}</div>
                  </div>
                `).join('')}
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">Live Activity</div>
          <div id="activity-timeline" class="timeline">
            <div class="empty-state">Waiting for events...</div>
          </div>
        </div>
      </div>
    `;

    // Wire up live activity from WebSocket
    const timeline = document.getElementById('activity-timeline');
    let hasEvents = false;

    window._dash.onDashboardEvent((event) => {
      if (!hasEvents) {
        timeline.innerHTML = '';
        hasEvents = true;
      }

      const colors = {
        task_completed: 'green', consensus_complete: 'green',
        task_dispatched: 'purple', agent_connected: 'purple', agent_disconnected: 'purple',
        skill_changed: 'yellow', consensus_started: 'yellow',
        task_failed: 'red',
      };

      const time = new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const color = colors[event.type] || 'purple';
      const text = formatEvent(event);

      const entry = document.createElement('div');
      entry.className = 'timeline-entry';
      entry.innerHTML = `
        <div class="timeline-dot ${color}"></div>
        <div class="timeline-time">${time}</div>
        <div class="timeline-text">${text}</div>
      `;
      timeline.prepend(entry);

      // Cap timeline entries
      while (timeline.children.length > 100) {
        timeline.removeChild(timeline.lastChild);
      }
    });
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
  }
}

function formatEvent(event) {
  const d = event.data || {};
  switch (event.type) {
    case 'task_dispatched': return `Task dispatched to <strong>${d.agentId || '?'}</strong>`;
    case 'task_completed': return `Task completed by <strong>${d.agentId || '?'}</strong>`;
    case 'task_failed': return `Task failed on <strong>${d.agentId || '?'}</strong>`;
    case 'consensus_started': return `Consensus started (${d.agentCount || '?'} agents)`;
    case 'consensus_complete': return `Consensus complete — ${d.confirmed || 0} confirmed`;
    case 'agent_connected': return `<strong>${d.agentId || '?'}</strong> connected`;
    case 'agent_disconnected': return `<strong>${d.agentId || '?'}</strong> disconnected`;
    case 'skill_changed': return `Skill <strong>${d.skill || '?'}</strong> toggled for ${d.agentId || '?'}`;
    default: return event.type;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/dashboard/src/app.js packages/dashboard/src/tabs/overview.js
git commit -m "feat(dashboard): app.js + overview tab — auth, routing, WebSocket, stat cards"
```

---

## Task 11: Dashboard Client — Agents Tab

**Files:**
- Create: `packages/dashboard/src/tabs/agents.js`

- [ ] **Step 1: Create agents.js**

```javascript
// packages/dashboard/src/tabs/agents.js

async function renderAgents() {
  const container = document.getElementById('tab-agents');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    const agents = await window._dash.api('agents');

    if (agents.length === 0) {
      container.innerHTML = '<div class="empty-state">No agents configured. Run gossip_setup to create your team.</div>';
      return;
    }

    container.innerHTML = `<div class="agent-cards">${agents.map(renderAgentCard).join('')}</div>`;
  } catch (err) {
    container.innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
  }
}

function renderAgentCard(agent) {
  const s = agent.scores;
  return `
    <div class="agent-detail-card">
      <div class="agent-header">
        <div>
          <strong>${agent.id}</strong>
          ${agent.native ? '<span class="agent-badge">native</span>' : ''}
          <div class="agent-meta">${agent.provider} / ${agent.model}${agent.preset ? ` (${agent.preset})` : ''}</div>
        </div>
        <div class="weight-badge" style="font-size:1.25rem">${s.dispatchWeight.toFixed(2)}</div>
      </div>

      <div class="agent-stats">
        <div class="agent-stat">
          <div class="num" style="color:var(--accent-primary)">${(s.accuracy * 100).toFixed(0)}%</div>
          <div class="lbl">Accuracy</div>
        </div>
        <div class="agent-stat">
          <div class="num" style="color:var(--accent-secondary)">${(s.uniqueness * 100).toFixed(0)}%</div>
          <div class="lbl">Uniqueness</div>
        </div>
        <div class="agent-stat">
          <div class="num" style="color:var(--status-confirmed)">${(s.reliability * 100).toFixed(0)}%</div>
          <div class="lbl">Reliability</div>
        </div>
        <div class="agent-stat">
          <div class="num">${s.signals}</div>
          <div class="lbl">Signals</div>
        </div>
        <div class="agent-stat">
          <div class="num">${s.agreements}</div>
          <div class="lbl">Agrees</div>
        </div>
        <div class="agent-stat">
          <div class="num">${s.disagreements}</div>
          <div class="lbl">Disagrees</div>
        </div>
        <div class="agent-stat">
          <div class="num" style="color:var(--status-disputed)">${s.hallucinations}</div>
          <div class="lbl">Hallucinations</div>
        </div>
      </div>

      ${agent.skills.length > 0 ? `
        <div style="margin-top:1rem">
          <div class="panel-title" style="margin-bottom:0.5rem">Skills</div>
          <div style="display:flex;flex-wrap:wrap;gap:0.375rem">
            ${agent.skills.map(sk => `<span class="agent-badge">${sk}</span>`).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/dashboard/src/tabs/agents.js
git commit -m "feat(dashboard): agents tab — detail cards with scores, skills"
```

---

## Task 12: esbuild Bundler + Root Config

**Files:**
- Create: `packages/dashboard/build.js`
- Modify: `package.json` (root)

- [ ] **Step 1: Create build.js — bundles into single HTML file**

```javascript
// packages/dashboard/build.js
const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const esbuild = require('esbuild');

const srcDir = join(__dirname, 'src');
const outDir = join(__dirname, '..', '..', 'dist-dashboard');

async function build() {
  // Bundle JS
  const jsResult = await esbuild.build({
    entryPoints: [
      join(srcDir, 'app.js'),
      join(srcDir, 'tabs', 'overview.js'),
      join(srcDir, 'tabs', 'agents.js'),
    ],
    bundle: false,
    write: false,
    minify: process.env.NODE_ENV === 'production',
    target: 'es2022',
  });

  const jsBundle = jsResult.outputFiles.map(f => f.text).join('\n');
  const css = readFileSync(join(srcDir, 'style.css'), 'utf-8');
  const htmlTemplate = readFileSync(join(srcDir, 'index.html'), 'utf-8');

  // Inline CSS and JS into the HTML
  const html = htmlTemplate
    .replace('<link rel="stylesheet" href="/dashboard/assets/style.css">', `<style>\n${css}\n</style>`)
    .replace('<script src="/dashboard/assets/app.js"></script>', `<script>\n${jsBundle}\n</script>`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html);
  console.log(`Dashboard built → ${join(outDir, 'index.html')} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}

build().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Update root package.json — add build:dashboard script and workspace**

Add to root `package.json` scripts:

```json
"build:dashboard": "node packages/dashboard/build.js"
```

The `workspaces` array already includes `"packages/*"` so `packages/dashboard` is automatically included.

- [ ] **Step 3: Build the dashboard**

Run: `npm run build:dashboard`
Expected: `Dashboard built → dist-dashboard/index.html (XX.X KB)`

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/build.js package.json
git commit -m "feat(dashboard): esbuild bundler — single-file HTML output"
```

---

## Task 13: Serve Built Dashboard + End-to-End Smoke Test

**Files:**
- Modify: `packages/relay/src/dashboard/routes.ts` (update `serveDashboard` path)

The `serveDashboard` method in Task 7 reads from `dist-dashboard/index.html` relative to `projectRoot`. However, `dist-dashboard/` is at the repo root, not the project root. Fix the path resolution:

- [ ] **Step 1: Update serveDashboard to check both locations**

In `packages/relay/src/dashboard/routes.ts`, update the `serveDashboard` method. The constructor should accept an optional `dashboardHtmlPath` that defaults to a sensible location:

```typescript
// In DashboardRouter constructor, add optional param:
constructor(
  private auth: DashboardAuth,
  private projectRoot: string,
  private ctx: DashboardContext,
  private dashboardHtmlPath?: string,
) {}

// Update serveDashboard:
private serveDashboard(res: ServerResponse): boolean {
  const paths = [
    this.dashboardHtmlPath,
    join(this.projectRoot, 'dist-dashboard', 'index.html'),
  ].filter(Boolean) as string[];

  for (const htmlPath of paths) {
    if (existsSync(htmlPath)) {
      const html = readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    }
  }

  res.writeHead(503, { 'Content-Type': 'text/plain' });
  res.end('Dashboard not built. Run: npm run build:dashboard');
  return true;
}
```

- [ ] **Step 2: Run all dashboard tests**

Run: `npx jest tests/relay/dashboard --no-coverage`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite to check for regressions**

Run: `npx jest --no-coverage`
Expected: All tests PASS (or only pre-existing failures)

- [ ] **Step 4: Commit**

```bash
git add packages/relay/src/dashboard/routes.ts
git commit -m "fix(dashboard): serveDashboard path resolution for bundled HTML"
```

---

## Summary

| Task | Description | Files | Tests |
|------|------------|-------|-------|
| 1 | Auth module | auth.ts | 7 |
| 2 | WebSocket manager | ws.ts | 5 |
| 3 | Overview API | api-overview.ts | 3 |
| 4 | Agents API | api-agents.ts | 3 |
| 5 | Skills API | api-skills.ts | 4 |
| 6 | Memory API | api-memory.ts | 6 |
| 7 | Route handler | routes.ts, index.ts | 5 |
| 8 | Wire into relay | server.ts (modify) | 4 |
| 9 | HTML + CSS | index.html, style.css | — |
| 10 | App JS + Overview tab | app.js, overview.js | — |
| 11 | Agents tab | agents.js | — |
| 12 | esbuild bundler | build.js | — |
| 13 | Path fix + smoke test | routes.ts (fix) | full suite |

**Total: 13 tasks, ~37 tests, 13 commits**
