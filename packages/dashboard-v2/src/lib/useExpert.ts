import { useEffect, useState } from 'react';

// Local declaration of the tiny `window` surface this module touches. The
// dashboard-v2 package's own tsconfig pulls in lib.dom; this guard keeps the
// file compilable when ts-jest (root tsconfig, lib.dom NOT included) loads it.
declare const window: {
  location: { search: string };
  addEventListener: (event: string, fn: () => void) => void;
  removeEventListener: (event: string, fn: () => void) => void;
} | undefined;

/**
 * Internal helper — pure URL parse. Exposed for testing without a DOM.
 */
export function expertFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('expert') === '1';
}

export function readExpert(): boolean {
  if (typeof window === 'undefined') return false;
  return expertFromSearch(window.location.search);
}

/**
 * Reads the `?expert=1` query param and re-renders on `dashboard:navigate`.
 *
 * Important: subscribes to `dashboard:navigate` ONLY, not `popstate`. The
 * router's module-level handler at `router.ts:42-44` already converts every
 * `popstate` into a `dashboard:navigate` event — adding a `popstate` listener
 * here would fire `update()` twice per back/forward navigation. (The existing
 * `useRoute` hook has a separate, pre-existing double-fire bug that is being
 * tracked as a follow-up cleanup.)
 */
export function useExpert(): boolean {
  const [expert, setExpert] = useState(readExpert);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const w = window;
    const update = () => setExpert(readExpert());
    w.addEventListener('dashboard:navigate', update);
    return () => w.removeEventListener('dashboard:navigate', update);
  }, []);
  return expert;
}
