import { useEffect, useState } from 'react';

const BASE = '/dashboard';

export function currentRoute(): string {
  const p = window.location.pathname;
  if (p === BASE || p === BASE + '/') return '/';
  if (p.startsWith(BASE + '/')) return p.slice(BASE.length);
  return p || '/';
}

export function href(path: string): string {
  if (path === '/' || path === '') return BASE + '/';
  return BASE + (path.startsWith('/') ? path : '/' + path);
}

export function navigate(path: string): void {
  const url = href(path);
  if (url !== window.location.pathname + window.location.search) {
    window.history.pushState({}, '', url);
  }
  window.dispatchEvent(new Event('dashboard:navigate'));
}

// Install a single global click interceptor (module-level, runs once)
if (typeof document !== 'undefined' && !(window as any).__dashboardRouterInstalled) {
  (window as any).__dashboardRouterInstalled = true;
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = (e.target as Element | null)?.closest?.('a');
    if (!target) return;
    const hrefAttr = target.getAttribute('href');
    if (!hrefAttr) return;
    if (target.hasAttribute('target') || target.hasAttribute('download')) return;
    if (!hrefAttr.startsWith(BASE)) return;
    e.preventDefault();
    if (hrefAttr !== window.location.pathname + window.location.search) {
      window.history.pushState({}, '', hrefAttr);
    }
    window.dispatchEvent(new Event('dashboard:navigate'));
  });
  window.addEventListener('popstate', () => {
    window.dispatchEvent(new Event('dashboard:navigate'));
  });
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute());

  useEffect(() => {
    const sync = () => setRoute(currentRoute());
    window.addEventListener('popstate', sync);

    window.addEventListener('dashboard:navigate', sync as EventListener);

    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('dashboard:navigate', sync as EventListener);
    };
  }, []);

  return route;
}
