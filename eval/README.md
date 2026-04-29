# Curated Eval Suite

Fixed-corpus benchmark for agent review accuracy. Each case freezes a
"the bug was here, the fix landed in commit X" pair, replays it against a
configurable agent set, and scores findings against a known ground truth.

Spec: `docs/specs/2026-04-29-curated-eval-suite.md` (gitignored — see your
local checkout).

## Quick start

```bash
# Run the full suite against all native:true reviewers in .gossip/config.json
gossipcat eval

# Subset of cases / agents
gossipcat eval --cases eval/cases/2026-04-29-pr325-aria-expanded.yaml --agents sonnet-reviewer

# Paired before/after via McNemar (after a skill change, etc.)
gossipcat eval --against eval/.runs/2026-04-29T12-00-00-000Z
```

Output: a Markdown leaderboard on stdout plus per-run artefacts under
`eval/.runs/<runId>/` (gitignored).

## Case format

```yaml
id: pr325-abortcontroller            # short, kebab-case, unique
title: Human-readable case title
parent_sha: a3f36b7                  # commit BEFORE the fix
fix_sha: 0424bf8                     # commit that resolved it (optional)
fix_pr: 325                          # PR number (optional)
scope:
  files:
    - packages/dashboard-v2/src/components/ViolationsCard.tsx
ground_truth:
  - id: gt1                          # stable per-case identifier
    severity: medium                 # critical | high | medium | low
    file: packages/.../ViolationsCard.tsx
    line_range: [11, 15]             # inclusive [start, end]
    summary: useEffect fetch lacks cleanup; setState fires on unmount
    category: concurrency            # match the agent finding-tag categories
prompt: |
  The natural-language task the agent receives. NO ground-truth
  hints. NO answer leakage.
notes: |
  Free-form notes for case authors. Never sent to the agent.
```

A negative case sets `ground_truth: []`. The expectation is that consensus
emits zero findings — any non-empty output drops precision to 0.

## Scoring rubric

For each agent finding `f` against the case ground-truth list:

```
match(f, gt):
  if f.file != gt.file: 0
  if f.line outside gt.line_range ± 5: 0.5     # near miss
  if token_similarity(f.summary, gt.summary) > 0.6: 1.0
  if f.category == gt.category: 0.7
  else: 0.3
```

`token_similarity` is Jaccard on lowercased word-tokens after stopword strip.
Severity weights: `critical=4, high=2, medium=1, low=0.5`. A missed `critical`
ground truth costs 4× a missed `low`; same multiplier on the fabrication side.

Per-agent metrics are micro-averaged across cases:

```
Precision = Σ(match · w_finding) / Σ(w_finding)
Recall    = Σ(matched_gt_w)       / Σ(gt_w)
F1        = 2 · P · R / (P + R)
```

A case is considered "passed" by an agent when `F1 ≥ 0.5` — that's the
threshold McNemar pairing uses.

## Anti-contamination

The suite lives under `eval/cases/` and is checked into the repo. Mitigations:

1. **No ground truth in the dispatch prompt.** `prepareDispatchCase()` in
   `eval/harness.ts` is the single chokepoint: it builds the
   `DispatchableCase` from the loaded yaml, dropping the `ground_truth`
   block before any string ever reaches the agent. The
   `tests/eval/contamination.test.ts` test asserts that no ground-truth
   sentinel string appears in the prompt sent to the dispatcher.
2. **Hold-out cases.** Operators may drop additional cases in
   `eval/cases-private/` (gitignored). These are the real gate; the
   visible suite is the dev-loop signal.
3. **Suite rotation.** Add ≥10 new cases per quarter, retire equal number
   (PR C concern, not PR A).

## McNemar paired before/after

When testing a skill change, run the suite twice:

```bash
gossipcat eval                                     # writes runId R0
# ... develop or bind a new skill ...
gossipcat eval --against eval/.runs/R0             # writes R1, paired vs R0
```

Output 2x2:

|                  | After: pass | After: fail |
|------------------|-------------|-------------|
| **Before: pass** | a (no change) | b (regression) |
| **Before: fail** | c (improved)  | d (still failing) |

`χ² = (b - c)² / (b + c)`. We do **not** compute p-values; operator interprets
with df=1, or pipes χ² downstream. With N≈30 cases, `|b - c| ≥ 7` is roughly
p<0.05 — anything below that lacks the statistical power to declare a real
movement, only suggestive signal.

## Adding a case

1. Find a real PR in this repo where consensus / cross-review caught a
   real bug, and a fix commit landed. The PR description must cite the
   bug specifically.
2. Identify `parent_sha` (commit before the fix) and `fix_sha`. Confirm
   the bug is reproducible at `parent_sha` via local checkout.
3. Write `ground_truth[]` from the fix commit's actual changes — file,
   inclusive line range, one-sentence summary, category, severity.
4. Pick a `prompt` that mirrors what a reviewer would naturally be asked
   for that surface. Do NOT hint at the bug.
5. Add `notes:` describing what the failure mode looks like and why this
   case is in the suite.

For negative cases, set `ground_truth: []` and document the failure mode
the case is meant to catch in `notes:`.

## Files

| File              | Purpose                                                           |
|-------------------|-------------------------------------------------------------------|
| `harness.ts`      | `loadCases`, `runCase`, `runSuite`. Anti-contamination chokepoint. |
| `match.ts`        | `match()` rubric + `tokenSimilarity` (Jaccard, stopword strip).    |
| `score.ts`        | Precision / Recall / F1 with severity weights.                     |
| `report.ts`       | `formatLeaderboard`, `formatMcNemar`.                              |
| `cases/*.yaml`    | The visible suite.                                                 |
| `.runs/<runId>/`  | Per-case JSON + leaderboard.md + mcnemar.md (gitignored).          |
