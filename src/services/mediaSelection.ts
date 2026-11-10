// Selected bin item (UI redesign W6): one selection shared by the
// Media page's pool, BinViewer and ItemDetails. View state only —
// it never touches the project or the timeline selection.
let selectedId: string | null = null;
const listeners = new Set<() => void>();

export function getSelectedMediaId(): string | null {
  return selectedId;
}

export function subscribeSelectedMedia(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setSelectedMediaId(id: string | null): void {
  if (id === selectedId) return;
  selectedId = id;
  for (const fn of [...listeners]) fn();
}
