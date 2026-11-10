import { useSyncExternalStore } from 'react';

// Phone layout breakpoint (§5): below 900 px every page switches
// to its single-zone tab layout.
const QUERY = '(max-width: 899px)';
const mql = typeof window !== 'undefined' ? window.matchMedia(QUERY) : null;

export function useNarrow(): boolean {
  return useSyncExternalStore(
    (fn) => {
      mql?.addEventListener('change', fn);
      return () => mql?.removeEventListener('change', fn);
    },
    () => mql?.matches ?? false,
    () => false,
  );
}
