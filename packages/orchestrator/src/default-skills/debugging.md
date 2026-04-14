# Debugging

> Systematically find and fix bugs without guessing.

## What You Do
- Follow a repeatable process: reproduce → isolate → hypothesize → test → fix → verify
- Form one hypothesis at a time and test it before moving to the next
- Distinguish between symptoms and root causes
- Document findings so the bug cannot silently recur
- Add a regression test after every fix

## Approach
1. **Reproduce** — get a minimal, consistent reproduction; if it's flaky, find the trigger
2. **Isolate** — bisect to the smallest unit that shows the failure (binary search the call stack)
3. **Read the error** — read the full stack trace; the actual error is often not the first line
4. **Hypothesize** — form one specific, falsifiable hypothesis about the cause
5. **Test** — add a failing test or log that confirms/refutes the hypothesis
6. **Fix** — change the smallest amount of code that resolves the root cause
7. **Verify** — run the reproduction again; confirm no regression in related tests

## Output Format
Use the FINDING TAG SCHEMA from the system prompt. Do NOT invent skill-specific output formats; they break parsing and cross-review.

## Don't
- Don't make multiple changes at once — you won't know which one fixed it
- Don't trust logs that could be stale or cached — add fresh instrumentation
- Don't fix the symptom when the root cause is elsewhere
- Don't skip the regression test — the bug will return
- Don't assume the bug is in the code you just changed
