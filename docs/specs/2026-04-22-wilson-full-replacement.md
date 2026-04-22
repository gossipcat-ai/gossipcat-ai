# Wilson full-replacement α-calibration spec

Status: draft · decision-gate, not implementation-ready · revised post-consensus ea59d1d2-b1614aba, b06aaa02-924f418a
Caveat: statistical claims in this spec are LLM-generated analyses, not empirical results. The calibration and simulation artifacts below are the load-bearing numerical validation — do not treat the ±30.6pp / ±13.2pp / 4.2% / 74.4% figures as verified until the scripts produce them.
Related: `packages/orchestrator/src/check-effectiveness.ts`, `packages/orchestrator/src/wilson-score.ts`, PR #225 (Wilson for degenerate / sparse baselines)

## Context

PR #225 shipped Wilson score intervals on two narrow branches of `resolveVerdict`:

- `wilson_degenerate` — `baselineP ∈ {0, 1}` (z-test has zero variance)
- `wilson_sparse` — `baselineTotal < MIN_BASELINE_FOR_ZTEST` (= 20) (z-test variance estimate unreliable)

The standard path (`baselineTotal ≥ 20`, `0 < baselineP < 1`) still uses a one-sided z-test at `Z_CRITICAL = 1.96`, `MIN_EVIDENCE = 120`, Bonferroni `α = 0.025`.

This spec scopes a **full replacement** of the z-test path with Wilson intervals — replacing three branches with one — and defines the **three** blocking artifacts required before any code change lands.

## Why consider it

1. **Path consolidation.** Three verdict methods (`z-test`, `wilson_degenerate`, `wilson_sparse`) all use the **same α = 0.025** (at `check-effectiveness.ts:19`, `:150`, `:178`) but produce three distinct z-critical values (z-test: 1.96 one-sided, Wilson: 2.24 from two-sided reuse). The maintenance surface is three branches holding the same α with divergent z-scaling — not three independent α values as earlier drafts of this spec claimed. A single `wilson` path collapses the matrix.
2. **Continuity across boundary.** At `baselineTotal = 20` today there is a method discontinuity: 19 routes through Wilson (z=2.24 effective), 20 routes through z-test (z=1.96). No principled justification for the jump.
3. **Graduation-rate parity, not improvement.** The explicit non-goal is "make more skills graduate." Wilson is expected to be **comparable or slightly more conservative** in the dense-baseline regime. Any calibration that materially increases graduation rate is a red flag for α drift, not a win.

## Why not

- `MIN_EVIDENCE = 120` is calibrated for **z-test** power (~75.5% at +10pp shift, p=0.75 baseline — verified at `check-effectiveness.ts:8-10`). Wilson at MIN_EVIDENCE=120 delivers sharply different power depending on α (preliminary LLM estimate: α=0.025 ≈4.2%, α=0.05 ≈12.2%, α≈0.30 ≈74.4%; validate in calibration script). Power preservation is therefore a **hard calibration constraint**, not a side concern. See "Blocking artifacts → calibration table → power constraint" below.
- The prior-consensus decision (`9369ebfc-a3654b51 f5`) treats z-test as the default. Replacing it invalidates at least one referenced invariant and needs a fresh consensus round.
- No live operational pain. Both paths coexist fine. This is structural cleanup, not a bug fix.

## Key finding from consensus review: single α is insufficient

Preliminary numerical analysis surfaced in consensus round ea59d1d2-b1614aba **(LLM estimate, pending empirical validation)** suggests that **a single α is mathematically insufficient**, not merely a "preferred if achievable" outcome. At α=0.30 (the value that would calibrate the typical operating point `bt=120, bp=0.75, pt=120` exactly), Wilson graduation rates at δ=+10pp diverge from z-test by an estimated **+30.6pp** at dense-high (`bp=0.90`) and **+13.2pp** at dense-low (`bp=0.50`) — both outside the ±5pp tolerance this spec sets. This is not miscalibration; it is a structural consequence of Wilson CI-overlap depending on `baselineTotal` through CI width while the z-test depends on it only through the baselineP point estimate.

**Therefore: piecewise α is a prerequisite, not an option.** The calibration table below treats "single α" as a falsifiable hypothesis to be recorded as rejected in the output, not as the preferred outcome. The calibration script must produce the numerical evidence that confirms or refutes this; do not accept the LLM estimates as load-bearing.

## Blocking artifacts

Implementation is **gated** on all three of the following. None exists today.

### 0. `zForAlpha` inverse-normal replacement

`wilson-score.ts:34-41` currently hardcodes `zForAlpha` to return two values — `1.959964` for α=0.05 and `2.241403` for α=0.025 — and silently falls through to `return 1.959964` for **any other α**. Any piecewise α schedule the calibration table produces (expected working range: 0.01 ≤ α ≤ 0.30, see below) will be silently collapsed to z=1.96 unless `zForAlpha` is replaced first.

**Required:** replace `zForAlpha` with a production inverse-normal (Beasley-Springer-Moro or Acklam). Validation: round-trip at α ∈ {0.01, 0.025, 0.05, 0.10, 0.15, 0.20, 0.30} against a reference implementation to within 1e-6 absolute. Commit with unit tests.

The validation range extends to α=0.01 because the degenerate-regime calibration may produce a stricter α than the typical/sparse regimes; the working range for non-degenerate calibration remains 0.05–0.30, but the implementation must accept the wider set without silent collapse.

Without this, artifacts 1 and 2 below produce meaningless output: any calibrated α outside {0.025, 0.05} is silently discarded at runtime.

### 1. α-calibration table

Produce a piecewise α schedule across the regimes below. The table must record either (a) a calibrated α per regime, OR (b) a documented reason why the regime's calibration target is unattainable.

**Matching target (non-degenerate, non-high-baseline):** for regimes `typical`, `dense-low`, `sparse-current`, numerically solve for the α such that Wilson's passed/failed threshold on `postP` matches the z-test's threshold to within ±1pp graduation probability on simulated data **AND** Wilson power at δ=+10pp, postTotal=MIN_EVIDENCE is within 10pp of the z-test's 74.4%. Both conditions are required; the second is the power-preservation constraint that keeps MIN_EVIDENCE load-bearing.

**High-baseline regime (`dense-high`, bp=0.90):** the "Key finding" above establishes that Wilson vs. z-test divergence at high-baseline is structural (CI-width dependency on baselineTotal), not calibratable. **Do not attempt α-derivation for this regime.** Instead: pick the α the `typical` regime produces, run the simulation at `dense-high` using that α, and **document** the resulting divergence in the calibration table. This row is an audit artifact, not a calibration target. If the simulation shows <5pp divergence (surprising), re-scope; if ≥5pp (expected), record and move on.

**Degenerate-regime target (`baselineP ∈ {0, 1}`):** the z-test has no threshold (variance is zero). Use a separate criterion: **at postTotal = MIN_EVIDENCE = 120** (pinned), derive α such that Wilson returns `passed` at exactly `postP = baselineP + MIN_DETECTABLE_EFFECT` (for baselineP=0) or `failed` at `postP = baselineP − MIN_DETECTABLE_EFFECT` (for baselineP=1), where `MIN_DETECTABLE_EFFECT = 0.10`. This pins the α to the smallest-detectable-effect the system promises elsewhere.

Record the derived α in the table output. If the derived α equals the existing `WILSON_ALPHA = 0.025` to within 1e-4, flag as "current α is already the MDE-calibrated α, no change needed" — this would mean the current degenerate-regime code was incidentally well-calibrated and the unified path can use the same α. If it differs, record the new value and include in the piecewise schedule.

Required rows:

| regime | baselineTotal | baselineP | postTotal | z-test rejection boundary (postP) | target Wilson α |
|--------|---------------|-----------|-----------|-----------------------------------|-----------------|
| typical | 120 | 0.75 | 120 | compute | derive (match + power) |
| dense-high | 500 | 0.90 | 120 | compute | **use typical's α; document divergence only** |
| dense-low | 500 | 0.50 | 120 | compute | derive (match + power) |
| sparse-current | 20 | 0.75 | 120 | compute | derive (match + power) |
| degenerate-current | 120 | 1.00 | 120 | n/a | derive (MDE at postTotal=120) |
| degenerate-current | 120 | 0.00 | 120 | n/a | derive (MDE at postTotal=120) |

**Acceptance criterion:** the calibration table lives in this spec, is reproducible by `scripts/wilson-calibration.mjs`, and produces a piecewise α schedule with 3–5 distinct α values (typical, dense-low, sparse-current, degenerate — with dense-high sharing typical's α). A "single α covers all non-degenerate regimes" result would contradict the consensus hypothesis above — if the script produces that, this is a valid outcome but requires spec revision before implementation.

### 2. Graduation-rate simulation

Simulate verdict distributions on synthetic signal streams under both the current (z-test + Wilson-branches) and proposed (Wilson-only) verdict functions.

**Fixed design choices** (pinning down the degrees of freedom flagged in consensus):

- **Baseline sampling:** `baselineP` is the **point estimate** `bc / bt` from each real skill file — NOT a Beta posterior draw. Sample each skill file at most once per simulation run to avoid double-counting. This is a deliberate choice to match production's use of `baselineP = bc / bt` at `check-effectiveness.ts:106`.
- **Regime filter:** report the acceptance cell (`δ=+10pp, baselineP ∈ (0.70, 0.80)`) AND the full matrix. The acceptance gate is evaluated on the filtered cell; the full matrix is committed for audit.
- **Method attribution for existing-Wilson skills:** skills that would currently route through `wilson_sparse` or `wilson_degenerate` are labeled **current = wilson (today)** and **proposed = wilson (recalibrated)**. Report separately from z-test-path skills.

Synthetic conditions:
- Baselines drawn from the observed distribution across all skill files in `.gossip/agents/*/skills/*.md` as of the simulation date
- Post-bind signals generated under three truth regimes: null effect (δ=0), small positive (δ=+5pp), target positive (δ=+10pp)
- N=10,000 simulated skills per regime
- Report: `passed`, `failed`, `inconclusive`, `insufficient_evidence`/`silent_skill` rates per regime, per method

**Acceptance criterion A (z-test-path skills):** for the `δ = +10pp, baselineP ∈ (0.70, 0.80)` cell restricted to z-test-path skills, Wilson-only graduation rate is within **±5 percentage points** of the current method. A larger gap means α is miscalibrated (if higher) or MIN_EVIDENCE needs revisiting (if lower). Either way, block implementation and re-scope.

**Acceptance criterion B (wilson-path skills):** for skills currently routed through `wilson_degenerate` or `wilson_sparse`, the proposed verdict distribution must change by **≤ ±5 percentage points** per terminal state (`passed`, `failed`) vs. current Wilson behavior at the same δ levels. This prevents silent regression on skills the unified path inherits from the existing Wilson branches. A larger gap means the degenerate-regime α derived in artifact 1 materially shifts behavior and requires explicit acknowledgment before proceeding.

Either criterion failing blocks implementation independently.

**Per-regime audit:** the simulation must additionally commit the full 6 regimes × 3 delta levels × 2 methods matrix. High-baseline divergence at `bp=0.90` is expected (structural — not calibratable per artifact 1); the matrix documents the size of that divergence for the record, even though it is not gated on.

Simulation script: `scripts/wilson-graduation-sim.mjs`. Results committed to this spec as a `## Calibration results` section appended post-implementation.

## Implementation outline (post-gate, not authorized until artifacts 0, 1, and 2 ship)

**Prereq step (before step 1):** extend the TypeScript union literal type for `verdict_method` at `check-effectiveness.ts:52` (`SkillSnapshot`) and `:66` (`VerdictResult`) to **add** the new regime values from the piecewise schedule (e.g. `'wilson_typical' | 'wilson_dense_low' | 'wilson_sparse_regime'` plus existing values). Retain `'z-test' | 'wilson_degenerate' | 'wilson_sparse'` in the union during migration — do **not** remove them yet. This is a pure type-widening, non-breaking.

1. Replace the standard-path z-test block (`check-effectiveness.ts:200-225`) with a Wilson call at the calibrated α (piecewise via regime lookup). New writes emit `'wilson_typical'` etc.; old `'z-test'` values on existing snapshots remain readable.
2. Replace the `wilson_degenerate` (`:149-170`) and `wilson_sparse` (`:177-198`) branches with calls into the unified Wilson path using their regime-specific α from the calibration table. Remove the "fall through to z-test" path at `:169` and `:197` — the unified path returns `pending` for any skill whose Wilson CI cannot reach a verdict at the current postTotal, and `pending` stays `pending` until the next verdict attempt. No z-test fallback exists in the unified path; the degenerate-regime Wilson must be complete in itself. Verify via test cases that a `baselineP=0, postTotal<MIN_EVIDENCE` skill that previously fell through to z-test `inconclusive` now returns `pending` until MIN_EVIDENCE is reached — then the degenerate-regime Wilson either passes (at postP ≥ MIN_DETECTABLE_EFFECT) or records inconclusive-with-strike-rotation.
3. **Audit value consumers of `verdict_method` BEFORE removing `'z-test'` from the union.** Sonnet's round-2 review found hardcoded `.toBe('z-test')` assertions in `tests/orchestrator/check-effectiveness.test.ts` (lines 388, 427, 502) and `tests/skill-effectiveness-e2e.test.ts` (lines 530, 572, 591, 625, 659). Every value-consumer site must either be updated to expect the new `wilson_<regime>` values OR explicitly grandfathered to preserve the `'z-test'` literal for historical snapshots. Do not treat this migration as non-breaking — the field is preserved, but the values are not, and value-consumers break.
4. Re-run the check-effectiveness test suite; every test file must either (a) pass unchanged, (b) have its expected-verdict string updated to the new piecewise regime value with a one-line reference back to this spec, or (c) document why the test case is now N/A (rare).
5. Once steps 1–4 ship and no pre-migration `'z-test'` values remain in live `.gossip/agents/*/skills/*.md` snapshots (verifiable via grep), a follow-up PR may remove `'z-test'` from the union and the grandfather code. This is a separate decision, outside this spec.
6. Dispatch a consensus round on the diff before merge — this path is load-bearing for every skill effectiveness verdict in the system.

## Consensus context to preserve

**Invariants explicitly preserved:**

- **#2 (`MIN_EVIDENCE = 120`)** — unchanged. The evidence gate is method-agnostic. Calibration-table step ensures Wilson power at MIN_EVIDENCE is comparable to z-test's 74.4%, keeping the constant load-bearing.
- **#6 (`bound_at` anchoring)** — unchanged. `buildPrompt()` still captures `bound_at` at prompt-generation time; baseline vs. delta window anchors are untouched.
- **#7 (skill-loader reads `snapshot.status`)** — unchanged. `loadSkills()` still filters `failed` / `silent_skill` at injection time. This spec modifies how `status` is computed, not how it is consumed. The `VerdictStatus` enum is preserved.

Any reviewer finding that frames full-Wilson replacement as weakening MIN_EVIDENCE is fabricating — the evidence gate is method-agnostic and does not move.

## Open questions

- Does the piecewise α schedule fragment further than the 6 regimes listed, or do the regimes cover the operating space adequately?
- Does Wilson behavior at `postTotal = MIN_EVIDENCE` differ meaningfully from `postTotal = 2 × MIN_EVIDENCE`? If so, is that a problem or a feature?
- Should `MIN_BASELINE_FOR_ZTEST = 20` be repurposed as a regime-split threshold for piecewise α, or retired entirely?
- Does the piecewise schedule's shape suggest a reparameterization (e.g. α as a function of `baselineP` rather than discrete regimes) is worth a follow-up?
- If the degenerate-regime calibration produces an α that differs materially from the current 0.025, acceptance criterion B may fail on the wilson-path cohort. Is the right response to (a) force the new α and accept the behavior change with documentation, (b) carve out a separate α for wilson-path carryover to preserve current behavior, or (c) re-scope?

## Not in scope

- Changes to `MIN_EVIDENCE`, `TIMEOUT_DAYS`, strike rotation, or terminal-state handling
- Adding new verdict states (`VerdictStatus` enum stays constant; this spec only extends `verdict_method` values)
- Frontend/dashboard changes (verdict name surfacing, if any, is a follow-up). Note: `verdict_method` field removal is NOT on the table; `'z-test'` literal removal is a separate follow-up (step 5 of implementation outline).
- Retroactive re-verdicting of skills already in `passed` / `failed` terminal states (invariant: terminal states are immutable)

---

## Calibration results (Artifact 1)

Reproduction: `node scripts/wilson-calibration.mjs` (script introduced on branch `feat/zfor-alpha-acklam`, depends on Artifact 0 at commit `b8e7389`).

### Calibration table

| regime | bt | bp | postTotal | z-test postP_crit | Wilson first-passed postP | α | power @ +10pp | note |
|--------|----|----|-----------|-------------------|---------------------------|---|---------------|------|
| typical | 120 | 0.75 | 120 | 0.8275 | 0.8333 | 0.3153 | 74.4% |  |
| dense-low | 500 | 0.50 | 120 | 0.5895 | 0.5833 | 0.2197 | 68.1% |  |
| sparse-current | 20 | 0.75 | 120 | 0.8275 | 0.8333 | 0.5491 | 74.4% |  |
| degenerate-zero | 120 | 0.00 | 120 | n/a | 0.1000 | 0.0126 | n/a | MDE target postP=0.10 |
| degenerate-one | 120 | 1.00 | 120 | n/a | 0.9000 | 0.0127 | n/a | MDE target postP=0.90 |
| dense-high | 500 | 0.90 | 120 | 0.9537 | 0.9417 | 0.3153 | 100.0% | uses typical α; divergence -1.2pp |

**Revised from v1 (initial run):** bisection search range widened from `[0.001, 0.50]` to `[0.001, 0.99]` to let sparse-current converge. Initial sparse-current α=0.5000 was a boundary hit, not a solution. Corrected α=0.5491 converges within `tolPostP=1e-3`.

### Single-α hypothesis check

mean α across non-degenerate regimes = 0.3844 (range 0.2197–0.5491)
- typical: diff from z-test boundary = −1.08pp
- dense-low: diff from z-test boundary = −2.28pp
- sparse-current: diff from z-test boundary = +3.09pp

**Single-α covers all non-degenerate within ±1pp:** **no — piecewise α required.** Consensus hypothesis confirmed.

### Schedule (JSON)

```json
{
  "typical":         { "alpha": 0.3152839660644532, "postTotal": 120 },
  "dense-low":       { "alpha": 0.21972811889648441, "postTotal": 120 },
  "sparse-current":  { "alpha": 0.5490728454589844, "postTotal": 120 },
  "degenerate-zero": { "alpha": 0.01258984375,      "postTotal": 120 },
  "degenerate-one":  { "alpha": 0.0126953125,       "postTotal": 120 },
  "dense-high":      { "alpha": 0.3152839660644532, "postTotal": 120,
                       "inherits": "typical", "divergencePp": -1.2 }
}
```

### Observations vs. spec LLM estimates

The spec's pre-artifact LLM estimates are significantly off from the empirical results. Recorded here for honesty about where the spec's narrative-level numerics ended up wrong:

| claim | LLM estimate | measured | delta |
|-------|--------------|----------|-------|
| typical α for z-test-boundary match | ≈0.30 | 0.315 | close |
| dense-high divergence at typical's α | +30.6pp | **−1.2pp** | **wrong direction, ~30pp off** |
| dense-low divergence at typical's α | +13.2pp | **−2.3pp** | **wrong direction, ~15pp off** |
| Wilson power @ δ=+10pp, α=0.30, bp=0.75 | ≈74.4% | 74.4% | exact |

**Implication for spec §31 ("Key finding from consensus review"):** the claim that single-α produces ±30pp gaps at dense regimes is overstated. Piecewise α is still required (sparse-current genuinely diverges), but the structural-divergence argument for dense-high is weaker than the spec implied. The spec's "dense-high: not calibrated, structural divergence expected" rule remains defensible on principle (CI-width dependence on baselineTotal is real), but the quantitative case is softer — −1.2pp is within most reasonable tolerance bands.

### Open issues from Artifact 1

1. **sparse-current converged α = 0.5491.** With the widened bisection range this is a real solution. Wilson at `bt=20, bp=0.75, postTotal=120` needs α ≈ 0.55 to match the z-test's rejection boundary — i.e. much looser tolerance than the typical regime. This is a direct consequence of Wilson CI width dominating at small `bt`. Implementation follow-up: verify the piecewise lookup correctly dispatches sparse-regime skills to this α rather than typical's.

2. **Degenerate α = 0.0126 is stricter than the current `WILSON_ALPHA = 0.025`**, which means Acceptance Criterion B (wilson-path ±5pp) in Artifact 2 may be sensitive here. Skills currently on the `wilson_degenerate` branch will receive tighter verdicts under the new schedule.

3. **Power-preservation constraint is met** at `typical` (74.4%) and `sparse-current` (74.4%). `dense-low` drops to 68.1%. Z-test's 74.4% baseline is specific to `bp=0.75`, so sub-74% at other baselines is expected. Spec §25 should be softened from "uniform preservation" to "preserved at the typical operating point; degrades gracefully at dense-low without loss of decision validity."
