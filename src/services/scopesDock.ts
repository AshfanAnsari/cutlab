/**
 * scopesDock.ts — the scopes dock's open state (D2.7, V.5). One flag,
 * three readers: the viewer toolbar (toggle), the Preview (renders
 * the dock under the stage), the ColorPanel (shows "shown under
 * viewer" instead of a second live copy — one canonical render), and
 * App (the dock's height comes out of the timeline first).
 */

let open = (() => {
  try { return localStorage.getItem('cutlab.scopesDock') === '1'; } catch { return false; }
})();
const subs = new Set<(o: boolean) => void>();

export function scopesDockOpen(): boolean {
  return open;
}

export function setScopesDock(next: boolean): void {
  if (open === next) return;
  open = next;
  try { localStorage.setItem('cutlab.scopesDock', open ? '1' : '0'); } catch { /* ignore */ }
  subs.forEach((fn) => fn(open));
}

export function subscribeScopesDock(fn: (o: boolean) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
