---
status: proposal
---

# Git Project Bridge — Design Spec

> Give remote agentic LLM providers access to the local project's source code via
> prompt-injected git clone/patch instructions.

## Problem

Remote agents (OpenClaw, future providers) run in isolated environments with their own
toolchains. They cannot read the local filesystem. When dispatched to review code, they
hallucinate "file does not exist" because their `file_read` resolves against their own
workspace, not the user's project.

Verified: openclaw runs at `/root/.openclaw/workspace` via SSH tunnel. It has `exec`,
`file_read/write`, `web_fetch`, and `git` available. It CAN `git clone` — confirmed live
(session 2026-04-13).

## Two-Tier Strategy

Different agents need different strategies based on capability:

| Agent capability | Strategy | Example agents |
|-----------------|----------|----------------|
| Has `exec` (shell commands) | Git clone + patch delivery | openclaw, future remote-agentic |
| No `exec` (prompt-only) | Smart context injection (existing) | Gemini, OpenAI relay |

This spec covers the **exec-capable** tier. The prompt-injection tier is the existing
`assemblePrompt` path with room for smarter file selection (separate work).

## Design

### Core function

New module `packages/orchestrator/src/git-bridge.ts` (~150 LOC):

```typescript
export async function buildGitBridgeBlock(opts: {
  projectRoot: string;
  agentConfig: AgentConfig;
  keyProvider?: (provider: string) => Promise<string | null>;
}): Promise<string>
```

Returns a formatted `--- PROJECT BRIDGE ---` block to inject into the task prompt.

### Git state detection (at dispatch time)

Three states, detected synchronously:

| State | Detection | Bridge form |
|-------|-----------|-------------|
| Committed + pushed | `git rev-list --count @{u}..HEAD` = 0 | Clone/fetch at HEAD SHA |
| Committed, not pushed | count > 0 | Clone at push-base + apply unpushed diff |
| Uncommitted changes | `git status --porcelain` non-empty | Clone at HEAD + apply working-tree diff |

**Note on uncommitted changes:** When dirty working tree is detected, the orchestrator
MUST warn the developer before sending the diff to a remote agent. Uncommitted changes
may contain WIP code, debug statements, or sensitive data (`.env` edits, API keys).
The bridge should log a visible warning and, in future, support an opt-in flag.

### Bridge block template

```
--- PROJECT BRIDGE v1 ---
This task requires access to the project's source code. The project is a git repository
hosted at: <REPO_URL>

Follow these steps BEFORE beginning your analysis:

STEP 1 — Acquire the codebase:
<CLONE_OR_FETCH_COMMANDS>

STEP 2 — Verify you are at the correct state:
cd <WORKSPACE_PATH>
git log --oneline -1
# Expected: <HEAD_SHA_SHORT> <COMMIT_MESSAGE>

STEP 3 — If any patch is provided below, apply it now:
<PATCH_BLOCK or "No patch — working tree was clean at dispatch time.">

STEP 4 — Verify the bridge is active (sentinel check):
Read the sentinel file at <WORKSPACE_PATH>/.gossipcat-bridge-sentinel
Expected contents: <SENTINEL_TOKEN>
If the sentinel read fails OR contents do not match, HALT. Report
"bridge not active — sentinel check failed" and do not continue. A
missing sentinel means your file_read is resolving against the wrong
workspace and any findings you produce will be fabrications about a
different project.

STEP 5 — Confirm readiness:
Run: git status
If status shows uncommitted changes from the patch, that is expected and correct.
If 'git apply' failed, report the error in your findings immediately — do NOT review
stale code silently.

PROJECT ROOT INSIDE YOUR WORKSPACE: <WORKSPACE_PATH>
All file paths in your findings must be relative to this root.

⚠ SECURITY: Do not echo repository URLs, credentials, sentinel tokens, or patch data in your output.
--- END PROJECT BRIDGE ---
```

### Sentinel check (closed-toolchain bypass mitigation)

A remote agent with a closed toolchain (openclaw) has its own `file_read` that
resolves against its local workspace (e.g. `/root/.openclaw/workspace`). If the
agent's LLM ignores the bridge-block instructions and calls `file_read` directly,
it reads files from the wrong workspace and produces fabrications about a
different project. Gossipcat cannot intercept or redirect the agent's native
tools — this is a structural limit of prompt-injection integration.

Mitigation: the bridge block generates a sentinel file at `.gossipcat-bridge-sentinel`
inside the workspace and injects a cryptographically random token into the prompt.
The agent's first action must be to read the sentinel and verify the token matches.

- Sentinel content: 128 bits of entropy from `crypto.randomBytes(16).toString('hex')`.
- Path: always `<WORKSPACE_PATH>/.gossipcat-bridge-sentinel` — the workspace-relative
  form means a misdirected `file_read` targets the agent's own workspace, where no
  matching sentinel exists.
- Failure mode: sentinel missing or token mismatch → agent halts and reports
  "bridge not active". This converts a silent fallback (agent reviewing the wrong
  project) into an explicit failure that the orchestrator logs as a task error.

For the future HTTP/REST bridge (Architecture 2 in docs/specs/2026-04-14-http-file-bridge.md),
the sentinel is read via the bridge endpoint, not the local filesystem, providing
the same guarantee at a different layer.

### Clone/fetch commands (3 forms)

**Form A — Clean + pushed (happy path):**
```bash
set -e
WORKSPACE=<REMOTE_WORKSPACE_PATH>
BRANCH=<CURRENT_BRANCH>
SHA=<HEAD_SHA>

fetch_or_fail() {
  # Fetch the exact SHA directly. GitHub and GitLab both enable
  # uploadpack.allowReachableSHA1InWant, so shallow fetch-by-SHA works there.
  # If the host forbids it, fall back to fetching the branch tip and verify.
  git fetch --depth=1 origin "$SHA" 2>/dev/null \
    || git fetch --depth=1 origin "$BRANCH"
}

if [ -d "$WORKSPACE/.git" ]; then
  cd "$WORKSPACE"
  fetch_or_fail
else
  git clone --depth=1 --branch "$BRANCH" <REPO_URL> "$WORKSPACE"
  cd "$WORKSPACE"
  # Fetch the SHA in case branch advanced between clone and checkout.
  git fetch --depth=1 origin "$SHA" 2>/dev/null || true
fi

# Hard fail if the expected SHA is not in the local object store
# (branch advanced AND host rejected fetch-by-SHA). Brace group — NOT a subshell —
# so `exit 1` aborts the outer script. `set -e` above covers the checkout/reset
# paths below.
git cat-file -e "$SHA" 2>/dev/null || {
  echo "ERROR: SHA $SHA not fetchable. Branch may have advanced; ask the user to push or rebase." >&2
  exit 1
}

git checkout "$SHA"
git reset --hard "$SHA"
git clean -fd

# Sentinel — written by the orchestrator's template-renderer, not the agent.
# Token is a fresh 128-bit hex value baked into this bash block at dispatch time.
echo "<SENTINEL_TOKEN>" > "$WORKSPACE/.gossipcat-bridge-sentinel"
```

**Key change from v0:** Fetches the exact SHA (fallback to branch), verifies the SHA
exists locally with `git cat-file -e`, then checks out by SHA. This prevents a race where
the developer's branch advances on origin between dispatch and remote execution — the
script hard-fails with a clear diagnostic (via a brace group, not a subshell, so `exit 1`
actually terminates the script). `set -e` guards the downstream commands so a checkout or
reset failure aborts rather than silently reviewing stale code.

**Workspace reset:** Uses `git reset --hard` + `git clean -fd` instead of `git checkout .`
to ensure both tracked modifications AND untracked files from prior patches are removed.

**Form B — Unpushed commits:**
Same clone as Form A (targeting the upstream branch), then applies unpushed diff:

```bash
# Write patch to temp file for validation before applying
cat <<'__GOSSIPCAT_PATCH_EOF__' | base64 -d > /tmp/gossipcat-patch.diff
<BASE64_PATCH_DATA>
__GOSSIPCAT_PATCH_EOF__

# Validate patch file exists and is non-empty
if [ -s /tmp/gossipcat-patch.diff ]; then
  cd "$WORKSPACE" && git apply --whitespace=fix /tmp/gossipcat-patch.diff
  rm /tmp/gossipcat-patch.diff
else
  echo "ERROR: Patch file is empty or corrupted"
fi
```

**Key changes from v0:**
- Uses `__GOSSIPCAT_PATCH_EOF__` delimiter (safe from appearing in diff content)
- Writes to temp file before applying (prevents mid-stream corruption)
- Validates file before `git apply`

**Form C — Dirty working tree:**
Same as Form A targeting HEAD SHA (already on remote), then applies working-tree patch
using the same temp-file pattern as Form B. Synthetic hunks for untracked files are
**only generated in Form C** (not Form B) to avoid `git apply` collisions with committed
content.

### Diff generation

For unpushed commits:
```bash
git diff @{u}..HEAD -- . ':!.gossip' ':!node_modules' ':!*.lock' ':!dist'
```

For uncommitted changes:
```bash
git diff HEAD -- . ':!.gossip' ':!node_modules' ':!*.lock' ':!dist'
```

**Note:** Uses `@{u}` (upstream tracking branch) consistently — both in detection
(`git rev-list --count @{u}..HEAD`) and diff generation. The previous `origin/HEAD` ref
is fragile and may not be set on all repos.

**Untracked files (Form C only):** Generated as synthetic `diff -u /dev/null <file>` hunks
for non-ignored, non-binary files enumerated via `git ls-files --others --exclude-standard`.
Binary untracked files are excluded — a note is added to the bridge block listing their
paths without content. Synthetic untracked hunks count toward the 500KB bridge-block cap.

**Diff exclusion:** The pathspec `':!.gossip' ':!node_modules' ':!*.lock' ':!dist'` covers
the common cases. For project-specific exclusions, `.gitignore` already handles most build
artifacts (`.tsbuildinfo`, `.turbo/`, `coverage/`, `build/`). The explicit exclusions are
a safety net for files that might not be gitignored.

### Prompt placement

The bridge block is appended to the assembled prompt **after** the 30K-char truncation
check. This means:

- The main prompt (skills, memory, lens, etc.) is capped at 30K as before
- The bridge block is appended unconditionally after the cap
- If the bridge block itself exceeds 500KB, fall back to skip-bridge (v1 — no partial bridge)

This places the bridge at the **structural end** of the prompt, not second in priority.
The agent sees it last, which is fine — the bridge is operational setup ("clone this repo")
not analytical context. The `assemblePrompt` function accepts a new `projectBridge?: string`
parameter for this.

### Session-scoped clone reuse

Multiple tasks in one session reuse the same clone. This is handled entirely by the
**shell guard** in the bridge commands (`if [ -d "$WORKSPACE/.git" ]`), not by server-side
state tracking. Each task's bridge block includes the full clone-or-fetch logic; the
shell guard determines which path runs.

Each task targets by **SHA (immutable)**, never by branch name as the checkout target.
Fetch-by-SHA is attempted first (reliable on GitHub/GitLab); branch-tip fetch is a fallback.
The final checkout is `git checkout "$SHA"`, preceded by a `git cat-file -e "$SHA"` guard
that hard-fails if the SHA is not in the local object store (branch advanced AND host
rejected fetch-by-SHA).

## Config schema

### AgentConfig additions (types.ts)

```typescript
/** Enable git project bridge for this agent. Auto-detected as true when
 *  provider === 'openclaw'. Set explicitly to force-enable for other remote
 *  providers or force-disable. */
enableGitBridge?: boolean;

/** Override the repository URL (defaults to 'origin' remote, converted to HTTPS). */
gitBridgeRepoUrl?: string;

/** Sparse checkout paths for large monorepos. Triggers --sparse --filter=blob:none. */
sparseCheckoutPaths?: string[];

/** Workspace path on the remote agent's machine.
 *  Default: /root/.openclaw/workspace/<repo-name> */
remoteWorkspacePath?: string;
```

**Required type change:** Add `'openclaw'` to the `AgentConfig.provider` union in
`types.ts` (currently `'anthropic' | 'openai' | 'google' | 'local'`).

### Private repos — credential handling

**Do NOT embed tokens in HTTPS URLs.** Tokens in URLs leak to:
- Shell history (`~/.bash_history`)
- Process list (`/proc/<pid>/cmdline`)
- `.git/config` (persisted after clone)

Instead, use a `GIT_ASKPASS` helper script:

```bash
# Bridge injects this before the clone command:
cat > /tmp/git-askpass.sh << 'ASKPASS_EOF'
#!/bin/sh
echo "<TOKEN>"
ASKPASS_EOF
chmod 700 /tmp/git-askpass.sh

GIT_ASKPASS=/tmp/git-askpass.sh git clone --depth=1 --branch "$BRANCH" https://github.com/owner/repo "$WORKSPACE"

# Immediately clean up
rm /tmp/git-askpass.sh
```

Token is retrieved at dispatch time via `keyProvider('git-bridge-token')` (same keychain
pattern already used in `DispatchPipelineConfig`). The `keyProvider` callback must be
stored as a class field on `DispatchPipeline` (currently only passed to
`ConsensusCoordinator` at line 141 — not available at dispatch call site).

### Large repos

- Default: `--depth=1` (shallow clone, no history)
- With `sparseCheckoutPaths`: `--filter=blob:none --sparse` + `git sparse-checkout set <paths>`
  - Note: `--filter=blob:none` must come before `--sparse` in some git versions
  - Sparse checkout is task-scoped: if task 1 checks out path A and task 2 needs path B,
    the bridge adds path B via `git sparse-checkout add` (not `set`)
- Binary files excluded from diffs (noted in bridge block)

## Edge cases

- **Patch > 500KB**: Skip bridge entirely for v1 (fall back to existing prompt injection).
  Future: file-by-file injection for task-referenced files via `assemblePrompt`
- **Binary files**: Excluded from diff. Untracked binary files listed by path only (no content)
- **git apply failure**: Bridge instructs agent to report the error, not review stale code
- **No git remote**: Skip bridge, fall back to prompt injection
- **No git repo**: Skip bridge entirely
- **No upstream tracking branch** (`@{u}` fails): Treat as "all commits unpushed", diff against
  `origin/main` or `origin/master` (whichever exists)
- **Excludes list completeness**: Hardcoded pathspec (`':!.gossip' ':!node_modules' ':!*.lock' ':!dist'`) 
  combined with `.gitignore` coverage covers standard build artifacts; project-specific exclusions 
  should be added to `.gitignore` rather than the bridge code

## Implementation scope

| File | Change |
|------|--------|
| `packages/orchestrator/src/git-bridge.ts` | NEW — ~150 LOC |
| `packages/orchestrator/src/types.ts` | Add 4 optional fields to AgentConfig + `'openclaw'` to provider union |
| `packages/orchestrator/src/dispatch-pipeline.ts` | Store `keyProvider` as class field, detect `enableGitBridge`, call `buildGitBridgeBlock`, pass result to `assemblePrompt` |
| `packages/orchestrator/src/prompt-assembler.ts` | Accept `projectBridge?: string` param, append after truncation cap |
| `tests/orchestrator/git-bridge.test.ts` | NEW — state detection, patch gen, template rendering, GIT_ASKPASS |

## What this does NOT do

- No git push on behalf of the developer (read-only bridge)
- No persistent remote clone management (ephemeral per session)
- No agent writeback via git (changes come back through task result text)
- No new MCP tools (everything is prompt injection)
- No new external dependencies
- No file-by-file fallback in v1: patch > 500KB skips bridge entirely (no partial bridge). File-by-file injection per task is deferred to v2.

## Prior art

| Framework | Approach | Handles uncommitted? |
|-----------|----------|---------------------|
| Cursor/Windsurf | Local FS via LSP | Yes |
| Copilot Workspace | Cloud container clone | No |
| Devin | Local agent process | Yes |
| SWE-Agent | Git clone per task | No |
| OpenHands | Docker volume mount | Yes |

Gossipcat's bridge is closest to **SWE-Agent's pattern** but with session-scoped reuse
and patch delivery for uncommitted changes — which no framework above handles for remote
agents via prompt injection.

## Consensus review findings (2026-04-13)

Full consensus round with sonnet-reviewer + haiku-researcher. All high/medium findings
addressed in this revision:

| Finding | Agent | Resolution |
|---------|-------|------------|
| SHA fetch unreliable on GitHub + branch-advancement race | both + latent | Fixed: fetch-by-SHA with branch-tip fallback, `git cat-file -e` guard, `set -e` + brace-group `exit 1` on mismatch |
| Token leakage in HTTPS URL | both | Fixed: use `GIT_ASKPASS` script |
| `git checkout .` incomplete reset | sonnet | Fixed: `git reset --hard` + `git clean -fd` |
| `base64 -d` cross-platform + heredoc collision | sonnet | Fixed: temp file + `__GOSSIPCAT_PATCH_EOF__` |
| `origin/HEAD` inconsistent with `@{u}` | both | Fixed: use `@{u}` everywhere |
| `provider` union missing `'openclaw'` | both | Fixed: added to scope table |
| `remoteWorkspace` naming ambiguous | haiku | Fixed: renamed to `enableGitBridge` |
| Priority placement paradox | sonnet | Fixed: clarified as post-truncation append |
| Uncommitted changes exposure | haiku | Fixed: added developer warning requirement |
| `keyProvider` not stored as class field | sonnet | Fixed: added to scope table |
| Sparse checkout + patch interaction | haiku | Fixed: use `sparse-checkout add` not `set` |
| 500KB fallback underspecified | sonnet | Fixed: skip bridge entirely for v1 |
| `git bundle` alternative | both | Noted: worth evaluating, deferred to v2 |
| Bridge version marker | sonnet | Fixed: added `v1` to block header |
| File-by-file fallback unspecified (f9) | consensus | Fixed: no file-by-file in v1, explicitly deferred to v2 |
| Synthetic hunks format underspecified (f10) | consensus | Fixed: confirmed `diff -u /dev/null <file>` format, added size-budget note |
| Excludes list incomplete (f21) | consensus | Fixed: clarified pathspec + `.gitignore` combination rationale in edge case |
| Closed-toolchain bypass (consensus `b3bf13c0-e821417b:f5`, critical) | sonnet | Fixed: sentinel-canary verification step — agent halts if sentinel read fails, converting silent wrong-workspace fallback into explicit error |

## Research sources

- sonnet-reviewer: 7-scenario design + consensus review + audit of race-fix revision (session 2026-04-13/14)
- haiku-researcher: framework comparison + consensus review + f9/f10/f21 revision (session 2026-04-13/14)
- gemini-reviewer: pre-consensus security review (session 2026-04-13)
- Prior memory: project_openclaw_context_injection.md (2026-04-08, live curl validation)
