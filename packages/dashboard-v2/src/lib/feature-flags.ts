/**
 * Feature flag util.
 *
 * Phase 1b PR3 introduced `?graph=1` as opt-IN for the AgentNetworkGraph beta.
 * Phase 1b PR6 flipped the default: the graph layout is now standard, and
 * `?graph=0` is the opt-OUT escape hatch for anyone who wants only the legacy
 * calm widgets.
 *
 * Returns true when the user has explicitly opted OUT of the graph.
 * Pass `window.location.search` as the argument (or omit to use it
 * automatically when called from a browser context).
 */
export function isGraphHidden(search?: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = (globalThis as any).window as { location: { search: string } } | undefined;
  const s = search ?? (win != null ? win.location.search : '');
  return new URLSearchParams(s).get('graph') === '0';
}
