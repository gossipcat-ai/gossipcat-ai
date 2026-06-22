---
name: emit-structured-claims
description: Emit a structured premise-claims JSON block alongside prose findings so the orchestrator can grep-verify code-shape claims and close the four Stage-1 bypass classes.
keywords: []
category: trust_boundaries
scope: [review, research]
status: active
---

## When this skill activates

Always on review and research dispatches. Emit a `premise-claims` block whenever your finding contains ANY of:

1. A file path + line number — *"at `file.ts:42`"*.
2. A count of callers / sites / handlers / files.
3. A claim of absence — *"X is not called"*, *"no handler emits Y"*.
4. A bypass-class phrase — *"several"*, *"a few"*, *"most"*, *"probably"*, *"I think"*, *"it looks like"*, *"all but"*, *"only N of M"*, *"none of"*.

## Iron law

Prose alone is not verifiable. If your finding rests on code shape — counts, line numbers, presence, absence — emit it as a structured claim too. The orchestrator will `rg`-check every claim before dispatch.

## How to emit

Append a fenced code block with the `premise-claims` info string AFTER your prose finding and BEFORE any suggested code. JSON with `schema_version`, `verifier`, and `claims` array. Full spec: `docs/specs/2026-04-22-premise-verification-stage-2.md`.

## Claim types (v1)

- `callsite_count` — `symbol`, `scope`, `expected` (int).
- `file_line` — `path`, `line` (int), `expected_symbol` (string).
- `absence_of_symbol` — `symbol`, `scope`, `context` (≤120 chars).
- `presence_of_symbol` — `symbol`, `scope`.
- `count_relation` — `symbol`, `scope`, `relation` (`>`, `<`, `=`, `≥`, `≤`), `value` (int).

## Modality (required on every claim)

- `asserted` — you checked; full strictness.
- `hedged` — not re-verified; falsification penalty halved.
- `vague` — no numeric commitment; pair with `range_hint: { min, max }` only when grounded. Omitting `range_hint` is the honest choice.

Omitting `modality` triggers a schema-lint warning and is scored as `asserted`.

## Uncertain about a line number?

Use `presence_of_symbol` scoped to the specific FILE (not a directory). Directory scope masks wrong-file errors; same-file scope preserves location information while dropping line precision.

- ✅ Line unknown: `{ type: "presence_of_symbol", symbol: "maybeAnnotate", scope: "apps/cli/src/sandbox.ts", modality: "asserted" }`
- ❌ Guessed line → fabricated citation. Drop the line, use `presence_of_symbol` with file scope.
