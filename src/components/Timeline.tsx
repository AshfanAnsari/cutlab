import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import { angleFlash } from '../services/angleFlash';
import { getSepStatus, subscribeSepStatus } from '../services/sepJobs';
import type { Clip, Project, TextClip, Track, VideoClip } from '../types';
import { clipDuration, newId, projectDuration } from '../types';
import { getMediaRuntime } from '../services/mediaStore';
import { playback } from '../engine/playback';
import { clamp, qFrame } from '../utils/time';
import { splitClipAt, addAdjustmentClip, addMarkerAtPlayhead, clearRange, closeNest, copySelected, deleteMany, deleteSelected, duplicateSelected, extractAudioSelected, generateBeatMarkers, makeCompoundFromSelection, makeMulticamFromSelection, openNest, pasteAttributes, rejoinSelected, rippleDeleteSelected, setRangeInAtPlayhead, setRangeOutAtPlayhead, splitAtPlayhead, uncompoundSelected, unlinkSelected, type PasteAttrGroups } from '../state/actions';
import { defaultTransitionFields, loadSettings } from '../services/settings';
import { addCaptionAtPlayhead } from '../services/captions';
import Switch from './Switch';
import CheckboxRow from './CheckboxRow';

/** Paste-attributes groups, glossed for the checklist rows. */
const ATTR_GROUP_DESCS: Record<keyof PasteAttrGroups, string> = {
  grade: 'Colour grade, wheels and LUT',
  transform: 'Position, scale and rotation',
  keyframes: 'Keyframe tracks and easing',
  effects: 'The effects stack',
  mask: 'Mask shape and feather',
  transition: 'Transition in and its duration',
  volume: 'Volume, mute and fades',
  textStyle: 'Font, size, colour and animation',
};

// UI redesign W5 (§3.8): the header column widens 112 -> 200. The
// plan's two-row header (name + four >=20px flag buttons + bus at
// full width) is geometrically impossible at 112 px — the plan was
// written against the audit's 248 px mis-measurement of this column
// (F13); 200 px is the smallest width where nothing truncates.
const LABEL_W = 200;
// TIMELINE SECTION 2026-11-06: every lane sits in the 36–44 px band —
// video/audio were 46 (over) and text 30 (cramped: its header row had
// to share 30 px with the resize handle). 44/44/40 gives each header
// two legible rows (name + flags, bus + volume) at real hit sizes.
const LANE_H: Record<Track['kind'], number> = { video: 44, audio: 44, text: 40 };
export const laneH = (t: Track) => t.height ?? LANE_H[t.kind];

// Audio-focus view state (§3.8, Audio page): video/text lanes
// collapse to 12 px reference rows; audio lanes keep full height.
// View state only — set by the Timeline while it is mounted with
// audioFocus, so leaving the page restores Edit heights exactly.
let audioFocusRows = false;
export const laneHView = (t: Track) => (audioFocusRows && t.kind !== 'audio' ? 12 : laneH(t));
const TRACK_COLORS: (string | undefined)[] = [undefined, '#E31000', '#E8C268', '#7DC98A', '#7DA8C9', '#C0C0C0'];

interface DragState {
  mode: 'move' | 'trimL' | 'trimR' | 'slip' | 'slide';
  hoverTrackId?: string;
  shiftHeld?: boolean;
  trackId: string;
  clipId: string;
  startX: number;
  orig: { start: number; in: number; out: number; dur: number };
  moved: boolean;
  snapshotted: boolean;
}

export default function Timeline({ audioFocus = false }: { audioFocus?: boolean }) {
  audioFocusRows = audioFocus;
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const selectedMany = useStore((s) => s.selectedMany);
  const nestSession = useStore((s) => s.nestSession);
  const clipboard = useStore((s) => s.clipboard);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; trackId: string; clipId: string } | null>(null);
  const [attrsOpen, setAttrsOpen] = useState(false);
  const [attrGroups, setAttrGroups] = useState<PasteAttrGroups>({ grade: true, transform: true, keyframes: true, effects: true, mask: true, transition: true, volume: true, textStyle: true });
  const pxPerSec = useStore((s) => s.pxPerSec);
  const [time, setTime] = useState(0);
  const [snapOn, setSnapOn] = useState<boolean>(() => loadSettings().snapDefault);
  const [bpm, setBpm] = useState(120);
  const [beatOffset, setBeatOffset] = useState(0);
  // TIMELINE SECTION 2026-11-06: Beats & markers is a collapsible
  // cluster — collapsed hides BPM / offset / Beats (the wide inputs)
  // so they stop eating permanent toolbar width; Marker stays.
  // Persisted like the app's other view prefs (cutlab.* keys).
  const [beatsCollapsed, setBeatsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('cutlab.timeline.beatsCollapsed') === '1'; } catch { return false; }
  });
  const toggleBeats = () => setBeatsCollapsed((v) => {
    const n = !v;
    try { localStorage.setItem('cutlab.timeline.beatsCollapsed', n ? '1' : '0'); } catch { /* session-only */ }
    return n;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const seekRef = useRef(false);
  const snapHitRef = useRef<number | null>(null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  const [follow, setFollow] = useState(false);
  const bladeMode = useStore((s) => s.bladeMode);
  const [markerEdit, setMarkerEdit] = useState<number | null>(null);
  const [renamingTrack, setRenamingTrack] = useState<string | null>(null);
  const [renameTrackText, setRenameTrackText] = useState('');
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [markerDraft, setMarkerDraft] = useState<{ label: string; color: string; dur: string }>({ label: '', color: '', dur: '' });

  useEffect(() => playback.onFrame(setTime), []);

  const fps = project.canvas.fps;
  const dur = Math.max(projectDuration(project), time, 10);
  const contentW = Math.ceil((dur + 8) * pxPerSec);

  const snapPoints = useMemo(() => {
    const pts: number[] = [time];
    if (project.rangeIn != null) pts.push(project.rangeIn);
    if (project.rangeOut != null) pts.push(project.rangeOut);
    for (const m of project.markers) pts.push(m.t);
    for (const t of project.tracks) for (const c of t.clips) {
      pts.push(c.start, c.start + clipDuration(c));
    }
    return pts;
  }, [project, time]);

  const snap = (t: number, extra: number[] = []) => {
    snapHitRef.current = null;
    if (!snapOn) return t;
    const thresh = 9 / pxPerSec;
    let best = t;
    let bestD = thresh;
    for (const p of [...snapPoints, ...extra]) {
      const d = Math.abs(p - t);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (best !== t) snapHitRef.current = best;
    return best;
  };

  const xToTime = (clientX: number) => {
    const rect = contentRef.current!.getBoundingClientRect();
    return clamp((clientX - rect.left - LABEL_W) / pxPerSec, 0, dur + 8);
  };

  // ---------- clip dragging ----------
  const onClipPointerDown = (e: React.PointerEvent, track: Track, clip: Clip, mode: DragState['mode']) => {
    e.stopPropagation();
    // T.5 blade tool: with blade mode on, a click splits the clip there.
    if (store.get().bladeMode && mode === 'move' && !track.locked) {
      const t = xToTime(e.clientX);
      if (t > clip.start + 0.02 && t < clip.start + clipDuration(clip) - 0.02) {
        splitClipAt(track.id, clip.id, t);
        store.set({ selected: { trackId: track.id, clipId: clip.id } });
      }
      return;
    }
    store.set({ selected: { trackId: track.id, clipId: clip.id } });
    if (clip.groupId) {
      // K.8: linked pairs select together until unlinked.
      const members: { trackId: string; clipId: string }[] = [];
      for (const tr of store.get().project.tracks) {
        for (const c of tr.clips) if (c.groupId === clip.groupId) members.push({ trackId: tr.id, clipId: c.id });
      }
      if (members.length > 1) store.set({ selectedMany: members });
    }
    if (track.locked) return; // E.6: locked tracks ignore drags/trims
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const isText = 'dur' in clip;
    // F.9/F.10/F.14: Alt+drag = slip, Shift+drag = slide, Shift+click = multi-select toggle.
    const effMode: DragState['mode'] = mode === 'move' && e.altKey && !isText ? 'slip'
      : mode === 'move' && e.shiftKey ? 'slide' : mode;
    dragRef.current = {
      mode: effMode, trackId: track.id, clipId: clip.id, startX: e.clientX, moved: false, snapshotted: false,
      shiftHeld: e.shiftKey,
      orig: {
        start: clip.start,
        in: isText ? 0 : (clip as VideoClip).in,
        out: isText ? 0 : (clip as VideoClip).out,
        dur: clipDuration(clip),
      },
    };
  };

  const onClipPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / pxPerSec;
    if (Math.abs(e.clientX - d.startX) > 2) d.moved = true;
    if (!d.moved) return;
    if (!d.snapshotted) {
      // first real movement: snapshot the pre-drag project for undo
      store.commit(() => undefined, { history: true });
      d.snapshotted = true;
    }
    if ((d.mode === 'move' || d.mode === 'slide') && contentRef.current) {
      // F.2: which lane is the pointer over? (same-kind drop retargets on release)
      const rect = contentRef.current.getBoundingClientRect();
      const y = e.clientY - rect.top - 24;
      let acc = 0;
      const tracksNow = store.get().project.tracks;
      for (const tr of tracksNow) {
        const h = laneHView(tr) + 1;
        if (y >= acc && y < acc + h) { d.hoverTrackId = tr.id; break; }
        acc += h;
      }
    }
    setSnapGuide(snapHitRef.current);
    const p = store.get().project;
    const media = p.media.find((m) => m.id === (p.tracks.find((t) => t.id === d.trackId)?.clips.find((c) => c.id === d.clipId) as VideoClip | undefined)?.media);
    store.commit((draft) => {
      const tr = draft.tracks.find((t) => t.id === d.trackId);
      const c = tr?.clips.find((x) => x.id === d.clipId);
      if (!tr || !c) return;
      const frame = 1 / fps;
      if (d.mode === 'slip' && !('dur' in c)) {
        // F.9 slip: same slot, different source window.
        const vc = c as VideoClip;
        const speed = vc.speed || 1;
        const span = d.orig.out - d.orig.in;
        const maxIn = Math.max(0, (media?.duration ?? d.orig.out) - span);
        const ni = clamp(d.orig.in + dx * speed, 0, maxIn);
        vc.in = ni;
        vc.out = ni + span;
      } else if (d.mode === 'slide') {
        // F.10 slide: this clip moves; neighbours re-trim to fill.
        const sorted = [...tr.clips].sort((a, b) => a.start - b.start);
        const idx = sorted.findIndex((x) => x.id === c.id);
        const prev = sorted[idx - 1];
        const next = sorted[idx + 1];
        let delta = qFrame(dx, fps);
        if (prev) delta = Math.max(delta, -(clipDuration(prev) - frame));
        if (next) delta = Math.min(delta, clipDuration(next) - frame);
        const oldStart = d.orig.start;
        c.start = Math.max(0, oldStart + delta);
        const applied = c.start - oldStart;
        if (prev) {
          if ('dur' in prev) (prev as TextClip).dur += applied;
          else (prev as VideoClip).out += applied * ((prev as VideoClip).speed || 1);
        }
        if (next) {
          next.start += applied;
          if (!('dur' in next)) (next as VideoClip).in += applied * ((next as VideoClip).speed || 1);
        }
      } else if (d.mode === 'move') {
        let ns = snap(d.orig.start + dx, [d.orig.start + dx + d.orig.dur]);
        // if the end snapped, honour that instead
        const endSnap = snap(d.orig.start + dx + d.orig.dur);
        if (Math.abs(endSnap - (d.orig.start + dx + d.orig.dur)) > 1e-9) ns = endSnap - d.orig.dur;
        c.start = Math.max(0, qFrame(ns, fps));
      } else if ('dur' in c) {
        // text clip: trims change start/duration
        if (d.mode === 'trimL') {
          const ns = clamp(qFrame(snap(d.orig.start + dx), fps), 0, d.orig.start + d.orig.dur - frame);
          (c as TextClip).dur = d.orig.dur - (ns - d.orig.start);
          c.start = ns;
        } else {
          c.dur; // no-op keep TS happy
          (c as TextClip).dur = Math.max(frame, qFrame(snap(d.orig.start + d.orig.dur + dx) - d.orig.start, fps));
        }
      } else {
        const vc = c as VideoClip;
        const speed = vc.speed || 1;
        if (d.mode === 'trimL') {
          const maxIn = d.orig.out - frame * speed;
          let ni = clamp(d.orig.in + dx * speed, 0, maxIn);
          const snappedStart = snap(d.orig.start + (ni - d.orig.in) / speed);
          ni = clamp(d.orig.in + (snappedStart - d.orig.start) * speed, 0, maxIn);
          ni = qFrame(ni * fps / fps, fps); // keep source cuts frame-quantised at project fps
          vc.in = ni;
          c.start = Math.max(0, qFrame(d.orig.start + (ni - d.orig.in) / speed, fps));
        } else {
          let no = clamp(d.orig.out + dx * speed, d.orig.in + frame * speed, media?.duration ?? Infinity);
          const snappedEnd = snap(d.orig.start + (no - d.orig.in) / speed);
          no = clamp(d.orig.in + (snappedEnd - d.orig.start) * speed, d.orig.in + frame * speed, media?.duration ?? Infinity);
          vc.out = no;
        }
      }
    }, { history: false });
  };

  const onClipPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setSnapGuide(null);
    if (!d) return;
    if (d.shiftHeld && !d.moved) {
      // F.14: plain Shift+click toggles membership in the multi-select set.
      const cur = store.get().selectedMany;
      const has = cur.some((x) => x.clipId === d.clipId && x.trackId === d.trackId);
      store.set({
        selectedMany: has
          ? cur.filter((x) => !(x.clipId === d.clipId && x.trackId === d.trackId))
          : [...cur, { trackId: d.trackId, clipId: d.clipId }],
      });
      return;
    }
    if (d.moved && d.hoverTrackId && d.hoverTrackId !== d.trackId && (d.mode === 'move' || d.mode === 'slide')) {
      const p = store.get().project;
      const from = p.tracks.find((t) => t.id === d.trackId);
      const to = p.tracks.find((t) => t.id === d.hoverTrackId);
      if (from && to && from.kind === to.kind && !to.locked) {
        store.commit((draft) => {
          const f = draft.tracks.find((t) => t.id === d.trackId)!;
          const i = f.clips.findIndex((c) => c.id === d.clipId);
          if (i < 0) return;
          const [clip] = f.clips.splice(i, 1);
          const t2 = draft.tracks.find((t) => t.id === d.hoverTrackId)!;
          t2.clips.push(clip);
          t2.clips.sort((a, b) => a.start - b.start);
        }, { history: false });
        store.set({ selected: { trackId: d.hoverTrackId, clipId: d.clipId } });
      }
    }
  };

  // ---------- zoom fit / wheel zoom / follow (D.5, D.6) ----------
  const fitZoom = () => {
    const el = scrollRef.current;
    if (!el) return;
    const avail = Math.max(120, el.clientWidth - LABEL_W);
    const total = Math.max(1, projectDuration(store.get().project));
    store.set({ pxPerSec: clamp(avail / (total + 1), 8, 320) });
    el.scrollLeft = 0;
  };
  useEffect(() => {
    const h = () => fitZoom();
    window.addEventListener('cutlab:zoom-fit', h);
    return () => window.removeEventListener('cutlab:zoom-fit', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const cur = store.get().pxPerSec;
      const timeAtPointer = (el.scrollLeft + x - LABEL_W) / cur;
      const next = clamp(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 8, 320);
      store.set({ pxPerSec: next });
      requestAnimationFrame(() => { el.scrollLeft = LABEL_W + timeAtPointer * next - x; });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    if (!follow || !playback.playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = LABEL_W + time * pxPerSec;
    if (x < el.scrollLeft + LABEL_W || x > el.scrollLeft + el.clientWidth - 48) {
      el.scrollLeft = Math.max(0, x - LABEL_W - 72);
    }
  }, [time, follow, pxPerSec]);

  // ---------- track reorder (E.10): drag the header grip ----------
  const startReorder = (e: React.PointerEvent, trackId: string) => {
    e.preventDefault();
    const content = contentRef.current;
    if (!content) return;
    const tracks = store.get().project.tracks;
    const from = tracks.findIndex((t) => t.id === trackId);
    if (from < 0) return;
    const rect = content.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const y = ev.clientY - rect.top - 24; // below the ruler
      let acc = 0;
      let idx = tracks.length;
      for (let i = 0; i < tracks.length; i++) {
        const h = laneHView(tracks[i]) + 1;
        if (y < acc + h / 2) { idx = i; break; }
        acc += h;
      }
      setDropIndex(idx);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const y = ev.clientY - rect.top - 24;
      let acc = 0;
      let idx = tracks.length;
      for (let i = 0; i < tracks.length; i++) {
        const h = laneHView(tracks[i]) + 1;
        if (y < acc + h / 2) { idx = i; break; }
        acc += h;
      }
      setDropIndex(null);
      if (idx !== from && idx !== from + 1) {
        store.commit((d) => {
          const [moved] = d.tracks.splice(from, 1);
          d.tracks.splice(idx > from ? idx - 1 : idx, 0, moved);
        });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---------- ruler seeking ----------
  const rulerSeek = (e: React.PointerEvent) => {
    playback.seek(qFrame(xToTime(e.clientX), fps));
  };

  const addTrack = (kind: Track['kind']) => {
    store.commit((draft) => {
      draft.tracks.push({ id: newId('trk'), kind, clips: [] });
    });
  };

  const addTextClip = () => {
    const p = store.get().project;
    let track = p.tracks.find((t) => t.kind === 'text');
    const start = qFrame(playback.time, fps);
    store.commit((draft) => {
      if (!track) {
        track = { id: newId('trk'), kind: 'text', clips: [] };
        draft.tracks.push(track);
      }
      const tr = draft.tracks.find((t) => t.id === track!.id)!;
      const clip: TextClip = {
        id: newId('clip'), text: 'Text', start, dur: 2, style: loadSettings().lastTextStyle ?? 'pop-bold',
        x: 0.5, y: 0.8, animIn: 'pop', animOut: 'fade', effects: [], ...defaultTransitionFields(),
      };
      tr.clips.push(clip);
      store.set({ selected: { trackId: tr.id, clipId: clip.id } });
    });
  };

  const ticks: number[] = [];
  const tickStep = pxPerSec >= 40 ? 1 : pxPerSec >= 14 ? 5 : 10;
  for (let t = 0; t <= dur + 8; t += tickStep) ticks.push(t);

  return (
    <section className="flex h-full shrink-0 flex-col border-t border-[#3a3a3a] bg-[#212121]" data-testid="timeline">
      {nestSession && (
        <div className="flex items-center gap-3 px-3 py-1.5 text-[12px]"
          style={{ background: '#2b1210', borderBottom: '1px solid #E31000', color: '#f2d8d5' }} role="status">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: '#E31000' }} />
          <span className="font-semibold">Editing inside “{nestSession.name}”</span>
          <span className="text-[#c9a49f]">
            a compound in “{(JSON.parse(nestSession.parentJson) as Project).name}” — autosave and cloud
            are paused; your edits land in the parent as one undo step.
          </span>
          <div className="flex-1" />
          <button className="btn small" onClick={closeNest}>Done</button>
        </div>
      )}
      {/* toolbar — §3.8 four labelled groups, same actions/keys.
          FIX A (D5): ONE row, never wraps (was 93px at 1400/1280,
          152px at 1024) — groups stay labelled and in order; when
          the timeline column is narrower than the row, it scrolls
          horizontally (.tl-toolbar), so every control stays
          reachable and the height holds at ~35px at every width.
          TIMELINE SECTION 2026-11-06: the groups are now indivisible
          .tl-cluster units (the row scrolls BETWEEN clusters, never
          through one); Beats & markers collapses its wide inputs
          away (persisted); View pins right via ml-auto when the row
          fits and takes its place at the end when it scrolls. */}
      <div className="tl-toolbar flex flex-nowrap items-center gap-x-1.5 overflow-x-auto px-3 py-1">
        <div className="tl-cluster" data-testid="tl-cluster-edit">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#a8a8a8]">Edit</span>
          <button className="btn small" onClick={splitAtPlayhead} title="Split at playhead (S)">Split</button>
          <button className="btn small" aria-pressed={bladeMode} onClick={() => store.set({ bladeMode: !bladeMode })}
            style={bladeMode ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
            title="Blade tool (B) — click a clip to split it at that point">Blade</button>
          <button className="btn small" onClick={rippleDeleteSelected} title="Delete + close gap (Del)">Ripple delete</button>
          <button className="btn small" onClick={deleteSelected} title="Delete, leave gap (Shift+Del)">Delete</button>
          <button className="btn small" onClick={setRangeInAtPlayhead} title="Set range start at playhead (I)">Set I</button>
          <button className="btn small" onClick={setRangeOutAtPlayhead} title="Set range end at playhead (O)">Set O</button>
          <button className="btn small" disabled={!clipboard} onClick={() => setAttrsOpen(true)}
            title="Paste attributes from the copied clip (Ctrl+C first)">Paste attrs…</button>
          <button className="btn small" onClick={makeCompoundFromSelection}
            title="Compound the selected clips into one nested clip (Ctrl+G)">Compound</button>
          {project.rangeIn != null && project.rangeOut != null && (
            <>
              <span className="font-mono text-[11px] text-[#e8c268]">
                range {project.rangeIn.toFixed(2)}–{project.rangeOut.toFixed(2)}s
              </span>
              <button className="btn small" onClick={clearRange}>Clear range</button>
            </>
          )}
        </div>
        <span className="mx-1.5 h-4 w-px shrink-0 bg-[#3a3a3a]" />
        <div className="tl-cluster" data-testid="tl-cluster-add">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#a8a8a8]">Add</span>
          <button className="btn small" onClick={() => addTrack('video')}>+ Video</button>
          <button className="btn small" onClick={() => addTrack('audio')}>+ Audio</button>
          <button className="btn small" onClick={() => addTrack('text')}>+ Text</button>
          <button className="btn small" onClick={addAdjustmentClip}
            title="Add an adjustment clip at the playhead — its effects and grade apply to everything beneath it">+ Adjustment</button>
          <button className="btn small" onClick={addTextClip}>Add text</button>
          <button className="btn small" onClick={() => addCaptionAtPlayhead()} title="Caption at the playhead, inheriting the previous caption's design">Add caption</button>
        </div>
        <span className="mx-1.5 h-4 w-px shrink-0 bg-[#3a3a3a]" />
        <div className="tl-cluster" data-testid="tl-cluster-beats">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#a8a8a8]">Beats & markers</span>
          <button className="btn small" data-testid="beats-toggle" aria-expanded={!beatsCollapsed}
            onClick={toggleBeats}
            title={beatsCollapsed ? 'Show BPM / offset / Beats controls' : 'Hide BPM / offset / Beats controls'}>
            {beatsCollapsed ? '›' : '‹'}
          </button>
          <button className="btn small" onClick={() => addMarkerAtPlayhead('')} title="Add marker (M)">Marker</button>
          {!beatsCollapsed && (
            <>
              <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                BPM
                <input type="number" className="field" style={{ width: 58 }} value={bpm} min={1} max={400}
                  onChange={(e) => setBpm(Number(e.target.value))} />
              </label>
              <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                offset s
                <input type="number" className="field" style={{ width: 58 }} value={beatOffset} step={0.01}
                  onChange={(e) => setBeatOffset(Number(e.target.value))} />
              </label>
              <button className="btn small" onClick={() => generateBeatMarkers(bpm, beatOffset)}>Beats</button>
            </>
          )}
        </div>
        <div className="tl-cluster ml-auto" data-testid="tl-cluster-view">
          <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-[#a8a8a8]">View</span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[#a8a8a8]">
            <Switch size="sm" checked={snapOn} label="Snap" onChange={(v) => setSnapOn(v)} />
          </span>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[#a8a8a8]" title="Keep the playhead in view during playback">
            <Switch size="sm" checked={follow} label="Follow" onChange={(v) => setFollow(v)} />
          </span>
          <label className="flex items-center gap-1.5 text-[11px] text-[#a8a8a8]">
            Zoom
            <input type="range" min={8} max={320} value={pxPerSec} style={{ width: 110 }}
              onChange={(e) => store.set({ pxPerSec: Number(e.target.value) })} />
          </label>
          <button className="btn small" onClick={fitZoom} title="Zoom to fit the whole project (Shift+Z)">Fit</button>
        </div>
      </div>
      {/* body */}
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        <div ref={contentRef} className="relative" style={{ width: LABEL_W + contentW }}>
          {/* ruler */}
          <div className="flex" style={{ height: 24 }}>
            <div className="sticky left-0 z-20 flex shrink-0 items-center bg-[#212121] px-2 font-mono text-[11px] text-[#a8a8a8]"
              style={{ width: LABEL_W }}>
              {Math.floor(time / 60)}:{String(Math.floor(time % 60)).padStart(2, '0')}.{String(Math.floor((time % 1) * fps)).padStart(2, '0')}
            </div>
            <div
              className="relative shrink-0 cursor-text"
              style={{ width: contentW }}
              onPointerDown={(e) => { seekRef.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId); rulerSeek(e); }}
              onPointerMove={(e) => { if (seekRef.current) rulerSeek(e); }}
              onPointerUp={() => { seekRef.current = false; }}
            >
              {ticks.map((t) => (
                <div key={t} className="absolute bottom-0 top-0 border-l border-[#3a3a3a]" style={{ left: t * pxPerSec }}>
                  <span className="pl-1 font-mono text-[11px] text-[#a8a8a8]">
                    {Math.floor(t / 60)}:{String(t % 60).padStart(2, '0')}
                  </span>
                </div>
              ))}
              {project.rangeIn != null && project.rangeOut != null && (
                <RangeBand rangeIn={project.rangeIn} rangeOut={project.rangeOut} pxPerSec={pxPerSec} fps={fps} xToTime={xToTime} />
              )}
              {project.markers.map((m, i) => (
                <span key={i}>
                  {m.dur ? (
                    <span className="absolute bottom-0 top-0 opacity-25"
                      style={{ left: m.t * pxPerSec, width: m.dur * pxPerSec, background: m.color ?? '#E31000' }} />
                  ) : null}
                  <button
                    className="absolute bottom-0 z-10 -translate-x-1/2"
                    style={{ left: m.t * pxPerSec }}
                    title={`${m.label || 'marker'} @ ${m.t.toFixed(2)}s — click to seek, double-click to edit, right-click to delete`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => playback.seek(m.t)}
                    onDoubleClick={() => {
                      setMarkerEdit(i);
                      setMarkerDraft({ label: m.label, color: m.color ?? '', dur: m.dur ? String(m.dur) : '' });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      store.commit((draft) => { draft.markers.splice(i, 1); });
                    }}
                  >
                    <span style={{ color: m.color ?? (m.label === 'beat' ? '#a8a8a8' : '#E31000'), fontSize: 11 }}>◆</span>
                  </button>
                </span>
              ))}
              {markerEdit !== null && project.markers[markerEdit] && (
                <MarkerEditor
                  left={Math.min(project.markers[markerEdit].t * pxPerSec, Math.max(0, contentW - 240))}
                  draft={markerDraft}
                  setDraft={setMarkerDraft}
                  onClose={() => setMarkerEdit(null)}
                  onSave={() => {
                    const idx = markerEdit;
                    store.commit((draft) => {
                      const mk = draft.markers[idx];
                      if (!mk) return;
                      mk.label = markerDraft.label;
                      mk.color = markerDraft.color || undefined;
                      const d = Number(markerDraft.dur);
                      mk.dur = markerDraft.dur !== '' && isFinite(d) && d > 0 ? d : undefined;
                    });
                    setMarkerEdit(null);
                  }}
                  onDelete={() => {
                    const idx = markerEdit;
                    store.commit((draft) => { draft.markers.splice(idx, 1); });
                    setMarkerEdit(null);
                  }}
                />
              )}
            </div>
          </div>
          {/* lanes */}
          {project.tracks.map((track) => (
            <div key={track.id} className="flex border-t border-[#333]">
              <TrackHeader
                track={track}
                ordinal={project.tracks.filter((t) => t.kind === track.kind).indexOf(track) + 1}
                renaming={renamingTrack === track.id}
                renameText={renameTrackText}
                onRenameText={setRenameTrackText}
                onStartRename={() => { setRenamingTrack(track.id); setRenameTrackText(track.name ?? ''); }}
                onCommitRename={() => {
                  const name = renameTrackText.trim();
                  setRenamingTrack(null);
                  store.commit((d) => {
                    const tr = d.tracks.find((t) => t.id === track.id);
                    if (tr) tr.name = name || undefined;
                  });
                }}
                onCancelRename={() => setRenamingTrack(null)}
                onToggle={(flag) => store.commit((d) => {
                  const tr = d.tracks.find((t) => t.id === track.id);
                  if (tr) tr[flag] = !tr[flag];
                })}
                onCycleColor={() => store.commit((d) => {
                  const tr = d.tracks.find((t) => t.id === track.id);
                  if (tr) {
                    const i = TRACK_COLORS.indexOf(tr.color);
                    tr.color = TRACK_COLORS[(i + 1) % TRACK_COLORS.length];
                  }
                })}
                onDelete={() => store.commit((draft) => { draft.tracks = draft.tracks.filter((t) => t.id !== track.id); })}
                onReorderStart={(e) => startReorder(e, track.id)}
              />
              <div className="relative shrink-0" style={{ width: contentW, height: laneHView(track), background: track.locked ? 'rgba(0,0,0,0.25)' : undefined }}
                onPointerDown={() => store.set({ selected: null })}>
                {track.clips.map((clip) => (
                  <ClipBlock
                    key={clip.id}
                    track={track}
                    clip={clip}
                    pxPerSec={pxPerSec}
                    height={laneHView(track)}
                    selected={selected?.clipId === clip.id || selectedMany.some((x) => x.clipId === clip.id)}
                    onContext={(e) => {
                      e.preventDefault();
                      store.set({ selected: { trackId: track.id, clipId: clip.id } });
                      setCtxMenu({ x: e.clientX, y: e.clientY, trackId: track.id, clipId: clip.id });
                    }}
                    onDown={onClipPointerDown}
                    onMove={onClipPointerMove}
                    onUp={onClipPointerUp}
                  />
                ))}
              </div>
            </div>
          ))}
          {/* TIMELINE SECTION 2026-11-06 (opening-state): one quiet
              line in the lanes while the timeline has no clips at
              all; it unmounts the moment any clip exists. */}
          {!project.tracks.some((t) => t.clips.length > 0) && (
            <div className="pointer-events-none absolute z-10" style={{ left: LABEL_W + 16, top: 84 }}
              data-testid="timeline-empty">
              <span className="text-[12px] text-[#8a8a8a]">Import media, then drag clips here to start editing</span>
            </div>
          )}
          {dropIndex !== null && (
            <div className="pointer-events-none absolute z-30 h-[2px] bg-[#E31000]"
              style={{ left: 0, right: 0, top: 24 + project.tracks.slice(0, dropIndex).reduce((a, t) => a + laneHView(t) + 1, 0) }} />
          )}
          {/* snap guide (D.9): shows WHAT the drag snapped to */}
          {snapGuide !== null && (
            <div className="pointer-events-none absolute bottom-0 top-0 z-20" style={{ left: LABEL_W + snapGuide * pxPerSec }}>
              <div className="h-full border-l border-dashed" style={{ borderColor: '#C0C0C0' }} />
            </div>
          )}
          {/* playhead */}
          <div className="pointer-events-none absolute bottom-0 top-0 z-30" style={{ left: LABEL_W + time * pxPerSec }}>
            <div className="h-full w-px" style={{ background: '#E31000' }} />
            <div className="absolute -left-[5px] top-0 h-0 w-0"
              style={{ borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '7px solid #E31000' }} />
          </div>
        </div>
      </div>
      {ctxMenu && (
        <ClipContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onAttrs={() => { setCtxMenu(null); setAttrsOpen(true); }}
        />
      )}
      {attrsOpen && (
        <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center" onClick={() => setAttrsOpen(false)}>
          <div className="modal-panel w-[320px] p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-[15px] font-semibold">Paste attributes</div>
            <p className="mb-3 text-[12px] text-[#a8a8a8]">
              From the copied clip onto {selectedMany.length > 0 ? `${selectedMany.length} selected clip(s)` : 'the selected clip'}.
            </p>
            <div className="flex flex-col">
              {(Object.keys(attrGroups) as (keyof PasteAttrGroups)[]).map((g) => (
                <CheckboxRow
                  key={g}
                  label={g === 'textStyle' ? 'Text style' : g[0].toUpperCase() + g.slice(1)}
                  description={ATTR_GROUP_DESCS[g]}
                  checked={attrGroups[g]}
                  onChange={(v) => setAttrGroups({ ...attrGroups, [g]: v })}
                />
              ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn" onClick={() => setAttrsOpen(false)}>Cancel</button>
              <button className="btn primary" onClick={() => { pasteAttributes(attrGroups); setAttrsOpen(false); }}>Paste</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ClipContextMenu({ menu, onClose, onAttrs }: {
  menu: { x: number; y: number; trackId: string; clipId: string };
  onClose: () => void;
  onAttrs: () => void;
}) {
  const project = useStore((s) => s.project);
  const clipboard = useStore((s) => s.clipboard);
  const many = useStore((s) => s.selectedMany);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('[data-clip-menu]')) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const track = project.tracks.find((t) => t.id === menu.trackId);
  const clip = track?.clips.find((c) => c.id === menu.clipId);
  if (!track || !clip) return null;
  const isMedia = 'media' in clip;
  const playheadInside = playback.time > clip.start && playback.time < clip.start + clipDuration(clip);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button className="flex w-full px-3 py-1.5 text-left text-[13px] text-[#e8e8e8] hover:bg-[#333] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      disabled={disabled} onClick={() => { onClose(); fn(); }}>
      {label}
    </button>
  );
  return (
    <div data-clip-menu className="fixed z-50 min-w-[210px] rounded-md border border-[#3a3a3a] bg-[#262626] py-1 shadow-2xl"
      style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 320) }} role="menu">
      {item('Split at playhead', () => splitAtPlayhead(), !playheadInside)}
      {'nest' in clip && item('Open nest — edit inside', () => openNest(menu.trackId, menu.clipId))}
      {'nest' in clip && item('Uncompound', () => uncompoundSelected())}
      {many.length > 1 && item(`Make compound from ${many.length} clips`, () => makeCompoundFromSelection())}
      {many.length > 1 && item(`Make multicam from ${many.length} clips`, () => makeMulticamFromSelection())}
      {item('Duplicate', () => duplicateSelected())}
      {item('Copy', () => copySelected())}
      {item('Paste attributes…', onAttrs, !clipboard)}
      {isMedia && track.kind === 'video' && item('Extract audio', () => extractAudioSelected())}
      {clip.groupId && item('Unlink A/V', () => unlinkSelected())}
      {isMedia && item('Rejoin through edit', () => {
        if (!rejoinSelected()) store.toastMsg('info', 'Not a through edit — neighbours must be contiguous pieces of the same source at identical settings.');
      })}
      <div className="my-1 border-t border-[#3a3a3a]" />
      {many.length > 1
        ? item(`Ripple delete ${many.length} clips`, () => deleteMany(true))
        : item('Ripple delete', () => rippleDeleteSelected())}
      {item('Delete (leave gap)', () => deleteSelected())}
      <div className="px-3 pb-1 pt-1.5 text-[11px] leading-snug text-[#a8a8a8]">
        Alt+drag slips · Shift+drag slides · Shift+click multi-selects · drag onto a same-kind lane moves tracks
      </div>
    </div>
  );
}

function ClipBlock({ track, clip, pxPerSec, height, selected, onDown, onMove, onUp, onContext }: {
  track: Track;
  clip: Clip;
  pxPerSec: number;
  height: number;
  selected: boolean;
  onContext: (e: React.MouseEvent) => void;
  onDown: (e: React.PointerEvent, t: Track, c: Clip, m: DragState['mode']) => void;
  onMove: (e: React.PointerEvent) => void;
  onUp: () => void;
}) {
  const project = useStore((s) => s.project);
  // D1.4: one-shot edge flash when this block is a fresh angle cut.
  const flash = useSyncExternalStore(angleFlash.subscribe, angleFlash.get);
  // D1.5: voice-isolation job state chip for this clip.
  const sep = useSyncExternalStore(subscribeSepStatus, () => getSepStatus(clip.id));
  const media = 'media' in clip ? project.media.find((m) => m.id === clip.media) : undefined;
  const rt = 'media' in clip ? getMediaRuntime(clip.media) : undefined;
  const dur = clipDuration(clip);
  const w = Math.max(6, dur * pxPerSec);
  const label = 'nest' in clip
    ? `▣ ${clip.nest.name}`
    : 'adj' in clip
      ? 'Adjustment'
      : 'text' in clip
        ? (clip as TextClip).text
        : media?.src ?? 'missing media';
  const missing = 'media' in clip && !rt;
  const waveRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = waveRef.current;
    if (!cv || !rt?.peaks || !media?.duration) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const isText = 'dur' in clip;
    const inF = isText ? 0 : (clip as VideoClip).in / media.duration;
    const outF = isText ? 1 : (clip as VideoClip).out / media.duration;
    const peaks = rt.peaks;
    for (let x = 0; x < W; x++) {
      const f = inF + (outF - inF) * (x / W);
      const p = peaks[Math.min(peaks.length - 1, Math.floor(f * peaks.length))] ?? 0;
      const h = Math.max(1, p * (H - 4));
      ctx.fillRect(x, (H - h) / 2, 1, h);
    }
  }, [rt?.peaks, media?.duration, clip, pxPerSec]);

  return (
    <div
      className={`clip-block ${selected ? 'selected' : ''} ${missing ? 'missing' : ''}`}
      data-testid="clip-block"
      style={{
        left: clip.start * pxPerSec,
        width: w,
        top: 3,
        height: height - 6,
        background: track.color ?? ('adj' in clip ? '#59524a' : track.kind === 'video' ? '#46586b' : track.kind === 'audio' ? '#476b52' : '#75603a'),
      }}
      onPointerDown={(e) => onDown(e, track, clip, 'move')}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onContextMenu={onContext}
      onDoubleClick={() => { if ('nest' in clip) openNest(track.id, clip.id); }}
    >
      {flash?.clipId === clip.id && (
        <div key={flash.nonce} aria-hidden
          className="cl-edge-flash pointer-events-none absolute inset-y-0 left-0 z-20 w-[3px] bg-[#E8C268]" />
      )}
      {(sep === 'queued' || sep === 'working' || sep === 'failed') && (
        <div aria-hidden className="pointer-events-none absolute bottom-0.5 right-1 z-20 rounded-sm px-1 text-[11px] font-medium leading-4"
          style={{ background: sep === 'failed' ? '#E31000' : '#3a3a3a', color: sep === 'failed' ? '#fff' : '#E8C268' }}>
          {sep === 'queued' ? 'voice: queued' : sep === 'working' ? 'voice: separating…' : 'voice: failed'}
        </div>
      )}
      {'audioOverride' in clip && clip.audioOverride?.enabled && !sep && (
        <div aria-hidden title="Voice isolated — the render blends the stem by the Inspector strength"
          className="pointer-events-none absolute bottom-0.5 right-1 z-20 rounded-sm bg-[#3a3a3a] px-1 text-[11px] font-medium leading-4 text-[#E8C268]">
          VOICE ISO
        </div>
      )}
      {/* FIX B1 #4: .trim-handle carries no left/right offset in CSS, so
          both handles stacked at the clip's left edge and the right
          handle (later in the DOM) won every hit — a left-edge drag
          trimmed the OUT point. Pin each handle to its own edge. */}
      <div className="trim-handle left" style={{ left: 0 }} onPointerDown={(e) => onDown(e, track, clip, 'trimL')} />
      <div className="pointer-events-none absolute inset-0 overflow-hidden px-1.5 py-0.5">
        <div className="truncate text-[11px] font-medium leading-tight text-white/95">
          {label}
          {'reversed' in clip && clip.reversed ? ' ⇋' : ''}
          {'freezeAt' in clip && clip.freezeAt != null ? ' ❄' : ''}
          {'speedKeys' in clip && (clip.speedKeys?.length ?? 0) > 0 ? ' ∿' : ''}
          {'angles' in clip && clip.angles ? ` ⧉ angle ${(clip.activeAngle ?? 0) + 1}/${clip.angles.length}` : ''}
          {'fit' in clip && clip.fit === 'blur-fill' ? ' ▨ blur-fill' : ''}
        </div>
        <div className="font-mono text-[11px] leading-tight text-white/60">{dur.toFixed(2)}s</div>
      </div>
      {rt?.peaks && track.kind !== 'text' && (
        <canvas ref={waveRef} width={Math.min(600, Math.max(20, Math.floor(w)))} height={height - 8}
          className="pointer-events-none absolute bottom-0 left-0 h-full w-full opacity-70" />
      )}
      {'media' in clip && (
        <VolumeLine track={track} clip={clip as VideoClip} w={w} h={height - 6} />
      )}
      {'keyframes' in clip && (clip as VideoClip).keyframes?.map((k, i) => (
        <span key={i} className="absolute bottom-[1px] cursor-ew-resize text-[11px] text-[#ffd75e]"
          style={{ left: `calc(${(k.t / Math.max(dur, 0.001)) * 100}% - 4px)`, pointerEvents: 'all' }}
          title={`Keyframe @${k.t.toFixed(2)}s — drag to retime, click to inspect, Alt+click deletes`}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.altKey) {
              store.commit((d) => {
                const tr = d.tracks.find((x) => x.id === track.id);
                const c = tr?.clips.find((x) => x.id === clip.id) as VideoClip | undefined;
                if (c) c.keyframes = (c.keyframes ?? []).filter((_, j) => j !== i);
              });
              return;
            }
            store.set({ selected: { trackId: track.id, clipId: clip.id }, selectedKf: { clipId: clip.id, index: i } });
            playback.seek(clip.start + k.t);
            store.commit(() => undefined, { history: true });
            const startX = e.clientX;
            const origT = k.t;
            const move = (ev: PointerEvent) => {
              const nt = clamp(origT + (ev.clientX - startX) / pxPerSec, 0, dur);
              store.commit((d) => {
                const tr = d.tracks.find((x) => x.id === track.id);
                const c = tr?.clips.find((x) => x.id === clip.id) as VideoClip | undefined;
                if (c?.keyframes) {
                  c.keyframes[i].t = Math.round(nt * project.canvas.fps) / project.canvas.fps;
                  c.keyframes.sort((a, b) => a.t - b.t);
                }
              }, { history: false });
            };
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}>◆</span>
      ))}
      <div className="trim-handle right" style={{ right: 0 }} onPointerDown={(e) => onDown(e, track, clip, 'trimR')} />
    </div>
  );
}


const MARKER_COLORS = [
  { name: 'Default', value: '' },
  { name: 'Red', value: '#E31000' },
  { name: 'Silver', value: '#C0C0C0' },
  { name: 'Amber', value: '#E8C268' },
  { name: 'Green', value: '#7DC98A' },
  { name: 'Blue', value: '#7DA8C9' },
];

function MarkerEditor({ left, draft, setDraft, onSave, onDelete, onClose }: {
  left: number;
  draft: { label: string; color: string; dur: string };
  setDraft: (d: { label: string; color: string; dur: string }) => void;
  onSave: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute top-[26px] z-40 w-[236px] rounded-md border border-[#3a3a3a] bg-[#262626] p-2.5 shadow-2xl"
      style={{ left }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="panel-title mb-1.5">Marker</div>
      <input className="field mb-2 w-full" placeholder="Label" value={draft.label} autoFocus
        onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
      <div className="mb-2 flex items-center gap-1.5">
        {MARKER_COLORS.map((c) => (
          <button key={c.name} title={c.name} aria-label={`Marker colour ${c.name}`}
            className="h-4 w-4 rounded-full border"
            style={{
              background: c.value || 'transparent',
              borderColor: draft.color === c.value ? '#fff' : '#555',
            }}
            onClick={() => setDraft({ ...draft, color: c.value })} />
        ))}
        <span className="ml-1 text-[11px] text-[#a8a8a8]">colour</span>
      </div>
      <label className="mb-2 flex items-center justify-between text-[11px] text-[#a8a8a8]">
        Range duration (s, blank = point)
        <input className="field" style={{ width: 64 }} type="number" step={0.1} min={0} value={draft.dur}
          onChange={(e) => setDraft({ ...draft, dur: e.target.value })} />
      </label>
      <div className="flex gap-1.5">
        <button className="btn small primary" onClick={onSave}>Save</button>
        <button className="btn small" onClick={onDelete}>Delete</button>
        <button className="btn small" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function RangeBand({ rangeIn, rangeOut, pxPerSec, fps, xToTime }: {
  rangeIn: number;
  rangeOut: number;
  pxPerSec: number;
  fps: number;
  xToTime: (clientX: number) => number;
}) {
  const dragEnd = (e: React.PointerEvent, which: 'in' | 'out') => {
    e.stopPropagation();
    e.preventDefault();
    store.commit(() => undefined, { history: true }); // one undo snapshot per handle drag
    const move = (ev: PointerEvent) => {
      const t = qFrame(xToTime(ev.clientX), fps);
      store.commit((d) => {
        if (which === 'in') d.rangeIn = Math.min(t, (d.rangeOut ?? Infinity) - 1 / fps);
        else d.rangeOut = Math.max(t, (d.rangeIn ?? 0) + 1 / fps);
      }, { history: false });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      <div className="absolute bottom-0 top-0" style={{
        left: rangeIn * pxPerSec, width: Math.max(2, (rangeOut - rangeIn) * pxPerSec),
        background: 'rgba(227,16,0,0.13)', borderLeft: '1px solid #E31000', borderRight: '1px solid #E31000',
      }} />
      <div className="absolute bottom-0 top-0 z-10 w-[7px] cursor-ew-resize" style={{ left: rangeIn * pxPerSec - 3 }}
        title="Drag to move the range start" onPointerDown={(e) => dragEnd(e, 'in')} />
      <div className="absolute bottom-0 top-0 z-10 w-[7px] cursor-ew-resize" style={{ left: rangeOut * pxPerSec - 4 }}
        title="Drag to move the range end" onPointerDown={(e) => dragEnd(e, 'out')} />
    </>
  );
}


function TrackHeader({ track, ordinal, renaming, renameText, onRenameText, onStartRename, onCommitRename, onCancelRename, onToggle, onCycleColor, onDelete, onReorderStart }: {
  track: Track;
  ordinal: number;
  renaming: boolean;
  renameText: string;
  onRenameText: (v: string) => void;
  onStartRename: () => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onToggle: (flag: 'muted' | 'solo' | 'locked' | 'hidden') => void;
  onCycleColor: () => void;
  onDelete: () => void;
  onReorderStart: (e: React.PointerEvent) => void;
}) {
  const h = laneHView(track);
  const letter = track.kind === 'video' ? 'V' : track.kind === 'audio' ? 'A' : 'T';
  if (audioFocusRows && track.kind !== 'audio') {
    return (
      <div className="sticky left-0 z-20 flex shrink-0 items-center bg-[#262626] px-1.5"
        style={{ width: LABEL_W, height: 12 }}>
        <span className="truncate font-mono text-[11px] text-[#a8a8a8]">
          {letter}{ordinal}{track.name ? ` · ${track.name}` : ''}
        </span>
      </div>
    );
  }
  // §3.8: flag buttons are >=20 px hit areas; Hide/Lock are icons.
  // TIMELINE SECTION 2026-11-06: 22 px hit areas inside the 44 px lane.
  const flagBtn = (flag: 'muted' | 'solo' | 'locked' | 'hidden', label: React.ReactNode, title: string) => (
    <button
      className="btn icon"
      style={{ width: 22, height: 22, padding: 0, display: 'grid', placeItems: 'center', fontSize: 11, lineHeight: 1, ...(track[flag] ? { borderColor: '#707070', color: '#fff', background: '#404040' } : {}) }}
      aria-pressed={!!track[flag]}
      aria-label={title}
      title={title}
      onClick={() => onToggle(flag)}
    >
      {label}
    </button>
  );
  const eyeIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.6" />
    </svg>
  );
  const lockIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="5.5" y="10.5" width="13" height="9" rx="1.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </svg>
  );
  return (
    <div className="sticky left-0 z-20 flex shrink-0 flex-col justify-center gap-1 bg-[#262626] px-1.5 py-0"
      style={{ width: LABEL_W, height: h, background: track.color ? track.color + '2e' : '#262626' }}>
      {/* §3.8 row 1: grip, name, colour, flags (>=20 px), delete */}
      <div className="flex items-center gap-1">
        <span className="cursor-grab touch-none px-0.5 text-[11px] text-[#a8a8a8]" title="Drag to reorder tracks (top video track = top layer)"
          onPointerDown={onReorderStart}>⠿</span>
        {renaming ? (
          <input className="field min-w-0 flex-1" style={{ padding: '0 4px', fontSize: 11 }} value={renameText} autoFocus
            onChange={(e) => onRenameText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onCommitRename(); if (e.key === 'Escape') onCancelRename(); }}
            onBlur={onCommitRename} />
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#c0c0c0]" title="Double-click to rename"
            onDoubleClick={onStartRename}>
            {letter}{ordinal}{track.name ? ` · ${track.name}` : ''}
          </span>
        )}
        <button className="h-3 w-3 shrink-0 rounded-full border border-[#555]" title="Track colour (click to cycle)"
          style={{ background: track.color ?? 'transparent' }} onClick={onCycleColor} />
        {(track.kind === 'audio' || track.kind === 'video') && flagBtn('muted', 'M', 'Mute track')}
        {track.kind === 'audio' && flagBtn('solo', 'S', 'Solo track')}
        {track.kind !== 'audio' && flagBtn('hidden', eyeIcon, 'Hide track in preview + render')}
        {flagBtn('locked', lockIcon, 'Lock track against edits')}
        <button className="btn icon" style={{ width: 22, height: 22, padding: 0, display: 'grid', placeItems: 'center', fontSize: 11 }} title="Delete track" aria-label="Delete track" onClick={onDelete}>×</button>
      </div>
      {/* §3.8 row 2: bus select (never truncates) + slim volume slider
          with the unity tick at the end of travel */}
      {track.kind !== 'text' && (
        <div className="flex items-center gap-1.5">
          {(track.kind === 'audio' || track.kind === 'video') && (
            <select className="field shrink-0" style={{ padding: '0 2px', fontSize: 11, height: 20, width: 104 }}
              title="Fairlight bus: dialogue tracks key the ducking; music/fx tracks get ducked"
              aria-label="Track bus"
              value={track.bus ?? ''}
              onChange={(e) => store.commit((d) => {
                const tr = d.tracks.find((t) => t.id === track.id);
                if (tr) tr.bus = (e.target.value || undefined) as Track['bus'];
              })}>
              <option value="">bus: mix</option>
              <option value="dialogue">bus: dialogue</option>
              <option value="music">bus: music</option>
              <option value="fx">bus: fx</option>
            </select>
          )}
          <div className="relative min-w-0 flex-1">
            <input type="range" min={0} max={1} step={0.01} value={track.volume ?? 1}
              className="w-full" style={{ height: 14 }} title={`Track volume ${Math.round((track.volume ?? 1) * 100)}%`}
              aria-label="Track volume"
              onPointerDown={() => store.commit(() => undefined, { history: true })}
              onChange={(e) => store.commit((d) => {
                const tr = d.tracks.find((t) => t.id === track.id);
                if (tr) tr.volume = Number(e.target.value);
              }, { history: false })} />
            <span aria-hidden className="pointer-events-none absolute right-0 top-1/2 h-[7px] w-px -translate-y-1/2 bg-[#a8a8a8]" />
          </div>
        </div>
      )}
      <TrackHeightHandle track={track} />
    </div>
  );
}

function TrackHeightHandle({ track }: { track: Track }) {
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = laneH(track);
    store.commit(() => undefined, { history: true }); // one undo snapshot per resize
    const move = (ev: PointerEvent) => {
      const h = clamp(startH + (ev.clientY - startY), 24, 120);
      store.commit((d) => {
        const tr = d.tracks.find((t) => t.id === track.id);
        if (tr) tr.height = h;
      }, { history: false });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className="absolute bottom-0 left-0 right-0 h-[5px] cursor-ns-resize" title="Drag to resize lane"
      onPointerDown={onDown} />
  );
}


/** The clip volume line (K.5): Alt+click adds a point, drag moves it,
 *  Ctrl+Alt+click deletes it — Fairlight's gesture set. Level shown is the
 *  key multiplier (1 = clip volume as set). */
function VolumeLine({ track, clip, w, h }: { track: Track; clip: VideoClip | import('../types').AudioClip; w: number; h: number }) {
  const dur = clipDuration(clip);
  const keys = [...(clip.volumeKeys ?? [])].sort((a, b) => a.t - b.t);
  const pts: string[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * dur;
    let v = 1;
    if (keys.length > 0) {
      if (t <= keys[0].t) v = keys[0].v;
      else if (t >= keys[keys.length - 1].t) v = keys[keys.length - 1].v;
      else {
        for (let j = 1; j < keys.length; j++) {
          if (t <= keys[j].t) {
            const a = keys[j - 1], b = keys[j];
            v = b.t === a.t ? b.v : a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
            break;
          }
        }
      }
    }
    pts.push(`${((t / dur) * w).toFixed(1)},${((1 - v) * h).toFixed(1)}`);
  }
  const commitKeys = (next: { t: number; v: number }[], history: boolean) => {
    store.commit((d) => {
      const tr = d.tracks.find((x) => x.id === track.id);
      const c = tr?.clips.find((x) => x.id === clip.id) as VideoClip | undefined;
      if (c) c.volumeKeys = next.length ? next : undefined;
    }, { history });
  };
  const localFromEvent = (e: React.PointerEvent) => {
    const block = (e.currentTarget as unknown as HTMLElement).closest('.clip-block') as HTMLElement | null;
    if (!block) return null;
    const r = block.getBoundingClientRect();
    const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
    const fy = clamp((e.clientY - r.top) / r.height, 0, 1);
    return { t: fx * dur, v: clamp(1 - fy, 0, 1.5) };
  };
  return (
    <svg className="absolute inset-0" width={w} height={h} style={{ top: 3, overflow: 'visible' }}
      onPointerDown={(e) => {
        if (!e.altKey || e.ctrlKey) return;
        e.stopPropagation();
        const p = localFromEvent(e);
        if (!p) return;
        store.commit(() => undefined, { history: true });
        commitKeys([...keys, { t: Math.round(p.t * 100) / 100, v: Math.round(p.v * 100) / 100 }].sort((a, b) => a.t - b.t), false);
      }}>
      <polyline points={pts.join(' ')} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth="1" pointerEvents="none" />
      {keys.map((k, i) => (
        <circle key={i} cx={(k.t / dur) * w} cy={(1 - k.v) * h} r={3.5}
          fill="#fff" stroke="#2A2A2A" strokeWidth="1" style={{ cursor: 'grab', pointerEvents: 'all' }}
          onPointerDown={(e) => {
            e.stopPropagation();
            if (e.ctrlKey && e.altKey) {
              store.commit(() => undefined, { history: true });
              commitKeys(keys.filter((_, j) => j !== i), false);
              return;
            }
            store.commit(() => undefined, { history: true });
            // FIX B1 #5: capture the block NOW — the window pointermove
            // handler used to read e.currentTarget from this pointerdown
            // event, which is null by move time, so every drag threw
            // "Cannot read properties of null (reading 'closest')".
            const dragBlock = (e.currentTarget as unknown as HTMLElement).closest('.clip-block') as HTMLElement | null;
            const move = (ev: PointerEvent) => {
              const block = dragBlock;
              if (!block) return;
              const r = block.getBoundingClientRect();
              const t = clamp(((ev.clientX - r.left) / r.width) * dur, 0, dur);
              const v = clamp(1 - (ev.clientY - r.top) / r.height, 0, 1.5);
              const next = keys.map((kk, j) => (j === i ? { t: Math.round(t * 100) / 100, v: Math.round(v * 100) / 100 } : kk));
              commitKeys(next, false);
            };
            const up = () => {
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }} />
      ))}
    </svg>
  );
}
