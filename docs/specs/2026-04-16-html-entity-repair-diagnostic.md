---
status: implemented
consensus: 2c0c1e0b-66cf4919 (sonnet-reviewer + gemini-reviewer, 2026-04-16)
---

# HTML-Entity Repair Diagnostic for `<agent_finding>` Parser

> When an orchestrator relays agent output whose `<agent_finding>` tags have been
> HTML-entity-encoded (`&lt;agent_finding ...&gt;`), the strict parser finds zero
> tags and the agent scores 0% format-compliant silently. Detect the encoded
> form and emit a loud diagnostic so the failure stops being silent.
>
> This is the **infrastructure PR** — it introduces the shared `ParseDiagnostic`
> discriminated union and the per-author diagnostics structure on `ConsensusReport`.
> Schema-drift diagnostic (`2026-04-16-schema-drift-diagnostic.md`) reuses both.

## Problem

`parseAgentFindingsStrict` in `packages/orchestrator/src/parse-findings.ts:83`
does a literal byte match on `<agent_finding`. When the orchestrator's transport
path entity-encodes the angle brackets, the payload arrives as
`&lt;agent_finding type=&quot;finding&quot; ...&gt;...&lt;/agent_finding&gt;`.

Current behavior:
- `tags_accepted = 0` (`packages/orchestrator/src/dispatch-pipeline.ts:88`)
- `detectFormatCompliance` returns `formatCompliant = false` (`:98`)
- `format_compliance` meta-signal fires as if the agent emitted no findings
  (`packages/orchestrator/src/dispatch-pipeline.ts:431`)
- Agent accuracy is docked for a defect they didn't produce

**Cross-session report, 2026-04-16** (`feedback_relay_tag_escape.md`): an
orchestrator session relayed an implementer's findings with the tags entity-
encoded. Parser found zero tags. The agent looked like they silently failed.

## Why this matters

The parser is strict by design (handbook invariant #8: "drops are loud,
parsers are strict"). The diagnostic strengthens the invariant rather than
weakening it — the invariant says DROPS are loud, not that PARSE FAILURES
are loud. Today's behavior silently conflates "agent emitted nothing" with
"transport mangled everything." This closes that gap without touching the
type enum.

## Proposal

### Infrastructure — `ParseDiagnostic` discriminated union

Add to `packages/orchestrator/src/parse-findings.ts`:

```ts
export type ParseDiagnostic =
  | { code: 'HTML_ENTITY_ENCODED_TAGS'; message: string; entityCount: number }
  | { code: 'HTML_ENTITY_MIXED_PAYLOAD'; message: string; rawCount: number; entityCount: number }
  | { code: 'SCHEMA_DRIFT_PHASE2_VERDICT_TOKENS'; message: string; matchedTokens: string[] }
  | { code: 'SCHEMA_DRIFT_INVENTED_TYPE_TOKENS'; message: string; matchedTokens: string[] }
  | { code: 'SCHEMA_DRIFT_NESTED_SUBTAGS'; message: string; subtagTypes: string[] };
```

`ParseFindingsResult` gains a `diagnostics: ParseDiagnostic[]` field,
populated by `parseAgentFindingsStrict` when any producer rule fires.

### Infrastructure — per-author diagnostics on `ConsensusReport`

`ConsensusReport` at `packages/orchestrator/src/consensus-types.ts:47-88` currently
has no per-author block. This spec **adds** a new field:

```ts
authorDiagnostics?: Record<string, ParseDiagnostic[]>;  // keyed by agentId
```

The round-level aggregate `droppedFindingsByType` at `consensus-types.ts:87`
is preserved unchanged. `authorDiagnostics` is the per-agent attribution layer.

### Producer — HTML-entity detection

In `parseAgentFindingsStrict`, after counting `<agent_finding` occurrences:

```ts
const rawTagCount = countOccurrences(text, '<agent_finding');
const entityTagCount = countOccurrences(text, '&lt;agent_finding');

if (rawTagCount === 0 && entityTagCount > 0) {
  diagnostics.push({ code: 'HTML_ENTITY_ENCODED_TAGS', ... });
} else if (rawTagCount > 0 && entityTagCount > 0) {
  diagnostics.push({ code: 'HTML_ENTITY_MIXED_PAYLOAD', ... });
}
```

The mixed-payload case closes the blind spot from consensus round
`2c0c1e0b-66cf4919:f14` — a second diagnostic code so mixed payloads don't
suppress the warning.

### Signal propagation

- `detectFormatCompliance` at `dispatch-pipeline.ts:88-106` receives the
  `diagnostics` array from the parse result and merges it into its output.
- `format_compliance` meta-signal payload at `dispatch-pipeline.ts:431` gains
  `diagnostic_codes: string[]`.
- `ConsensusEngine.synthesize` populates `authorDiagnostics[agentId]` when
  assembling per-agent results before the round-level roll-up.

### Dashboard rendering — spam discipline

Per consensus round `2c0c1e0b-66cf4919:f13`, diagnostics need de-dup rules
symmetric with the schema-drift spec:

- Consensus finding card: banner on first occurrence per
  `(consensus_id, agentId, code)` triplet, then badge with count.
- Agent detail page: persistent banner when the same code fires ≥ 3 times
  within a 30-day rolling window for that agent.

### Sanitization — consumer responsibility

Dashboard rendering of `diagnostic.message` and string fields MUST escape HTML
before interpolation. Dashboard has 4 `dangerouslySetInnerHTML` sites; new
diagnostic rendering routes through `packages/dashboard-v2/src/lib/sanitize.ts`
(`escapeHtml` helper). Closes gemini-reviewer's XSS concern from
`2c0c1e0b-66cf4919:f1`.

## Files

- `packages/orchestrator/src/parse-findings.ts` — `ParseDiagnostic` union + detection
- `packages/orchestrator/src/dispatch-pipeline.ts` — plumb into `format_compliance`
- `packages/orchestrator/src/consensus-types.ts` — add `authorDiagnostics`
- `packages/orchestrator/src/consensus-engine.ts` — populate in `synthesize`
- `packages/dashboard-v2/src/lib/sanitize.ts` — new `escapeHtml` helper
- `packages/dashboard-v2/src/components/*` — banner rendering + rate limit
- `tests/orchestrator/parse-findings.test.ts` — +4 cases
- `tests/orchestrator/dispatch-pipeline.test.ts` — +3 cases
- `tests/orchestrator/consensus-engine.test.ts` — +2 cases

## Validation

Unit tests cover all cases. Integration test under `packages/orchestrator/tests/`
drives `detectFormatCompliance` end-to-end with entity-encoded payload and
asserts `authorDiagnostics` survives serialization to the `MetaSignal` at
`consensus-types.ts:151`.

## Rollout

Single PR. No config flag — diagnostic is always on. Failure mode is
informational only.

## Not doing

- Automatic decoding of entity-encoded payloads. Strict parser stays strict.
- Rejecting dispatches that arrive entity-encoded.
- **No re-dispatch on parse failure.** Next dispatch uses repaired input.
- Broader "transport hygiene" framework.

## Interaction with schema-drift spec

Introduces the shared `ParseDiagnostic` union and `authorDiagnostics` structure.
Schema-drift spec reuses both. This PR lands first.
