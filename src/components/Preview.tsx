import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import type { AdjustmentClip, AudioClip, CompoundClip, Grade, Project, TextClip, VideoClip } from '../types';
import { clipDuration, projectDuration, resolveShadow, resolveTextStyle } from '../types';
import { arcLayout, clipAtTime, evalText, evalTransform, sourceTimeAt, speedRateAt, volumeAt } from '../engine/compose';
import { getMediaRuntime, getPreviewQuality, pickRuntimeUrl, setPreviewQuality, subscribePreviewQuality, type PreviewQuality } from '../services/mediaStore';
import { loadGuides, saveGuides } from '../services/guides';
import { grabStageStill } from '../services/stillGrab';
import { addGalleryStill, subscribeCompare } from '../services/gallery';
import { scopesDockOpen, setScopesDock, subscribeScopesDock } from '../services/scopesDock';
import Scopes from './Scopes';
import Switch from './Switch';

import { playback } from '../engine/playback';
import { clearRange, findClip, setActiveAngle, setRangeInAtPlayhead, setRangeOutAtPlayhead } from '../state/actions';
import CoverMaker from './CoverMaker';
import { buildFilterSpec, gradeIsIdentity, gradeLayersOf, stackHasEffect } from '../services/grade';
import { maskAt } from '../engine/compose';
import type { ClipMask, GradeKey } from '../types';
import { matteView, qualifierMaskValue, rgbToHsv, stagePicker } from '../services/qualifier';
import { trackSeed } from '../services/trackSeed';
import { setStemAudible } from '../services/isoPreview';
import { clamp, fmtTime } from '../utils/time';

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: '9:16', w: 720, h: 1280 },
  { label: '16:9', w: 1280, h: 720 },
  { label: '1:1', w: 960, h: 960 },
  { label: '4:5', w: 864, h: 1080 },
];

/** Parse a typed timecode. THE one format (FIX B2 #21): the display
 *  is MM:SS:FF (fmtTime), so typed input reads the same way —
 *  "83" = 83 s, "1:23" = MM:SS, "1:02:03" = MM:SS:FF,
 *  "0:01:02:03" = HH:MM:SS:FF.
 *  (Before, 3 parts parsed as HH:MM:SS while the display showed
 *  MM:SS:FF — typing the displayed timecode back seeked to hours.) */
export function parseTimecode(text: string, fps: number): number | null {
  const parts = text.trim().split(':').map((p) => p.trim());
  if (parts.some((p) => p === '' || isNaN(Number(p)))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 60 + nums[1] + nums[2] / fps;
  if (nums.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps;
  return null;
}

interface DragState {
  clipId: string;
  trackId: string;
  kind: 'text' | 'av';
  mode: 'move' | 'scale' | 'rotate';
  startPx: { x: number; y: number };
  orig: { x: number; y: number; scale: number; rotation: number }; // text: fractions; av: transform px/scale/deg
  centrePx: { x: number; y: number }; // stage-relative centre, for scale/rotate drags
  startDist: number;
  startAngle: number; // radians, for rotate drags
}

type LayerOverride = { clipId: string; x: number; y: number; scale: number; rotation: number };

/**
 * MatteOverlay (D1.2): the qualifier selection drawn as a greyscale
 * matte over the stage. A SAMPLED approximation by design — a 160×90
 * pass over the primary video element through the shared selection
 * formula (services/qualifier.ts); the render applies it exactly.
 * Labelled on stage so the preview never over-promises.
 */
function MatteOverlay({ qkey }: { qkey: GradeKey }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const MW = 160, MH = 90;
    const work = document.createElement('canvas');
    work.width = MW; work.height = MH;
    const wctx = work.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = playback.getPrimaryVideoElement();
      const c = canvasRef.current;
      if (!el || !c || !wctx || el.readyState < 2 || !el.videoWidth) return;
      try {
        wctx.drawImage(el, 0, 0, MW, MH);
        const img = wctx.getImageData(0, 0, MW, MH);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const m = Math.round(qualifierMaskValue(d[i], d[i + 1], d[i + 2], qkey) * 255);
          d[i] = m; d[i + 1] = m; d[i + 2] = m; d[i + 3] = 255;
        }
        if (c.width !== MW) { c.width = MW; c.height = MH; }
        c.getContext('2d')?.putImageData(img, 0, 0);
      } catch { /* element mid-swap: skip this frame */ }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [qkey]);
  return (
    <>
      <canvas ref={canvasRef} aria-hidden
        className="pointer-events-none absolute inset-0 z-30 h-full w-full"
        style={{ imageRendering: 'pixelated' }} />
      <span className="pointer-events-none absolute left-2 top-2 z-30 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tracking-wide text-[#E8C268]">
        MATTE — approximate preview, render is exact
      </span>
    </>
  );
}

/**
 * TrackSeedOverlay (D1.3c): while a track seed is armed (Inspector →
 * Track subject), the stage takes a drag: the rectangle the user draws
 * around the subject becomes the tracker's seed box (canvas fractions).
 * A plain click or Esc cancels; a real drag fires and disarms.
 */
function TrackSeedOverlay() {
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') trackSeed.disarm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const frac = (e: React.PointerEvent, el: HTMLDivElement) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
    };
  };
  return (
    <div
      className="absolute inset-0 z-40"
      style={{ cursor: 'crosshair', background: 'rgba(0,0,0,0.25)' }}
      onPointerDown={(e) => {
        e.stopPropagation();
        const el = e.currentTarget;
        const a = frac(e, el);
        setRect({ x: a.x, y: a.y, w: 0, h: 0 });
        const move = (ev: PointerEvent) => {
          const b = frac(ev as unknown as React.PointerEvent, el);
          setRect({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) });
        };
        const up = (ev: PointerEvent) => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          const b = frac(ev as unknown as React.PointerEvent, el);
          const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
          setRect(null);
          if (box.w >= 0.03 && box.h >= 0.03) trackSeed.fire(box);
          else trackSeed.disarm();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    >
      <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tracking-wide text-[#E8C268]">
        TRACK — drag a box around the subject · Esc cancels
      </span>
      {rect && (
        <div className="pointer-events-none absolute border-2 border-[#E8C268]"
          style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }} />
      )}
    </div>
  );
}

/**
 * AngleStrip (D1.4): the multicam angle strip under the stage. Shows
 * the selected multicam clip's angles (or the one under the playhead);
 * the live angle is highlighted, clicking switches (the clip's window
 * shifts by the sync-offset delta). Keys 1–9 cut instead of switching.
 */
function AngleStrip({ trackId, clip }: { trackId: string; clip: VideoClip }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1.5" role="group" aria-label="Multicam angles">
      <span className="text-[11px] uppercase tracking-wide text-[#a8a8a8]">Angles</span>
      {(clip.angles ?? []).map((a, i) => {
        const active = (clip.activeAngle ?? 0) === i;
        return (
          <button key={i} className="btn small" aria-pressed={active}
            style={active ? { color: '#fff', boxShadow: 'inset 0 -2px 0 #C0C0C0' } : undefined}
            title={a.syncOffset !== undefined ? `Offset vs angle 1: ${a.syncOffset >= 0 ? '+' : ''}${a.syncOffset.toFixed(2)}s` : a.label}
            onClick={() => setActiveAngle(trackId, clip.id, i)}>
            {i + 1} · {a.label}
          </button>
        );
      })}
      <span className="text-[11px] text-[#6f6f6f]">click switches · keys 1–9 cut at the playhead</span>
    </div>
  );
}

/**
 * ViewerToggle (TOGGLE PORT 2026-11-06): a viewer-strip boolean as
 * text label + the canonical Switch primitive. Module-level on
 * purpose — a component defined inside Preview would remount on
 * every render and kill the switch's spring animation. `inMenu`
 * stretches the row (label left, switch right) for the View ▾ panel.
 */
function ViewerToggle({ label, checked, onChange, disabled, title, inMenu }: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  title?: string;
  inMenu?: boolean;
}) {
  return (
    <span className={'inline-flex items-center gap-1.5 ' + (inMenu ? 'w-full justify-between' : '')}>
      <span className="text-[11px] text-[#c9c9c9]">{label}</span>
      <Switch size="sm" checked={checked} onChange={onChange} disabled={disabled} title={title} ariaLabel={label} />
    </span>
  );
}

export default function Preview({ compact = false }: { compact?: boolean } = {}) {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  // D1.2: qualifier matte view + stage eyedropper singletons.
  const matte = useSyncExternalStore(matteView.subscribe, matteView.get);
  const pickerArmed = useSyncExternalStore(stagePicker.subscribe, stagePicker.isArmed);
  // D1.3c: track seed box arming.
  const seedArm = useSyncExternalStore(trackSeed.subscribe, trackSeed.get);
  const [, setTick] = useState(0);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  // The stage is sized explicitly (canvas aspect) by a layout effect, the
  // fit this column actually has — never by the window.
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const [zoomMode, setZoomMode] = useState<'fit' | '50' | '100'>('fit');
  const [safe, setSafe] = useState(false);
  const [cover, setCover] = useState(false);
  const [loopOn, setLoopOn] = useState(playback.loop);
  const [tcEdit, setTcEdit] = useState<string | null>(null);
  const [override, setOverride] = useState<LayerOverride | null>(null);
  const [rulers, setRulers] = useState<boolean>(() => {
    // R8 (UI redesign W2): rulers OFF unless the user turned them on.
    try { return localStorage.getItem('cutlab.rulers') === '1'; } catch { return false; }
  });
  const [quality, setQuality] = useState<PreviewQuality>(() => getPreviewQuality());
  useEffect(() => subscribePreviewQuality(() => setQuality(getPreviewQuality())), []);
  const [guides, setGuides] = useState<{ v: number[]; h: number[] }>(() => loadGuides());
  // D2.7 viewer rebuild: scopes dock + compare wipe state.
  const [dockOpenState, setDockOpenState] = useState<boolean>(() => scopesDockOpen());
  useEffect(() => subscribeScopesDock((o) => setDockOpenState(o)), []);
  // §3.18: a GalleryStrip click loads that still into Compare.
  useEffect(() => subscribeCompare((url) => { setStillUrl(url); setCompareOn(true); }), []);
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [compareOn, setCompareOn] = useState(false);
  const [compareFrac, setCompareFrac] = useState(0.5);
  const [tcWhere, setTcWhere] = useState<'strip' | 'deck'>('deck');
  // FIX A (D3): the viewer strip condenses below ~1100px of strip
  // width — the secondary toggles (Safe/Rulers/Matte/Scopes/Grab
  // still/Compare/Cover/Proxy) move behind a "View ▾" menu instead
  // of running off the stage's right edge (Fullscreen was past the
  // viewport at 1024 Edit, Loop+Fullscreen at 1024 Deliver, and 4–5
  // controls were off-screen at 390). Clip name, zoom, Loop and
  // Fullscreen stay visible at every width. Compact (Audio rail)
  // mode keeps its own wrapping behaviour, untouched.
  const stripRef = useRef<HTMLDivElement>(null);
  const [stripW, setStripW] = useState(0);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const measure = () => setStripW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!viewMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (stripRef.current && !stripRef.current.contains(e.target as Node)) setViewMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setViewMenuOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [viewMenuOpen]);
  const condensed = !compact && stripW > 0 && stripW < 1100;
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => playback.onFrame(() => setTick((v) => v + 1)), []);
  // FIX B2 #1: page entry must show the paused frame at the playhead
  // (and let scopes draw) without waiting for a transport touch.
  useEffect(() => { playback.refresh(); }, []);

  const { canvas } = project;
  const dur = projectDuration(project);
  const t = playback.time;

  // Stage fit: largest canvas-aspect box inside the wrapper (fit mode), or
  // the raw canvas size (100% mode, wrapper scrolls). Recomputed on resize.
  useLayoutEffect(() => {
    const el = stageWrapRef.current;
    if (!el) return;
    const compute = () => {
      if (zoomMode === '100') {
        setStage({ w: canvas.w, h: canvas.h });
        return;
      }
      if (zoomMode === '50') {
        setStage({ w: Math.floor(canvas.w / 2), h: Math.floor(canvas.h / 2) });
        return;
      }
      const availW = Math.max(80, el.clientWidth);
      const availH = Math.max(80, el.clientHeight);
      const scale = Math.min(availW / canvas.w, availH / canvas.h);
      setStage({ w: Math.floor(canvas.w * scale), h: Math.floor(canvas.h * scale) });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas.w, canvas.h, zoomMode]);

  const dispW = stage?.w ?? canvas.w;
  const dispH = stage?.h ?? canvas.h;
  const k = dispW / canvas.w; // canvas px → display px

  // ---- direct manipulation (C.4) ----
  const beginDrag = (
    e: React.PointerEvent,
    payload: Omit<DragState, 'startPx' | 'centrePx' | 'startDist' | 'startAngle'>,
  ) => {
    const stageEl = stageRef.current;
    if (!stageEl) return;
    e.stopPropagation();
    playback.pause();
    store.set({ selected: { trackId: payload.trackId, clipId: payload.clipId } });
    const rect = stageEl.getBoundingClientRect();
    // Element centre in stage px: the dragged wrapper itself; for a scale
    // drag the event target is the corner handle, whose parent is the wrapper.
    const target = e.currentTarget as HTMLElement;
    const host = payload.mode === 'move' ? target : (target.parentElement ?? target);
    const hr = host.getBoundingClientRect();
    const centreStagePx = { x: hr.left - rect.left + hr.width / 2, y: hr.top - rect.top + hr.height / 2 };
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    dragRef.current = {
      ...payload,
      startPx: px,
      centrePx: centreStagePx,
      startDist: Math.max(8, Math.hypot(px.x - centreStagePx.x, px.y - centreStagePx.y)),
      startAngle: Math.atan2(px.y - centreStagePx.y, px.x - centreStagePx.x),
    };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const r = stageEl.getBoundingClientRect();
      const cur = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      if (d.mode === 'rotate') {
        const ang = Math.atan2(cur.y - d.centrePx.y, cur.x - d.centrePx.x);
        let deg = d.orig.rotation + ((ang - d.startAngle) * 180) / Math.PI;
        if (!ev.altKey) deg = Math.round(deg / 15) * 15; // 15° snap; Alt = free
        setOverride({ clipId: d.clipId, x: d.orig.x, y: d.orig.y, scale: d.orig.scale, rotation: deg });
        return;
      }
      if (d.mode === 'scale') {
        const dist = Math.max(8, Math.hypot(cur.x - d.centrePx.x, cur.y - d.centrePx.y));
        const scale = clamp(d.orig.scale * (dist / d.startDist), 0.05, 8);
        setOverride({ clipId: d.clipId, x: d.orig.x, y: d.orig.y, scale, rotation: d.orig.rotation });
        return;
      }
      const dxPx = cur.x - d.startPx.x;
      const dyPx = cur.y - d.startPx.y;
      if (Math.abs(dxPx) + Math.abs(dyPx) > 3) suppressClick.current = true;
      if (d.kind === 'text') {
        let nx = d.orig.x + dxPx / r.width;
        let ny = d.orig.y + dyPx / r.height;
        if (!ev.altKey) { // grid snap: 1/24 of frame; Alt = free
          nx = Math.round(nx * 24) / 24;
          ny = Math.round(ny * 24) / 24;
        }
        setOverride({ clipId: d.clipId, x: clamp(nx, 0, 1), y: clamp(ny, 0, 1), scale: 1, rotation: 0 });
      } else {
        const w = r.width / (store.get().project.canvas.w || 1);
        let nx = d.orig.x + dxPx / w;
        let ny = d.orig.y + dyPx / w;
        if (!ev.altKey) {
          const stepX = store.get().project.canvas.w / 24;
          const stepY = store.get().project.canvas.h / 24;
          nx = Math.round(nx / stepX) * stepX;
          ny = Math.round(ny / stepY) * stepY;
        }
        setOverride({ clipId: d.clipId, x: nx, y: ny, scale: d.orig.scale, rotation: d.orig.rotation });
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = dragRef.current;
      dragRef.current = null;
      setOverride((ov) => {
        if (d && ov && ov.clipId === d.clipId) {
          store.commit((draft) => {
            const tr = draft.tracks.find((x) => x.id === d.trackId);
            const clip = tr?.clips.find((c) => c.id === d.clipId);
            if (!clip) return;
            if (d.kind === 'text') {
              const tc = clip as TextClip;
              tc.x = ov.x;
              tc.y = ov.y;
            } else {
              const vc = clip as VideoClip;
              // M.11 auto-key: with keyframes present (or Auto-key on), a drag
              // at this playhead position writes a keyframe capturing the
              // dragged pose instead of moving the base transform.
              const local = playback.time - vc.start;
              const hasKfs = (vc.keyframes ?? []).length > 0;
              if ((store.get().autoKey || hasKfs) && local >= 0 && local <= clipDuration(vc)) {
                const cur = evalTransform(vc, local);
                const kt = Math.round(local * store.get().project.canvas.fps) / store.get().project.canvas.fps;
                const kfs = (vc.keyframes ?? []).filter((k) => Math.abs(k.t - kt) > 1e-6);
                kfs.push({
                  t: kt,
                  x: ov.x, y: ov.y, scale: ov.scale,
                  rotation: ov.rotation, opacity: cur.opacity,
                  ease: 'easeInOut',
                });
                kfs.sort((a, b) => a.t - b.t);
                vc.keyframes = kfs;
              } else {
                vc.transform.x = ov.x;
                vc.transform.y = ov.y;
                vc.transform.scale = ov.scale;
                vc.transform.rotation = ov.rotation;
              }
            }
          });
        }
        return null;
      });
      setTimeout(() => { suppressClick.current = false; }, 60);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // O.4: the selected clip's mask gets an on-canvas editor overlay.
  const selFound = selected ? findClip(project, selected.trackId, selected.clipId) : { track: undefined, clip: undefined };
  // D2.7 (V.2): the strip's clip name (selected clip, else the topmost
  // video clip under the playhead) + the selected clip's qualifier key
  // for the Matte toggle.
  const selKey = selFound.clip && 'grades' in selFound.clip
    ? (selFound.clip as VideoClip).grades?.find((g) => g.key)?.key
    : undefined;
  const topClipAtPlayhead = (() => {
    for (let i = project.tracks.length - 1; i >= 0; i--) {
      const tr = project.tracks[i];
      if (tr.kind !== 'video' || tr.hidden) continue;
      const c = tr.clips.find((cl) => 'media' in cl && t >= cl.start && t < cl.start + clipDuration(cl));
      if (c) return c as VideoClip;
    }
    return undefined;
  })();
  const nameOfClip = (c?: VideoClip): string => {
    if (!c) return project.name;
    const m = project.media.find((mm) => mm.id === c.media);
    return m?.src ?? project.name;
  };
  const currentClipName = nameOfClip((selFound.clip as VideoClip | undefined) ?? topClipAtPlayhead);
  // R7 (UI redesign W2): proxy-fallback badge data — the active clip's
  // runtime, and whether any project media has a proxy at all (the
  // quality menu marks the Proxy option when none does).
  const badgeClip = (selFound.clip as VideoClip | undefined) ?? topClipAtPlayhead;
  const badgeRt = badgeClip?.media ? getMediaRuntime(badgeClip.media) : undefined;
  const proxyFellBack = !!badgeRt && quality !== 'original' && !badgeRt.proxyUrl;
  const anyProxy = project.media.some((m) => getMediaRuntime(m.id)?.proxyUrl);
  // D1.4: the multicam clip the angle strip drives — the selected one,
  // else the one under the playhead.
  const angleClip = ((): { trackId: string; clip: VideoClip } | null => {
    const selClip = selFound.clip as VideoClip | undefined;
    if (selClip?.angles?.length && selFound.track) return { trackId: selFound.track.id, clip: selClip };
    for (const tr of project.tracks) {
      if (tr.kind !== 'video') continue;
      for (const c of tr.clips) {
        const vc = c as VideoClip;
        if (vc.angles?.length && t >= vc.start && t < vc.start + clipDuration(vc)) {
          return { trackId: tr.id, clip: vc };
        }
      }
    }
    return null;
  })();
  const selMaskClip = selFound.clip && 'mask' in selFound.clip ? (selFound.clip as VideoClip) : null;
  const selMaskTrackId = selFound.track?.id ?? null;
  // Text layers keep their own pass (array order, as before).
  const textLayers: { clip: TextClip; trackId: string }[] = [];
  for (const track of project.tracks) {
    if (track.hidden) continue; // E.7: hidden tracks render nothing
    if (track.kind !== 'text') continue;
    const clip = clipAtTime(track.clips, t);
    if (clip) textLayers.push({ clip: clip as TextClip, trackId: track.id });
  }
  // Visual stack, bottom → top (= reverse track order: the first track in
  // the list is the top layer — the documented model, now applied uniformly
  // to images too, which previously always painted above every video).
  // Adjustment clips fold over everything beneath them (foldAdjustments).
  const visualItems: VisualItem[] = [];
  let hasVideoLike = false;
  for (let ti = project.tracks.length - 1; ti >= 0; ti--) {
    const track = project.tracks[ti];
    if (track.hidden || track.kind !== 'video') continue;
    const clip = clipAtTime(track.clips, t);
    if (!clip) continue;
    if ('adj' in clip) {
      visualItems.push({ key: clip.id, adj: clip });
      continue;
    }
    if ('nest' in clip) {
      hasVideoLike = true;
      visualItems.push({
        key: clip.id,
        node: (
          <CompoundLayer key={clip.id} clip={clip} time={t} k={k}
            dispW={dispW} dispH={dispH} depth={0}
            volIn={(track.volume ?? 1) * (track.muted ? 0 : 1)} />
        ),
      });
      continue;
    }
    const vc = clip as VideoClip;
    const m = project.media.find((x) => x.id === vc.media);
    if (m?.kind === 'image') {
      visualItems.push({
        key: clip.id,
        node: (
          <ImageLayerView key={clip.id} clip={vc} trackId={track.id} time={t} k={k}
            selected={selected?.clipId === vc.id}
            override={override?.clipId === vc.id ? override : null}
            onDragStart={beginDrag} />
        ),
      });
    } else {
      hasVideoLike = true;
      visualItems.push({
        key: clip.id,
        node: (
          <VideoLayer key={track.id} clip={vc} trackId={track.id} time={t} k={k}
            selected={selected?.clipId === vc.id}
            override={override?.clipId === vc.id ? override : null}
            onDragStart={beginDrag} />
        ),
      });
    }
  }
  const visualStack = foldAdjustments(visualItems);

  // R6 (UI redesign W2): when a clip IS under the playhead but no frame
  // can be drawn, the stage says why (media missing / still loading)
  // instead of sitting black. Polled, because element readiness is not
  // React state.
  const [frameNotice, setFrameNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!hasVideoLike) { setFrameNotice(null); return; }
    const check = () => {
      let missing = false;
      let anyRt = false;
      for (const tr of project.tracks) {
        if (tr.hidden || tr.kind !== 'video') continue;
        const c = clipAtTime(tr.clips, t);
        if (!c || 'adj' in c || 'nest' in c) continue;
        const vc = c as VideoClip;
        const m = project.media.find((x) => x.id === vc.media);
        if (m?.kind === 'image') continue;
        if (getMediaRuntime(vc.media)) anyRt = true; else missing = true;
      }
      const el = playback.getPrimaryVideoElement();
      if (missing && !anyRt) setFrameNotice('Media missing for this clip — relink or re-import it in the Media bin.');
      else if (!el || (el.readyState < 2 && !el.videoWidth)) setFrameNotice('Still loading the frame…');
      else setFrameNotice(null);
    };
    check();
    const id = window.setInterval(check, 600);
    return () => window.clearInterval(id);
  }, [t, hasVideoLike, project]);

  const submitTimecode = () => {
    if (tcEdit === null) return;
    const v = parseTimecode(tcEdit, canvas.fps);
    if (v !== null) playback.seek(v);
    setTcEdit(null);
  };

  // FIX A (D3): the secondary viewer controls, rendered ONCE and
  // placed either inline (wide strip) or inside the View menu
  // (condensed strip) — same handlers, same pressed/disabled states.
  const renderSecondary = (inMenu: boolean) => (
    <>
      <ViewerToggle label="Safe" checked={safe} inMenu={inMenu}
        onChange={(v) => setSafe(v)} title="Action-safe (90%) and title-safe (80%) guides" />
      <ViewerToggle label="Rulers" checked={rulers} inMenu={inMenu}
        onChange={(v) => {
          setRulers(v);
          try { localStorage.setItem('cutlab.rulers', v ? '1' : '0'); } catch { /* ignore */ }
        }} title="Stage rulers in canvas units (C.7)" />
      {inMenu ? (
        selKey && selected && (
          <ViewerToggle label="Matte" checked={matte?.clipId === selected.clipId} inMenu
            onChange={(v) => matteView.set(v ? { clipId: selected.clipId, key: selKey } : null)}
            title="Qualifier matte view" />
        )
      ) : (
        <span style={{ width: 76 }} className="flex justify-center">
          {selKey && selected && (
            <ViewerToggle label="Matte" checked={matte?.clipId === selected.clipId}
              onChange={(v) => matteView.set(v ? { clipId: selected.clipId, key: selKey } : null)}
              title="Qualifier matte view" />
          )}
        </span>
      )}
      <ViewerToggle label="Scopes" checked={dockOpenState} inMenu={inMenu}
        onChange={(v) => setScopesDock(v)} title="Scopes dock under the viewer (V.5)" />
      <button className="btn small"
        onClick={() => {
          const fc = grabStageStill(canvas.w, canvas.h);
          if (fc) {
            const url = fc.toDataURL('image/png');
            setStillUrl(url);
            addGalleryStill(url);
            store.toastMsg('info', 'Still grabbed — Compare shows it against the program.');
          }
          else store.toastMsg('error', 'No frame to grab yet — play or scrub to a frame first.');
        }} title="Grab the current frame as the compare still (V.4)">Grab still</button>
      <ViewerToggle label="Compare" checked={compareOn} disabled={!stillUrl} inMenu={inMenu}
        onChange={(v) => setCompareOn(v)} title="Compare wipe: still vs program (V.4)" />
      <button className="btn small" onClick={() => setCover(true)} title="Grab this frame as a cover/thumbnail (Q.11)">Cover</button>
      <select className="field" style={inMenu ? { fontSize: 11 } : { padding: '1px 4px', fontSize: 11 }} value={quality}
        title="Preview quality: Proxy (light files), Half (proxy at half decode raster), Original (full-res)"
        aria-label="Preview quality"
        onChange={(e) => setPreviewQuality(e.target.value as PreviewQuality)}>
        <option value="proxy">{anyProxy ? 'Proxy' : 'Proxy — not made yet'}</option>
        <option value="half">Half</option>
        <option value="original">Original</option>
      </select>
      {(guides.v.length > 0 || guides.h.length > 0) && (
        <button className="btn small" title="Remove all guide lines"
          onClick={() => { const g = { v: [], h: [] }; setGuides(g); saveGuides(g); }}>Clear guides</button>
      )}
    </>
  );

  return (
    <section className={'flex min-h-0 min-w-0 flex-1 flex-col bg-[#1b1b1b]' + (compact ? ' overflow-hidden' : '')}>
      {/* Viewer toolbar strip (D2.7 V.2): one 28 px strip, Resolve
          grammar in our language — left clip + record TC, centre zoom,
          right overlay toggles in fixed slots (TOGGLE PORT 2026-11-06:
          label + canonical Switch; badges never shift the layout).
          Compact (rail) mode —
          the Audio page's 264 px viewer — wraps the same controls onto
          extra rows instead of letting the strip's min-content width
          push the rail past the viewport edge (the W12 clip defect). */}
      <div ref={stripRef} className={'flex items-center gap-1.5 px-2 ' + (compact ? 'shrink-0 flex-wrap py-1' : 'h-7')} role="toolbar" aria-label="Viewer">
        <div className="flex min-w-0 items-center gap-2" style={{ flex: compact ? '1 1 100%' : '1 1 0' }}>
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#c9c9c9]" title={currentClipName}>{currentClipName}</span>
          {/* R9 (UI redesign W2): one timecode only — current / total at
              the transport deck's left. The strip keeps the clip name. */}
        </div>
        <div className="flex items-center gap-1.5">
          <select className="field" value={zoomMode} onChange={(e) => setZoomMode(e.target.value as 'fit' | '50' | '100')}
            aria-label="Viewer zoom" title="Viewer zoom">
            <option value="fit">Fit</option>
            <option value="50">50%</option>
            <option value="100">100%</option>
          </select>
          <span className="font-mono text-[11px] text-[#a8a8a8]">{Math.round(k * 100)}%</span>
        </div>
        <div className={'flex items-center gap-1.5 ' + (compact ? 'flex-wrap' : '')} style={compact ? { flex: '1 1 auto', justifyContent: 'flex-start' } : { flex: '1 1 0', justifyContent: 'flex-end' }}>
          {/* FIX A (D3): wide strip renders the secondary controls
              inline (the pre-FIX-A layout, unchanged); the condensed
              strip groups them behind View ▾; compact keeps Scopes
              only, exactly as the Audio-rail fix left it. Loop and
              Fullscreen stay visible in every mode. */}
          {!compact && !condensed && renderSecondary(false)}
          {!compact && condensed && (
            <div className="relative">
              <button className="btn small" aria-haspopup="menu" aria-expanded={viewMenuOpen}
                style={viewMenuOpen ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
                onClick={() => setViewMenuOpen(!viewMenuOpen)} title="Viewer options — safe areas, rulers, scopes, stills, quality">View ▾</button>
              {viewMenuOpen && (
                <div className="viewer-menu-panel absolute right-0 top-full z-40 mt-1 flex w-[180px] flex-col gap-1 rounded-md border border-[#3a3a3a] bg-[#262626] p-1.5 shadow-2xl" role="menu">
                  {renderSecondary(true)}
                </div>
              )}
            </div>
          )}
          {compact && (<ViewerToggle label="Scopes" checked={dockOpenState}
            onChange={(v) => setScopesDock(v)} title="Scopes dock under the viewer (V.5)" />)}
          <ViewerToggle label="Loop" checked={loopOn}
            onChange={(v) => { playback.loop = v; setLoopOn(v); }} title="Loop playback" />
          <button className="btn small" onClick={() => void viewerRef.current?.requestFullscreen?.()} title="Fullscreen viewer">Fullscreen</button>
        </div>
      </div>
      <div
        ref={viewerRef}
        className="flex min-h-0 flex-1 flex-col bg-[#1b1b1b]"
        style={compact ? { minHeight: 120 } : undefined}
      >
        <div
          ref={stageWrapRef}
          className={'flex min-h-0 flex-1 items-center justify-center ' + (compact ? 'p-2 ' : 'p-3 ') + (zoomMode === '100' ? 'overflow-auto' : 'overflow-hidden')}
          onClick={() => {
            if (suppressClick.current) return;
            if (playback.playing) playback.pause(); else playback.play();
          }}
        >
          <SharpenDefs />
          <GradeDefs project={project} />
          <div className="relative shrink-0" style={{ width: dispW + (rulers ? 16 : 0), height: dispH + (rulers ? 16 : 0) }}>
            {rulers && <RulerH dispW={dispW} canvasW={canvas.w} k={k}
              onAddGuide={(frac) => { const g = { ...guides, v: [...guides.v, frac].sort((a, b) => a - b) }; setGuides(g); saveGuides(g); }} />}
            {rulers && <RulerV dispH={dispH} canvasH={canvas.h} k={k}
              onAddGuide={(frac) => { const g = { ...guides, h: [...guides.h, frac].sort((a, b) => a - b) }; setGuides(g); saveGuides(g); }} />}
            <div
              ref={stageRef}
              className="absolute overflow-hidden rounded-sm shadow-2xl"
              style={{
                left: rulers ? 16 : 0, top: rulers ? 16 : 0,
                width: dispW, height: dispH, background: project.canvas.bg ?? '#000',
                filter: gradeIsIdentity(project.look) ? undefined : 'url(#cl-look)',
                cursor: pickerArmed ? 'crosshair' : undefined,
              }}
              role="img"
              aria-label="Program monitor"
              onClick={(e) => {
                // D1.2 eyedropper: an armed pick consumes the click
                // (never toggles playback) and samples the pixel under
                // the cursor from the primary video element, mapped
                // through the stage's cover fit.
                if (!stagePicker.isArmed()) return;
                e.stopPropagation();
                const el = playback.getPrimaryVideoElement();
                const rect = stageRef.current?.getBoundingClientRect();
                if (!el || !rect || !el.videoWidth) { stagePicker.disarm(); return; }
                const vw = el.videoWidth, vh = el.videoHeight;
                const scale = Math.max(rect.width / vw, rect.height / vh);
                const ox = (rect.width - vw * scale) / 2, oy = (rect.height - vh * scale) / 2;
                const sx = Math.min(vw - 1, Math.max(0, (e.clientX - rect.left - ox) / scale));
                const sy = Math.min(vh - 1, Math.max(0, (e.clientY - rect.top - oy) / scale));
                const cv = document.createElement('canvas');
                cv.width = 1; cv.height = 1;
                const cx = cv.getContext('2d', { willReadFrequently: true });
                if (!cx) { stagePicker.disarm(); return; }
                cx.drawImage(el, sx, sy, 1, 1, 0, 0, 1, 1);
                const px = cx.getImageData(0, 0, 1, 1).data;
                stagePicker.fire(rgbToHsv(px[0], px[1], px[2])[0]);
              }}
            >
            {!hasVideoLike && (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-[#5a5a5a]">
                {/* FIX C: with no clips anywhere there is no playhead
                    position that could show video — the copy must not
                    suggest moving it. The with-clips variant (a gap
                    between clips) keeps its line. */}
                {project.tracks.some((tr) => tr.clips.length > 0)
                  ? 'No video at the playhead — add media, or move the playhead over a clip.'
                  : 'No video at the playhead — add media to the timeline to see it here.'}
              </div>
            )}
            {hasVideoLike && frameNotice && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6 text-center text-[12px] text-[#a8a8a8]">
                {frameNotice}
              </div>
            )}
            {/* R7 (W2, placement adjusted in W3): the proxy-fallback
                badge rides the stage's top-left corner — the same chip
                family as the matte/picker badges — because the strip
                has no fixed slot wide enough at 1400 px: name + badge
                + clusters overflowed and the clip name vanished. Same
                text, same trigger, never shifts any layout. */}
            {proxyFellBack && (
              <span className="pointer-events-none absolute left-2 top-2 z-20 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tracking-wide text-[#E8C268]"
                title="No proxy exists for this clip yet — the stage is playing the original file. Run a media job to make proxies.">
                Proxy not ready — showing original
              </span>
            )}
            {visualStack}

            {textLayers.map(({ clip, trackId }) => (
              <TextLayerView key={clip.id} clip={clip} trackId={trackId} time={t}
                dispW={dispW} dispH={dispH}
                override={override?.clipId === clip.id ? override : null}
                onDragStart={beginDrag} />
            ))}
            {selMaskClip?.mask && (
              <MaskEditOverlay clip={selMaskClip} trackId={selMaskTrackId!} dispW={dispW} dispH={dispH} time={t} />
            )}
            {safe && (
              <div className="pointer-events-none absolute inset-0 z-10" aria-hidden>
                <div className="absolute border border-dashed border-white/35" style={{ inset: '5%' }} />
                <div className="absolute border border-white/50" style={{ inset: '10%' }} />
                <div className="absolute left-1/2 top-0 h-full w-px bg-white/25" />
                <div className="absolute left-0 top-1/2 h-px w-full bg-white/25" />
              </div>
            )}
            {matte && selected?.clipId === matte.clipId && <MatteOverlay qkey={matte.key} />}
            {seedArm && <TrackSeedOverlay />}
            {(guides.v.length > 0 || guides.h.length > 0) && (
              <GuidesOverlay guides={guides} dispW={dispW} dispH={dispH}
                onChange={(g) => { setGuides(g); saveGuides(g); }} />
            )}
            {compareOn && stillUrl && (
              <>
                <img src={stillUrl} alt="" draggable={false} aria-hidden
                  className="pointer-events-none absolute inset-0 z-[15] h-full w-full"
                  style={{ clipPath: `inset(0 ${(1 - compareFrac) * 100}% 0 0)` }} />
                <span className="pointer-events-none absolute left-1.5 top-1.5 z-[16] rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-[#c0c0c0]">Still</span>
                <span className="pointer-events-none absolute right-1.5 top-1.5 z-[16] rounded bg-black/70 px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-[#e8c268]">Live</span>
                <div className="absolute top-0 z-40 h-full" style={{ left: `calc(${compareFrac * 100}% - 5px)`, width: 10, cursor: 'ew-resize', touchAction: 'none' }}
                  role="slider" aria-label="Compare wipe position" aria-valuenow={Math.round(compareFrac * 100)}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    const stageEl = e.currentTarget.parentElement!;
                    const move = (ev: PointerEvent) => {
                      const r = stageEl.getBoundingClientRect();
                      setCompareFrac(Math.min(0.995, Math.max(0.005, (ev.clientX - r.left) / r.width)));
                    };
                    const up = () => {
                      window.removeEventListener('pointermove', move);
                      window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up);
                  }}>
                  <div className="absolute left-[4px] top-0 h-full w-[2px] bg-[#E8C268]" />
                  <div className="absolute left-0 top-1/2 h-6 w-[10px] -translate-y-1/2 rounded-sm border border-[#8a7433] bg-[#2a2a2a]" />
                </div>
              </>
            )}
            </div>
          </div>
        </div>
      </div>
      {angleClip && <AngleStrip trackId={angleClip.trackId} clip={angleClip.clip} />}
      {/* Scopes dock (D2.7 V.5): the Colour scopes' second home, under
          the viewer. Height animates over 200 ms like the collapse
          bars; App takes the height from the timeline first. */}
      {/* FIX B2 #16 (DECK LAST): in the compact rail the dock is the
          FIRST thing to give — capped, shrinkable, internally
          scrolling — before the stage floor (120 px, on viewerRef
          above) or the shrink-0 transport deck below can be touched. */}
      {/* OVERFLOW FIX (2026-11-06): the dock takes the compact
          variant's height contract in BOTH variants now — auto
          height capped at 148, internally scrolling, row wrapping.
          The old non-compact fixed 92 px + nowrap row cut the
          scopes mid-canvas whenever the viewer column was narrow
          (the row is ~460 px wide and cannot shrink). */}
      <div className={'shrink-0 transition-[height] duration-200 ease-in-out motion-reduce:transition-none ' + (dockOpenState ? 'overflow-y-auto' : 'overflow-hidden')}
        style={{ height: dockOpenState ? 'auto' : 0, flexShrink: 1, minHeight: 0, maxHeight: dockOpenState ? 148 : 0 }} aria-hidden={!dockOpenState}>
        <div className={'flex flex-wrap items-start gap-3 px-3 pt-1.5 pb-1.5 ' + (compact ? 'justify-start' : 'justify-center')}>
          <span className="pt-1 font-mono text-[11px] uppercase tracking-wide text-[#a8a8a8]">Scopes</span>
          <Scopes />
        </div>
      </div>
      {/* Audio tracks get hidden elements the engine drives (they had none:
          audio clips were silent in preview before this). */}
      {project.tracks.filter((tr) => tr.kind === 'audio').map((tr) => (
        <AudioLayer key={tr.id} trackId={tr.id} />
      ))}
      {/* Slim transport (2026-11-06 fix): the jog strip is now a 7 px
          scrub bar riding directly on top of the deck, so deck + jog
          read as ONE compact row (~40 px) instead of a ~95 px stack. */}
      <JogStrip dur={dur} />
      {/* Transport deck (D2.7 V.3): the Resolve grammar as one centred
          deck — jog back / reverse / stop / play / jog forward, with
          the J/K/L shuttle as its engine. Held jog escalates ×1 ×2 ×4
          (the rate chip reports it); release stops. */}
      {/* OVERFLOW FIX (2026-11-06, user report "parts go out of
          the display"): the non-compact deck was ONE nowrap row of
          shrink-0 groups (~760 px min-content). In a narrower
          viewer column — Deliver's viewer under ~1150 px windows,
          Edit's under ~1030 px, and every phone — the canvas/FPS
          selects and the I/O group painted past the right edge,
          unreachable. The deck now wraps like the compact variant:
          at full width it is the same single 33 px row; narrow
          columns stack the selects onto a second row instead of
          pushing them off-screen. */}
      {/* COMPACT DECK (2026-11-06, user screenshot + verdict "isnt
          this waste of space too?"): the two flex-1 spacers that
          spread the groups across the row are gone — the deck is
          ONE centred cluster with consistent 8px gaps (timecode ·
          meter · transport · I/O · preset · fps), the meter runs
          at 48px and the selects at fixed compact widths, so the
          single row fits at desktop widths (~804px min-content,
          was ~920px + spread). flex-wrap STAYS for narrow columns:
          groups wrap to a second row rather than painting
          off-screen (the overflow fix above is preserved). */}
      <div className={'flex items-center gap-2 ' + (compact ? 'shrink-0 flex-wrap px-2 pb-1 pt-1' : 'min-h-[36px] shrink-0 flex-wrap justify-center px-3')}>
        {tcEdit !== null && tcWhere === 'deck' ? (
          <input
            className="field font-mono"
            style={{ width: 110 }}
            value={tcEdit}
            autoFocus
            aria-label="Go to timecode"
            onChange={(e) => setTcEdit(e.target.value)}
            onBlur={submitTimecode}
            onKeyDown={(e) => { if (e.key === 'Enter') submitTimecode(); if (e.key === 'Escape') setTcEdit(null); }}
          />
        ) : (
          <button className="shrink-0 whitespace-nowrap font-mono text-[12px] text-[#e8e8e8]" title="Click to type a timecode — format MM:SS:FF (also accepts SS, MM:SS, HH:MM:SS:FF)"
            onClick={() => { setTcWhere('deck'); setTcEdit(fmtTime(t, canvas.fps)); }}>
            {fmtTime(t, canvas.fps)} <span className="text-[#6f6f6f]">/ {fmtTime(dur, canvas.fps)}</span>
          </button>
        )}
        <LevelMeter width={compact ? 64 : 48} />
        {playback.rate !== 1 && (
          <span className="rounded bg-[#333] px-1.5 py-0.5 font-mono text-[11px] text-[#e8c268]">
            {playback.rate < 0 ? `◂◂ ${Math.abs(playback.rate)}×` : `${playback.rate}× ▸▸`}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Transport">
          <button className="btn small" onClick={() => playback.seek(0)} title="Go to start">|◂</button>
          <button className="btn small" onClick={() => playback.step(-1, canvas.fps)} title="Previous frame (←)">◂</button>
          <JogButton dir={-1} title="Play reverse — hold to shuttle faster (J)">◂◂</JogButton>
          <button className="btn small" onClick={() => playback.pause()} title="Stop (K)">■</button>
          <button
            className="btn small"
            style={{ minWidth: 56 }}
            onClick={() => (playback.playing ? playback.pause() : playback.play())}
          >
            {playback.playing ? 'Pause' : 'Play'}
          </button>
          <JogButton dir={1} title="Play forward — hold to shuttle faster (L)">▸▸</JogButton>
          <button className="btn small" onClick={() => playback.step(1, canvas.fps)} title="Next frame (→)">▸</button>
          <button className="btn small" onClick={() => playback.seek(dur)} title="Go to end">▸|</button>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button className="btn small" aria-label="Mark range in at playhead" onClick={() => setRangeInAtPlayhead()} title="Mark range in at playhead (I)">I</button>
          <button className="btn small" aria-label="Mark range out at playhead" onClick={() => setRangeOutAtPlayhead()} title="Mark range out at playhead (O)">O</button>
          {project.rangeIn != null && project.rangeOut != null ? (
            <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-[#333] px-1.5 py-0.5 font-mono text-[11px] text-[#e8e8e8]">
              range {(project.rangeOut - project.rangeIn).toFixed(2)}s
              <button className="text-[#a8a8a8] hover:text-white" title="Clear range" onClick={() => clearRange()}>×</button>
            </span>
          ) : (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-[#6f6f6f]">{dur.toFixed(2)}s total</span>
          )}
        </div>
        {!compact && (<><select
          className="field shrink-0"
          style={{ padding: '1px 4px', fontSize: 11, width: 132 }}
          aria-label="Canvas size preset"
          value={PRESETS.findIndex((p) => p.w === canvas.w && p.h === canvas.h) >= 0
            ? PRESETS.findIndex((p) => p.w === canvas.w && p.h === canvas.h)
            : 'custom'}
          onChange={(e) => {
            const p = PRESETS[Number(e.target.value)];
            if (p) store.commit((d) => { d.canvas.w = p.w; d.canvas.h = p.h; });
          }}
        >
          <option value="custom" disabled>
            {canvas.w}×{canvas.h}
          </option>
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label} · {p.w}×{p.h}
            </option>
          ))}
        </select>
        <select
          className="field shrink-0"
          style={{ padding: '1px 4px', fontSize: 11, width: 78 }}
          aria-label="Frames per second"
          value={canvas.fps}
          onChange={(e) => store.commit((d) => { d.canvas.fps = Number(e.target.value); })}
        >
          {[24, 25, 30, 50, 60].map((f) => (
            <option key={f} value={f}>{f} fps</option>
          ))}
        </select></>)}
      </div>
      {cover && <CoverMaker onClose={() => setCover(false)} />}
    </section>
  );
}

/**
 * JogButton (D2.7 V.3): press = shuttle at ×1; keep holding and the
 * shuttle escalates ×2 then ×4 (playback.shuttle steps the rate; the
 * deck's rate chip shows it). Release = stop (pause resets the rate).
 */
function JogButton({ dir, title, children }: { dir: 1 | -1; title: string; children: React.ReactNode }) {
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach((id) => window.clearTimeout(id)); timers.current = []; };
  return (
    <button className="btn small"
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        playback.shuttle(dir);
        timers.current.push(window.setTimeout(() => playback.shuttle(dir), 550));
        timers.current.push(window.setTimeout(() => playback.shuttle(dir), 1150));
      }}
      onPointerUp={() => { clear(); playback.pause(); }}
      onPointerLeave={() => { if (timers.current.length) { clear(); playback.pause(); } }}
      onPointerCancel={() => { clear(); playback.pause(); }}
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </button>
  );
}

/**
 * JogStrip (D2.7 V.3): the jog-wheel strip — drag to scrub; the
 * pointer's speed sets the scrub rate (faster drag = bigger time
 * steps). A centre detent line marks the strip's middle. Playback
 * pauses during the drag and resumes after if it was playing.
 */
function JogStrip({ dur }: { dur: number }) {
  const drag = useRef<{ x: number; at: number; wasPlaying: boolean } | null>(null);
  return (
    <div
      className="relative mx-3 mt-1 h-[7px] shrink-0 cursor-ew-resize touch-none rounded-sm border border-[#2c2c2c] bg-[#141414]"
      style={{ backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 11px, #242424 11px 12px)' }}
      title="Jog strip — drag to scrub (faster = coarser)"
      role="slider" aria-label="Jog strip" aria-valuemin={0} aria-valuemax={Math.round(dur * 100) / 100}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { x: e.clientX, at: performance.now(), wasPlaying: playback.playing };
        playback.pause();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const now = performance.now();
        const dx = e.clientX - d.x;
        const dt = Math.max(1, now - d.at);
        if (dx !== 0) {
          const speed = Math.abs(dx) / dt; // px per ms
          const mult = 0.004 * (1 + Math.min(8, speed * 2));
          playback.seek(Math.min(dur, Math.max(0, playback.time + dx * mult)));
          d.x = e.clientX;
          d.at = now;
        }
      }}
      onPointerUp={() => {
        const was = drag.current?.wasPlaying;
        drag.current = null;
        if (was) playback.play();
      }}
      onPointerCancel={() => { drag.current = null; }}
    >
      <div className="pointer-events-none absolute left-1/2 top-0 h-full w-px bg-[#4a4a4a]" aria-hidden />
    </div>
  );
}

function ScaleHandle({ onDown }: { onDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      className="absolute -bottom-2 -right-2 z-10 h-4 w-4 cursor-nwse-resize touch-none rounded-sm border border-white bg-[#E31000]"
      title="Drag to scale"
      onPointerDown={(e) => { e.stopPropagation(); onDown(e); }}
    />
  );
}

function maskLocal(t: { x: number; y: number; scale: number }, canvas: { width: number; height: number }) {
  // Layer box in canvas fractions (the layer is a 16/9 box in this engine).
  const lw = t.scale;
  const lh = (t.scale * canvas.width * (9 / 16)) / canvas.height;
  const left = 0.5 + t.x / canvas.width - lw / 2;
  const top = 0.5 + t.y / canvas.height - lh / 2;
  return { lw, lh, left, top };
}

/** Mask clip-path / SVG-mask for the layer (§O): geometry may be keyframed
 *  (maskAt); feather + invert go through an SVG luminance mask. */
function maskStyle(clip: VideoClip, t: { x: number; y: number; scale: number }, canvas: { width: number; height: number }, time: number, k: number): { style: React.CSSProperties; defs: React.ReactNode } {
  const base = clip.mask;
  if (!base) return { style: {}, defs: null };
  const mg = maskAt(clip, time) ?? { x: base.x, y: base.y, w: base.w, h: base.h };
  const { lw, lh, left, top } = maskLocal(t, canvas);
  const L = (fx: number) => ((fx - left) / lw) * 100;
  const T = (fy: number) => ((fy - top) / lh) * 100;
  const bandCorners = (): { x: number; y: number }[] => {
    const a = ((base.angle ?? 0) * Math.PI) / 180;
    const dx = Math.cos(a), dy = Math.sin(a);
    const nx = -dy * (base.w / 2), ny = dx * (base.w / 2);
    const cx = mg.x + mg.w / 2, cy = mg.y + mg.h / 2;
    const LEN = 1.6;
    return [
      { x: cx - dx * LEN + nx, y: cy - dy * LEN + ny },
      { x: cx + dx * LEN + nx, y: cy + dy * LEN + ny },
      { x: cx + dx * LEN - nx, y: cy + dy * LEN - ny },
      { x: cx - dx * LEN - nx, y: cy - dy * LEN - ny },
    ];
  };
  const useSvg = base.feather > 0.001 || base.invert;
  if (!useSvg) {
    let cp = '';
    if (base.shape === 'rect') cp = `inset(${T(mg.y)}% ${100 - L(mg.x + mg.w)}% ${100 - T(mg.y + mg.h)}% ${L(mg.x)}%)`;
    else if (base.shape === 'circle') cp = `ellipse(${(mg.w / lw) * 50}% ${(mg.h / lh) * 50}% at ${L(mg.x + mg.w / 2)}% ${T(mg.y + mg.h / 2)}%)`;
    else if (base.shape === 'linear') cp = `polygon(${bandCorners().map((c) => `${L(c.x)}% ${T(c.y)}%`).join(', ')})`;
    else cp = `polygon(${(base.points ?? []).map((pt) => `${L(pt.x)}% ${T(pt.y)}%`).join(', ')})`;
    return { style: { clipPath: cp }, defs: null };
  }
  const wpx = Math.max(2, Math.round(t.scale * canvas.width * k));
  const hpx = Math.max(2, Math.round(wpx * (9 / 16)));
  const id = `cl-fmask-${clip.id}`;
  const shapeEl = (() => {
    const fill = base.invert ? '#000' : '#fff';
    if (base.shape === 'rect') return <rect x={(L(mg.x) / 100) * wpx} y={(T(mg.y) / 100) * hpx} width={(mg.w / lw) * wpx} height={(mg.h / lh) * hpx} fill={fill} />;
    if (base.shape === 'circle') return <ellipse cx={(L(mg.x + mg.w / 2) / 100) * wpx} cy={(T(mg.y + mg.h / 2) / 100) * hpx} rx={(mg.w / lw) * wpx * 0.5} ry={(mg.h / lh) * hpx * 0.5} fill={fill} />;
    if (base.shape === 'linear') return <polygon points={bandCorners().map((c) => `${(L(c.x) / 100) * wpx},${(T(c.y) / 100) * hpx}`).join(' ')} fill={fill} />;
    return <polygon points={(base.points ?? []).map((pt) => `${(L(pt.x) / 100) * wpx},${(T(pt.y) / 100) * hpx}`).join(' ')} fill={fill} />;
  })();
  const blur = Math.max(0.5, base.feather * wpx * 0.5);
  const defs = (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>
        <filter id={`${id}-b`}><feGaussianBlur stdDeviation={blur} /></filter>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width={wpx} height={hpx}>
          <rect x="0" y="0" width={wpx} height={hpx} fill={base.invert ? '#fff' : '#000'} />
          <g filter={base.feather > 0.001 ? `url(#${id}-b)` : undefined}>{shapeEl}</g>
        </mask>
      </defs>
    </svg>
  );
  return { style: { maskImage: `url(#${id})`, WebkitMaskImage: `url(#${id})`, maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat' } as React.CSSProperties, defs };
}

function VideoLayer({ clip, trackId, time, k, selected, override, onDragStart, follower, interactive = true }: {
  clip: VideoClip;
  trackId: string;
  time: number;
  k: number;
  selected: boolean;
  override: LayerOverride | null;
  onDragStart: PreviewDragStart;
  /** Set when the layer lives inside a compound nest: the engine does not
   *  know this track, so a follower sync drives the element instead. */
  follower?: { volumeScale: number };
  interactive?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const bgRef = useRef<HTMLVideoElement>(null);
  const t = evalTransform(clip, time - clip.start);
  const x = override ? override.x : t.x;
  const y = override ? override.y : t.y;
  const scale = override ? override.scale : t.scale;
  const rotation = override ? override.rotation : t.rotation;
  const blurFill = clip.fit === 'blur-fill';

  useEffect(() => {
    if (follower) return; // nested elements are follower-driven, never registered
    playback.registerElement(trackId, ref.current);
    return () => playback.registerElement(trackId, null);
  }, [trackId, follower]);

  useFollowerSync(ref, clip, time, follower);
  useFollowerSync(bgRef, clip, time, follower ? { volumeScale: 0 } : undefined);
  // Blur-fill background at the top level: shadow the engine-driven element
  // (same source, same clock, silent) since only one element per track is
  // registered with the engine.
  useEffect(() => {
    const bg = bgRef.current, fg = ref.current;
    if (!bg || !fg || follower || !blurFill) return;
    bg.muted = true;
    if (fg.src && bg.src !== fg.src) bg.src = fg.src;
    if (fg.readyState >= 1 && Math.abs(bg.currentTime - fg.currentTime) > 0.3) {
      try { bg.currentTime = fg.currentTime; } catch { /* not ready */ }
    }
    bg.playbackRate = fg.playbackRate;
    if (!fg.paused && bg.paused) void bg.play().catch(() => undefined);
    if (fg.paused && !bg.paused) bg.pause();
  });

  const stemRef = useRef<HTMLAudioElement>(null);
  const stemRt = !follower && clip.audioOverride?.enabled
    ? getMediaRuntime(clip.audioOverride.stemMedia)
    : undefined;
  useStemSync(stemRef, clip, time, stemRt);
  const fx = filtersFor(clip);
  const gradeUrl = stackHasEffect(clip) ? `url(#cl-grade-${clip.id}) ` : '';
  const tf = transitionFx(clip, time - clip.start);
  const canvas = store.get().project.canvas;
  const effT = override ? { ...t, x: override.x, y: override.y, scale: override.scale } : t;
  const mk = maskStyle(clip, effT, { width: canvas.w, height: canvas.h }, time - clip.start, k);
  return (
    <div
      className={interactive ? 'absolute cursor-move touch-none' : 'absolute'}
      style={{
        left: '50%', top: '50%',
        width: `${scale * 100}%`,
        // R6 (UI redesign W2): the layer box follows the PROJECT canvas
        // aspect, not a hardcoded 16/9 — a portrait clip in a portrait
        // canvas was centre-sliced by the old box (audit F1). The render
        // lane's default fit fills the canvas the same way.
        aspectRatio: `${canvas.w} / ${canvas.h}`,
        transform: `translate(-50%,-50%) translate(${x * k}px, ${y * k}px) rotate(${rotation}deg) scale(${clip.flipH ? -1 : 1}, ${clip.flipV ? -1 : 1})${tf.extraTransform}`,
        opacity: t.opacity * tf.opacityMul,
        mixBlendMode: clip.blend && clip.blend !== 'normal' ? clip.blend : undefined,
        clipPath: tf.clipPath ?? (clip.crop ? `inset(${clip.crop.t * 100}% ${clip.crop.r * 100}% ${clip.crop.b * 100}% ${clip.crop.l * 100}%)` : undefined),
      }}
      onPointerDown={interactive ? (e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'av', mode: 'move', orig: { x: t.x, y: t.y, scale: t.scale, rotation: t.rotation } }) : undefined}
    >
      {mk.defs}
      {stemRt && <audio ref={stemRef} preload="auto" style={{ display: 'none' }} />}
      <div className="absolute inset-0" style={mk.style}>
        {blurFill && (
          <video
            ref={bgRef}
            muted
            playsInline
            preload="auto"
            aria-hidden
            className="absolute inset-0 block h-full w-full object-cover"
            style={{ filter: 'blur(18px) brightness(0.72)', transform: 'scale(1.18)' }}
          />
        )}
        <video
          ref={ref}
          muted={false}
          playsInline
          preload="auto"
          className={blurFill ? 'absolute inset-0 block h-full w-full object-contain' : 'block h-full w-full bg-black object-cover'}
          style={{
            ...((gradeUrl || fx || tf.extraFilter) ? { filter: (gradeUrl + fx + tf.extraFilter).trim() } : {}),
            // D2.6 'half' quality: the element lays out at half size
            // and scales back up — decode raster halves, framing is
            // unchanged (object-fit resolves inside the layout box).
            ...(getPreviewQuality() === 'half'
              ? { width: '50%', height: '50%', transform: 'scale(2)', transformOrigin: '0 0' }
              : {}),
          }}
        />
        <EffectOverlays clip={clip} />
        {tf.overlay}
      </div>
      {(clip.matteId || clip.chromaKey) && (
        <span className="pointer-events-none absolute left-1 top-1 z-10 rounded bg-black/70 px-1 font-mono text-[11px] text-[#C0C0C0]">
          {clip.chromaKey ? 'chroma — keys at render' : 'matte — applies at render'}
        </span>
      )}
      {selected && interactive && (
        <>
          <ScaleHandle onDown={(e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'av', mode: 'scale', orig: { x: t.x, y: t.y, scale: t.scale, rotation: t.rotation } })} />
          <RotateHandle onDown={(e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'av', mode: 'rotate', orig: { x: t.x, y: t.y, scale: t.scale, rotation: t.rotation } })} />
        </>
      )}
    </div>
  );
}

function RotateHandle({ onDown }: { onDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      className="absolute -top-8 left-1/2 z-10 flex h-4 w-4 -translate-x-1/2 cursor-grab touch-none items-center justify-center rounded-full border border-white bg-[#E31000] text-[11px] leading-none text-white"
      title="Drag to rotate (15° snap, Alt = free)"
      onPointerDown={(e) => { e.stopPropagation(); onDown(e); }}
    >
      ↻
    </div>
  );
}

/** Drive a media element that the playback engine does NOT own (compound
 *  nest content): mirrors the engine's maths — proxy-first source, speed-map
 *  source times, freeze pin, 0.18 s drift correction, seek-jump resync.
 *  Volume is set directly (nested audio bypasses the WebAudio EQ/pan/meter
 *  graph — a logged gap). No-op when `follower` is undefined. */
function useFollowerSync(
  ref: React.RefObject<HTMLMediaElement | null>,
  clip: VideoClip | AudioClip,
  time: number,
  follower: { volumeScale: number } | undefined,
) {
  const lastTime = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !follower) return;
    const rt = getMediaRuntime(clip.media);
    if (!rt) return;
    const wantSrc = pickRuntimeUrl(rt);
    const srcKey = clip.id + '|' + wantSrc;
    const local = time - clip.start;
    const dur = clipDuration(clip);
    if (local < -0.05 || local > dur + 0.05) {
      if (!el.paused) el.pause();
      return;
    }
    if (clip.freezeAt != null) {
      if (el.dataset.clipId !== srcKey || Math.abs(el.currentTime - clip.freezeAt) > 0.05) {
        el.dataset.clipId = srcKey;
        if (el.src !== wantSrc) el.src = wantSrc;
        try { el.currentTime = clip.freezeAt; } catch { /* not ready */ }
      }
      if (!el.paused) el.pause();
    } else {
      const seekJump = lastTime.current === null || Math.abs(time - lastTime.current) > 0.5;
      if (el.dataset.clipId !== srcKey) {
        el.dataset.clipId = srcKey;
        if (el.src !== wantSrc) el.src = wantSrc;
        try { el.currentTime = sourceTimeAt(clip, local); } catch { /* not ready */ }
      } else if (seekJump || Math.abs(el.currentTime - sourceTimeAt(clip, local)) > 0.18) {
        try { el.currentTime = sourceTimeAt(clip, local); } catch { /* ignore */ }
      }
      // FIX B2 #23: same reverse guard as the engine (FIX B1 #3) —
      // never hand Chromium a negative playbackRate. In reverse the
      // follower stays paused and is seek-dragged to the source time.
      if (playback.rate < 0) {
        try { el.playbackRate = Math.max(0.05, Math.abs(speedRateAt(clip, local) * playback.rate)); } catch { /* refused */ }
        try { el.currentTime = sourceTimeAt(clip, local); } catch { /* ignore */ }
        if (!el.paused) el.pause();
      } else {
        try { el.playbackRate = speedRateAt(clip, local) * playback.rate; } catch { /* refused */ }
        if (playback.playing && el.paused) void el.play().catch(() => undefined);
        if (!playback.playing && !el.paused) el.pause();
      }
    }
    const vc = clip as VideoClip;
    el.volume = clamp(
      volumeAt(
        { volume: vc.volume ?? 1, fadeIn: vc.fadeIn, fadeOut: vc.fadeOut, volumeKeys: vc.volumeKeys },
        dur, Math.max(0, local),
      ) * follower.volumeScale * (vc.muted ? 0 : 1),
      0, 1,
    );
    lastTime.current = time;
  });
}

/**
 * D1.5: drive a video clip's voice-isolation stem element — the same
 * follower maths as a nested element, but sourced from the stem media
 * and registered with isoPreview so the engine mutes the picture
 * element's own sound only while this stem can actually play.
 */
function useStemSync(
  ref: React.RefObject<HTMLAudioElement | null>,
  clip: VideoClip,
  time: number,
  stemRt: { url: string } | undefined,
) {
  const lastTime = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !stemRt) return;
    const onCanPlay = () => setStemAudible(clip.id, true);
    el.addEventListener('canplay', onCanPlay);
    if (el.readyState >= 2) setStemAudible(clip.id, true);
    const local = time - clip.start;
    const dur = clipDuration(clip);
    if (local < -0.05 || local > dur + 0.05 || clip.muted) {
      if (!el.paused) el.pause();
      lastTime.current = time;
      return () => { el.removeEventListener('canplay', onCanPlay); };
    }
    if (el.src !== stemRt.url) el.src = stemRt.url;
    if (clip.freezeAt != null) {
      if (Math.abs(el.currentTime - clip.freezeAt) > 0.05) {
        try { el.currentTime = clip.freezeAt; } catch { /* not ready */ }
      }
      if (!el.paused) el.pause();
    } else {
      const seekJump = lastTime.current === null || Math.abs(time - lastTime.current) > 0.5;
      if (seekJump || Math.abs(el.currentTime - sourceTimeAt(clip, local)) > 0.18) {
        try { el.currentTime = sourceTimeAt(clip, local); } catch { /* not ready */ }
      }
      // FIX B2 #23: reverse guard, as in useFollowerSync above.
      if (playback.rate < 0) {
        try { el.playbackRate = Math.max(0.05, Math.abs(speedRateAt(clip, local) * playback.rate)); } catch { /* refused */ }
        try { el.currentTime = sourceTimeAt(clip, local); } catch { /* ignore */ }
        if (!el.paused) el.pause();
      } else {
        try { el.playbackRate = speedRateAt(clip, local) * playback.rate; } catch { /* refused */ }
        if (playback.playing && el.paused) void el.play().catch(() => undefined);
        if (!playback.playing && !el.paused) el.pause();
      }
    }
    el.volume = clamp(
      volumeAt({ volume: clip.volume ?? 1, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, volumeKeys: clip.volumeKeys },
        dur, Math.max(0, local)),
      0, 1,
    );
    lastTime.current = time;
    return () => { el.removeEventListener('canplay', onCanPlay); };
  });
  useEffect(() => () => setStemAudible(clip.id, false), [clip.id]);
}

function NestedAudioEl({ clip, time, volumeScale }: { clip: AudioClip; time: number; volumeScale: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useFollowerSync(ref, clip, time, { volumeScale });
  return <audio ref={ref} preload="auto" style={{ display: 'none' }} />;
}

type VisualItem = { key: string; node: React.ReactNode } | { key: string; adj: AdjustmentClip };

/** Fold adjustment clips over the visual stack: walking bottom → top, an
 *  adjustment wraps everything beneath it in a filtered group (its effects
 *  overlays paint full-stage at its stack position). An adjustment with
 *  nothing beneath it renders nothing. Shared by the top-level stage and by
 *  compound nests. */
function foldAdjustments(items: VisualItem[]): React.ReactNode[] {
  let acc: React.ReactNode[] = [];
  for (const it of items) {
    if ('adj' in it) {
      if (acc.length === 0) continue;
      acc = [<AdjustmentWrap key={it.adj.id} clip={it.adj}>{acc}</AdjustmentWrap>];
    } else {
      acc.push(it.node);
    }
  }
  return acc;
}

function AdjustmentWrap({ clip, children }: { clip: AdjustmentClip; children: React.ReactNode }) {
  const fx = filtersFor(clip as unknown as VideoClip);
  const gradeUrl = stackHasEffect(clip) ? `url(#cl-grade-${clip.id}) ` : '';
  const filter = (gradeUrl + fx).trim();
  return (
    <>
      <div className="absolute inset-0" style={filter ? { filter } : undefined}>{children}</div>
      <EffectOverlays clip={clip as unknown as VideoClip} />
    </>
  );
}

const noopDrag: PreviewDragStart = () => undefined;

/** A compound clip's nested stack (F.16): the nest's tracks rendered at the
 *  mapped nest time (in + elapsed), inside the compound's own transform /
 *  grade / effects / transition. Display-only — open the nest to edit inside
 *  it. Nesting recurses to depth 4. */
function CompoundLayer({ clip, time, k, dispW, dispH, depth, volIn }: {
  clip: CompoundClip;
  time: number;
  k: number;
  dispW: number;
  dispH: number;
  depth: number;
  volIn: number;
}) {
  const project = useStore((s) => s.project);
  const tr = evalTransform(clip, time - clip.start);
  const tf = transitionFx(clip as unknown as VideoClip, time - clip.start);
  const nestTime = clip.in + (time - clip.start);
  const anySolo = clip.nest.tracks.some((x) => x.kind === 'audio' && x.solo);
  const items: VisualItem[] = [];
  const audioEls: React.ReactNode[] = [];
  for (let i = clip.nest.tracks.length - 1; i >= 0; i--) {
    const ntr = clip.nest.tracks[i];
    if (ntr.hidden) continue;
    const nc = clipAtTime(ntr.clips, nestTime);
    if (!nc) continue;
    const childVol = volIn * (clip.volume ?? 1) * (ntr.volume ?? 1)
      * (ntr.muted || (anySolo && ntr.kind === 'audio' && !ntr.solo) ? 0 : 1);
    if ('adj' in nc) {
      items.push({ key: nc.id, adj: nc });
      continue;
    }
    if ('nest' in nc) {
      if (depth < 4) {
        items.push({
          key: nc.id,
          node: (
            <CompoundLayer key={nc.id} clip={nc} time={nestTime} k={k}
              dispW={dispW} dispH={dispH} depth={depth + 1} volIn={childVol} />
          ),
        });
      }
      continue;
    }
    if (ntr.kind === 'text') {
      items.push({
        key: nc.id,
        node: <TextLayerView key={nc.id} clip={nc as TextClip} time={nestTime} dispW={dispW} dispH={dispH} />,
      });
      continue;
    }
    if (ntr.kind === 'audio') {
      audioEls.push(<NestedAudioEl key={nc.id} clip={nc as AudioClip} time={nestTime} volumeScale={childVol} />);
      continue;
    }
    const vc = nc as VideoClip;
    const m = project.media.find((x) => x.id === vc.media);
    if (m?.kind === 'image') {
      items.push({
        key: nc.id,
        node: <ImageLayerView key={nc.id} clip={vc} trackId={ntr.id} time={nestTime} k={k} />,
      });
    } else {
      items.push({
        key: nc.id,
        node: (
          <VideoLayer key={nc.id} clip={vc} trackId={ntr.id} time={nestTime} k={k}
            selected={false} override={null} onDragStart={noopDrag}
            follower={{ volumeScale: childVol }} interactive={false} />
        ),
      });
    }
  }
  const fx = filtersFor(clip as unknown as VideoClip);
  const gradeUrl = stackHasEffect(clip) ? `url(#cl-grade-${clip.id}) ` : '';
  const filter = (gradeUrl + fx + tf.extraFilter).trim();
  return (
    <div
      className="absolute inset-0"
      style={{
        transform: `translate(${tr.x * k}px, ${tr.y * k}px) rotate(${tr.rotation}deg) scale(${tr.scale})${tf.extraTransform}`,
        opacity: tr.opacity * tf.opacityMul,
        mixBlendMode: clip.blend && clip.blend !== 'normal' ? clip.blend : undefined,
        clipPath: tf.clipPath ?? (clip.crop ? `inset(${clip.crop.t * 100}% ${clip.crop.r * 100}% ${clip.crop.b * 100}% ${clip.crop.l * 100}%)` : undefined),
        filter: filter || undefined,
        pointerEvents: 'none',
      }}
    >
      {foldAdjustments(items)}
      {audioEls}
    </div>
  );
}

/** Image clip layer (shared by the top-level stage and compound nests). */
function ImageLayerView({ clip, trackId, time, k, selected = false, override = null, onDragStart }: {
  clip: VideoClip;
  trackId: string;
  time: number;
  k: number;
  selected?: boolean;
  override?: LayerOverride | null;
  onDragStart?: PreviewDragStart;
}) {
  const project = useStore((s) => s.project);
  const rt = getMediaRuntime(clip.media);
  const tr = evalTransform(clip, time - clip.start);
  const x = override ? override.x : tr.x;
  const y = override ? override.y : tr.y;
  const scale = override ? override.scale : tr.scale;
  const rotation = override ? override.rotation : tr.rotation;
  const m = project.media.find((mm) => mm.id === clip.media);
  const natW = (m?.width ?? 720) * scale;
  if (!rt) return null;
  return (
    <div
      className={onDragStart ? 'absolute cursor-move touch-none' : 'absolute'}
      style={{
        left: '50%', top: '50%', width: natW * k, opacity: tr.opacity,
        transform: `translate(-50%,-50%) translate(${x * k}px, ${y * k}px) rotate(${rotation}deg) scale(${clip.flipH ? -1 : 1}, ${clip.flipV ? -1 : 1})`,
        mixBlendMode: clip.blend && clip.blend !== 'normal' ? clip.blend : undefined,
        clipPath: clip.crop ? `inset(${clip.crop.t * 100}% ${clip.crop.r * 100}% ${clip.crop.b * 100}% ${clip.crop.l * 100}%)` : undefined,
      }}
      onPointerDown={onDragStart ? (e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'av', mode: 'move', orig: { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation } }) : undefined}
    >
      <img src={pickRuntimeUrl(rt)} alt="" draggable={false} className="block h-auto w-full" />
      {selected && onDragStart && (
        <>
          <ScaleHandle onDown={(e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'av', mode: 'scale', orig: { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation } })} />
          <RotateHandle onDown={(e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'av', mode: 'rotate', orig: { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation } })} />
        </>
      )}
    </div>
  );
}

type PreviewDragStart = (
  e: React.PointerEvent,
  payload: Omit<DragState, 'startPx' | 'centrePx' | 'startDist' | 'startAngle'>,
) => void;

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx!;
}

/** Text layer (shared by the top-level stage and compound nests). Without
 *  onDragStart it is display-only. H.11 arc text and the H.12 speech-bubble
 *  plate live here; arc + karaoke highlighting do not combine (the arc
 *  renders the plain string). */
function TextLayerView({ clip, trackId, time, dispW, dispH, override = null, onDragStart }: {
  clip: TextClip;
  trackId?: string;
  time: number;
  dispW: number;
  dispH: number;
  override?: LayerOverride | null;
  onDragStart?: PreviewDragStart;
}) {
  const st = resolveTextStyle(clip);
  const tx = evalText(clip, time - clip.start);
  if (!tx.visible) return null;
  const px = (dispW / 720) * ((st.fontSize ?? 30) / 30);
  const ref = dispW / 720; // 720-reference px → display px
  const fx = override ? override.x : (clip.x ?? 0.5);
  const fy = override ? override.y : (clip.y ?? 0.8);
  const sh = resolveShadow(clip);
  const shCss = sh
    ? `${(Math.cos((sh.angle * Math.PI) / 180) * sh.distance * ref).toFixed(1)}px ${(Math.sin((sh.angle * Math.PI) / 180) * sh.distance * ref).toFixed(1)}px ${(sh.blur * ref).toFixed(1)}px ${hexA(sh.color, sh.opacity)}`
    : undefined;
  const plate = clip.plate;
  const glowOn = (clip.effects ?? []).includes('glow');
  const plainShown = tx.shown.replace(/\*\*/g, '');
  const fontSizePx = Math.max(8, 30 * px);

  // H.11: text on an arc — per-glyph placement from measured advances.
  // Single-line only; multi-line text keeps the flat layout.
  let arcData: { layout: { x: number; y: number; rotation: number }[]; advances: number[]; total: number } | null = null;
  if (clip.curve && Math.abs(clip.curve) >= 40 && !tx.shown.includes('\n')) {
    const cv = getMeasureCtx();
    cv.font = `${st.fontWeight ?? 700} ${fontSizePx}px ${st.fontFamily ?? 'sans-serif'}`;
    const spacing = (clip.charSpacing ?? 0) * ref;
    const advances = [...plainShown].map((ch) => cv.measureText(ch).width + spacing);
    arcData = {
      layout: arcLayout(plainShown, advances, clip.curve * ref),
      advances,
      total: advances.reduce((a, b) => a + b, 0),
    };
  }

  // H.12: speech-bubble tail, attached to the plate's named edge.
  const tail = plate?.shape === 'bubble' ? (() => {
    const size = (plate.tailSize ?? 14) * ref;
    const at = (plate.tailAt ?? 0.5) * 100;
    const col = hexA(plate.color, plate.opacity);
    const half = `${(size * 0.55).toFixed(1)}px solid transparent`;
    const base: React.CSSProperties = { width: 0, height: 0 };
    switch (plate.tail ?? 'bottom') {
      case 'top':
        return { ...base, left: `calc(${at}% - ${(size * 0.55).toFixed(1)}px)`, bottom: '100%', borderLeft: half, borderRight: half, borderBottom: `${size.toFixed(1)}px solid ${col}` };
      case 'left':
        return { ...base, top: `calc(${at}% - ${(size * 0.55).toFixed(1)}px)`, right: '100%', borderTop: half, borderBottom: half, borderRight: `${size.toFixed(1)}px solid ${col}` };
      case 'right':
        return { ...base, top: `calc(${at}% - ${(size * 0.55).toFixed(1)}px)`, left: '100%', borderTop: half, borderBottom: half, borderLeft: `${size.toFixed(1)}px solid ${col}` };
      default:
        return { ...base, left: `calc(${at}% - ${(size * 0.55).toFixed(1)}px)`, top: '100%', borderLeft: half, borderRight: half, borderTop: `${size.toFixed(1)}px solid ${col}` };
    }
  })() : null;

  return (
    <div
      className={onDragStart ? 'absolute cursor-move touch-none whitespace-pre-wrap text-center font-bold leading-tight' : 'absolute whitespace-pre-wrap text-center font-bold leading-tight'}
      style={{
        left: fx * dispW + tx.loopXOffPx * ref, top: fy * dispH + tx.yOffPx * ref,
        transform: `translate(-50%,-50%) scale(${tx.scale * tx.loopScale})`,
        fontFamily: st.fontFamily, fontWeight: st.fontWeight,
        fontSize: fontSizePx,
        color: clip.noFill ? 'transparent' : st.color, opacity: tx.alpha,
        textAlign: clip.align ?? 'center',
        letterSpacing: clip.charSpacing ? `${clip.charSpacing * ref}px` : undefined,
        lineHeight: clip.lineSpacing ?? undefined,
        WebkitTextStroke: st.strokeWidth > 0 ? `${Math.max(1, st.strokeWidth * px * 2)}px ${st.strokeColor}` : undefined,
        paintOrder: 'stroke fill',
        textShadow: shCss,
        maxWidth: dispW * 0.94,
      }}
      onPointerDown={onDragStart && trackId ? (e) => onDragStart(e, { clipId: clip.id, trackId, kind: 'text', mode: 'move', orig: { x: clip.x ?? 0.5, y: clip.y ?? 0.8, scale: 1, rotation: 0 } }) : undefined}
    >
      {plate && (
        <span aria-hidden className="absolute" style={{
          left: (-plate.padX + plate.offX) * ref, right: (-plate.padX - plate.offX) * ref,
          top: (-plate.padY + plate.offY) * ref, bottom: (-plate.padY - plate.offY) * ref,
          background: hexA(plate.color, plate.opacity), borderRadius: plate.radius * ref, zIndex: -1,
        }}>
          {tail && <span aria-hidden className="absolute" style={tail} />}
        </span>
      )}
      {glowOn && !arcData && (
        <span aria-hidden className="absolute inset-0" style={{
          color: st.color, filter: `blur(${((clip.glowObj?.range ?? 8)) * ref}px)`,
          opacity: clip.glowObj?.intensity ?? 0.85,
        }}>{plainShown}</span>
      )}
      {arcData ? (
        <span className="relative block" style={{ width: arcData.total, height: fontSizePx, margin: '0 auto' }}>
          {[...plainShown].map((ch, i) => (
            <span key={i} className="absolute" style={{
              left: arcData.total / 2 + arcData.layout[i].x,
              top: arcData.layout[i].y,
              width: arcData.advances[i],
              transform: `translateX(-50%) rotate(${arcData.layout[i].rotation}rad)`,
              transformOrigin: '50% 100%',
              textAlign: 'center',
            }}>{ch === ' ' ? ' ' : ch}</span>
          ))}
        </span>
      ) : (
        <span className="relative">{renderWordsOrHighlight(clip, tx.shown, time - clip.start, st.color)}</span>
      )}
    </div>
  );
}

/** Stage rulers (C.7): ticks every 25 canvas units, labels every 100. */
function RulerH({ dispW, canvasW, k, onAddGuide }: { dispW: number; canvasW: number; k: number; onAddGuide?: (frac: number) => void }) {
  const ticks: React.ReactNode[] = [];
  for (let u = 0; u <= canvasW + 0.5; u += 25) {
    const x = u * k;
    const major = u % 100 === 0;
    ticks.push(<line key={u} x1={x} y1={major ? 5 : 10} x2={x} y2={14} stroke="#4a4a4a" strokeWidth={1} />);
    if (major && u > 0) ticks.push(<text key={`t${u}`} x={x + 2} y={9} fontSize={8} fill="#a8a8a8">{u}</text>);
  }
  return (
    <svg className="absolute" style={{ left: 16, top: 0, cursor: onAddGuide ? 'copy' : undefined }} width={dispW} height={14}
      role={onAddGuide ? 'button' : undefined}
      aria-label={onAddGuide ? 'Click to add a vertical guide' : undefined}
      onClick={(e) => {
        if (!onAddGuide) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const frac = (e.clientX - r.left) / r.width;
        if (frac > 0.005 && frac < 0.995) onAddGuide(Math.round(frac * 1000) / 1000);
      }}>{ticks}</svg>
  );
}

function RulerV({ dispH, canvasH, k, onAddGuide }: { dispH: number; canvasH: number; k: number; onAddGuide?: (frac: number) => void }) {
  const ticks: React.ReactNode[] = [];
  for (let u = 0; u <= canvasH + 0.5; u += 25) {
    const y = u * k;
    const major = u % 100 === 0;
    ticks.push(<line key={u} x1={major ? 5 : 10} y1={y} x2={14} y2={y} stroke="#4a4a4a" strokeWidth={1} />);
    if (major && u > 0) ticks.push(<text key={`t${u}`} x={2} y={y - 2} fontSize={8} fill="#a8a8a8">{u}</text>);
  }
  return (
    <svg className="absolute" style={{ left: 0, top: 16, cursor: onAddGuide ? 'copy' : undefined }} width={14} height={dispH}
      role={onAddGuide ? 'button' : undefined}
      aria-label={onAddGuide ? 'Click to add a horizontal guide' : undefined}
      onClick={(e) => {
        if (!onAddGuide) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        const frac = (e.clientY - r.top) / r.height;
        if (frac > 0.005 && frac < 0.995) onAddGuide(Math.round(frac * 1000) / 1000);
      }}>{ticks}</svg>
  );
}

/**
 * GuidesOverlay (D2.6): draggable guide lines over the stage. Drag to
 * move; drag off the stage or double-click to remove. Gold dashed —
 * CutLab's accent for view furniture.
 */
function GuidesOverlay({ guides, dispW, dispH, onChange }: {
  guides: { v: number[]; h: number[] };
  dispW: number; dispH: number;
  onChange: (g: { v: number[]; h: number[] }) => void;
}) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = (axis: 'v' | 'h', idx: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const rect = () => ref.current!.getBoundingClientRect();
    const fracOf = (ev: PointerEvent) => {
      const r = rect();
      return axis === 'v' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
    };
    const move = (ev: PointerEvent) => {
      const f = Math.min(1.05, Math.max(-0.05, fracOf(ev)));
      const next = { v: [...guides.v], h: [...guides.h] };
      next[axis][idx] = Math.round(f * 1000) / 1000;
      onChange(next);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const f = fracOf(ev);
      if (f < 0.01 || f > 0.99) {
        const next = { v: [...guides.v], h: [...guides.h] };
        next[axis].splice(idx, 1);
        onChange(next);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const remove = (axis: 'v' | 'h', idx: number) => {
    const next = { v: [...guides.v], h: [...guides.h] };
    next[axis].splice(idx, 1);
    onChange(next);
  };
  return (
    <svg ref={ref} className="absolute inset-0 z-30" width={dispW} height={dispH} aria-hidden
      style={{ pointerEvents: 'none' }}>
      {guides.v.map((f, i) => (
        <g key={`v${i}`}>
          <line x1={f * dispW} y1={0} x2={f * dispW} y2={dispH} stroke="#E8C268" strokeWidth={1} strokeDasharray="4 3" opacity={0.85} />
          <line x1={f * dispW} y1={0} x2={f * dispW} y2={dispH} stroke="transparent" strokeWidth={9}
            style={{ pointerEvents: 'stroke', cursor: 'ew-resize' }}
            onPointerDown={drag('v', i)} onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => { e.stopPropagation(); remove('v', i); }}>
            <title>Guide — drag to move, double-click to remove</title>
          </line>
        </g>
      ))}
      {guides.h.map((f, i) => (
        <g key={`h${i}`}>
          <line x1={0} y1={f * dispH} x2={dispW} y2={f * dispH} stroke="#E8C268" strokeWidth={1} strokeDasharray="4 3" opacity={0.85} />
          <line x1={0} y1={f * dispH} x2={dispW} y2={f * dispH} stroke="transparent" strokeWidth={9}
            style={{ pointerEvents: 'stroke', cursor: 'ns-resize' }}
            onPointerDown={drag('h', i)} onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => { e.stopPropagation(); remove('h', i); }}>
            <title>Guide — drag to move, double-click to remove</title>
          </line>
        </g>
      ))}
    </svg>
  );
}

/** CSS filter string approximating the clip's effect adjustments (preview only). */
export function filtersFor(clip: VideoClip): string {
  const eff = new Map((clip.effects ?? []).filter((e) => e.enabled !== false).map((e) => [e.type, e.value]));
  const parts: string[] = [];
  const b = eff.get('brightness');
  if (b !== undefined && b !== 0) parts.push(`brightness(${1 + b})`);
  const c = eff.get('contrast');
  if (c !== undefined && c !== 0) parts.push(`contrast(${1 + c})`);
  const s = eff.get('saturation');
  if (s !== undefined && s !== 0) parts.push(`saturate(${1 + s})`);
  const blurEff = (clip.effects ?? []).filter((e) => e.enabled !== false).find((e) => e.type === 'blur');
  if (blurEff) parts.push(`blur(${(blurEff.value * 12).toFixed(1)}px)`);
  const sh = eff.get('sharpen');
  if (sh !== undefined && sh > 0) parts.push(`url(#cl-sharpen-${sh <= 0.6 ? 1 : sh <= 1.3 ? 2 : 3})`);
  return parts.join(' ');
}

/** Non-filter effect overlays (vignette / TV lines / haze), preview approximations. */
export function EffectOverlays({ clip }: { clip: VideoClip }) {
  const on = (clip.effects ?? []).filter((e) => e.enabled !== false);
  const relight = on.find((e) => e.type === 'relight');
  const vig = on.find((e) => e.type === 'vignette');
  const tv = on.find((e) => e.type === 'tv-lines');
  const haze = on.find((e) => e.type === 'haze');
  if (!vig && !tv && !haze) return null;
  return (
    <>
      {haze && (
        <div className="pointer-events-none absolute inset-0" style={{
          backdropFilter: `blur(${haze.value}px)`,
          WebkitBackdropFilter: `blur(${haze.value}px)`,
          maskImage: `radial-gradient(circle at ${(haze.params?.cx ?? 0.5) * 100}% ${(haze.params?.cy ?? 0.5) * 100}%, transparent 30%, black 78%)`,
          WebkitMaskImage: `radial-gradient(circle at ${(haze.params?.cx ?? 0.5) * 100}% ${(haze.params?.cy ?? 0.5) * 100}%, transparent 30%, black 78%)`,
        }} />
      )}
      {vig && (
        <div className="pointer-events-none absolute inset-0" style={{
          background: `radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,${(vig.value * 0.85).toFixed(2)}) 100%)`,
        }} />
      )}
      {tv && (
        <div className="pointer-events-none absolute inset-0" style={{
          background: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0 1px, transparent 1px 3px)',
          opacity: tv.value * 0.5, // redgs' half-strength discipline, applied to the overlay itself
        }} />
      )}
      {relight && (relight.lights ?? []).map((lt, i) => (
        <div key={i} className="pointer-events-none absolute rounded-full" style={{
          left: `${(lt.x - lt.radius) * 100}%`, top: `${(lt.y - lt.radius) * 100}%`,
          width: `${lt.radius * 200}%`, height: `${lt.radius * 200}%`,
          background: `radial-gradient(circle, ${hexA(lt.color, 0.55)} 0%, transparent 70%)`,
          opacity: lt.intensity * relight.value,
          mixBlendMode: 'screen',
        }} />
      ))}
    </>
  );
}

/** One grade as an SVG filter (matrix → gamma transfer → curve table). */
export function GradeFilterDef({ id, grade }: { id: string; grade: Grade }) {
  return <GradeStackDef id={id} layers={[grade]} />;
}

/** Serial grade stack (D1.1): the layers' specs chained inside ONE filter
 *  element — each layer's primitives consume the previous layer's named
 *  output, so the preview applies the layers in stack order exactly like
 *  Lane B loops grade_fc. Disabled and identity layers are skipped. */
export function GradeStackDef({ id, layers }: { id: string; layers: Grade[] }) {
  const specs = layers.filter((g) => g.enabled !== false && !gradeIsIdentity(g)).map(buildFilterSpec);
  if (specs.length === 0) return null;
  const gammaFns = (spec: (typeof specs)[number], keyPfx: string) => (['r', 'g', 'b'] as const).map((c) => {
    const ch = spec.chan[c];
    const F = c === 'r' ? 'feFuncR' : c === 'g' ? 'feFuncG' : 'feFuncB';
    return <F key={`${keyPfx}${c}`} type="gamma" amplitude={ch.amp.toFixed(3)} exponent={ch.exp.toFixed(3)} offset={ch.off.toFixed(3)} />;
  });
  const tableFns = (spec: (typeof specs)[number], keyPfx: string) => (['r', 'g', 'b'] as const).map((c) => {
    const F = c === 'r' ? 'feFuncR' : c === 'g' ? 'feFuncG' : 'feFuncB';
    return <F key={`${keyPfx}${c}`} type="table" tableValues={spec.table[c]} />;
  });
  return (
    <filter id={id} colorInterpolationFilters="sRGB">
      {specs.map((spec, i) => {
        const inp = i === 0 ? 'SourceGraphic' : `gs${i - 1}`;
        const out = `gs${i}`;
        return (
          <Fragment key={i}>
            <feColorMatrix in={inp} result={`${out}m`} type="matrix" values={spec.matrix} />
            <feComponentTransfer in={`${out}m`} result={`${out}t`}>{gammaFns(spec, `g${i}`)}</feComponentTransfer>
            {spec.hasTable
              ? <feComponentTransfer in={`${out}t`} result={out}>{tableFns(spec, `t${i}`)}</feComponentTransfer>
              : <feOffset in={`${out}t`} result={out} dx={0} dy={0} />}
          </Fragment>
        );
      })}
    </filter>
  );
}

/** Grade filter defs for every graded clip + the project look (§N). */
export function GradeDefs({ project }: { project: Project }) {
  const defs: React.ReactNode[] = [];
  for (const tr of project.tracks) {
    for (const c of tr.clips) {
      if (tr.kind === 'video' && stackHasEffect(c as VideoClip)) {
        defs.push(<GradeStackDef key={c.id} id={`cl-grade-${c.id}`} layers={gradeLayersOf(c as VideoClip)} />);
      }
    }
  }
  if (!gradeIsIdentity(project.look)) defs.push(<GradeFilterDef key="look" id="cl-look" grade={project.look!} />);
  if (defs.length === 0) return null;
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>{defs}</defs>
    </svg>
  );
}

/** Sharpen convolution kernels (3 strength buckets) referenced by filtersFor. */
export function SharpenDefs() {
  const k = (id: string, c: number) => (
    <filter id={id} key={id}>
      <feConvolveMatrix order="3" kernelMatrix={`0 ${-c} 0 ${-c} ${1 + 4 * c} ${-c} 0 ${-c} 0`} preserveAlpha="true" />
    </filter>
  );
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <defs>{k('cl-sharpen-1', 0.4)}{k('cl-sharpen-2', 0.8)}{k('cl-sharpen-3', 1.4)}</defs>
    </svg>
  );
}


/** #rrggbb + alpha → rgba() string (falls back to the raw colour). */
export function hexA(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** H.10: **word** spans render in the highlight colour; markers are stripped. */
export function renderHighlighted(text: string, highlightColor?: string): React.ReactNode {
  if (!highlightColor || !text.includes('**')) return text.replace(/\*\*/g, '');
  const parts = text.split('**');
  return parts.map((part, i) =>
    i % 2 === 1
      ? <span key={i} style={{ color: highlightColor }}>{part}</span>
      : <span key={i}>{part}</span>,
  );
}


/** Preview transition approximation (§J): the incoming layer during the first
 *  transitionDur seconds of its clip. Lane B performs these for real; the
 *  preview's job is that the join is never invisible while editing. */
export function transitionFx(clip: VideoClip, local: number): {
  opacityMul: number;
  extraTransform: string;
  extraFilter: string;
  overlay: React.ReactNode;
  clipPath?: string;
} {
  const none = { opacityMul: 1, extraTransform: '', extraFilter: '', overlay: null as React.ReactNode };
  const type = clip.transitionIn;
  if (!type || type === 'cut' || local < 0) return none;
  const dur = Math.max(0.03, clip.transitionDur ?? 0.25);
  if (local >= dur) return none;
  const p = local / dur; // 0..1 through the join window
  const bell = Math.sin(p * Math.PI); // peaks mid-window
  switch (type) {
    case 'dissolve':
      return { ...none, opacityMul: 0.15 + 0.85 * p };
    case 'flash':
      return { ...none, overlay: <div className="pointer-events-none absolute inset-0 bg-white" style={{ opacity: bell * 0.9 }} /> };
    case 'glare': {
      // a sweeping light band, not a second flash (J.4)
      const x = -30 + p * 160;
      return {
        ...none,
        overlay: (
          <div className="pointer-events-none absolute inset-0" style={{
            background: `linear-gradient(105deg, transparent ${x - 18}%, rgba(255,255,255,0.85) ${x}%, transparent ${x + 18}%)`,
          }} />
        ),
      };
    }
    case 'slide': {
      const dir = clip.transitionDir ?? 'down';
      const off = (1 - p) * 100;
      const t = dir === 'down' ? `translateY(${-off}%)` : dir === 'up' ? `translateY(${off}%)`
        : dir === 'left' ? `translateX(${off}%)` : `translateX(${-off}%)`;
      return { ...none, extraTransform: ` ${t}` };
    }
    case 'shake': {
      const amp = (1 - p) * 5;
      const dx = Math.sin(local * 90) * amp;
      const dy = Math.cos(local * 113) * amp * 0.7;
      return { ...none, extraTransform: ` translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)` };
    }
    case 'blur-pulse':
      return { ...none, extraFilter: ` blur(${(bell * 9).toFixed(1)}px)` };
    case 'blur-cut': {
      // J.12 approximation: only this clip's settle is shown (Lane B also
      // blurs the previous clip's tail up to the same peak at the join).
      const env = 1 - p;
      const peak = clip.transitionBlur ?? 9;
      const zoomT = clip.transitionMode === 'zoom' ? ` scale(${(1 + 0.12 * env).toFixed(3)})` : '';
      return { ...none, extraFilter: ` blur(${(peak * env).toFixed(1)}px)`, extraTransform: zoomT };
    }
    case 'zoom': {
      const e = 1 - Math.pow(1 - p, 3);
      return { ...none, extraTransform: ` scale(${(1.18 - 0.18 * e).toFixed(3)})` };
    }
    case 'flip':
      return { ...none, extraTransform: ` perspective(900px) rotateY(${((1 - p) * 88).toFixed(1)}deg)` };
    case 'invert-flash':
      return { ...none, extraFilter: ' invert(1)' };
    case 'mask-wipe': {
      // J.11 approximation: a circular reveal growing from the wipe origin
      // across the transition window. Lane B performs the true mask wipe.
      const cx = (clip.wipeCx ?? 0.5) * 100;
      const cy = (clip.wipeCy ?? 0.5) * 100;
      return { ...none, clipPath: `circle(${(p * 150).toFixed(1)}% at ${cx.toFixed(1)}% ${cy.toFixed(1)}%)` };
    }
    default:
      return none;
  }
}


function AudioLayer({ trackId }: { trackId: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    playback.registerElement(trackId, ref.current);
    return () => playback.registerElement(trackId, null);
  }, [trackId]);
  return <audio ref={ref} preload="auto" style={{ display: 'none' }} />;
}

/** Stereo meter with peak hold (K.15), fed by the engine's analysers.
 *  FIX B2 #14: the meter owns its animation — a rAF loop, not the
 *  parent's render cycle. The transport-deck copy looked alive only
 *  because the deck re-renders on every frame tick; the Audio page's
 *  master-bus copy sat frozen between store changes. */
export function LevelMeter({ width = 64, height = 14 }: { width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peakRef = useRef({ l: 0, r: 0, at: 0 });
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      // Perf: a hidden tab needs no meter paints (rAF already
      // throttles there; this also skips the analyser readbacks).
      if (document.hidden) return;
      const { l, r } = playback.getLevels();
      const now = performance.now();
      const pk = peakRef.current;
      if (l >= pk.l || now - pk.at > 900) { pk.l = l; pk.at = now; }
      if (r >= pk.r) pk.r = r;
      const W = cv.width, H = cv.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#262626';
      ctx.fillRect(0, 0, W, H);
      const bar = (y: number, v: number, peak: number) => {
        const w = Math.min(W, v * W);
        ctx.fillStyle = v > 0.85 ? '#E31000' : v > 0.6 ? '#E8C268' : '#7DC98A';
        ctx.fillRect(0, y, w, 5);
        ctx.fillStyle = '#fff';
        ctx.fillRect(Math.min(W - 1, peak * W), y, 1, 5);
      };
      bar(1, l, pk.l);
      bar(8, r, pk.r);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={canvasRef} width={width} height={height} title="Output level (preview)" aria-label="Output level meter" />;
}


/** L.6 karaoke: with word timings, the spoken word lights up in the
 *  highlight colour; otherwise the H.10 **markup** renderer runs. */
export function renderWordsOrHighlight(
  clip: TextClip,
  shown: string,
  local: number,
  baseColor: string,
): React.ReactNode {
  if (clip.words && clip.words.length > 0 && clip.highlightColor) {
    return clip.words.map((wd, i) => {
      const active = local >= wd.t0 && local < wd.t1;
      const spoken = local >= wd.t1;
      return (
        <span key={i} style={{ color: active ? clip.highlightColor : baseColor, opacity: spoken || active ? 1 : 0.55 }}>
          {wd.w}{i < clip.words!.length - 1 ? ' ' : ''}
        </span>
      );
    });
  }
  return renderHighlighted(shown, clip.highlightColor);
}

/** O.4 on-canvas mask editor: outline + corner/edge handles + pen-point
 *  handles drawn in stage space (mask geometry is canvas fractions, so the
 *  mapping is direct). Drags write the base mask; keyframed geometry still
 *  wins during playback via maskAt. */
export function MaskEditOverlay({ clip, trackId, dispW, dispH, time }: {
  clip: VideoClip;
  trackId: string;
  dispW: number;
  dispH: number;
  time: number;
}) {
  const mask = clip.mask!;
  const mg = maskAt(clip, time - clip.start) ?? { x: mask.x, y: mask.y, w: mask.w, h: mask.h };
  const patch = (fn: (m: ClipMask) => void, history: boolean) =>
    store.commit((d) => {
      const tr = d.tracks.find((x) => x.id === trackId);
      const c = tr?.clips.find((x) => x.id === clip.id) as VideoClip | undefined;
      if (c?.mask) fn(c.mask);
    }, { history });

  const drag = (e: React.PointerEvent, apply: (dx: number, dy: number, orig: ClipMask) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const orig = JSON.parse(JSON.stringify(mask)) as ClipMask;
    store.commit(() => undefined, { history: true });
    const sx = e.clientX, sy = e.clientY;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / dispW;
      const dy = (ev.clientY - sy) / dispH;
      patch((m) => {
        Object.assign(m, JSON.parse(JSON.stringify(orig)));
        apply(dx, dy, m);
      }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const handle = (cx: number, cy: number, apply: (dx: number, dy: number, m: ClipMask) => void, key: string) => (
    <span key={key}
      className="pointer-events-auto absolute z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-sm border border-white bg-[#E31000]"
      style={{ left: cx, top: cy }}
      onPointerDown={(e) => drag(e, apply)} />
  );

  if (mask.shape === 'pen') {
    return (
      <div className="absolute inset-0 z-10">
        <svg width={dispW} height={dispH} className="pointer-events-none absolute inset-0">
          <polygon
            points={(mask.points ?? []).map((pt) => `${pt.x * dispW},${pt.y * dispH}`).join(' ')}
            fill="rgba(227,16,0,0.08)" stroke="#C0C0C0" strokeDasharray="4 3" />
        </svg>
        {(mask.points ?? []).map((pt, i) =>
          handle(pt.x * dispW, pt.y * dispH, (dx, dy, m) => {
            m.points![i] = {
              x: Math.min(1, Math.max(0, (mask.points![i].x) + dx)),
              y: Math.min(1, Math.max(0, (mask.points![i].y) + dy)),
            };
          }, `p${i}`),
        )}
      </div>
    );
  }

  const x = mg.x * dispW, y = mg.y * dispH, w = mg.w * dispW, h = mg.h * dispH;
  return (
    <div className="absolute inset-0 z-10">
      <div className="pointer-events-none absolute border border-dashed border-[#C0C0C0]"
        style={{
          left: mask.shape === 'linear' ? x + w / 2 - 1 : x, top: mask.shape === 'linear' ? 0 : y,
          width: mask.shape === 'linear' ? 2 : w, height: mask.shape === 'linear' ? dispH : h,
          transform: mask.shape === 'linear' ? `rotate(${mask.angle ?? 0}deg)` : undefined,
          transformOrigin: 'center',
          borderRadius: mask.shape === 'circle' ? '50%' : undefined,
        }} />
      {handle(x, y, (dx, dy, m) => { m.x = mg.x + dx; m.y = mg.y + dy; m.w = Math.max(0.02, mg.w - dx); m.h = Math.max(0.02, mg.h - dy); }, 'tl')}
      {handle(x + w, y, (dx, dy, m) => { m.y = mg.y + dy; m.w = Math.max(0.02, mg.w + dx); m.h = Math.max(0.02, mg.h - dy); }, 'tr')}
      {handle(x, y + h, (dx, dy, m) => { m.x = mg.x + dx; m.w = Math.max(0.02, mg.w - dx); m.h = Math.max(0.02, mg.h + dy); }, 'bl')}
      {handle(x + w, y + h, (dx, _dy, m) => { m.w = Math.max(0.02, mg.w + dx); m.h = Math.max(0.02, mg.h + _dy); }, 'br')}
      {handle(x + w / 2, y + h / 2, (dx, dy, m) => { m.x = mg.x + dx; m.y = mg.y + dy; }, 'c')}
    </div>
  );
}
