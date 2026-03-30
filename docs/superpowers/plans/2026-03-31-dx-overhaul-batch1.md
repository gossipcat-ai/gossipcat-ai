# DX Overhaul — Batch 1: Bug Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 5 architecture-independent bugs in gossipcat's MCP server that cause silent data loss, undiscoverable tools, and ignored timeouts.

**Architecture:** All fixes are in `apps/cli/src/mcp-server-sdk.ts`. Each fix is isolated — no dependencies between tasks. The file is ~2550 lines; fixes target specific tool handlers.

**Tech Stack:** TypeScript, Zod schemas, esbuild bundler

**Spec:** `docs/superpowers/specs/2026-03-31-dx-overhaul-design.md` (Batch 1)

---

### Task 1: Remove task truncation in gossip_run native path

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts:1816` (Agent() instruction string)
- Modify: `apps/cli/src/mcp-server-sdk.ts:220` (persistNativeTaskMap)

- [ ] **Step 1: Fix the Agent() instruction truncation**

In `apps/cli/src/mcp-server-sdk.ts`, find the `gossip_run` native dispatch return (around line 1816):

```ts
`Agent(model: "${config.model}", prompt: "${scopePrefix}${presetPrompt}\\n\\n---\\n\\nTask: ${task.slice(0, 200)}...")\n` +
```

Replace `${task.slice(0, 200)}...` with `${task}`:

```ts
`Agent(model: "${config.model}", prompt: "${scopePrefix}${presetPrompt}\\n\\n---\\n\\nTask: ${task}")\n` +
```

- [ ] **Step 2: Fix persistNativeTaskMap truncation**

Find the `persistNativeTaskMap` function (around line 218-223). The `slimResults` loop truncates the task field:

```ts
id: info.id, agentId: info.agentId, task: info.task.slice(0, 200),
```

Remove the `.slice(0, 200)`:

```ts
id: info.id, agentId: info.agentId, task: info.task,
```

- [ ] **Step 3: Add comments to intentional 50k result caps**

Find these four sites and add a comment to each explaining they are deliberate:

Line ~1703 in `gossip_relay_result`:
```ts
result: error ? undefined : (result ? result.slice(0, 50000) : result), // intentional 50k cap — memory protection
```

Line ~1762 in `publishNativeGossip`:
```ts
result.slice(0, 50000) // intentional 50k cap — memory protection
```

Line ~1871 in `gossip_run_complete`:
```ts
result: error ? undefined : (result ? result.slice(0, 50000) : result), // intentional 50k cap — memory protection
```

Line ~1917 in the gossip publish call:
```ts
result.slice(0, 50000) // intentional 50k cap — memory protection
```

- [ ] **Step 4: Verify the fix**

Run a grep to confirm no `task.slice(0, 200)` remains in the file:

```bash
grep -n 'task.slice(0, 200)' apps/cli/src/mcp-server-sdk.ts
```

Expected: no matches.

Run a grep to confirm `result.slice(0, 50000)` still exists (intentional):

```bash
grep -c 'slice(0, 50000)' apps/cli/src/mcp-server-sdk.ts
```

Expected: 4 matches.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "fix: remove 200-char task truncation in gossip_run native path and persistNativeTaskMap"
```

---

### Task 2: Fix prompt injection in gossip_run native path

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts:1816`

- [ ] **Step 1: Understand the vulnerability**

The current code embeds `task` raw into a template literal that generates Agent() call instructions. If `task` contains double-quotes, the instruction string is malformed. Compare with `gossip_dispatch_consensus` which correctly uses `JSON.stringify(agentPrompt)`.

- [ ] **Step 2: Fix the raw string embedding**

Find the `gossip_run` native return around line 1816. After Task 1's fix it looks like:

```ts
`Agent(model: "${config.model}", prompt: "${scopePrefix}${presetPrompt}\\n\\n---\\n\\nTask: ${task}")\n` +
```

Replace with escaped task using `JSON.stringify`:

```ts
`Agent(model: "${config.model}", prompt: ${JSON.stringify(`${scopePrefix}${presetPrompt}\n\n---\n\nTask: ${task}`)})\n` +
```

This wraps the entire prompt in `JSON.stringify`, which correctly escapes quotes, newlines, and special characters. Note: remove the `\\n\\n` double-escaping — `JSON.stringify` handles it.

- [ ] **Step 3: Verify the fix handles edge cases**

Search the file for other sites that build Agent() instruction strings without JSON.stringify:

```bash
grep -n 'Agent(model:' apps/cli/src/mcp-server-sdk.ts | grep -v JSON.stringify
```

Expected: only the `gossip_run` site (which is now fixed). If any other sites appear, apply the same fix.

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "fix: escape task string in gossip_run native dispatch to prevent prompt injection"
```

---

### Task 3: Remove silent timeout cap and fix defaults

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts:983` (gossip_collect default)
- Modify: `apps/cli/src/mcp-server-sdk.ts:1023` (gossip_collect Math.min)
- Modify: `apps/cli/src/mcp-server-sdk.ts:1256` (gossip_collect_consensus Math.min)
- Modify: `apps/cli/src/mcp-server-sdk.ts:1825` (gossip_run relay timeout)

- [ ] **Step 1: Raise gossip_collect default timeout**

Find the `gossip_collect` Zod schema around line 983:

```ts
timeout_ms: z.number().default(120000).describe('Max wait time in ms.'),
```

Change the default to match `gossip_collect_consensus`:

```ts
timeout_ms: z.number().default(300000).describe('Max wait time in ms. Default 5 minutes.'),
```

- [ ] **Step 2: Remove Math.min cap in gossip_collect**

Find around line 1023:

```ts
const nativeTimeout = Math.min(timeout_ms, 120000); // cap native wait at 2min
```

Replace with:

```ts
const nativeTimeout = timeout_ms;
```

- [ ] **Step 3: Remove Math.min cap in gossip_collect_consensus**

Find around line 1256:

```ts
const nativeTimeout = Math.min(timeout_ms, 120000);
```

Replace with:

```ts
const nativeTimeout = timeout_ms;
```

- [ ] **Step 4: Raise gossip_run relay timeout**

Find around line 1825:

```ts
const collectResult = await mainAgent.collect([taskId], 120000);
```

Change to:

```ts
const collectResult = await mainAgent.collect([taskId], 300000);
```

- [ ] **Step 5: Verify no Math.min caps remain for native timeouts**

```bash
grep -n 'Math.min(timeout_ms' apps/cli/src/mcp-server-sdk.ts
```

Expected: no matches.

```bash
grep -n 'default(120000)' apps/cli/src/mcp-server-sdk.ts
```

Expected: no matches related to timeout_ms (may appear in other unrelated schemas — that's fine).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "fix: remove silent 120s timeout cap for native agents, raise defaults to 5min"
```

---

### Task 4: Add gossip_retract_signal to gossip_tools listing

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts:2538` (gossip_tools array)

- [ ] **Step 1: Add the missing entry**

Find the `gossip_tools` handler's tool array around line 2537-2538. After the `gossip_setup` entry, add `gossip_retract_signal`:

Before:
```ts
      { name: 'gossip_bootstrap', desc: 'Generate team context prompt with live agent state' },
      { name: 'gossip_setup', desc: 'Create or update team configuration' },
    ];
```

After:
```ts
      { name: 'gossip_bootstrap', desc: 'Generate team context prompt with live agent state' },
      { name: 'gossip_setup', desc: 'Create or update team configuration' },
      { name: 'gossip_retract_signal', desc: 'Retract a previously recorded signal (e.g., wrong severity). Append-only — excluded from scoring.' },
    ];
```

- [ ] **Step 2: Verify tool count**

```bash
grep -c "{ name: 'gossip_" apps/cli/src/mcp-server-sdk.ts | tail -1
```

The `gossip_tools` array should now have 27 entries (matching the 27 registered `server.tool()` calls).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "fix: add gossip_retract_signal to gossip_tools discovery listing"
```

---

### Task 5: Fix evidence truncation in auto-signal recording

**Files:**
- Modify: `apps/cli/src/mcp-server-sdk.ts:1077`

- [ ] **Step 1: Remove evidence truncation**

Find around line 1077:

```ts
evidence: r.status === 'failed' ? `Task failed: ${(r.error || '').slice(0, 100)}`
```

Replace with:

```ts
evidence: r.status === 'failed' ? `Task failed: ${r.error || 'unknown error'}`
```

- [ ] **Step 2: Commit**

```bash
git add apps/cli/src/mcp-server-sdk.ts
git commit -m "fix: show full error in auto-signal evidence instead of truncating to 100 chars"
```

---

### Task 6: Rebuild MCP bundle and verify

**Files:**
- Build: `dist-mcp/mcp-server.js`

- [ ] **Step 1: Build workspace packages**

```bash
npm run build --workspaces 2>&1 | grep -E '(error|built|Dashboard)'
```

The CLI package may show TS errors (known issue) — ignore those. All other packages should build cleanly.

- [ ] **Step 2: Build MCP bundle**

```bash
npm run build:mcp
```

Expected: `dist-mcp/mcp-server.js` rebuilt with esbuild.

- [ ] **Step 3: Verify truncation fix**

```bash
grep -c 'task.slice(0, 200)' dist-mcp/mcp-server.js
```

Expected: 0 matches.

- [ ] **Step 4: Verify timeout cap fix**

```bash
grep -c 'Math.min(timeout_ms' dist-mcp/mcp-server.js
```

Expected: 0 matches.

- [ ] **Step 5: Verify retract_signal in tools listing**

```bash
grep 'gossip_retract_signal' dist-mcp/mcp-server.js | head -3
```

Expected: appears in both the tool registration and the gossip_tools listing.

- [ ] **Step 6: Verify injection fix**

```bash
grep -c 'JSON.stringify' dist-mcp/mcp-server.js | head -1
```

Expected: count includes the new JSON.stringify in gossip_run's native path.

- [ ] **Step 7: Verify bundle loads**

```bash
node -e "try { require('./dist-mcp/mcp-server.js'); } catch(e) { if (e.code === 'EADDRINUSE') console.log('OK: bundle loads (port in use)'); else console.log('ERROR:', e.message); }" 2>&1 &
PID=$!; sleep 2; kill $PID 2>/dev/null
```

Expected: "OK: bundle loads (port in use)" or similar indicating the bundle executes without syntax/import errors.

- [ ] **Step 8: Commit bundle**

```bash
git add dist-mcp/mcp-server.js
git commit -m "build: rebuild MCP bundle with Batch 1 bug fixes"
```

---

## Subsequent Batches

Batches 2-4 are separate implementation plans to be written after Batch 1 ships:

- **Batch 2: Tool Consolidation** — 27→12 tools with dual-mode deprecation. Requires its own plan with detailed tool-by-tool migration steps.
- **Batch 3: Native Auto-Relay** — Timeout watcher, race condition hardening, error propagation. Requires Tier 1 consensus review before implementation.
- **Batch 4: Feedback Quality** — Progress streaming, actionable errors, timing data. Straightforward implementation, no Tier review needed.
