# Team-Aware Supabase Sync — Design Spec

> Addendum to Phase 2 TaskGraph Supabase design. Adds multi-user team support to the existing sync infrastructure.

**Date:** 2026-03-23
**Status:** Draft
**Dependencies:** TaskGraph Supabase Sync (shipped), identity.ts (shipped)
**Enables:** Team dashboards, cross-user agent performance comparison, shared task history

---

## Problem Statement

The current Supabase sync uses `sha256(cwd)` for project identity and `sha256(email + cwd + localSalt)` for user identity. This breaks for teams:

1. **Different checkout paths** — Alice at `/Users/alice/myapp` and Bob at `/Users/bob/myapp` get different `projectId` hashes. Their tasks never correlate.
2. **Opaque user IDs** — local salts make user IDs unlinkable. No way to see "Bob's agents found 3 bugs yesterday."
3. **No shared identity** — no concept of "same team, same project."

## Design Overview

```
Alice's machine                           Supabase (shared)
.gossip/task-graph.jsonl  ──sync──►  ┌────────────────────────┐
  userId: sha256(alice@co + teamSalt) │ project: myapp         │
  projectId: sha256(git remote URL)   │ (from git remote hash) │
                                      │                        │
Bob's machine                         │ Alice: 215 tasks       │
.gossip/task-graph.jsonl  ──sync──►  │ Bob:   142 tasks       │
  userId: sha256(bob@co + teamSalt)   │ Carol:  89 tasks       │
  projectId: sha256(git remote URL)   │                        │
                                      │ Team analytics:        │
Carol's machine                       │ "gemini-reviewer 92%"  │
.gossip/task-graph.jsonl  ──sync──►  │ "447 tasks this week"  │
  projectId: sha256(git remote URL)   └────────────────────────┘
```

Key invariants:
- JSONL remains local source of truth
- Sync is one-way (local → Supabase), never pulls
- Solo mode (default) is unchanged from current behavior
- Supabase is deletable — rebuild from everyone's local JSONLs

## Component 1: Identity Layer

### Project Identity

**Current:** `sha256(process.cwd())` — different per machine.

**New:** Derived from normalized git remote URL:

```typescript
/** Normalize git remote URL to canonical form: hostname/owner/repo
 *  git@github.com:team/myapp.git  → github.com/team/myapp
 *  https://github.com/team/myapp.git → github.com/team/myapp
 *  github.com:team/myapp.git → github.com/team/myapp
 */
function normalizeGitUrl(url: string): string | null {
  if (!url) return null;
  try {
    // Convert SCP-style (git@host:path) to URL format
    const withProtocol = url.replace(/^([^@]+@)?([^:\/]+):(?!\/)/, 'ssh://$2/');
    const parsed = new URL(withProtocol);
    let pathname = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return `${parsed.hostname}/${pathname}`;
  } catch {
    // Fallback for non-standard URLs
    return url.replace(/^(https?:\/\/|git@|ssh:\/\/)/, '').replace(/\.git$/, '').replace(/:/, '/');
  }
}

export function getProjectId(projectRoot: string): string {
  try {
    const remoteUrl = execFileSync(
      'git', ['config', '--get', 'remote.origin.url'],
      { cwd: projectRoot, stdio: 'pipe' }
    ).toString().trim();
    const normalized = normalizeGitUrl(remoteUrl);
    if (normalized) {
      return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    }
  } catch { /* no remote */ }
  // Fallback: cwd-based hash for repos with no remote (solo projects)
  return createHash('sha256').update(projectRoot).digest('hex').slice(0, 16);
}
```

Normalization ensures that SSH, HTTPS, and SCP-style URLs for the same repo produce the same hash. Everyone who clones the same repo gets the same `projectId`.

**Known limitation:** Repo renames on GitHub change the URL for new clones but not existing ones. After a rename, team members with old clones should run `git remote set-url origin <new-url>` to stay in sync.

### User Identity — Two Modes

#### Solo Mode (default)

Unchanged from current implementation:

```typescript
userId = sha256(email + projectRoot + localSalt).slice(0, 16)
```

Opaque, unlinkable. `localSalt` is per-machine, stored in `.gossip/local-salt`.

#### Team Mode (opt-in)

Uses a shared `teamSalt` stored in Supabase:

```typescript
userId = sha256(email + teamSalt).slice(0, 16)
displayName = email  // stored alongside userId in tasks table
```

`teamSalt` is fetched from `team_config` table during setup. Same email + same salt = same userId across all team members' machines. The `displayName` field provides human-readable attribution.

### Identity Function Updates

**File:** `apps/cli/src/identity.ts`

```typescript
// Existing (unchanged):
export function getUserId(projectRoot: string): string { ... }
export function getProjectId(projectRoot: string): string { ... }  // updated to use git remote

// New:
export function getTeamUserId(email: string, teamSalt: string): string {
  return createHash('sha256').update(email + teamSalt).digest('hex').slice(0, 16);
}

export function getGitEmail(): string | null {
  try {
    const email = execFileSync('git', ['config', 'user.email'], { stdio: 'pipe' }).toString().trim();
    return email || null;
  } catch { return null; }
}
```

In team mode, setup MUST abort if `getGitEmail()` returns null — a git email is required for team identity. In solo mode, null falls back to `'anonymous'` (existing behavior).
```

## Component 2: Team Config Table

New Supabase table for shared team metadata:

```sql
CREATE TABLE IF NOT EXISTS team_config (
  project_id text PRIMARY KEY,
  team_salt text NOT NULL,
  project_name text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE team_config ENABLE ROW LEVEL SECURITY;

-- RLS note: single-tenant per Supabase project. Each team gets their own
-- Supabase project, so USING(true) is acceptable — the anon key is the
-- access boundary. For multi-tenant (multiple teams sharing one Supabase
-- project), tighten to require Supabase Auth + JWT claims. Deferred.
CREATE POLICY "Allow all access (single-tenant)" ON team_config
  FOR ALL USING (true) WITH CHECK (true);
```

- First team member creates the row via upsert (`INSERT ... ON CONFLICT (project_id) DO NOTHING`) then fetches. This handles the race where two members run setup simultaneously — both attempt insert, one succeeds, both read the same row.
- `teamSalt` is generated via `randomBytes(32).toString('hex')`
- Subsequent members fetch the existing row by `projectId`
- `project_name` is human-readable (e.g., "myapp") — optional, for display

## Component 3: Schema Changes

### Tasks table — add display_name

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS display_name text;
```

In team mode, `display_name` is set to the user's email. In solo mode, it's null.

### agent_scores — add project_id and display_name

```sql
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE agent_scores ADD COLUMN IF NOT EXISTS display_name text;
CREATE INDEX IF NOT EXISTS idx_scores_project ON agent_scores(project_id);
```

This enables the team-scoped agent performance queries in Component 6. All existing columns remain unchanged.

## Component 4: Sync Command Updates

### Setup Flow

**File:** `apps/cli/src/sync-command.ts`

The `runSetup()` function gains a mode selection step:

```
$ gossipcat sync --setup

  Supabase Sync Setup

  Sync mode:
    A) Solo — private, only your data (default)
    B) Team — shared with teammates on this project

  > B

  Supabase URL: https://xxx.supabase.co
  Anon key: eyJ...
```

**If Team mode — existing team:**
```
  Checking for existing team config...
  ✓ Found team: "myapp" (2 members)

  Your git email (alice@company.co) will be visible to teammates.
  Continue? (Y/n) y

  ✓ Config saved. Run: gossipcat sync
```

**If Team mode — first member:**
```
  Checking for existing team config...
  No team found for this project. Creating...

  Project name (e.g. myapp): myapp

  ✓ Team "myapp" created.

  Your git email (alice@company.co) will be visible to teammates.
  Continue? (Y/n) y

  Share the Supabase URL + anon key with teammates.
  They run: gossipcat sync --setup → Team mode

  ✓ Config saved. Run: gossipcat sync
```

### Config File

**File:** `.gossip/supabase.json` (gitignored)

```json
{
  "url": "https://xxx.supabase.co",
  "projectRef": "xxx",
  "mode": "team",
  "displayName": "alice@company.co"
}
```

In solo mode, `displayName` is absent. `teamSalt` is stored in the OS keychain via `Keychain.setKey('supabase-team-salt', salt)`, NOT in the config file (prevents accidental commit to git). The anon key is also in keychain (existing pattern via `Keychain.setKey('supabase', key)`).

### Sync Behavior

The `TaskGraphSync` class interface is unchanged. The only difference is how `userId` and `projectId` are computed before being passed to the constructor:

```typescript
// In sync-command.ts and mcp-server-sdk.ts:
const config = loadSupabaseConfig();
const email = getGitEmail();

let userId: string;
let displayName: string | null = null;
if (config.mode === 'team') {
  const teamSalt = await keychain.getKey('supabase-team-salt');
  if (!teamSalt) {
    throw new Error('Team mode requires teamSalt in keychain. Run: gossipcat sync --setup');
  }
  if (!email) {
    throw new Error('Team mode requires a git email. Run: git config user.email "you@example.com"');
  }
  userId = getTeamUserId(email, teamSalt);
  displayName = config.displayName || email;
} else {
  userId = getUserId(process.cwd());
}

const projectId = getProjectId(process.cwd());  // now uses git remote
```

The `display_name` field is included in the `syncCreated` payload:

```typescript
// In TaskGraphSync.syncCreated():
await this.upsert('/rest/v1/tasks?on_conflict=id', {
  id: event.taskId,
  agent_id: event.agentId,
  task: event.task,
  skills: event.skills,
  parent_id: event.parentId || null,
  status: 'created',
  user_id: this.userId,
  project_id: this.projectId,
  display_name: this.displayName,  // NEW — null in solo mode
  created_at: event.timestamp,
});
```

## Component 5: TaskGraphSync Constructor Update

The constructor gains an optional `displayName` parameter:

```typescript
export class TaskGraphSync {
  constructor(
    private graph: TaskGraph,
    private supabaseUrl: string,
    private supabaseKey: string,
    private userId: string,
    private projectId: string,
    projectRoot: string,
    private displayName?: string | null,
  ) { ... }
}
```

## Component 6: Team Queries

Example queries enabled by team sync:

```sql
-- Team activity this week
SELECT display_name, agent_id, count(*) as tasks,
       avg(duration_ms)::int as avg_ms
FROM tasks
WHERE project_id = 'abc123'
  AND created_at > now() - interval '7 days'
  AND status = 'completed'
GROUP BY display_name, agent_id
ORDER BY tasks DESC;

-- Best agent for security reviews (across team)
SELECT agent_id,
       avg(accuracy)::numeric(3,1) as avg_accuracy,
       count(*) as reviews
FROM agent_scores
WHERE project_id = 'abc123'
  AND skills @> '{security_audit}'
GROUP BY agent_id
ORDER BY avg_accuracy DESC;

-- What did the team ship yesterday?
SELECT display_name, agent_id, task,
       left(result, 200) as summary, duration_ms
FROM tasks
WHERE project_id = 'abc123'
  AND status = 'completed'
  AND created_at > now() - interval '1 day'
ORDER BY created_at DESC;

-- Agent utilization by team member
SELECT display_name,
       count(*) as total_tasks,
       count(*) FILTER (WHERE status = 'completed') as completed,
       count(*) FILTER (WHERE status = 'failed') as failed,
       avg(duration_ms)::int as avg_duration
FROM tasks
WHERE project_id = 'abc123'
GROUP BY display_name;
```

## Component 7: Per-Task Token Tracking

Inspired by crab-language's per-call token tracking. The gossipcat LLM providers already return `usage: { inputTokens, outputTokens }` in `LLMResponse`, but this data is discarded after each call. This component captures it in TaskGraph and syncs to Supabase for team-wide cost visibility.

### JSONL Event Changes

Add token fields to `task.completed` and `task.failed` events:

```typescript
interface TaskCompletedEvent extends TaskGraphEventBase {
  type: 'task.completed';
  taskId: string;
  result: string;
  duration: number;
  inputTokens?: number;   // NEW — total input tokens for this task
  outputTokens?: number;  // NEW — total output tokens for this task
}

// Same for TaskFailedEvent
```

These are optional (backwards-compatible). Older events without tokens are valid.

### Where Tokens Come From

The `WorkerAgent` runs multi-turn tool loops. Each turn calls `llm.generate()` which returns `LLMResponse.usage`. The worker should accumulate tokens across turns:

```typescript
// In WorkerAgent.executeTask():
let totalInputTokens = 0;
let totalOutputTokens = 0;

// After each LLM call:
if (response.usage) {
  totalInputTokens += response.usage.inputTokens;
  totalOutputTokens += response.usage.outputTokens;
}

// Return alongside result:
return { result, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
```

### Pipeline Integration

`DispatchPipeline.collect()` passes tokens to `TaskGraph.recordCompleted()`:

```typescript
// In collect() post-processing:
if (t.status === 'completed') {
  this.taskGraph.recordCompleted(
    t.id,
    (t.result || '').slice(0, 4000),
    duration,
    t.inputTokens,    // NEW
    t.outputTokens,   // NEW
  );
}
```

### Schema Changes

```sql
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS output_tokens integer;
```

### Sync Changes

`TaskGraphSync.syncCompleted()` includes token fields in the PATCH:

```typescript
private async syncCompleted(event: TaskCompletedEvent): Promise<void> {
  await this.patch(`/rest/v1/tasks?id=eq.${event.taskId}`, {
    status: 'completed',
    result: event.result,
    duration_ms: event.duration,
    completed_at: event.timestamp,
    input_tokens: event.inputTokens ?? null,   // NEW
    output_tokens: event.outputTokens ?? null,  // NEW
  });
}
```

### Team Cost Queries

```sql
-- Token usage by agent this week
SELECT agent_id,
       count(*) as tasks,
       sum(input_tokens) as total_input,
       sum(output_tokens) as total_output,
       sum(input_tokens + output_tokens) as total_tokens
FROM tasks
WHERE project_id = 'abc123'
  AND created_at > now() - interval '7 days'
  AND status = 'completed'
GROUP BY agent_id
ORDER BY total_tokens DESC;

-- Token usage by team member
SELECT display_name,
       count(*) as tasks,
       sum(input_tokens + output_tokens) as total_tokens,
       avg(input_tokens + output_tokens)::int as avg_tokens_per_task
FROM tasks
WHERE project_id = 'abc123'
  AND created_at > now() - interval '7 days'
GROUP BY display_name
ORDER BY total_tokens DESC;

-- Most expensive task types (by average tokens)
SELECT left(task, 60) as task_preview,
       agent_id,
       input_tokens + output_tokens as total_tokens,
       duration_ms
FROM tasks
WHERE project_id = 'abc123'
  AND status = 'completed'
ORDER BY (input_tokens + output_tokens) DESC NULLS LAST
LIMIT 20;
```

### CLI: gossipcat tasks --costs

Extend the existing `gossipcat tasks` command with an optional `--costs` flag:

```
$ gossipcat tasks --costs

Recent Tasks (20):

  072281d1  gemini-reviewer  completed  7s   1.2k tok  Review relay...
  c2e1c121  gemini-reviewer  completed  51s  8.4k tok  Security audit...

  Total: 47.3k input + 12.1k output = 59.4k tokens
```

### What This Does NOT Include

- **Hard budget ceilings** (Paperclip-style) — deferred. Per-task tracking is the foundation; budget enforcement can be added later by checking cumulative tokens against a configured limit before dispatch.
- **Cost in dollars** — token costs vary by model and provider. Raw token counts are more universal. Dollar estimation can be a dashboard feature.
- **Context pressure auto-rollup** (crab-language-style) — gossipcat agents run short tasks (not persistent loops), so context rarely grows large enough to need rollup. Session gossip summarization already handles cross-task context compression.

## Files Changed/Created

| File | Action | Change |
|------|--------|--------|
| `apps/cli/src/identity.ts` | Modify | Add `normalizeGitUrl()`, `getTeamUserId()`, `getGitEmail()`, update `getProjectId()` to use normalized git remote |
| `apps/cli/src/sync-command.ts` | Modify | Add mode selection (solo/team), team config fetch/create, displayName |
| `apps/cli/src/mcp-server-sdk.ts` | Modify | Update syncFactory to use team identity when configured |
| `packages/orchestrator/src/task-graph-sync.ts` | Modify | Add `displayName` constructor param, include in `syncCreated`, add token fields to `syncCompleted` |
| `packages/orchestrator/src/task-graph.ts` | Modify | Add `inputTokens`/`outputTokens` params to `recordCompleted`/`recordFailed` |
| `packages/orchestrator/src/types.ts` | Modify | Add `inputTokens`/`outputTokens` to `TaskCompletedEvent`/`TaskFailedEvent` and `TaskEntry` |
| `packages/orchestrator/src/worker-agent.ts` | Modify | Accumulate token usage across multi-turn tool loops, return in result |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Modify | Pass token counts from task entry to `recordCompleted`/`recordFailed` |
| `apps/cli/src/tasks-command.ts` | Modify | Add `--costs` flag for token display |
| `docs/migrations/002-team-sync.sql` | Create | `team_config` table + `display_name` + `input_tokens`/`output_tokens` columns on tasks |
| `.gossip/supabase.json` | Runtime | Add `mode`, `displayName`, `projectIdVersion`, `previousUserId` fields |

## Security Constraints

- **Team salt stays in keychain** — stored via `Keychain.setKey('supabase-team-salt', salt)`. Never written to `.gossip/` files. Fetched from Supabase `team_config` table during setup, then cached in keychain for offline use.
- **Email as display name** — only stored in Supabase, never in local JSONL. Requires explicit consent during setup ("Your git email will be visible to teammates. Continue?"). Users can decline and stay in solo mode.
- **Solo mode default** — team mode requires explicit opt-in during setup.
- **No pull sync** — you can't read other team members' local data. Supabase is the only shared surface.
- **Anon key sharing** — team members share the Supabase URL + anon key out-of-band. The anon key is non-privileged (only PostgREST access with RLS).

## Migration Path

### projectId change (sha256(cwd) → sha256(gitRemoteUrl))

This changes the `project_id` for all existing synced data. Historical tasks in Supabase will have the old hash. Strategy:

1. On first sync after update, detect the migration: if `.gossip/supabase.json` has no `projectIdVersion` field, this is a pre-migration config.
2. Run a one-time `PATCH` to update `project_id` for all rows matching the old hash:
   ```sql
   UPDATE tasks SET project_id = '{new_hash}' WHERE project_id = '{old_hash}' AND user_id = '{userId}';
   UPDATE agent_scores SET project_id = '{new_hash}' WHERE project_id = '{old_hash}' AND user_id = '{userId}';
   ```
3. Set `projectIdVersion: 2` in `.gossip/supabase.json` so the migration only runs once.
4. If Supabase is not configured (solo mode, no sync), no migration needed — JSONL has no project_id.

### userId change (solo → team mode)

When switching from solo to team mode, the `userId` changes from `sha256(email + cwd + localSalt)` to `sha256(email + teamSalt)`. Historical tasks would be orphaned under the old userId. Strategy:

1. During `sync --setup` when switching to team mode, save the old `userId` in `.gossip/supabase.json` as `previousUserId`.
2. On first team-mode sync, run a one-time `PATCH` to re-assign old tasks:
   ```sql
   UPDATE tasks SET user_id = '{new_userId}', display_name = '{email}'
     WHERE user_id = '{old_userId}' AND project_id = '{projectId}';
   UPDATE agent_scores SET user_id = '{new_userId}', display_name = '{email}'
     WHERE user_id = '{old_userId}' AND project_id = '{projectId}';
   ```
3. Clear `previousUserId` from config after migration.

### Email change handling

If a user changes their git email, their `userId` in team mode will change (different hash). To link old and new identities:

1. The sync command detects email mismatch: `config.displayName !== getGitEmail()`.
2. Prompts: `Your email changed from old@co to new@co. Migrate historical tasks? (Y/n)`
3. If yes: runs the same `PATCH` migration as solo→team (old userId → new userId).
4. Updates `displayName` in config.

This is opt-in — if the user declines, old tasks stay under the old identity.

### Other migration notes

- All new fields are optional/nullable — no breaking schema changes.
- Team mode is opt-in — existing configs without `mode` default to solo.
- The `team_config` table is new — no existing data to migrate.

## Testing Strategy

### URL normalization
- **Unit test:** `normalizeGitUrl` normalizes SSH, HTTPS, SCP-style to same canonical form
- **Unit test:** `normalizeGitUrl('git@github.com:team/myapp.git')` → `'github.com/team/myapp'`
- **Unit test:** `normalizeGitUrl('https://github.com/team/myapp.git')` → `'github.com/team/myapp'`
- **Unit test:** `normalizeGitUrl('github.com:team/myapp.git')` → `'github.com/team/myapp'`
- **Unit test:** `normalizeGitUrl` returns null for empty/undefined input

### Identity
- **Unit test:** `getProjectId` with git remote vs no remote fallback
- **Unit test:** `getProjectId` returns same hash for SSH and HTTPS clones of same repo
- **Unit test:** `getTeamUserId` produces consistent hashes with same salt
- **Unit test:** `getTeamUserId` produces different hashes for different emails
- **Unit test:** `getGitEmail` returns null when git not configured

### Team mode
- **Unit test:** Sync throws when team mode active but teamSalt missing from keychain
- **Unit test:** Sync throws when team mode active but git email is null
- **Unit test:** Setup aborts if user declines email consent prompt
- **Mock test:** `syncCreated` includes `display_name` when provided, null when solo
- **Integration test:** Setup flow creates `team_config` row on first member, fetches on second

### Token tracking
- **Unit test:** `WorkerAgent.executeTask` accumulates tokens across multi-turn loops
- **Unit test:** `recordCompleted` writes `inputTokens`/`outputTokens` to JSONL event
- **Unit test:** `recordCompleted` without tokens (backwards compat) — fields are undefined, not null
- **Unit test:** `syncCompleted` includes `input_tokens`/`output_tokens` in PATCH payload
- **Unit test:** `gossipcat tasks --costs` displays token counts when available, `?` when not
- **Mock test:** Worker with 3 tool turns accumulates correct token total

### Migration
- **Unit test:** projectId migration detects missing `projectIdVersion` and sends PATCH
- **Unit test:** projectId migration only runs once (`projectIdVersion: 2` set after)
- **Unit test:** Solo→team userId migration sends PATCH with old→new userId
- **Unit test:** Email change detected and migration offered
