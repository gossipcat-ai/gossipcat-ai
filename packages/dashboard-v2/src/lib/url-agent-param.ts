/**
 * URL `?agent=ID` selection state for the AgentNetworkGraph + GraphRail
 * (Phase 1b PR4). Lives in the query string (NOT the hash) so it round-trips
 * cleanly through the existing dashboard:navigate dispatch — no extra
 * event plumbing needed.
 *
 * Pure helpers + a thin write that does the side-effect. React-facing
 * code uses the hook at hooks/useUrlAgentParam.ts.
 */

export function getAgentParam(search: string): string | null {
  const v = new URLSearchParams(search).get('agent');
  return v && v.length > 0 ? v : null;
}

/**
 * Build the new URL with `agent` set/removed, preserving every other param
 * and the pathname. Pure — does not mutate `window.location`.
 */
export function buildUrlWithAgent(pathname: string, search: string, agentId: string | null): string {
  const params = new URLSearchParams(search);
  if (agentId === null) {
    params.delete('agent');
  } else {
    params.set('agent', agentId);
  }
  const qs = params.toString();
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

/**
 * Side-effecting setter: pushes a new history entry with the new `agent`
 * param and fires `dashboard:navigate` so the router's useRoute hook
 * re-renders. SSR-safe (no-op when window is undefined).
 *
 * Uses `globalThis` cast to avoid DOM-lib dependency at the root tsconfig
 * level (which uses ES2022-only lib). The dashboard-v2 tsconfig includes DOM.
 */
export function setAgentParam(agentId: string | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = globalThis as any;
  if (typeof w.window === 'undefined') return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win: any = w.window;
  const url = buildUrlWithAgent(win.location.pathname, win.location.search, agentId);
  if (url !== win.location.pathname + win.location.search) {
    win.history.pushState({}, '', url);
    win.dispatchEvent(new Event('dashboard:navigate'));
  }
}
