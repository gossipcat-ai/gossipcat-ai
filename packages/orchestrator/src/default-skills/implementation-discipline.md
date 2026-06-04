---
name: implementation-discipline
description: Coding-time discipline for implementer agents — think first, simplest change, surgical edits, stated success criteria.
keywords: []
category: implementation
mode: permanent
status: active
---

## When this skill activates
Always — this is a permanent-mode skill for implementer agents. It governs HOW
you write code, not WHAT to build. Premise-checking is a separate skill
(`verify-the-premise`); run that first, then apply this.

## Iron law
Every line you change must trace to the dispatched task. Touch nothing else.
The simplest change that satisfies the task — and survives a trust-boundary
review — wins over the clever one.

## 1. Think before coding
- State the assumptions your implementation depends on. If an assumption is
  load-bearing and unverified, check it (see `verify-the-premise`) or flag it.
- If the task has more than one reasonable interpretation, do NOT pick silently.
  Implement the most defensible one and name the alternative in your result so
  the orchestrator can redirect cheaply.
- If a materially simpler approach exists than the one implied by the task, say
  so before building the complex one. Pushing back early is cheaper than a
  rewrite after consensus.

## 2. Simplicity first — with a trust-boundary carve-out
- Minimum code that solves the task. No features, abstractions, config, or
  "flexibility" that the task did not ask for. No abstraction for single-use code.
- If 200 lines could be 50, rewrite before you submit.
- **CARVE-OUT (do not skip):** "no error handling for impossible scenarios" does
  NOT apply at trust boundaries. Any value that crossed an untrusted edge — MCP
  tool input, an LLM/agent output, a file path or citation from a finding, a
  parsed persisted record — must be validated even when the bad state "can't
  happen." In this project, attackers (and buggy upstreams) make impossible
  states real. Validate-and-fail-closed at the boundary is required simplicity,
  not speculative complexity. (See the `trust-boundaries` skill.)

## 3. Surgical changes
- Edit only what the task requires. Do NOT "improve" adjacent code, comments, or
  formatting, and do NOT refactor things that aren't broken.
- Match the surrounding style even if you'd personally write it differently.
- Remove imports / variables / functions that YOUR change orphaned. Do NOT
  delete pre-existing dead code unless the task asked for it.
- Spotting an adjacent bug or smell is valuable — but **cite it, don't fix it**.
  Note it in your result (or as a finding) so the orchestrator can scope a
  follow-up. Fixing it in this change is scope creep; reporting it is not.

## 4. Stated success criteria
- Before editing, restate the task as a verifiable goal and a brief numbered
  plan with a per-step check. Example:
  ```
  1. Add the validator    → verify: npx tsc passes
  2. Wire the call site    → verify: new unit test for invalid input is red→green
  3. Cover the edge case   → verify: jest <path> all green
  ```
- "Add validation" becomes "write tests for invalid inputs, then make them pass."
  Strong, checkable criteria let you finish without round-trips.
- Do NOT treat self-passing tests as final sign-off — your output is verified by
  peer cross-review against the actual code, not by your own green run. State the
  criteria, meet them, then report; the consensus loop confirms.

## Anti-patterns
- Drive-by refactors bundled into a feature change — they hide the real diff from
  review and inflate blast radius.
- "I added config/an interface in case we need it later." You don't; delete it.
- Dropping input validation at a boundary because the state "is impossible."
- Self-certifying ("tests pass, done") in place of stating checkable criteria and
  letting cross-review verify.
