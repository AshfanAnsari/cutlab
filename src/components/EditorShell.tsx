/**
 * EditorShell — the whole editor view (TopBar, the five pages,
 * PageBar, the Export / Replicate overlays), extracted from App.tsx
 * for the P8 lazy split (2026-11-06). App lazy-loads this module the
 * first time the user leaves Home, so a cold open downloads only the
 * shell + Home.
 *
 * Inside the shell, the Edit page is the default page (§ pages.ts)
 * and ships with the shell; Media / Colour / Audio / Deliver and the
 * two overlays load on demand through LazySurface — first visit to a
 * page shows its loading state, later visits are instant (module
 * cache). Behaviour is unchanged: pages remain layouts over the one
 * store, and every state flow below is App's original, moved.
 *
 * Entry intent: Home's creation crossings run BEFORE the view flips,
 * so the two things they used to set on App state — the phone zone
 * and "open Replicate on arrival" — arrive as props and seed the
 * shell's state on mount (the shell remounts on every entry).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import { dispatchShortcut } from '../services/shortcuts';
import { subscribeViewerFocus, setViewerFocus, viewerFocus } from '../services/layout';
import { scopesDockOpen, subscribeScopesDock } from '../services/scopesDock';
import { getPage, subscribePage } from '../services/pages';
import { useNarrow } from '../services/useNarrow';
import TopBar from './TopBar';
import PageBar from './PageBar';
import EditPage from './EditPage';
import ViewerStack, { TIMELINE_DEFAULT_DELIVER } from './ViewerStack';
import LazySurface from './LazySurface';

export type EditorIntent = { zone?: string; replicate?: boolean };

export default function EditorShell({ onHome, intent }: {
  onHome: () => void;
  intent: EditorIntent;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const phone = useNarrow();
  const [zone, setZone] = useState(intent.zone ?? 'stage');
  const [replicateOpen, setReplicateOpen] = useState(intent.replicate ?? false);
  const [focus, setFocus] = useState<boolean>(() => viewerFocus());
  const [dockOpen, setDockOpen] = useState<boolean>(() => scopesDockOpen());
  const page = useSyncExternalStore(subscribePage, getPage);
  const nestSession = useStore((s) => s.nestSession);

  useEffect(() => subscribeViewerFocus((f) => setFocus(f)), []);
  useEffect(() => subscribeScopesDock((o) => setDockOpen(o)), []);

  useEffect(() => {
    // All bindings live in the shortcut registry (services/shortcuts.ts) —
    // the same list the Inspector renders and the user can remap (T.10).
    // The shell only mounts in the editor view, so Home never sees
    // these (FIX C: a stray Space/S on the front door must not edit an
    // unseen project).
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
      if (typing) return;
      if (dispatchShortcut(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Page system (§2): pages are layouts over the one store. A nest
  // session pins the app to Edit (§2.7); focus mode exists on Edit
  // only and never writes persisted keys (as today).
  const effPage = nestSession ? 'edit' : page;
  const focusPin = focus && effPage === 'edit';

  return (
    <>
      <TopBar onHome={onHome} onReplicate={() => {
        if (store.get().nestSession) {
          store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
          return;
        }
        setReplicateOpen(true);
      }} onExport={() => {
        if (store.get().nestSession) {
          store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
          return;
        }
        setExportOpen(true);
      }} />
      {effPage === 'edit' && (
        <EditPage phone={phone} focusPin={focusPin} dockOpen={dockOpen}
          onSplitExitFocus={() => setViewerFocus(false)} zone={zone} onZoneChange={setZone} />
      )}
      {effPage === 'media' && (
        <LazySurface load={() => import('./MediaPage')} label="Media page" />
      )}
      {effPage === 'colour' && (
        <LazySurface load={() => import('./ColourPage')} label="Colour page" />
      )}
      {effPage === 'audio' && (
        <LazySurface load={() => import('./AudioPage')} label="Audio page" />
      )}
      {effPage === 'deliver' && (
        <LazySurface load={() => import('./DeliverPage')} label="Deliver page"
          viewer={<ViewerStack splitKey="cutlab.timelineH.deliver" defaultH={TIMELINE_DEFAULT_DELIVER} focusPin={false} dockOpen={false} onSplitExitFocus={() => undefined} />} />
      )}
      <PageBar />
      {exportOpen && (
        <LazySurface variant="overlay" load={() => import('./ExportPanel')} label="Export"
          onClose={() => setExportOpen(false)} />
      )}
      {replicateOpen && (
        <LazySurface variant="overlay" load={() => import('./ReplicateView')} label="Replicate"
          onClose={() => setReplicateOpen(false)} />
      )}
    </>
  );
}
