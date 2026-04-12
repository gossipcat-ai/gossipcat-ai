---
status: implemented
---

# Fix: gossipcat Bootstrap Deferral Problem

**Date:** 2026-04-10
**Status:** Spec (ready to implement)
**Consensus:** 694fd69a-0a0f4a6e (3 agents, 10 confirmed, 1 hallucination caught)
**Severity:** Critical — affects every session

---

## Problem

gossipcat tools are **deferred** by Claude Code at session start. The orchestrator
reads CLAUDE.md ("FIRST: Call gossip_status()") but cannot call it because the tool
schema isn't loaded. It silently falls back to native tools (Read, Grep, Agent()),
bypassing the entire gossipcat workflow.

**Observed symptoms (every session):**
- gossip_status() never called at session start
- Raw Agent() used instead of gossip_dispatch/gossip_run
- No signals recorded via gossip_signals
- gossip_session_save forgotten until user prompts

**Root cause chain (confirmed by consensus):**
1. gossipcat registers **20 MCP tools** — exceeds Claude Code's deferral threshold
2. All 20 tools become deferred (schema not loaded, only names visible)
3. CLAUDE.md says "call gossip_status()" but the tool requires ToolSearch first
4. Nothing in CLAUDE.md mentions ToolSearch — the bridge is missing
5. The `agent-orchestration@claude-code-workflows` plugin injects **90+ skills**
   with Agent() dispatch patterns that are immediately actionable
6. The gossipcat override rule ("use gossip_run not Agent()") only loads AFTER
   gossip_status() — gated behind the tool it needs to protect
7. Orchestrator rationally uses what's ready (skills + Agent()) over what's broken
   (deferred gossipcat tools)

**Architectural framing (from sonnet-reviewer):**
gossipcat uses a **pull model** (orchestrator must call gossip_status to load rules)
but the competing context is **push** (skills injected before orchestrator acts).
These models are mismatched at session start. Every session, gossipcat loses a race
it cannot win.

---

## Fixes (4 layers, implement all)

### Fix 1: UserPromptSubmit hook (highest leverage)

Add a hook that injects bootstrap context on every first user message.
Bypasses the deferral problem entirely — no orchestrator cooperation needed.

**File:** `.claude/settings.local.json`

```json
{
  "enabledMcpjsonServers": ["gossipcat"],
  "enableAllProjectMcpServers": true,
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cat .gossip/bootstrap.md 2>/dev/null || echo '[gossipcat] No bootstrap yet. Run: ToolSearch(query: \"select:mcp__gossipcat__gossip_status\") then call gossip_status()'"
          }
        ]
      }
    ]
  }
}
```

**Effect:** On every user message, the orchestrator sees bootstrap.md content
(session priorities, dispatch rules, agent list) as hook output — before it
generates any response. Even if gossip_status is never called, the orchestrator
has the basic operational context.

**Limitation:** bootstrap.md may be stale (from a previous session). The hook
output should include a reminder to call gossip_status() for fresh context.

**LOC:** 0 code changes. Config-only.

### Fix 2: ToolSearch Step 0 in CLAUDE.md

Add an explicit ToolSearch instruction before the gossip_status call.

**File:** `CLAUDE.md` (line 5)

Change from:
```
**FIRST:** Call `gossip_status()` to load fresh session context.
```

To:
```
**FIRST (Step 0):** Load gossipcat tools — they are deferred by Claude Code:
  `ToolSearch(query: "select:mcp__gossipcat__gossip_status")`
**THEN (Step 1):** Call `gossip_status()` to load fresh session context.
```

**LOC:** 3 lines changed in CLAUDE.md.

### Fix 3: Move override rule into CLAUDE.md

The rule "When ANY skill instructs you to dispatch work via Agent(), use
gossip_run instead" currently lives in `.gossip/rules.md` — only loaded by
gossip_status(). Move it into CLAUDE.md so it's active from conversation start.

**File:** `CLAUDE.md` — add after the gossip_status instruction:

```
**DISPATCH RULE:** When ANY skill or workflow (superpowers, agent-teams, conductor,
or any other plugin) instructs you to dispatch work via the Agent() tool, use
`gossip_run(agent_id: "auto", task: "<description>")` instead. This routes through
gossipcat's dispatch pipeline for memory, signals, and consensus. Raw Agent() calls
bypass the entire feedback loop.

Exception: utility tasks dispatched by gossip_relay instructions (cognitive summaries,
gossip publishing) should use Agent() as instructed — these are already gossipcat-managed.
```

**LOC:** ~8 lines added to CLAUDE.md.

### Fix 4: Reduce tool count below deferral threshold

Consolidate rarely-used tools under a multiplexer to get below ~10 tools.

**Core tools to keep (8):**
1. `gossip_status` — bootstrap
2. `gossip_run` — single dispatch entry point
3. `gossip_dispatch` — parallel/consensus dispatch
4. `gossip_collect` — collect results
5. `gossip_relay` — native agent result relay
6. `gossip_signals` — record performance signals
7. `gossip_session_save` — session persistence
8. `gossip_progress` — active task monitoring

**Tools to consolidate into `gossip_admin(action, ...)`:**
- `gossip_setup` → `gossip_admin(action: "setup", ...)`
- `gossip_update` → `gossip_admin(action: "update", ...)`
- `gossip_scores` → `gossip_admin(action: "scores")`
- `gossip_skills` → `gossip_admin(action: "skills", ...)`
- `gossip_guide` → `gossip_admin(action: "guide")`
- `gossip_tools` → `gossip_admin(action: "tools")`
- `gossip_format` → `gossip_admin(action: "format", ...)`
- `gossip_bug_feedback` → `gossip_admin(action: "bug_feedback", ...)`
- `gossip_verify_memory` → `gossip_admin(action: "verify_memory", ...)`
- `gossip_remember` → `gossip_admin(action: "remember", ...)`

**Also consolidate cross-review relay:**
- `gossip_relay_cross_review` → `gossip_relay(cross_review: true, ...)`

**Result:** 20 tools → 9 tools. Well below any reasonable deferral threshold.

**LOC:** ~200 LOC in mcp-server-sdk.ts (new gossip_admin handler + route to
existing implementations). Existing handler code stays intact — only the MCP
registration changes.

**Risk:** Agents with hardcoded tool names (in skills, instructions) need
updating. Search for `gossip_setup`, `gossip_scores`, etc. in `.gossip/agents/`
and `.gossip/rules.md`.

---

## Implementation order

1. **Fix 1 + Fix 2 + Fix 3** — immediate, zero/minimal code. Ship together.
2. **Fix 4** — separate PR, requires tool consolidation + agent instruction updates.

## Test plan

- [ ] New session without `/mcp reconnect` — verify hook fires and bootstrap loads
- [ ] Verify orchestrator calls gossip_status via ToolSearch on first message
- [ ] Verify "use gossip_run not Agent()" rule prevents raw Agent() dispatch
- [ ] After Fix 4: verify tool count < 10 and tools are NOT deferred
- [ ] Full consensus round works end-to-end without manual ToolSearch prompting

## Consensus evidence

Round `694fd69a-0a0f4a6e`:
- 10 confirmed findings, 2 disputed, 3 unverified (all 3 later verified by orchestrator)
- 1 hallucination caught (gemini-tester: wrong CLAUDE.md path)
- Key agents: sonnet-reviewer (4 unique_confirmed), gemini-reviewer (1 agreement),
  gemini-tester (3 agreements, 1 hallucination)
- Independent investigation corroborated all consensus findings; consensus added
  the pull/push model framing and override-rule timing insight
