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
      <pre
        className="overflow-x-auto"
        style={{
          background: 'var(--surface-sunk)',
          borderLeft: '3px solid var(--border-strong)',
          padding: '12px 16px',
          borderRadius: '6px',
          fontFamily: 'var(--font-mono)',
          fontSize: '12px',
          color: 'var(--text)',
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre">{l || '\u00A0'}</div>
        ))}
      </pre>
    </div>
  );
}
