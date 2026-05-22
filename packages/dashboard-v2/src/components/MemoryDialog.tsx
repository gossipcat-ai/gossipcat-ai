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
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-6 backdrop-blur-sm"
      style={{ background: 'color-mix(in oklch, var(--surface) 80%, transparent)' }}
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[calc(100vh-48px)] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-primary/30"
        style={{
          background: 'var(--surface-elev)',
          boxShadow:
            '0 24px 64px -16px rgba(31,31,29,0.32), 0 0 0 1px rgba(31,31,29,0.02), 0 0 0 3px var(--accent-soft)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — tag + title + close, all on one row (mockup line 245-267) */}
        <div className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3.5">
          <span
            className="shrink-0 rounded-sm border border-primary/30 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em]"
            style={{ background: 'color-mix(in oklch, var(--accent) 6%, transparent)', color: 'var(--accent)' }}
          >
            {display}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium" style={{ color: 'var(--text)' }}>
            {memory.filename}
          </span>
          <button
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition hover:bg-accent/20"
            style={{ color: 'var(--text-dim)' }}
            aria-label="Close"
          >
            <span className="text-base leading-none">✕</span>
          </button>
        </div>

        {/* Body — section headers now primary-colored per mockup line 275 */}
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 text-[13px] leading-relaxed" style={{ color: 'var(--text)' }}>
          <section>
            <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
              Owner
            </h3>
            <div className="flex flex-wrap gap-3 font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
              <span>{owner}</span>
              {ts && <span>· updated {timeAgo(ts)}</span>}
            </div>
            <div className="mt-1 truncate font-mono text-[10px]" style={{ color: 'color-mix(in oklch, var(--text-dim) 60%, transparent)' }}>
              {path}
            </div>
          </section>

          {fmEntries.length > 0 && (
            <section>
              <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
                Frontmatter
              </h3>
              <div className="overflow-hidden rounded-md border border-border/40" style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)' }}>
                <table className="w-full text-left font-mono text-[11px]">
                  <tbody>
                    {fmEntries.map(([k, v]) => (
                      <tr key={k} className="border-b border-border/20 last:border-b-0">
                        <td className="w-32 px-3 py-1.5" style={{ color: 'color-mix(in oklch, var(--text-dim) 70%, transparent)' }}>{k}</td>
                        <td className="px-3 py-1.5 break-all" style={{ color: 'color-mix(in oklch, var(--text) 90%, transparent)' }}>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--accent)' }}>
              Content
            </h3>
            <div
              className="task-md overflow-x-auto rounded-md border border-border/40 p-3 text-xs leading-relaxed"
              style={{ background: 'color-mix(in oklch, var(--surface) 40%, transparent)', color: 'color-mix(in oklch, var(--text) 90%, transparent)' }}
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
