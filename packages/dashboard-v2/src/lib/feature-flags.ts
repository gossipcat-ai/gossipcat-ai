/**
 * Feature flag util — Phase 1b PR3 ships the AgentNetworkGraph behind
 * `?graph=1`. No localStorage persistence: opt-in per session keeps the
 * blast radius small while the component is in beta.
 *
 * Pass `window.location.search` as the argument (or omit to use it
 * automatically when called from a browser context).
 */
export function isGraphBeta(search?: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = (globalThis as any).window as { location: { search: string } } | undefined;
  const s = search ?? (win != null ? win.location.search : '');
  return new URLSearchParams(s).get('graph') === '1';
}
