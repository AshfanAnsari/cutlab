import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../state/store';
import { loadProjectFile, missingMedia, saveProjectBundle, saveProjectJson } from '../services/projectIO';
import { mediaStore } from '../services/mediaStore';
import { jobService, clearRelayProjectSlot, setRelayProjectSlot } from '../services/jobsSupabase';
import { entryProject, listLibrary, removeFromLibrary, saveToLibrary, type LibraryEntry } from '../services/projectLibrary';
import HistoryPanel from './HistoryPanel';
import { controlAllowed, setControlEnabled, useControl } from '../services/control';
import { signOut, useAuth } from '../services/auth';
import AuthModal from './AuthModal';
import AccountPanel from './AccountPanel';
import SettingsDialog from './SettingsDialog';
import FeedbackDialog from './FeedbackDialog';
import { togglePanel, PANEL_KEYS } from '../services/settings';
import { requestShortcutsOpen } from '../services/inspectorNav';
import { setPage, PAGES, type PageId } from '../services/pages';
import { addMarkerAtPlayhead, deleteSelected, rippleDeleteSelected, splitAtPlayhead } from '../state/actions';
import { fmtDateTime } from '../utils/time';
import type { RemoteProjectInfo } from '../services/jobs';
import type { Project } from '../types';
import { bindProjectMedia, newProject } from '../services/projectLifecycle';
import logoMark from '../assets/logo-mark.png';
import Switch from './Switch';

type MenuItem =
  | { divider: true }
  | { label: string; hint?: string; disabled?: boolean; onClick: () => void };

/** While a compound nest is open, project-level operations (open / save /
 *  cloud) must not run: the store's project IS the nest, and saving or
 *  replacing it would corrupt the parent. Returns true when blocked. */
function nestBlocked(): boolean {
  if (!store.get().nestSession) return false;
  store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
  return true;
}

export default function TopBar({ onExport, onReplicate, onHome }: {
  onExport: () => void;
  onReplicate?: () => void;
  /** FIX A (research §5.2/§5.3): the logo is Home. FIX C landed the
   *  Home (Project Manager) view — App passes onHome and the click
   *  goes there for real. The toast fallback in goHome remains only
   *  for a hypothetical TopBar mounted without the prop. */
  onHome?: () => void;
}) {
  useEffect(() => {
    const open = () => void openCloudList();
    // FIX B1 #11: Ctrl+O means the FILE picker (same as File → Open…);
    // the cloud/library modal moved to Ctrl+Shift+O ('cutlab:open-project').
    const openFileEvt = () => { if (!nestBlocked()) fileRef.current?.click(); };
    const save = () => { if (!nestBlocked()) saveProjectJson(store.get().project); };
    window.addEventListener('cutlab:open-project', open);
    window.addEventListener('cutlab:open-project-file', openFileEvt);
    window.addEventListener('cutlab:save-json', save);
    return () => {
      window.removeEventListener('cutlab:open-project', open);
      window.removeEventListener('cutlab:open-project-file', openFileEvt);
      window.removeEventListener('cutlab:save-json', save);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const name = useStore((s) => s.project.name);
  const saveStatus = useStore((s) => s.saveStatus);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const restored = useStore((s) => s.restoredFromAutosave);
  useStore((s) => s.project); // re-render on every project change so undo/redo states stay live
  const canUndo = store.canUndo();
  const canRedo = store.canRedo();
  const fileRef = useRef<HTMLInputElement>(null);
  const control = useControl();
  const auth = useAuth();
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [cloudList, setCloudList] = useState<RemoteProjectInfo[] | null>(null);
  /** FIX B1 #12: why the relay list is empty — a failed fetch must not
   *  read as "no projects yet", and signed-out must say so. */
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [libList, setLibList] = useState<LibraryEntry[] | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<'file' | 'edit' | 'view' | 'help' | 'overflow' | 'avatar' | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // FIX A degradation (research §5.5, AMENDED by the user's zoning
  // input 2026-11-06 13:18 IST): viewport-driven levels. ONE bar,
  // zoned internally with dividers; it sheds in a fixed order and
  // NEVER clips: the project name truncates → the save word drops to
  // dot-only → the TOOLS zone (Jarvis + Replicate) collapses into ⋯ →
  // Undo/Redo move into ⋯ → the menus collapse into ⋯. The ⋯ button
  // is rendered only when a level gives it contents; at full width
  // it does not exist. Export, avatar/Sign in and the logo never move.
  const [vw, setVw] = useState<number>(() => (typeof window !== 'undefined' ? window.innerWidth : 1920));
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const barLevel: 'full' | 'mid' | 'small' | 'phone' =
    vw < 900 ? 'phone' : vw < 1024 ? 'small' : vw < 1280 ? 'mid' : 'full';
  const showSaveWord = barLevel === 'full';
  const toolsInBar = barLevel === 'full';
  const historyInBar = barLevel === 'full' || barLevel === 'mid';
  const showMenus = barLevel !== 'phone';
  const showOverflow = barLevel !== 'full';
  const showAccountSlot = barLevel !== 'phone';
  // The Jarvis slot's gate is the Phase-1 condition, preserved exactly:
  // rendered only when control is on, or the signed-in account is the
  // control-capable owner (controlAllowed() itself requires a session).
  const jarvisAllowed = control.enabled || controlAllowed().allowed;

  // Menus close on any outside pointer-down or Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const openSettings = () => setSettingsOpen(true);

  /** The bar's one primary (research §5.3 #10): Export goes to the
   *  Deliver page. The quick Export… dialog stays on File > Export…
   *  (the onExport prop) — two doors, one labelled dialog, one page. */
  const goDeliver = () => {
    if (nestBlocked()) return;
    setPage('deliver');
  };

  const goPage = (p: PageId) => {
    if (store.get().nestSession && p !== 'edit') {
      store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
      return;
    }
    setPage(p);
  };

  /** Help > Keyboard shortcuts: the shortcuts view is the Inspector's
   *  Shortcuts section (Project view, nothing selected). Route there
   *  honestly: Edit page + cleared selection + open the Inspector
   *  panel if its persisted state is closed. */
  const openShortcuts = () => {
    goPage('edit');
    store.set({ selected: null, selectedMany: [] });
    // FIX C: the shortcuts table now lives behind the Inspector's
    // "Keyboard shortcuts" disclosure — ask it to open on arrival
    // (services/inspectorNav: a sticky one-shot, consumed on mount
    // or heard live if the rail is already showing the project view).
    requestShortcutsOpen();
    try {
      if (localStorage.getItem(PANEL_KEYS.inspector) === 'closed') togglePanel(PANEL_KEYS.inspector);
    } catch { /* panel state unreadable: the section is one click away */ }
  };

  const goHome = () => {
    // FIX C: App passes onHome — the click switches to the Home view
    // (the loaded project stays autosaved; Continue brings it back).
    if (onHome) { onHome(); return; }
    store.toastMsg('info', 'Home — the project home is the next build step. Your project stays open here.');
  };

  const adoptProject = async (p: Project) => {
    if (nestBlocked()) return;
    await bindProjectMedia(p);
    // D4 companion: loading a project pushes history, so the promise
    // the Open dialog (and the New toast) makes — "Undo brings the
    // old one back" — is actually true.
    store.replaceProject(p, { history: true, label: 'Open project' });
    const missing = await missingMedia(p);
    if (missing.length > 0) {
      store.toastMsg('info', `Project loaded. ${missing.length} media file(s) not in the bin yet — import them (same file names) to bind: ${missing.map((m) => m.src).join(', ')}`);
    } else {
      store.toastMsg('info', 'Project loaded and all media bound.');
    }
  };

  const openFile = async (f: File) => {
    try {
      const p = await loadProjectFile(f);
      // A file-loaded project starts a fresh relay slot; Cloud save will
      // create its own row instead of overwriting the previous project's.
      void clearRelayProjectSlot();
      await adoptProject(p);
    } catch {
      /* toast already shown by loader */
    }
  };

  const cloudSave = async () => {
    if (nestBlocked()) return;
    if (!jobService.saveProjectRemote) return;
    setCloudBusy(true);
    try {
      await jobService.saveProjectRemote(store.get().project);
      store.toastMsg('info', 'Project saved to the server relay (cutlab_projects).');
    } catch (e) {
      store.toastMsg('error', 'Cloud save failed — ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCloudBusy(false);
    }
  };

  const openCloudList = async () => {
    if (nestBlocked()) return;
    setCloudOpen(true);
    setLibList(null);
    void listLibrary().then(setLibList).catch(() => setLibList([]));
    if (!jobService.listRemoteProjects) return;
    setCloudList(null);
    setCloudError(null);
    try {
      setCloudList(await jobService.listRemoteProjects());
    } catch (e) {
      store.toastMsg('error', 'Could not list relay projects — ' + (e instanceof Error ? e.message : String(e)));
      setCloudError(e instanceof Error ? e.message : String(e));
      setCloudList([]);
    }
  };

  const cloudLoad = async (id: string) => {
    if (!jobService.loadProjectRemote) return;
    setCloudBusy(true);
    try {
      const p = await jobService.loadProjectRemote(id);
      if (!p) {
        store.toastMsg('error', 'That relay project no longer exists.');
        return;
      }
      setCloudOpen(false);
      await setRelayProjectSlot(id, p.name);
      await adoptProject(p);
    } catch (e) {
      store.toastMsg('error', 'Cloud load failed — ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCloudBusy(false);
    }
  };

  const saveBundle = async () => {
    if (nestBlocked()) return;
    const recs = await mediaStore.all();
    await saveProjectBundle(store.get().project, recs);
  };


  // Every menu item calls the SAME action its toolbar/keyboard surface calls.
  const menus: Record<'file' | 'edit' | 'view' | 'help', MenuItem[]> = {
    file: [
      { label: 'New project', onClick: newProject },
      { label: 'Open…', hint: '.json / .cutlab', onClick: () => fileRef.current?.click() },
      { label: 'Open cloud…', onClick: () => void openCloudList() },
      { divider: true },
      { label: 'Save JSON', onClick: () => saveProjectJson(store.get().project) },
      { label: 'Save bundle (.cutlab)', onClick: () => void saveBundle() },
      {
        label: 'Save copy to local library', hint: 'this browser',
        onClick: () => {
          void saveToLibrary(store.get().project).then(() => {
            store.toastMsg('info', 'Saved to the local library — find it under Open cloud… → This browser.');
          });
        },
      },
      { label: 'Save cloud', onClick: () => void cloudSave() },
      { divider: true },
      { label: 'Export…', hint: 'dialog', onClick: onExport },
      { label: 'Go to Deliver page', onClick: goDeliver },
      { divider: true },
      { label: 'Settings…', onClick: openSettings },
    ],
    edit: [
      { label: 'Undo', hint: 'Ctrl+Z', disabled: !canUndo, onClick: () => store.undo() },
      { label: 'Redo', hint: 'Ctrl+Shift+Z', disabled: !canRedo, onClick: () => store.redo() },
      { label: 'History…', onClick: () => setHistoryOpen(true) },
      { divider: true },
      { label: 'Split at playhead', hint: 'S', onClick: splitAtPlayhead },
      { label: 'Ripple delete', hint: 'Del', onClick: rippleDeleteSelected },
      { label: 'Delete (leave gap)', hint: 'Shift+Del', onClick: deleteSelected },
      { divider: true },
      { label: 'Add marker at playhead', hint: 'M', onClick: () => addMarkerAtPlayhead('') },
      { divider: true },
      // FIX A: Replicate's TopBar pill is gone; this menu entry is its
      // home now. NOTE: before this rebuild the pill was the ONLY
      // route to ReplicateView anywhere in the app (no menu, panel or
      // page surface calls onReplicate) — this entry is load-bearing.
      { label: 'Replicate an Edit…', disabled: !onReplicate, onClick: () => onReplicate?.() },
    ],
    view: [
      ...PAGES.map((p): MenuItem => ({ label: `${p.label} page`, onClick: () => goPage(p.id) })),
      { divider: true },
      { label: 'Toggle Media panel', onClick: () => togglePanel(PANEL_KEYS.media) },
      { label: 'Toggle Inspector panel', onClick: () => togglePanel(PANEL_KEYS.inspector) },
    ],
    // AMENDED (user, 2026-11-06): a Help menu joins File/Edit/View,
    // and Feedback lives HERE — not in the avatar menu (§5 had it
    // there). Only real destinations: the feedback dialog (account-
    // bound, so signed-out routes to sign-in with the reason stated)
    // and the shortcuts view. No help-pages link: the app has no
    // in-app help URL (help lives on the landing site, a different
    // deploy base) — omitted rather than invented.
    help: [
      {
        label: 'Feedback…', hint: auth ? undefined : 'sign in first',
        onClick: () => {
          if (auth) setFeedbackOpen(true);
          else {
            store.toastMsg('info', 'Sign in to send feedback — reports are tied to your account.');
            setAuthOpen(true);
          }
        },
      },
      { label: 'Keyboard shortcuts…', onClick: openShortcuts },
    ],
  };

  // FIX A: what the ⋯ overflow holds at each degraded level
  // (amended order: tools zone first, then history). mid: the tools
  // zone's items (Jarvis if its gate passes, Replicate). small: +
  // Undo/Redo. phone: the grouped sheet in the JSX renders
  // menus.file/edit/view/help + account directly, so nothing is
  // phone-unreachable. Save cloud is NOT here — File menu only
  // (user input 2026-11-06).
  const overflowItems: MenuItem[] = [
    ...(!toolsInBar && jarvisAllowed ? [{
      label: control.enabled ? 'Jarvis control: ON — stop' : 'Jarvis control — let Jarvis drive',
      onClick: () => void setControlEnabled(!control.enabled),
    } as MenuItem] : []),
    ...(!toolsInBar && onReplicate ? [{
      label: 'Replicate an Edit…', onClick: () => onReplicate?.(),
    } as MenuItem] : []),
    ...(!toolsInBar && (jarvisAllowed || onReplicate) && !historyInBar ? [{ divider: true } as MenuItem] : []),
    ...(!historyInBar ? [
      { label: 'Undo', hint: 'Ctrl+Z', disabled: !canUndo, onClick: () => store.undo() } as MenuItem,
      { label: 'Redo', hint: 'Ctrl+Shift+Z', disabled: !canRedo, onClick: () => store.redo() } as MenuItem,
    ] : []),
  ];

  // Avatar menu (amended): Account / Settings / Sign out ONLY —
  // Feedback moved to the Help menu on the user's input.
  const accountItems: MenuItem[] = auth ? [
    { label: 'Account…', onClick: () => setAccountOpen(true) },
    { label: 'Settings…', onClick: openSettings },
    { divider: true },
    {
      label: 'Sign out',
      onClick: () => { void signOut().then(() => store.toastMsg('info', 'Signed out. Local projects are untouched.')); },
    },
  ] : [];

  /** One renderer for every TopBar dropdown (menus, ⋯, avatar). */
  const renderMenuItems = (items: MenuItem[]) => items.map((item, i) =>
    'divider' in item ? (
      <div key={i} className="my-1 border-t border-[#3a3a3a]" />
    ) : (
      <button
        key={i}
        role="menuitem"
        className="flex w-full items-center justify-between gap-6 px-3 py-1.5 text-left text-[13px] text-[#e8e8e8] hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        disabled={item.disabled}
        onClick={() => { setOpenMenu(null); item.onClick(); }}
      >
        <span>{item.label}</span>
        {item.hint && <span className="font-mono text-[11px] text-[#a8a8a8]">{item.hint}</span>}
      </button>
    ),
  );

  // R11: autosave as a status dot + a one-line word that never wraps.
  // The dot's changes are instant (it is a status, not an animation).
  const saveText =
    saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'error' ? 'Autosave failed'
    : lastSavedAt ? `Saved ${new Date(lastSavedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    : restored ? 'Restored from autosave'
    : 'Autosave on';
  const saveDot =
    saveStatus === 'saving' ? '#E8C268'
    : saveStatus === 'error' ? '#E31000'
    : saveStatus === 'saved' || lastSavedAt ? '#7DC98A'
    : '#8f8f8f';

  return (
    <>
    <header ref={menuRef} className="relative flex h-[42px] items-center gap-2 border-b border-[#3a3a3a] bg-[#161616] px-3">
      {/* LEFT zone (AMENDED zoning, user 2026-11-06): logo (Home) +
          File/Edit/View/Help menus + project name + saved state.
          Ghost buttons, no pill chrome; zones split by dividers. */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <button className="tb-icon-btn" aria-label="Home" title="Home"
          onClick={goHome}>
          <img src={logoMark} alt="" width={20} height={20} className="block" draggable={false} />
        </button>
        {showMenus && (
          <div className="tb-menus flex items-center gap-0.5" role="menubar" aria-label="Application menus">
            {(Object.keys(menus) as ('file' | 'edit' | 'view' | 'help')[]).map((key) => (
              <div key={key} className="relative">
                <button
                  className="tb-ghost"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === key}
                  style={openMenu === key ? { background: '#2a2a2a', color: '#fff' } : undefined}
                  onClick={() => setOpenMenu(openMenu === key ? null : key)}
                >
                  {key[0].toUpperCase() + key.slice(1)}
                </button>
                {openMenu === key && (
                  <div className="absolute left-0 top-full z-40 mt-1 min-w-[230px] rounded-md border border-[#3a3a3a] bg-[#262626] py-1 shadow-2xl" role="menu">
                    {renderMenuItems(menus[key])}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <span aria-hidden className="tb-divider" />
        {/* Project name + saved state — inside the LEFT zone
            (amended zoning). The name is the bar's flex item: it
            truncates FIRST in the degradation order; the save word
            drops at <1280px, leaving the status dot. Cloud-save
            STATUS lives here as dot+word — an indicator, not a
            button (the action itself is File-menu only). */}
        {/* SLIM PASS 2026-11-06: the name field hugs its content
            (ch-width, capped) instead of flexing to a fixed 340px —
            the title + save dot read as ONE tight cluster, and the
            bar's empty stretch is plain bar, not a stranded dot
            floating mid-cluster. */}
        <div className="flex min-w-0 items-center gap-2 pl-1">
        <input
          className="field tb-name"
          style={{ width: `min(340px, max(96px, ${(name?.length ?? 0) + 2}ch))` }}
          value={name}
          aria-label="Project name"
          title="Project name — click to rename"
          onChange={(e) => store.commit((d) => { d.name = e.target.value; }, { history: false })}
        />
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-[#a8a8a8]"
          title={`The project auto-persists locally and is restored on reload — ${saveText}`}>
          <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: saveDot }} />
          {showSaveWord && <span className="tb-savetext">{saveText}</span>}
        </span>
        </div>
      </div>
      {/* HISTORY zone — the icon-only Undo/Redo pair, its own zone. */}
      {historyInBar && (
        <>
          <span aria-hidden className="tb-divider" />
          <div className="flex shrink-0 items-center gap-0.5">
            <button className="tb-icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)"
              disabled={!canUndo} onClick={() => store.undo()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" />
              </svg>
            </button>
            <button className="tb-icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"
              disabled={!canRedo} onClick={() => store.redo()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m15 14 5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" />
              </svg>
            </button>
          </div>
        </>
      )}
      {/* TOOLS zone — Jarvis control + Replicate. AMENDED (user,
          2026-11-06): Replicate SURVIVES in the bar here, overriding
          research §5's menus-only move; it ALSO remains reachable
          from the Edit menu. The Jarvis slot exists only under the
          Phase-1 gate (signed-in owner / control on), as before. */}
      {toolsInBar && (
        <>
          <span aria-hidden className="tb-divider" />
          <div className="flex shrink-0 items-center gap-1">
            {jarvisAllowed && (
              /* TOGGLE PORT 2026-11-06: Jarvis control is the canonical
                 Switch (labelled, state legible at a glance) — the old
                 icon+dot button is gone; the ON banner below the bar is
                 unchanged. */
              <span className="flex items-center gap-1.5 pl-0.5">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="text-[#c0c0c0]">
                  <path d="M12 3.5 13.9 10 20.5 12 13.9 13.9 12 20.5 10.1 13.9 3.5 12 10.1 10Z" />
                </svg>
                <span className="text-[12px] text-[#c9c9c9]">Jarvis</span>
                <Switch
                  checked={control.enabled}
                  ariaLabel={control.enabled ? 'Jarvis control is on' : 'Jarvis control'}
                  onChange={(v) => void setControlEnabled(v)}
                  title={control.enabled
                    ? 'Jarvis control is ON — Jarvis is driving this editor. Click to stop.'
                    : 'Jarvis control — let Jarvis drive this open editor live through the relay. Owner-only; off by default; a banner shows while it is on.'}
                />
              </span>
            )}
            {onReplicate && (
              <button className="tb-ghost" onClick={onReplicate}
                title="Replicate an Edit — analyse a reference edit and rebuild it with your own footage">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />
                </svg>
                Replicate
              </button>
            )}
          </div>
        </>
      )}
      <span aria-hidden className="tb-divider" />
      {/* FAR RIGHT — the bar's ONLY primary (Export, red) · the
          account slot (avatar menu signed in / Sign in signed out,
          never both) · conditional ⋯. New / Open… / Save cloud /
          Account / Feedback / Settings pills are GONE from the bar:
          File, Edit, Help and avatar menus carry them (reachability
          verified in QA). */}
      <div className="flex shrink-0 items-center gap-1.5">
        {barLevel === 'phone' ? (
          <button className="btn primary" style={{ padding: '6px 8px' }} aria-label="Export — go to Deliver page"
            title="Export — go to the Deliver page" onClick={goDeliver}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" /><path d="M4 15v3a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-3" />
            </svg>
          </button>
        ) : (
          <button className="btn primary" onClick={goDeliver} title="Export — go to the Deliver page">Export</button>
        )}
        {/* Account slot: the SAME slot in both states — avatar menu
            signed in, neutral Sign in signed out. On phone it moves
            into the ⋯ sheet (spec §5.5). */}
        {showAccountSlot && (auth ? (
          <div className="relative">
            <button className="tb-avatar-btn" aria-label="Account menu" aria-haspopup="menu"
              aria-expanded={openMenu === 'avatar'} title={auth.user.email}
              onClick={() => setOpenMenu(openMenu === 'avatar' ? null : 'avatar')}>
              {(auth.user.email?.[0] ?? '?').toUpperCase()}
            </button>
            {openMenu === 'avatar' && (
              <div className="absolute right-0 top-full z-40 mt-1 min-w-[230px] rounded-md border border-[#3a3a3a] bg-[#262626] py-1 shadow-2xl" role="menu">
                <div className="px-3 py-1.5">
                  <div className="truncate text-[13px] text-[#e8e8e8]">{auth.user.email}</div>
                  <div className="text-[11px] text-[#a8a8a8]">Signed in</div>
                </div>
                <div className="my-1 border-t border-[#3a3a3a]" />
                {renderMenuItems(accountItems)}
              </div>
            )}
          </div>
        ) : (
          <button className="btn" onClick={() => setAuthOpen(true)}>Sign in</button>
        ))}
        {/* ⋯ overflow — rendered ONLY at degraded levels, where it
            has contents (research §5.5). At full width it does not
            exist. On phone it is a grouped sheet mirroring the menus
            + account, so nothing is phone-unreachable. */}
        {showOverflow && (
          <div className="relative">
            <button className="tb-icon-btn" aria-label="More actions" aria-haspopup="menu"
              aria-expanded={openMenu === 'overflow'} title="More actions"
              style={openMenu === 'overflow' ? { background: '#2a2a2a', color: '#fff' } : undefined}
              onClick={() => setOpenMenu(openMenu === 'overflow' ? null : 'overflow')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
              </svg>
            </button>
            {openMenu === 'overflow' && (barLevel === 'phone' ? (
              <div className="absolute right-0 top-full z-40 mt-1 max-h-[70vh] w-[260px] overflow-y-auto rounded-md border border-[#3a3a3a] bg-[#262626] py-1 shadow-2xl" role="menu">
                {jarvisAllowed && (
                  <>
                    {renderMenuItems([{
                      label: control.enabled ? 'Jarvis control: ON — stop' : 'Jarvis control — let Jarvis drive',
                      onClick: () => void setControlEnabled(!control.enabled),
                    }])}
                    <div className="my-1 border-t border-[#3a3a3a]" />
                  </>
                )}
                <div className="panel-title px-3 pb-0.5 pt-1.5">Project</div>
                {renderMenuItems(menus.file)}
                <div className="panel-title px-3 pb-0.5 pt-2">Edit</div>
                {renderMenuItems(menus.edit)}
                <div className="panel-title px-3 pb-0.5 pt-2">View</div>
                {renderMenuItems(menus.view)}
                <div className="panel-title px-3 pb-0.5 pt-2">Help</div>
                {renderMenuItems(menus.help)}
                <div className="panel-title px-3 pb-0.5 pt-2">Account</div>
                {auth
                  ? renderMenuItems(accountItems)
                  : renderMenuItems([{ label: 'Sign in…', onClick: () => setAuthOpen(true) }])}
              </div>
            ) : (
              <div className="absolute right-0 top-full z-40 mt-1 min-w-[230px] rounded-md border border-[#3a3a3a] bg-[#262626] py-1 shadow-2xl" role="menu">
                {renderMenuItems(overflowItems)}
              </div>
            ))}
          </div>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,.cutlab,application/json,application/zip"
        className="hidden"
        data-testid="project-file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void openFile(f);
          e.target.value = '';
        }}
      />
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {accountOpen && (
        <AccountPanel
          onClose={() => setAccountOpen(false)}
          onLoadProject={(id) => { setAccountOpen(false); void cloudLoad(id); }}
        />
      )}
      {feedbackOpen && <FeedbackDialog onClose={() => setFeedbackOpen(false)} />}
      {cloudOpen && (
        <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={() => setCloudOpen(false)}>
          <div className="modal-panel w-[440px] max-w-[92vw]"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
              <span className="text-[18px] font-semibold">Open project</span>
              <button className="btn icon" onClick={() => setCloudOpen(false)}>×</button>
            </div>
            <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto px-4 py-3">
              <div className="panel-title">This browser — local library</div>
              {libList === null && <p className="text-[13px] text-[#a8a8a8]">Listing local projects…</p>}
              {libList !== null && libList.length === 0 && (
                <p className="text-[13px] text-[#a8a8a8]">Nothing saved yet — File → “Save copy to local library” puts the current project here.</p>
              )}
              {(libList ?? []).map((e) => (
                <div key={e.id} className="flex items-center gap-2 rounded-md border border-[#3a3a3a] bg-[#262626] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{e.name}</div>
                    <div className="font-mono text-[11px] text-[#a8a8a8]">{fmtDateTime(e.savedAt)}</div>
                  </div>
                  {e.prev && (
                    <button className="btn small" title={`Restore the previous version (${fmtDateTime(e.prevAt ?? '')})`}
                      onClick={async () => {
                        const p = entryProject(e, 'prev');
                        if (p) { setCloudOpen(false); await adoptProject(p); }
                      }}>Prev version</button>
                  )}
                  <button className="btn small" onClick={async () => {
                    const p = entryProject(e, 'current');
                    if (p) { setCloudOpen(false); await adoptProject(p); }
                  }}>Load</button>
                  <button className="btn small danger" title="Remove from the library"
                    onClick={async () => { await removeFromLibrary(e.id); setLibList(await listLibrary()); }}>✕</button>
                </div>
              ))}
              <div className="panel-title mt-2">Server relay</div>
              {cloudList === null && <p className="text-[13px] text-[#a8a8a8]">Listing relay projects…</p>}
              {cloudList !== null && cloudList.length === 0 && !auth && (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-[13px] text-[#a8a8a8]">Sign in to browse cloud projects — relay projects are tied to your account, so there is nothing to list while you are signed out.</p>
                  <button className="btn small" onClick={() => { setCloudOpen(false); setAuthOpen(true); }}>Sign in</button>
                </div>
              )}
              {cloudList !== null && cloudList.length === 0 && !!auth && cloudError && (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-[13px] text-[#a8a8a8]">Couldn’t load your relay projects — {cloudError}</p>
                  <button className="btn small" onClick={() => void openCloudList()}>Retry</button>
                </div>
              )}
              {cloudList !== null && cloudList.length === 0 && !!auth && !cloudError && (
                <p className="text-[13px] text-[#a8a8a8]">No projects on the relay yet — “Save cloud” puts this one there.</p>
              )}
              {(cloudList ?? []).map((rp) => (
                <div key={rp.id} className="flex items-center gap-2 rounded-md border border-[#3a3a3a] bg-[#262626] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{rp.name}</div>
                    <div className="font-mono text-[11px] text-[#a8a8a8]">
                      {fmtDateTime(rp.updatedAt)}
                    </div>
                  </div>
                  <button className="btn small" disabled={cloudBusy} onClick={() => void cloudLoad(rp.id)}>Load</button>
                </div>
              ))}
              <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
                Loading replaces the current project (Undo brings it back). Media still
                binds by file name from this browser’s bin.
              </p>
            </div>
          </div>
        </div>
      )}
      {historyOpen && <HistoryPanel onClose={() => setHistoryOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
    {control.enabled && (
      <div
        className="flex items-center gap-3 px-3 py-1.5 text-[12px]"
        style={{ background: '#2b1210', borderBottom: '1px solid #E31000', color: '#f2d8d5' }}
        role="status"
      >
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: '#E31000' }}
        />
        <span className="font-semibold">Jarvis is driving this editor</span>
        <span className="font-mono text-[11px] text-[#c9a49f]">
          session {control.sessionId ? control.sessionId.slice(0, 13) + '…' : '—'}
        </span>
        <span className="text-[#c9a49f]">
          {control.busyKind
            ? `Running command: ${control.busyKind}…`
            : control.last
              ? `Last: ${control.last.kind} — ${control.last.ok ? 'done' : 'failed' + (control.last.error ? ` (${control.last.error})` : '')}`
              : 'Waiting for commands…'}
        </span>
        <div className="flex-1" />
        <button className="btn small" onClick={() => void setControlEnabled(false)}>
          Stop
        </button>
      </div>
    )}
    </>
  );
}
