---
status: proposal
related:
  - docs/specs/2026-04-17-unified-memory-view.md
  - docs/specs/2026-04-15-memory-taxonomy-hybrid.md
---

# Memory hygiene propagation — durable + per-session

## Problem

The taxonomy mapper routes `project_*.md` files with no `status:` frontmatter to **Backlog** — correct default, but nothing ever flows to **Record**. Record only populates when writes carry `status: shipped|closed`.

Empirical data (haiku-researcher 2026-04-17, dispatch `bdc99a16`): on this repo, files created ≥Apr 16 are 100% `status:`-tagged; files ≤Apr 13 are 0%. The CLAUDE.md "Memory hygiene" section **works** — Claude Code's auto-memory writer honors per-repo CLAUDE.md conventions.

But the convention currently lives **only** in this repo's CLAUDE.md. Fresh gossipcat users on a new project never get it. And CLAUDE.md can be deleted, edited out, or drift — `gossip_setup` is one-shot.

## Proposed fix — dual delivery

**A. Per-session injection (load-bearing).** Append a "Memory hygiene convention" block to `gossip_status()` bootstrap output. Every Claude instance sees it on session start. No file dependency, no drift risk.

**B. Setup-time CLAUDE.md seeding (belt-and-suspenders).** On `gossip_setup`, idempotently check for the hygiene heading in project CLAUDE.md; if absent, offer to append it. Durable artifact for users reopening cold or outside Claude Code.

A is the primary fix because `gossip_status()` is already mandated as the first call every session (see current CLAUDE.md Step 1). B protects users whose MCP client doesn't always hit `gossip_status()` on warmup.

## Code changes

### A. Bootstrap output injection

File: the bootstrap/status builder that produces `gossip_status` output. Add a new section `## Memory Hygiene Convention` after `## Operating Rules` containing the four `status:` rules from `CLAUDE.md § Memory hygiene` (lines 128-145). Keep the block under ~15 lines.

Estimated: ~20 LOC plus copy.

### B. Setup idempotent CLAUDE.md check

File: `gossip_setup` handler (grep for the `gossip_setup` tool impl).
- On setup completion, read project-root `CLAUDE.md` if it exists.
- If the string `## Memory hygiene` (case-insensitive, exact heading) is absent, append the canonical block.
- If CLAUDE.md does not exist, skip silently (don't create one — too invasive).
- Idempotent: re-running setup on a seeded project is a no-op.
- Log one line to stderr so the user sees what happened.

Estimated: ~30 LOC.

## What stays unchanged

- Writer separation (unified-memory-view invariant #5) — untouched.
- Taxonomy mapper behavior (no `status:` → Backlog) — untouched.
- CC's auto-memory writer — untouched.
- No native-store mutation.

## Non-goals

- **No automated `status: shipped` transitions.** Deferred per sonnet-reviewer research (dispatch `63a2a6ec`): would require either a retraction of unified-memory-view invariant #5 (write to `~/.claude/projects/`) or a `.gossip/backlog-status.jsonl` overlay with dashboard merge plumbing. Day-1 UX is already fine without it.
- Don't write CLAUDE.md if one doesn't exist — user may intentionally not use it.

## Expected outcome

- Fresh users: on session 1 they get the hygiene block in-context via `gossip_status()`. Subsequent project/backlog memories written by Claude Code will carry `status:` (per haiku's propagation evidence).
- Existing users: `gossip_setup` re-run seeds CLAUDE.md if missing. Otherwise no change.
- Dashboard Record folder starts populating organically as items ship.

## Test plan

- Unit: bootstrap output contains `## Memory Hygiene Convention` heading.
- Unit: setup CLAUDE.md hook — skip when file missing, append when heading absent, no-op when heading present.
- Integration: simulated fresh-project setup writes CLAUDE.md with hygiene block appended (not replacing existing content).

## References

- Haiku research: dispatch `bdc99a16` (2026-04-17) — CLAUDE.md propagation confirmed (100% post-convention, 0% pre).
- Sonnet research: dispatch `63a2a6ec` — writer invariant #5 rules out native-store mutation.
- Gemini research: dispatch `5574b79f` — fresh-user dashboard shows 3/4 folders populated day 1; Record empty without status.
- Prior: `docs/specs/2026-04-17-unified-memory-view.md` (shipped view-layer merge today).
