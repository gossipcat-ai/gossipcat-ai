# Relay-Lint Hardening Spec
## Plan 4e1e534c Step 2 — Synthesis

**Status:** Specification  
**Date:** 2026-04-25  
**Related Work:**
- Problem: `project_relay_prose_finding_loss.md`
- Collision: `project_drift_bypass_finding_dropped_format.md`
- Code paths: `apps/cli/src/handlers/native-tasks.ts`, `packages/orchestrator/src/completion-signals.ts`

---

## Problem

When the orchestrator relays native-agent output via `gossip_relay(task_id, result)` by paraphrasing rather than preserving the original `<agent_finding>` tags, the consensus finding-extractor parses zero findings and silently drops all findings. The dashboard shows only findings from relay agents; native agents' findings are invisible.

**Root cause:** The consensus engine's Phase 1 collection calls `parseAgentFindingsWithLogs()` at `packages/orchestrator/src/consensus-engine.ts:802`, which runs a regex over the `result` string searching for `<agent_finding type="..." severity="...">` blocks. When the orchestrator summarizes (e.g., `"HIGH (e955d7d0:sonnet:f1) — recordCreated does not redactSecrets…"`) instead of pasting verbatim, **zero tags parse**. The prose lands in session-gossip.jsonl but never reaches `consensus-reports/*.json`.

**Why this is a system discipline gap, not a user-instruction problem:** A new user hitting this trap sees no warning, no error, no UI feedback. The orchestrator believes it has relayed the result. Data loss is invisible until findings are counted manually.

---

## Path A — Relay-Lint Warning (Ship First)

Observation: When a native agent's dispatch included `CONSENSUS_OUTPUT_FORMAT` instructions, the orchestrator MUST relay verbatim `<agent_finding>` tags. When zero tags appear in the relayed result, suspect paraphrase.

### Insertion Point
**File:** `apps/cli/src/handlers/native-tasks.ts`  
**Location:** Inside `handleNativeRelay()`, immediately before or within the `emitCompletionSignals()` call (line ~444).

### Detection Logic

```
1. Count <agent_finding> tags in the incoming result string.
   - Regex: /<agent_finding[^>]*>/g
   - If count === 0, proceed to step 2.

2. Check if this task is part of an active consensus round.
   - Query: ctx.pendingConsensusRounds.has(task_id)
   - If true, we're in Phase 1 of a consensus dispatch.
   
3. If both conditions are met: likely paraphrase.
   - Emit a `relay_findings_dropped` signal.
```

### Signal Emission

**Signal type:** `pipeline`  
**Signal name:** `relay_findings_dropped`  
**Emission path:** `completion-signals-helper` (via `emitCompletionSignals()`'s internal `PerformanceWriter.appendSignals()` call)

**Implementation:** Add a post-check **before** calling `emitCompletionSignals()`:

```typescript
// Detect paraphrase: zero findings in relayed result
// (assumes native agent dispatch included CONSENSUS_OUTPUT_FORMAT)
if (taskInfo.pendingConsensusRounds?.has(task_id) && !taskInfo.utilityType) {
  const findingCount = (result.match(/<agent_finding[^>]*>/g) || []).length;
  if (findingCount === 0 && result.trim().length > 0) {
    // Emit the warning signal. Note: signal goes out via
    // PerformanceWriter in the next call to emitCompletionSignals(),
    // so we DON'T call a separate pipeline path here.
    // (Avoid drift-detector collision per project_drift_bypass_...)
    
    // The signal must be tagged in the result or metadata so
    // downstream observers see it in session-gossip.jsonl.
    // Two options:
    //   A. Emit via gossip_signals(action:"record", ...) before relay returns
    //   B. Record in .gossip/relay-warnings.jsonl + include in response body
    // 
    // Choose Option B: persist to disk, include in response.
    appendRelayWarning(task_id, agentId, {
      reason: 'relay_findings_dropped',
      findingCount: 0,
      resultLength: result.length,
      timestamp: new Date().toISOString(),
    });
  }
}
```

### Persistence

**File:** `.gossip/relay-warnings.jsonl`  
**Format:** One JSON object per line.

```json
{
  "taskId": "string",
  "agentId": "string",
  "reason": "relay_findings_dropped",
  "findingCount": 0,
  "resultLength": number,
  "timestamp": "ISO-8601"
}
```

**Append helper:**
```typescript
function appendRelayWarning(
  taskId: string,
  agentId: string,
  warning: { reason: string; findingCount: number; resultLength: number; timestamp: string }
): void {
  try {
    const path = join(process.cwd(), '.gossip/relay-warnings.jsonl');
    const line = JSON.stringify({ taskId, agentId, ...warning }) + '\n';
    fs.appendFileSync(path, line, 'utf8');
  } catch (err) {
    process.stderr.write(`[gossipcat] append relay-warning failed: ${(err as Error).message}\n`);
    // Fail-open: do not block relay completion
  }
}
```

### Response Body

Include a human-readable warning in the `gossip_relay` response so the orchestrator sees it inline:

```typescript
const warningLines: string[] = [];
if (findingCount === 0 && ctx.pendingConsensusRounds?.has(task_id)) {
  warningLines.push(
    `⚠️  relay-lint: zero <agent_finding> tags detected in paraphrased result.\n` +
    `    Expected verbatim <agent_finding> blocks. Findings may have been lost.\n` +
    `    See .gossip/relay-warnings.jsonl for details.`
  );
}

return {
  content: [{
    type: 'text' as const,
    text: [
      `✅ Relayed ${agentId} [${task_id}]`,
      ...warningLines,
      `Signal counters: completion=${autoSignalsEmitted.completion}, ...`
    ].join('\n'),
  }],
};
```

### Tests

**Unit test file:** `tests/orchestrator/relay-lint.test.ts`

```typescript
describe('handleNativeRelay — relay-lint warning', () => {
  it('emits relay_findings_dropped when paraphrased', () => {
    // Setup: dispatch a native agent in consensus mode
    // Relay with prose result (no <agent_finding> tags)
    // Assert: .gossip/relay-warnings.jsonl contains entry
    // Assert: gossip_relay response includes warning text
  });

  it('does not warn when findings are properly tagged', () => {
    // Setup: relay with verbatim <agent_finding type="..."> block
    // Assert: .gossip/relay-warnings.jsonl has no entry
  });

  it('only warns during consensus (Phase 1)', () => {
    // Setup: solo native relay (no pending consensus)
    // Relay with zero tags
    // Assert: warning is NOT emitted
  });

  it('skips utility tasks', () => {
    // Setup: skill_develop utility relay
    // Relay with zero tags
    // Assert: warning NOT emitted (utility tasks exempt)
  });
});
```

**Coverage target:** <100 lines source + tests combined.

---

## Path B — Verbatim-Buffer Parsing (Ship Later, Blocked)

**Status:** BLOCKED until upstream MCP change.

Once the Agent() output buffer is exposed to `gossip_relay`, the consensus engine can try buffer-first, fallback to result-string.

### Prerequisites

Currently, `handleNativeRelay()` receives:
- `task_id` (string)
- `result` (string, from orchestrator paraphrase)
- No reference to the original Agent() output buffer

To enable Path B:

**Option B1 — Thread buffer path via MCP**
- Modify MCP schema: add optional `result_buffer_path` parameter to `gossip_relay`
- Orchestrator passes `tasks/<task_id>.output` JSONL path when calling relay
- Async overhead minimal (one file stat to check existence)

**Option B2 — Write native results to disk pre-relay**
- Modify `handleNativeRelay()` to fetch `tasks/<task_id>.output` from filesystem
- Trade-off: requires gossipcat to manage task output lifecycle

### If Implemented

Insert at `packages/orchestrator/src/consensus-engine.ts:1981`, inside `parseAgentFindingsWithLogs()`:

```typescript
private parseAgentFindingsWithLogs(
  agentId: string,
  raw: string,
  roundId?: string,
  bufferPath?: string,  // [NEW] optional path to verbatim Agent() output
): ParseFindingsResult {
  // Try verbatim buffer first if available
  let source = 'result-string';
  let parseInput = raw;
  
  if (bufferPath && fs.existsSync(bufferPath)) {
    try {
      const buffer = fs.readFileSync(bufferPath, 'utf8');
      const parseResult = parseAgentFindingsStrict(buffer, { ... });
      if (parseResult.findings.length > 0) {
        source = 'buffer';
        parseInput = buffer;
      }
    } catch { /* fallback to result-string */ }
  }
  
  const result = parseAgentFindingsStrict(parseInput, { ... });
  result.metadata = { parseSource: source };  // Telemetry
  return result;
}
```

**Telemetry:** Record which path produced findings (buffer vs. result-string) so we can measure paraphrase frequency.

---

## Acceptance Test

**Scenario:** Orchestrator relays a native agent's output by paraphrasing instead of pasting verbatim.

**Repro steps:**
1. Dispatch a native agent in consensus mode: `gossip_dispatch(mode:"consensus", tasks: [{agent_id:"sonnet-reviewer", task:"..."}])`
2. Execute the native agent (Agent() tool)
3. Relay with paraphrased prose: `gossip_relay(task_id, "HIGH — recordCreated lacks redaction")`
4. Run `gossip_collect(task_ids, consensus:true)` to synthesize

**Expected:**
- `.gossip/relay-warnings.jsonl` contains a `relay_findings_dropped` entry with `taskId`, `agentId`, `timestamp`
- `gossip_relay` response includes warning banner: "⚠️ relay-lint: zero <agent_finding> tags detected…"
- Consensus report shows finding from relay agents only (proof native findings were dropped)

---

## Rollout

1. **Ship Path A** (~1 week)
   - Merge relay-lint warning detection + persistence + response text
   - Run internal consensus rounds
   - Observe `.gossip/relay-warnings.jsonl` for paraphrase events

2. **Measure** (~1 week)
   - Aggregate weekly paraphrase rate from relay-warnings.jsonl
   - If >X% of native relays trigger warning, Path B becomes urgent
   - If <X%, Path A may be sufficient for manual awareness

3. **Decide Path B** (data-driven)
   - If paraphrase is rare: close as "Path A sufficient"
   - If paraphrase is frequent: upstream MCP change to expose buffer path

---

## Open Questions

From Step 1 research:

1. **Finding ID format for relay-lint failures**
   - Current: `relay_findings_dropped` is a pipeline signal, not a finding
   - Should it be tagged with a `consensus_id` for back-search, or is finding_id N/A?
   - Proposal: tag with the pending `consensus_id` if available; omit if solo relay

2. **Dashboard card placement**
   - Where should RelayLintAlerts appear in the dashboard?
   - Suggested: between CircuitAlerts and ActiveTasksBanner
   - Or: separate "Relay Health" section in Consensus tab?

3. **HTML-entity drift in warning text**
   - Response includes `⚠️` emoji; verify UTF-8 survives MCP serialization
   - Check: does `JSON.stringify()` escape emoji, and does consumer unescape?

4. **Utility-task format expectations**
   - Should skill_develop/gossip_publish utility tasks be exempt from relay-lint?
   - They may legitimately have zero `<agent_finding>` tags (summary task)
   - Current design: skip warning if `utilityType` is set (proposal: keep it)

5. **Cross-review prompt sanitization**
   - Phase 2 uses JSON arrays instead of prose result strings
   - Does relay-lint need to validate relay agents (custom HTTP providers)?
   - Proposal: monitor relay-warnings.jsonl for patterns; defer cross-review lint to Phase 2 design

---

## Risks / Non-Goals

### Must NOT:
- **Break relay path** — detection is observability-only; relay succeeds regardless
- **Bypass signal pipeline** — must use `completion-signals-helper` path, NOT `signal-helpers-pipeline` (drift-detector allowlist collision per `project_drift_bypass_finding_dropped_format.md`)
- **Modify consensus engine** — Path A does not touch Phase 1/Phase 2 finding collection
- **Force schema changes** — gossip_relay response includes warning text, but result field unchanged

### Out of Scope:
- Enforcing paraphrase rejection (too brittle, legitimate edge cases exist)
- Automatic correction (requires orchestrator to re-run relay with verbatim blocks)
- Cross-review validation (relay agents use different output format; Phase 2 research needed)

---

## Implementation Checklist

- [ ] Add `appendRelayWarning()` helper to native-tasks.ts
- [ ] Insert finding-count detection before `emitCompletionSignals()` call
- [ ] Construct warning text for response body
- [ ] Update `gossip_relay` response to include warning
- [ ] Create `.gossip/relay-warnings.jsonl` format docs
- [ ] Write unit tests (paraphrase, tagged, solo, utility cases)
- [ ] Add `.gossip/relay-warnings.jsonl` to .gitignore (temporary logs)
- [ ] Verify drift detector passes with `completion-signals-helper` path
- [ ] Acceptance test: paraphrased relay → warning in warnings.jsonl + response
- [ ] Document in handbook / troubleshooting guide

---

## Related Architecture

**Signal pipeline:**
- `emitCompletionSignals()` writes task_completed, format_compliance, finding_dropped_format
- `relay_findings_dropped` is a new pipeline signal using the same `completion-signals-helper` path
- No interaction with `emitPipelineSignals()` (avoids drift-detector bypass)

**Consensus workflow:**
- Phase 1: parseAgentFindingsWithLogs() runs regex on result string
- Path A adds pre-relay detection; Path B would refactor Phase 1 fallback logic
- Both assume result string is the primary source

**Backlog implications:**
- If paraphrase rate is high, Path B becomes a critical refactor (consensus engine + relay contract changes)
- If paraphrase is rare, relay-lint warning is sufficient for manual auditing

