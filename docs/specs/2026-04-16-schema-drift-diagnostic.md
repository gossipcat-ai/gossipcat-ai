---
status: proposal
consensus: 2c0c1e0b-66cf4919 (sonnet-reviewer + gemini-reviewer, 2026-04-16)
depends_on: 2026-04-16-html-entity-repair-diagnostic.md
---

# Schema-Drift Diagnostic for Reviewer Instruction Conflicts

> When a reviewer agent emits `<agent_finding>` tags that the strict parser
> drops (unknown type attribute, missing type attribute, or nested-subtag
> pattern), detect the drop pattern, correlate it with reviewer instructions,
> and emit a specific diagnostic that names the likely conflict.
>
> Reuses the `ParseDiagnostic` union and `authorDiagnostics` structure from
> `2026-04-16-html-entity-repair-diagnostic.md`. That PR must land first.

## Problem

Handbook invariant #8 pins the accepted finding types to
`finding | suggestion | insight`. Anything else is silently filtered:

- **Unknown type attribute** (e.g. `type="confirmed"`) → `droppedUnknownType`
  at `packages/orchestrator/src/parse-findings.ts:57,117`
- **Missing type attribute** (e.g. `<agent_finding><type>finding</type>...`)
  → `droppedMissingType` at `parse-findings.ts:61,110`

When a reviewer's **instructions** conflict with the schema (e.g. teach the old
Phase-2 "consensus verdict format" of `CONFIRMED/DISPUTED/UNIQUE`, or teach
nested subtags instead of attributes), the agent complies with its own
instructions, emits tags that fall into a drop bucket, and every finding is
silently filtered.

**Cross-session report, 2026-04-16** (`project_reviewer_prompt_schema_conflict.md`):
a third-party project's reviewer was emitting old consensus verdict format and
nested subtags. User spent debugging time before identifying the conflict.

## Why this matters

Our shipped defaults are clean. But user projects can carry legacy reviewer
prompts. Parser already has attribution data (per-parse `droppedUnknownType`
and `droppedMissingType`). Pattern-matching over those buckets can name the
root cause before the user opens any source file.

## Proposal

### Token classification (two buckets, not one)

Per consensus round `2c0c1e0b-66cf4919:f16`, single-bucket conflates Phase-2
verdict drift with generic type invention. Split:

```ts
const PHASE2_VERDICT_TOKENS = new Set([
  'confirmed', 'disputed', 'unique', 'verdict',
]);

const INVENTED_TYPE_TOKENS = new Set([
  'approval', 'rejection', 'concern', 'risk',
  'recommendation', 'observation', 'critique',
  'bug', 'issue', 'warning',
]);
```

### Detection — three codes, three failure modes

All three fire regardless of `tags_accepted` value — partial-drift is in scope
per consensus round `2c0c1e0b-66cf4919:f10`.

**`SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS`** — intersect `droppedUnknownType` with
`PHASE2_VERDICT_TOKENS`. Message: "Reviewer emitted tag type(s) [...] — these
look like Phase-2 consensus verdicts, not Phase-1 finding types."

**`SCHEMA_DRIFT_INVENTED_TYPE_TOKENS`** — intersect with `INVENTED_TYPE_TOKENS`
(when no Phase-2 overlap). Message: "Reviewer emitted invented tag type(s)
[...]. Valid types are finding | suggestion | insight."

**`SCHEMA_DRIFT_NESTED_SUBTAGS`** — per consensus round `2c0c1e0b-66cf4919:f9`,
the nested-subtag drift mode hits `droppedMissingType`, NOT `droppedUnknownType`.
Detect via combination:

```ts
if (droppedMissingType > 0) {
  const nestedSubtagRe = /<type>\s*([a-z_]+)\s*<\/type>/gi;
  const subtagTypes: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = nestedSubtagRe.exec(text)) !== null) subtagTypes.push(m[1].toLowerCase());
  if (subtagTypes.length > 0) diagnostics.push({ code: 'SCHEMA_DRIFT_NESTED_SUBTAGS', ... });
}
```

All token interpolations route through `escapeHtml` from the HTML-entity-repair
spec's `packages/dashboard-v2/src/lib/sanitize.ts` to prevent XSS
(gemini-reviewer `2c0c1e0b-66cf4919:f1`).

### Overlap with existing `tags_dropped_unknown_type`

The meta-signal payload already carries `tags_dropped_unknown_type` at
`dispatch-pipeline.ts:431`. Preserved — coarse per-round count. The per-agent
attribution layer is `diagnostic_codes` (from HTML-entity-repair spec).

Dashboard rule: generic "N unknown types dropped" banner when
`tags_dropped_unknown_type > 0` AND no specific `SCHEMA_DRIFT_*` fired.
Specific diagnostic banner supersedes the generic one when it fires.

### Dashboard rendering — rate limit

Consensus finding card: banner per `(consensus_id, agentId, code)` triplet.

Agent detail page: persistent banner when same code fires ≥ 3 times in 30d.
Banner text includes the specific code, pointer to
`.gossip/agents/<id>/instructions.md`, link to handbook invariant #8.

## Files

- `packages/orchestrator/src/parse-findings.ts` — token sets + 3 producers
- `packages/dashboard-v2/src/...` — per-code banners + rate-limit
- `tests/orchestrator/parse-findings.test.ts` — +6 cases (see validation)

## Validation

Unit test cases:
1. all types valid → no drift diagnostic
2. `type="confirmed"` dropped + zero accepted → `PHASE2_VERDICT_TOKENS` fires
3. `type="confirmed"` dropped + `type="finding"` accepted → `PHASE2_VERDICT_TOKENS`
   still fires (partial-drift in scope)
4. `type="risk"` dropped only → `INVENTED_TYPE_TOKENS` fires
5. `type="confirmed"` + `type="risk"` both dropped → `PHASE2_VERDICT_TOKENS`
   only (Phase-2 takes precedence)
6. nested `<type>finding</type>` subtags → `SCHEMA_DRIFT_NESTED_SUBTAGS` fires

Backlog calibration: grep `.gossip/consensus-reports/*.json` for rounds where
round-level aggregates contain verdict tokens — calibration evidence for the
detection rules, NOT validation of live behavior.

## Rollout

Single PR, lands AFTER the HTML-entity-repair PR. No config flag.

## Not doing

- Auto-rewriting reviewer instructions.
- Expanding token lists to every possible drift.
- Blocking dispatches from drifted reviewers.
- **No re-dispatch on parse failure.**
- Mutating the parser's type enum.
