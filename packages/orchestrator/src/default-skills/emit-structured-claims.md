---
name: emit-structured-claims
description: Emit a structured premise-claims JSON block alongside prose findings so the orchestrator can grep-verify code-shape claims and close the four Stage-1 bypass classes.
keywords: []
category: trust_boundaries
mode: permanent
status: active
---

## When this skill activates
Always — this is a permanent-mode skill for investigation agents
(`-researcher`, `-reviewer`). Your finding must include a `premise-claims`
JSON block whenever it contains ANY of:

1. **A file path + line number** — *"at `apps/cli/src/handlers/dispatch.ts:42`"*.
2. **A count of callers / sites / handlers / files** — *"5 sites call X"*,
   *"3 handlers emit Y"*, *"2 files reference Z"*.
3. **A claim of absence** — *"X is not called"*, *"no handler emits Y"*,
   *"Z is missing from scope"*.
4. **Any bypass-class phrase** — *"several"*, *"a few"*, *"most"*,
   *"probably"*, *"I think"*, *"it looks like"*, *"all but"*, *"only N of M"*,
   *"none of"*. These are the vague / hedged / inverted classes Stage 1
   regex cannot see; structured claims are the ONLY way they get verified.

## Iron law
Prose alone is not verifiable. If your finding rests on code shape — counts,
line numbers, presence, absence — emit it as a structured claim too. The
orchestrator will `rg`-check every claim before dispatch. Claims that
falsify mean your premise is wrong; ship the claim block and let the
pipeline catch the mistake before an implementer inherits it.

## How to emit
Append a fenced code block with the `premise-claims` info string AFTER your
prose finding and BEFORE any suggested code. The block is JSON with a
`schema_version`, `verifier`, and `claims` array. Spec:
`docs/specs/2026-04-22-premise-verification-stage-2.md`.

### Worked example

Given finding prose like:

> *"Five dispatch sites call `assembleUtilityPrompt` in
> `apps/cli/src/mcp-server-sdk.ts`; none of them pass the sentinel flag.
> `maybeAnnotateUnverifiedClaims` lives at `apps/cli/src/sandbox.ts:207`."*

Emit alongside:

```premise-claims
{
  "schema_version": "1",
  "verifier": "orchestrator",
  "claims": [
    { "type": "callsite_count", "symbol": "assembleUtilityPrompt",
      "scope": "apps/cli/src/mcp-server-sdk.ts", "expected": 5,
      "modality": "asserted" },
    { "type": "absence_of_symbol", "symbol": "SCOPE_NOTE",
      "scope": "apps/cli/src/handlers/dispatch.ts",
      "context": "preamble emission path", "modality": "asserted" },
    { "type": "file_line", "path": "apps/cli/src/sandbox.ts",
      "line": 207, "expected_symbol": "maybeAnnotateUnverifiedClaims",
      "modality": "asserted" }
  ]
}
```

## Claim types (v1 — see spec for full table)

- `callsite_count` — `symbol`, `scope`, `expected` (int). Verifier sums
  `rg --count-matches` across scope; compares against `expected`.
- `file_line` — `path`, `line` (int), `expected_symbol` (string). Verifier
  reads the file ±2 lines and string-matches `expected_symbol`.
- `absence_of_symbol` — `symbol`, `scope`, `context` (≤120 chars).
  Verifier requires `rg --count-matches` summed total of 0.
- `presence_of_symbol` — `symbol`, `scope`. Verifier requires total ≥ 1.
- `count_relation` — `symbol`, `scope`, `relation` (`>`, `<`, `=`, `≥`, `≤`),
  `value` (int). Use this for SUBSET forms like *"all but one of 5"* or
  *"only 1 of 5 is safe"* — NOT `negated:true`, which only encodes simple
  inequality against a total (bypass class I).

## Modality (required on every claim)

Classify your confidence at emit time — the verifier uses modality to scale
the falsification penalty.

- `asserted` — *"5 sites call X"* — you checked; verifier runs full strictness.
- `hedged` — *"~5 sites call X; not re-checked"* — you saw a number but
  didn't re-verify. Verifier still runs, falsification penalty is halved.
- `vague` — *"several sites call X"* — no numeric commitment. Pair with
  `range_hint: { min, max }` only when you have grounded reason to believe
  a range. If `range_hint` is absent, the verifier records the observed
  count but returns `unverifiable_by_grep` — it will NOT fabricate a
  falsification. Omitting `range_hint` is the honest choice when you do
  not know the count; inventing bounds to satisfy the schema is worse
  than staying prose-vague.

Omitting the `modality` field entirely is a schema-lint warning; the
verifier treats a missing field as `asserted` (strictest path) and logs
the violation. Always include `modality` explicitly.

### Uncertain about a line number? Use `presence_of_symbol` — scoped to the same file.

Anchor mismatches (wrong line, or worse, wrong file) are the dominant
observed failure mode. If you are not directly looking at the cited line
as you write the claim, **do not use `file_line`** — a guessed line
becomes a fabricated citation, which is the most expensive kind of
hallucination.

The safe fallback is `presence_of_symbol` scoped to **the specific file
you believe the symbol lives in** — not a directory. A directory scope
passes whenever the symbol appears anywhere in the subtree (including
tests, stale comments, unrelated modules), which turns a line-number
error into a silent wrong-file error. Same-file scope preserves location
information even though you've dropped line precision.

- ✅ *"`maybeAnnotate` is in `sandbox.ts`"* (line unknown) →
  `{ type: "presence_of_symbol", symbol: "maybeAnnotate", scope: "apps/cli/src/sandbox.ts", modality: "asserted" }`
- ✅ *"`maybeAnnotate` is at `sandbox.ts:207`"* (looking at line 207) →
  `{ type: "file_line", path: "apps/cli/src/sandbox.ts", line: 207, expected_symbol: "maybeAnnotate", modality: "asserted" }`
- ❌ *"`maybeAnnotate` lives around line 290 of `sandbox.ts`"* (guessed line)
  → fabricated citation. Drop the line, keep the file: use `presence_of_symbol` with `scope: "apps/cli/src/sandbox.ts"`.
- ❌ *"`maybeAnnotate` is somewhere in `apps/cli/src/`"* (directory scope)
  → masks wrong-file errors. If you don't know the file either, the honest choice is prose with `modality: "vague"` and no claim — not a directory-scoped presence check.

## When to use `count_relation` vs `negated:true`

- `negated: true` on `callsite_count` — encodes "observed count ≠ expected".
  Use only for simple inequality claims.
- `count_relation` — use for subset forms. *"All but one of the 5 sites"* →
  `{ type: "count_relation", symbol: "...", scope: "...", relation: "=",
  value: 4 }` (4 of 5). *"Only 2 of 5 are safe"* → `relation: "="`,
  `value: 2`. *"None of 5"* → `relation: "="`, `value: 0`.

## Compound sentences → multiple claim objects

One prose sentence can pack count + file:line + absence. Decompose into N
separate claim objects in the `claims` array. The verifier reports
per-claim outcomes; dispatch annotation cites only the subset that failed
or could not be verified.

### Example

Prose: *"`persistRelayTasks` is called 3× in `dispatch.ts` and 1× in
`collect.ts`; `doBoot` at `mcp-server-sdk.ts:465` calls `restoreNativeTaskMap`."*

The realistic compound failure is NOT a malformed "X and Y" symbol — it's
**silent partial coverage**: emitting one claim, treating the rest as
covered by prose.

❌ BAD (only the easiest claim emitted; two load-bearing assertions slip
through as unverified prose):
```json
{ "type": "callsite_count", "symbol": "persistRelayTasks",
  "scope": "apps/cli/src/handlers/dispatch.ts", "expected": 3, "modality": "asserted" }
```

✅ GOOD (one claim per prose assertion; none of the three load-bearing
pieces can slip through without verification):
```json
{ "type": "callsite_count", "symbol": "persistRelayTasks",
  "scope": "apps/cli/src/handlers/dispatch.ts", "expected": 3, "modality": "asserted" }
{ "type": "callsite_count", "symbol": "persistRelayTasks",
  "scope": "apps/cli/src/handlers/collect.ts", "expected": 1, "modality": "asserted" }
{ "type": "file_line", "path": "apps/cli/src/mcp-server-sdk.ts", "line": 465,
  "expected_symbol": "restoreNativeTaskMap", "modality": "asserted" }
```

If a prose sentence has N verifiable assertions and your `claims[]`
array has fewer than N entries, the missing assertions become unverified
prose — no penalty when wrong, no signal when right.

## Anti-patterns

- **Do NOT fabricate counts** to satisfy the schema. If you did not grep,
  use `modality: "vague"` without `range_hint`. A `vague`-unverifiable
  verdict is 0× penalty; a fabricated `asserted` that falsifies is 3×.
- **Do NOT emit claims for untestable scopes.** The verifier runs local
  `rg` inside the project root; claims about remote repos, runtime
  behavior, or semantic intent cannot be verified and will return
  `unverifiable_by_grep`. Keep those as prose.
- **Do NOT omit modality.** Missing field triggers a schema-lint warning
  and is scored as `asserted` (strictest) — you lose the hedge discount.
- **Do NOT combine `absence_of_symbol` with `negated: true`.** That is
  just `presence_of_symbol`; schema-lint rejects on emit.

## Why this skill exists

Stage 1 regex catches literal-numeral + TARGETS-noun patterns over prose
("5 sites call X"). It silently passes four bypass classes: **vague**
(*"several sites"* — no numeric anchor), **hedged** (*"probably 5"* — no
uncertainty marker to the regex), **inverted** (*"all but 1 of 5"* — the
count matches, the semantically load-bearing negation doesn't), and
**compound** (one sentence, three claims — regex fires once). Structured
claims give each of these an explicit schema representation. See
`docs/specs/2026-04-22-premise-verification-stage-2.md` for the full
rationale and the adoption plan toward Stage 1 sunset.
