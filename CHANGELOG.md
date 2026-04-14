# Changelog

All notable changes to gossipcat are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) — entries describe user-visible behavior changes and migration impact, not every commit.

## [Unreleased]

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
