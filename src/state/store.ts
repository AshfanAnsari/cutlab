// One central store. Project state flows out; actions flow in (structure rule).
// Undo/redo keeps project snapshots. Playhead time deliberately lives in the
// playback engine, not here, so 30fps playhead updates don't re-render the app.
import { useSyncExternalStore } from 'react';
import type { Project } from '../types';
import { emptyProject } from '../types';

export interface Selection {
  trackId: string;
  clipId: string;
}

/** An open compound-nest editing session (F.16). While set, `project` is
 *  the nest's synthetic project; parentJson is the parked parent. App's
 *  autosave suspends for the whole session so a nest can never be saved or
 *  relayed as if it were the parent project. */
export interface NestSession {
  parentJson: string;
  name: string;
  trackId: string;
  clipId: string;
}

export interface AppState {
  project: Project;
  /** Non-null while a compound nest is open for editing (isolated session). */
  nestSession: NestSession | null;
  selected: Selection | null;
  /** Multi-select set (F.14): `selected` stays the anchor; bulk ops use this set when non-empty. */
  selectedMany: Selection[];
  /** Internal clip clipboard (F.12) — a deep clone, never the live object. */
  clipboard: import('../types').Clip | null;
  /** Keyframe clipboard (M.6), rebased so the first keyframe sits at t=0. */
  clipboardKfs: import('../types').Keyframe[] | null;
  /** Keyframe selected on the timeline / in the graph editor (M.4). */
  selectedKf: { clipId: string; index: number } | null;
  /** Auto-keyframing on direct manipulation (M.11). */
  autoKey: boolean;
  bladeMode: boolean;
  pxPerSec: number;
  restoredFromAutosave: boolean;
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  lastSavedAt: number | null;
  toast: { id: number; kind: 'error' | 'info'; msg: string } | null;
}

type Listener = () => void;

class Store {
  private state: AppState = {
    project: emptyProject(),
    nestSession: null,
    selected: null,
    selectedMany: [],
    clipboard: null,
    clipboardKfs: null,
    selectedKf: null,
    autoKey: false,
    bladeMode: false,
    pxPerSec: 90,
    restoredFromAutosave: false,
    saveStatus: 'idle',
    lastSavedAt: null,
    toast: null,
  };
  private listeners = new Set<Listener>();
  private past: string[] = [];
  private future: string[] = [];
  /** Step labels parallel to past/future (S.2): pastLabels[i] names the
   *  action that moved state i → i+1. */
  private pastLabels: string[] = [];
  private futureLabels: string[] = [];

  get = (): AppState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }

  set(partial: Partial<AppState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  /** Labelled commit (S.2) — same as commit with a history label. */
  commitL(label: string, mutator: (draft: Project) => void) {
    this.commit(mutator, { label });
  }

  /** Mutate the project with history. The mutator edits a draft clone. */
  commit(mutator: (draft: Project) => void, opts: { history?: boolean; label?: string } = {}) {
    const before = JSON.stringify(this.state.project);
    const draft = JSON.parse(before) as Project;
    mutator(draft);
    if (opts.history !== false) {
      this.past.push(before);
      this.pastLabels.push(opts.label ?? 'Edit');
      if (this.past.length > 100) { this.past.shift(); this.pastLabels.shift(); }
      this.future = [];
      this.futureLabels = [];
    }
    this.set({ project: draft });
  }

  replaceProject(p: Project, opts: { history?: boolean; label?: string } = {}) {
    if (opts.history) {
      this.past.push(JSON.stringify(this.state.project));
      this.pastLabels.push(opts.label ?? 'Open project');
      if (this.past.length > 100) { this.past.shift(); this.pastLabels.shift(); }
      this.future = [];
      this.futureLabels = [];
    }
    this.set({ project: p, selected: null });
  }

  /** Label of the most recent undoable step (Prompt tab's Undo state). */
  topHistoryLabel(): string | null {
    return this.pastLabels.length ? this.pastLabels[this.pastLabels.length - 1] : null;
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(JSON.stringify(this.state.project));
    this.futureLabels.push(this.pastLabels.pop() ?? 'Edit');
    this.set({ project: JSON.parse(prev) as Project, selected: null });
  }

  redo() {
    const nxt = this.future.pop();
    if (!nxt) return;
    this.past.push(JSON.stringify(this.state.project));
    this.pastLabels.push(this.futureLabels.pop() ?? 'Edit');
    this.set({ project: JSON.parse(nxt) as Project, selected: null });
  }

  /** S.2: the labelled step list + current position (state index). */
  historyInfo(): { entries: { label: string; state: number; undone: boolean }[]; current: number } {
    const entries: { label: string; state: number; undone: boolean }[] = [];
    this.pastLabels.forEach((label, i) => entries.push({ label, state: i + 1, undone: false }));
    // futureLabels is a stack (last = next redo); entry order is reverse.
    const fut = [...this.futureLabels].reverse();
    fut.forEach((label, j) => entries.push({ label, state: this.past.length + 1 + j, undone: true }));
    return { entries, current: this.past.length };
  }

  /** Jump straight to a history state index (0 = oldest snapshot). */
  jumpHistory(state: number) {
    let cur = this.past.length;
    if (state === cur) return;
    let projectJson = JSON.stringify(this.state.project);
    while (cur > state && this.past.length > 0) {
      const prev = this.past.pop()!;
      this.future.push(projectJson);
      this.futureLabels.push(this.pastLabels.pop() ?? 'Edit');
      projectJson = prev;
      cur--;
    }
    while (cur < state && this.future.length > 0) {
      const nxt = this.future.pop()!;
      this.past.push(projectJson);
      this.pastLabels.push(this.futureLabels.pop() ?? 'Edit');
      projectJson = nxt;
      cur++;
    }
    this.set({ project: JSON.parse(projectJson) as Project, selected: null });
  }

  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }

  /** History stacks parked by beginIsolated (nest sessions). */
  private isolatedSaved: { past: string[]; pastLabels: string[]; future: string[]; futureLabels: string[] } | null = null;

  /** Swap in an isolated project (a compound nest) with a FRESH history;
   *  the current stacks are parked until endIsolated. */
  beginIsolated(p: Project) {
    this.isolatedSaved = {
      past: this.past, pastLabels: this.pastLabels,
      future: this.future, futureLabels: this.futureLabels,
    };
    this.past = []; this.pastLabels = []; this.future = []; this.futureLabels = [];
    this.set({ project: p, selected: null, selectedMany: [] });
  }

  /** Restore the parked stacks and the parent project, recording the whole
   *  isolated edit as ONE labelled undo step (beforeJson → parent). */
  endIsolated(parent: Project, beforeJson: string, label: string) {
    const saved = this.isolatedSaved;
    this.isolatedSaved = null;
    this.past = saved?.past ?? [];
    this.pastLabels = saved?.pastLabels ?? [];
    this.future = [];
    this.futureLabels = [];
    this.past.push(beforeJson);
    this.pastLabels.push(label);
    if (this.past.length > 100) { this.past.shift(); this.pastLabels.shift(); }
    this.set({ project: parent, selected: null, selectedMany: [] });
  }

  toastMsg(kind: 'error' | 'info', msg: string) {
    const id = Date.now();
    this.set({ toast: { id, kind, msg } });
    setTimeout(() => {
      if (this.state.toast?.id === id) this.set({ toast: null });
    }, 4500);
  }
}

export const store = new Store();

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
