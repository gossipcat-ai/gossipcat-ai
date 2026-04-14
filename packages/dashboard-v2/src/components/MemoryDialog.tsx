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
 *
 * Visual shell mirrors docs/designs/memory-brain-v3.html lines 235-292:
 *   - Narrow (~576px), vertically centered
 *   - Primary-faint ring shadow for the "floating card" feel
 *   - Close glyph inline with tag + title in a single header row
 *   - Section headers colored primary, not muted
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
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-background/80 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-primary/30 bg-card"
        style={{
          boxShadow:
            '0 20px 60px rgba(0, 0, 0, 0.6), 0 0 0 3px rgba(139, 92, 246, 0.06)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — tag + title + close, all on one row (mockup line 245-267) */}
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3.5">
          <span className="shrink-0 rounded-sm border border-primary/30 bg-primary/[0.06] px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-primary">
            {display}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
            {memory.filename}
          </span>
          <button
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <span className="text-base leading-none">✕</span>
          </button>
        </div>

        {/* Body — section headers now primary-colored per mockup line 275 */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed text-foreground">
          <section>
            <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
              Owner
            </h3>
            <div className="flex flex-wrap gap-3 font-mono text-[11px] text-muted-foreground">
              <span>{owner}</span>
              {ts && <span>· updated {timeAgo(ts)}</span>}
            </div>
            <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/60">
              {path}
            </div>
          </section>

          {fmEntries.length > 0 && (
            <section>
              <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                Frontmatter
              </h3>
              <div className="overflow-hidden rounded-md border border-border/40 bg-background/40">
                <table className="w-full text-left font-mono text-[11px]">
                  <tbody>
                    {fmEntries.map(([k, v]) => (
                      <tr key={k} className="border-b border-border/20 last:border-b-0">
                        <td className="w-32 px-3 py-1.5 text-muted-foreground/70">{k}</td>
                        <td className="px-3 py-1.5 break-all text-foreground/90">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
              Content
            </h3>
            <div
              className="task-md overflow-x-auto rounded-md border border-border/40 bg-background/40 p-3 text-xs leading-relaxed text-foreground/90"
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
