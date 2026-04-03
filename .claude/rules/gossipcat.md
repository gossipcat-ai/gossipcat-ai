# Gossipcat Agent Dispatch Rules

## Core Principle

**Author == sole reviewer is always a bug.** If you wrote the code and it's more than a
one-liner, you cannot be the only reviewer. Dispatch at least one agent.

The deciding factor is NOT size or complexity. It's **what the diff touches.** Match on
code properties (files, patterns, state), not intent ("I'm just fixing a small thing").

**Why this matters:** The native task persistence code (commit `87e4587`) was 40 lines. It
passed linting, type-checking, and all tests. The author reviewed it and committed. It
contained 3 silent bugs: two race conditions and unbounded file growth. None crashed. None
failed tests. They were found only when agents reviewed it later. Author self-review is
optimistic by nature — you can't adversarially question your own design.

## 5-Second Decision Checklist

Before committing, work through these in order. Stop at the first match.

1. Shared mutable state across async boundaries? → **Tier 1**
2. Writes to disk with potentially unbounded size? → **Tier 1**
3. Touches auth, sessions, credentials, or security? → **Tier 1**
4. Touches core dispatch pipeline or relay lifecycle? → **Tier 1**
5. File persistence (write at runtime, read on boot)? → **Tier 1**
6. New production dependency? → **Tier 1**
7. API handler, new MCP tool, or memory system? → **Tier 2**
8. Cross-cutting type/interface change? → **Tier 2**
9. Data transformation of external input? → **Tier 2**
10. Well-tested, isolated, single-function? Can name the test file? → **Tier 3**

---

## Tier 1: Mandatory Consensus (3 agents, ~10-15 min)

Use `gossip_dispatch(mode: "consensus", tasks: [...])` with agents split by concern
(security, logic/concurrency, edge-cases/persistence). Then collect with
`gossip_collect(task_ids: [...], consensus: true)`. Do NOT commit until consensus report
is verified and signals recorded.

**Triggers — ANY of these:**

| Trigger | Why | Files to watch |
|---------|-----|----------------|
| Shared mutable state across async boundaries | Race conditions are invisible to tests | Any Map/Set modified with `await` between read and write |
| Unbounded resource growth | Silent until disk fills or OOM | `.json`/`.jsonl` writes where entry size depends on LLM/user input |
| Authentication or session management | Subtle bypasses don't throw errors | `auth.ts`, cookie/token handling, key comparison |
| Core dispatch pipeline | Affects every agent task | `mcp-server-sdk.ts`, `dispatch-pipeline.ts`, `orchestrator.ts` |
| Relay server lifecycle | Affects all connections | `server.ts`, `connection-manager.ts`, `router.ts` |
| File persistence of state | Crash-recovery semantics are hard | Any file written at runtime AND read on boot (TTL, eviction, restore) |
| New production dependency | Supply chain risk | `dependencies` in any `package.json` |

**What to ask reviewers:**
- "What happens if the async path throws halfway through?"
- "What bounds the file size after 500 tasks?"
- "Can two concurrent callers corrupt the state?"

**Unconditional Tier 1:** Any change to `mcp-server-sdk.ts` that touches `nativeTaskMap`,
`nativeResultMap`, or `native-tasks.json` persistence.

---

## Tier 2: Single Agent Review (gossip_run, ~2-5 min)

Use `gossip_run` with `sonnet-reviewer`. Do NOT commit until findings are verified or dismissed.

**Triggers — ANY of these:**

| Trigger | Files |
|---------|-------|
| Dashboard API handlers | `packages/relay/src/dashboard/api-*.ts` |
| New MCP tool registration | Any new `server.tool(...)` call |
| Memory system logic | `agent-memory.ts`, `memory-writer.ts`, `memory-compactor.ts` |
| Cross-cutting type/interface change | Types used by multiple files |
| Data transformation of external input | JSON/JSONL/markdown parsing |
| Spec or architecture doc (pre-implementation) | Design docs that will drive code |

**Escalation rule:** If the Tier 2 reviewer raises a concern about concurrency, persistence,
or auth — escalate to Tier 1 before committing.

---

## Tier 3: Self-Review + Tests (seconds)

Acceptable only when ALL of these are true:
1. The change does not match any Tier 1 or Tier 2 trigger above
2. Existing tests cover the changed code path
3. You can name the specific test file

**Examples:**
- Documentation (`.md` files, comments)
- Test additions or fixes
- Single-function refactoring (no signature change)
- CSS/HTML in `packages/dashboard/src` (unless it adds data transformation)
- Log messages, error strings

**Self-review is NOT fine for:**
- "Simple" bug fixes that touch shared state — that's Tier 1
- "Quick" refactors that change a type used in dispatch pipeline — that's Tier 1
- "Obvious" auth changes — that's Tier 1

---

## Override: `(quick-fix)`

Include `(quick-fix)` in commit message to drop to Tier 3. Valid ONLY when:
- Diff is under 10 lines
- No side effects on shared state, file I/O, or auth
- You can name the exact test that covers it

Still must run `npx jest` for the affected module.

**Invalid uses of override:**
- "This is obvious" — obvious to the author IS the antipattern
- "We already reviewed the design" — design review ≠ implementation review
- "It's a fix for a bug we just found" — follow-on fixes to shared state are still Tier 1

---

## Auto-Dispatch Rule

**Precedence:** The Tier 1/2/3 rules above take priority over auto-dispatch.
If a task matches a Tier 1 trigger (shared mutable state, auth, persistence, etc.), use
`gossip_dispatch(mode: "consensus")` as before. If it matches Tier 2, use `gossip_run`
with the appropriate reviewer. Auto-dispatch applies to implementation tasks that don't
match Tier 1 or Tier 2 triggers.

Before writing implementation code, call `gossip_run(agent_id: "auto", task: "<description>")`.

This applies when the user asks to implement, build, add, create, refactor, or fix any
non-trivial code change. The orchestrator's role is to coordinate — dispatch to agents,
verify results, record signals — not to implement directly.

**Exceptions (orchestrator may implement directly):**
- User includes `(direct)` in their message
- Change matches Tier 3 (docs, CSS, test additions, log strings)
- Change is under 10 lines with no side effects on shared state (existing `(quick-fix)` rules)
- Orchestrator is already executing inside a dispatched plan step

**Flow:**
1. Check Tier 1/2 triggers first — if matched, follow existing dispatch rules
2. Call `gossip_run(agent_id: "auto", task: "<what user asked>")`
3. gossip_run classifies → single-agent or multi-agent
4. Single: selects best-fit agent via dispatch weights, dispatches directly
5. Multi: calls gossip_plan, presents decomposition, dispatches on approval
6. Orchestrator collects results, verifies, records signals

---

## Subagent Override (IMPORTANT)

When ANY skill or workflow (including subagent-driven-development, executing-plans, or
any custom skill) instructs you to dispatch work via the Agent() tool, use `gossip_run`
instead. This ensures tasks appear in the dashboard, agent memory is written, and
performance signals are recorded.

**Flow:** `gossip_run(agent_id, task)` → for native agents, returns EXECUTE NOW instructions.

**CRITICAL — Auto-Execute Native Dispatch:**
When `gossip_run` returns `⚠️ EXECUTE NOW`, you MUST immediately in the SAME response:
1. Call `Agent()` with the provided model and prompt (use `run_in_background: true`)
2. When the agent completes, call `gossip_relay(task_id, result)` with the full output

Do NOT ask the user for permission. Do NOT wait between steps. The gossip_run already
authorized the dispatch — your job is to execute it and relay the result.

**Exception:** `gossip_dispatch(mode: "consensus", ...)` already handles its own native
Agent() calls — don't double-wrap those.

**Why:** Raw Agent() bypasses the gossipcat pipeline. Tasks won't appear in the activity
feed, no memory is written, no signals recorded. The agent effectively works off-grid.

**Cross-Review Dispatch:**
When `gossip_collect(consensus: true)` returns `⚠️ EXECUTE NOW`, follow the same
auto-execute rules: dispatch all native Agent() calls for cross-review and relay
results via `gossip_relay_cross_review` before doing anything else.

---

## Signal Recording

**Record signals IMMEDIATELY when you verify an agent's output — findings OR actions.**

This is not optional. The moment you confirm or invalidate an agent's work, call
`gossip_signals(action: "record", ...)` before doing anything else.

| Trigger | Signal | Example |
|---------|--------|---------|
| Agent finding verified correct | `unique_confirmed` or `agreement` | Code review catches a real bug |
| Agent finding is fabricated/wrong | `hallucination_caught` | Reviewer claims bug exists but code is correct |
| Agent's code change breaks build | `hallucination_caught` | Agent edits tsconfig, causes TS6059 errors |
| Agent's code change is reverted | `hallucination_caught` | Fix introduced worse problems than it solved |
| Two agents agree on a finding | `agreement` | Both flag same race condition |
| Agents disagree, one is right | `disagreement` | One says safe, other finds real vuln |

**Why this matters:** Signals drive dispatch weights. Deferred signals mean stale scores,
which means wrong agents get picked for future tasks. The haiku-researcher tsconfig incident
(moved paths to base config, broke all package builds) went unrecorded until manually prompted
— that's a feedback loop failure.

**Anti-patterns:**
- "I'll record signals after I finish fixing" — NO, record NOW
- "This was just a research task, no signal needed" — if the research was wrong, record it
- "The agent tried its best" — intent doesn't matter, accuracy does

---

### Post-Collect Cross-Review (Mandatory)

After `gossip_collect(consensus: true)`, if native cross-review is needed:
1. The output starts with `⚠️ EXECUTE NOW` — same rules as gossip_run
2. Dispatch Agent() calls for each native agent's cross-review prompt
3. Relay each result via `gossip_relay_cross_review(consensus_id, agent_id, result)`
4. Wait for consensus report synthesis to complete
5. THEN verify UNVERIFIED findings and record signals

---

## UNVERIFIED Findings — Mandatory Verification

**After every `gossip_collect` with consensus, the orchestrator MUST verify ALL UNVERIFIED
findings before presenting results to the user.**

UNVERIFIED does not mean "low priority" or "probably wrong." It means the cross-reviewer
couldn't access the code — but the orchestrator CAN. In practice, most UNVERIFIED findings
are real issues. Evidence: 4/4 UNVERIFIED findings in the 2026-04-01 session were confirmed
as real bugs after manual verification.

**Workflow after consensus:**
1. Read each UNVERIFIED finding
2. Grep/read the cited code or `<fn>`-tagged identifiers
3. Record the appropriate signal (`unique_confirmed` or `hallucination_caught`)
4. Present the fully verified report — no UNVERIFIED findings left unexamined
5. Only present genuinely ambiguous findings as "uncertain"

**Do NOT:**
- Present raw consensus results with UNVERIFIED findings and ask the user what to do
- Skip verification because "the user can check it"
- Leave UNVERIFIED findings unexamined — that is a system failure

---

## Closing the Loop: Hallucination → Skill Development

When you record `hallucination_caught` for an agent, check if the error maps to a
repeatable skill gap. If the agent keeps failing in a specific category (e.g.,
`resource_exhaustion`, `persistence_semantics`, `scope_lifecycle`), build a skill:

```
gossip_skills(action: "develop", agent_id: "<agent>", category: "<category>")
```

This generates a skill file that gets injected into future prompts for that agent,
preventing the same class of error from recurring. A signal penalizes past mistakes;
a skill prevents future ones.

**When to develop a skill:**
- Agent hallucinated about how a subsystem works (e.g., "ScopeTracker persists to disk" when it's in-memory only)
- Agent repeatedly fails in a category where peers succeed (visible in `gossip_scores()` output)
- Collect output shows "Skill gap detected" for the same agent/category across multiple sessions

**When NOT to develop a skill:**
- One-off mistake that won't recur (e.g., wrong line number citation)
- The agent is already being penalized and will be deprioritized by dispatch weights
