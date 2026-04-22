#!/usr/bin/env node
// Wilson α-calibration script — Artifact 1 of docs/specs/2026-04-22-wilson-full-replacement.md
//
// For each regime, numerically solve for the Wilson-interval α such that the
// wilsonVerdict decision boundary matches (or achieves the degenerate-regime
// MDE target from) the z-test reference.
//
// Inlines Acklam inverse-normal and Wilson score (mirror of
// packages/orchestrator/src/wilson-score.ts at commit b8e7389), no external
// dependencies — Node ESM, matches pattern of scripts/audit-memories.mjs.
//
// Usage:
//   node scripts/wilson-calibration.mjs
//
// Output:
//   - Markdown calibration table to stdout
//   - JSON schedule blob to stdout (fenced)

import process from 'node:process';

// ---------------------------------------------------------------------------
// Acklam inverse-normal CDF (mirrors wilson-score.ts)
// ---------------------------------------------------------------------------

function inverseNormalCDF(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q, r, x;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    x =
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) *
        q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
}

function zForAlpha(alpha) {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError(`zForAlpha: alpha must be in (0, 1), got ${alpha}`);
  }
  return inverseNormalCDF(1 - alpha / 2);
}

// ---------------------------------------------------------------------------
// Wilson score interval + verdict (mirror of wilson-score.ts)
// ---------------------------------------------------------------------------

function wilsonScoreInterval(correct, total, alpha) {
  if (total <= 0) return { lower: 0, upper: 1 };
  if (correct < 0) correct = 0;
  if (correct > total) correct = total;
  const z = zForAlpha(alpha);
  const n = total;
  const pHat = correct / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin =
    (z * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n))) / denom;
  const lower = Math.max(0, center - margin);
  const upper = Math.min(1, center + margin);
  return { lower, upper };
}

function wilsonVerdict(baseline, post, alpha) {
  const b = wilsonScoreInterval(baseline.correct, baseline.total, alpha);
  const p = wilsonScoreInterval(post.correct, post.total, alpha);
  if (p.lower > b.upper) return 'passed';
  if (p.upper < b.lower) return 'failed';
  return 'pending';
}

// ---------------------------------------------------------------------------
// z-test boundary: smallest postP at which one-sided z-test rejects H0: p = bp
// postP_crit = bp + 1.96 * sqrt(bp*(1-bp)/postTotal)
// ---------------------------------------------------------------------------

function zTestCritPostP(bp, postTotal) {
  return bp + 1.96 * Math.sqrt((bp * (1 - bp)) / postTotal);
}

// For a given α, find the smallest postP (at integer postCorrect) at which
// wilsonVerdict returns 'passed'. Returns postP or NaN if never passes.
function firstPassedPostP(bt, bp, postTotal, alpha) {
  const baseline = { correct: Math.round(bt * bp), total: bt };
  for (let pc = 0; pc <= postTotal; pc++) {
    const v = wilsonVerdict(baseline, { correct: pc, total: postTotal }, alpha);
    if (v === 'passed') return pc / postTotal;
  }
  return NaN;
}

// Wilson "power" at δ=+10pp: simulate? We use analytic — probability that
// Wilson passes when truthP = bp + 0.10, via normal approx to Binomial(postTotal, truthP).
// But easier + reproducible: exhaustive binomial PMF sum.
function wilsonPowerAtDelta(bt, bp, postTotal, alpha, delta) {
  const truthP = bp + delta;
  if (truthP <= 0 || truthP >= 1) {
    // Degenerate — use boundary, Wilson passes when postCorrect produces disjoint CI.
  }
  const baseline = { correct: Math.round(bt * bp), total: bt };
  // Find threshold postCorrect where wilson first passes
  let threshold = -1;
  for (let pc = 0; pc <= postTotal; pc++) {
    const v = wilsonVerdict(baseline, { correct: pc, total: postTotal }, alpha);
    if (v === 'passed') {
      threshold = pc;
      break;
    }
  }
  if (threshold < 0) return 0;
  // Power = P(postCorrect >= threshold | truthP)
  // Clamp truthP for binomial
  const tp = Math.max(1e-9, Math.min(1 - 1e-9, truthP));
  return binomialTailGE(postTotal, tp, threshold);
}

// P(X >= k) where X ~ Binomial(n, p) — log-space for numerical safety.
function binomialTailGE(n, p, k) {
  // Compute log(pmf(i)) for i in [k, n] and log-sum-exp.
  const logP = Math.log(p);
  const log1mP = Math.log(1 - p);
  // log C(n, i) iteratively from i=0
  const logFact = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) logFact[i] = logFact[i - 1] + Math.log(i);
  const logChoose = (i) => logFact[n] - logFact[i] - logFact[n - i];
  let maxLog = -Infinity;
  const terms = [];
  for (let i = k; i <= n; i++) {
    const lp = logChoose(i) + i * logP + (n - i) * log1mP;
    terms.push(lp);
    if (lp > maxLog) maxLog = lp;
  }
  if (!Number.isFinite(maxLog)) return 0;
  let s = 0;
  for (const lp of terms) s += Math.exp(lp - maxLog);
  return Math.exp(maxLog) * s;
}

// ---------------------------------------------------------------------------
// Bisection: find α ∈ [αLo, αHi] matching target postP on firstPassedPostP.
// Wilson is more conservative at smaller α → firstPassedPostP is monotonically
// DECREASING in α. So: if current firstPassed > target, need LARGER α.
// ---------------------------------------------------------------------------

function bisectAlphaMatch(bt, bp, postTotal, targetPostP, opts = {}) {
  const tolAlpha = opts.tolAlpha ?? 1e-4;
  const tolPostP = opts.tolPostP ?? 1e-3;
  let lo = opts.lo ?? 0.001;
  let hi = opts.hi ?? 0.99;
  const fLo = firstPassedPostP(bt, bp, postTotal, lo);
  const fHi = firstPassedPostP(bt, bp, postTotal, hi);
  // Guard: if both sides miss target same direction, return bound
  let best = { alpha: NaN, postP: NaN };
  for (let iter = 0; iter < 80; iter++) {
    const mid = 0.5 * (lo + hi);
    const fMid = firstPassedPostP(bt, bp, postTotal, mid);
    best = { alpha: mid, postP: fMid };
    if (hi - lo < tolAlpha) break;
    if (!Number.isFinite(fMid)) {
      // Too conservative — widen α
      lo = mid;
      continue;
    }
    if (Math.abs(fMid - targetPostP) < tolPostP) break;
    // firstPassed decreases with α. If fMid > target, need larger α.
    if (fMid > targetPostP) lo = mid;
    else hi = mid;
  }
  return best;
}

// Degenerate regime: for bp=0 solve α such that wilsonVerdict passes at postP = 0.10
// For bp=1 solve α such that wilsonVerdict FAILS at postP = 0.90.
// At bp=0, baseline CI upper decreases as α grows (wider CI → larger upper → harder to pass).
// Wait: LARGER α → smaller z → NARROWER CI → baseline upper LOWER → EASIER to pass.
// firstPassedPostP decreasing in α still holds.
function bisectAlphaDegenerate(bp, postTotal) {
  const bt = 120;
  if (bp === 0) {
    // We want firstPassedPostP == 0.10 exactly (or closest)
    return bisectAlphaMatch(bt, bp, postTotal, 0.10, {});
  }
  // bp === 1: want wilson to FAIL at postP = 0.90 (i.e. 0.90 first-fails at that α)
  // firstFailedPostP: smallest postP at which verdict == 'failed' when decreasing pc.
  // We iterate pc from postTotal downward.
  const target = 0.90;
  let lo = 0.001, hi = 0.5;
  let best = { alpha: NaN, postP: NaN };
  const firstFailedPostP = (alpha) => {
    const baseline = { correct: bt, total: bt };
    for (let pc = postTotal; pc >= 0; pc--) {
      const v = wilsonVerdict(
        baseline,
        { correct: pc, total: postTotal },
        alpha,
      );
      if (v === 'failed') return pc / postTotal;
    }
    return NaN;
  };
  for (let iter = 0; iter < 80; iter++) {
    const mid = 0.5 * (lo + hi);
    const fMid = firstFailedPostP(mid);
    best = { alpha: mid, postP: fMid };
    if (hi - lo < 1e-4) break;
    if (!Number.isFinite(fMid)) {
      lo = mid;
      continue;
    }
    if (Math.abs(fMid - target) < 1e-3) break;
    // LARGER α → narrower CI → baseline lower INCREASES → easier to fail
    // → firstFailedPostP (largest postP that fails) INCREASES with α.
    if (fMid < target) lo = mid;
    else hi = mid;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Regime definitions
// ---------------------------------------------------------------------------

const REGIMES = [
  { name: 'typical', bt: 120, bp: 0.75, postTotal: 120, kind: 'match' },
  { name: 'dense-low', bt: 500, bp: 0.50, postTotal: 120, kind: 'match' },
  { name: 'sparse-current', bt: 20, bp: 0.75, postTotal: 120, kind: 'match' },
  { name: 'degenerate-zero', bt: 120, bp: 0.00, postTotal: 120, kind: 'degenerate' },
  { name: 'degenerate-one', bt: 120, bp: 1.00, postTotal: 120, kind: 'degenerate' },
];

const DENSE_HIGH = { name: 'dense-high', bt: 500, bp: 0.90, postTotal: 120 };

function main() {
  const rows = [];
  const schedule = {};

  for (const r of REGIMES) {
    if (r.kind === 'match') {
      const target = zTestCritPostP(r.bp, r.postTotal);
      const { alpha, postP } = bisectAlphaMatch(r.bt, r.bp, r.postTotal, target);
      const power = wilsonPowerAtDelta(r.bt, r.bp, r.postTotal, alpha, 0.10);
      rows.push({
        regime: r.name,
        bt: r.bt,
        bp: r.bp,
        postTotal: r.postTotal,
        zTestCritPostP: target,
        wilsonFirstPassedPostP: postP,
        alpha,
        powerAt10pp: power,
        note: '',
      });
      schedule[r.name] = { alpha, postTotal: r.postTotal };
    } else {
      const { alpha, postP } = bisectAlphaDegenerate(r.bp, r.postTotal);
      const targetP = r.bp === 0 ? 0.10 : 0.90;
      rows.push({
        regime: r.name,
        bt: r.bt,
        bp: r.bp,
        postTotal: r.postTotal,
        zTestCritPostP: NaN,
        wilsonFirstPassedPostP: postP,
        alpha,
        powerAt10pp: NaN,
        note: `MDE target postP=${targetP.toFixed(2)}`,
      });
      schedule[r.name] = { alpha, postTotal: r.postTotal };
    }
  }

  // Dense-high: use typical's α, record divergence only.
  const typicalAlpha = schedule['typical'].alpha;
  const dhTarget = zTestCritPostP(DENSE_HIGH.bp, DENSE_HIGH.postTotal);
  const dhPostP = firstPassedPostP(
    DENSE_HIGH.bt,
    DENSE_HIGH.bp,
    DENSE_HIGH.postTotal,
    typicalAlpha,
  );
  const dhPower = wilsonPowerAtDelta(
    DENSE_HIGH.bt,
    DENSE_HIGH.bp,
    DENSE_HIGH.postTotal,
    typicalAlpha,
    0.10,
  );
  const dhDivergencePp = Number.isFinite(dhPostP)
    ? (dhPostP - dhTarget) * 100
    : NaN;
  rows.push({
    regime: DENSE_HIGH.name,
    bt: DENSE_HIGH.bt,
    bp: DENSE_HIGH.bp,
    postTotal: DENSE_HIGH.postTotal,
    zTestCritPostP: dhTarget,
    wilsonFirstPassedPostP: dhPostP,
    alpha: typicalAlpha,
    powerAt10pp: dhPower,
    note: `uses typical α; divergence ${dhDivergencePp.toFixed(1)}pp`,
  });
  schedule[DENSE_HIGH.name] = {
    alpha: typicalAlpha,
    postTotal: DENSE_HIGH.postTotal,
    inherits: 'typical',
    divergencePp: dhDivergencePp,
  };

  // -----------------------------------------------------------------------
  // Single-α covers all non-degenerate? Flag if yes.
  // -----------------------------------------------------------------------
  const nondegen = rows.filter(
    (r) => r.regime !== 'degenerate-zero' && r.regime !== 'degenerate-one' && r.regime !== 'dense-high',
  );
  const alphas = nondegen.map((r) => r.alpha);
  const aMin = Math.min(...alphas);
  const aMax = Math.max(...alphas);
  // Test: if we pick the mean α, does every non-degenerate regime stay within ±1pp of z-test target?
  const meanAlpha = (aMin + aMax) / 2;
  let singleAlphaCovers = true;
  const singleAlphaChecks = [];
  for (const r of nondegen) {
    const postP = firstPassedPostP(r.bt, r.bp, r.postTotal, meanAlpha);
    const diffPp = (postP - r.zTestCritPostP) * 100;
    singleAlphaChecks.push({ regime: r.regime, alpha: meanAlpha, diffPp });
    if (Math.abs(diffPp) > 1.0) singleAlphaCovers = false;
  }

  // -----------------------------------------------------------------------
  // Emit markdown
  // -----------------------------------------------------------------------
  const lines = [];
  lines.push('### Calibration table');
  lines.push('');
  lines.push(
    '| regime | bt | bp | postTotal | z-test postP_crit | Wilson first-passed postP | α | power @ +10pp | note |',
  );
  lines.push(
    '|--------|----|----|-----------|-------------------|---------------------------|---|---------------|------|',
  );
  for (const r of rows) {
    const zCrit = Number.isFinite(r.zTestCritPostP)
      ? r.zTestCritPostP.toFixed(4)
      : 'n/a';
    const wPass = Number.isFinite(r.wilsonFirstPassedPostP)
      ? r.wilsonFirstPassedPostP.toFixed(4)
      : 'never';
    const aStr = Number.isFinite(r.alpha) ? r.alpha.toFixed(4) : 'n/a';
    const pStr = Number.isFinite(r.powerAt10pp)
      ? (r.powerAt10pp * 100).toFixed(1) + '%'
      : 'n/a';
    lines.push(
      `| ${r.regime} | ${r.bt} | ${r.bp.toFixed(2)} | ${r.postTotal} | ${zCrit} | ${wPass} | ${aStr} | ${pStr} | ${r.note} |`,
    );
  }
  lines.push('');
  lines.push('### Single-α hypothesis check');
  lines.push('');
  lines.push(
    `mean α across non-degenerate regimes = ${meanAlpha.toFixed(4)} (range ${aMin.toFixed(4)}–${aMax.toFixed(4)})`,
  );
  for (const c of singleAlphaChecks) {
    lines.push(
      `- ${c.regime}: diff from z-test boundary = ${c.diffPp.toFixed(2)}pp`,
    );
  }
  lines.push('');
  lines.push(
    `**single-α covers all non-degenerate within ±1pp:** ${singleAlphaCovers ? 'YES — FLAG, consensus hypothesis falsified' : 'no — piecewise α required'}`,
  );
  lines.push('');
  lines.push('### Schedule (JSON)');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(schedule, null, 2));
  lines.push('```');

  const md = lines.join('\n');
  process.stdout.write(md + '\n');
  return singleAlphaCovers ? 2 : 0;
}

const code = main();
process.exit(code);
