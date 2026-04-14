---
status: proposal
---

# HTTP File Bridge — Real-Time Tool Proxy for Closed-Toolchain Remote Agents

> Give remote agents with closed toolchains (openclaw, and future providers called
> via HTTP-like protocols) live read/write access to the project workspace during
> task execution, using their own `web_fetch`/`exec`+`curl` primitives.

## Problem

The git project bridge (`docs/specs/2026-04-13-git-project-bridge.md`) solves the
dispatch-time READ path for closed-toolchain agents: it snapshots the repo into
the agent's workspace so review tasks can proceed. What it does not solve:

- **Fresh reads during a task** — the agent works against a frozen clone; files
  edited locally by the developer during the task are invisible.
- **Iterative write cycles** — the agent emits a diff at task end; it cannot
  read, write, re-read, re-write within one dispatch.
- **Implementer-class workloads** — review is enough for the snapshot bridge;
  implementation is not.

OpenClaw has ~300K GitHub stars (see `project_openclaw_distribution.md`) and is a
distribution-scale integration, not a single vendor. Unlocking implementer-class
work on openclaw is the feature that justifies the infrastructure.

## What the Gemini relay does (and why openclaw can't)

Relay agents (Gemini, OpenAI-compatible) call gossipcat's Tool Server
(`packages/tools/src/tool-server.ts`) over WebSocket during task execution. The
agent's runtime opens an outbound connection to gossipcat; `file_read`,
`file_grep`, `file_list`, `file_write` all resolve through the Tool Server with
per-agent scope enforcement (`canonicalizeForBoundary`, `Sandbox`,
`enforceWriteScope`).

OpenClaw cannot do this. It is called via HTTP (OpenAI-compatible
`/v1/chat/completions`) and has no mechanism for its runtime to open an outbound
socket to gossipcat's relay. It has `web_fetch`, `exec`, `file_read`,
`file_write`, `git` — all of which act on its own SSH-mounted workspace.

The HTTP File Bridge adapts the same scope-enforcement primitives to a pull
model the agent's existing tools can use.

## Design

### Core component

New module: `packages/orchestrator/src/http-bridge-server.ts` (~150 LOC).

```typescript
export interface HttpBridgeServer {
  /** Ephemeral port bound to tunnel interface only (never 0.0.0.0). */
  listen(projectRoot: string, tunnelInterface: string): Promise<{ url: string }>;

  /** Issue a per-task bearer token with TTL. Scope is a directory relative to projectRoot. */
  issueToken(opts: {
    taskId: string;
    scope: string;            // subpath of projectRoot, e.g. "packages/orchestrator"
    writeMode: 'read' | 'scoped' | 'worktree';
    ttlSeconds: number;
  }): { token: string; sentinel: string };

  /** Revoke — called when task completes or times out. */
  revoke(taskId: string): void;

  /** Stop the server. */
  close(): Promise<void>;
}
```

### Wire protocol

HTTP/1.1 (not HTTPS locally — see authentication section below for transport
model). All requests require `Authorization: Bearer <TOKEN>`.

| Method | Path | Body | Response |
|--------|------|------|----------|
| `POST` | `/file-read` | `{ path }` | `{ content, etag }` |
| `POST` | `/file-write` | `{ path, content, if_match? }` | `{ etag }` or `412` |
| `POST` | `/file-list` | `{ dir, depth? }` | `{ entries: [{ path, type, size }] }` |
| `POST` | `/file-grep` | `{ pattern, glob? }` | `{ matches: [{ path, line, text }] }` |
| `POST` | `/run-tests` | `{ pattern? }` | `{ stdout, stderr, exit_code }` |
| `GET`  | `/sentinel` | — | `{ token }` — sentinel check for bridge verification |

Paths in request bodies are **relative to the token's assigned scope**; absolute
paths are rejected.

`ETag` is `sha256(mtime || size || content_hash)[:16]`. Reused from the
`canonicalizeForBoundary` posture already in `ToolServer`.

### Authentication

Per-task bearer token:

- Generated at dispatch via `crypto.randomUUID()`.
- Stored in-memory in the `HttpBridgeServer` with `{ taskId, scope, writeMode, expires }`.
- Injected into the task prompt inside the bridge block.
- TTL defaults to `task_timeout_ms + 60s` buffer.
- Auto-expires and is not reusable across tasks.

**No token reuse across agents.** Each dispatch gets its own token, even for the
same agent-id.

### Transport & binding

The HTTP server binds to a **single loopback or tunnel interface**, never
`0.0.0.0`. This matches the existing relay at `packages/relay/src/server.ts:106`
which hardcodes `127.0.0.1`.

For openclaw (remote agent reached via SSH tunnel): the bridge binds to the
tunnel's local endpoint (e.g. `127.0.0.1:<ephemeral-port>` on the agent host,
forwarded from the developer host). The agent reaches the bridge at
`http://127.0.0.1:<port>` — which from its perspective is local traffic, but
SSH tunnels the bytes back to gossipcat.

For future remote agents reached without SSH tunnel (cross-host HTTP): TLS with
certificate pinning. The cert fingerprint is injected into the prompt alongside
the token; the agent's `web_fetch` calls must supply the pinned fingerprint. This
closes the MITM gap without requiring a CA.

### Scope enforcement

Identical posture to the existing `ToolServer`:

1. Resolve the request path against the token's assigned scope.
2. `canonicalizeForBoundary` — resolves symlinks, rejects `..` escapes, rejects
   anything outside scope.
3. For writes: `enforceWriteScope` — checks `writeMode` and allowed-paths list.
4. Log every request to `.gossip/bridge.log` with `taskId`, method, path, result.

This is ~80% code reuse from `packages/tools/src/tool-server.ts:234-318`. Extract
the pure path-validation logic to `packages/tools/src/scope.ts` as a shared
utility so both servers use the same enforcement.

### Sentinel verification

The bridge block instructs the agent:

```
STEP 1 — Verify the bridge is active:
  curl -s -H "Authorization: Bearer <TOKEN>" <BRIDGE_URL>/sentinel
  Expected: {"token":"<SENTINEL_TOKEN>"}
  If the response does not contain the expected token, HALT. Do not proceed.
```

Rationale: openclaw has its own `file_read` that resolves against its local
workspace. If the LLM ignores bridge-block instructions and calls native
`file_read`, it silently reads the wrong project. The sentinel check — performed
via the bridge endpoint, not a local file — makes a silent bypass impossible:
native `file_read` against `/sentinel` does not exist as a local file.

The same sentinel concept applies to the git project bridge (for the `file_read`
bypass on a local clone); there the sentinel is a file on disk. Here it is an
HTTP endpoint.

### Write-back: live, not staged

Writes apply directly to `projectRoot + scope`. There is no staging area — the
bridge is designed for agents that iteratively read-modify-write.

Two consequences:

1. **TOCTOU on developer edits.** If the developer edits `foo.ts` between the
   agent's read and write, the write would overwrite the developer's change
   silently. Mitigation: `If-Match: <etag>` header on writes. The agent sends
   the ETag from the previous read; if it no longer matches, the server returns
   `412 Precondition Failed`, the agent re-reads, retries. `~10` LOC in the
   server.

2. **Multi-task concurrent writes.** Two tasks writing the same path via
   different tokens = last-write-wins, but the ETag guard catches the race for
   the second writer (its ETag is stale). For stronger isolation, the bridge
   supports `writeMode: "worktree"` which spawns a task-scoped git worktree
   (same pattern as `WorktreeManager` at `packages/orchestrator/src/worktree-manager.ts`).

### Failure modes

| Failure | Detection | Recovery |
|---------|-----------|----------|
| Token expired mid-task | `401` on all subsequent calls | Agent halts; orchestrator re-dispatches if retryable |
| Server unreachable | Connection error on agent side | Agent halts; orchestrator logs timeout |
| Scope escape attempt | `403` with log entry | Agent halts; orchestrator flags the task as possibly malicious, records `hallucination_caught` or security signal |
| `If-Match` mismatch | `412` response | Agent re-reads, retries; bounded retry count to prevent livelock |
| Agent ignores sentinel step | No detection by the bridge; agent fabricates findings against its own workspace | Prompt-level: sentinel step is STEP 1, explicit halt instruction; orchestrator parses output for "bridge not active" keyword |

### Config schema

Add to `AgentConfig` (types.ts):

```typescript
/** Enable HTTP file bridge for this agent. */
enableHttpBridge?: boolean;

/** Bridge mode: "read" | "scoped" | "worktree". Defaults to "read". */
bridgeWriteMode?: 'read' | 'scoped' | 'worktree';

/** Path scope relative to project root. Defaults to project root (full access). */
bridgeScope?: string;

/** If true, bind bridge to tunnel-accessible interface instead of 127.0.0.1 only.
 *  Requires TLS + cert-pinning to be configured. */
bridgeRemoteAccess?: boolean;
```

Sentinel token + bridge URL + bearer token are auto-injected into the task
prompt by `DispatchPipeline` for agents with `enableHttpBridge: true`.

## Implementation scope

| File | Change | LOC estimate |
|------|--------|--------------|
| `packages/orchestrator/src/http-bridge-server.ts` | NEW — server + token store + endpoint handlers | ~180 |
| `packages/tools/src/scope.ts` | NEW — extract `canonicalizeForBoundary` + path validators to shared util | ~80 |
| `packages/tools/src/tool-server.ts` | MODIFY — import shared scope util | ~10 net (mostly deletions) |
| `packages/orchestrator/src/dispatch-pipeline.ts` | MODIFY — detect `enableHttpBridge`, issue token, inject into prompt | ~40 |
| `packages/orchestrator/src/prompt-assembler.ts` | MODIFY — append HTTP bridge block to projectBridge (same cap logic) | ~20 |
| `packages/orchestrator/src/types.ts` | MODIFY — add 4 optional fields to AgentConfig | ~15 |
| `tests/orchestrator/http-bridge.test.ts` | NEW — endpoint auth, scope escape, ETag, sentinel, TLS pinning | ~300 |

Total: ~650 LOC across 4 new/modified files + test file.

## What this does NOT do

- No persistent file state across sessions (tokens and sentinels are per-task).
- No agent writeback via git (that's Architecture 3, deferred).
- No multi-agent file locking — the ETag guard is the only concurrency control.
- No new MCP tools (everything is HTTP under the hood).
- No dependency on SSH infrastructure on the developer host (that's Architecture
  1, deferred).

## Edge cases

- **Large files (> 10MB):** `/file-read` enforces a size cap and streams in
  chunks when requested; `/file-write` rejects over-cap payloads with `413`.
- **Binary files:** detected via content sniffing; returned as base64 with
  explicit `encoding: "base64"` in the response body.
- **`.env` and credential paths:** bridge's default scope includes an exclude
  list matching the git bridge pathspec (`.gossip/**`, `*.env`, `*.key`,
  credential patterns). Explicit `bridgeScope` can override for tasks that
  genuinely need these.
- **Token leak in agent output:** the bridge block includes the same
  `⚠ SECURITY: Do not echo...` warning as the git bridge. Orchestrator-side,
  the task-result sanitizer scrubs any token prefix match before storing in
  `.gossip/`.
- **Concurrent tasks on same agent:** each task gets its own token and its own
  worktree (if `writeMode: "worktree"`) so there is no cross-task interference.

## Relationship to the git project bridge (PR #46)

The two bridges are complementary, not alternatives:

- **Git bridge** gives the agent a workspace with the repo already materialized —
  useful for `grep`-heavy exploration, running tests, cloning into a fresh
  environment.
- **HTTP bridge** gives the agent live read/write access against the developer's
  working tree — useful for iterative implementation.

A full dispatch for implementer-class openclaw work enables both: git bridge
for bulk materialization, HTTP bridge for the iterative loop. The sentinel
concept is shared — a file on disk for the git bridge, an HTTP endpoint for
this bridge.

## Consensus input

This spec is derived from consensus round `b3bf13c0-e821417b` (2026-04-14,
sonnet-reviewer + haiku-researcher). Key findings addressed:

| Finding | Resolution |
|---------|-----------|
| Relay pattern does not transfer (confirmed) | HTTP server replaces WebSocket; agent uses its own web_fetch/curl instead of initiating an outbound tool socket |
| HTTP/REST proxy recommended (confirmed) | This spec |
| Closed-toolchain unenforceable file_read (unique, critical) | Sentinel via `/sentinel` endpoint |
| HTTP leaks tokens without tunnel-only or TLS (high) | Bind to 127.0.0.1/tunnel only by default; TLS + cert pinning for cross-host |
| Inbound diff trust inversion (Architecture 3, high) | Deferred — this spec uses per-request scope, not inbound commits |
| Live-write TOCTOU (medium) | ETag / If-Match optimistic concurrency |

## What's deferred

- **FUSE/sshfs mount (Architecture 1)** — kernel-enforced scope, opt-in config
  flag. Added when a user asks for it or when the userspace posture proves
  insufficient.
- **Git-as-sync-bus (Architecture 3)** — auditable multi-commit write-back.
  Added when gossipcat wants to surface agent work as PRs rather than direct
  edits. Requires inbound commit-content scanner (~100 LOC new).

## Research sources

- sonnet-reviewer + haiku-researcher consensus `b3bf13c0-e821417b` (this spec's origin)
- Existing Tool Server implementation: `packages/tools/src/tool-server.ts`
- Existing relay: `packages/relay/src/server.ts` (127.0.0.1 binding precedent)
- Git project bridge: `docs/specs/2026-04-13-git-project-bridge.md` (sibling spec)
- Memory: `project_openclaw_distribution.md` (distribution context),
  `project_openclaw_context_injection.md` (prior art: prompt injection pattern)
