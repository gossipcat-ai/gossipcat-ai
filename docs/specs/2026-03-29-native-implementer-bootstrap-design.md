# Gossipcat Self-Awareness — Native Implementer Agents + Bootstrap Verification

**Date:** 2026-03-29
**Status:** Spec (approved design)

---

## Overview

Two related problems under one umbrella: gossipcat doesn't know about implementation work (no native implementer agent), and gossipcat lies to future sessions about its own state (bootstrap staleness).

## Problem 1: No Native Implementer Agent

**Current state:** The team has `sonnet-reviewer` (reviewer) and `haiku-researcher` (researcher) as native agents. `gemini-implementer` exists as a custom relay agent. When the orchestrator needs implementation done, it has two bad options:

1. Dispatch to `gemini-implementer` via relay — unreliable for precise edits (hallucinated line numbers, 0% accuracy on review tasks)
2. User dispatches raw `Agent()` — bypasses gossipcat entirely, no signals, no memory

**Fix:** Add `sonnet-implementer` and `opus-implementer` as native Claude agents. `gossip_run` already supports native dispatch. The agent registry's `findBestMatch` will route to them based on skills.

### Agent Definitions

#### `.claude/agents/sonnet-implementer.md`

```markdown
---
name: sonnet-implementer
model: sonnet
description: Fast implementation agent for well-specified tasks — TDD, clean code, atomic commits
tools:
  - Bash
  - Glob
  - Grep
  - Read
  - Edit
  - Write
---

You are an implementation agent. Your job is to write clean, tested code that matches the spec exactly.

## How You Work

1. Read the task description fully before writing any code
2. Write failing tests first (TDD) when tests are part of the task
3. Implement the minimal code to make tests pass
4. Run tests to verify — do not claim they pass without running them
5. Self-review: check completeness, quality, YAGNI
6. Commit with a descriptive message

## Rules

- Follow existing patterns in the codebase — match style, naming, file organization
- Do not add features, refactoring, or improvements beyond what was requested
- Do not guess — if something is unclear, report back with status NEEDS_CONTEXT
- If the task is too complex or you're uncertain, report BLOCKED rather than producing bad work
- Keep files focused — one clear responsibility per file
- Test behavior, not implementation details

## Report Format

When done, report:
- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- What you implemented
- Test results (with actual command output)
- Files changed
- Any concerns
```

#### `.claude/agents/opus-implementer.md`

Same structure, but:
- `model: opus`
- `description: Senior implementation agent for complex multi-file integration, architectural decisions, and debugging`
- Additional instruction: "You handle tasks that require understanding multiple modules, making design judgment calls, or debugging complex interactions. Think carefully about how your changes affect the broader system."

### Skills Assignment

Both agents get skills: `["implementation", "typescript", "testing"]`

Registered via `gossip_setup` update or manual config edit. The skill index auto-seeds from config.

### Dispatch Routing

No changes to the dispatch differentiator needed. The existing `AgentRegistry.findBestMatch()` already matches on skills. When a task requires `implementation` + `typescript`, it will prefer `sonnet-implementer` or `opus-implementer` over `sonnet-reviewer` (which has `code_review`, `security_audit`).

`gossip_plan` already classifies tasks as READ or WRITE and assigns agents via the registry. Adding implementer agents with `implementation` skill means the planner will auto-assign them to WRITE tasks.

### When to Use Which

| Signal | Agent |
|--------|-------|
| Clear spec, 1-2 files, mechanical | `sonnet-implementer` |
| Multi-file integration, design decisions | `opus-implementer` |
| Parallel scoped writes (module isolation) | `gemini-implementer` (relay) |

The orchestrator doesn't auto-select between sonnet and opus today — the user chooses at dispatch time or the plan assigns based on skills. Future: task complexity scoring could automate this.

## Problem 2: Bootstrap Staleness

**Current state:** `gossip_bootstrap()` regenerates the bootstrap prompt on boot. It reads `next-session.md` and includes it verbatim. If `next-session.md` says "gossip_run is TODO" but the tool was already shipped, the session inherits a false claim.

**Fix:** During bootstrap generation, verify tool-related claims in "remaining items" against the MCP server source.

### Verification Logic

In `BootstrapGenerator.readNextSessionNotes()`, after reading the raw content:

1. Find lines that look like remaining/TODO items mentioning tool names
2. For each tool name found, check if `server.tool('tool_name', ...)` exists in `apps/cli/src/mcp-server-sdk.ts`
3. If the tool exists, annotate the line: `~~gossip_run~~ (SHIPPED — tool exists in MCP server)`
4. Return the annotated content

### Tool Name Detection

Match patterns like:
- `gossip_<name>` — any gossipcat MCP tool
- Lines containing "TODO", "remaining", "deferred" near a tool name

This is intentionally narrow — only checks gossipcat tool existence. It doesn't validate arbitrary claims about features or file paths.

### Implementation

Add a private method to `BootstrapGenerator`:

```typescript
private verifyToolClaims(content: string): string {
  const mcpPath = join(this.projectRoot, 'apps', 'cli', 'src', 'mcp-server-sdk.ts');
  if (!existsSync(mcpPath)) return content; // can't verify without source

  const mcpSource = readFileSync(mcpPath, 'utf-8');

  return content.replace(
    /^(.*(?:TODO|remaining|deferred|needed).*)(gossip_\w+)(.*)/gim,
    (match, before, toolName, after) => {
      // Check if tool is registered: server.tool('tool_name', ...)
      const registered = mcpSource.includes(`'${toolName}'`) || mcpSource.includes(`"${toolName}"`);
      if (registered) {
        return `~~${match.trim()}~~ *(verified: ${toolName} exists in MCP server)*`;
      }
      return match;
    }
  );
}
```

Called from `readNextSessionNotes()` before returning content.

### Bootstrap Tools Table

The tools table in `renderTeamPrompt()` is hardcoded and missing `gossip_run` / `gossip_run_complete`. Update it to include all current tools:

```
| `gossip_run(agent_id, task)` | Single-agent dispatch. Relay: returns result. Native: returns Agent() instructions + callback. |
| `gossip_run_complete(task_id, result)` | Complete a native agent gossip_run — relays result, writes memory, emits signals. |
| `gossip_relay_result(task_id, result)` | Feed native Agent() result back into relay for consensus. |
```

## File Changes

| File | Change |
|------|--------|
| `.claude/agents/sonnet-implementer.md` | **New** — native sonnet implementer agent definition |
| `.claude/agents/opus-implementer.md` | **New** — native opus implementer agent definition |
| `.gossip/config.json` | **Modify** — add sonnet-implementer and opus-implementer to agents |
| `packages/orchestrator/src/bootstrap.ts` | **Modify** — add `verifyToolClaims()`, update tools table, call verify in `readNextSessionNotes()` |
| `tests/orchestrator/bootstrap.test.ts` | **Modify** — add tests for tool claim verification |

## Non-Goals

- Auto-selecting sonnet vs opus based on task complexity (future work)
- Validating non-tool claims in session notes (too broad, diminishing returns)
- Changing how `gossip_session_save()` writes data (fix on read, not write)
- Modifying the dispatch differentiator (it already handles skill-based routing)

## Risk

**Low.** Adding native agents is a config change + markdown files. Bootstrap verification is a single grep per boot — no performance concern. Both changes are backward-compatible. The `gossip_run` flow for native agents is already tested.
