import { useEffect, useState } from 'react';
import { getAgentParam, setAgentParam } from '../lib/url-agent-param';

/**
 * React hook bridging the ?agent= URL param to component state.
 * Mirrors the pattern of useRoute (lib/router.ts): subscribe to the
 * existing `dashboard:navigate` event for re-render triggers.
 *
 * Returns [selectedAgentId, setSelectedAgentId]. Setting null clears
 * the param. Back/forward browser navigation works because pushState
 * is paired with the popstate-derived `dashboard:navigate` event.
 */
export function useUrlAgentParam(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : getAgentParam(window.location.search),
  );

  useEffect(() => {
    const sync = () => {
      const next = typeof window === 'undefined' ? null : getAgentParam(window.location.search);
      setId((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('dashboard:navigate', sync as EventListener);
    return () => {
      window.removeEventListener('dashboard:navigate', sync as EventListener);
    };
  }, []);

  // `as const` preserves the tuple shape; without it, TypeScript widens the
  // return type to (string | null | setter)[], which makes destructured
  // call-site inference unsafe.
  return [id, setAgentParam] as const;
}
