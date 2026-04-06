import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '@/lib/api';
import { onEvent } from '@/lib/ws';

interface LogEntry {
  line: number;
  text: string;
  category: string;
}

interface LogsResponse {
  entries: LogEntry[];
  totalLines: number;
  fileSize: number;
  filter?: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  dispatch: 'text-blue-400',
  consensus: 'text-purple-400',
  error: 'text-red-400',
  timeout: 'text-orange-400',
  worker: 'text-cyan-400/70',
  gemini: 'text-cyan-400/70',
  skill: 'text-amber-400',
  boot: 'text-muted-foreground/50',
  relay: 'text-green-400',
  gossip: 'text-pink-400',
  utility: 'text-muted-foreground/70',
  memory: 'text-violet-400',
  persist: 'text-muted-foreground/50',
  toolserver: 'text-muted-foreground/50',
  other: 'text-muted-foreground/70',
};

const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/^\[gossipcat\]\s*\[worker:/, 'worker'],
  [/^\[gossipcat\]\s*\[Gemini\]/, 'gemini'],
  [/^\[gossipcat\]\s*\[ToolServer\]/, 'toolserver'],
  [/^\[gossipcat\]\s*dispatch\b/, 'dispatch'],
  [/^\[gossipcat\]\s*relay\b/, 'relay'],
  [/^\[gossipcat\]\s*Cross-review\b/, 'consensus'],
  [/^\[gossipcat\]\s*Consensus\b/, 'consensus'],
  [/^\[gossipcat\]\s*Skill\b/, 'skill'],
  [/^\[gossipcat\]\s*Bootstrap\b/, 'boot'],
  [/^\[gossipcat\]\s*Booted:/, 'boot'],
  [/^\[gossipcat\]\s*Dashboard:/, 'boot'],
  [/^\[gossipcat\]\s*Adaptive\b/, 'boot'],
  [/^\[gossipcat\]\s*Gossip\b/, 'gossip'],
  [/^\[gossipcat\]\s*utility\b/, 'utility'],
  [/^\[gossipcat\]\s*Compacted\b/, 'memory'],
  [/native agent/, 'boot'],
  [/persist|Persist/, 'persist'],
  [/timeout|Timeout|timed.out/, 'timeout'],
  [/^\[gossipcat\].*(?:Error|error|failed|Failed)/, 'error'],
];

function categorize(text: string): string {
  for (const [re, cat] of CATEGORY_PATTERNS) {
    if (re.test(text)) return cat;
  }
  return 'other';
}

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'dispatch', label: 'Dispatch' },
  { key: 'consensus', label: 'Consensus' },
  { key: 'error', label: 'Errors' },
  { key: 'timeout', label: 'Timeouts' },
  { key: 'worker', label: 'Workers' },
  { key: 'skill', label: 'Skills' },
  { key: 'relay', label: 'Relay' },
  { key: 'boot', label: 'Boot' },
];

const MAX_LINES = 1000;

export function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [totalLines, setTotalLines] = useState(0);
  const [fileSize, setFileSize] = useState(0);
  const [filter, setFilter] = useState('all');
  const [autoScroll, setAutoScroll] = useState(true);
  const [live, setLive] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const nextLineRef = useRef(0);

  // Initial fetch
  useEffect(() => {
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const data = await api<LogsResponse>('logs?tail=500');
        if (cancelled) return;
        setEntries(data.entries);
        setTotalLines(data.totalLines);
        setFileSize(data.fileSize);
        nextLineRef.current = data.totalLines + 1;
      } catch { /* ignore */ }
    };
    fetchLogs();
    return () => { cancelled = true; };
  }, []);

  // Live log streaming via WebSocket
  useEffect(() => {
    if (!live) return;
    return onEvent((event) => {
      if (event.type !== 'log_lines') return;
      const newLines = (event as any).data?.lines as string[];
      if (!newLines?.length) return;

      setEntries((prev) => {
        const newEntries = newLines.map((text, i) => ({
          line: nextLineRef.current + i,
          text,
          category: categorize(text),
        }));
        nextLineRef.current += newLines.length;
        setTotalLines((t) => t + newLines.length);
        const combined = [...prev, ...newEntries];
        return combined.length > MAX_LINES ? combined.slice(-MAX_LINES) : combined;
      });
    });
  }, [live]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, autoScroll]);

  const filteredEntries = filter === 'all'
    ? entries
    : entries.filter((e) => e.category === filter);

  const formatSize = useCallback((bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }, []);

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="font-mono text-xs font-bold uppercase tracking-widest text-foreground">
          MCP Log <span className="text-primary">{totalLines} lines</span>
        </h2>
        <span className="font-mono text-[10px] text-muted-foreground/50">
          {formatSize(fileSize)}
        </span>
        {live && (
          <span className="flex items-center gap-1 font-mono text-[10px] text-confirmed">
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-confirmed" />
            live
          </span>
        )}
      </div>

      {/* Filter chips + controls */}
      <div className="mb-3 flex items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-sm px-2.5 py-1 font-mono text-[10px] font-semibold transition ${
              filter === f.key
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="ml-auto flex gap-1.5">
          <button
            onClick={() => setLive(!live)}
            className={`rounded-sm px-2.5 py-1 font-mono text-[10px] font-semibold transition ${
              live ? 'bg-confirmed/10 text-confirmed' : 'text-muted-foreground'
            }`}
          >
            {live ? '● Live' : '○ Paused'}
          </button>
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`rounded-sm px-2.5 py-1 font-mono text-[10px] font-semibold transition ${
              autoScroll ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
            }`}
          >
            {autoScroll ? '⤓ Auto' : '⤓ Scroll'}
          </button>
        </div>
      </div>

      {/* Log output */}
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="max-h-[70vh] overflow-y-auto p-3 font-mono text-xs leading-relaxed">
          {filteredEntries.map((entry) => (
            <div key={entry.line} className="flex gap-2 hover:bg-muted/30">
              <span className="w-10 shrink-0 select-none text-right text-muted-foreground/30">
                {entry.line}
              </span>
              <span className={CATEGORY_COLORS[entry.category] || CATEGORY_COLORS.other}>
                {entry.text}
              </span>
            </div>
          ))}
          {filteredEntries.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {entries.length === 0 ? 'Loading...' : 'No matching log entries.'}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
    </>
  );
}
