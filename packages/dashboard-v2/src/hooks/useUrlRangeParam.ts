import { useEffect, useState } from 'react';
import { getRangeParam, setRangeParam, type Range } from '../lib/range-param';

/**
 * Mirror of useUrlAgentParam — bridges ?range= URL param to component state
 * via the existing dashboard:navigate event. Default '7d' when param absent.
 */
export function useUrlRangeParam(): readonly [Range, (r: Range | null) => void] {
  const [r, setR] = useState<Range>(() => {
    if (typeof window === 'undefined') return '7d';
    return getRangeParam(window.location.search) ?? '7d';
  });

  useEffect(() => {
    // Canonicalize on mount — write the default ?range=7d if absent so the
    // URL is shareable from the first render (otherwise a freshly-loaded
    // visitor's URL won't reflect their current range until they manually
    // pick a different one).
    if (typeof window !== 'undefined' && getRangeParam(window.location.search) === null) {
      setRangeParam(r);
    }
    const sync = () => {
      const next = typeof window === 'undefined' ? '7d' : (getRangeParam(window.location.search) ?? '7d');
      setR((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('dashboard:navigate', sync as EventListener);
    return () => window.removeEventListener('dashboard:navigate', sync as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps — `r` is captured intentionally on mount only
  }, []);

  return [r, setRangeParam] as const;
}
