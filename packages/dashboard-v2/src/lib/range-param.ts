export type Range = '1h' | '24h' | '7d' | '30d';

const VALID: ReadonlyArray<Range> = ['1h', '24h', '7d', '30d'];

export function isRange(v: unknown): v is Range {
  return typeof v === 'string' && (VALID as readonly string[]).includes(v);
}

export function getRangeParam(search: string): Range | null {
  const raw = new URLSearchParams(search).get('range');
  return isRange(raw) ? raw : null;
}

export function buildUrlWithRange(pathname: string, search: string, range: Range | null): string {
  const params = new URLSearchParams(search);
  if (range === null) params.delete('range');
  else params.set('range', range);
  const qs = params.toString();
  return qs.length > 0 ? `${pathname}?${qs}` : pathname;
}

export function setRangeParam(range: Range | null): void {
  const g = globalThis as unknown as { window?: { location: { pathname: string; search: string }; history: { pushState: (...a: unknown[]) => void }; dispatchEvent: (e: Event) => void } };
  if (!g.window) return;
  const w = g.window;
  const url = buildUrlWithRange(w.location.pathname, w.location.search, range);
  if (url !== w.location.pathname + w.location.search) {
    w.history.pushState({}, '', url);
    w.dispatchEvent(new Event('dashboard:navigate'));
  }
}
