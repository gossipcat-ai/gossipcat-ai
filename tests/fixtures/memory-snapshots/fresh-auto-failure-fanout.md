---
name: Auto-failure signal fan-out on dispatch timeout
description: SHIPPED 0bbf4b0 — auto-signal filter now skips synthetic `_` buckets and scopes to requestedIds, ending the 14-signals-per-timeout fan-out
type: project
---

**SHIPPED 2026-04-08 in commit 0bbf4b0.** Fix applied in `apps/cli/src/handlers/collect.ts:126-149`. Both guards added: agentId-starts-with-underscore skip + requestedIds scoping. Build passes.

**Symptom (pre-fix):** A single gemini-implementer dispatch timeout produced 14 failure signals — 13 of them against the synthetic `_utility` bucket — because the auto-signal block iterated all pending relay tasks instead of scoping to the task that actually timed out.

**Fix landed:**
1. Added `&& !String(r.agentId || '').startsWith('_')` to the `failedResults` filter — skip synthetic buckets.
2. When `requestedIds` is non-empty, only fan out signals for results whose `id` is in `requestedIds` (scope to current collect call).

**How to verify:** trigger a deliberate dispatch timeout and assert `mcp.log` "Auto-recorded N failure signal(s)" reports N=1 with the real agent_id, not 14 with `_utility` spam.
