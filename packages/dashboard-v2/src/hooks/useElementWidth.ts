import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Tracks the width of a DOM element via ResizeObserver.
 * Returns [ref, width]. Width is 0 before first measurement.
 */
export function useElementWidth<T extends HTMLElement = HTMLDivElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width];
}
