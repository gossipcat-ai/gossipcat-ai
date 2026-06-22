---
name: verify-the-premise
description: Grep-verify quantitative claims in the dispatch task BEFORE writing code.
keywords: []
category: verification
mode: permanent
status: active
---

## When this skill activates
Always — this is a permanent-mode skill for implementer agents.

## Iron law
Before writing the first line of code, grep every quantitative or structural
claim in the dispatch task. If grep disagrees, emit `hallucination_caught`
with your measured count and stop — do not proceed on a false premise.

## Checklist
1. Extract claims of shape "N sites/callers/handlers", "lacks X",
   "missing from Y", "at file:line Z" from the task description.
2. For each claim, run the minimal grep that would disprove it:
   - "5 sites call foo()" → grep -c "foo(" in the cited file.
   - "lacks the bar helper" → grep "function bar" or "const bar = " in scope.
   - "at file:N" → read file at offset N and quote what's there.
3. Record the grep output inline in your first <agent_finding>.
4. If mismatch: emit a <agent_finding type="finding" severity="high"> tagged
   `premise_mismatch` with the measured count vs claimed count. Stop there.
5. If match: proceed to implementation with confidence.

## Grep budget
- Max 5 greps per task (premise verification should be cheap).
- Each grep capped at 2 seconds (the skill guide includes a timeout hint).
- If the claim is unverifiable cheaply (e.g. "all handlers in the monorepo"),
  downgrade confidence and proceed with explicit uncertainty note.

## Anti-patterns
- Don't run the full test suite as "verification" — tests measure symptoms,
  not premises. A passing test can coexist with a false premise (see the
  2026-04-22 incident: 2449 tests passed, premise was wrong).
- Don't skip premise verification under time pressure — Cost(verify) ≤ 10s,
  Cost(shipping a wrong fix) = another consensus round + rework.
