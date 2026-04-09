# Changelog

All notable changes to gossipcat are documented here. The format is loosely based on [Keep a Changelog](https://keepachangelog.com/) — entries describe user-visible behavior changes and migration impact, not every commit.

## [Unreleased]

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
