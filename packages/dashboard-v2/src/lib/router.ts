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

/**
 * Match a parametric route pattern against the current route string.
 * Supports a single `:param` segment (e.g. "/tasks/:id").
 *
 * Returns the captured param value (URL-decoded) or null if no match.
 *
 * Examples:
 *   matchRoute('/tasks/:id', '/tasks/abc123')  → 'abc123'
 *   matchRoute('/tasks/:id', '/tasks')          → null
 *   matchRoute('/agent/:id', '/tasks/abc123')   → null
 */
export function matchRoute(pattern: string, route: string): string | null {
  // Build a regex from the pattern by replacing `:param` with a capture group.
  // We first escape regex special chars, then replace the (now-escaped) `:param`
  // placeholder with a capture group.  The `:` char is not a regex special char so
  // it survives the first pass intact; `\w` is safe to replace afterward.
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:\w+/g, '([^/]+)');
  const re = new RegExp(`^${escaped}$`);
  const m = route.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute());

  useEffect(() => {
    // popstate is re-dispatched as 'dashboard:navigate' by the module-level
    // handler above, so subscribing to both here would fire setRoute twice
    // on browser back/forward.
    const sync = () => setRoute(currentRoute());
    window.addEventListener('dashboard:navigate', sync as EventListener);
    return () => {
      window.removeEventListener('dashboard:navigate', sync as EventListener);
    };
  }, []);

  return route;
}
