// Gallery view state (UI redesign §3.18): the Colour page's
// filmstrip — the hero frame (persisted in idb by the hero grab,
// the match target) pinned first, then stills grabbed from the
// viewer, in grab order. Stills are view state only: removing one
// here never touches project data. A strip click asks the viewer
// to load the still into its Compare wipe (V.4 machinery).
import { idb } from './db';

export interface GalleryState {
  hero: string | null;
  stills: string[];
}

let state: GalleryState = { hero: null, stills: [] };
const listeners = new Set<() => void>();
let compareRequest: string | null = null;
const compareListeners = new Set<(url: string) => void>();

function emit() {
  for (const fn of [...listeners]) fn();
}

export function getGallery(): GalleryState {
  return state;
}

export function subscribeGallery(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function initGallery(): Promise<void> {
  try {
    const hero = await idb.get<string>('kv', 'heroFrame');
    if (hero && hero !== state.hero) {
      state = { ...state, hero };
      emit();
    }
  } catch {
    /* no stored hero yet */
  }
}

export function setGalleryHero(url: string): void {
  state = { ...state, hero: url };
  emit();
}

export function addGalleryStill(url: string): void {
  state = { ...state, stills: [...state.stills, url] };
  emit();
}

export function removeGalleryStill(index: number): void {
  state = { ...state, stills: state.stills.filter((_, i) => i !== index) };
  emit();
}

export function requestCompare(url: string): void {
  compareRequest = url;
  for (const fn of [...compareListeners]) fn(url);
}

export function subscribeCompare(fn: (url: string) => void): () => void {
  compareListeners.add(fn);
  if (compareRequest) fn(compareRequest);
  return () => compareListeners.delete(fn);
}
