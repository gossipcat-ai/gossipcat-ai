# gossip_verify_memory — on-demand staleness check

**Status:** Spec. Branch: `feat/stale-memory-detection`. Driven by consensus research in session 2026-04-08 (3 parallel reviewers: haiku-researcher architecture audit + 2× sonnet-reviewer critiques of A/B/C design options).

## Problem

Memory files at `/Users/goku/.claude/projects/-Users-goku-Desktop-gossip/memory/` describe code state at write-time and silently rot. Session 2026-04-08 hit this twice:

1. `project_quota_watcher.md` — 3 days old, said "not started", code was ~90% shipped across 4 files.
2. `project_cross_platform_credentials.md` — 14 days old, said "macOS only", macOS + Linux + AES-256-GCM encrypted-file fallback were all already shipped.

Both were only caught after manual code reading burned ~15 Grep/Read calls. The CLAUDE.md rule added earlier this session (`dispatch research before acting on a backlog item`) mitigates the symptom but has no tool support — it asks the orchestrator to write a prose research prompt each time.

## Architectural constraint

Haiku's audit found that **gossipcat does not touch `/Users/goku/.claude/projects/` at all.** All gossipcat memory ops stay within `.gossip/agents/*/memory/`. This kills the three standard design options for automatic staleness tracking:

- **Option A (anchor hash in frontmatter)** — requires writing to memory files, which gossipcat's existing MemoryWriter cannot reach. Also high cosmetic-change false positives (~60-70% per sonnet-reviewer).
- **Option B (commit watermark)** — broken by this session's force-push (we rewrote 10 commits fixing the git email). Orphaned SHAs return `missing` from `git cat-file`, and `git gc` makes the break permanent. Fragile against a workflow we already use.
- **Option C (scheduled cron audit)** — gossipcat has no cron infrastructure; auditing 60+ files per cycle is wasteful; bounded by agent file coverage, non-deterministic for CI.

## Design: on-demand verification tool

A new MCP tool that wraps a single structured haiku-researcher dispatch:

```
gossip_verify_memory(memory_path: string, claim: string)
  → { verdict: "FRESH" | "STALE" | "CONTRADICTED" | "INCONCLUSIVE",
      evidence: string,            // file:line citations
      rewrite_suggestion?: string, // proposed new prose if STALE/CONTRADICTED
      checked_at: ISO8601 }
```

**Key properties:**
- Works on **any** file path — gossipcat does file reads, the file does not need to live inside `.gossip/`.
- No schema migration. No frontmatter change. Existing ~60 memory files work immediately.
- Deterministic verdict schema makes integration testing possible even with a mock haiku.
- Single haiku dispatch per call — cheap, on-demand, no standing cost.

## Verdict semantics

| Verdict | Meaning | Orchestrator action |
|---|---|---|
| `FRESH` | Claim matches current code, no change needed | Proceed, cite `checked_at` in output |
| `STALE` | Claim was once true, code has since changed | Re-read code before acting; suggest rewriting memory |
| `CONTRADICTED` | Claim was never accurate OR is now directly wrong | Stop, do not use memory content, rewrite required |
| `INCONCLUSIVE` | Haiku could not find the referenced code, or claim is too vague to verify | Fall back to manual audit |

## Dispatch flow

1. `gossip_verify_memory` handler reads `memory_path`, extracts description + prose body.
2. Builds a haiku-researcher prompt: "Verify this claim against current code at `<cwd>`. Claim: `<claim>`. Memory body for context: `<body>`. Return `<verdict>` + evidence with file:line."
3. Dispatches via existing native-utility-provider path (session 2026-04-05b).
4. Parses the verdict line, extracts evidence, returns the structured response.
5. On `STALE` or `CONTRADICTED`, includes a `rewrite_suggestion` field derived from haiku's evidence block — the orchestrator decides whether to overwrite the memory file.

Rewrite is **orchestrator-initiated**, never automatic — the tool reports, the orchestrator writes. This keeps the audit path separate from the mutation path and avoids runaway self-modification.

## CLAUDE.md integration

The existing rule added this session says "Before acting on any backlog item from memory: your FIRST action is a gossipcat research dispatch, not manual Read/Grep." Updated wording once the tool ships:

> Before acting on any backlog item from memory, call `gossip_verify_memory(memory_path, claim)` where `claim` is the specific memory assertion you are about to rely on. Only proceed on `FRESH`. On `STALE` or `CONTRADICTED`, apply the returned `rewrite_suggestion` and re-read before acting.

This collapses the "write a prose research prompt" step to a single structured call.

## Test fixtures

Both stale examples from session 2026-04-08 are recoverable from git history — they were updated to SHIPPED state in the same session, so `git show <sha>:memory/...` returns the stale version.

```
Fixture 1: project_quota_watcher.md (pre-update)
  Claim: "Gemini hit 429 quota limit ... no mechanism to detect or recover"
  Expected verdict: CONTRADICTED
  Expected evidence: packages/orchestrator/src/llm-client.ts:74-182 (QuotaTracker)
                     apps/cli/src/handlers/dispatch.ts:60-101 (reroutableAgent)
                     apps/cli/src/mcp-server-sdk.ts:1039-1054 (status display)

Fixture 2: project_cross_platform_credentials.md (pre-update)
  Claim: "Current Keychain class ... is macOS-only"
  Expected verdict: CONTRADICTED
  Expected evidence: apps/cli/src/keychain.ts:101-114 (darwin + linux + encrypted-file)
```

Both fixtures can be replayed deterministically. The test mocks the haiku LLM response to the expected verdict structure, asserts the handler parses and returns correctly, and asserts evidence extraction works on the exact file paths above.

A third fixture for `FRESH` uses a fresh memory from the current session that we know still matches code (e.g., `project_auto_failure_signal_fanout_bug.md` after its SHIPPED update — it accurately describes the state of `collect.ts:129`).

## Non-goals

- **Automatic memory rewriting.** Tool reports, orchestrator writes.
- **Batch audit over all memories.** On-demand only. A "nightly sweep" is a follow-up if we find the orchestrator reliably forgets to call.
- **Schema migration of existing memories.** No frontmatter change. No annotations required.
- **Detecting stale claims that are PROVABLY true today but will rot tomorrow.** The tool is a point-in-time check; it does not subscribe to file change events.
- **Verifying claims about things outside the repo** (e.g., external API behaviors, npm package internals). Scope is local filesystem only.

## Deliverables

1. `gossip_verify_memory` tool registered in `apps/cli/src/mcp-server-sdk.ts` (follow the `gossip_signals` registration pattern — clean, known-good array-optional schema, no `.default().optional()` traps).
2. Handler that dispatches haiku-researcher via the existing native-utility path and parses the response into the verdict schema.
3. Prompt template for the haiku verification dispatch (sibling file under `packages/orchestrator/src/` or inline in the handler).
4. Integration test in `tests/cli/` using the two fixture memories and a mocked haiku response. Assert verdicts, evidence extraction, and rewrite-suggestion pass-through.
5. CLAUDE.md update — replace the current "dispatch research first" paragraph with a pointer to `gossip_verify_memory`.
6. One commit per deliverable, atomic, each passing build. Final PR runs `gossip_dispatch(mode: "consensus", ...)` review per the new `.github/PULL_REQUEST_TEMPLATE.md` convention.

## Out of scope for this PR but tracked

- `.claude/settings.local.json` boundary escape false positive (`apps/cli/src/handlers/dispatch.ts` or wherever the detector lives). Separate branch `fix/boundary-escape-harness-exclusion` once this lands.
- A `gossip_verify_memory(scan: true)` batch mode. Add if on-demand usage proves insufficient.

## Open questions

1. Where does the haiku prompt template live — inline in the handler, in a sibling file, or in `packages/orchestrator/src/default-skills/`? Preference: inline for now, extract if it grows past ~40 lines.
2. Should the tool accept `memory_path` relative to cwd, absolute, or both? Preference: both. Validate that the resolved path exists and is readable.
3. Rate limiting — should multiple `gossip_verify_memory` calls in quick succession batch into a single haiku dispatch? Probably not for v1. Each call gets its own dispatch so verdicts stay deterministic.
