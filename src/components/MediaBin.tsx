import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import type { MediaItem } from '../types';
import { clipDuration, newId } from '../types';
import { getMediaRuntime, mediaStore, registerMedia, unregisterMedia } from '../services/mediaStore';
import { getProxyStatus, importFiles, kindOfFile, probeFile, subscribeProxyStatus } from '../services/importer';
import { jobService } from '../services/jobsSupabase';
import { importCaptionFile } from '../services/captions';
import { playback } from '../engine/playback';
import { defaultTransitionFields } from '../services/settings';
import { getSelectedMediaId, setSelectedMediaId, subscribeSelectedMedia } from '../services/mediaSelection';
import { getBinView, setBinView, subscribeBinView, type KindFilter, type SortMode } from '../services/binView';
import { setPage } from '../services/pages';

function fmtDur(d?: number) {
  if (d === undefined || !isFinite(d)) return '—';
  return d.toFixed(1) + 's';
}

const ROOT_BIN = 'Media';

/** Add a bin item to the timeline (end of the first matching track).
 *  Shared by the bin cards and the Media page's ItemDetails (§3.17). */
export function addMediaToTimeline(m: MediaItem) {
  const p = store.get().project;
  const kind = m.kind === 'image' ? 'video' : m.kind;
  const track = p.tracks.find((t) => t.kind === kind) ?? p.tracks[0];
  if (!track) return;
  const start = Math.max(0, ...track.clips.map((c) => c.start + clipDuration(c)));
  store.commit((draft) => {
    const tr = draft.tracks.find((t) => t.id === track.id)!;
    const dur = m.duration ?? 5;
    if (kind === 'video') {
      tr.clips.push({
        id: newId('clip'), media: m.id, start, in: 0, out: dur, speed: 1,
        muted: false, volume: 1, ...defaultTransitionFields(),
        transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      });
    } else {
      tr.clips.push({
        id: newId('clip'), media: m.id, start, in: 0, out: dur, speed: 1,
        volume: 1, fadeIn: 0, fadeOut: 0, ...defaultTransitionFields(),
      });
    }
  });
  playback.seek(start);
}

/** R15 honest status (§4.6): silver is the normal-state colour;
 *  amber means missing/relink only; "queued" appears only when the
 *  proxy-status registry actually has the item queued. */
export function mediaStatus(m: MediaItem): { text: string; tone: 'ok' | 'warn' | 'dim' } {
  const rt = getMediaRuntime(m.id);
  if (!rt) return { text: 'media missing — relink or re-import', tone: 'warn' };
  if (rt.proxyUrl) return { text: 'proxy ready', tone: 'ok' };
  if (m.kind === 'video') {
    return getProxyStatus(m.id) === 'queued'
      ? { text: 'original stored · proxy queued', tone: 'dim' }
      : { text: 'original stored · no proxy yet', tone: 'dim' };
  }
  return { text: 'original stored', tone: 'dim' };
}
export default function MediaBin({ mode = 'pool', binFilter = null }: { mode?: 'compact' | 'pool'; binFilter?: string | null }) {
  useEffect(() => {
    const h = () => fileRef.current?.click();
    window.addEventListener('cutlab:import-media', h);
    return () => window.removeEventListener('cutlab:import-media', h);
  }, []);
  const media = useStore((s) => s.project.media);
  const project = useStore((s) => s.project);
  const [dragOver, setDragOver] = useState(false);
  // --- bin organisation / discovery view state (B.8–B.10) — view-only.
  // FIX B2 #11: lifted into services/binView so it survives page
  // switches (this component unmounts on every switch). ---
  const binView = useSyncExternalStore(subscribeBinView, getBinView);
  const { query, kindFilter, sort, view } = binView;
  const setQuery = (v: string) => setBinView({ query: v });
  const setKindFilter = (v: KindFilter) => setBinView({ kindFilter: v });
  const setSort = (v: SortMode) => setBinView({ sort: v });
  const setView = (v: 'cards' | 'list') => setBinView({ view: v });
  const selMediaId = useSyncExternalStore(subscribeSelectedMedia, getSelectedMediaId);
  const [jobsOpen, setJobsOpen] = useState(false);
  const segCls = (on: boolean) =>
    'rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap ' + (on ? 'bg-[#3d3d3d] text-[#ececec]' : 'text-[#a8a8a8] hover:text-[#ececec]');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newBinName, setNewBinName] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const relinkRef = useRef<HTMLInputElement>(null);
  const subsRef = useRef<HTMLInputElement>(null);
  const relinkTarget = useRef<string | null>(null);
  useSyncExternalStore(subscribeProxyStatus, () => {
    let v = 0;
    for (const m of store.get().project.media) {
      const s = getProxyStatus(m.id);
      v += s === 'done' ? 2 : s === 'queued' ? 1 : 0;
    }
    return v;
  });

  useEffect(() => {
    const onDrag = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', onDrag);
    window.addEventListener('drop', onDrag);
    return () => {
      window.removeEventListener('dragover', onDrag);
      window.removeEventListener('drop', onDrag);
    };
  }, []);

  // Usage counts per media id across all tracks (B.13).
  const usage = new Map<string, number>();
  const firstUse = new Map<string, { trackId: string; clipId: string; start: number }>();
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if ('media' in c) {
        usage.set(c.media, (usage.get(c.media) ?? 0) + 1);
        if (!firstUse.has(c.media)) firstUse.set(c.media, { trackId: t.id, clipId: c.id, start: c.start });
      }
    }
  }

  // K.17: record a voiceover at the playhead — browser-native, no server.
  const toggleRecord = async () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        void (async () => {
          const name = `VO ${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}.webm`;
          const file = new File([new Blob(chunks, { type: rec.mimeType || 'audio/webm' })], name, { type: rec.mimeType || 'audio/webm' });
          const atTime = playback.time;
          await importFiles([file]);
          const item = store.get().project.media.find((m) => m.src === name);
          const audioTrack = store.get().project.tracks.find((t) => t.kind === 'audio' && !t.locked);
          if (item && audioTrack) {
            const clipId = newId('clip');
            store.commit((d) => {
              const tr = d.tracks.find((t) => t.id === audioTrack.id)!;
              tr.clips.push({
                id: clipId, media: item.id, start: atTime, in: 0, out: item.duration ?? 0, speed: 1,
                volume: 1, fadeIn: 0, fadeOut: 0, ...defaultTransitionFields(),
              });
              tr.clips.sort((a, b) => a.start - b.start);
            });
            store.set({ selected: { trackId: audioTrack.id, clipId } });
            store.toastMsg('info', 'Voiceover recorded and placed at the playhead.');
          } else {
            store.toastMsg('info', 'Voiceover recorded to the bin (no unlocked audio track to place it on).');
          }
        })();
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch {
      store.toastMsg('error', 'Microphone unavailable — check the browser permission for this site.');
    }
  };

  const addToTimeline = addMediaToTimeline;

  const doRemove = async (m: MediaItem, withClips: boolean) => {
    await mediaStore.remove(m.id);
    unregisterMedia(m.id);
    store.commit((draft) => {
      draft.media = draft.media.filter((x) => x.id !== m.id);
      if (withClips) {
        for (const t of draft.tracks) t.clips = t.clips.filter((c) => !('media' in c && c.media === m.id));
      }
    });
    setConfirmRemove(null);
  };

  const removeMedia = (m: MediaItem) => {
    // B.7: warn before orphaning clips.
    if ((usage.get(m.id) ?? 0) > 0) {
      setConfirmRemove(m.id);
      return;
    }
    void doRemove(m, false);
  };

  const jumpToUse = (m: MediaItem) => {
    const u = firstUse.get(m.id);
    if (!u) return;
    // FIX B2 #10: same behaviour as ItemDetails' "go to first use" —
    // select the clip, seek, AND switch to Edit (the card badge used
    // to do the first two silently, leaving the user on Media).
    store.set({ selected: { trackId: u.trackId, clipId: u.clipId } });
    playback.seek(u.start);
    setPage('edit');
  };

  const renameMedia = async (m: MediaItem) => {
    const name = renameText.trim();
    setRenaming(null);
    if (!name || name === m.src) return;
    if (store.get().project.media.some((x) => x.id !== m.id && x.src === name)) {
      store.toastMsg('error', `Another bin item is already named "${name}".`);
      return;
    }
    const rec = await mediaStore.get(m.id);
    store.commit((draft) => {
      const item = draft.media.find((x) => x.id === m.id);
      if (item) item.src = name;
    });
    if (rec) {
      rec.meta = { ...rec.meta, src: name };
      await mediaStore.put(rec);
      registerMedia(rec);
    }
    store.toastMsg('info', `Renamed to "${name}".`);
  };

  const relinkMedia = async (m: MediaItem, file: File) => {
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
        const item = draft.media.find((x) => x.id === m.id);
        if (item) {
          item.kind = kind;
          item.duration = rec.meta.duration;
          item.width = rec.meta.width;
          item.height = rec.meta.height;
        }
      });
      store.toastMsg('info', `"${m.src}" relinked to the chosen file.`);
    } catch (e) {
      store.toastMsg('error', 'Relink failed — ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const createBin = () => {
    const name = (newBinName ?? '').trim();
    setNewBinName(null);
    if (!name) return;
    store.commit((draft) => {
      const bins = new Set([...(draft.mediaBins ?? []), ...draft.media.map((x) => x.bin ?? ROOT_BIN)]);
      bins.add(name);
      draft.mediaBins = [...bins];
    });
  };

  const moveToBin = (m: MediaItem, bin: string) => {
    store.commit((draft) => {
      const item = draft.media.find((x) => x.id === m.id);
      if (item) item.bin = bin === ROOT_BIN ? undefined : bin;
    });
  };

  // ---- derived, filtered, grouped view ----
  const binNames = [...new Set([...(project.mediaBins ?? []), ...media.map((m) => m.bin ?? ROOT_BIN)])]
    .sort((a, b) => (a === ROOT_BIN ? -1 : b === ROOT_BIN ? 1 : a.localeCompare(b)));
  const visible = media.filter((m) =>
    (kindFilter === 'all' || m.kind === kindFilter) &&
    (query === '' || m.src.toLowerCase().includes(query.toLowerCase())));
  const sorted = [...visible].sort((a, b) =>
    sort === 'name' ? a.src.localeCompare(b.src)
    : sort === 'duration' ? (a.duration ?? 0) - (b.duration ?? 0)
    : 0);
  const groups = binNames
    .map((bin) => ({ bin, items: sorted.filter((m) => (m.bin ?? ROOT_BIN) === bin) }))
    .filter((g) => g.items.length > 0 || (project.mediaBins ?? []).includes(g.bin));

  const statusLine = (m: MediaItem) => {
    const st = mediaStatus(m);
    return (
      <span style={{ color: st.tone === 'warn' ? '#E8C268' : st.tone === 'ok' ? '#C0C0C0' : '#a8a8a8' }}>
        {st.text}
      </span>
    );
  };

  const usedBadge = (m: MediaItem) => {
    const n = usage.get(m.id) ?? 0;
    if (n === 0) return null;
    return (
      <button className="btn small" style={{ padding: '0 6px' }} title="Select the first clip using this file"
        onClick={() => jumpToUse(m)}>
        ×{n} on timeline
      </button>
    );
  };

  const removeBlock = (m: MediaItem) =>
    confirmRemove === m.id ? (
      <div className="mt-2 rounded border border-[#a3271b] bg-[#2c1210] p-2 text-[11px] leading-snug">
        <div className="mb-1.5 text-[#ffb3a7]">
          {usage.get(m.id)} clip(s) on the timeline use this file.
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button className="btn small" onClick={() => void doRemove(m, false)}>Remove, keep clips (they will show as missing)</button>
          <button className="btn small" onClick={() => void doRemove(m, true)}>Remove + delete its clips</button>
          <button className="btn small" onClick={() => setConfirmRemove(null)}>Cancel</button>
        </div>
      </div>
    ) : null;

  return (
    // FIX B2 #7: min-h-0 is load-bearing — without it this aside's
    // flex item refuses to shrink below content height on the phone
    // Bin zone (it painted 1,386 px tall over the PageBar in an
    // 844 px viewport); with it, the list area below scrolls
    // internally and the PageBar stays reachable.
    <aside className="flex min-h-0 w-full min-w-0 flex-1 flex-col border-r border-[#3a3a3a] bg-[#212121]">
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        {/* R16: ONE segmented control — view switch + Record VO +
            Import + Subs; sized so no label clips at 248 px. The
            panel-title text is gone (the control's first segment IS
            the Media panel's switch; F17's duplicate label dies). */}
        <div className="flex items-center rounded-md border border-[#3a3a3a] bg-[#1b1b1b] p-0.5" role="group" aria-label="Bin view and actions">
          <button className={segCls(view === 'cards')} onClick={() => setView('cards')} title="Card view" aria-pressed={view === 'cards'}>▦</button>
          <button className={segCls(view === 'list')} onClick={() => setView('list')} title="List view" aria-pressed={view === 'list'}>☰</button>
          <span className="mx-0.5 h-4 w-px bg-[#3a3a3a]" />
          <button className={segCls(recording)} style={recording ? { color: '#ff6b5e' } : undefined}
            onClick={() => void toggleRecord()}>{recording ? 'Stop ●' : 'Record VO'}</button>
          <button className={segCls(false)} onClick={() => fileRef.current?.click()}>Import</button>
          <button className={segCls(false)} onClick={() => subsRef.current?.click()} title="Import captions (.srt / .vtt / .txt)">Subs</button>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          data-testid="media-file-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            if (files.length) void importFiles(files);
            e.target.value = '';
          }}
        />
        <input
          ref={subsRef}
          type="file"
          accept=".srt,.vtt,.txt"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importCaptionFile(f);
            e.target.value = '';
          }}
        />
        <input
          ref={relinkRef}
          type="file"
          accept="video/*,audio/*,image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            const target = relinkTarget.current;
            relinkTarget.current = null;
            if (f && target) {
              const m = store.get().project.media.find((x) => x.id === target);
              if (m) void relinkMedia(m, f);
            }
            e.target.value = '';
          }}
        />
      </div>
      {mode === 'pool' && (
      <div className="flex items-center gap-1 px-3 pb-2">
        <span className="relative block min-w-0 flex-1">
          <svg aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8f8f8f]" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="6.5" /><path d="m20.5 20.5-4.6-4.6" />
          </svg>
          <input
            className="field w-full"
            style={{ borderRadius: 999, paddingLeft: 28 }}
            placeholder="Search media…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search media"
          />
        </span>
        <select className="field" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as KindFilter)} aria-label="Filter by kind">
          <option value="all">All</option>
          <option value="video">Video</option>
          <option value="audio">Audio</option>
          <option value="image">Image</option>
        </select>
        <select className="field" value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="Sort media">
          <option value="added">Added</option>
          <option value="name">Name</option>
          <option value="duration">Duration</option>
        </select>
      </div>
      )}
      {mode === 'pool' && (
      <div
        className="mx-3 mb-2 rounded-md border border-dashed px-2 py-2 text-center text-[11px] text-[#a8a8a8]"
        style={{ borderColor: dragOver ? '#C0C0C0' : '#3a3a3a', background: dragOver ? '#2a2a2a' : 'transparent' }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = [...e.dataTransfer.files];
          if (files.length) void importFiles(files);
        }}
      >
        Drop video / audio / image files here
      </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {/* FIX B2 #13: a query/filter is active → the no-matches state
            wins, even when the pool is empty (searching an empty bin
            used to claim "Nothing imported yet"). */}
        {(query !== '' || kindFilter !== 'all') && visible.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#3a3a3a] px-3 py-3 text-[12px] text-[#a8a8a8]">No media matches the search/filter.</p>
        ) : media.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#3a3a3a] px-3 py-3 text-[12px] leading-relaxed text-[#a8a8a8]">
            Nothing imported yet — use Import above, or drop files here, to add
            video, audio or images. Your files stay on this device; only the
            copies a server job needs are uploaded when you run one.
          </p>
        ) : visible.length === 0 ? (
          <p className="rounded-md border border-dashed border-[#3a3a3a] px-3 py-3 text-[12px] text-[#a8a8a8]">No media matches the search/filter.</p>
        ) : null}
        {(binFilter ? groups.filter((g) => g.bin === binFilter) : groups).map(({ bin, items }) => (
          <div key={bin} className="mb-2">
            <button
              className="flex w-full items-center gap-1.5 py-1 text-left"
              onClick={() => setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(bin)) next.delete(bin); else next.add(bin);
                return next;
              })}
              aria-expanded={!collapsed.has(bin)}
            >
              <span className="text-[11px] text-[#a8a8a8]">{collapsed.has(bin) ? '›' : '‹'}</span>
              <span className="panel-title">{bin}</span>
              <span className="font-mono text-[11px] text-[#a8a8a8]">{items.length}</span>
            </button>
            {!collapsed.has(bin) && (
              <div className="flex flex-col gap-2">
                {items.map((m) => {
                  const rt = getMediaRuntime(m.id);
                  return view === 'cards' ? (
                    <MediaCard
                      key={m.id}
                      m={m}
                      selected={selMediaId === m.id}
                      rt={rt}
                      status={statusLine(m)}
                      used={usedBadge(m)}
                      confirm={removeBlock(m)}
                      renaming={renaming === m.id}
                      renameText={renameText}
                      binNames={binNames}
                      onAdd={() => addToTimeline(m)}
                      onRemove={() => removeMedia(m)}
                      onStartRename={() => { setRenaming(m.id); setRenameText(m.src); }}
                      onRenameText={setRenameText}
                      onCommitRename={() => void renameMedia(m)}
                      onCancelRename={() => setRenaming(null)}
                      onRelink={() => { relinkTarget.current = m.id; relinkRef.current?.click(); }}
                      onMoveBin={(b) => moveToBin(m, b)}
                    />
                  ) : (
                    // FIX B2 #8: a list row selects exactly like a card
                    // click (it used to be inert — BinViewer/Details
                    // kept showing the previously selected item).
                    <div key={m.id} onClick={() => setSelectedMediaId(m.id)}
                      className={'cursor-pointer rounded-md border bg-[#2a2a2a] px-2 py-1.5 ' + (selMediaId === m.id ? 'border-[#707070]' : 'border-[#3a3a3a]')}>
                      <div className="flex items-center gap-2">
                        {(m.kind === 'video' || m.kind === 'image' || m.kind === 'matte' || m.kind === 'depth') ? (
                          <select className="rounded border border-[#3a3a3a] bg-[#262626] px-0.5 font-mono text-[11px] uppercase text-[#a8a8a8]"
                            title="Media kind — mattes/depth drive clip alpha and depth looks (O.9)"
                            value={m.kind}
                            onChange={(e) => {
                              const kind = e.target.value as MediaItem['kind'];
                              store.commit((d) => {
                                const mm = d.media.find((x) => x.id === m.id);
                                if (mm) mm.kind = kind;
                              });
                            }}>
                            <option value={m.kind === 'image' ? 'image' : 'video'}>{m.kind === 'image' ? 'img' : 'vid'}</option>
                            <option value="matte">matte</option>
                            <option value="depth">depth</option>
                          </select>
                        ) : (
                          <span className="font-mono text-[11px] uppercase text-[#a8a8a8]">{m.kind.slice(0, 3)}</span>
                        )}
                        <span className="line-clamp-2 min-w-0 flex-1 text-[12px] font-medium leading-snug" title={m.src}>{m.src}</span>
                        <span className="font-mono text-[11px] text-[#a8a8a8]">{fmtDur(m.duration)}</span>
                        {usedBadge(m)}
                        <button className="btn small" onClick={() => addToTimeline(m)}>Add</button>
                        <button className="btn small" onClick={() => removeMedia(m)}>Remove</button>
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] text-[#a8a8a8]">
                        {m.width ? `${m.width}×${m.height} · ` : ''}{statusLine(m)}
                      </div>
                      {removeBlock(m)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
        {newBinName === null ? (
          <button className="btn small mt-1" onClick={() => setNewBinName('')}>+ New bin</button>
        ) : (
          <div className="mt-1 flex gap-1">
            <input className="field min-w-0 flex-1" placeholder="Bin name" value={newBinName}
              autoFocus onChange={(e) => setNewBinName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createBin(); if (e.key === 'Escape') setNewBinName(null); }} />
            <button className="btn small" onClick={createBin}>Create</button>
            <button className="btn small" onClick={() => setNewBinName(null)}>Cancel</button>
          </div>
        )}
      </div>
      {mode === 'compact' && (
        <div className="border-t border-[#3a3a3a] px-3 py-2">
          <button className="flex w-full items-center gap-1.5 text-left" aria-expanded={jobsOpen}
            onClick={() => setJobsOpen((v) => !v)}>
            <span className="text-[11px] text-[#a8a8a8]">{jobsOpen ? '‹' : '›'}</span>
            <span className="panel-title">Server jobs</span>
          </button>
          {jobsOpen && <div className="pt-2"><ServerJobs /></div>}
        </div>
      )}
    </aside>
  );
}

function MediaCard({ m, selected, rt, status, used, confirm, renaming, renameText, binNames, onAdd, onRemove, onStartRename, onRenameText, onCommitRename, onCancelRename, onRelink, onMoveBin }: {
  m: MediaItem;
  selected?: boolean;
  rt: ReturnType<typeof getMediaRuntime>;
  status: React.ReactNode;
  used: React.ReactNode;
  confirm: React.ReactNode;
  renaming: boolean;
  renameText: string;
  binNames: string[];
  onAdd: () => void;
  onRemove: () => void;
  onStartRename: () => void;
  onRenameText: (v: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onRelink: () => void;
  onMoveBin: (bin: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubUrl = rt?.proxyUrl ?? rt?.url;
  return (
    <div className={'rounded-md border bg-[#2a2a2a] p-2 ' + (selected ? 'border-[#707070]' : 'border-[#3a3a3a]')} onClick={() => setSelectedMediaId(m.id)}>
      <div className="flex gap-2">
        <div
          className="relative flex h-[54px] w-[72px] shrink-0 items-center justify-center overflow-hidden rounded bg-black"
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onPointerMove={(e) => {
            // Hover-scrub (B.11): pointer x across the thumb = time in the clip.
            const v = videoRef.current;
            if (!v || !m.duration || !isFinite(v.duration)) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            try { v.currentTime = frac * m.duration; } catch { /* metadata not ready */ }
          }}
        >
          {hover && m.kind === 'video' && scrubUrl ? (
            <video ref={videoRef} src={scrubUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
          ) : rt?.thumbUrl ? (
            <img src={rt.thumbUrl} alt="" className="h-full w-full object-cover" />
          ) : m.kind === 'video' && rt?.url ? (
            <LocalThumb id={m.id} url={rt.url} kind={m.kind} />
          ) : m.kind === 'audio' ? (
            <span className="font-mono text-[11px] text-[#a8a8a8]">AUDIO</span>
          ) : (
            <span className="font-mono text-[11px] text-[#a8a8a8]">{m.kind.toUpperCase()}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <span className="flex gap-1">
              <input className="field min-w-0 flex-1" value={renameText} autoFocus
                onChange={(e) => onRenameText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onCommitRename(); if (e.key === 'Escape') onCancelRename(); }} />
              <button className="btn small" onClick={onCommitRename}>Save</button>
            </span>
          ) : (
            <div className="line-clamp-2 text-[12px] font-medium leading-snug" title={m.src}>{m.src}</div>
          )}
          <div className="font-mono text-[11px] text-[#a8a8a8]">
            {m.kind} · {fmtDur(m.duration)}{m.width ? ` · ${m.width}×${m.height}` : ''}
          </div>
          <div className="mt-0.5 text-[11px]">{status}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <button className="btn small" onClick={onAdd}>Add to timeline</button>
        <button className="btn small" onClick={onRemove}>Remove</button>
        {used}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button className="btn small" onClick={onStartRename}>Rename</button>
        <button className="btn small" onClick={onRelink} title="Replace the stored file for this item (keeps its timeline clips)">Relink…</button>
        <select className="field" style={{ padding: '1px 4px', fontSize: 11 }} value={m.bin ?? ROOT_BIN}
          onChange={(e) => onMoveBin(e.target.value)} aria-label="Move to bin" title="Move to bin">
          {binNames.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>
      {confirm}
    </div>
  );
}

/** The SERVER JOBS block (extracted in W6): the Edit rail shows it
 *  inside a disclosure (§3.6); the Media page's sources rail shows
 *  it standing (§2.2). Same actions either way. */
export function ServerJobs() {
  const mediaCount = useStore((s) => s.project.media.length);
  const project = useStore((s) => s.project);
  const [jobBusy, setJobBusy] = useState(false);
  const resultsRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <button
        className="btn small"
        disabled={mediaCount === 0 || jobBusy}
        onClick={async () => {
          setJobBusy(true);
          try {
            const recs = await mediaStore.all();
            await jobService.createMediaJobBundle(project, recs);
          } finally {
            setJobBusy(false);
          }
        }}
      >
        {jobBusy ? 'Server job running…' : 'Run media job on server'}
      </button>
      <button className="btn small" onClick={() => resultsRef.current?.click()}>
        Load server results pack…
      </button>
      <input
        ref={resultsRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        data-testid="results-file-input"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) {
            try {
              await jobService.ingestServerResults(f, store.get().project);
            } catch (err) {
              store.toastMsg('error', 'Could not read that results pack — ' + (err instanceof Error ? err.message : String(err)));
            }
          }
          e.target.value = '';
        }}
      />
      <p className="text-[11px] leading-snug text-[#a8a8a8]">
        The media job runs live on the server relay: originals upload,
        the server makes proxies, thumbnails and waveforms, and they
        attach here automatically — the preview switches to the proxies.
        The results-pack loader stays for packs produced by hand.
      </p>
    </div>
  );
}

/** R14: a local first-frame thumbnail. The runtime URL (OPFS blob)
 *  is drawn once to a canvas and cached as a data URL; the server
 *  thumbUrl wins whenever it exists (the card checks it first). */
const thumbCache = new Map<string, string>();
export function LocalThumb({ id, url, kind }: { id: string; url: string; kind: string }) {
  const [src, setSrc] = useState<string | undefined>(() => thumbCache.get(id));
  useEffect(() => {
    if (thumbCache.has(id)) {
      setSrc(thumbCache.get(id));
      return;
    }
    let dead = false;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    v.addEventListener('loadedmetadata', () => {
      try {
        v.currentTime = Math.min(1, (v.duration || 2) / 4);
      } catch {
        /* metadata race — the label stays */
      }
    });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        const w = 144;
        c.width = w;
        c.height = Math.max(40, Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16)));
        c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
        const data = c.toDataURL('image/jpeg', 0.7);
        thumbCache.set(id, data);
        if (!dead) setSrc(data);
      } catch {
        /* frame not drawable (codec) — the label stays */
      }
      v.removeAttribute('src');
      v.load();
    });
    return () => {
      dead = true;
    };
  }, [id, url]);
  if (src) {
    return <img src={src} alt="" className="h-full w-full object-cover" style={{ animation: 'cl-fade-in .15s ease both' }} />;
  }
  return <span className="font-mono text-[11px] text-[#a8a8a8]">{kind.toUpperCase()}</span>;
}
