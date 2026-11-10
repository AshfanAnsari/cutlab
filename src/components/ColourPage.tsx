import { useEffect, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import { findClip } from '../state/actions';
import { DEFAULT_GRADE, gradeLayersOf } from '../services/grade';
import type { Grade, VideoClip } from '../types';
import { getGallery, initGallery, removeGalleryStill, requestCompare, subscribeGallery } from '../services/gallery';
import { scopesDockOpen, setScopesDock } from '../services/scopesDock';
import Preview from './Preview';
import ZoneTabs from './ZoneTabs';
import { useNarrow } from '../services/useNarrow';
import { useState } from 'react';
import { ColourDeck, GradeStackEditor } from './ColorPanel';

/**
 * GalleryStrip (§3.18): the hero frame pinned first with its label,
 * then grabbed stills in grab order. Clicking a still loads it
 * into the viewer's Compare wipe; × removes it from the strip
 * (stored project data is untouched — stills are view state).
 */
function GalleryStrip() {
  const gallery = useSyncExternalStore(subscribeGallery, getGallery);
  useEffect(() => {
    void initGallery();
  }, []);
  const thumb = 'group relative shrink-0 overflow-hidden rounded border border-[#3a3a3a]';
  return (
    <div className="flex items-center gap-2 overflow-x-auto px-3 py-2" aria-label="Still gallery">
      <span className="panel-title shrink-0 pr-1">Gallery</span>
      {gallery.hero && (
        <button className={thumb} title="Hero frame — load into Compare" onClick={() => requestCompare(gallery.hero!)}>
          <img src={gallery.hero} alt="Hero frame" className="h-[64px] w-[112px] object-cover" style={{ animation: 'cl-fade-in .15s ease both' }} />
          <span className="absolute bottom-0 left-0 bg-black/70 px-1 text-[11px] text-[#e8c268]">hero</span>
        </button>
      )}
      {gallery.stills.map((url, i) => (
        <span key={i} className={thumb}>
          <button title="Load into Compare" onClick={() => requestCompare(url)}>
            <img src={url} alt={`Still ${i + 1}`} className="h-[64px] w-[112px] object-cover" style={{ animation: 'cl-fade-in .15s ease both' }} />
          </button>
          <button className="absolute right-0 top-0 bg-black/70 px-1 text-[11px] text-white opacity-0 group-hover:opacity-100"
            title="Remove from the strip" aria-label={`Remove still ${i + 1}`}
            onClick={() => removeGalleryStill(i)}>×</button>
        </span>
      ))}
      {!gallery.hero && gallery.stills.length === 0 && (
        <span className="text-[11px] text-[#a8a8a8]">Grab a still from the viewer to start a gallery.</span>
      )}
    </div>
  );
}

/**
 * Colour page (§2.4): gallery over the viewer (scopes dock open by
 * default on this page only), the qualifier + grade-stack column
 * at 300 px, and the project look's control sections as a bottom
 * deck of columns. The stack column edits the selected clip's
 * grade stack (or the project look when nothing is selected).
 */
export default function ColourPage() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const phone = useNarrow();
  const [zone, setZone] = useState('viewer');

  // Per-page dock default (§3.15): open here; the user's own
  // preference is restored when leaving the page.
  useEffect(() => {
    const prev = scopesDockOpen();
    setScopesDock(true);
    return () => setScopesDock(prev);
  }, []);

  const [clearArm, setClearArm] = useState(false);
  const found = selected ? findClip(project, selected.trackId, selected.clipId) : { track: undefined, clip: undefined };
  const clip = found.clip as VideoClip | undefined;
  const stackLayers: Grade[] = clip ? gradeLayersOf(clip) : [project.look ?? DEFAULT_GRADE];
  const stackClipId = clip?.id;
  const onStackLayers = (next: Grade[], history = true) => {
    if (clip && selected) {
      store.commit((d) => {
        const t = d.tracks.find((x) => x.id === selected.trackId);
        const c = t?.clips.find((x) => x.id === clip.id) as VideoClip | undefined;
        if (c) {
          c.grades = next;
          delete c.grade;
        }
      }, { history });
    } else {
      // FIX B2 #2/#3: the project look is ONE grade in the data model
      // (Project.look), not a stack. An empty next[] here used to wipe
      // it silently (d.look = undefined with no trace); empty is now
      // refused at this boundary — clearing goes through the explicit
      // Clear button below, with history, so Undo restores the look.
      if (next.length === 0) {
        store.toastMsg('info', 'The project look stays until you clear it with “Clear project look” below.');
        return;
      }
      store.commit((d) => {
        d.look = next[0];
      }, { history });
    }
  };
  const clearLook = () => {
    store.commit((d) => { d.look = undefined; }, { history: true, label: 'Clear project look' });
    setClearArm(false);
    store.toastMsg('info', 'Project look cleared. (Undo brings it back.)');
  };
  const patchLook = (fn: (g: Grade) => void, history = true) =>
    store.commit((d) => {
      if (!d.look) d.look = JSON.parse(JSON.stringify(DEFAULT_GRADE)) as Grade;
      fn(d.look);
    }, { history });

  const viewerCol = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-[#3a3a3a] bg-[#1b1b1b]">
        <GalleryStrip />
      </div>
      <Preview />
    </div>
  );
  const stackCol = (
    <div className="flex w-full flex-col px-3 py-3">
      <div className="panel-title pb-2">
        {clip ? 'Grade stack — selected clip' : 'Grade stack — project look'}
      </div>
      <GradeStackEditor layers={stackLayers} clipId={stackClipId} onLayers={onStackLayers} singleLook={!clip} />
      {!clip && project.look && (
        clearArm ? (
          <div className="mt-3 flex items-center gap-1.5">
            <span className="text-[11px] leading-snug text-[#ffb3a7]">Clear the whole project look?</span>
            <button className="btn small" onClick={clearLook}>Clear it</button>
            <button className="btn small" onClick={() => setClearArm(false)}>Keep</button>
          </div>
        ) : (
          <button className="btn small mt-3 self-start" onClick={() => setClearArm(true)}
            title="Remove the project look entirely (Undo restores it)">Clear project look</button>
        )
      )}
    </div>
  );
  const deck = (
    <>
      <div className="flex items-center gap-2 border-b border-[#2c2c2c] px-3 py-1.5">
        <span className="panel-title">Project look — deck</span>
        <span className="text-[11px] text-[#a8a8a8]">applies over every clip, last in the chain</span>
      </div>
      <div className="min-h-0 flex-1">
        <ColourDeck grade={project.look ?? DEFAULT_GRADE} onPatch={patchLook} />
      </div>
    </>
  );

  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ZoneTabs label="Colour zones" active={zone} onChange={setZone} zones={[
          { id: 'viewer', label: 'Viewer' }, { id: 'stack', label: 'Stack' }, { id: 'deck', label: 'Deck' },
        ]} />
        {zone === 'viewer' && viewerCol}
        {zone === 'stack' && <div className="min-h-0 flex-1 overflow-y-auto bg-[#212121]">{stackCol}</div>}
        {zone === 'deck' && <div className="flex min-h-0 flex-1 flex-col">{deck}</div>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {viewerCol}
        <div className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-[#3a3a3a] bg-[#212121]">
          {stackCol}
        </div>
      </div>
      {/* FIX B2 #6: the deck gives space back to the stage (38% → 34%
          of the page column); its columns scroll with a visible
          scrollbar affordance (.deck-col in index.css). */}
      <div className="flex shrink-0 flex-col border-t border-[#3a3a3a]" style={{ height: '34%' }}>
        {deck}
      </div>
    </div>
  );
}
