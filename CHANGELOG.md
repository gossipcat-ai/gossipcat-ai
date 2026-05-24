# Changelog

All notable changes to gossipcat are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) — entries describe user-visible behavior changes and migration impact, not every commit.

## [Unreleased]

## [0.5.2] — 2026-05-24

Dashboard polish + a load-bearing reader bug fix. The visible win is a cleaner Team page and login screen; the invisible win is that the Tasks page stops showing "0 of 0" forever once the task graph crosses 5MB.

### Fixed

- **Task-graph rotation reader bug** (PR #487). `performance-writer.rotateJsonlIfNeeded` does single-slot 5MB rotation (`.jsonl` → `.jsonl.1`) but the three relay endpoints reading task history (`api-tasks.ts`, `api-agents.ts`, `api-overview.ts`) only loaded the primary file. After rotation, every `task.created` event in the archive became orphaned from its later `task.completed` in the new primary, so long-running and historical tasks vanished from the Tasks page, the per-agent task lists, and the Overview hourly bucket counts. `taskCompletionRate` (which drove the "Reliability" bar) became permanently null. Readers now load `.jsonl.1` then `.jsonl` and concatenate in chronological order. On a fleet with 1,483 historical `task.created` entries in the archive, the Tasks page went from showing 3 entries to 1,486.
- **Consensus eee614bd-31ba4209 high-severity findings** (PR #487). Seven dashboard fixes from a 3-agent consensus round: (1) `SeverityMixStrip` switched from a monochrome `--bad` opacity ramp to per-segment semantic colors (`--bad`/`--warn`/`--info`/`--idle`) so critical/high/medium/low render distinctly. (2) `RecentSignalsPeek` "+N in last hour" badge moved from `--accent` (terracotta, CTA-only per DESIGN.md) to `--info`. (3) `SkillGraduationGrid` skill-count badge: `--accent` → bold `--ink`. (4) `computeDeltaPp` gates the ±pp display behind ≥4 non-null buckets — prevents misleading ±100pp swings from 2-bucket single-signal data on PASSED cards. (5) `RecentSignalsPeek` severity tick now has `role="img"` + descriptive `aria-label` so screen readers get severity context (was `aria-hidden` with title-only). (6) `TopBar` Search placeholder: `role="button" tabIndex={-1}` (contradictory AT) → `aria-hidden="true"`. (7) `±pp` delta added explicit `aria-label` for trend direction.
- **AuthGate UX hardening** (PR #487). Loading state on Unlock button (disabled + "Unlocking…" label during pending). `LoginResult` discriminated union threaded through `lib/api.ts` → `useAuth.ts` → `AuthGate.tsx` so the error message distinguishes 401/403 ("Invalid key") from network/5xx ("Connection error — relay may be offline"). `shadow-2xl` removed per DESIGN.md no-drop-shadow rule.

### Added

- **SkillGraduationGrid per-agent identity** (PR #487). Each card now shows a colored agent dot + agent ID below the skill name — disambiguates the 4 `trust-boundaries`, 3 `data-integrity`, 2 `type-safety` duplicates that previously rendered identically. Card chrome now also displays a `7d` window chip, the current accuracy vs threshold (`0.42 / 0.70`), and a ±pp drift indicator (PASSED skills only).
- **`/api/skills` 7d effectiveness window** (PR #487). `deriveEffectiveness` switched from `[boundAt, now]` equal-time bucketing to a `[max(boundAt, now-7d), now]` window. Skills bound long ago with one cluster of historical activity used to collapse into 2-3 populated buckets out of 10; now sparse-data cards render the clean dashed threshold line and dense recent activity fills the curve evenly.
- **AgentNetworkGraph starfield polish** (PR #487). 170 stars (was 120) with three-tier brightness — ~7% bright (r ≈ 2.0-2.6, opacity 0.75-1.0), ~25% mid (r ≈ 1.2-1.6), ~68% faint background — and a deeper 0.80 ± 0.35 twinkle swing.

### Changed

- **TeamPage + AuthGate DESIGN.md compliance** (PR #487). Full token migration across both surfaces: `--text` → `--ink`, `--text-dim` → `--ink-2/--ink-3`, `--danger` → `--bad`, `--success` → `--ok`. Headers use `.h-route` (Fraunces 32px); stat labels, column headers, badges, and mini-bar labels use `.h-section` small-caps Geist (was `font-mono uppercase tracking-wider`, the "killed Risk #4" pattern per DESIGN.md). TeamPage rank #1 color: `--accent` → bold `--ink`. `TasksPage` + `FindingsPage` token migration also landed (whole-file scope of the gate-check).
- **Reliability bar removed from Team/Fleet/Agent surfaces** (PR #487). `AgentCardBig`, `AgentPage`, and the App TeamPage table no longer render the Reliability row. The backing `taskCompletionRate` was null because of the task-graph rotation bug above; the row will return once backend wiring of per-agent completion ratios from the merged `.jsonl + .jsonl.1` stream lands.
- **README hero refresh** (commit `5362f681`). Three dashboard screenshots embedded near the top of `README.md` so GitHub visitors see the post-DESIGN.md visual story before the install section.

### Migration

No API changes. Operators using the Tasks page or relying on `taskCompletionRate` will immediately see historical entries after upgrading.

## [0.5.1] — 2026-05-24

Hotfix for SkillGraduationGrid sparkline rendering — fragmented dots on low-signal cards were noise, not information.

### Fixed

- **SkillEffectivenessSparkline minimum-points gate** (PR #486, supersedes PR #484). `MIN_VISIBLE_POINTS` raised from 3 to 5 (half of the 10-bucket window). Below the threshold the card shows only the dashed graduation threshold line — sparse data with big gaps collapses to the clean placeholder instead of fragmented stubs that read as broken noise.

## [0.5.0] — 2026-05-24

Marathon dashboard session — full `DESIGN.md v1` application checklist (Steps 0-10) landed across 14 PRs (#464-#482). The visual system is now an editorial canvas: Fraunces serif for route titles, small-caps Geist for section labels, JetBrains Mono restricted to data/IDs, semantic color tokens (`--ok`/`--warn`/`--bad`/`--info`/`--idle`) replacing pre-migration aliases.

### Added

- **DESIGN.md v1** (PR #463). Source of truth for the dashboard visual system — editorial canvas + infographic vocabulary direction, color token palette, typography rules (Fraunces / Geist / JetBrains Mono), 10-step implementation checklist with gate criteria.
- **Steps 0+1 — fonts + token aliases + TeamHero smoke** (PR #464). Fraunces + Geist + JetBrains Mono loaded; DESIGN.md alias-block tokens introduced.
- **Step 2 — section header sweep + accent cleanup** (PR #465). `.h-section` small-caps Geist applied across section labels; first pass of terracotta `--accent` leaks removed from non-CTA chrome.
- **Step 3 — topbar text migration** (PR #466). TopBar nav + brand mark migrated to DESIGN.md typography contracts.
- **Step 4 — accuracy-scope encoding + equal-height hero** (PR #467). Hero row uses `align-items: stretch` per DESIGN.md.
- **Step 5 — ActivityWaterfall 24h per-agent heatmap** (PR #469). New visualization replacing the prior bar grid.
- **Step 6 — team cards + topbar polish** (PR #471). AgentCardBig refactored with polar gauge + severity strip + sparkline + status chip; per-agent identity color via `agentColor(id)`.
- **Step 7 — Consensus flow page + `/api/consensus-flow` backend** (PR #472). 4-state Sankey visualization of consensus rounds with `lg/sm` responsive breakpoints; trust-boundary regex validation on `consensusId`.
- **Step 8 — signal stream table** (PR #473). RecentSignalsPeek refactored to TIME / VERDICT / AGENT / FINDING / CONF columns; `renderFinding()` helper wraps backtick spans in inline code styling.
- **Step 9 + 9.5 — SkillGraduationGrid** (PR #474, #475). Verdict-grouped foundation rewritten as a flat card grid; UNKNOWN bucket in a native `<details>` collapsible; per-skill post-bind effectiveness curves derived from 10-bucket bucketing of `agent-performance.jsonl` with 60s mtime cache; backend `/api/skills` extended with `effectiveness: SkillEffectivenessEntry[]`.
- **PR-A page heading parity — `.h-route` Fraunces H1** (PR #476). All routes use the same 32px Fraunces route title; `.h-section` demoted to section labels only.
- **PR-B Overview restructure** (PR #478). `<header>` moved above graph; duplicate actionable CTA deduped; graph toggle via URL state.

### Changed

- **Step 10 — final cleanup** (PR #482). Inter font removed from `index.html` + `globals.css`; legacy tokens (`--text-faint`, `--color-chart-deep`) removed; final all-caps `font-mono` header sweep (`uppercase tracking-widest` returns empty in `packages/dashboard-v2/src`).
- **PR-C Tasks + regressions** (PR #479). Tasks section polish + regression fixes accumulated during the marathon.

### Fixed

- **TopBar glossary button polish** (PR #477). Normalized to 32×32 / 8px-rounded matching the theme toggle.
- **`/` → `/dashboard` redirect** (PR #481). 302 redirect at the relay so the bare host serves the dashboard.

### Migration

Dashboard-only release — no API surface changes. The visual system is now contract-driven by `DESIGN.md`; any new component must respect the alias-block tokens and the small-caps-not-all-caps-mono convention.

## [0.4.31] — 2026-05-22

Fixes a recurring silent-failure mode where `Agent(isolation:"worktree")` dispatches sometimes didn't engage the worktree sandbox — subagents wrote directly to the parent checkout. Three-agent consensus session diagnosed the root cause: the `isolation: "worktree"` parameter was emitted as a conditional string fragment mid-tuple in the dispatch banner (`apps/cli/src/handlers/dispatch.ts:705,707`), exactly the position where LLMs drop keyword args during paraphrase. Two prior fix designs ("Inverted Gate" PreToolUse-hook denial, "Dispatch-Time Probe" new MCP tool) were proposed and rejected during the session — both solved a different layer than the actual bug.

### Fixed

- **Worktree-isolation prompt emission hardening** (PR #450, commit `ca97a5f`). Three structural changes to `apps/cli/src/handlers/dispatch.ts` make `isolation: "worktree"` undroppable: (1) standalone `Worktree isolation: REQUIRED — Agent() MUST be invoked with isolation: "worktree"` banner field, parallel to Task ID/Agent/Model, emitted only when `useWorktree` is the effective state; (2) multi-line `Agent()` template that places `isolation: "worktree", // REQUIRED — do not omit` on its own line instead of mid-tuple — non-worktree dispatches keep the single-line shape, so no regression; (3) `// GOSSIP_ISOLATION: worktree` four-line header prepended to the elided prompt file (`.gossip/dispatch-prompts/<taskId>.txt`) when `write_mode='worktree'`, anchoring the contract in the prompt body itself for `prompt_format: 'elided'` dispatches. Closes a **latent gap** in `handleDispatchConsensus` that previously did not emit `isolation: "worktree"` at all when `write_mode='worktree'`. Pre-merge consensus (sonnet-reviewer + opus-implementer) caught a contradictory-packet bug fixed in fixup `dccc0c1`: `elidePromptIfRequested` now receives effective `useWorktree` (post git-repo downgrade) rather than raw `write_mode`, preventing the on-disk header from contradicting the banner+Agent() call on non-git-repo dispatches. 7 new tests in `tests/cli/dispatch-native-prompt.test.ts` cover all three dispatch paths (single/parallel/consensus) plus elided-positive, elided-negative, and the non-git-repo silent-downgrade case. Option B post-relay detection (`worktree-isolation-detection.ts`) and PR #436 concurrent-worktree-taint stay unchanged as the safety net — this PR adds emission-side hardening, not a replacement for the detection layer.

### Migration

No code changes required. Internal dispatch banner format change only — no public API surface affected.

## [0.4.30] — 2026-05-22

Adds consensus auto-verify — an opt-in feature that automatically dispatches a verifier agent to `file_read`-check every UNVERIFIED finding before the consensus report is returned, eliminating the manual CLAUDE.md orchestrator-side rule's "forgetting" and "inconsistency" failure modes. Off by default. Spec went through 6 consensus rounds across rev-1 → rev-6 (21+ HIGH findings caught and resolved) before approval.

### Added

- **Consensus auto-verify with team-aware verifier discovery** (PR #448, commit `4b28a1c`). New behavioral flag `GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED` (boolean, default `'0'`) gates the feature; companion `GOSSIP_CONSENSUS_AUTO_VERIFY_AGENT` (string, default empty) lets operators pin a specific verifier. When enabled, `maybeAutoVerify` at the single call site in `ConsensusEngine.run()` (`packages/orchestrator/src/consensus-engine.ts:407`) dispatches a verifier per UNVERIFIED finding through `verifierDispatch` (injected via `ConsensusEngineConfig`), parses a strict line-1 `VERDICT: confirmed|refuted|inconclusive` from the response, and stamps `finding.autoVerify = {attempted, verdict, evidence, dispatchedAt, durationMs}`. The `tag` field stays `'unverified'` regardless of verdict — auto-verify is metadata, not state transition — so verifier misfire cannot promote/demote findings and the CLAUDE.md orchestrator fallback still applies. Two operational signals (`auto_verify_attempted`, `auto_verify_skipped_misconfigured`) land in `report.signals` with `agentId: '_utility'` and `severity: 'low'`; they do NOT touch `scoringSignals` arithmetic (the `never`-default arm in `packages/orchestrator/src/performance-reader.ts:906` makes this compile-enforced — 5 existing operational signals received explicit `case ... break;` arms in the same commit). Team-aware discovery at `apps/cli/src/handlers/auto-verify-discovery.ts` resolves a `VerifierBinding` from `ctx.mainAgent.getAgentList()` using the live `AgentConfig.native` discriminant; native subagents always qualify, relay workers must declare a `'verification'` skill. The override path runs the same suitability predicate so a misconfigured pin produces the `override_agent_unsuitable` skip reason. Option A (relay-worker dispatch) is fully wired; **Option C (native two-phase deferred-enrichment via `_utility_task_id` re-entry) is stubbed** — the engine's fail-open path catches the rejection and stamps each finding `inconclusive` with the error evidence, so deployments without a verification-skilled relay worker get a working misconfig signal but no actual verification. Follow-up PR needed for Option C. Defense-in-depth: 3 structural layers (`escapeFindingDataDelimiters` widened regex `/<\s*\/?\s*finding_data[^>]*>/gi`, verdict-at-line-1 parser that defeats input-echo injection, `tag` invariant) + 2 non-structural (CLAUDE.md orchestrator fallback, DATA-ONLY preamble — explicitly labeled "best-effort prompt-level fence with documented bypass history" after rev-5 review caught the rev-3 overclaim). 50 new tests across 4 test files. Pre-merge consensus rounds: `547d50c7-674c44c0` (rev-1, 4 HIGH), `6579f97f-...` (rev-2, 5 HIGH), `d8ab49b6-...` (rev-3, 5 HIGH), `43a9d722-27ac4226` (rev-4, 3 HIGH), rev-5 review (3 HIGH), rev-6 final (0 HIGH — approved).

### Fixed

- **`VALID_CONSENSUS_SIGNALS` allowlist drift caught and fixed before release** (commit `316baab`, part of PR #448). The initial implementation added the two new auto-verify signals to `KNOWN_SIGNALS` + `ConsensusSignal['signal']` union + `OPERATIONAL_SIGNAL_NAMES` but missed `VALID_CONSENSUS_SIGNALS` in `packages/orchestrator/src/performance-writer.ts:51` — the runtime validator. The pre-existing `signal-allowlist-drift.test.ts:108` regression test (which exists precisely to catch this — same failure mode as PR #329's silent-drop of `transport_failure`) failed in CI and the gap was closed with a 7-line addition before merge. Without this fix every emitted auto-verify signal would have been silently rejected by `validateSignal` and dropped on the floor.

### Migration

No code changes required. Auto-verify defaults OFF; enable via `gossip_config(set: GOSSIP_CONSENSUS_AUTO_VERIFY_UNVERIFIED=1)` only after configuring a verification-skilled relay worker (Option A wiring is the only complete path in this release).

## [0.4.29] — 2026-05-22

Two PRs shipped same-day: backlog #4 closes (runtime-config DI refactor that finally removes the `GOSSIP_NATIVE_WORKTREE_MANAGED` tombstone), and a critical fix for a silent crash-loop on hosts that ran `gossip_setup`. The hook fix is the more user-visible of the two — any user who reported "gossipcat keeps crashing after install" was hitting it.

### Fixed

- **`gossipcat hook --run` no longer spawns a duplicate MCP server** (PR #443, commit `38bd6b2`). The published `gossipcat` binary (`package.json:bin → dist-mcp/mcp-server.js`) was the MCP-server-only bundle with no CLI argument parsing. When `installBootstrapHook()` at `packages/orchestrator/src/hook-installer.ts:312` wrote `BOOTSTRAP_HOOK_COMMAND="gossipcat hook --run"` into `.claude/settings.local.json` UserPromptSubmit (called by `gossip_setup`), every prompt fired `dist-mcp/mcp-server.js hook --run` which ignored the args and booted a second MCP server. Two instances then fought over `.gossip/` lockfiles, HTTP MCP port 51838, and stdio — the real server's relay disconnected, triggered reconnect-loops, and users saw "gossipcat keeps crashing". The fix is a ~50-line argv-dispatch shim at the top of `apps/cli/src/mcp-server-sdk.ts` that runs BEFORE the stderr redirect and any side-effecting initialization. It reuses the existing `parseHookSubcommand` + `runHook` helpers from `apps/cli/src/hook-run.ts` (already used by the CLI dispatcher at `apps/cli/src/index.ts:60-65`), so the same `gossipcat hook --run` invocation now produces identical output whether resolved through the published binary or the workspace-internal CLI. Adds `--help` / `-h` / `help` for inline usage and exits with code 2 on unknown subcommands. 5 new integration tests at `tests/cli/mcp-server-argv-dispatch.test.ts` spawn the actual `dist-mcp` bundle and assert no `.gossip/mcp.log` is created on the hook-exit paths. Pre-merge consensus `64625c95-206140e1` flagged 2 lows + 2 CLI-ergonomics insights (no critical/high). Misdiagnosis note: an earlier peer report attributed the same crash to `.gossip/agents/<id>/memory/` being un-pre-created by `gossip_setup` — that path is actually fail-soft (all readers `existsSync`-guard, all writers `mkdirSync({recursive:true})` first). The bootstrap-hook dispatch was the real cause.

### Changed

- **`runtime-config` API gains optional `registry` parameter on every public function** (PR #442, commit `d80dac1`, closes backlog #4). The 7 public functions in `packages/orchestrator/src/runtime-config.ts` — `getRuntimeFlag`, `getRuntimeFlagBool`, `getRuntimeFlagInt`, `setRuntimeFlag`, `unsetRuntimeFlag`, `listRuntimeFlags`, `reloadRuntimeFlags` — now accept an optional trailing `registry: RuntimeFlagRegistry = RUNTIME_FLAG_REGISTRY` parameter. Three internal helpers (`ensureLoaded`, `getSpec`, `validateValue`) also accept it and forward it through every delegation site (including the `Object.entries(registry)` site at `runtime-config.ts:443` in `listRuntimeFlags`, which is a second registry read distinct from the `ensureLoaded` warning loop). Production code is fully backward-compatible — every existing callsite omits the new arg and relies on the default. Tests inject a synthetic `TEST_REGISTRY` to exercise registry behavior without touching the production constant. New `RuntimeFlagRegistry` type re-exported from `packages/orchestrator/src/index.ts:248` so external test suites can declare conforming registries. **`RuntimeFlagKey` collapses to `never`** in the published `dist/index.d.ts` because `RUNTIME_FLAG_REGISTRY = {}` after the tombstone removal — verified zero external consumers across `apps/`, `packages/`, and `dist-mcp/` (grep for `RuntimeFlagKey` and `keyof typeof RUNTIME_FLAG_REGISTRY` returns only the definition + the barrel re-export). Three new DI-seam falsification tests added to `tests/orchestrator/runtime-config.test.ts`: Test A verifies the `getSpec`-default lookup branch, Test B verifies the `ensureLoaded` warning loop honors the injected registry (the most-likely missed delegation site if the contract regresses), Test C verifies `listRuntimeFlags` enumerates the injected registry. `apps/cli/src/mcp-server-sdk.ts:3941` gets a `|| '(none registered)'` fallback for the empty-registry error message. Pre-merge consensus `bd0d9829-e2ea4502` confirmed 5 findings and produced 6 unique observations across two reviewers.

### Migration

No code changes required for consumers. The `RuntimeFlagKey → never` collapse is the only public-type surface change; it is harmless because no consumer parameterizes on it.

If you were affected by the `gossipcat hook --run` crash-loop and have a `gossipcat hook --run` line in your `.claude/settings.local.json` UserPromptSubmit, upgrade to 0.4.29 and re-run `gossip_setup` (or leave it alone — it now does the right thing). The 3 other discipline hooks (SessionStart bootstrap, PreToolUse signals validator, PostToolUse collect reminder) were unaffected throughout.

## [0.4.28] — 2026-05-20

Four bug fixes and one polish PR shipped same-day after v0.4.27. Two of them — #401 anchor warning and #402 auto-discovery routing — were known issues from a prior consensus round (`71493829-1261487e`) where their interaction silently mis-routed gemini relay workers to sibling worktrees and emitted misleading "resolved against project root" warnings against properly-resolved worktree paths. Both shipped after multi-agent design consensus rounds with cross-review. The auto-discovery fix walks back the original auto-promote behavior to a discovery-only contract — operators must now pass explicit `resolutionRoots` to route cross-reviewers to a specific worktree.

### Fixed

- **Auto-discovery no longer auto-promotes sibling worktrees** (PR #419, closes #402). `apps/cli/src/handlers/dispatch.ts:764` previously set `effectiveRoots = discovered` whenever `autoDiscoverWorktrees` found sibling worktrees, silently routing relay workers to whichever worktree `git worktree list` returned first. When the operator was reviewing master HEAD, this sent cross-reviewers to the wrong branch and produced phantom UNVERIFIED findings. The flag is now discovery-only: it validates discovered paths, logs a hashed-paths warning naming the siblings, and returns. Operators must pass explicit `resolutionRoots` to route cross-reviewers. Mirror fix at `apps/cli/src/handlers/collect.ts:444` (was `effectiveRoots = [...explicitRoots, ...discovered]`, now `effectiveRoots = explicitRoots`). HANDBOOK §"Reviewing a branch that lives in a git worktree" rewritten. Spec `docs/specs/2026-04-17-issue-126.md` carries a v4 amendment note in the local-only spec dir. Design verified by 2-agent cross-review consensus `c6b8580d-595e48d2` — sonnet-reviewer + opus-implementer converged on the discovery-only contract; reviewers also surfaced the collect.ts mirror site and the multi-worktree N>1 data-loss path (mooted by this fix). 15/15 autodiscover tests updated to enforce the new contract (no relay-options injection, hashed paths only, no raw paths in warnings).

- **Consensus-engine anchor warning false-positive on nested worktrees** (PR #418, closes #401). When a worktree lived at `<projectRoot>/.claude/worktrees/agent-X` (standard layout — nested INSIDE projectRoot), the priority resolver correctly returned the worktree path, but the warning attribution check `filePath.startsWith(resolve(projectRoot) + '/')` evaluated true for any nested-worktree path. Result: every worktree-resolved anchor carried the misleading `via="⚠ resolved against project root, NOT worktree"` attribute. New private helper `isResolvedFromProjectRootOnly` checks both projectRoot membership AND non-membership in any active worktree root via the existing `isInsideAnyRoot` realpath-normalized helper. Both call sites at `consensus-engine.ts:1495` and `:1549` migrated. Priority resolver itself unchanged — bug was purely in warning attribution. 2 regression tests added.

- **Citation regex strips Windows drive letters** (PR #417, closes #413). Reported by @GravyaDev in his PR #407 validation report. The citation-extraction regex at 7 source sites used prefix character class `[\w./-]` which excludes `:` — for `c:/Users/Daniele/repo/src/foo.ts:42` the regex matched starting at position 2, producing `/Users/Daniele/repo/src/foo.ts:42` (drive letter silently stripped). Added a non-capturing optional Windows-drive prefix `(?:[a-zA-Z]:\/)?` before the existing prefix character class at all 7 sites in `packages/orchestrator/src/`: `parse-findings.ts:31`, `consensus-engine.ts:57`, `:1464`, `:1540`, `:1661`, `dispatch-pipeline.ts:121`, `dedupe-key.ts:24`. Non-capturing + optional → Unix paths still match identically; only Windows-prefixed paths now retain the drive letter. 134-LOC test file with 9 cases across 5 describe blocks covering Unix baseline, Windows lowercase/uppercase drive, cite-tag context, URL-shaped strings.

### Polish

- **EXCLUDED_EXTS dotfiles + HANDBOOK rationale** (PR #416, follow-ups to #414). Two low-priority follow-ups from PR #414's consensus review: (1) `EXCLUDED_EXTS` in `skill-engine.ts:751` expanded with 5 common Node-repo root dotfiles (`.prettierrc`, `.eslintrc`, `.babelrc`, `.dockerignore`, `.flowconfig`) — they previously leaked into the extension census as weak `.prettierrc(1)` noise on every Node project. (2) HANDBOOK Tech-stack auto-detection rationale corrected — prior text claimed `.yaml` is excluded "since already captured by other signals" (inaccurate for Kubernetes/Ansible projects where `.yaml` IS the source), replaced with the real rationale (noise reduction + ubiquity-based exclusion) and explicit trade-off note. No behavior change for existing fixtures.

### Migration

No breaking changes for operators who already pass `resolutionRoots` explicitly. Operators relying on the old `autoDiscoverWorktrees` auto-promote behavior MUST now pass `resolutionRoots: [".claude/worktrees/agent-<hash>"]` on `gossip_dispatch` and `gossip_collect` to route cross-reviewers to a specific worktree. The flag still serves discovery + validation but does not assign workers.

## [0.4.27] — 2026-05-20

Closes issue #410 — `SkillEngine.detectTechStack` confabulated a Node.js tech-stack on non-Node host projects (Solidity, Rust, Move, audit workspaces) because its signal pool was npm-only. A typical audit repo with `gossipcat` as its sole npm dep saw the LLM produce a "Node.js gossip-protocol library with readable-stream, through2, in-memory storage" description that was then injected into every subsequent `gossip_skills(action: "develop")` prompt — silently degrading any skill generated for a non-Node agent until the operator caught it manually. The fix lands in three layered PRs from the same consensus design (`06606bd2-56fd4015`): Option B floor blocks the LLM call on thin signals, Option C lets operators hand-author a `.gossip/tech-stack.md` override, Option A extends the signal gathering pool to 8 non-Node manifests + README + a shallow extension census.

### Added

- **`.gossip/tech-stack.md` user override** (PR #412). Drop a hand-authored file at the project root to bypass auto-detection entirely. Content (≤2000 chars after trim) is injected verbatim into the skill-develop prompt's `<tech_stack>` block. Reads through `readTechStackOverride()` at `packages/orchestrator/src/skill-engine.ts:816`, called from the cache-miss line at `:456` via `??` chain. Empty file or read errors fall through to auto-detect (with stderr warning on errors); files over 2KB are clamped with a stderr warning. Cache is session-stable — restart the MCP server to pick up edits. HANDBOOK "Tech-stack override" section documents the workflow. 6 new test fixtures (D–H + memoization assertion).

- **Multi-toolchain auto-detection** (PR #414). When no override is present and the npm dep count is below `TECH_STACK_MIN_DEPS=3` OR the project is non-Node, `detectTechStack` now scans the project root for known manifests (Cargo.toml, pyproject.toml, requirements.txt, go.mod, foundry.toml, Move.toml, Gemfile, composer.json), the README first 30 lines / 2KB, and a shallow file-extension census (root only, excluding `node_modules`/`.git`/`.gossip`/`dist`/`build`/`out`/`coverage`, capped at 10 extension types). Any non-Node signal — manifest match, README content, or extension census — bypasses the `MIN_DEPS=3` floor so polyglot projects don't need the override file. Workspace-level manifests deferred to follow-up. The extension census filters out ubiquitous config extensions (`.json`/`.md`/`.yaml`/`.toml`/`.lock`/`.env`/etc.) via `EXCLUDED_EXTS` to prevent false non-Node signals in typical Node projects. README scan falls through to alternative candidates on read errors (post-review fixup `5aa0c1c` addressed the medium F1 break-vs-continue bug). 9 new test fixtures (I–Q including the EISDIR fallback regression test).

- **`TECH_STACK_MIN_DEPS=3` thin-signal floor** (PR #411). `detectTechStack` now tracks `totalDepCount` as an integer across all collected `package.json` entries and returns null early when the dep count is below 3, suppressing the `<tech_stack>` injection entirely. Replaces the prior single-`inputs.length===0` guard. Rationale: 1–2 dep signals are dominated by the LLM's Node.js training prior; 3+ non-trivial deps provide enough negative-list signal to suppress that prior. Fixup `788e73c` refactored the original string-serialization round-trip into integer counting per consensus `af031aac-dac94c57` review (closes f1+f2+f5). 4 new test fixtures (A–C + memoization).

- **`scripts/test-tech-stack-audit-team.ts`** — verification script that instantiates SkillEngine pointed at any project root, captures the `<project_deps>` block sent to the LLM detector, and prints the resulting `<tech_stack>` injection. Doubles as a regression smoke test for #410 after future skill-engine changes.

### Migration

No breaking changes. The thin-signal floor changes one observable behavior: projects with fewer than 3 npm deps AND no non-Node signal will no longer receive an auto-detected `<tech_stack>` block. Previously this produced a hallucinated Node.js description; now it produces no block at all (skill content is generic instead of wrong-domain). Operators who want a tech-stack hint for thin-signal projects should drop a `.gossip/tech-stack.md` file at the project root.

## [0.4.26] — 2026-05-19

Native-dispatch context optimization (Phases 1 + 2 of the elision pattern), prose-only ledger resolution, two contributor-reported bug fixes (HTTP MCP transport crash + memory-index prototype pollution), and a cluster of transport / observability hardening. The headline savings: native consensus dispatches no longer pay 30 KB of skill bodies per turn across the orchestrator's conversation. Phase 1 (PR #398) writes the assembled prompt to `.gossip/dispatch-prompts/<taskId>.txt` and emits a marker; Phase 2 (PR #404) layers a skills-only warm cache on top so repeat-shape dispatches in a session skip `assemblePrompt` entirely. Splice-not-reuse design — caching the full body with stale `Task:` would corrupt the RL feedback loop, per consensus `335e8be5-336648b5:f11`. The two contributor fixes are independently severe — HTTP MCP daemons crashed on the first inbound MCP request (per-connection server fix, PR #407 closing #405); `gossip_remember(_project)` crashed when the corpus contained the token `constructor` or any other prototype member name (PR #408).

### Added

- **Phase 2 dispatch-prompt warm cache** (PR #404). New `apps/cli/src/handlers/dispatch-prompt-cache.ts` (268 LOC) — caches the `--- SKILLS ---` section keyed by `{agentId, skillFingerprint, taskKind}`, splices the live `Task:` block at hit time. Fingerprint is SHA-256 over sorted `<absPath>:<mtimeMs>` pairs from `skillResult.paths` (no extra IO at fingerprint time). 5-value `taskKind` enum disambiguates `handleDispatchParallel(consensus:true)` from `handleDispatchParallel(consensus:false)`. 64-entry LRU with `dispatch_cache_evicted` pipeline signal (`reason: lru | invalidation | overwrite_race`). Six invalidation sites cover every skill-mutation path: `gossip_skills(bind|unbind|develop)`, `gossip_setup(replace|merge|update_instructions)`, `saveFromRaw` return path, `checkEffectiveness` runner, `create-agent.ts` direct instruction writes. Spec at `docs/specs/2026-05-18-dispatch-prompt-warm-cache.md`. 16 tests including splice-integrity. Consensus `335e8be5-336648b5` (11 confirmed + 5 unique, 1 disputed) — CRITICAL finding flipped Open Question §1 from "reuse stale body" to "splice live task" before implementation.

- **Phase 1 server-side prompt elision** (PR #398). All three dispatch tools (`gossip_dispatch`, `gossip_run`, `gossip_collect`) accept `prompt_format: 'inline' | 'elided'`. Default `'inline'` is byte-identical to the pre-PR path. When `'elided'`: server writes the assembled prompt body to `.gossip/dispatch-prompts/<taskId>.txt` (atomic temp-rename, SAFE_NAME-validated taskId) and emits Item 1 with a marker `[skills section elided: see <abspath>, <N> bytes — READ this file and pass its CONTENTS verbatim as the Agent(prompt: ...) value]`. Item 2 is OMITTED entirely under elision — orchestrator MUST Read the cited file. On-disk file contains ONLY agent-facing content (no `relay_token`, no `task_id`, no `AGENT_PROMPT:` tag prefix). Crash recovery via `pruneOrphanDispatchPrompts` on boot. Aggregate cap `DISPATCH_PROMPT_CAP_BYTES = 100MB` with eldest-eviction. HANDBOOK invariant #4 updated with the optional elision protocol. New file `apps/cli/src/handlers/dispatch-prompt-storage.ts` (203 LOC). Consensus `ea473d6a-88ff402b` for design, `8f74076f-e2dc4bb7` for impl review.

- **`LoadSkillsResult.paths` field** (PR #403). `loadSkills` now exposes the resolved absolute paths of every loaded skill file at `packages/orchestrator/src/skill-loader.ts:111`, index-aligned with `loaded[]`. Realpath-normalized in `resolveSkill` at `:445`; `realpathSync` failures fall back to the non-normalized path (deletion-race tolerant). Iteration order in the assembly loop (permanent → scoped → accepted) documented as load-bearing — consumers depend on `paths[i] === resolved(loaded[i])`. Prerequisite for the Phase 2 warm cache fingerprint. 5 new tests cover empty paths, index alignment for permanent + contextual, symlink realpath resolution. Required by consensus `335e8be5-336648b5:f1,f15` as an implementation blocker.

- **`gossip_status({ slim: true })`** (PR #397). Omits the `## Project Handbook` inline section (~21 KB savings) on reconnect refreshes when the orchestrator already has the handbook in working memory. Bootstrap callers should leave `slim:false` (default). MCP handler at `apps/cli/src/mcp-server-sdk.ts` adds the param to `gossip_status`'s schema; the handler at line ~700 conditionally elides the `loadHandbook()` block when slim is true.

- **`prose-only` ledger bullet resolver** (PR #388, hardened in PR #389). Closes the `[PROSE-ONLY]` ledger-gap described in `feedback_prose_only_ledger_gap.md`. New `packages/orchestrator/src/prose-bullet-resolver.ts` (~600 LOC) with 4 token classes, Jaccard ≥0.3 + ≥2-token match, tie-breaking that returns ambiguous candidates in details, and a sidecar dual-keyed for ext4 inode reuse. PR #389 added defense-in-depth: `isProseResolverIndex` type guard, `FRONTMATTER_READ_LIMIT` + `SIDECAR_READ_LIMIT` `statSync` gates, `DISCOVER_AGENT_CAP = 1000`, and mtime-only invalidation. Spec round `5b171030-4996426e`, impl reviews `27d22652-c5c14302` (defense-in-depth) and the original `8f74076f-e2dc4bb7` (deferred Phase-1 tests later backfilled in PR #400).

- **`dist-mcp` staleness dev-check** (PR #387). Banner + `mcp.log` breadcrumb when `dist-mcp/mcp-server.js` is older than orchestrator/CLI source. Closes the "merged-but-not-bundled" gap that previously hid PR #383's annotations. Hook at the MCP server entry compares newest-source-mtime vs `dist-mcp/mcp-server.js`. Consensus `6f0ddb50-c759411b`, 14 tests, positive + negative e2e.

- **Dispatch-time worktree auto-discovery** (PR #390 / #393, fix #394). `consensus.autoDiscoverWorktrees: true` in `.gossip/config.json` auto-discovers all `git worktree list` entries at round start; PR #394 (`closes #392`) covers the `handleDispatchParallel(consensus:true)` path that was missing the discovery hook. Validator runs each path through realpath + git-common-dir membership check before adding to the citation-resolver trust zone. (Note: PR #394's auto-discovery selection policy has a known operational issue tracked at issue #402 — sibling worktrees can win over cwd for master-HEAD dispatches.)

### Fixed

- **HTTP MCP transport — per-connection McpServer** (PR #407, closes #405, reported by @GravyaDev / Kloud AI assistant). The HTTP MCP daemon at `apps/cli/src/mcp-server-sdk.ts:973` constructed a single `McpServer` at module load and called `server.connect(transport)` on it per inbound HTTP session. The MCP SDK refuses a second `.connect()` on the same instance, so the daemon crashed on the first inbound MCP request with `Error: Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.` Downstream observable as `ECONNRESET` on the client. Stdio transport was unaffected (one process per session). Fix: factor `createMcpServer()` wrapping construction + all 23 `server.tool(...)` registrations; stdio `main()` calls it once; HTTP path calls it per session and tracks the instance in `httpMcpSessions` for explicit `entry.server.close()` on all teardown paths (`transport.onclose`, idle-evict timer, explicit `DELETE`). Closure-capture audit confirmed 0 references to the outer `server` identifier inside any tool handler. Regression test at `tests/cli/http-mcp-second-connect.test.ts` exercises the two-instance contract + locks the SDK invariant via a same-instance double-`connect()` sentinel. Smoke-tested end-to-end. Side fix: `GOSSIPCAT_MCP_NO_MAIN` env gate lets jest import the module without binding stdio.

- **Memory-index prototype-key collision crashes `gossip_remember(_project)`** (PR #408, reported by audit-team Claude Code orchestrator). `gossip_remember(agent_id: '_project', query: ...)` threw `TypeError: Cannot read properties of undefined (reading 'push')` whenever the shared auto-memory corpus contained the token `"constructor"` (or any `Object.prototype` member name reachable by the tokenizer). Root cause: `buildPostings` at `packages/orchestrator/src/memory-index-sidecar.ts:307` used `postings = {}` — a plain object inheriting `Object.prototype`. For `term === 'constructor'`, `postings[term]` returned `Object.prototype.constructor` (truthy), the init branch was skipped, and `.docs.push(filename)` crashed on the undefined `docs` property. Silent secondary impact: corrupted the global `Object` function with a `df` property on first failing call. Fix: `Object.create(null)` at every term/filename/token-keyed map — `buildPostings`, `buildFullIndex.docs`, `incrementalRebuild.newDocs`, `buildDocEntry.terms`. Plus new `reseatPrototypelessMaps` in `tryLoadIndex` to rewrap maps after `JSON.parse` (which always returns prototype-bearing objects). 5 regression tests cover the write path, the read path, the JSON round-trip, and the black-box `MemorySearcher.search('_project', ...)` repro. Per-agent queries were never affected (they don't route through `searchCorpus`). Severity: medium-high for users with audit/engineering markdown notes — `constructor` is extremely common in Solidity/Rust/JS auditing memory.

- **Gemini `MALFORMED_FUNCTION_CALL` retry-once + `transport_failure` operational signal** (PR #396). Worker-agent loop now retries a Gemini turn once on `MALFORMED_FUNCTION_CALL` finish reason before surfacing the failure. New `transport_failure` operational signal (regex tightened — provider token required) tracks pipeline degradation distinct from agent capability. `format_compliance` suppression added on placeholder-only responses so a transport blip doesn't depress an agent's compliance score. Consensus `c520ef0b-88114e21` caught 2 NEW bugs in implementer output (fixed in fixup `3db1f94`). 5/5 tests + 8/8 drift + clean build.

- **CLI bootstrap-hook trim — mtime-keyed sentinel suppression** (PR #395). PPID-based sentinel was fragile across `/mcp` reconnect (`mcp-server-sdk.ts:4745-4747` regenerates bootstrap on reconnect, changing the parent process). Switched to mtime-keyed sentinel that survives reconnect. Distribution via `gossipcat hook --run` subcommand (not `$(npm root)` lookup). Spec at `docs/specs/2026-05-07-bootstrap-hook-trim.md`.

- **Test backfill: 4 deferred test gaps from consensus `8f74076f-e2dc4bb7`** (PR #400, closes #399). `f5` crash-recovery integration test (dispatch elided → plant orphan → `restoreNativeTaskMap` → orphan pruned, tracked survives), `f6` atomic-write failure path (`renameSync` mocked to throw, assert no `.tmp` / no partial target / seed survives), `f7` concurrent same-taskId writes (`Promise.all` of 5 writes resolves, no `.tmp` leak, final body matches one input), `f8` tightened eviction `>=1` → exact `2` with explicit eldest-first ordering assertion.

### Known issues

- **Issue #401:** `consensus-engine.ts:1493-1496` and `:1550-1553` emit a false-positive `via="⚠ resolved against project root, NOT worktree"` warning when worktrees are nested inside projectRoot (e.g. `.claude/worktrees/agent-X`). The priority resolver returns the correct worktree path; the post-resolution check incorrectly flags it. Diagnosis verified by consensus `71493829-1261487e:sonnet-reviewer:f7`. Fix sketch in the issue body — adds `!isInsideAnyRoot(filePath, [...currentWorktreeRoots])` predicate and extracts an `isResolvedFromProjectRootOnly` helper.

- **Issue #402:** Consensus auto-discovery sends gemini relay workers to a sibling worktree (`/Users/.../gossip-<branch>`) instead of cwd when dispatching against master HEAD without explicit `resolutionRoots`. Reviewers then read stale code and produce findings against the wrong codebase. Same failure mode as `feedback_cross_review_resolution_roots.md` but with the opposite direction (operator didn't pass roots; auto-discovery silently picked a wrong one). Fix scope: guard `assignRoot` to default to cwd when no explicit roots are passed, OR match worktree to task via branch hint.

## [0.4.25] — 2026-05-14

Passed-skill drift detector + signal-aggregate sidecar hardening. `passed` is no longer a permanent verdict — graduated skills are continuously re-tested on fresh N=80 windows and demoted when they regress. Two prerequisite fixes landed alongside (sidecar straddle fallback, SkillFrontmatter extension) plus a same-ms mtime race patch in `performance-reader.ts` (sibling of PR #372). HANDBOOK invariant #11 documents the new state machine for fresh users. No breaking schema migration for existing users — v3 backfills cleanly with `passed_at = bound_at` and an optional `passed_baseline_rate`.

### Added

- **Passed-skill drift detector** (PR #381). `status: 'passed'` is no longer a terminal verdict. The detector at `packages/orchestrator/src/check-effectiveness.ts:resolvePassedDrift` runs a Wilson lower-bound test on every fresh N=80 post-graduation window against `passed_baseline_rate`. Two consecutive failing windows (K=2) demote the skill to `inconclusive` with `regressed_from_passed_at` stamped; a subsequent fresh-window failure fast-paths to `silent_skill`. `SkillSnapshot` gains six new optional fields: `passed_at`, `passed_baseline_rate`, `passed_backfilled`, `regressed_from_passed_at`, `drift_strikes`, `drift_strike_at`. The skill-loader at `packages/orchestrator/src/skill-loader.ts:191-200` quarantines drift-demoted skills (`inconclusive` + `regressed_from_passed_at != null`) from dispatch injection. The cooldown gate at `packages/orchestrator/src/skill-freshness.ts:computeCooldown` hard-blocks `gossip_skills(action: 'develop')` while a skill is drift-demoted. v3 schema migration in `packages/orchestrator/src/skill-engine.ts` backfills `passed_at = bound_at` and reconstructs `passed_baseline_rate` from the most recent N=80 reachable signals (or leaves it undefined → drift detection PAUSED for fresh installs and low-volume agents). Fresh-install / backfilled skills additionally test against a 0.75 floor on their first drift window (`HYBRID_BACKFILL_FLOOR`) — demote if either baseline fails — to prevent re-anchoring at an already-degraded rate. The K=2 windows are independent via `drift_strike_at` rotation (strike-1 stamps it; strike-2 anchors there). 23 new tests across `tests/orchestrator/drift-detection.test.ts`, `tests/orchestrator/drift-detection-migration.test.ts`, plus a `tests/cli/mcp-skills-develop-throttle.test.ts` hard-block case. Spec: `docs/specs/2026-05-13-passed-skill-drift-detection.md`. Consensus rounds: `5058d7b0-7eec4aca` (design), `05bbbf4c-fd4c4c89` (spec self-review caught 3 bugs pre-impl), `2d824890-82354657` (PR review — caught K=2 window non-rotation gap, fixed in 9d72fe2). HANDBOOK invariant #11 added.

- **`SkillFrontmatter.regressed_from_passed_at`** (PR #380). Optional ISO-8601 timestamp parsed at `packages/orchestrator/src/skill-parser.ts:47-78`. Set when the drift detector demotes a `passed` skill to `inconclusive`; absent for organically-inconclusive skills. Prerequisite for the skill-loader quarantine clause in PR #381. The flat key-value scanner already extracted the field — only the typed interface and return statement needed extension. Required by consensus `05bbbf4c-fd4c4c89:sonnet-reviewer:f7` (the spec's quarantine filter was a structural no-op until the parser surfaced the field).

### Fixed

- **Sidecar `readCountersSince` falls back to raw on bucket-straddle queries.** When a sidecar bucket received signals both before and after `sinceMs` (a "straddle"), the previous bucket-level `lastUpdateMs >= sinceMs` filter summed the entire bucket — including pre-`sinceMs` signals — because the aggregate doesn't preserve per-signal timestamps. `readCountersSince` at `packages/orchestrator/src/signal-aggregate-index.ts` now returns `null` when any candidate bucket has `boundAtMs < sinceMs <= lastUpdateMs`, and `getCountersSince` at `performance-reader.ts` treats the null as a fall-through signal to the raw per-signal jsonl scan (which has the correct `ts < sinceMs` filter). Phase B perf is preserved for the dominant case — effectiveness checks where `sinceMs = bound_at` aligns with a bucket key. **Breaking type change for direct importers:** `readAggregateCountersSince` (re-exported from `packages/orchestrator/src/index.ts`) now returns `{correct, hallucinated} | null`. No in-repo consumers besides the orchestrator's own `getCountersSince`, but downstream type-importers may need to handle the null case. Required prerequisite for the upcoming passed-skill drift detector (`docs/specs/2026-05-13-passed-skill-drift-detection.md`); without it the K=2 Wilson guarantee biases toward false negatives. Consensus `c081db30-57ac4bb7` (gemini-reviewer + sonnet-reviewer): 3 confirmed, 3 disputed-and-resolved.

- **Signal log readers walk rotated `.jsonl.1`** (PR #367). All 14 readers of `.gossip/agent-performance.jsonl` migrated to a new `readJsonlWithRotated` helper so historical signal evidence stops being invisible the moment the live `.jsonl` rotates. Phase A of the rotation-data-loss fix.

### Added

- **Signal-aggregate sidecar — Phase B of the rotation fix** (PR #371). New `.gossip/signal-aggregate-index.json` derived state at `packages/orchestrator/src/signal-aggregate-index.ts` (386 LOC). Write-time fold-in after each `appendSignal`/`appendSignals` via tmp-write + `renameSync`; reader fast-path through `getCountersSince` consults the sidecar first and falls back to raw scan on staleness (`liveMtime > lastRawTimestampMs + 1`) or missing file. Bound-at consistency preserved across write + rebuild paths via stamped `_aggregate_bound_at_ms` on each row. Crash-consistent: if the process dies between jsonl append and sidecar write, the next reader detects via mtime and rebuilds from `readJsonlWithRotated`. 23 new tests cover schema, concurrent rebuild, retraction propagation, rotation mid-scan, and 5 crash scenarios. Consensus `bafd8bbb-99944c8b` (gemini-reviewer + sonnet-reviewer, 4 confirmed, 1 disputed, 6 unique) — three medium follow-ups filed as separate backlog items (tamper-validation, bucket compaction, in-reader cache).

- **Editorial theme contrast — v2 palette** (PR #368). The cream/ink editorial theme was failing WCAG AA on `--color-text-dim` (2.75:1 on background), `--color-unverified` (2.81:1), and `--color-severity-high` (~4.31:1 on card). v2 darkens the muted family as a unit, swaps `--color-chart` to deep teal `#1E4D52` to escape the amber collision with `--color-unverified`, and resyncs `--color-border`/`--color-input` with the new `--color-accent`. Body text now lands ~6:1 on card, all semantic tokens pass AA. CSS-only, 10/10 token swaps in `packages/dashboard-v2/src/globals.css`.

- **`wilson-score.ts` header tells the truth** (PR #365). The file header described a legacy z-test as the live skill-graduation path; the verdict path actually walks Wilson-score intervals. Header rewritten; the z-test is correctly framed as diagnostic-only.

- **Cross-review anchor resolver honors `resolutionRoots`** (PR #365). `<anchor>` blocks in cross-reviewer prompts now resolve against the configured `resolutionRoots` paths (e.g. git worktrees) before falling back to project root. When the fallback fires, the anchor is annotated `via="⚠ resolved against project root, NOT worktree"` so reviewers know the citation is suspect. Closes a class of false-absence findings noted in PR #364's consensus round.

- **PR #364/#365 follow-up cluster** (PR #366, commit 724f583). Loose ends from the BM25 sidecar + resolutionRoots work: `loadIndex` file-lock gap, latent open-boost bug for typeless frontmatter, frontmatter parser deduplication, plus the `corpusDir` leading-dash comment correction.

- **`--color-insight` consumers wired to the token** (PR #369). `FindingDetailDrawer` had mapped insight findings to `text-muted-foreground`, and `FindingsMetrics` hardcoded `text-zinc-500` for the insight filter chip — so `--color-insight` was defined in both themes but never reached the UI. Both consumers now reference `text-insight`/`bg-insight`/`border-insight`. Closes the orphan flagged in PR #368's cross-review.

- **Impact-adjacency gate fires on PR `edited`** (PR #370). The gate workflow used the default `pull_request` activity types (`opened`/`synchronize`/`reopened`), so adding `consensus-id: <hex>-<hex>` to a PR body after open didn't trigger a re-run. `gh run rerun` replayed the original event payload (frozen at open-time), so the gate failed identically. Adding `edited` to the activity types makes body edits re-fire the gate against the current body. PR #367 hit this twice before the bug was diagnosed.

### Notes

- Consensus round `532d78b3-d5174b9b` validated the editorial v2 palette via `sonnet-designer × sonnet-reviewer × gemini-reviewer` cross-review. Three `hallucination_caught` signals recorded against `gemini-reviewer` for arithmetic errors in contrast-ratio computations (~1.0 off on multiple findings). Five real structural issues in v1 (border/input desync, scrollbar RGB literal, orphaned insight token, chart/unverified amber collision, text-dim/muted step collapse) were caught by `sonnet-reviewer` and folded into v2.
- The Phase A rotation fix is read-side only; the underlying single-slot `.jsonl.1` rotation in `performance-writer.ts` is still destructive across multiple rotations. Phase B will add a derived aggregate sidecar matching the existing `skill-index.json` / `task-graph-index.json` pattern so scoring inputs survive rotation regardless of raw-row retention.

## [0.4.24] — 2026-05-08

BM25 memory-search wiring + hono CVE override. Closes the follow-up deferred from v0.4.23 (PR #360 shipped the sidecar; this release wires it into the query path). No breaking changes for non-`_project` agent IDs; `_project` semantics shift from per-project `.gossip/agents/_project/memory/` to the public auto-memory corpus at `~/.claude/projects/<encoded>/memory/` (the documented intent — orchestrator's cross-session memory pool).

### Added

- **`MemorySearcher.searchCorpus()`** (PR #364). Routes `agent_id="_project"` through the BM25 sidecar built in #360: `tokenize` → `loadIndex` (lazy mtime-keyed incremental rebuild) → `rankDocuments` → `SearchResult` projection. Per-agent knowledge-file path unchanged for non-`_project` queries. 3 new tests cover ranking, empty-result, and lazy-rebuild trigger; full test suite 229/229 green.

### Fixed

- **hono CVE override** (PR #364). Bumps transitive `hono` from 4.12.14 → 4.12.18 via `overrides.hono: ">=4.12.16 <5"` to patch [GHSA-69xw-7hcm-h432](https://github.com/advisories/GHSA-69xw-7hcm-h432) (jsx HTML injection) and [GHSA-9vqf-7f2p-gf9v](https://github.com/advisories/GHSA-9vqf-7f2p-gf9v) (`bodyLimit()` bypass for chunked / unknown-length requests). Reaches via `@modelcontextprotocol/sdk@1.27.1` → `@hono/node-server`. Mirrors the ip-address override pattern from #361.

### Changed

- **`_project` is now the public-memory sentinel.** `gossip_remember(agent_id: "_project", query: ...)` now searches the auto-memory corpus at `~/.claude/projects/<encoded-cwd>/memory/` (where `MEMORY.md` and the project_*/feedback_*/user_* memories live), not the per-project `.gossip/agents/_project/memory/` directory. The legacy per-project directory is no longer reachable via this sentinel; if you were relying on it, use a non-reserved agent_id instead.

### Notes

- Consensus round `2ae7bea8-d0f445f2` validated the change via gemini-reviewer + sonnet-reviewer cross-review (4 confirmed, 2 disputed-and-rejected, 5 hallucinations caught and signaled). 4 follow-up findings recorded for future PRs (loadIndex file-lock gap, corpusDir doc accuracy, latent open-boost bug for typeless frontmatter, frontmatter parser duplication).
- New backlog memory `project_consensus_anchor_resolutionroots_gap.md` documents a discovered gossipcat bug: cross-review prompt `<anchor>` blocks are resolved against `project_root` (master HEAD), not against `resolutionRoots` paths, which caused 3 false-absence findings on this PR before orchestrator manual verification.
- New trust_boundaries skill bound to `sonnet-reviewer` (`trust-boundaries-anchor-and-branch-verification`) targets the absence-claim hallucination cluster surfaced by this consensus round.

## [0.4.23] — 2026-05-05

Skill-graduation lifecycle fix + signal pipeline integrity + dashboard visual/IA pass + new CI gates. Bundles ~50 merged PRs since v0.4.22. Headline fix is **PR #353** (the v0.4.22 skill runner fix turned out to be structurally bypassed on the production-common code path; this release closes both root causes). No breaking changes; existing `.gossip/` state is fully forward-compatible.

### Fixed

- **Skill graduation runner now actually fires AND survives shutdown** (PR #353). Two distinct root causes diagnosed via 3-agent consensus 4bd62d6c-46fd4e55 and re-verified by 66bf72b1-2e5046fa: (a) `gossip_collect`'s two-phase consensus path returns early at `collect.ts:746` BEFORE reaching the v0.4.22 `setImmediate` registration at line 1179 — every consensus round with native cross-reviewers (the production-common path) silently skipped graduation; (b) even on single-phase rounds where the runner WAS registered, the SIGTERM handler at `mcp-server-sdk.ts:352` called `process.exit(0)` synchronously, tearing down the event loop before the detached `setImmediate` callback could settle. Fix: extract `scheduleSkillRunner` and call it from BOTH the early-return site AND the post-consensus tail; new `apps/cli/src/shutdown.ts` exports `shutdownOnSignal` that runs `drainLifecycleTasks → eviction.stop → relay.stop → cleanupPid → exit` in strict order. New `.gossip/skill-runner-health.json` heartbeat (atomic write) surfaced in `gossip_status` output.

- **`AgentScore.totalSignals` vs `scoringSignals` split** (PR #349). `totalSignals` was incrementing on every recorded signal regardless of category, inflating Rule A/B confidence and Rule C scores when non-scoring signals (e.g. `format_compliance`, `task_completed`) accumulated. Fix: `scoringSignals` counts only the 6-signal scoring subset; `totalSignals` preserved for dashboard display. Required 3 CI iterations to catch all `AgentScore` literal sites in relay + tests (memory: `feedback_agent_score_consumers.md`).

- **`VALID_CONSENSUS_SIGNALS` allowlist drift detector** (PR #350). Bidirectional drift test (8 assertions) asserts every PERFORMANCE/OPERATIONAL signal name member is in some `VALID_*` set; empirically verified catches the PR #329-class regression where a new signal type slipped past the allowlist.

- **`ref-allowlist` detector handles squash-merged PRs** (PR #348). Detector used `git log --merges` which excluded squash commits (single-parent). Dropped the `--merges` filter, added regression test, retracted 3 historical false-positive signals.

- **`transport_failure` signal class for relay-worker resolutionRoots gap** (PRs #327, #328, #329). Path A: detector emits `transport_failure` when relay-worker tool calls drop `resolutionRoots`. Path B: plumbed `resolutionRoots` through `runOneRelayCrossReview`. Plus Option B warning when worker drops the field, registered in the allowlist with regression coverage.

- **Round-counter atomic flush + remainder tracking** (PRs #309, #312). `f2` and follow-on race: when in-memory fallback flushed to disk after FS recovery, the flushed delta could be double-counted or lost on partial-flush interleavings. Fix: atomic flush with explicit remainder accounting.

- **`findFile` symlink-TOCTOU close** (PR #308). `realpathSync` canonicalization before any membership check; closes a narrow attack window where a symlink could be swapped between `lstat` and `read`.

- **Resolver line-anchored staleness behind a config flag** (PR #310). When `resolver.lineAnchored: true`, citations whose anchor line no longer contains the cited symbol are flagged stale; opt-in to avoid changing default behavior.

- **`gossip_update` env scrub** (PR #317). `GOSSIPCAT_*` env vars are now scrubbed from `execSync` calls inside `gossip_update` to prevent leaking session-scoped secrets into the upgrade subprocess. Test hardened from consensus 591af14b (PR #318).

- **Insight-filter for open-findings count + agent prompt context** (commit 1d4677a). `type:insight` findings no longer pollute the actionable-findings count or the next-round prompt context. Test cases extracted to a non-excluded suite (PR #313).

### Added

- **Impact-adjacency CI consensus gate** (PRs #314, #315). New `.github/workflows/impact-adjacency-gate.yml` runs on every PR, requires consensus when the diff touches files with `// @gossip:impact-adjacent:<category>` magic comments. Hardened base-ref + consensus-id regex (PR #315).

- **`ref-allowlist` Phase 1 detector** (PR #316). Detects direct master push by write-mode agents (the 2026-04-28 sonnet-implementer incident class).

- **Curated eval-suite harness + 5 seed cases** (PR #326). Foundation for paired-before/after skill-effectiveness measurement at small N (McNemar's test) — a workaround for the slow-by-design MIN_EVIDENCE=80 graduation timeline.

- **Dashboard `/overview` calm landing route + `?expert=1` toggle** (PR #351). Parallel simple view at `/overview` for first-time visitors and returning operators answering "what is gossipcat / is it healthy / where do I look first" in 5 seconds. Dense `/Dashboard` view preserved byte-identical behind `?expert=1` per iron-law constraint.

- **Dashboard ref-allowlist violations API + UI** (PRs #324, #325). Card on overview, dedicated page, signal-label rendering.

### Changed

- **Dashboard visual/IA polish series** — ~20 small PRs (#320-#347) shipping the post-empathy-pass visual cleanup: actionable BigStat (#334), filter rail conditional render on empty (#347), tri-stat agents widget (#321), real task-completion rate replaces composite-score reliability (#346), Reliability bar on canonical-4 AgentCardBig (#345), 8-item tooltip pass + a11y (#333), in-app glossary modal + "?" icon (#331), naming alignment + stale banner (#332), 5 quick-win copy changes (#330), CSS-craft body font-family swap (#341), tabular-nums + badge polish (#340), cross-lens fix bundle (#342), Team metric schema alignment (#343), AgentPage section reorder (#338), task-row type chip (#337), Signals filter rail de-emphasis on pre-filtered URL (#339), 10 design-QA fixes (#320), 10 route-audit fixes (#322), tri-stat overflow regression fix (#323).

- **README opening rewritten for promotion** (PR #319). Above-the-fold content sharpened.

### Notes for fresh installs

- The skill graduation loop now self-reports liveness via `.gossip/skill-runner-health.json`, surfaced in `gossip_status`. Fresh installs see `Skill graduation: never run since session start (expected after first gossip_collect)` — concrete liveness signal without log spam. After the first `gossip_collect`, the heartbeat updates with `last_run_at`, `last_run_duration_ms`, `skills_evaluated`, `transitions {passed, failed, flagged_for_manual_review, inconclusive, pending}`, and `last_error`.

- `SAFE_NAME` regex change at `check-effectiveness-runner.ts` allows dotted model IDs (`gemini-1.5-pro`) but rejects `..` substrings via negative lookahead — same as v0.4.22, repeated here for completeness.

- The HANDBOOK still cites `MIN_EVIDENCE=120` in invariant #2; source-of-truth is `MIN_EVIDENCE=80` at `packages/orchestrator/src/check-effectiveness.ts:19`. The HANDBOOK doc is stale on this point. Trust the source.

## [0.4.22] — 2026-04-28

Skill-graduation runtime fix. Bundles three PRs (#305, #306, #307) that together close the end-to-end skill-effectiveness loop: structural blockers in `SkillEngine`, the one-sample Wilson math for sparse baselines, and the runtime detach so the runner actually fires after consensus rounds. No breaking changes.

### Fixed

- **Skill effectiveness runner now actually runs after consensus** (PR #307). `runCheckEffectivenessForAllSkills` was awaited at the tail of `gossip_collect`, and the relay process was being SIGTERM'd within milliseconds of synthesis (12-min disconnect cycle). Across 9 consensus rounds in a diagnosis session: zero invocations, zero graduations — even with skills that mathematically should have passed. Fix: detach via `setImmediate(async () => { ... })` so the runner survives the MCP response close and runs on the next event-loop tick. Closure captures `skillEngine`, `mainAgent`, `registryGet`, `projectRoot` in the outer scope for stability across the boundary.

- **Path-traversal hardening on the runner** (PR #307). `agentId` and skill-file `category` come from `readdirSync` and were used directly in `join()` and downstream calls. Added `SAFE_NAME` regex `/^(?!.*\.\.)[a-zA-Z0-9._-]+$/` — allows dotted model IDs (`gemini-1.5-pro`, `claude-3.5-sonnet`) but rejects any `..` substring via negative lookahead. Skip `_*` synthetic dirs (e.g. `_project`) early.

- **One-sample Wilson for sparse baselines** (PR #306, also released as 0.4.21 hot-path). Skills with zero or near-zero baseline signals now use a one-sample Wilson lower-bound test against the agent's lifetime accuracy prior, instead of the two-sample CI-overlap test that requires both samples to be populated. Cap one-sample prior at 0.95 and pin alpha to the sparse-current side. Skills that previously sat at `pending` indefinitely with bt < 20 can now graduate.

- **Five structural blockers in `SkillEngine`** (PR #305). Removed defensive guards and ordering issues that prevented graduation: `bound_at` reset on touch, `verdict.shouldUpdate` filter inversion, premature `migrationCount` increment, snapshot drift between read and write, and the silent-skill bucket leaking into `passed` candidates.

## [0.4.21] — 2026-04-27

Open-findings auto-resolver. PR #299 + several follow-ups (#300–#303). Walks open findings and auto-resolves any whose cited code has been fixed (file-scoped grep, comment-stripped, multi-cite AND, structural `type:insight` exclusion). Hash-chained audit log at `.gossip/finding-resolutions.jsonl`. New `gossip_resolve_findings` MCP tool. No breaking changes.

## [0.4.20] — 2026-04-25

Hardening + utility-task observability release. Bundles ten merged PRs (#251–#258, #260, #261) covering postinstall robustness, the skill-develop learning-loop fallback path, periodic eviction scheduling, and dashboard visibility for the RL learning loop. No breaking changes.

### Fixed

- **Utility-task results survive 2h TTL eviction** (PR #254). `gossip_skills(action: "develop")` re-entry reads the agent's relayed result from `nativeResultMap`, but `evictStaleNativeTasks()` swept entries older than `NATIVE_TASK_TTL_MS = 2h` on every relay. When the dispatch → relay → re-entry chain spans >2h (routine for human-in-loop skill development), the result was evicted before re-entry — the fallback then produced a template-shaped skill instead of the freshly-relayed agent-specific content, silently degrading the contextual-RL learning loop. Fix: separate `nativeUtilityResultMap` with a 24h TTL, branched relay write for `utilityType === 'skill_develop'`, re-entry checks utility map first with `??` fallback to legacy entries.

- **Periodic eviction scheduler so quiet processes prune** (PR #257). Post-hoc consensus on PR #254 caught a HIGH finding: `evictStaleNativeTasks` only fires on relay/dispatch traffic. A quiet MCP process that dispatched a utility task, had the agent crash before relay, and received no further traffic would never prune the entry — pinning it for process lifetime, not the 24h TTL the code reads as enforcing. Fix: `scheduleNativeTaskEviction` runs eviction on a 1h `setInterval`, `.unref()`'d so it doesn't block clean process exit, registered in `doBoot()` before SIGTERM/SIGINT handlers (closes the narrow race where a signal between handler registration and timer assignment would `clearInterval(undefined)`).

- **`.mcp.json` postinstall merges existing entries** (PR #256). The previous postinstall path overwrote any user-defined MCP server entries when refreshing the gossipcat block. Fix: read existing `.mcp.json`, spread its servers, then refresh only the `gossipcat` key. Preserves user-defined servers across upgrade.

- **Postinstall staleness bypass + workspace walk-up regression** (PR #251). Two regressions from prior install paths fixed: a staleness check that wrongly fast-pathed past needed regeneration, and a walk-up loop that escaped workspace boundaries when the postinstall ran from a nested directory.

- **Postinstall FATAL error includes recovery instructions** (PR #252). When the postinstall script hits a fatal error, the message now tells the user what to run to recover instead of leaving them at a stack trace.

- **`findFile` recursion depth cap** (PR #253). `consensus-engine.ts:findFile` (the citation-resolver helper used by cross-reviewers) recursed without depth bound. A pathologically nested directory could exhaust the stack. Fix: cap recursion at a small constant; tests verify the cap fires correctly.

- **Skill-freshness frontmatter quote-strip** (PR #255). Commit `8164472` (PR #249) fixed quote-stripping for `skill-parser.ts:parseSkillFrontmatter`, but the parallel loader path in `skill-freshness.ts:extractFrontmatterField` drifted — `status: "pending"` in YAML surfaced as the literal 9-character string `"pending"` (with quote chars), failed `coerceStatus`'s enum check, and emitted `[gossipcat] skill-engine: invalid status "\"pending\"" remapped to pending` on every skill read. Fix: mirror the quote-stripping in the freshness loader path. Both `"..."` and `'...'` covered.

- **Dashboard surfaces `skill_develop` learning loop without phantom-agent pollution** (PR #260). `gossip_skills(action: "develop")` was invisible in the dashboard activity feed: the dispatch site at `mcp-server-sdk.ts:3286` registered the task in `nativeTaskMap` but never called `recordNativeTask`, so `task-graph.jsonl` had no `task.created` event for the utility — meanwhile `recordNativeTaskCompleted` wrote `task.completed` unconditionally, producing an orphan completion the dashboard reader silently dropped. Users saw nothing in the UI when a skill was being developed, despite the RL learning loop being a headline feature. Consensus round `067d01e2-beba4cc2` flipped the originally-proposed gate-the-completion fix, finding it would undo the intentional CLI/Supabase visibility comment at `native-tasks.ts:395`. Fix instead: add the missing `recordNativeTask` call at dispatch (closes the orphan at source), pass an informative result string at completion, and introduce a shared `isUtilityAgent` filter applied to four task-graph readers (`api-tasks`, `api-agents`, `api-overview`, `api-active-tasks`) so the `_utility` pseudo-agent doesn't pollute agent stats / token aggregates / hourly activity buckets.

- **Utility-task duration label clarified as "since dispatch"** (PR #261). `[gossipcat] ✅ utility ← skill_develop [id] OK (Ns)` reported wall-clock since dispatch, not agent execution time, since utility tasks don't pass `agentStartedAt` to `gossip_relay`. Observed 2026-04-24: a 12-second `Agent()` dispatch logged `OK (7637.1s)` because the orchestrator delayed the relay call by ~2h. Both numbers were correct — they measure different things — but the bare seconds suffix invited the assumption that this was agent runtime. Relabel to `"Ns since dispatch"` plus a 3-line comment explaining the semantics. No behavior change.

### Changed

- **Operator handbook adds "When to gate merges on consensus — impact-adjacency, not just LOC"** (PR #258). New section in `docs/HANDBOOK.md`, inlined into every orchestrator's bootstrap via `gossip_status()`, codifying the rule that consensus rounds should fire on six impact-adjacent change classes (shared in-memory state lifecycle, background cleanup / TTL / timer logic, serialization at persistence boundaries, authN/Z, signal/event pipelines, install/bootstrap paths) regardless of diff size. Replaces the prior LOC-only gate. Categories are codebase-agnostic so the rule applies to web apps, APIs, and data pipelines using gossipcat — not just gossipcat's own internals. Sourced from a 2-agent consensus reviewing real merged-without-consensus cases (#254, #256) where post-hoc rounds caught HIGH findings on already-shipped code.

## [0.4.19] — 2026-04-22

Hardening release for the Stage 2 premise-verification pipeline (PRs #241/#242/#243). A 2-agent consensus audit on the merged range surfaced three HIGH-severity findings; this release ships the fixes plus one skill-prompt correction and one skill-parser noise fix. All changes ride on top of the existing `modality` signal wiring, which audit confirmed correct.

### Fixed

- **Claim-verifier path containment + input length caps** (PR #244). Three HIGH findings from consensus round `1879db26-7e6a4074` on the Stage 2 verifier: `runRg` and `verifyFileLine` in `packages/orchestrator/src/claim-verifier.ts:71,193` were calling `resolve(projectRoot, agentInput)` with only an `existsSync` gate. `path.resolve('/proj', '/etc/shadow')` returns `/etc/shadow`, so an agent-supplied absolute `path`/`scope` bypassed the project root entirely; relative `../../` escapes were uncaught; and `symbol`/`scope`/`expected_symbol` in `packages/orchestrator/src/claim-types.ts` validated non-empty but had no upper length bound, letting a megabyte-long regex pattern CPU-blow `rg` before the 500ms wall-clock fires. Fix: new `containWithinProject(projectRoot, input)` helper resolves lexically, collapses symlinks via `realpathSync` on both target and root (handles macOS `/var → /private/var`), prefix-compares, fails safely to `null` without leaking the attempted input into verdict reasons. Plus `MAX_CLAIM_STRING_CHARS = 256` and `MAX_PATH_CHARS = 1024` across all 5 claim types; oversize claims rejected via schema-lint. 8 new tests covering absolute-scope, `../../`-scope, absolute-path, symlink-escape, and 4 length-cap cases.

- **Agent-controlled string surfaces sanitized before log + prompt interpolation** (PR #246). Two MEDIUM findings from the same consensus round: exception messages in `claim-verifier.ts:391` (`reason: verifier_error: ${e.message}`) flowed into `formatFalsifiedNote` at `apps/cli/src/handlers/dispatch.ts`, which prepends the text verbatim to the next agent's task prompt — a prompt-injection surface. Separately, `unknown_type: ${t}` at `claim-types.ts:270` interpolated the agent-supplied `type` field (unbounded, control-char-permitted) into stderr + the `schema_lint` JSONL row. Fix: new `packages/orchestrator/src/_sanitize.ts` `sanitizeForLog(raw, maxChars=200)` — replaces control chars (U+0000–U+001F, U+007F) except `\t`/`\n` with U+FFFD, truncates with trailing `…`. Applied at 5 sites (verifier reason, schema-lint message, `schema_lint` JSONL field, stderr write, the `note` prepended to `annotatedTask`). Exported from the orchestrator barrel. 7 new tests.

- **Gemini MALFORMED_FUNCTION_CALL dropouts now surface in round-level coverage tracking** (PR #247). `consensus-engine.ts:2684` detected 0-char dropouts via `r.result.trim().length === 0` for `coverageDegraded` + the `consensus_coverage_degraded` signal — but Gemini's MALFORMED responses come back as a non-empty sentinel string (`[No response from Gemini: malformed_function_call finishReason=...]`), so round-level tracking missed them. Per-task detection at `collect.ts:178` already caught the sentinel via substring match; the gap was only at round level — no ⚠ warning in the summary when Gemini silently drops out of a 3-agent round. Fix: mirrored collect.ts's `includes('[No response from')` check in the round-level filter so both surfaces stay consistent. 1 new test using the real sentinel string.

- **Skill-parser strips surrounding quotes from frontmatter scalar values** (PR #249). Two parsers read the same skill-file frontmatter — `skill-engine.ts:parseSkillFile:924` strips surrounding `"..."` correctly, but `skill-parser.ts:parseSkillFrontmatter:60` stored values verbatim. Gemini-* agent skills written by an older path had `status: "pending"` (quoted); every load via the loader path fired `[gossipcat] skill-engine: invalid status "\"pending\"" remapped to pending` at stderr. `coerceStatus` kept things working via fallback, just noisily. Fix: mirror the quote-stripping from the engine path so `status: "pending"` and `status: pending` parse identically. Handles both `"..."` and `'...'`; inline-array detection for `keywords` is unaffected. 2 new parser tests.

### Changed

- **`emit-structured-claims` skill tightens anchor + compound guidance** (PR #248). Audit of 18 Gemini hallucinations in `.gossip/agent-performance.jsonl` (2026-04-02…2026-04-22) classified ~44% as anchor mismatches (wrong file:line), ~28% as INVERTED polarity flips, ~17% as COMPOUND bundling. A first-pass edit added a "Prose ↔ claim mirror" section promising a 3× penalty for skipping the claim block — but `dispatch.ts:212-213` early-returns with zero signals when no claim block is present, so no such penalty exists. Consensus round `46b92c21-362647ce` (sonnet + haiku, Phase 2 cross-review) converged on dropping the aspirational promise and scoping the skill to what the verifier actually does. Net change: two new sections — "Uncertain about a line number?" (fallback is `presence_of_symbol` scoped to the **specific file**, not a directory — directory scope would substitute wrong-file errors for wrong-line errors) and a realistic BAD/GOOD compound example (partial coverage, not a malformed-symbol joke). No runtime code changes; default-skills ship via `dist-mcp/default-skills/` to new installs on `npm i -g gossipcat@latest`.



Patch release shipping the `OUTPUT_DELIVERY_PROTOCOL` dispatch-prompt fix so sibling instances pick it up via `npm i -g gossipcat@latest`. No data-layer changes; prompt-only.

### Fixed

- **Subagent self-relay failure mode** (PR #219). A fresh-install session observed an `architect` native agent attempt to call `gossip_relay` itself, discover the tool isn't exposed to subagents, and burn 67K tokens + 36 tool uses flailing without returning findings. Root cause: the "orchestrator calls gossip_relay on your behalf" contract was only written in orchestrator-facing dispatch instructions, never in the agent prompt the subagent actually sees. Fix: every assembled dispatch prompt (native + relay, consensus + solo) now carries a priority-0 `OUTPUT_DELIVERY_PROTOCOL` block stating "emit findings as TEXT in your response; do NOT call gossip_relay, gossip_relay_cross_review, or any gossip_* tool yourself; stop when findings are written — don't try to 'submit' or 'finalize'." Kept as a separate constant so `FINDING_TAG_SCHEMA`'s byte size stays stable for the suffix-budget tests in `prompt-assembler.test.ts`. (`packages/orchestrator/src/finding-tag-schema.ts`, `packages/orchestrator/src/prompt-assembler.ts`)

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
