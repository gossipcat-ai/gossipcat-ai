# Changelog

All notable changes to gossipcat are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) — entries describe user-visible behavior changes and migration impact, not every commit.

## [Unreleased]

## [0.4.16] — 2026-04-21

Catch-up release: consolidates user-visible work shipped across v0.4.10–v0.4.15 (which were tagged without CHANGELOG entries) plus this session's four new PRs. Highlights: consensus citation correctness on duplicates, first-class `boundary_escape` signal type, MEMORY.md index hygiene, and the dashboard/retraction/worktree-citation work that previously sat under `[Unreleased]`.

### Added

- **Write-time `status:` tag injection in MEMORY.md index** (PR #215). Claude Code's auto-memory writer regenerates `MEMORY.md` as a title-only index, so `[OPEN]` / `[SHIPPED]` / `[CLOSED]` state was invisible and orchestrators kept re-dispatching shipped work. The memory writer now prepends each entry's frontmatter `status:` value as a bracketed tag at write time, so the index reflects ship state the instant a file is saved.

- **`boundary_escape` signal type** (PR #212). Sandbox policy violations (Layer 2 PreToolUse hook rejections + Layer 3 audit findings) now record as a first-class `boundary_escape` signal instead of being co-mingled with `hallucination_caught`. Enables per-agent boundary-escape rates in the dashboard and clean separation between "agent said something false" and "agent tried to write outside its sandbox." (`packages/orchestrator/src/performance-writer.ts`, signal schema + dashboard surfaces)

- **Consensus-round retraction** (PR #130). `gossip_signals({action:'retract', consensus_id:'<8-8 hex>', reason:'...'})` retracts every signal whose `finding_id` starts with the given `consensus_id + ':'` — mirrors the forward direction of `bulk_from_consensus`. Use case: a consensus round ran on the wrong branch / with stale file state / with a misconfigured team, and every signal it produced is now untrustworthy; one call cascades removal instead of retracting signals one-by-one. Tombstone pattern — append-only, matches cross-round dedupe (`docs/specs/2026-04-17-cross-round-dedupe-key.md`) and existing per-signal retraction. zod enforces `^[0-9a-f]{8}-[0-9a-f]{8}$` on `consensus_id` (typo guard — 1-char error fails validation, not silent mis-retract) and `min(1).max(1024)` on `reason`. Handler XOR-guards `{consensus_id, reason}` vs `{agent_id, task_id}` — mutually exclusive payloads, matches `bulk_from_consensus` flat-object pattern. Tombstone row uses sentinel `agentId: "_system"` to satisfy `validateSignal`. Reader builds `retractedConsensusIds: Set<string>` and filters per-signal, **scoped to `type === 'consensus'`** so `impl_*` / meta signals are structurally unaffected. Dashboard excludes tombstones at the data-fetch layer (`api-overview.ts` `totalSignals`, `api-signals.ts` per-agent, `routes.ts` surface) plus a new `roundRetractions` channel. `FindingsMetrics.tsx` renders an inline banner with the retraction reason on each retracted round card + struck-through container. `bulk_from_consensus` targeting a retracted round emits a warn log (signals still recorded but filtered at read). Symmetric scoring removal: +/- signals both vanish (if round premise is invalid, no signal within it is trustworthy). Irreversible by design — re-run a new round if retracted in error. 19 new tests. Spec `docs/specs/2026-04-17-consensus-round-retraction.md` (v2, ratified by 2 consensus rounds). (`apps/cli/src/mcp-server-sdk.ts`, `packages/orchestrator/src/{consensus-types,performance-writer,performance-reader}.ts`, `packages/relay/src/dashboard/{api-overview,api-signals,routes}.ts`, `packages/dashboard-v2/src/components/FindingsMetrics.tsx`)

- **User-worktree citation resolution** (#126, PR #129). `gossip_collect` now accepts `resolutionRoots: string[]` — a list of directories to treat as valid citation-resolution roots for the round. Solves the "all-UNVERIFIED on feature-branch review" symptom: when a user has a pre-existing git worktree (`git worktree add .worktrees/feature-x feature-x`) and asks consensus to review code on that branch from master, every citation previously failed with `⚠ file not found` because `getValidRoots()` only recognized worktrees gossip itself created via `write_mode: "worktree"`. `gossip_dispatch` also accepts the field as an optional convenience pass-through (persisted on `PendingConsensusRound`, survives `/mcp` reconnect); collect-time value replaces dispatch-time. Secondary: `consensus.autoDiscoverWorktrees: boolean` in `.gossip/config.json` (default **off**) enables per-round `git worktree list -z --porcelain` auto-discovery through the same validation pipeline. Every path — explicit or discovered — passes through `validateResolutionRoot` (NUL/control reject-round, `..` reject, realpath canonicalization, ownership stat-check, `git rev-parse --git-common-dir` match against projectRoot, `git worktree list` membership). Git invocations hardened with `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_NOSYSTEM=1` + 30s timeout. Paths outside `projectRoot` are always logged as `sha256:first-8-hex` — never verbatim. `findFile` hardened as part of the same PR: bare-filename recursion skipped outside `projectRoot` (was silent cross-project contamination); new `matchesRelativePath(root, candidate, fileRef)` requires trailing-segment match for non-bare citations; recursive walk uses `withFileTypes:true` and skips symlinks, plus realpath-and-reverify each candidate before return. 27 new tests. Spec `docs/specs/2026-04-17-issue-126.md` (v3, ratified by two consensus rounds). (`packages/orchestrator/src/validate-resolution-root.ts` new, `packages/orchestrator/src/discover-git-worktrees.ts` new, consensus-engine + mcp-server-sdk + handlers)

- **Realpath-based containment for `isInsideAnyRoot`** (PR #128). Pre-#126 hardening. Symmetric `realpathSync` on both candidate and root, with a `currentRealpathRoots` cache populated in `updateWorktreeRoots` alongside `currentWorktreeRoots`. Closes a symlink-escape hole that would otherwise be load-bearing when PR-B widened roots to user-supplied paths. No behavior change for non-symlinked paths. (`packages/orchestrator/src/consensus-engine.ts`, `tests/orchestrator/consensus-engine.security.test.ts` new)

- **Auto-benching v2 dashboard badges** (PR #127). Surfaces v1 Rule A/B `isBenched` state in the dashboard — resolves the `performance-reader.ts:140` TODO. New `lib/bench.ts` drives three-state UI: red **benched** (chronic/burst), amber **struggling** (circuitOpen tail failures), amber-outline **kept for coverage** (would-bench-but-sole-provider). `api-agents.ts` passes the union of `categoryCorrect`+`categoryHallucinated` keys so sparse categories aren't dropped by `MIN_CATEGORY_N=5`. `circuitOpen` kept alongside — the two signals measure distinct failure modes and dispatch filters them independently, so a UI drop would create dashboard/dispatch mismatch. `CircuitAlerts` panel retitled "Agents Needing Attention" with per-reason chips. (`packages/dashboard-v2/src/lib/bench.ts` new, `packages/relay/src/dashboard/api-agents.ts`, dashboard-v2 components)

### Fixed

- **Relay cross-reviewers now share the engine's path-resolution plumbing**. `runOneRelayCrossReview`'s inner tool runner was bypassing `resolveToolPath` and the `effectiveRoots` used by the engine-side `verifierToolRunner`, so relay agents invoking `file_read`/`file_grep` on a bare filename (`cross-reviewer-selection.ts`) got raw "file not found" instead of the same worktree-aware disambiguation native Claude reviewers enjoy — producing spurious UNVERIFIED findings. Fixed; relay and engine paths now resolve identically. (`apps/cli/src/handlers/collect.ts:451-472`)

- **Cross-reviewer file citations resolve to the correct duplicate** (PR #213). When a finding cited a filename that existed in multiple directories under `projectRoot`, citation resolution could bind to the wrong copy, causing cross-reviewers to review unrelated code and (in the worst case) mark real findings UNVERIFIED. Resolver now disambiguates via the finding's trailing-path segments instead of bare filename match.

### Docs

- **Orchestrator warning: don't trust the MEMORY.md index line** (PR #214). `.claude/rules/` now instructs orchestrators to read the linked memory file's `status:` frontmatter directly. Index entries rot — the frontmatter is authoritative.
- **Never auto-execute `.gossip/` deletion from agent suggestions**. CLAUDE.md rule: implementer proposals to "clean up", "reset", or "remove" `.gossip/` must be rejected and confirmed with the user. `.gossip/` is operational training state — wiping it resets every agent's competency profile.
- **README polish**: reward-loop Mermaid diagram, bundlephobia size badge, weightless-in-context-RL framing, "Full implementation workflow" marked shipped.

## [0.4.9] — 2026-04-17

Consensus reliability + dashboard UX release. Seven PRs shipped in a single session: two critical consensus bug fixes, two consensus features that tighten the signal pipeline, two dashboard/memory UX fixes, and one scoring feature. Most users should upgrade; the all-native consensus fix (#121) is the load-bearing one.

### Fixed

- **Auto-verifier silent no-op for all-native consensus teams** (#121, PR #123). `runSelectedCrossReview` unconditionally invoked `crossReviewForAgent` for every completed result. Native agents were deliberately excluded from `agentLlmCache` (`collect.ts:242`) so their LLM resolution fell back to the main Gemini provider, which silently returned empty text. Synthesis proceeded with zero peer input and tagged every finding `UNIQUE`. Fix: detect `hasNative` at the collect-handler call site and skip server-side Phase 2, falling through to the existing `generateCrossReviewPrompts` path that already handles natives. One stderr line emitted for observability. Regression test asserts native path yields ≥2 prompts AND the mainLlm is never invoked. (`apps/cli/src/handlers/collect.ts:326-352`, `tests/orchestrator/consensus-two-phase.test.ts:110-153`)

- **Dashboard agent list empty after `gossip_setup` on degraded-mode boot** (#96, PR #124). Silent `try {} catch {}` at the tail of `doSyncWorkers` wrapping `ctx.relay.setAgentConfigs(...)` swallowed dashboard wiring failures. If sync failed the user had no signal. Fix: `doSyncWorkers` now records `{ok, mergedAgentCount, error}` into `ctx.lastSyncResult`; `gossip_setup` surfaces it via a new `buildDashboardAdvisory()` helper — success message, failure message with `/mcp` reconnect hint, or the degraded-boot note. Also: dashboard poll interval 10s → 5s; `ctx.bootedInDegradedMode` flag set at the no-config branch; `config.ts` error message now names both `.gossip/config.json` (primary) and `gossip.agents.json` (legacy). (`apps/cli/src/mcp-server-sdk.ts:377,997-1013,1961-1977,2013-2021`, `apps/cli/src/setup-response.ts` new, `packages/dashboard-v2/src/hooks/useDashboardData.ts:11`, `apps/cli/src/config.ts:53`)

### Added

- **Agent auto-benching v1 — chronic + burst thresholds** (#93, PR #125). Existing `CIRCUIT_BREAKER_THRESHOLD=3` only trips on consecutive failures. Agents with interleaved failures across hundreds of signals (gemini-reviewer at 0.30/650, 39 hallucinations) never tripped it. New `isBenched(agentId, categories?, allAgentIds?)` exports from `performance-reader.ts` with Rule A (chronic: `accuracy < 0.30 && totalSignals >= 200`) and Rule B (burst: `weightedHallucinations >= 5 && rate > 0.4`). Skill-coverage safeguard returns `{benched:false, safeguardBlocked:true, reason}` when the candidate is the sole unbenched agent for any required category — preserves team capability while flagging the state for dashboard surfacing. Soft bench only (excludes from `auto` dispatch + `selectCrossReviewers`; explicit `gossip_run(agent_id: ...)` still works). Implicit 5pp hysteresis via strict `<0.30` entry vs effective ≥0.35 exit. `AgentScore.weightedHallucinations` now exported. (`packages/orchestrator/src/performance-reader.ts:24,125-188,608,625`, `packages/orchestrator/src/cross-reviewer-selection.ts:86-96`, `tests/orchestrator/is-benched.test.ts` new — 12 cases)

- **Cross-round finding dedupe via content-anchored key** (PR #122). `finding_id` is round-scoped (`<consensusId>:<agentId>:fN`) so the same semantic bug rediscovered in a new consensus round got a new finding_id and double-counted in the signal pipeline. Three key-formula candidates evaluated in parallel (dispatches `2ccd021c`, `ea9ee175`, `9065d90f`): strict line+category rejected (line-ranges truncate in ANCHOR_PATTERN, category was not persisted), 10-line bucket rejected (real historical collision in `cross-reviewer-selection.ts` between starvation bug and `Math.min` crash), belt-and-suspenders caveated on boilerplate risk. Converged on content-anchored: `sha256(agentId + normalizedFilePath + first-32-normalized-content + category)`. Null-returns when no citation or content < 32 chars (dedup disabled, safer than false-collide). Prerequisite fix: `category` now persisted into `implementation-findings.jsonl` rows. (`packages/orchestrator/src/dedupe-key.ts` new, `apps/cli/src/mcp-server-sdk.ts:2430-2505`, `apps/cli/src/handlers/collect.ts:605-618`)

- **Unified memory view — merge at view layer, preserve writer separation** (#118, PR #119). The dashboard previously rendered gossip + native memory as two structurally distinct sections. On a 2-day-old project: 2 gossip files vs 180 native files, 3 of 4 gossip folders empty. Fix: merge into one `<MemoryFolders>` view at the view layer only; writer separation stays intact. Dedupe key becomes `${origin}/${filename}` so cross-store collisions remain visible (legacy filename-only fallback preserved for pre-merge callers). Writer pipelines, API endpoints, and taxonomy mapper untouched. (`packages/dashboard-v2/src/App.tsx:458-464`, `packages/dashboard-v2/src/lib/memory-dedupe.ts` new, `packages/dashboard-v2/src/hooks/useDashboardData.ts:74-88`)

- **Memory hygiene convention propagation** (PR #120). Fresh gossipcat users never got the `status: open|shipped|closed` frontmatter convention because it lived only in this repo's CLAUDE.md. Dual delivery: (a) `## Memory Hygiene Convention` section injected into `gossip_status()` bootstrap output every session (load-bearing; no file dependency, zero drift); (b) `seedMemoryHygiene()` helper idempotently appends the canonical block to project CLAUDE.md on `gossip_setup` if heading absent (belt-and-suspenders; never creates new CLAUDE.md). Haiku research (dispatch `bdc99a16`) empirically confirmed CC's auto-memory writer honors per-repo CLAUDE.md conventions — 100% `status:` adoption on post-convention files, 0% before. (`packages/orchestrator/src/bootstrap.ts:216-227,243`, `packages/orchestrator/src/memory-hygiene-seed.ts` new, `apps/cli/src/mcp-server-sdk.ts:1925-1937`)

### Test coverage

1806 → 1859 tests (+53 new across the seven PRs). `tsc -b packages/orchestrator apps/cli` clean.

## [0.4.8] — 2026-04-16

Tool Server cwd divergence fix + sandbox hardening follow-ups. Shipped via #109 and #110.

### Fixed

- **Tool Server cwd divergence on worktree `file_*` tools** (#110). `Sandbox.validatePath` unconditionally resolved relative paths against `projectRoot`, while `shell_exec` / `git_commit` correctly used `agentRoot`. Net effect: a worktree agent calling `file_write('output.txt')` wrote to `projectRoot/output.txt`; subsequent `git_commit` inside the worktree saw no staged changes and failed silently. Fix: resolve relative paths against `allowedRoots[0]` when provided (worktree), fallback to `projectRoot` otherwise. Union-of-roots for absolute paths preserved by the downstream containment check. Test matrix extended: rewrote the test that codified the bug as spec; added 5 cases covering worktree relative/absolute writes, sequential and scoped fallbacks, and projectRoot-via-absolute read. (`packages/tools/src/sandbox.ts`, `tests/tools/tool-server-scope.test.ts`)

- **L3 audit scoped-mode false-positive** (#109). In scoped dispatches, `buildAuditExclusions` only excluded `ownWorktree`; it had no equivalent for `scope`, so every in-scope write by a scoped agent was flagged as a boundary escape. Fix: thread `scope` through `Layer3AuditOptions` → `runLayer3Audit` → `buildAuditExclusions`, and exclude `${projectRoot}/${scope}` when present. (`apps/cli/src/sandbox.ts`)

- **`node-compile-cache` dominates tmpdir scan noise** (#109). Node 22+ emits many compile-cache files per dispatch to `$TMPDIR/node-compile-cache/*`. These were 6 of 8 remaining worktree-mode violations in live fire. Added `node-compile-cache` to the tmpdir pattern list alongside `com.apple.*`, `itunescloudd`, `TemporaryItems`. Scoped mode already narrows to `projectRoot` (v0.4.7) so unaffected. (`apps/cli/src/sandbox.ts`)

- **`spawn git ENOENT` retry + explicit env** (#109). Worker dispatches hit intermittent `posix_spawn` failures on `execFile('git', ...)` calls in `git-tools.ts` and `worktree-manager.ts` — likely libuv transient failure under subprocess-spawn load (nodejs/node#48440 family). Consistent with the pattern mismatch vs `shell-tools.ts` which passes `env` explicitly and never fails. Fix: new `execGit` helper in both files passes `env: { ...process.env }` explicitly and retries once after 100ms on `ENOENT`. Defensive hardening — does not address the deeper cause but mitigates the observed symptoms. (`packages/tools/src/git-tools.ts`, `packages/orchestrator/src/worktree-manager.ts`)

### Live-fire validation (2026-04-16)

Task 7919c908 (pre-fix): worktree dispatch → `file_write('CHANGELOG.md')` landed in `projectRoot`, `git_commit` in worktree saw nothing, task failed silently in 179s.

Task ad66d36e (post-fix): same dispatch → file landed in worktree, `git_diff` saw the change, `git_commit` produced hash `3e2f7e2`, task succeeded in 106s. Main tree `CHANGELOG.md` untouched — no silent drift.

## [0.4.7] — 2026-04-16

Layer 3 audit overhaul — scoped-mode noise drops 99.9%, worktree-mode 82%. Shipped via #107 which stacks two commits:

### Fixed

- **`find -prune` instead of `-not -path`** for L3 exclusions. `-not -path` only filters `find`'s output; the scan still descends into every excluded directory. On macOS that means `find` enters `~/Library/Application Support/{Safari,Photos,Group Containers}/` and hits TCC "Operation not permitted" every dispatch, producing a noisy `find partial failure` log entry even though `err.stdout` parsing (v0.4.4) recovers real violations. `-prune` skips the subtree entirely — no descent, no permission errors, clean stderr. (`apps/cli/src/sandbox.ts`)

- **Mode-aware scan roots + expanded exclusions.** Design consensus from two parallel investigations (haiku-researcher + sonnet-reviewer, 2026-04-16) produced two load-bearing findings:
  - **Scoped mode scanning `$HOME` has zero true-positive capacity.** Tool Server's `shell_exec` for scoped agents is hard-restricted to read-only git. A scoped agent cannot write outside scope via any Tool Server primitive, so every violation reported from a `$HOME` scan was noise by design. `defaultScanRoots('scoped', projectRoot)` now returns `[projectRoot]` only. Worktree mode keeps the broad scan (relay `shell_exec` can still escape).
  - **Orchestrator git activity runs inside `collect()` BEFORE `runLayer3Audit`.** `worktreeManager.merge()` + `cleanup()` at `dispatch-pipeline.ts:697-699` write to `.git/refs`, `.git/logs`, `.git/index`, `.git/objects/*` — all were being flagged as "agent violations." Added `${projectRoot}/.git` to exclusions.

  Also broadens `$HOME/.claude/projects` → whole `$HOME/.claude` (harness adds new subtrees per release: `tasks`, `history.jsonl`, `file-history`, `backups`, `shell-snapshots`, `todos`) and adds tmpdir OS-app prefixes `com.apple.*`, `itunescloudd`, `TemporaryItems` so macOS apps squatting in `/var/folders/<a>/<b>/T/` don't inflate violations.

### Live-fire results (2026-04-16)

| Mode | Before v0.4.7 | After v0.4.7 | Reduction |
|------|---------------|--------------|-----------|
| Worktree dispatch (gemini-implementer) | 44 violations | 8 | **82%** |
| Scoped dispatch (gemini-implementer) | 1064 violations | 1 | **99.9%** |

The remaining 8 worktree entries are all legitimate "outside worktree" writes (orchestrator activity + sibling-repo noise + Node compile cache). The remaining 1 scoped entry is the agent's own in-scope write (`docs/<file>`) — L3 in scoped mode doesn't currently consult the scope boundary; follow-up item.

## [0.4.6] — 2026-04-16

### Fixed

- **Layer 3 audit now excludes user-level app directories** (#105). Live-fire verification against v0.4.5 produced 44 "boundary escape" violations that were 100% OS-level churn — Chrome cookies, Spotify cache, NordVPN data, Claude Code's own `~/.claude/projects/*.jsonl` session logs — not a single agent action. These app directories are unreachable through the Tool Server sandbox or the Layer 2 PreToolUse hook, so false positives from them were pure noise drowning out any real signal. `buildAuditExclusions` now adds `$HOME/Library`, `$HOME/.cache`, `$HOME/.npm`, `$HOME/.claude/projects` to the `find -not -path` list. Broad `$HOME` scan is preserved for defense-in-depth against `shell_exec` bypass; real agent violations anywhere else in `$HOME` are still caught. (`apps/cli/src/sandbox.ts`)

## [0.4.5] — 2026-04-16

Tool Server union-of-roots — worktree-mode relay agents can now actually write inside their own worktrees.

### Fixed

- **Tool Server was worktree-blind on 6 file_* tools** (#103). `ToolServer.enforceWriteScope` correctly gated against the agent's assigned worktree root, but then `FileTools.fileWrite` called `Sandbox.validatePath` which re-resolved against `projectRoot` only. Worktrees live under `os.tmpdir()/gossip-wt-*` — always outside `projectRoot` — so every absolute worktree path was rejected with the misleading `"resolves outside project root"` error, and every relative path silently landed at repo root (diverging from `shell_exec`'s `agentRoot` cwd). Fix threads `agentRoot` through `FileTools` + `Sandbox.validatePath` accepts an optional `allowedRoots` array so a path is valid if it's inside `projectRoot` OR the caller's worktree root. Scope: `file_read`, `file_write`, `file_delete`, `file_search`, `file_grep`, `file_tree`. (`packages/tools/src/{sandbox,file-tools,tool-server}.ts`)

### Preserved security properties

- Normalize before check (`path.resolve` on candidate + every allowed root)
- `realpathSync` symlink resolution before membership check — in-worktree symlinks pointing outside are still rejected
- Trailing-slash canonical form — blocks sibling-prefix bypass (e.g. `/tmp/gossip-wt-AB` vs `/tmp/gossip-wt-ABXYZ`)
- Case-fold on darwin/win32 — matches existing Sandbox behavior, no new logic
- Per-agent keyed `agentRoots` Map — no path-derived root lookup
- Existing `Sandbox.validatePath` callers that don't pass `allowedRoots` are unchanged

### Out of scope (intentional, captured for follow-up)

- `shell_exec` and `git_*` already use `agentRoot` as cwd — unchanged.
- `run_tests`, `run_typecheck`, `verify_write` still use `projectRoot`-only scope — extending to worktrees is a separate concern.
- Relative-path resolution base still resolves against `projectRoot` — known Tool-vs-shell_exec cwd divergence tracked separately.
- `scope.ts::canonicalizeForBoundary` only walks up one directory to find an existing ancestor (unlike `sandbox.ts::validatePath` which walks N levels) — deep non-existent subtrees under a worktree fail silently in the enforceWriteScope guard. Discovered while writing tests. Separate follow-up.

Design consensus: parallel investigation by `haiku-researcher` (task `21e974c8`) and `sonnet-reviewer` (task `9e737678`), 2026-04-16.

Tests: `tests/tools/` 83 → 89 (+6 union-of-roots cases covering inside/outside roots, sibling-prefix bypass, symlink escape, no-root fallback, relative-path sanity).

## [0.4.4] — 2026-04-16

Point release closing two Layer 3 sandbox bugs surfaced by live-fire verification against the freshly-released v0.4.3 (consensus task `56641e6e`, 2026-04-16).

### Fixed

- **Layer 3 `worktreePath` patch was a no-op** (#101). The F2 fix in #99 called `ctx.mainAgent.getTask(taskId)` after `collect()`, but `DispatchPipeline.collect()` deletes the task entry from its `this.tasks` Map before returning (default `consume: true`). Every relay worktree dispatch since #99 recorded `worktreePath: undefined`, so the Layer 3 audit never excluded the agent's own worktree from its scan. Fix reads `worktreeInfo.path` directly off the result entry (`collectResult.results[0]`), which already carries it from `dispatch-pipeline.ts`'s `results.map` builder. (`apps/cli/src/mcp-server-sdk.ts`)

- **macOS TCC silently hid Layer 3 violations** (#101). `execFileSync` in `auditFilesystemSinceSentinel` threw on any non-zero exit from `find`, and macOS TCC returns "Operation not permitted" whenever `find` crosses into sandboxed Library paths (Safari Group Containers, Photos, etc.). `find` then exits non-zero even when it had successfully captured real violations on stdout — the entire scan root's output was discarded. Fix parses `err.stdout` on throw before logging, so permission errors still log to stderr but real violations survive. Catch binding narrowed from `(err as Error)` to structural type `{ stdout?: Buffer | string; message?: string }` to reach Node's `ExecFileException` fields without `as any`. (`apps/cli/src/sandbox.ts`)

Tests: Layer 3 suite 29 → 31 (synthetic `findBinary` shim that emits stdout then exits non-zero, plus a negative case proving empty-stdout failures do not fabricate violations).

## [0.4.3] — 2026-04-16

Headline: **worktree filesystem sandbox** — the multi-layer defense for issue #90 ships end-to-end. Agents dispatched with `write_mode: "worktree"` are now soft-blocked from writing outside their isolated worktree by a PreToolUse hook (Layer 2), with a post-dispatch `find -newer` audit as a backstop (Layer 3) for escape paths the hook can't see. Plus a round of scoring corrections, dashboard polish, and relay resilience fixes driven by recent consensus rounds.

### Worktree FS sandbox — layered defense (#90)

Prior to this release, `write_mode: "worktree"` was advisory only — the Claude Code harness accepts absolute paths anywhere on disk and gossipcat had no enforcement point. Three layers of defense now ship together:

- **Layer 2 — PreToolUse hook (#94).** A bash hook installed into `.claude/settings.json` intercepts `Edit`/`Write`/`MultiEdit` calls before they reach the filesystem and denies absolute paths that fall outside the agent's worktree cwd. Recognizes both namespaces: `/tmp/gossip-wt-*` (relay-managed) and `.claude/worktrees/agent-*` (Claude Code native). `gossip_setup` wires the hook automatically on merge; existing installs pick it up on next setup refresh. 3 consensus rounds found and fixed 8 bypasses (tilde expansion, env vars, glob, `cd`, `pushd`, `$()`, backtick, process substitution) + 2 contract violations.
- **Layer 3 — post-dispatch `find -newer` audit (#99).** POSIX `find` runs after every `scoped`/`worktree` dispatch and flags any file whose mtime is newer than the task's sentinel and whose path falls outside the task's worktree. Catches shell-expanded, tilde-expanded, env-var-derived, and backtick-substituted paths that the hook can't see at parse time. Fail-open on `find` errors so a broken audit never blocks a task result. Windows: audit is POSIX-only and no-ops with a skip log.
- **Merge runs git hooks (#92).** Removing `-c core.hooksPath=/dev/null` from `worktreeManager.merge` was the prerequisite for pre-commit validators (linter, typecheck) to actually run when a worktree lands.

### Scoring corrections

- **Hallucination decay tune + category enforcement (#98).** Per-task decay half-life reduced so a handful of fabricated findings from months ago no longer dominate the current accuracy score. Category-level accuracy is now enforced as a hard gate for cross-reviewer selection rather than a soft preference.
- **Task-timeout and task-empty signals (#81).** Relay dispatches that time out or return empty content now emit explicit negative meta-signals instead of silently vanishing. Implementation agents also reset their streak counter on these events so a run of timeouts can't masquerade as a clean streak.
- **`unique_unconfirmed` dropped from circuit-breaker (#71).** Uncontested findings that were never cross-reviewed no longer count as negative signals against the originating agent — they're reviewer-pool artifacts, not hallucinations. Circuit-breaker decisions use `hallucination_caught` + `disagreement` only.
- **`diversityMul` applied symmetrically (#70).** The peer-diversity multiplier was scaling the agreement numerator but not the denominator, capping small-pool accuracy at the diversity ratio even for correct findings. Now applied at all 3 sites.
- **Cross-reviewer median excludes fresh agents (#80).** `medianScore` was computed over `scoredCandidates` (including fresh agents seeded to 0), so when ≥50% of the pool was fresh the median collapsed and the `belowMedian` filter became impossible to satisfy — silently disabling epsilon-greedy exploration exactly when uncertainty was highest. Now computed over `eligible` (score > 0) with a clean short-circuit for all-fresh pools.

### Dashboard

- **Live-refresh with Bearer auth (#97).** The dashboard now polls its API with the correct `Authorization: Bearer <key>` header instead of the older query-string key, and refreshes pages without a hard reload. Degraded-mode log no longer misreports "OK" when a subsystem is down.
- **Avg-duration clamp tightened to 4h (#95).** Older reports with `duration_ms` in the 30-day range were inflating the average on team cards; clamp lowered to 4h so one runaway long-dispatch can't skew the dashboard.
- **Memory taxonomy 4-folder display remap (#74).** Five-type auto-memory schema (user/feedback/project/reference/session) now renders as four semantic buckets (active/reference/notes/history) on the dashboard with a status nudge for legacy files missing `status`.
- **UNVERIFIED peers surfaced on CONFIRMED findings (#76).** Finding cards now show `+N peers verified, +M unverified` instead of only listing the AGREE confirmers — masking peer-pool saturation was hiding real signal from the reviewer team.

### Relay resilience

- **Server-side `dispatched_at_ms` fallback + 30d clamp (#88).** Missing dispatch timestamps from older relay paths were causing task cards to show "dispatched 1970" or NaN durations. Server now fills in `dispatched_at_ms` at arrival time and clamps to 30d for display sanity.
- **WebSocket heartbeat + PID diagnostic (#75).** Added a lightweight ping/pong on the relay socket plus a PID field in the diagnostic endpoint so orphaned worker processes are identifiable during a disconnect cycle.
- **`syncWorkersViaKeychain` self-heal on first sync (#77).** `lastKeyByAgent` snapshot was empty on the first sync, so subsequent "key changed?" checks were comparing against undefined and producing false positives.

### Skills + memory

- **Upstream freshness filter (#86).** `skill-develop` now filters the gap-tracker against skill-file mtime so a fresh gap doesn't immediately trigger a re-develop on a just-generated skill. Audit log expanded to include the verdict at develop time, not just the trigger.
- **Verdict-aware cooldown gate (#84).** `gossip_skills develop` is now throttled per-verdict: `pending` no gate, `silent_skill`/`insufficient_evidence` 30d, `inconclusive` 60d (preserves strike rotation), `passed`/`failed` hard-block. Force override is logged to `.gossip/forced-skill-develops.jsonl`.
- **Skill-loader observability + category boost (#78).** Skill injection events are logged per-task with category + verdict so the dashboard can show which skills were active. Category-boost applied when a skill matches the extracted finding category.
- **Separate native + gossip memory stores (#83).** Gossipcat's memory writes no longer collide with Claude Code's native auto-memory. Ordered writes ensure read consistency within a session.

### Security

- **Dependabot: 7 vulnerabilities resolved (#82).** `npm audit fix` run against the full workspace tree. No breaking changes.

### Docs

- **Sandbox SCOPE_NOTE hardening + throttle doc (#85).** The advisory scope note now includes a concrete "what gossipcat does / does not enforce" list. Skill-develop throttle semantics documented in HANDBOOK.
- **Socket badge in README (#79).** Cosmetic.

## [0.4.2] — 2026-04-14

README-only republish. 0.4.1's install instructions (both on the npm package page and in the GitHub README) shipped before the README normalization PRs #67/#68 merged, so users landing on npmjs.com saw the old `https://github.com/.../releases/latest/download/gossipcat.tgz` one-liner instead of the shorter `npm install -g gossipcat` form. No code changes — the tarball is byte-identical to 0.4.1 except for `README.md` + the `package.json` version bump.

If you installed 0.4.1, upgrading to 0.4.2 is a no-op for behavior. This exists purely so the npm package page matches the GitHub README.

## [0.4.1] — 2026-04-14

A round of hardening driven by two consensus rounds (`0a7c34cb-91624bd4`, `20c17ac3-03bb4f25`) that reviewed 0.4.0's own PRs and caught real security + correctness regressions that the original review missed. Three stacked PRs close every HIGH/MEDIUM/LOW finding plus two silent-failure modes in already-merged 0.4.0 code.

### Security (merge-blockers caught in cross-review)

- **`gossip_plan` native utility now issues a `relay_token`.** The initial 0.4.0 implementation of the native-utility re-entry path (PR #64) created a `nativeTaskMap` entry without a token, so any caller who guessed or observed the 8-hex `taskId` in the 120s window could POST a fabricated decomposition via `gossip_relay`, feeding `decomposeFromRaw` + `registerPlan` an attacker-chosen plan. Now matches the `gossip_verify_memory` hardening pattern: token issued at dispatch, echoed in the EXECUTE NOW instructions, enforced by `handleNativeRelay`. (#64)
- **Re-entry path validates stash before mutating maps.** `gossip_plan` used to delete `_pendingPlanData`, `nativeResultMap`, and `nativeTaskMap` entries for `_utility_task_id` *before* the `if (!stashed)` guard. A caller passing any live task's ID could purge its native state (cross-tool DoS). Order flipped: validate first, delete after. (#64)

### Cache-drift fixes on `syncWorkersViaKeychain` (#63)

Shared invariants cached at boot but never refreshed when agents are added/removed surfaced as stale state minutes or hours into a session.

- `identityRegistry` lifted onto `ctx.identityRegistry`; `.clear()` runs before every repopulation so removed/renamed agents no longer keep stale `self_identity` entries.
- `main_agent` provider/model change warning now compares against the **original** boot-time config values (new `ctx.mainProviderConfig`/`ctx.mainModelConfig`), not the post-fallback runtime — users whose primary key was missing at boot no longer get a spurious warning on every dispatch. Self-heals after warning fires.
- `SkillIndex.seedFromConfigs()` + `ensureBoundWithMode(['memory-retrieval'], …, 'permanent')` called on every sync so new agents get the baseline skill.
- `DispatchPipeline.invalidateProjectStructureCache()` added (delegated via `MainAgent`) and called on every sync so prompts regenerate against the current layout.
- Native `task_completed` meta-signal now emitted alongside `format_compliance` (parity with the relay path). `task_tool_turns` intentionally **not** emitted for native agents — tool-use is unobservable to the relay and emitting `value: 0` poisoned skill-gap detection. Stderr logging added on meta-signal write failure (previously silent catch).

### Consensus engine + prompt assembler hardening (#64, #65)

- **Phase-2 cross-reviewers now keep their skills.** `ConsensusEngine` takes a `getAgentSkillsContent(agentId, task)` callback and appends the agent's skills block to the cross-review system prompt. Without this, reviewers trained on `citation_grounding` / `security-audit` lost that methodology the moment the prompt flipped to cross-review. Wired via `ConsensusCoordinator` → `DispatchPipeline` using the existing `loadSkills()` + `skillIndex`. (#64)
- **`gossip_plan` works on pure-native teams.** Added the `_utility_task_id` re-entry branch matching `gossip_skills`/`gossip_session_save`. Decomposition dispatches to a native subagent; re-entry resumes via `TaskDispatcher.decomposeFromRaw()`. `classifyWriteModes` degrades to all-read (no second LLM hop available) — users can still dispatch; per-task defaults apply at `gossip_dispatch` time. (#64)
- **`TaskDispatcher` split:** `buildDecomposeMessages` + `decomposeFromRaw` + `classifyWriteModesFallback`. `decomposeFromRaw` now validates the `strategy` enum (unknown → `single`) and subtask shape (non-string descriptions dropped, `requiredSkills` filtered to strings) so untrusted native-utility output can't smuggle malformed plans into `registerPlan`. (#64)
- **`assembleUtilityPrompt()` helper** formats the `EXECUTE NOW` + `AGENT_PROMPT:<taskId>` pair used by every native-utility call site, with optional `relayToken` in the relay step. `gossip_plan` adopts it first; other sites can migrate incrementally. `MAX_ASSEMBLED_PROMPT_CHARS` exported from `@gossip/orchestrator` so utility builders share one 30K budget. (#64)
- **Suffix cap on `assemblePrompt`.** Earlier versions only truncated the prefix, so oversized `MEMORY` / `SPEC REVIEW` / session blocks silently exceeded the 30K cap. Suffix segments now carry priority 0-6 (0 = mandatory: TASK + schema). When total suffix exceeds a 60% reserve (18K), lowest-priority segments drop first until it fits. Schema + task always survive. (#65)
- **`provisionalConsensusId` validation.** `allFindings[0].id.split(':')[0]` silently accepted any string, so free-form finding IDs from legacy or custom producers routed provisional signals under the wrong consensusId. Exported `CONSENSUS_ID_RE` / `isValidConsensusId` / `extractConsensusIdFromFindingId` helpers; prefer the authoritative consensusId on `consensusReport.signals[0]`, fall back to parsed-and-validated first-finding ID only when no signals are available. (#65)

### Cleanup

- Removed dead `setAgentSkillsResolver` late-binder from `ConsensusCoordinator`. (#64)
- `gossip_plan` reentrant-call instruction now uses `JSON.stringify(task)` so backslashes, newlines, and quotes escape correctly. (#64)

### Tests

+32 tests net across the three PRs:

- `assembleUtilityPrompt` shape + relay_token include/omit + reentrant verbatim (6 tests).
- `decomposeFromRaw` fallback behavior: non-JSON input, unknown strategy, valid strategy, subtask shape filtering, all-invalid collapse, `requiredSkills` filter (6 tests).
- `getAgentSkillsContent` callback: injection when callback returns content, safe containment on throw (2 tests).
- `invalidateProjectStructureCache` public method sanity (2 tests).
- Native `format_compliance` signal emission + `task_tool_turns` suppression for native agents (1 test).
- `CONSENSUS_ID_RE` / `isValidConsensusId` / `extractConsensusIdFromFindingId` validator suite (11 tests).
- Priority-ordered suffix drop: TASK+SCHEMA always survive, lowest-priority first, AGENT_MEMORY before MEMORY, multi-drop ordering, no-op when everything fits (5 tests).

Test suite: 1495 passing (was 1463 at 0.4.0 release), 1 skipped, 121 suites green.

## [0.4.0] — 2026-04-14

Combines the unreleased 0.3.0 work (server-side cross-review, memory pre-fetch, scoring, dashboard polish) with three new streams: HTTP file bridge infrastructure, the consensus type-contract fix, and a long-standing test bug cleanup.

> **Note:** v0.3.0 was published to npm on 2026-04-13 but never cut a matching GitHub release. Its changes are included here under 0.4.0 rather than retroactively tagged — the CHANGELOG entries below merge both cycles for a single coherent release. If you installed 0.3.0 from npm, upgrading to 0.4.0 is additive; behavior changes are called out explicitly in the "Behavior changes" subsection.

### Behavior changes (read before upgrading)

- **`formatCompliant` now requires `tags_accepted > 0`.** Previously an agent that emitted `<agent_finding>` tags with non-canonical `type` values (e.g. `approval`, `concern`, `risk`) was counted as format-compliant because the raw tag count was non-zero. The parser silently dropped those tags, but the meta-signal stayed positive. The new behavior is stricter: compliance requires that at least one tag survived the type-enum filter. Agents producing only invented types will now correctly fail the compliance check. Downstream consumers (signals pipeline, per-agent accuracy, dashboard) will see a short-term shift in the `format_compliance` signal distribution — this is a correction, not a regression. See PR #56.

### HTTP file bridge — foundation (#54, #55)

Two stacked PRs land the groundwork for live tool proxying to closed-toolchain remote agents (openclaw and future HTTP-only providers). **The bridge is dead code in this release — it ships behind the `enableHttpBridge` AgentConfig flag (default off) and is not wired into dispatch yet.** A follow-up PR will land the dispatch-pipeline integration (token issuance, cleanup paths, prompt block, sentinel detector) in a future release. What's in 0.4.0:

- `packages/tools/src/scope.ts` — extracted `canonicalizeForBoundary` + `validatePathInScope` from `tool-server.ts` as a shared security primitive. Both branches of the original function (including the security-critical non-existent-path branch for `/file-write`) preserved verbatim. Exported from `@gossip/tools` barrel.
- `packages/orchestrator/src/rate-limiter.ts` — generic sliding-window `RateLimiter` supporting both count mode (weight=1) and weighted-sum mode (variable weights for in-flight byte quotas). Purges expired entries on every access. Rejects single events whose weight exceeds `maxWeight` (strict interpretation for bytes quota).
- `packages/relay/src/message-rate-limiter.ts` — rewritten as a thin adapter over the generic limiter. Public API (`isAllowed`, `clear`, `RateLimiterConfig`) unchanged.
- `packages/orchestrator/src/http-bridge-server.ts` + `http-bridge-handlers.ts` — factory `createHttpBridgeServer()` returning the `HttpBridgeServer` interface (`listen`/`issueToken`/`revoke`/`close`). Seven endpoints (`/file-read`, `/file-write`, `/file-list`, `/file-grep`, `/run-tests`, `/sentinel`, `/bridge-info`), per-task bearer tokens, 127.0.0.1 binding by default, pre-body Content-Length check on writes (not `express.json`), ETag with pipe-delimited hash, per-token RPS + in-flight-bytes quotas, `BridgeConfigError` thrown when `bridgeRemoteAccess: true` without TLS cert. 32 new tests.
- 4 new optional `AgentConfig` fields (`enableHttpBridge`, `bridgeWriteMode`, `bridgeScope`, `bridgeRemoteAccess`) — all default off.

Spec at `docs/specs/2026-04-14-http-file-bridge.md`, updated from a 3-agent pre-implementation review (#53) that caught 5 HIGH spec inaccuracies before code was written.

### Consensus type contract — strict parser, loud drops (#56)

Fixes a silent-drop bug where agents emitted `<agent_finding type="approval|concern|risk|recommendation|confirmed">` tags and the parser silently discarded them, leaving the dashboard showing "0 findings" despite 14+ tagged observations.

- New `packages/orchestrator/src/finding-tag-schema.ts` — single source of truth for the tag contract. Exports `FINDING_TAG_SCHEMA` (the ~6-line type-enum + anti-invention rule) and `CONSENSUS_OUTPUT_FORMAT` (schema + consensus-specific framing) with a prominent "⚠ UNKNOWN TYPES ARE SILENTLY DROPPED" header.
- 10 default skills flattened — `## Output Format` sections replaced with a canonical 2-line pointer to the system-prompt schema. Skills now describe methodology only; output format is the orchestrator's responsibility.
- `prompt-assembler.ts` now injects a format block on every skill-bearing dispatch (full `CONSENSUS_OUTPUT_FORMAT` for consensus, slim `FINDING_TAG_SCHEMA` for non-consensus) — previously non-consensus tasks had no tag-schema guidance at all.
- New `packages/orchestrator/src/parse-findings.ts` — shared `parseAgentFindingsStrict()` helper replaces two duplicated regex sites in `consensus-engine.ts`. Preserves `findingIdx` sequential IDs (load-bearing for cross-review matching). Returns per-type drop counters via `onUnknownType` callback.
- Per-drop `⚠ DROPPED` log + per-round `⚠ DROP_SUMMARY` log at both parser sites. Misleading "ZERO tags" warning split into three paths (zero raw tags / all invalid / missing type attribute).
- New `droppedFindingsByType: Record<string, number>` field on `ConsensusReport`, populated in synthesis, persisted from `collect.ts` and `relay-cross-review.ts`. Dashboard surface: `FindingsMetrics.tsx` shows a "dropped findings" badge with tooltip listing offending types.
- `format_compliance` meta-signal extended with `{tags_total, tags_accepted, tags_dropped_unknown_type, tags_dropped_short_content}` for empirical fix verification.
- 35 new unit tests covering canonical types, unknown types, typos, missing type attr, case sensitivity, single-quote rejection, whitespace rejection, multi-line bodies, unclosed tags, nested angle brackets, short-content drops.

Diagnosed via a 3-agent consensus round (sonnet-reviewer + haiku-researcher + gemini-reviewer, 26 findings confirmed). Parser enum intentionally **not broadened** — broadening would normalize bad input and invite further drift.

### Message-rate-limiter windowing test fix

`tests/relay/message-rate-limiter.test.ts` "should not let old messages affect the current window" had an off-by-one (sent 5 messages then asserted the 6th call returns true with `maxMessages=5`). Fix is a 1-char change: `maxMessages - 2` → `maxMessages - 3`. Suite removed from `KNOWN_BROKEN_SUITES` — no longer skipped in CI.

### Server-side cross-review with epsilon-greedy reviewer selection (#45)

The consensus engine now handles Phase 2 cross-review internally. Previously the orchestrator had to manually dispatch cross-review agents one at a time (5-step protocol). Now `gossip_collect(consensus: true)` triggers server-side reviewer selection, cross-review with verifier tools (`file_read`, `file_grep`), and synthesis — all in one call (3-step protocol).

**Cross-reviewer selection** (`selectCrossReviewers`) uses epsilon-greedy exploration with severity-scaled rates: critical findings get 4.5% exploration (rarely experimental reviewers), low-severity gets full starvation-based exploration. Scoring: `accuracy * 0.7 + categoryAccuracy * 0.3`. Fresh agent pools use Fisher-Yates shuffle (`crypto.randomBytes`) for uniform distribution.

### Consensus-aware memory pre-fetch

Agents skip `memory_query` 85% of the time despite having a permanent skill telling them to recall. The new `prefetchConsensusFindingsText` function reads `implementation-findings.jsonl` at dispatch time, keyword-scores each finding against the task text, and injects the top 3 peer-confirmed findings into the agent's prompt automatically. No LLM call, ~5ms latency, ~600 chars budget. Agents no longer need to call `memory_query` to see recent consensus findings on the files they're reviewing.

Also added: `memoryQueryCalled` tracking on every task result for compliance auditing.

### Real agent scores for memory importance

Previously `writeTaskEntry` hardcoded `accuracy: 4, uniqueness: 3` for every task — making warmth-based compaction purely time-driven. Now uses actual `perfReader` scores: a sonnet-reviewer task (0.80 accuracy) gets importance 0.67, while an openclaw task (0.00 accuracy) gets 0.47. High-quality agents' memories survive compaction longer.

### Bulk signal recording from consensus reports

New action: `gossip_signals(action: "bulk_from_consensus", consensus_id: "xxx")`. Reads a consensus report and auto-records agreement/disagreement/unique signals for all findings, with dedup against existing `finding_id`s. Replaces manual one-by-one recording for 30+ finding rounds.

### Dashboard improvements

- Cross-review coverage badges per finding (reviewer initials, yellow warnings for under-reviewed)
- Consensus topic subtitle + severity filter on Debates page
- Design polish across all 5 pages (Home, Team, Debates, Tasks, Settings)
- Font centralization: `--font-inter` Tailwind v4 utility replaces 7 inline styles
- Bug fixes: filter state bleed, agentInitials trailing-dash, BarRow NaN guard
- Performance: dedupe agent set computation, useMemo for lastTaskByAgent, aria-expanded

### Other

- Timestamped centralized logger (`log.ts`) with emoji categories
- Bootstrap deferral fix (ToolSearch Step 0 + dispatch override rule)
- Removed 6 stale `.js`/`.d.ts` artifacts shadowing `.ts` sources
- Git project bridge spec (proposal, consensus-reviewed — deferred)
- HANDBOOK updated: consensus protocol 3 steps, CI pipeline caveat removed
- 2090+ lines of new tests across 5 test files

## [0.1.2] — 2026-04-09

### Native Claude Code as a first-class orchestrator (#12)

New users on fresh Claude Code projects previously hit two friction points that contradicted the README's zero-config promise:

- `gossip_setup` defaulted the `main_agent` to Gemini even when the host was Claude Code, because the wizard only considered keyed providers and never saw native as an option.
- Boot with no API keys printed `❌ No API keys available — orchestrator LLM disabled, features degrade to profile-based`, scaring users away from what is in fact the expected zero-config state on Claude Code (the host classifies tasks via natural language through the existing `isNullLlm` path).

Both are fixed. The wizard now injects `none: none (native Claude Code orchestration)` at the top of the available-models list when `CLAUDECODE=1` and explicitly instructs the LLM to PREFER `{ provider: "none", model: "none" }` for `main_agent` on Claude Code hosts. The boot fallback now prints `✅ Native Claude Code orchestration enabled` instead of the old error. The session-summary validation was also relaxed — it no longer requires a strict `SUMMARY:` prefix (the downstream extraction fallback already synthesizes one), and on true malformed output the raw LLM text is persisted to `.gossip/memory/last-malformed-summary.txt` for diagnosis.

### Cross-review silent-drop diagnostics (#13)

`gossip_relay_cross_review` filters entries whose `peerAgentId` is not a real round member (anti-fabrication guard at `relay-cross-review.ts:139`). This filter was previously silent — if ALL entries were malformed (e.g. a reviewer invented findingId prefixes like `cr:f1` or `sa:f1` instead of using `<peerAgentId>:f<N>`), the relay would ack the submission, mark the agent as responded, and advance synthesis with zero signal from that reviewer. Diagnosis required cross-referencing `mcp.log` against the consensus report.

Now both stderr and the MCP tool response itself carry a ⚠️ diagnostic line showing rejected peer IDs and the set of valid round members when any entry is filtered out. Happy path gets a ✅ `N/M entries accepted` confirmation for symmetry.

### Single source of truth for version reporting (#14)

Three independent code paths reported gossipcat's version and all three were broken: `gossip_status` returned a hardcoded literal `'0.1.0'`, `gossip_update` walked a fixed 4-level `__dirname` path that only held in the monorepo dev checkout (falling through to `'0.0.0'` on global installs and release tarballs), and `gossip_bug_feedback` read `process.cwd()/package.json` which returned the CALLING project's version instead of gossipcat's.

New `apps/cli/src/version.ts` walks up from `__dirname` until it finds a `package.json` with `name === 'gossipcat'`. The name check is what makes it layout-agnostic — it skips the workspace `apps/cli/package.json` in dev and only matches the real package root. Cached after first resolution, capped at 20 parent levels. Verified across dev checkout, global install, local dep, and GitHub release tarball layouts.

### checkEffectiveness Option A v2 (commit `048077e`, 2026-04-08)

The skill effectiveness gate has been rewritten to eliminate the `postTotal < 0` failure mode that caused skills to silently freeze in `pending` state for up to 90 days. Effectiveness evaluation now operates on **anchored deltas** rather than subtracting cumulative counters that drift independently.

**What changed:**

- New `PerformanceReader.getCountersSince(agentId, category, sinceMs)` counts signals in a time window anchored at an arbitrary `sinceMs`. Unlike `getScores()`, it does **not** apply the 30-day rolling window — `sinceMs=0` means lifetime. Used only by the effectiveness path; dispatch scoring is unchanged.
- `SkillSnapshot` field renames:
  - `baseline_correct` → `baseline_accuracy_correct`
  - `baseline_hallucinated` → `baseline_accuracy_hallucinated`
- `inconclusive_correct` and `inconclusive_hallucinated` are **removed entirely** from the snapshot. `inconclusive_at` alone serves as the next anchor for `getCountersSince`.
- `resolveVerdict` signature changed from `(snapshot, current, nowMs, opts)` to `(snapshot, delta, nowMs, opts)` — the second param is now a pre-computed delta, not cumulative counters.
- The defensive `postTotal < 0` guard is removed entirely — it is structurally unreachable in v2 because deltas are non-negative integer counts by construction.

### ⚠ Migration semantic shift (action required)

**For agents with more than 30 days of signal history**, the v1 → v2 migration introduces a *one-time* shift in the z-test reference baseline. This is intentional but worth understanding before you see it in the dashboard.

Under v1, `baseline_correct` was snapshotted from `getScores()` at bind time, which returns a **rolling 30-day cumulative**. Under v2, `migrateIfNeeded` re-snapshots from `getCountersSince(agentId, category, 0)` (full lifetime) when migrating any skill that lacks the v2 fields. For an agent who had 100 signals before bind (split 60 in the rolling window, 40 outside), the old baseline was `60` and the new baseline is `100`.

**Why this is the right fix:** v1's rolling-window baseline drifted as old signals expired, which is exactly the bug v2 is closing. The lifetime baseline is stable — it does not change as time passes.

**What you may notice on the first post-migration check:**
- A skill that was `inconclusive` under v1 may flip to `pending` or `passing` once it migrates, because the z-test is now comparing against a different (more accurate) reference proportion.
- A skill that was `passing` may flip to `inconclusive` if its v1 baseline was artificially low. This is a *correction*, not a regression.
- Skills with less than 30 days of pre-bind history are unaffected — both versions produce the same baseline because the rolling window already covered their full history.

**Migration is lazy:** snapshots upgrade on the next `checkEffectiveness()` call. There is no batch migration step; existing skill files on disk continue to work until they're next inspected. The migration is also idempotent — `migration_count >= 2` short-circuits re-runs.

**To audit the migration impact** for a specific agent before it runs in production, you can inspect the difference between `perfReader.getScores().get(agentId).categoryCorrect[category]` (the v1 number) and `perfReader.getCountersSince(agentId, category, 0).correct` (the v2 number) — if they differ significantly, that agent will see a baseline shift on its next check.

### Spec reference

Full design rationale and the Files Changed table live at `docs/superpowers/specs/2026-04-08-checkeffectiveness-v2.md` (gitignored — local working doc). The implementation was verified by 848/848 tests in `tests/orchestrator/` and went through two consensus rounds (`3d369dac-06c4434d` design + `a3a79e78-f1324af3` spec review, 11 confirmed findings).

### `gossip_remember` reachable from native subagents (2026-04-08)

Native Claude Code subagents can now call `mcp__gossipcat__gossip_remember` directly to search their archived knowledge on demand. Previously the tool was registered in the MCP server but no agent had it in their `tools:` allowlist — it was effectively dead code.

**What changed:**
- `gossip_setup` template now includes `mcp__gossipcat__gossip_remember` in the default `tools:` list when generating `.claude/agents/<id>.md` files. New installs get this automatically.
- The 4 native subagents in this repo (`sonnet-reviewer`, `haiku-researcher`, `sonnet-implementer`, `opus-implementer`) have been updated in-tree.

**Upgrade path for existing installs:**

If you ran `gossip_setup` before this version, your `.claude/agents/*.md` files lack the new tool. Two options:

1. **Manual edit** (preserves any custom instructions): for each file in `.claude/agents/`, add a line `  - mcp__gossipcat__gossip_remember` under the `tools:` block.
2. **Regenerate from template**: `gossip_setup(mode: "replace", agents: [...])` rewrites all agent files from the new template. This **overwrites custom instructions**, so prefer option 1 if you've edited them.

After editing, `/mcp reconnect gossipcat` (or restart Claude Code) so the agent files are re-read at session boot. The new tool will then appear in each subagent's context on next dispatch.

**Prerequisites for any gossipcat tool**:
- `.claude/settings.local.json` must include `"enabledMcpjsonServers": ["gossipcat"]`
- The gossipcat MCP server must be discoverable via your `claude_desktop_config.json` or equivalent

### Other 2026-04-08 fixes

- `f4a13d5` — `gossip_dispatch(mode:"consensus")` no longer drops tasks via the selective-routing shortcut. When you ask for consensus with N agents, all N run.
- `d2df59b` — Native subagent stuck threshold bumped from 3min/5min cap to 10min default; dispatch summary box now uses 📡 / 🧠 emoji per agent type.
- `95a188b` — Completed relay tasks are now visible in `gossip_progress` `recentlyCompleted`. Previously they vanished the moment they finished due to a two-store split between native and relay task tracking.
- `f3aa418` — `impl_test_pass` and `impl_peer_approved` signals now display as positive (`+1`) in the `gossip_signals` receipt instead of negative. Display-only fix; the underlying scoring (impl-track via `getImplDispatchWeight`) was already correct.
