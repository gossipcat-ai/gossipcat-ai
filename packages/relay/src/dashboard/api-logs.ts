import { existsSync, openSync, readSync, closeSync, statSync } from 'fs';
import { join } from 'path';

export interface LogEntry {
  line: number;
  text: string;
  category: string;
}

export interface LogsResponse {
  entries: LogEntry[];
  totalLines: number;
  fileSize: number;
  filter?: string;
}

const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/^\[worker:/, 'worker'],
  [/^\[Gemini\]/, 'gemini'],
  [/^\[ToolServer\]/, 'toolserver'],
  [/^dispatch\b/, 'dispatch'],
  [/^relay\b/, 'relay'],
  [/^Cross-review\b/, 'consensus'],
  [/^Consensus\b/, 'consensus'],
  [/^Skill\b/, 'skill'],
  [/^Bootstrap\b/, 'boot'],
  [/^Booted:/, 'boot'],
  [/^Dashboard:/, 'boot'],
  [/^Adaptive\b/, 'boot'],
  [/^Gossip\b/, 'gossip'],
  [/^utility\b/, 'utility'],
  [/^Compacted\b/, 'memory'],
  [/native agent/, 'boot'],
  [/^Restored\b/, 'boot'],
  [/^Skipping\b/, 'boot'],
  [/persist|Persist/, 'persist'],
  [/timeout|Timeout|timed.out/, 'timeout'],
  [/^\[gossipcat\].*(?:Error|error|failed|Failed)/, 'error'],
];

function categorize(text: string): string {
  // Strip [gossipcat] prefix for matching
  const stripped = text.replace(/^\[gossipcat\]\s*/, '');
  for (const [re, cat] of CATEGORY_PATTERNS) {
    if (re.test(stripped)) return cat;
  }
  return 'other';
}

export function logsHandler(
  projectRoot: string,
  query?: URLSearchParams,
): LogsResponse {
  const logPath = join(projectRoot, '.gossip', 'mcp.log');
  if (!existsSync(logPath)) {
    return { entries: [], totalLines: 0, fileSize: 0 };
  }

  const filter = query?.get('filter') || undefined;
  const tail = parseInt(query?.get('tail') || '200', 10);
  const clampedTail = Math.min(Math.max(tail, 10), 2000);

  const fileSize = statSync(logPath).size;

  // Tail-read: only load the last chunk of the file, not the whole thing.
  // 2000 lines × ~200 bytes/line ≈ 400KB — read at most 512KB from the end.
  const MAX_READ = 512 * 1024;
  const readFrom = Math.max(0, fileSize - MAX_READ);
  const readLen = fileSize - readFrom;
  // Open fd first, allocate buffer inside try so any allocation error is caught
  // with the fd already guarded by finally.
  const fd = openSync(logPath, 'r');
  let buf: Buffer = Buffer.alloc(0);
  try {
    buf = Buffer.allocUnsafe(readLen);
    // Use the actual bytes-read count so we never expose uninitialized allocUnsafe bytes.
    const bytesRead = readSync(fd, buf, 0, readLen, readFrom);
    buf = buf.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
  // If we started mid-file, drop the first (possibly partial) line and count
  // newlines in the skipped portion so we can produce correct file-absolute
  // line numbers.
  let raw = buf.toString('utf-8');
  let lineOffset = 0;
  if (readFrom > 0) {
    const nl = raw.indexOf('\n');
    raw = nl >= 0 ? raw.slice(nl + 1) : raw;

    // Count newlines in the skipped byte range (0..readFrom) using 64KB chunks
    // to avoid a single large allocation.
    const SCAN_CHUNK = 64 * 1024;
    const scanFd = openSync(logPath, 'r');
    try {
      let pos = 0;
      const chunk = Buffer.allocUnsafe(SCAN_CHUNK);
      while (pos < readFrom) {
        const len = Math.min(SCAN_CHUNK, readFrom - pos);
        const n = readSync(scanFd, chunk, 0, len, pos);
        if (n === 0) break;
        for (let j = 0; j < n; j++) {
          if (chunk[j] === 0x0a) lineOffset++;
        }
        pos += n;
      }
    } finally {
      closeSync(scanFd);
    }
    // lineOffset = number of newlines in [0, readFrom) = complete lines before our window.
    // The partial line straddling readFrom is then dropped above, so allLines[0] is
    // file line lineOffset+2 (lineOffset complete lines + 1 dropped partial line + 1).
  }
  const allLines = raw.split('\n').filter(Boolean);

  // Build entries with correct file-absolute line numbers.
  // When readFrom > 0: allLines[0] is file line (lineOffset + 2) because we dropped
  // one partial line. When readFrom === 0: lineOffset is 0 and allLines[0] is line 1.
  const firstLineNumber = readFrom > 0 ? lineOffset + 2 : 1;
  let entries: LogEntry[] = [];
  for (let i = 0; i < allLines.length; i++) {
    const text = allLines[i];
    const category = categorize(text);

    if (filter && filter !== 'all') {
      if (category !== filter) continue;
    }

    entries.push({ line: firstLineNumber + i, text, category });
  }

  // totalLines reflects the matched set so clients can show "X of Y" correctly.
  const totalLines = entries.length;

  // Return only the last N matching entries
  entries = entries.slice(-clampedTail);

  return { entries, totalLines, fileSize, filter };
}
