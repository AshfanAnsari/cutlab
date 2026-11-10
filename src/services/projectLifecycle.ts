/**
 * Project lifecycle — the create / open / adopt paths every surface
 * shares (App boot + Home crossings, TopBar's menus, the Media page's
 * library). Extracted from App.tsx for the P8 lazy split (2026-11-06):
 * TopBar and MediaPage statically imported bindProjectMedia /
 * newProject from ../App while App statically imported them, an
 * App ↔ TopBar cycle that made the bundler merge any lazy editor
 * chunk straight back into the entry. The helpers depend only on
 * services + the store, so they live here and the cycle is gone.
 */
import { store } from '../state/store';
import { emptyProject, type Project } from '../types';
import { clearRelayProjectSlot } from './jobsSupabase';
import { mediaStore, registerMedia, aliasMediaRuntime, findStoredFor } from './mediaStore';
import { missingMedia } from './projectIO';
import { CANVAS_PRESETS, loadSettings } from './settings';

export async function bindProjectMedia(project: Project = store.get().project) {
  const all = await mediaStore.all();
  for (const rec of all) registerMedia(rec);
  for (const m of project.media) {
    const rec = findStoredFor(all, m.id, m.src);
    if (rec) aliasMediaRuntime(m.id, rec);
  }
}

export function createProject(canvasKey?: keyof typeof CANVAS_PRESETS): boolean {
  if (store.get().nestSession) {
    store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
    return false;
  }
  const p = emptyProject();
  const preset = CANVAS_PRESETS[canvasKey ?? loadSettings().defaultCanvas];
  p.canvas.w = preset.w;
  p.canvas.h = preset.h;
  // D4 fix: New PUSHES history (the store's replaceProject already
  // supports it), so the toast below tells the truth — Undo really
  // does bring the old project back. Previously this replaced with
  // no history entry and Undo sat disabled after New.
  store.replaceProject(p, { history: true, label: 'New project' });
  // A brand-new project gets its own relay row on first Cloud save.
  void clearRelayProjectSlot();
  store.toastMsg('info', 'New empty project. (Undo brings the old one back.)');
  return true;
}

export function newProject() {
  createProject();
}

/**
 * HOME PORT 2026-11-06: creation with an explicit spec — the ported
 * New Project dialog carries a name, arbitrary canvas dims (the
 * remake's preset cards run to 1920×1080 / 2560×1080, beyond
 * CANVAS_PRESETS) and an fps. Same contract as createProject:
 * history pushed, relay slot cleared, nest sessions refuse.
 */
export function createProjectCustom(spec: { name: string; w: number; h: number; fps: number }): boolean {
  if (store.get().nestSession) {
    store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
    return false;
  }
  const p = emptyProject();
  p.name = spec.name;
  p.canvas.w = spec.w;
  p.canvas.h = spec.h;
  p.canvas.fps = spec.fps;
  store.replaceProject(p, { history: true, label: 'New project' });
  void clearRelayProjectSlot();
  store.toastMsg('info', 'New empty project. (Undo brings the old one back.)');
  return true;
}

/** FIX C: Home's "Start from…" — a new project at an explicit canvas
 *  preset (CANVAS_PRESETS is the whole list; nothing is invented). */
export function newProjectWithCanvas(canvasKey: keyof typeof CANVAS_PRESETS): boolean {
  return createProject(canvasKey);
}

/**
 * FIX C: adopt a loaded project exactly like the editor's own Open
 * flows do (TopBar.adoptProject's contract): bind media BEFORE the
 * project enters the store, push history so Undo brings the old
 * project back, and report unbound media by name. Returns false when
 * a nest session blocks the swap. Home's open paths (library cards,
 * file picker, relay cards) all enter the editor through here.
 */
export async function adoptProject(p: Project): Promise<boolean> {
  if (store.get().nestSession) {
    store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
    return false;
  }
  await bindProjectMedia(p);
  store.replaceProject(p, { history: true, label: 'Open project' });
  const missing = await missingMedia(p);
  if (missing.length > 0) {
    store.toastMsg('info', `Project loaded. ${missing.length} media file(s) not in the bin yet — import them (same file names) to bind: ${missing.map((m) => m.src).join(', ')}`);
  } else {
    store.toastMsg('info', 'Project loaded and all media bound.');
  }
  return true;
}
