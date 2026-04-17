import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve, relative } from 'path';

// Consensus/finding IDs come from URL segments after decodeURIComponent.
// Reject anything that could escape the consensus-reports directory via
// path separators, `..`, or NUL bytes. Alphanumerics, `-`, `_`, `:` only —
// covers the 8-8 hex format and the `<consensusId>:<agentId>:fN` shape.
const SAFE_ID = /^[\w:.\-]+$/;

export interface CitationSnippet {
  file: string;
  line: number;
  snippet: string;
}

export interface FindingDetailSignal {
  signal: string;
  agentId: string;
  counterpartId?: string;
  evidence?: string;
  timestamp: string;
}

export interface FindingDetail {
  consensusId: string;
  finding: {
    id: string;
    authorFindingId?: string;
    originalAgentId: string;
    finding: string;
    findingType: 'finding' | 'suggestion' | 'insight';
    severity?: 'critical' | 'high' | 'medium' | 'low';
    tag: 'confirmed' | 'disputed' | 'unverified' | 'unique' | 'insight' | 'newFinding';
    confirmedBy: string[];
    disputedBy: { agentId: string; reason: string }[];
    confidence: number;
  };
  signals: FindingDetailSignal[];
  citations: CitationSnippet[];
  retracted?: { reason: string; at: string };
}

const SNIPPET_CONTEXT = 2;
// Stateful `g` regex is safe because extractCitations is synchronous, but use a
// local instance anyway so a future `await` inside the loop cannot break
// concurrent callers via shared `lastIndex`.
const CITE_PATTERN = /<cite tag="file">([^<:]+):(\d+)<\/cite>/g;

function extractCitations(findingText: string, projectRoot: string): CitationSnippet[] {
  const out: CitationSnippet[] = [];
  // Resolve the root through any symlinks (e.g. macOS `/tmp` → `/private/tmp`)
  // so subsequent realpath comparisons are apples-to-apples.
  let realRoot: string;
  try { realRoot = realpathSync(resolve(projectRoot)); } catch { return out; }
  const re = new RegExp(CITE_PATTERN.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(findingText)) !== null) {
    const filePath = m[1];
    const line = parseInt(m[2], 10);
    if (!Number.isFinite(line) || line < 1) continue;
    // Reject NUL bytes outright — they can split paths on some filesystems.
    if (filePath.includes('\0')) continue;
    const abs = resolve(realRoot, filePath);
    // Pre-check on the resolved-but-not-real path — catches `../../etc/passwd`
    // before we touch the filesystem at all.
    const preRel = relative(realRoot, abs);
    if (preRel === '' || preRel.startsWith('..')) continue;
    if (!existsSync(abs)) { out.push({ file: filePath, line, snippet: '// file not found' }); continue; }
    // Resolve symlinks and confirm the REAL path still lives under the REAL
    // project root. A bare `relative().startsWith('..')` is symlink-blind.
    let realAbs: string;
    try { realAbs = realpathSync(abs); } catch { continue; }
    const rel = relative(realRoot, realAbs);
    if (rel === '' || rel.startsWith('..')) continue;
    try {
      const lines = readFileSync(realAbs, 'utf-8').split('\n');
      const start = Math.max(0, line - 1 - SNIPPET_CONTEXT);
      const end = Math.min(lines.length, line + SNIPPET_CONTEXT);
      out.push({ file: filePath, line, snippet: lines.slice(start, end).join('\n') });
    } catch { out.push({ file: filePath, line, snippet: '// read error' }); }
  }
  return out;
}

export async function findingHandler(
  projectRoot: string,
  consensusId: string,
  findingId: string,
): Promise<FindingDetail> {
  // URL segments reach this handler already decodeURIComponent'd, so `%2e%2e%2f`
  // will have expanded to `../` — allowlist the decoded form before it touches
  // the filesystem.
  if (!SAFE_ID.test(consensusId)) throw new Error(`consensus ${consensusId} not found`);
  if (!SAFE_ID.test(findingId)) throw new Error(`finding ${findingId} not found in ${consensusId}`);
  const reportPath = join(projectRoot, '.gossip', 'consensus-reports', `${consensusId}.json`);
  if (!existsSync(reportPath)) throw new Error(`consensus ${consensusId} not found`);
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

  const buckets: [string, FindingDetail['finding']['tag']][] = [
    ['confirmed', 'confirmed'], ['disputed', 'disputed'],
    ['unverified', 'unverified'], ['unique', 'unique'],
    ['insights', 'insight'], ['newFindings', 'newFinding'],
  ];
  let found: any = null;
  let tag: FindingDetail['finding']['tag'] = 'unverified';
  for (const [bucket, tagName] of buckets) {
    const hit = (report[bucket] || []).find((f: any) => f.id === findingId);
    if (hit) { found = hit; tag = tagName; break; }
  }
  if (!found) throw new Error(`finding ${findingId} not found in ${consensusId}`);

  const signals: FindingDetailSignal[] = [];
  const perfPath = join(projectRoot, '.gossip', 'agent-performance.jsonl');
  if (existsSync(perfPath)) {
    const lines = readFileSync(perfPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.findingId === findingId) {
          signals.push({
            signal: rec.signal,
            agentId: rec.agentId,
            counterpartId: rec.counterpartId,
            evidence: rec.evidence,
            timestamp: rec.timestamp,
          });
        }
      } catch { /* skip */ }
    }
  }

  const citations = extractCitations(found.finding || '', projectRoot);

  return {
    consensusId,
    finding: {
      id: found.id,
      authorFindingId: found.authorFindingId,
      originalAgentId: found.originalAgentId,
      finding: found.finding,
      findingType: found.findingType,
      severity: found.severity,
      tag,
      confirmedBy: found.confirmedBy || [],
      disputedBy: found.disputedBy || [],
      confidence: found.confidence ?? 0,
    },
    signals,
    citations,
  };
}
