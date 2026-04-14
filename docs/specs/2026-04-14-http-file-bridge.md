---
status: implementable
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

`ETag` is `sha256(mtime + '|' + size + '|' + content_hash)[:16]` — pipe delimiter to prevent
component-boundary collisions (e.g. `mtime=12, size=345` vs `mtime=123, size=45` hashing
identically). Reused from the `canonicalizeForBoundary` posture already in `ToolServer`.

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

The bridge adapts the same security posture from `ToolServer` — it is NOT ~80% drop-in
reuse. The cleanly-extractable core is `canonicalizeForBoundary` (including its
non-existent-path branch at `tool-server.ts:33-41` — the function itself spans
`tool-server.ts:29-44` — that resolves the parent and reattaches the basename, critical
for `/file-write` on paths that don't yet exist) plus a `validatePathInScope` helper.
Both are extracted to `packages/tools/src/scope.ts` (~50 LOC shared util). The bridge's
per-endpoint enforcement logic (~200 LOC in `http-bridge-server.ts`) reuses these
primitives but cannot share ToolServer's per-request control flow directly because the
HTTP error surface (401/403/412/413/429) differs from the WebSocket tool-call surface.
Net code change in `tool-server.ts`: ~-20 LOC (deletions from extraction).

**Parallel canonicalization in `sandbox.ts`.** `packages/tools/src/sandbox.ts` has its
own inline `realpathSync`-based resolution at lines 8 and 31. It is explicitly NOT part
of this extraction — the two canonicalization sources will coexist after this PR. This
is called out so future hardening (e.g., case-folding or trailing-slash rules) lands on
both or neither, not silently on only `scope.ts`.

### Sentinel verification

The bridge block instructs the agent:

```
STEP 1 — Verify the bridge is active:
  curl -s -H "Authorization: Bearer <TOKEN>" <BRIDGE_URL>/sentinel
  Expected: {"token":"<SENTINEL_TOKEN>"}
  If the response does not contain the expected token, HALT. Do not proceed.
```

Rationale: this check mitigates against an agent that attempts to follow instructions but
connects to the wrong environment (e.g. a stale bridge from a prior task, or a bridge
pointing at a divergent workspace). By fetching a unique, task-specific sentinel token
from an HTTP endpoint, the agent confirms it is communicating with the correct, active
bridge for the current task.

**What this does NOT catch:** an agent whose LLM ignores the bridge block entirely. In
that case the agent never performs STEP 1, never hits the bridge endpoint, and silently
reads its own local workspace. This failure mode is structural to prompt-injection
integration — gossipcat cannot force the agent's runtime to execute the curl call. The
orchestrator-side backstop is to parse the agent's result output for evidence that the
sentinel-verification marker was emitted (echoing the retrieved token back in the
agent's response); results that omit the marker are flagged as unverified (no sentinel
evidence) rather than silently trusted.

**Sentinel file vs endpoint — disambiguation.** The git project bridge's sentinel is a
file on disk (`.gossipcat-bridge-sentinel`); this bridge's sentinel is an HTTP endpoint
(`GET /sentinel` over the bridge URL). Both serve the same verification purpose (did
the agent reach the correct workspace?) but at different layers — the git bridge's
check is filesystem-mediated, this bridge's check is endpoint-mediated. See
`docs/specs/2026-04-13-git-project-bridge.md:106` for the git-bridge version. Readers
of both specs should not conflate them.

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
| `packages/orchestrator/src/http-bridge-server.ts` | NEW — server + token store + endpoint handlers + per-endpoint rate gate | ~200 |
| `packages/tools/src/scope.ts` | NEW — extract `canonicalizeForBoundary` (both branches) + `validatePathInScope` | ~50 |
| `packages/orchestrator/src/rate-limiter.ts` | NEW — generic sliding-window limiter supporting BOTH count and weighted-sum modes (`RateLimiter<TWeight = 1>`); feeds both per-endpoint RPS gates and per-token bytes quota | ~80 |
| `packages/relay/src/message-rate-limiter.ts` | REWRITE — re-implement as thin adapter over generic `RateLimiter`. Note: no current production callers in `server.ts`/`router.ts` (only test importers), so the "deletion" framing is misleading; net ~52 → ~25 LOC for parity | ~-25 |
| `packages/tools/src/tool-server.ts` | MODIFY — import shared scope util; convert 5 inline `startsWith(scope)` checks (lines 245, 251, 292, 300, 353) to `validatePathInScope` calls | ~-20 net (deletions) |
| `packages/orchestrator/src/dispatch-pipeline.ts` | MODIFY — detect `enableHttpBridge`, issue token, inject into prompt. Must call `revoke(taskId)` in ALL THREE cleanup paths (completion ~line 339, timeout ~478-484, reaper ~660-665) mirroring existing `releaseAgent` pattern. Also extend `detectFormatCompliance` (~line 65-74) with a sentinel-emission detector that flags results missing the sentinel-echo marker as unverified | ~55 |
| `packages/orchestrator/src/prompt-assembler.ts` | MODIFY — introduce NEW `parts.bridgeBlock` argument to `assemblePrompt` + block generator (token/URL/sentinel substitution + sentinel-verification instructions). There is NO existing `projectBridge` block — the git-bridge sibling spec is still `status: proposal`, so this spec does not depend on it. Insert into the blocks priority order at ~line 190 under the existing `MAX_PROMPT_CHARS = 30_000` cap | ~45 |
| `packages/orchestrator/src/types.ts` | MODIFY — add 4 optional fields to AgentConfig | ~15 |
| `tests/orchestrator/http-bridge.test.ts` | NEW — endpoint auth, scope escape, ETag, sentinel (including orchestrator-side "missing sentinel echo" detection), rate limit + 429 body shape, in-flight-bytes quota, pre-body Content-Length check | ~350 |
| `tests/orchestrator/http-bridge-tls.test.ts` | NEW — TLS cert-pinning tests in a separate file because the repo has NO existing `tls.createServer`/self-signed cert fixture; includes per-test cert generation | ~100 |
| `tests/orchestrator/rate-limiter.test.ts` | NEW — sliding-window correctness (count mode), weighted-sum correctness, concurrent access, window rollover | ~100 |
| `package.json` | MODIFY — add `selfsigned` (or `node-forge`) devDependency for TLS test fixture | ~+1 |

Total: ~970 LOC across 6 new + 6 modified files. Higher than the pre-consensus
~765 estimate because the code-level pre-implementation review (consensus round
`2026-04-14 sonnet-reviewer + haiku-researcher`) surfaced three missed work items:
(a) sentinel orchestrator-side parsing had no implementation home, (b) the repo has no
pre-existing TLS test fixture so cert-pinning coverage needs its own file + dev
dependency, (c) the generic rate limiter must support both count and weighted-sum modes
to drive the in-flight-bytes quota. See "Pre-implementation code review" section below
for the full finding set.

## What this does NOT do

- No persistent file state across sessions (tokens and sentinels are per-task).
- No agent writeback via git (that's Architecture 3, deferred).
- No multi-agent file locking — the ETag guard is the only concurrency control.
- No new MCP tools (everything is HTTP under the hood).
- No dependency on SSH infrastructure on the developer host (that's Architecture
  1, deferred).

## Edge cases

- **Large files (> 10MB):** `/file-read` rejects over-cap files with `413` (and an
  optional `hint` field suggesting the git bridge for bulk materialization); `/file-write`
  pre-checks `Content-Length` before reading the request body and rejects over-cap
  payloads with `413`. Chunked streaming is deferred — if an agent requires chunked
  reads of large files, use the git bridge (Architecture 1) instead, which materializes
  the repo into the agent's workspace for filesystem-level access.
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

## Resolved decisions

The 11 gaps surfaced by the 2026-04-14 pre-merge audit (tasks `6902e935` / `fcfcba5a`)
were reviewed in a 3-agent consensus round `4693d81d-2ebb46e9` (gemini-reviewer +
haiku-researcher + sonnet-reviewer cross-check). The resolutions below are folded
into the spec body above — this section records the decisions for traceability.

### Error response body (HIGH)

All non-2xx responses use a uniform JSON shape:

```json
{ "error": "<short_class>", "code": "<enumerated_code>", "message": "<human_text>" }
```

- `error` — coarse HTTP class (e.g. `unauthorized`, `forbidden`, `precondition_failed`).
- `code` — machine-readable enumerated discriminator (e.g. `token_expired`,
  `scope_violation`, `etag_mismatch`, `payload_too_large`, `too_many_requests`,
  `version_mismatch`). Agents dispatch on `code`, not on HTTP status alone — required
  so the Failure modes table above can distinguish `token_expired` (401) from a
  bad-request (400).
- `message` — human-readable text for logs and error messages.

For `429` responses specifically the body is extended with `retry_after`:
`{ "error": "too_many_requests", "code": "too_many_requests", "message": "...", "retry_after": 60 }`.
The `Retry-After: 60` header is also sent, but the body field is the machine-readable
source of truth — some LLM tool-call parsers strip headers before the model sees them.

### Rate limiting (HIGH)

Per-token rate limits on a 60-second sliding window. Exceeding a limit returns `429`
with both the `Retry-After: 60` header and the `retry_after` body field:

| Endpoint | Limit (per minute) |
|----------|--------------------|
| `/file-read`, `/file-list`, `/sentinel` | 100 |
| `/file-write` | 50 |
| `/file-grep` | **20** — plus per-request match cap (500 matches) and 2s regex timeout. Grep is unbounded CPU/IO without co-requisite bounds; the low RPS alone is insufficient |
| `/run-tests` | 10 |
| `/bridge-info` | 100, **keyed by source IP not token** (pre-auth, see below) |

`412` responses (ETag mismatch) do NOT count against the per-token RPS cap. Orchestrator-side
retry budget: 3 retries per task per write. Unbounded client loops on 412 are bounded by
the server's `Retry-After`-gated timeout rather than consuming the RPS quota.

**In-flight bytes quota (anti-exhaustion):** 10MB cap × 100 req/min on `/file-read` is
1GB/min per token. Add per-token `bytes_read_last_60s` and `bytes_written_last_60s`
counters; if either exceeds 50MB/min, subsequent requests return `429` until the
window clears. This bounds memory/disk exhaustion under a slow or looping agent
even when per-request size caps are respected.

### Sentinel verification wording (HIGH)

The Sentinel verification subsection has been rewritten above to (a) drop the
incorrect "makes silent bypass impossible" claim, (b) name orchestrator-side
result-parsing as the backstop against full bridge-block skip, (c) add an explicit
disambiguation sentence vs the git-bridge file-based sentinel.

### Observability (MEDIUM)

All bridge requests log to `.gossip/bridge.log` as JSON-lines:

```json
{ "timestamp": "<iso8601>", "taskId": "...", "tokenHash": "<sha256(token)[:12]>",
  "method": "...", "path": "...", "status": <int>, "bytesRead": <int>,
  "bytesWritten": <int>, "durationMs": <int> }
```

- `tokenHash` is the first 12 hex chars (48 bits) of `sha256(token)` — NEVER a prefix
  of the raw token itself (leaks partial credential). 48 bits eliminates realistic
  intra-session collisions (birthday bound ~16M).
- Rotation model follows the project's existing archive pattern for parity with
  memory-compactor and session-gossip logs: append-only JSONL, rotated when the
  live file exceeds a configurable `bridge_log_max_bytes` (default 10MB), rotated
  files named `.gossip/bridge.log.<N>` without gzip. Retain last 5 rotations by
  default. Users can override both the size cap and retention count via
  `config.bridge.log.{max_bytes, retain_count}`.
- **Per-task aggregates** are computed at token-revoke time and stored in the
  task metadata for dashboard surfacing: `bridge_requests_total`,
  `bridge_bytes_read_total`, `bridge_bytes_written_total`, `bridge_latency_p99_ms`.

### Wire-protocol versioning (MEDIUM)

- All bridge responses include `X-Bridge-Version: 1` header.
- `GET /bridge-info` is **pre-auth** (no bearer token required) and returns only
  non-sensitive metadata: `{ "version": 1, "capabilities": { "endpoints": [...],
  "auth": "bearer", "etag": true } }`. Pre-auth is essential because `/bridge-info`'s
  primary use case is wire-protocol negotiation when the agent doesn't yet have a
  token (startup) or its token has expired (handshake after 401). Requiring a valid
  bearer token would make `/bridge-info`'s own 401 indistinguishable from a data-endpoint
  401 and would block the version-mismatch detection path entirely.
- `/bridge-info` is rate-limited at 100/min keyed by source IP (not token), binding
  the pre-auth surface.
- Version mismatch (client expects a version the server does not support) returns
  `400` with `{ "error": "bad_request", "code": "version_mismatch", "message": "..." }`.

### Concurrent-read visibility (MEDIUM)

Read isolation is explicitly **read-committed from the live filesystem**. There is no
read isolation across concurrent tasks or between a task and a developer editing
locally; all read operations (`/file-read`, `/file-list`, `/file-grep`) fetch from the
current working tree. A task that reads a file, has the developer edit it, and reads
again will see the newer version. The `If-Match` ETag mechanism is the sole protection
against overwriting external changes during a write — it is a write-race guard, not a
read-isolation guarantee. Tasks requiring snapshot isolation must use
`writeMode: "worktree"`.

### Scope extraction (MEDIUM)

Extractable primitives land at `packages/tools/src/scope.ts`:
- `canonicalizeForBoundary(root, path)` — resolves both the "path exists" branch
  (follow symlinks, reject `..` escapes) AND the "path does not yet exist" branch
  (resolve parent, reattach basename to prevent ancestor-directory symlink escapes
  during `/file-write`). Both branches are mandatory; omitting the non-existent-path
  branch regresses the write scope guard relative to the existing ToolServer.
- `validatePathInScope(scope, canonicalPath)` — final membership check.

See also the expanded discussion in the Scope enforcement section above (line ~132)
for the revised LOC estimate. **Generic RateLimiter extraction:** extract a generic
`RateLimiter<TWeight = 1>` class to `packages/orchestrator/src/rate-limiter.ts` with a
`record(key, weight?)` method and `currentWeight(key)` accessor. It must support BOTH
count mode (relay's message rate gate, weight=1) and weighted-sum mode (bridge's
in-flight-bytes quota where weight = request size). The existing
`packages/relay/src/message-rate-limiter.ts` becomes a thin adapter. Caveat: the existing
`MessageRateLimiter` is not wired into `server.ts`/`router.ts` production paths today —
only test files reference it — so the rewrite is about substrate consolidation, not
production-path refactoring.

### Streaming semantics (LOW)

Chunked streaming is deferred. Both `/file-read` and `/file-write` reject payloads
exceeding the 10MB cap with `413`. Size-check mechanism for writes is a pre-body
`Content-Length` inspection — the bridge never reads a multi-megabyte request body
only to discard it. For reads, the file's on-disk size is checked before any body
is serialized. If an agent requires chunked reads of large files, use the git bridge
(Architecture 1) instead; it materializes the repo into the agent's workspace for
direct filesystem access. If/when a concrete use case for chunked HTTP reads emerges,
a future v2 protocol can add offset/size query params + `X-Remaining-Bytes` response
header.

### Consensus round traceability

Verification details for each decision are in consensus report
`.gossip/consensus-reports/4693d81d-2ebb46e9.json` (8 confirmed, 1 disputed-and-rebuttal-hallucinated,
2 unverified-then-orchestrator-verified, 5 unique-then-verified). The disputed
finding (gemini-reviewer:f3 — "Decision #9 blocks large files") was confirmed correct
on orchestrator re-verification; the rebuttal's spec quote did not exist in the file.
See `docs/specs/2026-04-13-git-project-bridge.md:102` and
`packages/tools/src/tool-server.ts:29-44` for the reference primitives cited in
multiple resolutions.

## Pre-implementation code review

Before writing any code, a third consensus round (2026-04-14, sonnet-reviewer native +
haiku-researcher native; gemini-reviewer attempted and failed with Google 503) verified
the Implementation scope table against the actual codebase state on master. Both agents
cross-confirmed each other's findings. Five HIGH-severity items were surfaced:

| # | Finding | Resolution in this revision |
|---|---------|-----------------------------|
| 1 | `projectBridge` block referenced by spec does NOT exist in `prompt-assembler.ts`; sibling git-bridge spec is still `status: proposal` | Prompt-assembler row rewritten to "introduce NEW `parts.bridgeBlock` argument"; LOC bumped 20 → 45 |
| 2 | `MessageRateLimiter` has zero production callers (only test-file references); "-30 LOC deletions" framing is misleading | Row reframed as REWRITE, net ~-25 LOC with explicit caveat |
| 3 | Sentinel orchestrator-side parsing (spec §Sentinel verification) had NO implementation home | Folded into `dispatch-pipeline.ts` row: extend `detectFormatCompliance` with a sentinel-emission detector (~+15 LOC); total bump 40 → 55 |
| 4 | No HTTP/TLS test harness exists in repo; cert-pinning tests need their own fixture + `selfsigned` dependency | Split `http-bridge-tls.test.ts` into its own 100-LOC file; added `package.json` row for `selfsigned` |
| 5 | Three implementation foot-guns: (a) `revoke(taskId)` must fire in 3 cleanup paths in `dispatch-pipeline.ts`, (b) generic `RateLimiter` needs count AND weighted-sum modes for in-flight-bytes quota, (c) `express.json({limit:'10mb'})` DOES NOT satisfy pre-body Content-Length requirement — must inspect header before attaching body-stream listener | All three folded into the relevant rows (dispatch-pipeline, rate-limiter, http-bridge-server). The Content-Length handling is a verification checklist item for the implementer's PR description |

Medium-severity items folded into the revised design:
- `sandbox.ts` parallel canonicalization — acknowledged explicitly in §Scope enforcement as dual-source (NOT this PR).
- `AgentConfig.bridgeRemoteAccess: true` silent footgun — implementer must add a runtime guard rejecting the flag when no TLS cert is configured; this is enforced at the `dispatch-pipeline.ts` branch, not in types.
- `FileTools.fileGrep` has none of the spec's grep protections (2s timeout, 500 match cap, ReDoS defense) — implementer should either harden `FileTools.fileGrep` in place (applies to the WebSocket path too, net positive) or write a `safeFileGrep` wrapper in the bridge module.

Spec line-range reference `tool-server.ts:29-43` (used earlier in this doc for
`canonicalizeForBoundary`) was off-by-one — the function actually spans `:29-44`.
Updated in the §Scope enforcement section and §Resolved decisions → Consensus round
traceability. The non-existent-path branch itself is at `:33-41` and is intact.

## Research sources

- sonnet-reviewer + haiku-researcher consensus `b3bf13c0-e821417b` (this spec's origin)
- sonnet-reviewer + haiku-researcher pre-merge audit tasks `6902e935` + `fcfcba5a`
  (2026-04-14) — source of the 11 pre-resolution gaps
- gemini-reviewer + haiku-researcher + sonnet-reviewer consensus `4693d81d-2ebb46e9`
  (2026-04-14) — tightened the 11 resolutions into the Resolved decisions section
- sonnet-reviewer + haiku-researcher pre-implementation code review (2026-04-14) —
  validated the Implementation scope table against actual master state; surfaced the
  five HIGH items documented above in §Pre-implementation code review
- Existing Tool Server implementation: `packages/tools/src/tool-server.ts`
- Existing relay: `packages/relay/src/server.ts` (127.0.0.1 binding precedent)
- Git project bridge: `docs/specs/2026-04-13-git-project-bridge.md` (sibling spec)
- Memory: `project_openclaw_distribution.md` (distribution context),
  `project_openclaw_context_injection.md` (prior art: prompt injection pattern)
