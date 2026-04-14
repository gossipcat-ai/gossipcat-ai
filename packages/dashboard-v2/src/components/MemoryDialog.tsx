import { useEffect } from 'react';
import type { MemoryFile } from '@/lib/types';
import { renderMarkdown, timeAgo } from '@/lib/utils';
import { toDisplayType } from '@/lib/memory-taxonomy';

interface MemoryDialogProps {
  memory: MemoryFile | null;
  onClose: () => void;
}

/**
 * Modal showing the full markdown content of a memory file plus its
 * frontmatter, agent owner, file path, and a relative timestamp when one is
 * derivable from frontmatter (memories don't carry mtime through the API).
 */
export function MemoryDialog({ memory, onClose }: MemoryDialogProps) {
  useEffect(() => {
    if (!memory) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [memory, onClose]);

  if (!memory) return null;

  const display = toDisplayType(memory);
  const owner = memory.agentId === '_project' ? 'project' : memory.agentId || 'unknown';
  const path = `.gossip/agents/${memory.agentId || '_project'}/memory/knowledge/${memory.filename}`;
  const ts = pickTimestamp(memory.frontmatter);
  const fmEntries = Object.entries(memory.frontmatter || {});

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative mt-12 w-full max-w-3xl rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-primary">
                {display}
              </span>
              <span className="truncate font-mono text-xs font-semibold text-foreground">
                {memory.filename}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 font-mono text-[10px] text-muted-foreground">
              <span>owner: {owner}</span>
              {ts && <span>· {timeAgo(ts)}</span>}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/60">
              {path}
            </div>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-md border border-border/40 bg-card px-2 py-1 font-mono text-xs text-muted-foreground transition hover:bg-accent/50 hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[calc(100vh-220px)] space-y-5 overflow-y-auto px-5 py-4">
          {fmEntries.length > 0 && (
            <section>
              <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Frontmatter
              </h3>
              <div className="overflow-hidden rounded-md border border-border/40 bg-background/40">
                <table className="w-full text-left font-mono text-[11px]">
                  <tbody>
                    {fmEntries.map(([k, v]) => (
                      <tr key={k} className="border-b border-border/20 last:border-b-0">
                        <td className="w-32 px-3 py-1.5 text-muted-foreground/70">{k}</td>
                        <td className="px-3 py-1.5 text-foreground/90 break-all">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 font-mono text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Content
            </h3>
            <div
              className="task-md rounded-md border border-border/40 bg-background/40 p-3 text-xs leading-relaxed text-foreground/90 overflow-x-auto"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(memory.content) }}
            />
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * Pull the most likely timestamp from frontmatter. Memory files don't carry
 * mtime through the dashboard API, so we fall back to common frontmatter keys
 * authors actually use; returns undefined if none parse to a real Date.
 */
function pickTimestamp(fm?: Record<string, string>): string | undefined {
  if (!fm) return undefined;
  for (const key of ['timestamp', 'updated', 'updatedAt', 'modified', 'created', 'date']) {
    const v = fm[key];
    if (v && !isNaN(new Date(v).getTime())) return v;
  }
  return undefined;
}
