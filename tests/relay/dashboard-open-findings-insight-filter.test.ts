// Spec: docs/specs/2026-04-28-write-time-insight-filter.md (consensus 7438ce05-25ff407f)
//
// Extracted from tests/relay/dashboard-edge-cases.test.ts so these assertions run
// in CI. The parent suite is gated by RUN_KNOWN_BROKEN=1 due to 3 pre-existing
// totalSignals failures unrelated to the insight filter.
import { openFindingsHandler } from '@gossip/relay/dashboard/api-open-findings';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Dashboard API: api-open-findings insight filter', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'gossip-dash-insight-'));
    mkdirSync(join(projectRoot, '.gossip'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('excludes type:insight rows from count and list, includes type:finding rows', async () => {
    const insightEntry = JSON.stringify({ taskId: 'task-insight-1', finding: 'Informational insight note', status: 'open', type: 'insight', timestamp: new Date().toISOString() });
    const findingEntry = JSON.stringify({ taskId: 'task-finding-1', finding: 'Actionable security finding', status: 'open', type: 'finding', timestamp: new Date().toISOString() });
    writeFileSync(join(projectRoot, '.gossip', 'implementation-findings.jsonl'), [insightEntry, findingEntry].join('\n') + '\n');

    const result = await openFindingsHandler(projectRoot);

    expect(result.totals.open).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].finding_id).toBe('task-finding-1');
    expect(result.rows.some(r => r.finding_id === 'task-insight-1')).toBe(false);
  });

  it('does NOT exclude type:null legacy rows (cheap variant — null stays visible)', async () => {
    const legacyEntry = JSON.stringify({ taskId: 'task-legacy-1', finding: 'Legacy finding with null type', status: 'open', type: null, timestamp: new Date().toISOString() });
    writeFileSync(join(projectRoot, '.gossip', 'implementation-findings.jsonl'), legacyEntry + '\n');

    const result = await openFindingsHandler(projectRoot);

    expect(result.totals.open).toBe(1);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].finding_id).toBe('task-legacy-1');
  });
});
