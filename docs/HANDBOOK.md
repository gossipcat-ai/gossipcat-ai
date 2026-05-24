# Gossipcat Handbook

This file is the operator's manual for gossipcat. It's **automatically loaded** by `gossip_status()` so every new Claude instance starts with the full context, not just the code. If you're reading this as a human, welcome — this is the "why" behind the "what."

**Who this is for:**
- **Orchestrator LLMs** (Claude Code, Cursor, any MCP client) starting a new session on a gossipcat project
- **New users** cloning the repo and wondering where to start
- **Contributors** trying to understand why the code is shaped the way it is

Keep this file under 500 lines. Curate, don't accumulate.

---

## What gossipcat is

Gossipcat is an MCP server that turns a single LLM client into a multi-agent review loop with measurable skill learning. It runs a portfolio of review agents — Claude Code subagents natively (zero API cost), plus relay workers for Gemini, OpenClaw, and any OpenAI-compatible endpoint — and coordinates them via consensus cross-review.

The core primitive is a **grounded reward signal**: every finding an agent produces must cite a real `file:line`, peers verify those citations against actual source code, and verified findings (or caught hallucinations) become signals that update per-agent competency scores. Low-scoring agents get targeted skill files generated from their own failure history.

It is, effectively, **in-context reinforcement learning at the prompt layer** — with reward signals grounded in source code rather than a judge model. No fine-tuning, no weights touched, no RLHF infrastructure. The "policy update" is a markdown file under `.gossip/agents/<id>/skills/`.

---

## Architectural invariants (decisions not to re-litigate)

These are load-bearing design choices. If you're tempted to change any of them, read the reasoning first — most of them were arrived at after a failed simpler version.

### 1. Grounded citation verification, not LLM-as-judge

Every finding must cite `file:line`. Peers verify the citation exists and says what the finding claims. **This is a mechanical check, not a subjective grade.** Reality has ground truth; taste does not. The moment we switched from "agents grade each other's quality" to "agents verify each other's citations against source," the feedback loop became orders of magnitude cleaner.

**Do not** add an LLM-as-judge layer to the consensus protocol. It will re-introduce the taste problem we removed.

### 2. `MIN_EVIDENCE = 80` is a real statistical gate, not a bug

The skill effectiveness z-test at `check-effectiveness.ts:15` requires ≥80 post-bind signals before issuing a `passed`/`failed` verdict. This is calibrated for statistical detection of a +10pp shift at p=0.75 baseline under Bonferroni α=0.025. Raising MIN_EVIDENCE to ~120 reaches ≈75.5% power; ~148 reaches ≥80% power if stronger guarantees are needed.

Skills will sit in `pending` for a long time. That is **correct behavior**, not a bug. If you see "stuck at pending" and your first instinct is to lower MIN_EVIDENCE, stop — lowering it weakens the statistical power claim that the whole effectiveness loop depends on. For paper evidence, build a curated eval suite with paired before/after testing (smaller N, McNemar's test, ~15 per category) instead.

See `check-effectiveness.ts:7-19` for the in-code comment documenting this, and prior consensus `9369ebfc-a3654b51 f5` for the decision history.

### 3. Category names are canonicalized via `normalizeSkillName` on BOTH read and write

Signal records in `.gossip/agent-performance.jsonl` use **underscore**-separated categories (`data_integrity`). Skill filenames on disk use **hyphen**-separated names (`data-integrity.md`) via `normalizeSkillName` at `skill-name.ts:6`. The comparison in `getCountersSince` normalizes both sides so either form matches.

**Do not** mutate signals on disk to change their canonical form. Normalization is read-time only. Future producers can write either form and it will still match.

### 4. The two-item content split for native dispatch

When the MCP server dispatches a task to a native Claude Code subagent, the response is split into **two content items**:
- Item 1: orchestrator instructions (task ID, relay token, re-call steps)
- Item 2: the agent prompt verbatim

The agent prompt in item 2 must see **nothing** about the surrounding orchestration — no task IDs, no relay tokens, no "call gossip_relay after you finish." Modern Sonnet treats token strings embedded in orchestration instructions as credential injection and issues a hard refusal (not confusion — a hard stop).

This is a **security boundary**, not a style preference. See prior session 2026-04-08 and consensus `ff598432`.

**Optional elision protocol (`prompt_format: 'elided'`).** All three dispatch tools — `gossip_dispatch`, `gossip_run`, `gossip_collect` — accept an opt-in `prompt_format` parameter. The default `'inline'` is byte-identical to the description above. When the caller passes `'elided'`:

- The server writes the prompt body to `.gossip/dispatch-prompts/<taskId>.txt` (atomic temp-rename, `SAFE_NAME`-validated taskId).
- Item 1 contains a marker line of the form `[skills section elided: see <abspath>, <N> bytes — READ this file and pass its CONTENTS verbatim as the Agent(prompt: ...) value. Do NOT pass the path string.]`.
- **Item 2 is OMITTED entirely** — no skeleton, no placeholder. The orchestrator MUST `Read(<abspath>)` and forward the file contents verbatim to `Agent(prompt: ...)`. A missing file is a hard failure; never substitute the marker text for the prompt.

The on-disk prompt file carries ONLY the agent-facing prompt (identity + instructions + skills + task). It NEVER carries `relay_token`, `task_id`, the `AGENT_PROMPT:` tag prefix, or any other orchestration metadata — those stay in Item 1 only. Persistence: the absolute path is stored alongside the task in `.gossip/native-tasks.json` so `/mcp` reconnect can prune orphan files for tasks that no longer exist. Eviction is mtime-based (default 1h) plus aggregate eldest-eviction at 100 MB.

Example flow inside the consensus protocol when `prompt_format: 'elided'` is passed to `gossip_collect`:

```
1. gossip_collect(task_ids: [...], consensus: true, prompt_format: 'elided')
2. → server writes .gossip/dispatch-prompts/<consensusId>__<agentId>.txt per cross-review participant
3. → returns ⚠️ EXECUTE NOW payload with one marker line per agent; PROMPTS section is ABSENT
4. → orchestrator Reads each cited file and passes contents verbatim to Agent(prompt: ...)
5. → gossip_relay_cross_review(consensus_id, agent_id, result) per agent
6. → gossip_collect(consensus: true) for final synthesized output
```

Spec: `docs/specs/2026-05-18-native-dispatch-skill-handle-pattern.md` (Option B — server-side prompt elision).

### 5. Scoped agents write files, orchestrator commits

Scoped write mode (`write_mode: "scoped"`) lets agents write files within a directory scope but **not** run `git commit` or `shell_exec` (except read-only git commands). The orchestrator validates the agent's output and commits on their behalf. Worktree agents have full git access within their isolated branch.

This is intentional. It keeps the commit authorship chain clean and prevents agents from shipping code before it's verified.

### 6. Effectiveness window anchors on `bound_at`, not "skill write time"

`SkillEngine.buildPrompt()` captures `bound_at` at prompt-generation time, not at file-write time. The baseline snapshot uses `getCountersSince(..., 0)` (lifetime anchor) while the delta uses `getCountersSince(..., bound_at)`. These are semantically different windows **by design**. Moving `bound_at` to save-time would not expand the post-bind window — it would only delay it.

If you see a review agent claiming a "timing order bug" here, it is fabricated. We verified this in consensus and auto-penalized the reviewer.

### 7. The reward loop reads `snapshot.status` back in `skill-loader.ts`

Skills with `status: 'failed'`, `status: 'silent_skill'`, or `status: 'inconclusive' && regressed_from_passed_at != null` (drift-demoted) are filtered out at `loadSkills()` injection time. Skills with `passed`, `pending`, `insufficient_evidence`, `flagged_for_manual_review`, or organically-inconclusive (no `regressed_from_passed_at`) are injected normally. This closes the RL loop — verdict → policy update — in a single place.

The drift-demoted clause was added with the drift detector (invariant #11). The condition is dual: `status === 'inconclusive'` AND `regressed_from_passed_at` present. Organic inconclusive (the standard "ran the evidence window without a confident verdict" state) still injects — only the "was passed, then regressed" state is quarantined.

**Do not** add a second filter site. Filtering is a read-only operation at load-for-injection time; frontmatter is never mutated.

### 8. `FINDING_TAG_SCHEMA` is the single source of truth — parsers are strict, prompts are explicit, drops are loud

The `<agent_finding>` tag contract lives in `packages/orchestrator/src/finding-tag-schema.ts`. Type MUST be one of `finding | suggestion | insight`. Any other value (e.g. `approval`, `concern`, `risk`, `recommendation`, `confirmed`) is silently dropped by the parser, counted in `droppedFindingsByType`, logged at both `parseAgentFindingsStrict` call sites, and surfaced in the dashboard as a "dropped findings" badge with tooltip listing the offending types.

**Do not** broaden the parser enum to "accept" new types. Every accepted synonym teaches the next agent the enum is negotiable. Drift is unbounded — today it's `approval`, tomorrow it's `verdict`, `observation`, `critique`. The fix is to make the contract loud, not to normalize bad input.

`FINDING_TAG_SCHEMA` is injected on every skill-bearing dispatch — full `CONSENSUS_OUTPUT_FORMAT` (schema + cross-review framing) for consensus rounds, slim schema-only block for non-consensus. Default skills point to the system-prompt schema with a 2-line pointer; they do not define their own `## Output Format`. User-editable skills at `.gossip/agents/<id>/skills/*.md` are not touched automatically — if you fork a default skill, use the pointer pattern.

### 9. `formatCompliant` requires accepted tags, not raw-count tags

`detectFormatCompliance` in `dispatch-pipeline.ts` computes compliance as `tags_accepted > 0 && citationCount >= tags_accepted`. An agent that emits 14 `<agent_finding>` tags all with `type="approval"` is NOT compliant — the tags are dropped by the type-enum filter, `tags_accepted` is zero, and the compliance signal correctly fails. The `format_compliance` meta-signal payload includes `{tags_total, tags_accepted, tags_dropped_unknown_type, tags_dropped_short_content}` so drift can be tracked empirically.

If you see an agent scoring badly on compliance despite emitting tags, check `droppedFindingsByType` on the consensus report — the invented type will be named there.

### 10. Implementer agents use the `-implementer` suffix; the convention is load-bearing

The `verify-the-premise` skill (premise-verification Stage 1) auto-binds to every agent whose `id` ends in `-implementer` via `IMPLEMENTER_PERMANENT_DEFAULTS` at `apps/cli/src/mcp-server-sdk.ts:651-666`. The filter is literal `id.endsWith('-implementer')` — case-sensitive, suffix-only.

**Load-bearing implication:** a user who creates a custom implementer named `claude-writer` (no suffix) or `MyImplementer` (wrong case) will **silently miss the premise-verification skill** — the skill that exists specifically to prevent the 2026-04-22 Math.min revert incident. Default agents already follow this convention (`sonnet-implementer`, `opus-implementer`); any new implementer must keep the suffix.

**How to opt in from the user side:** name the agent `<whatever>-implementer` at `gossip_setup` time. The skill will appear in the agent's prompt on the next dispatch. No manual skill-bind needed.

**Rationale:** suffix-match was chosen over (a) a `role` field in agent config (no such field exists today) and (b) a hardcoded list (breaks user-defined implementers). The suffix is self-documenting, idiomatic in the default agent names, and does not require schema migration.

### 11. `passed` is not terminal — drift detection makes it conditional

A graduated skill (`status: 'passed'`) is NOT a permanent verdict. The drift detector at `packages/orchestrator/src/check-effectiveness.ts:resolvePassedDrift` re-tests every `passed` skill on a fresh `N=DRIFT_WINDOW_SIZE` post-graduation window via Wilson lower-bound vs `passed_baseline_rate`. Two consecutive failing windows (`K=DRIFT_DEMOTE_STRIKES = 2`) demote the skill to `inconclusive` with `regressed_from_passed_at` stamped. A subsequent fresh-window Wilson failure fast-paths to `silent_skill` (skipping the 3-strike machinery).

**Three load-bearing details:**

- **K=2 independence requires `drift_strike_at` rotation.** Strike-1 stamps `drift_strike_at: nowIso`. Strike-2's `getCountersSince` anchors there — NOT at `passed_at` — so the second window is independent of the first. Without this, the two strikes share signals and the α²=0.000625 false-demote rate collapses to ~α=0.025. See PR #381 fixup commit `9d72fe2`.

- **Hybrid first-window for backfilled skills.** Bundled-default skills that ship `status: passed` (or skills migrated to v3 with reconstructed baselines) carry `passed_backfilled: true`. Their FIRST drift window tests against BOTH the reconstructed `passed_baseline_rate` AND the 0.75 floor (`HYBRID_BACKFILL_FLOOR`) — demote if EITHER fails. After the first pass, `passed_backfilled` clears. Prevents re-anchoring at a degraded post-migration rate.

- **Paused-until-evidence for fresh installs.** A fresh user's bundled `passed` skill has zero signal history. v3 migration leaves `passed_baseline_rate: undefined`, which `resolvePassedDrift` treats as PAUSED — the skill keeps injecting normally, no demote on zero evidence. Drift detection activates once N=80 fresh post-install signals accumulate; at that point the hybrid 0.75 floor is the load-bearing check ("does this skill generalize beyond the maintainer's project?").

**Do not** treat `passed` as a write-once anchor. The verdict can rotate: passed → drift-demoted inconclusive → re-graduation passed (with `passed_at` rotated, `regressed_from_passed_at` cleared, `drift_strikes = 0`, `drift_strike_at = undefined`). Code that assumes "passed is sticky" will misbehave on bounce-back.

**Do not** add a Bonferroni correction to drift α. The graduation, drift, and fast-path tests operate on disjoint signal populations (anchored at `bound_at`/`inconclusive_at`, `passed_at`/`drift_strike_at`, and `regressed_from_passed_at` respectively). Sequential gates on different evidence pools each spend their own α=0.025 without leakage. See `docs/specs/2026-05-13-passed-skill-drift-detection.md` for the full statistical argument.

### 12. Relay result must be passed verbatim — paraphrase silently drops `<agent_finding>` tags

When the orchestrator calls `gossip_relay(task_id, result)` after a native agent completes, the `result` value **must be the agent's raw output, unchanged.** If the orchestrator summarizes or paraphrases (e.g., `"HIGH — recordCreated lacks redaction"` instead of the full `<agent_finding>` block), the consensus engine's regex at `consensus-engine.ts:802` finds zero tags, the agent's findings are counted as zero, and the dashboard shows an empty native-agent column. Data loss is invisible — no error, no retry.

**Failure mode:** the bullet-parse fallback at `consensus-engine.ts:917-932` may partially recover prose summaries, but it loses citation data, severity grading, and confidence scores. Recovered bullets are unverifiable.

**Parser-side defense (PR #270):** `handleNativeRelay()` in `native-tasks.ts` detects zero tags on a consensus-dispatch relay and appends a `relay_findings_dropped` signal to `.gossip/relay-warnings.jsonl` plus a receipt warning in the `gossip_relay` response. This is detection, not prevention.

**Orchestrator-side rule (this invariant):** every dispatch banner and utility relay instruction now carries an explicit `(VERBATIM — pass the agent's raw output; do NOT paraphrase or summarize, or <agent_finding> tags will be lost)` qualifier on the `gossip_relay` step. Treat this line as a hard contract, not a hint.

**Related:** invariant #8 (`FINDING_TAG_SCHEMA` — parsers are strict). Consensus: `edbf8675-87b24107`.

### 13. Parallel native write-intent dispatch must use `worktree` — the dispatcher rejects it otherwise

Two or more native **write-intent** tasks dispatched in `mode: "parallel"` run concurrently (`run_in_background: true`) in the **same** `process.cwd()`. Each implementer typically runs `git checkout -b <branch>`; `.git/HEAD` is a single file, so the last checkout wins (POSIX write semantics) and a later `git commit` from another agent lands on the wrong branch. The relay cannot see this — the race is inside the agent's Bash, not a `gossip_*` call (issue #434).

A **warning is useless** here: it ships in the *same* MCP response packet as the `NATIVE_DISPATCH: Execute these N Agent calls` directive, so the orchestrator cannot interpose before the Agent() calls fire. Therefore `handleDispatchParallel` (`apps/cli/src/handlers/dispatch.ts`) **hard-rejects** the dispatch before any task is spawned when **≥2 native tasks** satisfy the exported `isParallelHeadRaceWriteIntent` predicate (`dispatch.ts`, unit-tested in `tests/cli/dispatch-parallel-head-race-guard.test.ts`) — i.e. `write_mode === 'sequential'` OR (`write_mode === undefined` AND `agent_id` ends in `-implementer`).

**Safe modes (excluded, never trigger the error):**
- `write_mode: "worktree"` — each task gets an isolated working tree with its own `.git` (`git branch X HEAD` only *reads* HEAD; `git worktree add` writes the worktree's own HEAD, not the shared one).
- `write_mode: "scoped"` — scoped agents do no git; the orchestrator commits (invariant #5).
- Read-only **reviewers** (no `-implementer` suffix, `write_mode` omitted) — parallel review/consensus dispatch is unaffected.

**Do NOT** "fix" this by auto-promoting `sequential` → `worktree`: worktree always forks a fresh branch from the base, which silently discards prior work when the task is a *revision to an existing branch* (see `feedback_worktree_dispatch_branch_divergence`). The caller must choose `worktree` (fresh isolation) or `scoped` (orchestrator-committed) explicitly. The predicate gates on the `-implementer` suffix for the same reason as invariant #10. Consensus: `974a1bb2-de854fb4`.

---

## Operator playbook (for orchestrator LLMs)

### When to dispatch vs. implement directly

**Dispatch** (via `gossip_run` / `gossip_dispatch`) when:
- Any non-trivial implementation (>10 LOC, any shared-state touch)
- Any code review of unfamiliar territory
- Any security audit, any architecture review
- When in doubt — dispatching is cheap, unreviewed code is expensive

**Implement directly** when:
- The user includes `(direct)` in their message
- The change is documentation, CSS, test data adjustments, or log-string-only
- Under 10 lines, no side effects on shared state, no security surface

### When to gate merges on consensus — impact-adjacency, not just LOC

Pre-merge consensus is cheap; bugs in trust-boundary-adjacent code are expensive. Run `gossip_dispatch(mode: "consensus", ...)` on a PR **regardless of size** when the diff touches any of:

- **Shared in-memory state with lifecycle hooks** — any `Map`, `Set`, or cache where entries are added in one path and removed (or expire) in another. Race conditions and memory leaks hide here even in small diffs.
- **Background cleanup / TTL / timer logic** — scheduled eviction, session expiry, job-queue draining, or any timer whose firing sequence is observable externally. A missed edge case silently accumulates state.
- **Serialization at persistence boundaries** — code that writes or parses structured files (JSON config, YAML frontmatter, append-only logs, DB migrations). A format regression is invisible until a downstream reader breaks, and the blast radius is multiplicative.
- **Authentication / authorization boundaries** — middleware, token validation, permission checks, or any decorator that gates access. A single missing condition opens the full surface behind it.
- **Signal or event pipelines** — pub/sub routing, queue producers/consumers, or any path where message loss, duplication, or ordering is externally observable. Subtle ordering bugs are hard to reproduce after the fact.
- **Install / bootstrap / initialization paths** — postinstall hooks, config writers, seeding scripts, or startup sequences. These run once and their failures are often silent or hard to roll back.

**Why LOC alone misses these:** risk is proportional to how many concurrent systems depend on implicit assumptions, not to code size. A 40-line change to a cache eviction path or a config merge routine can introduce a memory leak or clobber user state just as easily as a 500-line feature. Let impact adjacency — not file count — trigger consensus.

**Exceptions within impact-adjacent areas:**
- Small mirror-of-existing-pattern changes (applying a previously-reviewed fix to a sibling file) don't need a fresh round; the pattern is already validated.
- Pure log-string or comment edits inside these files are fine.

**Remediation when missed:** run post-hoc consensus on the merged diff, file follow-up PRs if findings surface, and document the gap as feedback.

### Consensus protocol — 3 steps

When you dispatch with `mode: "consensus"`, the orchestrator follows **three** steps. Phase 2 cross-review runs server-side automatically.

1. `gossip_dispatch(mode: "consensus", tasks: [...])` — Phase 1 dispatched
2. Run native `Agent()` calls + `gossip_relay` each result
3. `gossip_collect(task_ids, consensus: true)` — triggers server-side Phase 2 (cross-reviewer selection + cross-review + synthesis) and returns the final consensus report

The server selects cross-reviewers via `selectCrossReviewers` (epsilon-greedy, severity-scaled), runs `crossReviewForAgent` with verifier tools (`file_read`, `file_grep`, etc.), and synthesizes the final report — all inside a single `gossip_collect` call. If server-side Phase 2 fails, it falls back to the legacy 5-step manual path (orchestrator dispatches cross-review agents individually).

#### Cross-reviewer selection heuristic

`selectCrossReviewers` at `packages/orchestrator/src/cross-reviewer-selection.ts` picks who reviews each finding:

| Severity | Target K (reviewers per finding) |
|----------|----------------------------------|
| critical | 3 |
| high, medium, low | 2 |

**Scoring:** `accuracy * 0.7 + categoryAccuracy * 0.3` — agents with category expertise get preference. When no category data exists, compete on accuracy alone.

**Exploration:** severity-scaled epsilon-greedy. The exploration rate is `starvation * sevScale`:
- Starvation: 0.30 (< 10 signals), 0.15 (10-50), 0.05 (> 50)
- sevScale: critical=0.15, high=0.35, medium=0.70, low=1.00
- Critical epsilon cap: 0.30 × 0.15 = 4.5% — critical findings rarely get experimental reviewers

**All-zero fallback:** When no agents have scores (fresh pool), findings are assigned via Fisher-Yates shuffle (`crypto.randomBytes`) to ensure uniform distribution.

**Dashboard visibility:** Each consensus report stores `crossReviewAssignments` (who reviewed what) and `crossReviewCoverage` (assigned vs targetK per finding). The dashboard shows reviewer badges and coverage indicators on each finding card, with yellow warnings for under-reviewed findings.

### Signal recording is mandatory, not deferrable

When you verify a finding as real (or catch a hallucination), **record the signal immediately** via `gossip_signals`. Don't batch signals at session end. Don't ask the user permission to record. This is the action immediately after verification.

**Strict order: verify → signal → synthesize.** Not the other way. The common failure mode is recognizing that the signal step is owed, but deciding the synthesis deliverable (a decision table, a PR description, a summary back to the user) feels more urgent — so signals get pushed to "after I present this." That reordering is how signal recording silently stops happening. If you catch yourself writing the summary before signals are recorded, stop and record first. "This deliverable is cleaner" is the disguise the failure mode wears.

**Every signal must include `finding_id`** in the format `<consensusId>:<agentId>:fN`. Without it, the dashboard can't trace back from signal → finding → agent and scoring becomes opaque.

### Relaying native agent output preserves raw angle brackets

When feeding a native `Agent()` result back via `gossip_relay`, the `<agent_finding>` tags must reach the parser as raw angle brackets. If the transport path double-entity-encodes to `&lt;agent_finding&gt;` — common when output is routed through a markdown renderer, a JSON.stringify helper that re-encodes, or a web-UI paste — the strict parser (invariant #8) does a literal `<agent_finding` match, finds zero tags, and scores the agent as format-noncompliant even though the output was correct. Pass the agent's output verbatim.

If `format_compliance` signals a sudden drop for an agent that was fine last round, inspect the raw tags in the consensus report for `&lt;` / `&gt;` entity encoding before investigating further.

### Skill-develop cooldown gate

`gossip_skills(action: "develop")` is throttled to prevent churn. Redeveloping the same skill while its effectiveness window is still accumulating evidence resets the `MIN_EVIDENCE=80` counter and collapses the statistical signal. Cooldown is verdict-aware:

- `pending` — no gate (skill may need 60-120d to reach MIN_EVIDENCE)
- `silent_skill` / `insufficient_evidence` — 30d
- `inconclusive` — 60d (preserves strike rotation)
- `passed` / `failed` — hard-block (terminal)
- missing `bound_at` — allow (pre-schema files)

When blocked, the error message shows age + remaining cooldown + override instruction. Pass `force: true` to bypass; every override is appended to `.gossip/forced-skill-develops.jsonl` for auditability. Chronic override patterns on an agent+category pair are a signal that the skill prompt is ineffective or `MIN_EVIDENCE` is miscalibrated for that category — investigate before reflexively forcing.

### Tech-stack override

Drop a `.gossip/tech-stack.md` at the project root to bypass auto-detection on `gossip_skills(action: "develop")`. Content (max 2000 chars after trim) is injected verbatim into the skill-develop prompt's `<tech_stack>` block, replacing the auto-detected description. Useful for non-Node host projects (Solidity, Rust, Move, audit workspaces) where the LLM hallucinates a Node.js stack from thin npm dep signal (issue #410, PR #411 floor + this override). Cache is session-stable — restart the MCP server to pick up edits. Empty file or read errors fall through to auto-detect (with stderr warning on errors). Files over 2 KB are clamped with a stderr warning.

**Tech-stack auto-detection.** When no override is present and the npm dep count is below `TECH_STACK_MIN_DEPS=3` OR the project is non-Node, `detectTechStack` scans the project root for known manifests (Cargo.toml, pyproject.toml, requirements.txt, go.mod, foundry.toml, Move.toml, Gemfile, composer.json), the README first 30 lines / 2 KB, and a shallow file-extension census (root only, excluding `node_modules`/`.git`/`.gossip`/`dist`/`build`/`out`/`coverage`, capped at 10 extension types; Config/docs extensions (`.json`, `.md`, `.yaml`, `.toml`, `.lock`, common dotfiles like `.prettierrc`/`.eslintrc`/`.dockerignore`/etc.) are excluded from the census — they're either ubiquitous across project types (carrying no toolchain signal) or already covered elsewhere (npm deps via `package.json`, language via manifests). Trade-off: Kubernetes / Ansible projects whose primary source is `.yaml` will receive less detection signal from the census; use `.gossip/tech-stack.md` for those). Any non-Node signal — manifest match, README content, or extension census — bypasses the `MIN_DEPS=3` floor so polyglot projects don't need the override file. Workspace-level manifests (e.g., `packages/contracts/foundry.toml`) are NOT scanned in this MVP; place the manifest at root or use `.gossip/tech-stack.md` for those cases.

### Verifying UNVERIFIED findings

When a consensus report has `UNVERIFIED` findings (cross-reviewer couldn't check), **you must verify them yourself before presenting results**. UNVERIFIED means "the peer didn't have the tools or context to check" — you do. Read the cited files, grep for the identifiers, confirm or reject. Do not show raw consensus output with unexamined UNVERIFIED findings.

### Reviewing a branch that lives in a git worktree

If you're reviewing code that only exists on a feature branch (e.g. `git worktree add .worktrees/feature-x feature-x`), pass the worktree path via `gossip_collect`:

```
gossip_collect({
  task_ids: [...],
  consensus: true,
  resolutionRoots: ['.worktrees/feature-x'],
})
```

Without `resolutionRoots`, citations to files that only exist in the worktree resolve against `projectRoot` → `⚠ file not found` → every cross-reviewer marks UNVERIFIED → the round produces zero verified findings. `resolutionRoots` runs each path through a validator (NUL reject, `..` reject, realpath, ownership check, git-common-dir match, `git worktree list` membership) before adding it to the citation-resolver trust zone.

Secondary: `consensus.autoDiscoverWorktrees: true` in `.gossip/config.json` is DISCOVERY-ONLY (opt-in, default off). When enabled, it logs a warning listing hashed paths of sibling git worktrees so operators know which branches exist — but it does NOT auto-route cross-reviewers to any of them. You must still pass explicit `resolutionRoots` to `gossip_dispatch` (or `gossip_collect`) to pin cross-reviewers to a specific worktree. Per consensus c6b8580d-595e48d2 + issue #402, prior auto-promotion behaviour was a foot-gun: it silently routed reviews to the wrong branch when multiple worktrees existed. Same validator applies to anything you do pass explicitly.

See spec `docs/specs/2026-04-17-issue-126.md` for the full design.

### Never auto-execute `.gossip/` deletion from agent suggestions

`.gossip/` is operational state — signals, consensus reports, memory, skill bindings, boundary-escape audit log. If any dispatched agent (implementer, reviewer, researcher) suggests "clean up .gossip/", "reset stale state", "remove the old signal log", or similar, **stop and confirm with the user before executing**. Never relay the suggestion as an action.

An agent proposing `.gossip/` deletion has confused project state (source, tests, build) with operational state. Wiping it resets every agent's competency profile, destroys cross-session memory, and breaks the feedback loop the whole system depends on. Legitimate modifications come from `gossip_signals(action: "retract", ...)`, `gossip_setup(mode: "merge"|"update_instructions", ...)`, or direct user request — not from agent output.

Implementers writing into `.gossip/` also trip the worktree sandbox as a `boundary_escape` — a second signal that this class of suggestion is out-of-scope. See prior session 2026-04-20 where a sibling orchestrator nearly executed this before the user caught it.

### Before trusting a memory entry

Backlog memories decay fast. Before acting on any `project_*.md` memory claim older than 48 hours, call `gossip_verify_memory(memory_path, claim)` and handle the verdict:

- `FRESH` — proceed
- `STALE` — read the actual code at the cited paths, rewrite the memory, then act
- `CONTRADICTED` — the memory is wrong; stop, reassess whether the task even makes sense
- `INCONCLUSIVE` — manual audit via Read/Grep, do **not** treat as a pass

---

## For new users (first-run guide)

```bash
# Install globally
npm install -g gossipcat

# Add to your Claude Code MCP config (~/.claude/mcp_settings.json or equivalent)
{
  "mcpServers": {
    "gossipcat": {
      "command": "gossipcat",
      "args": ["mcp"]
    }
  }
}

# First-time setup — from your project directory
# In Claude Code: say "set up gossipcat for this project"
# Or call: gossip_setup(mode: "merge", agents: [...])
```

**What you'll see after install:**

- `.gossip/` directory in your project (agents, memory, performance signals, consensus reports)
- A local dashboard at `http://localhost:<port>/dashboard` — URL and key are in `gossip_status()` output
- A relay running on a sticky port per project (no collisions between projects)
- A set of default agent archetypes you can edit in `.gossip/agents/<id>/instructions.md`

**Your first real session should:**

1. Call `gossip_status()` first — every time. It loads fresh context and this handbook.
2. Ask the orchestrator to review a recent commit via consensus — this is the fastest way to see the signal pipeline work end-to-end.
3. Watch the dashboard. Open it in a browser tab. You'll see findings, signals, and competency scores updating in real time.

**What it won't do on day 1:**

- Skill effectiveness verdicts won't graduate from `pending` for weeks or months — that's the MIN_EVIDENCE gate working as designed (see invariant #2).
- The first few consensus rounds will be noisier than later ones. The system gets sharper as signal history accumulates.

---

## Known caveats (honest limits)

### Effectiveness tracking is slow by design

Skills sit in `pending` until ≥80 post-bind signals accumulate in the category, or until the 90-day timeout flips them to `silent_skill` / `insufficient_evidence`. At typical side-project volumes, most skills will time out before graduating. This is intentional statistical rigor, not a bug.

**Workaround for paper-style validation**: build a curated eval suite with paired before/after runs on a fixed task corpus. Use McNemar's test on paired outcomes (smaller N needed, detects ~15pp shifts at N=30). This is on the roadmap but not shipped.

### CI pipeline

GitHub Actions runs on every push to `master` and every PR: workspace builds in
topological order, `tsc --noEmit` for CLI + orchestrator, `npm test --ci`, MCP bundle
build + 5MB size guard. See `.github/workflows/ci.yml`. All PRs must pass before merge.

### Gemini provider cascades on bad keys

When the Gemini API key is invalid, failures cascade into unrelated paths (skill development, lens generation, consensus cross-review) because several subsystems share the main provider. Workaround: set `config.utility_model.provider = "native"` to route utility work through native Claude Code subagents instead. Path B (PR #25) wired this up for `gossip_skills develop`.

### The dashboard is minimal

It works. It shows the data. It is not pretty. Design polish is an ongoing stream, not a blocker.

### Consensus rounds are slow (~10 min for a full 2-agent round)

Two-phase consensus (Phase 1 parallel findings + Phase 2 cross-review) takes real wall-clock time. This is the correctness tax. There is no plan to shorten it by skipping Phase 2 — that would break the grounded reward claim.

### `flagged_for_manual_review` is effectively unreachable

Per `check-effectiveness.ts:146-157`: reaching 3 `inconclusive` strikes requires ~240 fresh category signals across three independent MIN_EVIDENCE windows, which exceeds the 90-day timeout at realistic volumes. The terminal state exists in the enum but no real skill will reach it. Consider it a design placeholder.

---

## Hallucination patterns we've caught (avoid re-discovery)

These are real failure modes caught in consensus rounds. If you see a review agent making any of these claims, verify independently before acting — and record a `hallucination_caught` signal if confirmed.

### "Timing order bug" in `skill-engine.ts buildPrompt`/`saveFromRaw`

**Claim:** `bound_at` is set before the skill file is written, so pre-existing signals are excluded from the delta window. **Fix**: move `bound_at` to save-time.

**Reality:** The baseline and delta queries use different `sinceMs` anchors (lifetime=0 for baseline, `bound_at` for delta) by design. Moving `bound_at` later would only delay the post-bind window, never expand it. This has been fabricated by at least one reviewer and is in the training data.

### "Phantom pipeline files" — `dispatch-pipeline.ts` / `collect-pipeline.ts`

**Claim:** A finding cites `dispatch-pipeline.ts:N` or `collect-pipeline.ts:N`.

**Reality:** These files do not exist. Actual dispatch/collect logic is flat in `dispatch.ts` / `collect.ts`. Any finding citing a "pipeline" suffix should be verified with `ls` before trusting.

### "Phantom thresholds" — percentages or counts not in the code

**Claim:** A finding references a "2% rolling window," "75% throttle," or a specific numeric gate.

**Reality:** Grep the repo for the literal number. If it's not in the source, the threshold is fabricated. Do not propose fixes based on unverified numeric claims.

### "Test framework mismatch" in review findings

**Claim:** A reviewer claims the project uses vitest when tests say jest, or vice versa.

**Reality:** The project uses **Jest** (`jest.config.base.js`). Both `jest` and `vitest` may appear in package.json history but jest is the runner. Any "framework mismatch" finding is a hallucination.

### "Wrong gate direction" on conditional branches

**Claim:** A reviewer says a gate at line N "blocks" code that appears before line N.

**Reality:** A gate like `if (X) return` at line N early-returns downstream, not upstream. Always read the call site to confirm the directional relationship before trusting the claim.

---

## Lessons from failed experiments

These are things we tried and learned from. Listed so the next iteration doesn't re-walk the same path.

### Two-agent parallel compare (pre-consensus)

Early version: run two agents on the same task, trust findings they agreed on, discard the rest. **Failed** because two agents can confidently agree on claims neither of them checked — agreement is not verification. The pivot to citation-verified cross-review is what made the loop reliable.

### `develop` hardwired to Gemini

Early `SkillEngine.generate()` was constructed with a direct `m.createProvider(mainProvider, ...)` call and always hit the main provider's LLM. When Gemini's key was invalid, skill-develop failed hard even though lens generation and session summary already worked via native utility re-entry. PR #25 (Path B) refactored `generate()` into `buildPrompt()` + `saveFromRaw()` so the same re-entry pattern could route skill generation through native Claude Code.

**Lesson:** any subsystem that depends on an external LLM call should go through the utility branch from day one. Don't hardwire providers.

### Effectiveness check with raw string category comparison

PR #24 caught this: `getCountersSince` was comparing `signal.category !== category` with exact string equality, but signals are stored with underscore form and queries arrive with hyphen form from the runner. For 9 of 10 categories, counters always returned 0.

**Lesson:** any code that joins data from two sources that each have their own normalization rules should normalize at the comparison point, not assume upstream canonicalization.

### LinkedIn-style promotional language in Reddit posts

Don't. Reddit punishes hype visibly. Reddit-native voice is specific, honest about limits, and leads with what can be poked at, not what's impressive. See `docs/reddit-claudeai-post.md` for the canonical voice.

### Dual delivery mechanism for LLM + human artifacts

Consensus reports, session summaries, and formatted outputs serve two audiences simultaneously: (1) the orchestrator LLM that needs structured tokens (`REQUIRED_NEXT`, `finding_id`, `<agent_finding>` tags) to drive the next tool call, and (2) the human reading the terminal or dashboard who needs readable tables and prose. These are not the same format.

Early versions optimized for one audience and confused the other. Machine tokens in human-readable output look like noise. Human prose in machine-parsed output causes regex fallbacks and silent data loss (see consensus `1537efbb-2b44492d:f13` — paraphrased AGENT_PROMPT dropped the CONSENSUS_OUTPUT_FORMAT training block).

**Lesson:** every artifact that crosses the LLM/human boundary needs explicit separation. The two-content-item split for native dispatch (item 1: orchestrator instructions, item 2: agent prompt verbatim) is the working pattern. `formatReport()` producing both a structured `ConsensusReport` object and a human-readable `summary` string is another. When adding new output, decide which audience it serves before writing it — don't try to serve both in one string.

---

## Glossary

- **Agent** — an LLM worker with an `agent_id`, runtime (native/relay), provider, and model. Defined in `.gossip/agents/<id>/instructions.md`.
- **Consensus round** — a 2-phase multi-agent review with an 8-hex-8-hex ID like `1537efbb-2b44492d`. Phase 1 is parallel findings; Phase 2 is server-side cross-review (automated via `selectCrossReviewers` + `crossReviewForAgent` with verifier tools).
- **Finding** — a single reviewer observation, wrapped in `<agent_finding>` tags, with a mandatory `file:line` citation.
- **Finding ID** — `<consensusId>:<agentId>:fN` — the primary key linking a signal back to the exact finding that produced it.
- **Signal** — a recorded outcome from verification: `agreement`, `disagreement`, `unique_confirmed`, `hallucination_caught`, `impl_test_pass`, etc. Stored in `.gossip/agent-performance.jsonl`.
- **Category** — a competency dimension: `trust_boundaries`, `concurrency`, `data_integrity`, `injection_vectors`, `input_validation`, `resource_exhaustion`, `type_safety`, `error_handling`, `citation_grounding`, `verification`.
- **Skill** — an agent-specific markdown file under `.gossip/agents/<id>/skills/<category>.md` that's injected into the agent's prompt on every dispatch. Has a verdict `status` in frontmatter.
- **Verdict** — the output of `check-effectiveness`: `pending`, `passed`, `failed`, `flagged_for_manual_review`, `silent_skill`, `insufficient_evidence`, `not_applicable`.
- **Native agent** — a Claude Code subagent dispatched via the Agent tool, zero API cost, relayed back via `gossip_relay`.
- **Relay agent** — a worker running against an API endpoint (Gemini, OpenClaw, any OpenAI-compatible), coordinated via WebSocket.
- **Scoped write** — a restricted write mode where agents can edit files within a directory scope but not run git commits or shell commands.
- **Worktree write** — an isolation mode where agents operate in a git worktree on a separate branch with full git access.

---

## Research angle (for the curious)

Gossipcat is the production substrate for an emerging research framing: **weightless in-context reinforcement learning at the prompt layer with grounded cross-review rewards**. Key claims:

- Reward signals are grounded in citation verification against real source code, not preference-based judging
- Competency scores are per-agent, per-category posteriors updated online from verified outcomes
- The "policy update" is a generated skill file (markdown), not a gradient step
- The dispatcher is a portfolio bandit over a heterogeneous LLM pool with specialization pressure

**What's genuinely novel** (to the best of our literature review): the combination of citation-grounded rewards, per-category competency posteriors, skill-gated penalty recovery, and the closed loop where verdicts feed back into dispatch — running at production scale on a real codebase.

**What's not novel:** multi-agent debate, LLM-as-judge, ensemble voting, prompt chaining. Do not frame gossipcat as "another multi-agent framework." It's a weightless RL substrate that happens to use multi-agent review as the reward source.

For a paper draft, the critical path is: (1) curated eval suite with paired before/after on fixed tasks, (2) training-data-leakage defense (author-injected bugs + post-cutoff PRs), (3) McNemar's test on paired outcomes, (4) ablations removing grounded rewards, removing skill-gated recovery, removing per-category posteriors. See `project_gossipcat_paper_framing.md` in the operator's memory folder for the full framing.

---

## How to update this handbook

This file is the canonical "operator's manual" and is auto-loaded by `gossip_status()`. When you add a new invariant, caveat, or lesson:

1. Keep it **specific and citable** — prefer `file:line` references over abstract claims
2. Keep it **under 500 lines total** — curate, don't accumulate
3. **Remove** entries that are no longer true (not just add new ones)
4. If a section grows past ~50 lines, consider whether it should be a separate doc linked from here
5. Commit via a proper PR — do not direct-push to master

The handbook is evidence that the system accumulates wisdom across sessions. Treat it that way.
