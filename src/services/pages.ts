// Page state for the page system (UI redesign §2.1/§3.2): the five
// editor pages are layouts over the one store — switching never
// touches the project, playhead, selection or playback (§2.7).
// Persisted in localStorage 'cutlab.page', default Edit. Per-page
// layout state (rail widths, splits, dock) persists under per-page
// keys owned by the components themselves.
export type PageId = 'media' | 'edit' | 'colour' | 'audio' | 'deliver';

export const PAGES: { id: PageId; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Edit' },
  { id: 'colour', label: 'Colour' },
  { id: 'audio', label: 'Audio' },
  { id: 'deliver', label: 'Deliver' },
];

const KEY = 'cutlab.page';

function read(): PageId {
  try {
    const v = localStorage.getItem(KEY);
    return PAGES.some((p) => p.id === v) ? (v as PageId) : 'edit';
  } catch {
    return 'edit';
  }
}

let current: PageId = read();
const listeners = new Set<() => void>();

export function getPage(): PageId {
  return current;
}

export function subscribePage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setPage(p: PageId): void {
  if (p === current) return;
  current = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* storage unavailable: page lives for this session only */
  }
  for (const fn of [...listeners]) fn();
}
