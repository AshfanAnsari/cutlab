// The shortcut registry (T.10): ONE canonical list of actions with their
// default key combos. App.tsx's keyboard handler is a thin shell that calls
// dispatchShortcut — the registry IS the behaviour, so the Inspector's
// (editable) reference can never drift from what the keys do.
//
// User remapping: an override REPLACES an action's whole combo list with a
// single captured combo. Overrides persist in localStorage 'cutlab.keymap'
// as { actionId: combo }. Matching is two-pass: exact combo first (so
// Ctrl+Shift+B = split-all wins), then the combo with Shift stripped (so
// Shift+← still steps, Shift+Del still deletes, Ctrl+Shift+Z still reaches
// undo whose run() reads shiftKey and redoes). Runs receive the event, so
// shift-sensitive actions keep their old behaviour exactly.
import { store } from '../state/store';
import { playback } from '../engine/playback';
import { toggleViewerFocus } from './layout';
import { setPage, type PageId } from './pages';
import {
  addMarkerAtPlayhead,
  copySelected,
  cutToAngleAtPlayhead,
  deleteMany,
  deleteSelected,
  duplicateSelected,
  extractAudioSelected,
  makeCompoundFromSelection,
  nudgeSelectedVolume,
  pasteClipboard,
  rippleDeleteSelected,
  rippleTrimEndToPlayhead,
  rippleTrimStartToPlayhead,
  seekEditPoint,
  seekKeyframe,
  setRangeInAtPlayhead,
  setRangeOutAtPlayhead,
  splitAllAtPlayhead,
  splitAtPlayhead,
  uncompoundSelected,
} from '../state/actions';

export interface ShortcutAction {
  id: string;
  /** Human label for the Inspector list. */
  label: string;
  /** Display string for the default binding(s). */
  hint: string;
  defaults: string[];
  run: (e: KeyboardEvent) => void;
}

const fps = () => store.get().project.canvas.fps;
const fire = (name: string) => window.dispatchEvent(new CustomEvent(name));

/** Page switching (§2.1/§2.7): during a nest session every page
 *  except Edit answers with the nest toast. Shared by the registry
 *  actions and the positional Shift+digit handling in dispatch. */
export function gotoPage(p: PageId): void {
  if (store.get().nestSession && p !== 'edit') {
    store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
    return;
  }
  setPage(p);
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  { id: 'playPause', label: 'Play / pause', hint: 'Space', defaults: ['space'],
    run: () => { if (playback.playing) playback.pause(); else playback.play(); } },
  { id: 'shuttleRev', label: 'Shuttle reverse (again = faster)', hint: 'J', defaults: ['j'],
    run: () => playback.shuttle(-1) },
  { id: 'shuttlePause', label: 'Shuttle pause', hint: 'K', defaults: ['k'],
    run: () => playback.pause() },
  { id: 'shuttleFwd', label: 'Shuttle forward (again = faster)', hint: 'L', defaults: ['l'],
    run: () => playback.shuttle(1) },
  { id: 'stepBack', label: 'Step one frame back (Shift = 10)', hint: '←', defaults: ['arrowleft'],
    run: (e) => playback.step(e.shiftKey ? -10 : -1, fps()) },
  { id: 'stepFwd', label: 'Step one frame forward (Shift = 10)', hint: '→', defaults: ['arrowright'],
    run: (e) => playback.step(e.shiftKey ? 10 : 1, fps()) },
  { id: 'editPointPrev', label: 'Previous edit point', hint: '↑', defaults: ['arrowup'],
    run: () => seekEditPoint(-1) },
  { id: 'editPointNext', label: 'Next edit point', hint: '↓', defaults: ['arrowdown'],
    run: () => seekEditPoint(1) },
  { id: 'goStart', label: 'Go to start', hint: 'Home', defaults: ['home'],
    run: () => playback.seek(0) },
  { id: 'split', label: 'Split at playhead', hint: 'S or Ctrl+B', defaults: ['s', 'ctrl+b'],
    run: () => splitAtPlayhead() },
  { id: 'splitAll', label: 'Split all tracks at playhead', hint: 'Ctrl+Shift+B', defaults: ['ctrl+shift+b'],
    run: () => splitAllAtPlayhead() },
  { id: 'blade', label: 'Blade tool — click a clip to split it there', hint: 'B', defaults: ['b'],
    run: () => store.set({ bladeMode: !store.get().bladeMode }) },
  { id: 'rippleTrimStart', label: 'Ripple-trim clip start to playhead', hint: 'Q', defaults: ['q'],
    run: () => rippleTrimStartToPlayhead() },
  { id: 'rippleTrimEnd', label: 'Ripple-trim clip end to playhead', hint: 'W', defaults: ['w'],
    run: () => rippleTrimEndToPlayhead() },
  { id: 'rangeIn', label: 'Set range in at playhead', hint: 'I', defaults: ['i'],
    run: () => setRangeInAtPlayhead() },
  { id: 'rangeOut', label: 'Set range out at playhead', hint: 'O', defaults: ['o'],
    run: () => setRangeOutAtPlayhead() },
  { id: 'deleteSelection', label: 'Ripple delete selection (Shift = leave gap)', hint: 'Del', defaults: ['delete', 'backspace'],
    run: (e) => {
      if (store.get().selectedMany.length > 1) deleteMany(!e.shiftKey);
      else if (e.shiftKey) deleteSelected();
      else rippleDeleteSelected();
    } },
  { id: 'duplicate', label: 'Duplicate selection', hint: 'Ctrl+D', defaults: ['ctrl+d'],
    run: () => duplicateSelected() },
  { id: 'copy', label: 'Copy clip', hint: 'Ctrl+C', defaults: ['ctrl+c'],
    run: () => copySelected() },
  { id: 'paste', label: 'Paste clip at playhead', hint: 'Ctrl+V', defaults: ['ctrl+v'],
    run: () => pasteClipboard() },
  { id: 'extractAudio', label: 'Extract audio from selected clip', hint: 'Ctrl+Shift+S', defaults: ['ctrl+shift+s'],
    run: () => extractAudioSelected() },
  { id: 'volUp', label: 'Nudge selected clip volume +0.05', hint: 'Ctrl+.', defaults: ['ctrl+.'],
    run: () => nudgeSelectedVolume(0.05) },
  { id: 'volDown', label: 'Nudge selected clip volume −0.05', hint: 'Ctrl+,', defaults: ['ctrl+,'],
    run: () => nudgeSelectedVolume(-0.05) },
  { id: 'marker', label: 'Add marker at playhead', hint: 'M', defaults: ['m'],
    run: () => addMarkerAtPlayhead('') },
  { id: 'kfPrev', label: 'Previous keyframe of selected clip', hint: '[', defaults: ['['],
    run: () => seekKeyframe(-1) },
  { id: 'kfNext', label: 'Next keyframe of selected clip', hint: ']', defaults: [']'],
    run: () => seekKeyframe(1) },
  { id: 'zoomFit', label: 'Zoom timeline to fit', hint: 'Shift+Z', defaults: ['shift+z'],
    run: () => fire('cutlab:zoom-fit') },
  { id: 'pageMedia', label: 'Media page', hint: 'Shift+2', defaults: ['shift+2'],
    run: () => gotoPage('media') },
  { id: 'pageEdit', label: 'Edit page', hint: 'Shift+4', defaults: ['shift+4'],
    run: () => gotoPage('edit') },
  { id: 'pageColour', label: 'Colour page', hint: 'Shift+6', defaults: ['shift+6'],
    run: () => gotoPage('colour') },
  { id: 'pageAudio', label: 'Audio page', hint: 'Shift+7', defaults: ['shift+7'],
    run: () => gotoPage('audio') },
  { id: 'pageDeliver', label: 'Deliver page', hint: 'Shift+8', defaults: ['shift+8'],
    run: () => gotoPage('deliver') },
  { id: 'viewerFocus', label: 'Viewer focus mode (collapse panels + timeline)', hint: 'Shift+F', defaults: ['shift+f'],
    run: () => toggleViewerFocus() },
  { id: 'undo', label: 'Undo (Ctrl+Shift+Z redoes)', hint: 'Ctrl+Z', defaults: ['ctrl+z'],
    run: (e) => { if (e.shiftKey) store.redo(); else store.undo(); } },
  { id: 'redo', label: 'Redo', hint: 'Ctrl+Y', defaults: ['ctrl+y'],
    run: () => store.redo() },
  { id: 'importMedia', label: 'Import media', hint: 'Ctrl+I', defaults: ['ctrl+i'],
    run: () => fire('cutlab:import-media') },
  { id: 'openProject', label: 'Open project file', hint: 'Ctrl+O', defaults: ['ctrl+o'],
    run: () => fire('cutlab:open-project-file') },
  { id: 'openCloudProject', label: 'Open cloud / library project', hint: 'Ctrl+Shift+O', defaults: ['ctrl+shift+o'],
    run: () => fire('cutlab:open-project') },
  { id: 'saveJson', label: 'Download project JSON', hint: 'Ctrl+S', defaults: ['ctrl+s'],
    run: () => fire('cutlab:save-json') },
  { id: 'compound', label: 'Compound selected clips into a nest', hint: 'Ctrl+G', defaults: ['ctrl+g'],
    run: () => makeCompoundFromSelection() },
  { id: 'uncompound', label: 'Uncompound selected nest', hint: 'Ctrl+Shift+G', defaults: ['ctrl+shift+g'],
    run: () => uncompoundSelected() },
];

// ---- overrides (per-user keymap) ----

const KEYMAP_KEY = 'cutlab.keymap';
let overridesCache: Record<string, string> | null = null;

export function loadKeymapOverrides(): Record<string, string> {
  if (overridesCache) return overridesCache;
  try {
    const raw = localStorage.getItem(KEYMAP_KEY);
    overridesCache = raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    overridesCache = {};
  }
  return overridesCache;
}

function persistOverrides() {
  try {
    localStorage.setItem(KEYMAP_KEY, JSON.stringify(loadKeymapOverrides()));
  } catch { /* storage unavailable — remap lasts for the session */ }
}

/** The effective combo list for an action: the override, or the defaults. */
export function combosFor(action: ShortcutAction): string[] {
  const ov = loadKeymapOverrides()[action.id];
  return ov ? [ov] : action.defaults;
}

export function keymapOverride(id: string): string | undefined {
  return loadKeymapOverrides()[id];
}

/** Normalise a keyboard event to a combo string ('ctrl+shift+b', 'space',
 *  'arrowleft', …). Returns null for lone modifiers / unmappable keys. */
export function comboForEvent(e: KeyboardEvent): string | null {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null;
  let key: string;
  if (e.code === 'Space') key = 'space';
  else if (e.key === 'Delete') key = 'delete';
  else if (e.key === 'Backspace') key = 'backspace';
  else if (e.key === 'Home') key = 'home';
  else if (e.key.startsWith('Arrow')) key = e.key.toLowerCase();
  else if (e.key.length === 1) key = e.key.toLowerCase();
  else return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export function displayCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return 'Alt';
      if (p === 'space') return 'Space';
      if (p === 'delete') return 'Del';
      if (p === 'backspace') return '⌫';
      if (p === 'arrowleft') return '←';
      if (p === 'arrowright') return '→';
      if (p === 'arrowup') return '↑';
      if (p === 'arrowdown') return '↓';
      if (p === 'home') return 'Home';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join('+');
}

/** Assign a captured combo to an action. Refuses (with a reason) when
 *  another action already owns that combo. */
export function setKeymapOverride(id: string, combo: string): { ok: true } | { ok: false; error: string } {
  for (const a of SHORTCUT_ACTIONS) {
    if (a.id !== id && combosFor(a).includes(combo)) {
      return { ok: false, error: `“${displayCombo(combo)}” already runs “${a.label}” — reset that one first.` };
    }
  }
  loadKeymapOverrides()[id] = combo;
  persistOverrides();
  return { ok: true };
}

export function clearKeymapOverride(id: string) {
  delete loadKeymapOverrides()[id];
  persistOverrides();
}

export function resetKeymap() {
  overridesCache = {};
  persistOverrides();
}

/** FIX B1 #10: is any modal/dialog open? Every dialog in the app is
 *  either a [role="dialog"] card or a full-screen .fixed.inset-0
 *  backdrop (Export, Open cloud, Settings, Feedback, Account, History,
 *  Cover, Paste-attributes, Auth, Replicate). While one is open,
 *  transport/editing shortcuts must NOT fire behind it — pressing Space
 *  in the Export dialog used to start playback under the modal. The
 *  dialogs' own keys (Escape, Tab, typing) are handled by the dialogs
 *  themselves and never reach this dispatcher as actions. */
export function anyDialogOpen(): boolean {
  return typeof document !== 'undefined'
    && !!document.querySelector('[role="dialog"], .fixed.inset-0');
}

/** The App keyboard handler: find the action for this event and run it.
 *  Returns true when a binding matched (caller preventDefaults). */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  if (anyDialogOpen()) return false;
  const combo = comboForEvent(e);
  if (!combo) return false;
  // D1.4: bare digit keys cut the multicam clip under the playhead to
  // that angle. Positional like Resolve's angle keys, so not part of
  // the remappable registry; when no multicam clip is in play the digit
  // falls through and keeps its default behaviour.
  if (/^[1-9]$/.test(combo) && cutToAngleAtPlayhead(Number(combo) - 1)) return true;
  // Page keys are POSITIONAL (Resolve's Shift+2…Shift+8 row): match
  // by e.code, because Shift+digit produces layout-dependent e.key
  // values ('@', '"', …) that comboForEvent cannot normalise. The
  // registry entries exist for the reference list + remapping; this
  // is the path that actually fires on the number row.
  if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const pageForCode: Record<string, PageId> = {
      Digit2: 'media', Digit4: 'edit', Digit6: 'colour', Digit7: 'audio', Digit8: 'deliver',
    };
    const p = pageForCode[e.code];
    if (p) { gotoPage(p); return true; }
  }
  for (const a of SHORTCUT_ACTIONS) {
    if (combosFor(a).includes(combo)) { a.run(e); return true; }
  }
  if (e.shiftKey) {
    const stripped = combo.replace('shift+', '');
    for (const a of SHORTCUT_ACTIONS) {
      if (combosFor(a).includes(stripped)) { a.run(e); return true; }
    }
  }
  return false;
}

// Back-compat display list (derived from the registry).
export interface ShortcutDef { keys: string; action: string }
export const SHORTCUTS: ShortcutDef[] = SHORTCUT_ACTIONS.map((a) => ({
  keys: a.defaults.map(displayCombo).join(' / '),
  action: a.label,
}));
