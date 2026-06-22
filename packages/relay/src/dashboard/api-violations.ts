import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface ViolationEntry {
  taskId: string;
  agentId: string;
  preSha: string;
  postSha: string;
  detectedAt: string;   // ISO-8601
  commits: string[];    // "sha subject" strings
}

export interface ViolationsResponse {
  items: ViolationEntry[];
  total: number;
  page: number;
  pageSize: number;
}

const FILE = '.gossip/process-violations.jsonl';

export function violationsHandler(
  projectRoot: string,
  query?: URLSearchParams,
): ViolationsResponse {
  const page = Math.max(1, parseInt(query?.get('page') ?? '1', 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(query?.get('pageSize') ?? '25', 10)));
  const agentFilter = query?.get('agentId') ?? null;

  const filePath = join(projectRoot, FILE);
  if (!existsSync(filePath)) {
    return { items: [], total: 0, page, pageSize };
  }

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.trim().split('\n').filter(Boolean);

  const entries: ViolationEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as ViolationEntry;
      if (!agentFilter || entry.agentId === agentFilter) {
        entries.push(entry);
      }
    } catch { continue; }
  }

  entries.sort((a, b) =>
    new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime()
  );

  const total = entries.length;
  const start = (page - 1) * pageSize;
  return { items: entries.slice(start, start + pageSize), total, page, pageSize };
}
