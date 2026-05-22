import type { CitationSnippet as CS } from '@/lib/types';

export function CitationSnippet({ citation }: { citation: CS }) {
  const lines = citation.snippet.split('\n');
  return (
    <div className="rounded-md border border-border/40 overflow-hidden" style={{ background: 'color-mix(in oklch, var(--surface-elev) 60%, transparent)' }}>
      <div className="flex items-center justify-between px-3 py-1 border-b border-border/40" style={{ background: 'color-mix(in oklch, var(--surface-sunk) 40%, transparent)' }}>
        <span className="font-mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {citation.file}:{citation.line}
        </span>
      </div>
      <pre className="px-3 py-2 font-mono text-[11px] leading-relaxed overflow-x-auto">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre">{l || '\u00A0'}</div>
        ))}
      </pre>
    </div>
  );
}
