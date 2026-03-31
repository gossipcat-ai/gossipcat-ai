# Scoring, Redundancy & Dashboard Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 14 confirmed findings: 3 critical scoring bugs, 2 scoring design improvements, 4 code dedup issues, 4 dashboard UI improvements, and 1 escapeHtml audit.

**Architecture:** Four independent batches (A: critical scoring bugs, B: scoring design, C: pipeline dedup, D: dashboard UI). Each batch can be committed and tested independently.

**Tech Stack:** TypeScript, Jest, vanilla JS (dashboard)

**Spec:** `docs/superpowers/specs/2026-03-31-scoring-redundancy-dashboard-fixes.md`

---

## Batch A: Critical Scoring Bugs

### Task 1: Fix retractSignal call in native-tasks.ts (F1)

**Files:**
- Modify: `apps/cli/src/handlers/native-tasks.ts:178-183`

- [ ] **Step 1: Read the broken code**

Read `apps/cli/src/handlers/native-tasks.ts` around line 178-183. The current code:
```typescript
try {
  const { PerformanceWriter } = require('@gossip/orchestrator');
  const writer = new PerformanceWriter(process.cwd());
  writer.retractSignal(taskInfo.agentId, task_id, 'Late relay arrived — agent completed successfully after timeout');
  process.stderr.write(`[gossipcat] Retracted timeout signal for ${taskInfo.agentId} [${task_id}]\n`);
} catch { /* best-effort */ }
```

- [ ] **Step 2: Replace with appendSignals pattern**

Replace the try block contents with the `signal_retracted` append pattern used in `mcp-server-sdk.ts:1211-1218`:

```typescript
try {
  const { PerformanceWriter } = require('@gossip/orchestrator');
  const writer = new PerformanceWriter(process.cwd());
  writer.appendSignals([{
    type: 'consensus' as const,
    signal: 'signal_retracted' as const,
    agentId: taskInfo.agentId,
    taskId: task_id,
    evidence: 'Late relay arrived — agent completed successfully after timeout',
    timestamp: new Date().toISOString(),
  }]);
  process.stderr.write(`[gossipcat] Retracted timeout signal for ${taskInfo.agentId} [${task_id}]\n`);
} catch { /* best-effort */ }
```

- [ ] **Step 3: Build and verify**

Run: `npm run build -w packages/orchestrator && npm run build:mcp 2>&1 | tail -3`

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/handlers/native-tasks.ts
git commit -m "fix(native-tasks): use appendSignals for signal retraction instead of missing retractSignal

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fix double signal writes in collect.ts (F3)

**Files:**
- Modify: `apps/cli/src/handlers/collect.ts:186-222`

The consensus engine (`dispatch-pipeline.ts:975`) already writes per-cross-review-entry signals (agreement/disagreement/unverified for each reviewer's assessment). Our provisional signals should only cover the TAG-level summary for each finding's ORIGINAL AUTHOR — and only if that author doesn't already have a signal from the engine pass.

- [ ] **Step 1: Read the current provisional signal block**

Read `apps/cli/src/handlers/collect.ts` lines 186-222.

- [ ] **Step 2: Filter out already-signaled agents**

Replace the provisional signal block with one that checks `consensusReport.signals` for existing coverage:

```typescript
  // Auto-record provisional signals for consensus findings NOT already covered by engine signals
  let provisionalSignalCount = 0;
  try {
    const { PerformanceWriter } = await import('@gossip/orchestrator');
    const writer = new PerformanceWriter(process.cwd());
    const timestamp = new Date().toISOString();

    const tagToSignal: Record<string, string> = {
      confirmed: 'unique_confirmed',
      disputed: 'disagreement',
      unverified: 'unique_unconfirmed',
      unique: 'unique_unconfirmed',
    };

    // Build set of agent+finding combos already signaled by the consensus engine
    const alreadySignaled = new Set<string>();
    for (const s of (consensusReport.signals || [])) {
      alreadySignaled.add(s.agentId);
    }

    const allFindings = [
      ...(consensusReport.confirmed || []),
      ...(consensusReport.disputed || []),
      ...(consensusReport.unverified || []),
      ...(consensusReport.unique || []),
    ];

    // Only record provisional signals for finding authors NOT already covered
    const provisionalSignals = allFindings
      .filter((f: any) => !alreadySignaled.has(f.originalAgentId))
      .map((f: any) => ({
        type: 'consensus' as const,
        taskId: f.id || '',
        signal: tagToSignal[f.tag] || 'unique_unconfirmed',
        agentId: f.originalAgentId,
        evidence: `[provisional] ${(f.finding || '').slice(0, 200)}`,
        timestamp,
      }));

    if (provisionalSignals.length > 0) {
      writer.appendSignals(provisionalSignals);
      provisionalSignalCount = provisionalSignals.length;
      process.stderr.write(`[gossipcat] Auto-recorded ${provisionalSignalCount} provisional signal(s). Retract incorrect ones with gossip_signals(action: "retract").\n`);
    }
  } catch { /* best-effort */ }
```

- [ ] **Step 3: Build and verify**

Run: `npm run build -w packages/orchestrator && npm run build:mcp 2>&1 | tail -3`

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/handlers/collect.ts
git commit -m "fix(collect): filter provisional signals to avoid double-counting with consensus engine signals

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fix totalSignals double-count on disagreement winner (F11)

**Files:**
- Modify: `packages/orchestrator/src/performance-reader.ts:217`
- Test: `tests/orchestrator/dispatch-pipeline.test.ts` (or performance reader tests if they exist)

- [ ] **Step 1: Check for existing performance-reader tests**

Run: `find tests -name "*performance*" -o -name "*scoring*" 2>/dev/null`

- [ ] **Step 2: Read the disagreement case**

Read `packages/orchestrator/src/performance-reader.ts` lines 208-219. The current code:

```typescript
case 'disagreement': {
  a.weightedTotal += decay;
  a.disagreements++;
  if (signal.counterpartId && signal.counterpartId.length > 0) {
    const winner = ensure(signal.counterpartId);
    const wi = winner.tasksSeen.get(taskKey) ?? winner.taskCounter - 1;
    const wSince = winner.taskCounter - wi - 1;
    const wd = Math.pow(0.5, wSince / DECAY_HALF_LIFE);
    winner.weightedCorrect += wd;
    winner.weightedTotal += wd;
    winner.totalSignals++;  // ← BUG: double-counts
  }
  break;
}
```

- [ ] **Step 3: Remove the winner.totalSignals++ line**

Delete line 217 (`winner.totalSignals++`). The winner's own signal row already increments `totalSignals` at line 188 when that row is processed.

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator --no-coverage 2>&1 | tail -5`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/performance-reader.ts
git commit -m "fix(scoring): remove totalSignals double-count for disagreement winners

Winner was getting totalSignals++ both from the disagreement counterpart
path (line 217) and from their own signal row (line 188).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Batch B: Scoring Design Improvements

### Task 4: Add slow time decay for bad agents (F9)

**Files:**
- Modify: `packages/orchestrator/src/performance-reader.ts:299-306`

- [ ] **Step 1: Read the current time decay block**

Lines 299-306 currently apply decay only for `reliability >= 0.5`.

- [ ] **Step 2: Implement bidirectional decay**

Replace the time decay block:

```typescript
// Time-based decay: pull reliability toward neutral (0.5) based on inactivity.
// Good agents (>= 0.5): fast decay (7-day half-life) — lose their edge
// Bad agents (< 0.5): slow decay (21-day half-life) — gradual rehabilitation
if (a.lastSignalMs > 0) {
  const daysSinceLastSignal = (now - a.lastSignalMs) / 86400000;
  const halfLife = reliability >= 0.5 ? TIME_DECAY_HALF_LIFE_DAYS : TIME_DECAY_HALF_LIFE_DAYS * 3;
  const timeFreshness = Math.pow(0.5, daysSinceLastSignal / halfLife);
  reliability = 0.5 + (reliability - 0.5) * timeFreshness;
}
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator --no-coverage 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/performance-reader.ts
git commit -m "fix(scoring): allow slow rehabilitation for bad agents via 21-day time decay

Previously agents with reliability < 0.5 never recovered. Now they
decay toward 0.5 at 3x slower rate than good agents.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Add signal volume confidence to dispatch weight (F10)

**Files:**
- Modify: `packages/orchestrator/src/performance-reader.ts:73-79`

- [ ] **Step 1: Read the current dispatch weight formula**

Lines 73-79:
```typescript
getDispatchWeight(agentId: string): number {
  const score = this.getAgentScore(agentId);
  if (!score || score.totalSignals < 3) return 1.0;
  if (score.circuitOpen) return 0.3;
  return clamp(0.3 + score.reliability * 1.7, 0.3, 2.0);
}
```

- [ ] **Step 2: Add confidence blending**

```typescript
getDispatchWeight(agentId: string): number {
  const score = this.getAgentScore(agentId);
  if (!score || score.totalSignals < 3) return 1.0; // not enough data, neutral
  if (score.circuitOpen) return 0.3;
  // Confidence increases with signal volume: 3 signals → ~0.26, 10 → ~0.63, 30 → ~0.95
  const confidence = 1 - Math.exp(-score.totalSignals / 10);
  // Blend reliability toward neutral (0.5) based on confidence
  const adjusted = 0.5 + (score.reliability - 0.5) * confidence;
  return clamp(0.3 + adjusted * 1.7, 0.3, 2.0);
}
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator --no-coverage 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/performance-reader.ts
git commit -m "feat(scoring): add signal volume confidence to dispatch weight

Agents with few signals are blended toward neutral. 3 signals = 26%
confidence, 10 = 63%, 30 = 95%. Prevents overconfident weighting
from small sample sizes.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Batch C: Pipeline Dedup

### Task 6: Fix CompetencyProfiler to use PerformanceReader's signal filtering (F2)

**Files:**
- Modify: `packages/orchestrator/src/competency-profiler.ts:249-257` and `:204`

- [ ] **Step 1: Make CompetencyProfiler delegate signal reading to PerformanceReader**

Replace the `readSignals()` method in CompetencyProfiler:

```typescript
private readSignals(): PerformanceSignal[] {
  // Delegate to PerformanceReader for consistent expiry + retraction filtering
  const reader = new PerformanceReader(this.filePath.replace('/agent-performance.jsonl', ''));
  // PerformanceReader.readSignals is private, so we read the same file but apply the same filtering
  if (!existsSync(this.filePath)) return [];
  try {
    const SIGNAL_EXPIRY_DAYS = 30;
    const expiryMs = Date.now() - SIGNAL_EXPIRY_DAYS * 86400000;
    const lines = readFileSync(this.filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const all = lines.map(line => {
      try { return JSON.parse(line) as PerformanceSignal; }
      catch { return null; }
    }).filter((s): s is PerformanceSignal => s !== null && typeof s.agentId === 'string' && s.agentId.length > 0);

    // Apply retraction filtering (matches PerformanceReader logic)
    const retracted = new Set<string>();
    for (const s of all) {
      if ((s as any).signal === 'signal_retracted') {
        const taskKey = s.taskId || s.timestamp;
        retracted.add(s.agentId + ':' + taskKey + ':*');
      }
    }

    return all.filter(s => {
      if ((s as any).signal === 'signal_retracted') return false;
      const ts = s.timestamp ? new Date(s.timestamp).getTime() : 0;
      if (!isFinite(ts) || ts === 0 || ts < expiryMs) return false;
      const taskKey = s.taskId || s.timestamp;
      if (retracted.has(s.agentId + ':' + taskKey + ':*')) return false;
      return true;
    });
  } catch { return []; }
}
```

- [ ] **Step 2: Align the blend ratio**

At line 204, change `acc * 0.7 + uniq * 0.3` to `acc * 0.8 + uniq * 0.2` to match PerformanceReader:

```typescript
p.reviewReliability = clamp(acc * 0.8 + uniq * 0.2, 0, 1);
```

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator --no-coverage 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/competency-profiler.ts
git commit -m "fix(competency): add signal expiry + retraction filtering, align blend ratio to 0.8/0.2

CompetencyProfiler was reading all signals including expired/retracted
ones. Now applies 30-day expiry and retraction filtering matching
PerformanceReader. Blend ratio aligned from 0.7/0.3 to 0.8/0.2.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Fix task-graph-sync reading wrong fields (F4)

**Files:**
- Modify: `packages/orchestrator/src/task-graph-sync.ts:146-169`

- [ ] **Step 1: Read the current sync code**

Read lines 146-169. It reads `agent-performance.jsonl` but posts `entry.scores?.relevance` etc. which don't exist.

- [ ] **Step 2: Fix to post actual signal fields**

```typescript
async syncAgentScores(): Promise<number> {
  const perfPath = join(this.gossipDir, 'agent-performance.jsonl');
  if (!existsSync(perfPath)) return 0;
  const content = readFileSync(perfPath, 'utf-8');
  const lines = content.trim().split('\n').filter(Boolean);
  const meta = this.graph.getSyncMeta();
  let synced = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (meta.lastSync && entry.timestamp <= meta.lastSync) continue;
      if (!entry.agentId || !entry.signal) continue; // skip malformed
      await this.post('/rest/v1/agent_scores', {
        user_id: this.userId,
        agent_id: entry.agentId,
        task_id: entry.taskId || null,
        signal: entry.signal,
        evidence: (entry.evidence || '').slice(0, 500),
        source: 'consensus',
        created_at: entry.timestamp,
        project_id: this.projectId,
        display_name: this.displayName || null,
      });
      synced++;
    } catch { /* skip malformed entries */ }
  }
  return synced;
}
```

Note: This changes the Supabase schema expectation. The `agent_scores` table needs `signal` and `evidence` columns instead of `relevance/accuracy/uniqueness`. If the table doesn't support this, just fix the posting to not send undefined fields — replace `entry.scores?.relevance` with `null` to make the intent explicit:

```typescript
relevance: null, accuracy: null, uniqueness: null,
```

Use whichever approach matches the current Supabase schema. Read the table definition if accessible, otherwise use the null approach (safer).

- [ ] **Step 3: Run tests**

Run: `npx jest tests/orchestrator --no-coverage 2>&1 | tail -5`

- [ ] **Step 4: Commit**

```bash
git add packages/orchestrator/src/task-graph-sync.ts
git commit -m "fix(sync): post actual signal fields instead of undefined scores to Supabase

agent-performance.jsonl contains signal entries, not scored entries.
Previous code posted entry.scores?.relevance which was always undefined.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Extract shared constants and deduplicate consensus gate (F5, F6)

**Files:**
- Modify: `packages/orchestrator/src/performance-reader.ts` (extract clamp)
- Modify: `packages/orchestrator/src/competency-profiler.ts` (use shared clamp)
- Modify: `packages/orchestrator/src/dispatch-pipeline.ts` (extract _postTaskComplete, shared constant)

- [ ] **Step 1: Extract MIN_AGENTS_FOR_CONSENSUS constant**

Add to `packages/orchestrator/src/types.ts`:
```typescript
export const MIN_AGENTS_FOR_CONSENSUS = 2;
```

- [ ] **Step 2: Use constant in both files**

In `dispatch-pipeline.ts`, replace the hardcoded `>= 2` in the consensus check with:
```typescript
import { MIN_AGENTS_FOR_CONSENSUS } from './types';
// ...
if (options?.consensus && this.llm && results.filter(r => r.status === 'completed').length >= MIN_AGENTS_FOR_CONSENSUS)
```

In `apps/cli/src/handlers/collect.ts`, replace:
```typescript
if (consensus && allResults.filter((r: any) => r.status === 'completed').length >= 2)
```
with importing and using the constant (or just reference 2 with a comment — the CLI handler may not have direct access to the orchestrator types).

- [ ] **Step 3: Extract _postTaskComplete helper in dispatch-pipeline.ts**

Find the duplicated 3-step memory write sequence in both `collect()` (~line 502-545) and `writeMemoryForTask()` (~line 826-856). Extract to a private method:

```typescript
private async _postTaskComplete(t: TrackedTask): Promise<void> {
  const config = this.registryGet(t.agentId);
  const scores = {
    relevance: (t.result?.length ?? 0) > 200 ? 4 : 3,
    accuracy: 4,
    uniqueness: 3,
  };
  this.taskGraph.recordCompleted(t.id, t.agentId, t.task, scores, t.inputTokens, t.outputTokens);
  
  if (this.memWriter) {
    await this.memWriter.writeTaskEntry(t.agentId, {
      taskId: t.id, task: t.task, skills: config?.skills || [],
      findings: 0, hallucinated: 0, scores,
      warmth: 1, importance: 1,
    });
    if (t.result) {
      await this.memWriter.writeKnowledgeFromResult(t.agentId, t.id, t.task, t.result);
      await this.memWriter.rebuildIndex(t.agentId);
    }
  }
  if (this.memCompactor) {
    await this.memCompactor.compactIfNeeded(t.agentId);
  }
}
```

Then call it from both `collect()` and `writeMemoryForTask()`.

- [ ] **Step 4: Run tests**

Run: `npx jest tests/orchestrator --no-coverage 2>&1 | tail -5`

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator/src/types.ts packages/orchestrator/src/dispatch-pipeline.ts apps/cli/src/handlers/collect.ts
git commit -m "refactor(dispatch): extract _postTaskComplete helper and MIN_AGENTS_FOR_CONSENSUS constant

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Batch D: Dashboard UI

### Task 9: Add stat bars below agent rings (F12)

**Files:**
- Modify: `packages/dashboard/src/hub/team.js:39-52`

- [ ] **Step 1: Add stat bars after the ring and name**

After the ring SVG and agent name, add 4 small stat bars:

```javascript
const reliability = agent.scores?.reliability ?? 0.5;
const uniqueness = agent.scores?.uniqueness ?? 0.5;

btn.innerHTML =
  '<div class="ag-ring-wrap">' +
    '<svg class="ag-ring" viewBox="0 0 48 48" style="opacity:' + ringOpacity + '">' +
      '<circle cx="24" cy="24" r="21" fill="none" stroke="' + ringColor + '" stroke-width="3" opacity="0.2"/>' +
      '<circle cx="24" cy="24" r="21" fill="none" stroke="' + ringColor + '" stroke-width="3"' +
        ' stroke-dasharray="' + arcLength + ' 132"' +
        ' transform="rotate(-90 24 24)"/>' +
    '</svg>' +
    '<span class="ag-initials" style="color:' + ringColor + '">' + agentInitials(agent.id) + '</span>' +
  '</div>' +
  '<span class="ag-name">' + e(agent.id) + '</span>' +
  '<div class="ag-stats">' +
    '<div class="ag-stat"><span class="ag-stat-label">acc</span><div class="ag-stat-bar"><div class="ag-stat-fill" style="width:' + (accuracy * 100) + '%;background:' + ringColor + '"></div></div></div>' +
    '<div class="ag-stat"><span class="ag-stat-label">rel</span><div class="ag-stat-bar"><div class="ag-stat-fill" style="width:' + (reliability * 100) + '%;background:' + ringColor + '"></div></div></div>' +
    '<div class="ag-stat"><span class="ag-stat-label">uniq</span><div class="ag-stat-bar"><div class="ag-stat-fill" style="width:' + (uniqueness * 100) + '%;background:' + ringColor + '"></div></div></div>' +
  '</div>' +
  '<span class="ag-last">' + lastText +
    (lastTime ? ' <span class="ag-time">' + lastTime + '</span>' : '') +
  '</span>';
```

- [ ] **Step 2: Add CSS for stat bars**

Add to `packages/dashboard/src/styles.css` (or wherever dashboard styles live):

```css
.ag-stats { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 0 4px; }
.ag-stat { display: flex; align-items: center; gap: 4px; }
.ag-stat-label { font-size: 9px; color: var(--text-3); width: 24px; text-align: right; }
.ag-stat-bar { flex: 1; height: 3px; background: var(--bg-2); border-radius: 2px; overflow: hidden; }
.ag-stat-fill { height: 100%; border-radius: 2px; transition: width 0.3s; }
```

- [ ] **Step 3: Build dashboard**

Run: `npm run build:dashboard && npm run build:mcp 2>&1 | tail -3`

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/hub/team.js packages/dashboard/src/styles.css
git commit -m "feat(dashboard): add accuracy/reliability/uniqueness stat bars to agent cards

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Add stacked bar to consensus run cards (F14)

**Files:**
- Modify: `packages/dashboard/src/hub/activity.js:24-47`

- [ ] **Step 1: Add stacked proportion bar after pills**

After the pills div, add a stacked bar showing proportions:

```javascript
// Build stacked bar segments
const segments = [];
if (c.agreement) segments.push('<div class="bar-seg bar-seg-g" style="width:' + ((c.agreement / total) * 100) + '%"></div>');
if (c.disagreement || c.hallucination) segments.push('<div class="bar-seg bar-seg-r" style="width:' + (((c.disagreement || 0) + (c.hallucination || 0)) / total * 100) + '%"></div>');
if (c.unverified) segments.push('<div class="bar-seg bar-seg-y" style="width:' + ((c.unverified / total) * 100) + '%"></div>');
if (c.unique) segments.push('<div class="bar-seg bar-seg-b" style="width:' + ((c.unique / total) * 100) + '%"></div>');

const barHtml = total > 0 ? '<div class="run-bar">' + segments.join('') + '</div>' : '';
```

Add `barHtml` after `run-pills` in the header innerHTML:
```javascript
'<div class="run-pills">' + pills.join('') + '</div>' +
barHtml;
```

- [ ] **Step 2: Add CSS**

```css
.run-bar { display: flex; height: 4px; border-radius: 2px; overflow: hidden; margin-top: 4px; }
.bar-seg { min-width: 2px; }
.bar-seg-g { background: var(--green); }
.bar-seg-r { background: var(--red); }
.bar-seg-y { background: var(--amber); }
.bar-seg-b { background: var(--blue, #5b9bd5); }
```

- [ ] **Step 3: Build and commit**

```bash
npm run build:dashboard && npm run build:mcp
git add packages/dashboard/src/hub/activity.js packages/dashboard/src/styles.css
git commit -m "feat(dashboard): add stacked proportion bar to consensus run cards

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Add signal trend sparkline (F13)

**Files:**
- Modify: `packages/dashboard/src/detail/signals.js`

- [ ] **Step 1: Add sparkline before the signal list**

At the top of the signal rendering (before the filter loop), group signals by day and render a mini chart:

```javascript
// Sparkline: group by day, count positive vs negative
const byDay = new Map();
for (const s of signals) {
  const day = (s.timestamp || '').slice(0, 10);
  if (!day) continue;
  const d = byDay.get(day) || { pos: 0, neg: 0 };
  if (['agreement', 'unique_confirmed', 'new_finding', 'consensus_verified'].includes(s.signal)) d.pos++;
  else if (['disagreement', 'hallucination_caught'].includes(s.signal)) d.neg++;
  byDay.set(day, d);
}

if (byDay.size > 1) {
  const spark = document.createElement('div');
  spark.className = 'signal-sparkline';
  const maxCount = Math.max(...[...byDay.values()].map(d => d.pos + d.neg), 1);
  let sparkHtml = '';
  for (const [day, counts] of [...byDay.entries()].sort().slice(-14)) {
    const posH = (counts.pos / maxCount) * 24;
    const negH = (counts.neg / maxCount) * 24;
    sparkHtml += '<div class="spark-col" title="' + day + ': +' + counts.pos + ' -' + counts.neg + '">' +
      '<div class="spark-pos" style="height:' + posH + 'px"></div>' +
      '<div class="spark-neg" style="height:' + negH + 'px"></div>' +
    '</div>';
  }
  spark.innerHTML = sparkHtml;
  container.appendChild(spark);
}
```

- [ ] **Step 2: Add CSS**

```css
.signal-sparkline { display: flex; gap: 2px; align-items: flex-end; height: 28px; margin-bottom: 12px; padding: 0 4px; }
.spark-col { display: flex; flex-direction: column; align-items: center; width: 8px; cursor: help; }
.spark-pos { width: 6px; background: var(--green); border-radius: 1px; }
.spark-neg { width: 6px; background: var(--red); border-radius: 1px; margin-top: 1px; }
```

- [ ] **Step 3: Build and commit**

```bash
npm run build:dashboard && npm run build:mcp
git add packages/dashboard/src/detail/signals.js packages/dashboard/src/styles.css
git commit -m "feat(dashboard): add signal trend sparkline to agent detail view

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Audit escapeHtml usage in dashboard (F15)

**Files:**
- Audit: `packages/dashboard/src/app.js`, `hub/team.js`, `hub/activity.js`, `detail/signals.js`

- [ ] **Step 1: Grep for innerHTML without escapeHtml**

Run: `grep -n 'innerHTML' packages/dashboard/src/**/*.js | grep -v escapeHtml`

Check each instance. The dashboard already uses `escapeHtml` (aliased as `e`) in most places. Verify that ALL dynamic data (agent IDs, task text, evidence, timestamps) pass through `e()` before insertion.

- [ ] **Step 2: Fix any missing escapeHtml calls**

For each dynamic string inserted into innerHTML without escaping, wrap with `e()`. Focus on:
- `agent.id` — should be `e(agent.id)`
- `sig.evidence` — already escaped in activity.js:62
- `sig.agentId` — already escaped in activity.js:64

- [ ] **Step 3: Replace expand/collapse triangle with chevron**

In `hub/activity.js:42`, replace `&#9654;` (right triangle) with `&#8250;` (right chevron) and update the toggle at line 81:
```javascript
// Line 42:
'<span class="run-expand">&#8250;</span>' +
// Line 81:
header.querySelector('.run-expand').innerHTML = isOpen ? '&#8250;' : '&#8964;';
```

- [ ] **Step 4: Build and commit**

```bash
npm run build:dashboard && npm run build:mcp
git add packages/dashboard/src/
git commit -m "fix(dashboard): audit escapeHtml coverage, replace expand icon with chevron

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```

---

## Summary

| Task | Batch | Finding | Files | Priority |
|------|-------|---------|-------|----------|
| 1 | A | F1: retractSignal missing | native-tasks.ts | CRITICAL |
| 2 | A | F3: double signal writes | collect.ts | HIGH |
| 3 | A | F11: totalSignals double-count | performance-reader.ts | HIGH |
| 4 | B | F9: permanent penalty for bad agents | performance-reader.ts | MEDIUM-HIGH |
| 5 | B | F10: volume confidence | performance-reader.ts | MEDIUM |
| 6 | C | F2: diverging scoring pipelines | competency-profiler.ts | HIGH |
| 7 | C | F4: wrong fields in sync | task-graph-sync.ts | MEDIUM |
| 8 | C | F5+F6: dedup constants + helper | types.ts, dispatch-pipeline.ts | LOW |
| 9 | D | F12: stat bars on agent cards | hub/team.js | MEDIUM |
| 10 | D | F14: stacked bar on consensus runs | hub/activity.js | MEDIUM |
| 11 | D | F13: signal trend sparkline | detail/signals.js | MEDIUM |
| 12 | D | F15: escapeHtml audit + chevron | dashboard src/ | LOW |
