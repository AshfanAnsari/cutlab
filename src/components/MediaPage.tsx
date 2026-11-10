import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import type { MediaItem } from '../types';
import { getMediaRuntime, mediaStore, registerMedia, unregisterMedia } from '../services/mediaStore';
import { kindOfFile, probeFile } from '../services/importer';
import { getSelectedMediaId, subscribeSelectedMedia } from '../services/mediaSelection';
import { listLibrary, entryProject, type LibraryEntry } from '../services/projectLibrary';
import { bindProjectMedia } from '../services/projectLifecycle';
import { setPage } from '../services/pages';
import { playback } from '../engine/playback';
import CollapsiblePanel from './CollapsiblePanel';
import ZoneTabs from './ZoneTabs';
import { useNarrow } from '../services/useNarrow';
import MediaBin, { ServerJobs, addMediaToTimeline, mediaStatus } from './MediaBin';
import BinViewer from './BinViewer';

const ROOT_BIN = 'Media';

function fmtBytes(n?: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Media page (UI redesign §2.2): sources rail left (bins, this
 * browser's local library, server jobs, import), BinViewer over
 * the pool in the centre, ItemDetails right. The pool is the same
 * MediaBin component the Edit rail mounts in compact mode.
 */
export default function MediaPage() {
  const project = useStore((s) => s.project);
  const media = project.media;
  const [binSel, setBinSel] = useState<string | null>(null);
  const phone = useNarrow();
  const [zone, setZone] = useState('pool');
  const [lib, setLib] = useState<LibraryEntry[] | null>(null);
  useEffect(() => {
    void listLibrary().then(setLib).catch(() => setLib([]));
  }, []);

  const binNames = [...new Set([...(project.mediaBins ?? []), ...media.map((m) => m.bin ?? ROOT_BIN)])]
    .sort((a, b) => (a === ROOT_BIN ? -1 : b === ROOT_BIN ? 1 : a.localeCompare(b)));
  const countOf = (bin: string) => media.filter((m) => (m.bin ?? ROOT_BIN) === bin).length;

  const loadLib = async (e: LibraryEntry) => {
    const p = entryProject(e, 'current');
    if (!p) return;
    await bindProjectMedia(p);
    // FIX B1 #2: loading a project records history, like every other
    // Open path — Undo brings the previous project back.
    store.replaceProject(p, { history: true, label: 'Open project' });
    store.toastMsg('info', `Loaded "${e.name}" from this browser's library.`);
  };

  const sources = (
        <aside className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto border-r border-[#3a3a3a] bg-[#212121]">
          <div className="px-3 pb-1 pt-3">
            <div className="panel-title pb-1.5">Bins</div>
            <div className="flex flex-col gap-1">
              <button className={'btn small justify-start ' + (binSel === null ? 'bg-[#333]' : '')}
                aria-pressed={binSel === null} onClick={() => setBinSel(null)}>
                All bins <span className="ml-auto font-mono text-[11px] text-[#a8a8a8]">{media.length}</span>
              </button>
              {binNames.map((b) => (
                <button key={b} className={'btn small justify-start ' + (binSel === b ? 'bg-[#333]' : '')}
                  aria-pressed={binSel === b} onClick={() => setBinSel(b)}>
                  <span className="truncate">{b}</span>
                  <span className="ml-auto font-mono text-[11px] text-[#a8a8a8]">{countOf(b)}</span>
                </button>
              ))}
            </div>
            <button className="btn small mt-2 w-full justify-center"
              onClick={() => window.dispatchEvent(new Event('cutlab:import-media'))}>
              Import files (Ctrl+I)
            </button>
          </div>
          <div className="px-3 pb-1 pt-3">
            <div className="panel-title pb-1.5">This browser — local library</div>
            {lib === null && <p className="text-[12px] text-[#a8a8a8]">Listing…</p>}
            {lib !== null && lib.length === 0 && (
              <p className="text-[12px] leading-snug text-[#a8a8a8]">
                No saved projects yet — File → “Save copy to local library” puts the current project here.
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              {(lib ?? []).map((e) => (
                <div key={e.id} className="rounded-md border border-[#3a3a3a] bg-[#262626] px-2.5 py-2">
                  <div className="truncate text-[12px] font-medium" title={e.name}>{e.name}</div>
                  <div className="pb-1.5 font-mono text-[11px] text-[#a8a8a8]">{new Date(e.savedAt).toLocaleDateString()}</div>
                  <button className="btn small" onClick={() => void loadLib(e)}>Load</button>
                </div>
              ))}
            </div>
          </div>
          <div className="mt-auto border-t border-[#3a3a3a] px-3 py-2.5">
            <div className="panel-title pb-1.5">Server jobs</div>
            <ServerJobs />
          </div>
        </aside>
  );
  const centre = (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-[#3a3a3a]" style={{ height: '40%', minHeight: 200 }}>
          <BinViewer />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <MediaBin mode="pool" binFilter={binSel} />
        </div>
      </div>
  );

  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ZoneTabs label="Media zones" active={zone} onChange={setZone} zones={[
          { id: 'sources', label: 'Sources' }, { id: 'pool', label: 'Bin' }, { id: 'details', label: 'Details' },
        ]} />
        {zone === 'sources' && <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{sources}</div>}
        {zone === 'pool' && centre}
        {zone === 'details' && <div className="flex min-h-0 flex-1 flex-col overflow-y-auto"><ItemDetails /></div>}
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <CollapsiblePanel side="left" panelWidth={248} storageKey="cutlab.panel.mediapage" label="Sources">
        {sources}
      </CollapsiblePanel>
      {centre}
      <CollapsiblePanel side="right" panelWidth={264} storageKey="cutlab.panel.itemdetails" label="Details">
        <ItemDetails />
      </CollapsiblePanel>
    </div>
  );
}

/** ItemDetails (§3.17): the selected item's metadata + actions. */
function ItemDetails() {
  const project = useStore((s) => s.project);
  const selId = useSyncExternalStore(subscribeSelectedMedia, getSelectedMediaId);
  const item = project.media.find((m) => m.id === selId) ?? project.media[0];
  const [size, setSize] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [renameText, setRenameText] = useState<string | null>(null);
  const relinkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let dead = false;
    setSize(null);
    setConfirm(false);
    setRenameText(null);
    if (item) {
      void mediaStore.get(item.id).then((r) => {
        if (!dead) setSize(r?.blob?.size ?? null);
      });
    }
    return () => {
      dead = true;
    };
  }, [item?.id]);

  if (!item) {
    return (
      <aside className="flex w-full min-w-0 flex-1 flex-col border-l border-[#3a3a3a] bg-[#212121] px-3 py-3">
        <div className="panel-title pb-2">Item details</div>
        <p className="text-[12px] leading-snug text-[#a8a8a8]">Import media to see an item's details here.</p>
      </aside>
    );
  }
  const m: MediaItem = item;
  const st = mediaStatus(m);
  const rt = getMediaRuntime(m.id);
  let uses = 0;
  let firstUse: { trackId: string; clipId: string; start: number } | null = null;
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if ('media' in c && c.media === m.id) {
        uses++;
        if (!firstUse) firstUse = { trackId: t.id, clipId: c.id, start: c.start };
      }
    }
  }
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] uppercase tracking-wide text-[#a8a8a8]">{label}</span>
      <span className="min-w-0 text-right text-[12px] text-[#ececec]">{value}</span>
    </div>
  );

  const doRemove = async (withClips: boolean) => {
    await mediaStore.remove(m.id);
    unregisterMedia(m.id);
    store.commit((draft) => {
      draft.media = draft.media.filter((x) => x.id !== m.id);
      if (withClips) {
        for (const t of draft.tracks) t.clips = t.clips.filter((c) => !('media' in c && c.media === m.id));
      }
    });
    setConfirm(false);
  };

  const commitRename = async () => {
    const name = (renameText ?? '').trim();
    setRenameText(null);
    if (!name || name === m.src) return;
    if (store.get().project.media.some((x) => x.id !== m.id && x.src === name)) {
      store.toastMsg('error', `Another bin item is already named "${name}".`);
      return;
    }
    const rec = await mediaStore.get(m.id);
    store.commit((draft) => {
      const it = draft.media.find((x) => x.id === m.id);
      if (it) it.src = name;
    });
    if (rec) {
      rec.meta = { ...rec.meta, src: name };
      await mediaStore.put(rec);
      registerMedia(rec);
    }
    store.toastMsg('info', `Renamed to "${name}".`);
  };

  const relink = async (file: File) => {
    const kind = kindOfFile(file);
    if (!kind) {
      store.toastMsg('error', `"${file.name}" is not a video, audio or image file.`);
      return;
    }
    try {
      const meta = await probeFile(file, kind);
      const existing = await mediaStore.get(m.id);
      const rec = existing ?? { meta: { ...m }, blob: file };
      rec.blob = file;
      rec.remoteOriginal = undefined;
      rec.meta = { ...rec.meta, id: m.id, src: m.src, kind, duration: meta.duration ?? rec.meta.duration, width: meta.width ?? rec.meta.width, height: meta.height ?? rec.meta.height };
      await mediaStore.put(rec);
      registerMedia(rec);
      store.commit((draft) => {
        const it = draft.media.find((x) => x.id === m.id);
        if (it) {
          it.kind = kind;
          it.duration = rec.meta.duration;
          it.width = rec.meta.width;
          it.height = rec.meta.height;
        }
      });
      store.toastMsg('info', `"${m.src}" relinked to the chosen file.`);
    } catch (e) {
      store.toastMsg('error', 'Relink failed — ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <aside className="flex w-full min-w-0 flex-1 flex-col overflow-y-auto border-l border-[#3a3a3a] bg-[#212121] px-3 py-3">
      <div className="panel-title pb-1">Item details</div>
      {renameText !== null ? (
        <span className="flex gap-1 pb-1">
          <input className="field min-w-0 flex-1" value={renameText} autoFocus aria-label="Rename item"
            onChange={(e) => setRenameText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(); if (e.key === 'Escape') setRenameText(null); }} />
          <button className="btn small" onClick={() => void commitRename()}>Save</button>
        </span>
      ) : (
        <div className="line-clamp-2 pb-1 text-[13px] font-medium leading-snug" title={m.src}>{m.src}</div>
      )}
      <div className="divide-y divide-[#2c2c2c] border-y border-[#2c2c2c]">
        {row('Kind', m.kind)}
        {row('Dimensions', m.width ? `${m.width} × ${m.height}` : '—')}
        {row('Duration', m.duration ? `${m.duration.toFixed(1)}s` : '—')}
        {row('Size', fmtBytes(size))}
        {row('Bin', m.bin ?? ROOT_BIN)}
        {row('Status', <span style={{ color: st.tone === 'warn' ? '#E8C268' : '#C0C0C0' }}>{st.text}</span>)}
        {row('Runtime', rt ? (rt.proxyUrl ? 'proxy bound' : 'original bound') : 'not in this browser')}
      </div>
      <div className="flex flex-col gap-1.5 pt-3">
        <button className="btn justify-center" onClick={() => addMediaToTimeline(m)}>Add to timeline</button>
        {uses > 0 && firstUse && (
          <button className="btn justify-center" title="Select the first clip using this file and switch to Edit"
            onClick={() => {
              store.set({ selected: { trackId: firstUse!.trackId, clipId: firstUse!.clipId } });
              playback.seek(firstUse!.start);
              setPage('edit');
            }}>
            ×{uses} on timeline — go to first use
          </button>
        )}
        <div className="flex gap-1.5">
          <button className="btn flex-1 justify-center" onClick={() => setRenameText(m.src)}>Rename</button>
          <button className="btn flex-1 justify-center" onClick={() => relinkRef.current?.click()}>Relink…</button>
          <button className="btn flex-1 justify-center" onClick={() => (uses > 0 ? setConfirm(true) : void doRemove(false))}>Remove</button>
        </div>
        <input ref={relinkRef} type="file" accept="video/*,audio/*,image/*" className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void relink(f);
            e.target.value = '';
          }} />
        {confirm && (
          <div className="rounded border border-[#a3271b] bg-[#2c1210] p-2 text-[11px] leading-snug">
            <div className="mb-1.5 text-[#ffb3a7]">{uses} clip(s) on the timeline use this file.</div>
            <div className="flex flex-col gap-1.5">
              <button className="btn small" onClick={() => void doRemove(false)}>Remove, keep clips (they will show as missing)</button>
              <button className="btn small" onClick={() => void doRemove(true)}>Remove + delete its clips</button>
              <button className="btn small" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
