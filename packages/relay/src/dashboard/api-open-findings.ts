// packages/relay/src/dashboard/api-open-findings.ts
//
// GET /dashboard/api/open-findings — surfaces the open + recently-resolved
// findings table for the dashboard with `state: open | resolved |
// stale-anchor` and an optional resolved-by-commit SHA so the UI can
// render a green "→ <sha>" badge linking to GitHub.
//
// Spec: docs/specs/2026-04-27-open-findings-auto-resolve.md (rev2,
// consensus b3f57cc6-22c24114) — "Dashboard surface" section.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface OpenFindingRow {
  finding_id: string;
  state: 'open' | 'resolved' | 'stale-anchor';
  resolved_by?: string; // "commit:<sha>" | "stale_anchor" | "manual"
  resolved_at?: string; // ISO-8601
  finding: string;
  agent_id?: string;
  tag?: string;
  severity?: string;
  timestamp?: string;
}

export interface OpenFindingsResponse {
  rows: OpenFindingRow[];
  totals: {
    open: number;
    resolved: number;
    staleAnchor: number;
  };
}

export async function openFindingsHandler(projectRoot: string): Promise<OpenFindingsResponse> {
  const rows: OpenFindingRow[] = [];
  let open = 0;
  let resolved = 0;
  let staleAnchor = 0;
  const findingsPath = join(projectRoot, '.gossip', 'implementation-findings.jsonl');
  if (!existsSync(findingsPath)) {
    return { rows, totals: { open: 0, resolved: 0, staleAnchor: 0 } };
  }
  let raw: string;
  try { raw = readFileSync(findingsPath, 'utf-8'); }
  catch { return { rows, totals: { open: 0, resolved: 0, staleAnchor: 0 } }; }
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines) {
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    const findingId = String(entry.taskId ?? entry.findingId ?? entry.id ?? '');
    if (!findingId) continue;
    // Skip insight rows — they pollute the actionable findings count.
    // type:null legacy rows are preserved (spec §Design cheap variant).
    if (entry.type === 'insight') continue;
    let state: 'open' | 'resolved' | 'stale-anchor';
    if (entry.status === 'resolved') {
      state = entry.resolvedBy === 'stale_anchor' ? 'stale-anchor' : 'resolved';
    } else {
      state = 'open';
    }
    if (state === 'open') open++;
    else if (state === 'resolved') resolved++;
    else staleAnchor++;

    rows.push({
      finding_id: findingId,
      state,
      resolved_by: entry.resolvedBy,
      resolved_at: entry.resolvedAt,
      finding: typeof entry.finding === 'string' ? entry.finding : '',
      agent_id: entry.originalAgentId,
      tag: entry.tag,
      severity: entry.severity,
      timestamp: entry.timestamp,
    });
  }
  return { rows, totals: { open, resolved, staleAnchor } };
}
