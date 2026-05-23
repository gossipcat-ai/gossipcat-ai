import { useEffect } from 'react';
import { navigate } from '@/lib/router';

/**
 * Global keyboard handler for the rail's currently-advertised shortcuts.
 *   ⏎ — open dispatch log for the selected agent
 *   G — view skill graph
 *   ⌘D / Ctrl-D — dispatch consensus (no-op for now; visual hint only)
 *
 * Skips when focus is in an editable element so typing isn't hijacked.
 */
function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof Element)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (t as HTMLElement).isContentEditable === true;
}

export function useGlobalAgentKeys(selectedAgentId: string | null): void {
  useEffect(() => {
    if (!selectedAgentId) return;

    function onKey(ev: KeyboardEvent) {
      if (isEditable(ev.target)) return;

      // ⌘D / Ctrl-D — claimed by browser bookmarks. Still hint for visual
      // consistency with the rail's <kbd> label; the actual dispatch wiring
      // is deferred (consensus dispatch needs a server-side hook).
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'd' || ev.key === 'D')) {
        // Intentionally no preventDefault — let the browser keep bookmarks.
        return;
      }

      // Bare key shortcuts — only act when no modifier is held.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;

      if (ev.key === 'Enter') {
        ev.preventDefault();
        navigate('/agent/' + encodeURIComponent(selectedAgentId!));
      } else if (ev.key === 'g' || ev.key === 'G') {
        ev.preventDefault();
        navigate('/agent/' + encodeURIComponent(selectedAgentId!) + '#skills');
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectedAgentId]);
}
