import { useEffect, useRef, useState } from 'react';
import { store, useStore } from './state/store';
import { type Project } from './types';
import { projectStore } from './services/projectStore';
import { clearRelayProjectSlot, jobService, setRelayProjectSlot } from './services/jobsSupabase';
import { mediaStore, registerMedia } from './services/mediaStore';
import { loadProjectFile, normalizeProject } from './services/projectIO';
import { playback } from './engine/playback';
import { registerControlProjectAdopter } from './services/control';
import { initAuth } from './services/auth';
import { CANVAS_PRESETS } from './services/settings';
import { initFonts } from './services/fonts';
import { initLuts } from './services/luts';
import { getPage, setPage, subscribePage, type PageId } from './services/pages';
import { track } from './services/analytics';
import { importFiles } from './services/importer';
import { requestInspectorTabOpen, requestPromptDraft, requestPromptTabOpen } from './services/promptDraft';
import { requestProjectSettingsOpen } from './services/inspectorNav';
import { adoptProject, bindProjectMedia, createProject, createProjectCustom, newProject, newProjectWithCanvas } from './services/projectLifecycle';
import Home from './components/Home';
import LazySurface from './components/LazySurface';
import type { EditorIntent } from './components/EditorShell';
import { useNarrow } from './services/useNarrow';

export default function App() {
  useEffect(() => { void initFonts(); void initLuts(); }, []);
  // Phase 1: restore the auth session (and complete an OAuth return)
  // before anything reaches for the relay. Auth trouble only toasts —
  // local editing never depends on it.
  useEffect(() => {
    void initAuth().then((err) => {
      if (err) store.toastMsg('error', err);
    });
  }, []);
  const toast = useStore((s) => s.toast);
  const phone = useNarrow();
  const booted = useRef(false);
  // FIX C — HOME: the app-level view state (research §5.2). A cold
  // open lands on Home; the view is deliberately NOT persisted —
  // every fresh load starts at the front door, and the editor is
  // entered by opening a project (Continue / a card / Open… / New).
  const [view, setView] = useState<'home' | 'editor'>('home');
  const [bootReady, setBootReady] = useState(false);
  const [autosaveAt, setAutosaveAt] = useState<number | null>(null);
  // P8 lazy split (2026-11-06): the editor shell is a separate chunk,
  // loaded on first entry. Home crossings that used to set editor
  // state on App (phone zone, open-Replicate-on-arrival) now record
  // an entry intent, which the freshly mounted shell seeds from.
  const [editorIntent, setEditorIntent] = useState<EditorIntent>({});
  // BACK-NAV FIX (2026-11-06, user report): pressing the browser
  // Back button in the editor threw the user out of the app onto
  // the landing page. Home ⇄ Editor was pure React state, so the
  // browser's previous history entry was the landing document
  // itself. Now entering the editor pushes ONE sentinel history
  // entry and leaving pops it: Back from the editor lands on the
  // workspace Home, Forward returns to the editor, and a second
  // Back from Home leaves the app — normal browser behaviour.
  // The logo (TopBar onHome → goHome below) consumes the same
  // entry via history.back(), so both back routes agree.
  const viewRef = useRef(view);
  viewRef.current = view;
  const onEditorEntry = () =>
    (window.history.state as { cutlabView?: string } | null)?.cutlabView === 'editor';

  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const toEditor = (e.state as { cutlabView?: string } | null)?.cutlabView === 'editor';
      if (toEditor) {
        if (viewRef.current !== 'editor') setView('editor');
        return;
      }
      if (viewRef.current !== 'editor') return;
      if (store.get().nestSession) {
        // Same refusal as goHome: a nest edit is finished with
        // "Done", never by navigating away. Restore the sentinel
        // so the editor keeps its Back trap while nested.
        window.history.pushState({ cutlabView: 'editor' }, '');
        store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
        return;
      }
      playback.pause();
      setView('home');
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Analytics (EXTRAS, privacy-light): page_views only here — one
  // per PageId per session (the once-guard lives in track()), plus
  // 'home' for the workspace view, which is not a PageId. Tracking
  // fails silent by construction, so this can never affect boot.
  useEffect(() => subscribePage(() => track('page_view', { page: getPage() })), []);
  useEffect(() => {
    track('page_view', { page: view === 'home' ? 'home' : getPage() });
  }, [view]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    playback.setProjectGetter(() => store.get().project);
    // Live control (services/control.ts): opening a cloud project by remote
    // command must bind media and enter the store exactly like the UI's own
    // Open-cloud flow does.
    registerControlProjectAdopter(async (p) => {
      await bindProjectMedia(p);
      // FIX B2 #24: the Jarvis-control adopter goes through the same
      // store path as every other Open — with history, so a remotely
      // opened project can be undone back to the local one (B1 flag).
      store.replaceProject(p, { history: true, label: 'Open project' });
    });
    (async () => {
      try {
        const all = await mediaStore.all();
        for (const rec of all) registerMedia(rec);
        const rec = await projectStore.loadAutosave();
        if (rec?.savedAt) setAutosaveAt(rec.savedAt);
        if (rec && rec.project && (rec.project.tracks?.length || rec.project.media?.length)) {
          const p = normalizeProject(rec.project);
          // Bind media BEFORE the project enters the store: the runtime
          // registry is not reactive, so the first render with this project
          // must already see its media bound.
          await bindProjectMedia(p);
          store.replaceProject(p, { history: false });
          store.set({ restoredFromAutosave: true });
        }
      } catch (e) {
        console.error('CutLab boot restore failed:', e);
      } finally {
        // FIX C: Home may only judge "is there a project to continue?"
        // once the autosave read has settled either way.
        setBootReady(true);
      }
    })();
    // autosave: debounce on project changes (+ a pagehide flush so a fast
    // reload/close inside the debounce window does not lose the last edit)
    let timer: number | undefined;
    let lastJson = JSON.stringify(store.get().project);
    const flush = () => {
      // Nest sessions never autosave: `project` is the nest right now, and
      // persisting it would replace the parent on the next boot. The parent
      // was flushed by openNest before the swap.
      if (store.get().nestSession) return;
      projectStore.saveAutosave(store.get().project).catch(() => undefined);
    };
    window.addEventListener('pagehide', flush);
    const unsub = store.subscribe(() => {
      if (store.get().nestSession) return; // suspended for the whole session
      const json = JSON.stringify(store.get().project);
      if (json === lastJson) return;
      lastJson = json;
      store.set({ saveStatus: 'saving' });
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (store.get().nestSession) { store.set({ saveStatus: 'idle' }); return; }
        projectStore
          .saveAutosave(store.get().project)
          .then(() => store.set({ saveStatus: 'saved', lastSavedAt: Date.now() }))
          .catch(() => store.set({ saveStatus: 'error' }));
      }, 600);
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  // FIX C — Home ⇄ Editor crossings. Opening an EXISTING project
  // leaves the page alone: the app persists ONE last-used page
  // (services/pages, localStorage), so the editor reopens where the
  // user last worked — there is no per-project page record, and none
  // is faked. A BRAND-NEW project always lands on Media (its first
  // job is import).
  const enterEditor = (intent: EditorIntent = {}) => {
    setEditorIntent(intent);
    setView('editor');
    // BACK-NAV FIX: one sentinel entry per editor stay. Already
    // sitting on it (a Forward landing reuses this path's view
    // flip via popstate, not via here) — never stack two.
    if (!onEditorEntry()) window.history.pushState({ cutlabView: 'editor' }, '');
  };
  const goHome = () => {
    if (store.get().nestSession) {
      store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
      return;
    }
    playback.pause();
    // BACK-NAV FIX: when the editor's sentinel entry is current,
    // leave through history so the entry is consumed and the
    // popstate handler performs the flip — the logo and the
    // browser Back button can never disagree about where "back"
    // lands. The sentinel always sits above the app's own load
    // entry, so the pop is guaranteed to fire.
    if (onEditorEntry()) {
      window.history.back();
    } else {
      setView('home');
    }
  };
  const homeOpenProject = async (p: Project): Promise<boolean> => {
    if (!(await adoptProject(p))) return false;
    enterEditor();
    track('project_opened');
    return true;
  };
  const homeOpenFile = async (f: File): Promise<boolean> => {
    try {
      const p = await loadProjectFile(f);
      // A file-loaded project starts a fresh relay slot (TopBar parity).
      void clearRelayProjectSlot();
      return await homeOpenProject(p);
    } catch {
      return false; /* toast already shown by the loader */
    }
  };
  const homeOpenRelay = async (id: string): Promise<boolean> => {
    if (!jobService.loadProjectRemote) return false;
    try {
      const p = await jobService.loadProjectRemote(id);
      if (!p) {
        store.toastMsg('error', 'That relay project no longer exists.');
        return false;
      }
      await setRelayProjectSlot(id, p.name);
      return await homeOpenProject(p);
    } catch (e) {
      store.toastMsg('error', 'Cloud load failed — ' + (e instanceof Error ? e.message : String(e)));
      return false;
    }
  };
  const homeNewProject = (canvas?: keyof typeof CANVAS_PRESETS) => {
    const ok = canvas ? newProjectWithCanvas(canvas) : (newProject(), !store.get().nestSession);
    if (!ok) return;
    setPage('media');
    enterEditor();
    track('project_created');
  };
  // HOME PORT 2026-11-06: the ported New Project dialog creates with
  // an explicit name / canvas / fps spec — same landing as New (the
  // Media page, whose first job is import).
  const homeCreateProject = (spec: { name: string; w: number; h: number; fps: number }) => {
    if (!createProjectCustom(spec)) return;
    setPage('media');
    enterEditor();
    track('project_created');
  };

  // FIX D — Home v2 workspace crossings. Creation intents (prompt bar,
  // captions, replicate, prompt tile) start a NEW project exactly
  // like New does (history pushed, Undo brings the old one back);
  // surface intents (rail pages, Resize, Export) keep the CURRENT
  // project — Resize and Export operate on the work in hand, so they
  // must never wipe it behind a fresh blank.
  const homeEnterPage = (p: PageId) => {
    setPage(p);
    enterEditor();
  };
  const homePromptStart = async (text: string, files: File[]) => {
    if (!createProject()) return;
    if (files.length) await importFiles(files);
    const trimmed = text.trim();
    if (trimmed) requestPromptDraft(trimmed);
    else requestPromptTabOpen();
    setPage('edit');
    enterEditor({ zone: 'inspector' });
    store.toastMsg('info', trimmed
      ? (files.length
        ? 'Media imported — your prompt is waiting in the Prompt tab. Press Run when ready.'
        : 'Your prompt is waiting in the Prompt tab — import media, then press Run.')
      : 'New project created — your media is in the bin.');
    track('project_created');
  };
  const homeQuickCaptions = async (files: File[]) => {
    if (!files.length || !createProject()) return;
    await importFiles(files);
    setPage('edit');
    enterEditor();
    store.toastMsg('info', 'Clip imported. Select it on the timeline, then Inspector → Transcribe → Captions — or park the playhead and use Add caption in the timeline toolbar.');
    track('project_created');
  };
  const homeQuickReplicate = () => {
    if (!createProject()) return;
    enterEditor({ replicate: true });
    track('project_created');
  };
  const homeQuickPrompt = () => {
    if (!createProject()) return;
    requestPromptTabOpen();
    setPage('edit');
    enterEditor({ zone: 'inspector' });
    store.toastMsg('info', 'New project — describe your edit in the Prompt tab. Import media first if it needs clips.');
    track('project_created');
  };
  const homeQuickResize = () => {
    // The canvas fields live on the Inspector's Project card, which
    // shows when nothing is selected — clear the selection so the
    // tile lands exactly on them.
    requestInspectorTabOpen();
    requestProjectSettingsOpen();
    store.set({ selected: null, selectedMany: [] });
    setPage('edit');
    enterEditor({ zone: 'inspector' });
  };

  return (
    <div className={`flex h-full flex-col${phone ? ' narrow' : ''}`}>
      {view === 'home' ? (
        <Home
          ready={bootReady}
          autosaveAt={autosaveAt}
          onContinue={() => enterEditor()}
          onOpenProject={homeOpenProject}
          onOpenFile={homeOpenFile}
          onOpenRelay={homeOpenRelay}
          onNewProject={homeNewProject}
          onCreateProject={homeCreateProject}
          onEnterPage={homeEnterPage}
          onPromptStart={homePromptStart}
          onQuickCaptions={homeQuickCaptions}
          onQuickReplicate={homeQuickReplicate}
          onQuickPrompt={homeQuickPrompt}
          onQuickResize={homeQuickResize}
        />
      ) : (
        <LazySurface
          load={() => import('./components/EditorShell')}
          label="Editor"
          onHome={goHome}
          intent={editorIntent}
        />
      )}
      {toast && (
        <div
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-md px-4 py-2 text-[13px] shadow-xl"
          style={{
            background: toast.kind === 'error' ? '#5a1610' : '#2e2e2e',
            border: '1px solid ' + (toast.kind === 'error' ? '#a3271b' : '#4a4a4a'),
            color: '#f2f2f2',
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
