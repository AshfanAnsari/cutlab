// Pool view state (FIX B2 #11): the Media bin's search / kind
// filter / sort / card-list view are view-only state, but they used
// to live in MediaBin's useState — unmounting the component on a
// page switch evaporated them. They live here instead, beside the
// other view-state services (mediaSelection, pages), so they
// survive page switches for the whole session. Never persisted and
// never touches the project.
import type { MediaItem } from '../types';

export type KindFilter = 'all' | MediaItem['kind'];
export type SortMode = 'added' | 'name' | 'duration';
export type BinViewMode = 'cards' | 'list';

export interface BinViewState {
  query: string;
  kindFilter: KindFilter;
  sort: SortMode;
  view: BinViewMode;
}

let state: BinViewState = { query: '', kindFilter: 'all', sort: 'added', view: 'cards' };
const listeners = new Set<() => void>();

export function getBinView(): BinViewState {
  return state;
}

export function subscribeBinView(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setBinView(patch: Partial<BinViewState>): void {
  state = { ...state, ...patch };
  for (const fn of [...listeners]) fn();
}
