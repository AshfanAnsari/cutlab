/**
 * layout.ts — viewer focus mode (D2.7, V.1). Shift+F collapses both
 * side panels and drops the timeline to its minimum in one move;
 * pressing it again restores the EXACT previous layout (each part
 * remembers its own pre-focus state — nothing is persisted, so a
 * reload never inherits a focus-collapsed layout).
 *
 * Transport is a window CustomEvent, the same pattern as
 * settings.togglePanel: App owns the timeline height, CollapsiblePanel
 * owns panel open state, this module owns the shared flag.
 */

let focus = false;
const subs = new Set<(f: boolean) => void>();

export function viewerFocus(): boolean {
  return focus;
}

export function setViewerFocus(next: boolean): void {
  if (focus === next) return;
  focus = next;
  subs.forEach((fn) => fn(focus));
  window.dispatchEvent(new CustomEvent('cutlab:focus-mode', { detail: { focus } }));
}

export function toggleViewerFocus(): void {
  setViewerFocus(!focus);
}

export function subscribeViewerFocus(fn: (f: boolean) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
