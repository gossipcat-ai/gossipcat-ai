# Replace Preset System with Freeform Role

**Date:** 2026-04-01
**Status:** Draft
**Consensus:** 2-agent review (sonnet-reviewer, gemini-reviewer) on preset removal analysis

## Problem

The hardcoded `preset` enum (`implementer | reviewer | researcher | tester`) blocks custom agent roles. A user wanting to create a "ui-architect" or "security-auditor" agent gets rejected by the Zod schema.

Additionally, an existing bug means `.claude/agents/<id>.md` instructions are loaded at boot into `ctx.nativeAgentConfigs` but **never injected** into the native dispatch prompt. Hardcoded `presetPrompts` are used instead, making the `.md` file's system prompt dead weight.

## Goal

Replace the rigid `preset` enum with a freeform `role` string. The role is metadata for display, dispatch seeding, and orchestrator classification. The agent's real identity — its system prompt — lives in `.claude/agents/<id>.md` and evolves through memory and skills.

## Non-Goals

- Changing how relay workers are dispatched (they already don't use presets)
- Modifying the signal pipeline or scoring system
- Changing the `.claude/agents/<id>.md` file format
- Updating the standalone CLI flows (`create-agent`, `setup-wizard`) — separate effort

## Design

### Change 1: Schema — `preset` enum → `role` string

In `apps/cli/src/mcp-server-sdk.ts:873`, the `gossip_setup` Zod schema:

**Before:**
```typescript
preset: z.enum(['implementer', 'reviewer', 'researcher', 'tester']).optional()
  .describe('Agent role preset'),
```

**After:**
```typescript
role: z.string().optional()
  .describe('Agent role — freeform, e.g. "ui-architect", "security-auditor", "reviewer"'),
```

Backward compatibility: if the incoming config has `preset` instead of `role`, read it as `role`. Both field names accepted on input; `role` written on output.

### Change 2: Fix native dispatch prompt (bug fix)

In `apps/cli/src/mcp-server-sdk.ts:1180-1195`, the native agent dispatch builds a prompt from `presetPrompts[preset]`.

**Before:**
```typescript
const preset = agentConfig?.preset || config.description || '';
const presetPrompts: Record<string, string> = {
  reviewer: 'You are a senior code reviewer...',
  researcher: 'You are a research agent...',
  implementer: 'You are an implementation agent...',
  tester: 'You are a testing agent...',
};
const presetPrompt = presetPrompts[preset] || `You are a ${preset} agent.`;
const agentPrompt = `${scopePrefix}${presetPrompt}\n\n---\n\nTask: ${task}`;
```

**After:**
```typescript
const basePrompt = config.instructions
  || `You are a skilled ${config.description || 'agent'}. Complete the task thoroughly.`;
const agentPrompt = `${scopePrefix}${basePrompt}\n\n---\n\nTask: ${task}`;
```

`config.instructions` is the body of `.claude/agents/<id>.md` — already loaded at boot. This makes the `.md` file the single source of truth for the agent's system prompt. The `presetPrompts` map is deleted entirely.

### Change 3: Delete `inferPreset()`

In `apps/cli/src/config.ts:185`, `inferPreset()` regex-matches agent name/description to force one of 4 legacy preset values. A "ui-architect" gets silently mapped to "implementer".

**Delete the function entirely.** In `claudeSubagentsToConfigs()`, set `role: undefined` instead of calling `inferPreset()`. The agent's identity comes from its `.md` file, not from name-matching heuristics.

### Change 4: Replace `presetScores()` with flat default

In `apps/cli/src/mcp-context.ts:66-74`, `presetScores()` returns hardcoded relevance/accuracy/uniqueness scores per preset. These feed memory importance via `native-tasks.ts:234`.

**Replace with flat default:**
```typescript
export function defaultImportanceScores(): { relevance: number; accuracy: number; uniqueness: number } {
  return { relevance: 3, accuracy: 3, uniqueness: 3 };
}
```

This gives all agents equal memory importance seeding (`importance = 9/15 = 0.6`). The signal pipeline takes over after the first few tasks — the seed values are numerically insignificant once real data accumulates.

Update the call site in `apps/cli/src/handlers/native-tasks.ts:234` to use `defaultImportanceScores()` instead of `presetScores(agentMeta.preset)`.

### Change 5: Config defaults — stop writing default preset

In `apps/cli/src/mcp-server-sdk.ts:1000,1024`, the `gossip_setup` handler writes:
```typescript
preset: agent.preset || 'implementer',
```

**Change to:**
```typescript
role: agent.role || agent.preset, // backward compat: read old preset field
```

No default value — if the user didn't specify a role, the field is omitted from config.json. Agents without a role are valid; their identity comes from skills + `.md` file + signal history.

### Change 6: Boot-time nativeAgentConfigs description

In `apps/cli/src/mcp-server-sdk.ts:269,533`, `nativeAgentConfigs` stores `description: ac.preset || ''`.

**Change to:**
```typescript
description: ac.role || ac.preset || ''
```

This ensures the description field carries the role string (for display in status/dashboard) while maintaining backward compat with existing configs that use `preset`.

## Backward Compatibility

| Scenario | Handling |
|----------|----------|
| Existing config with `"preset": "reviewer"` | Read as `role: "reviewer"`. Works unchanged. |
| Existing config with `"preset": "implementer"` (default) | Read as `role: "implementer"`. Works unchanged. |
| New config created without role | No `role` field written. Agent identity from `.md` file + skills. |
| New config with custom role | `role: "ui-architect"` written. Used for display and description. |

No migration script needed. The `preset` field is read as a fallback alias for `role` wherever it appears.

## File Changes

| File | Change |
|------|--------|
| `apps/cli/src/mcp-server-sdk.ts:873` | `preset` enum → `role` string in Zod schema |
| `apps/cli/src/mcp-server-sdk.ts:1180-1195` | Delete `presetPrompts`, use `config.instructions` |
| `apps/cli/src/mcp-server-sdk.ts:1000,1024` | `preset: x \|\| 'implementer'` → `role: x.role \|\| x.preset` |
| `apps/cli/src/mcp-server-sdk.ts:269,533` | `description: ac.preset` → `description: ac.role \|\| ac.preset` |
| `apps/cli/src/mcp-context.ts:66-74` | `presetScores()` → `defaultImportanceScores()` |
| `apps/cli/src/config.ts:185-196` | Delete `inferPreset()`, update `claudeSubagentsToConfigs()` |
| `apps/cli/src/handlers/native-tasks.ts:234` | `presetScores(preset)` → `defaultImportanceScores()` |
| `tests/cli/mcp-server-sdk.test.ts` | Update `presetScores` tests → `defaultImportanceScores` |

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Existing configs break on schema change | Low | `preset` read as `role` alias — backward compat |
| Native agents get weak prompts | Low | `config.instructions` is already loaded; this is a bug fix |
| Memory importance seeding less differentiated | Low | Flat default is 0.6; signal history dominates after ~3 tasks |
| CLI flows still use old preset enum | Low | Out of scope — separate effort, doesn't block MCP usage |

## Success Criteria

- `gossip_setup` accepts arbitrary role strings (e.g. "ui-architect")
- Native agents dispatched via `gossip_run` use their `.claude/agents/<id>.md` prompt
- Existing teams with `preset: "reviewer"` continue working without config changes
- `presetPrompts` map and `inferPreset()` are deleted
