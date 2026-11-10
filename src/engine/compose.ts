// Pure composition maths: given a project + time, what is on screen?
// Shared semantics with the Lane B renderer (render-lane-b/render.py):
// keyframes interpolate linearly (with per-segment easing applied in preview),
// text animations run 0.28 s in / 0.25 s out.
import type { Clip, ClipMask, CompoundClip, Keyframe, TextClip, Transform, VideoClip } from '../types';
import { clipDuration, resolveTextStyle, speedAtSource, speedDuration } from '../types';
import { applyEase, clamp, easeOutBack, easeOutCubic, type BezierHandles } from '../utils/time';

export function clipAtTime(clips: Clip[], t: number): Clip | undefined {
  return clips.find((c) => t >= c.start && t < c.start + clipDuration(c));
}

/** Keyframe-interpolated value for one transform property at clip-local time. */
export function kfValue(
  kfs: Keyframe[] | undefined,
  base: Transform,
  prop: keyof Transform,
  localT: number,
  clipDur: number,
): number {
  if (!kfs || kfs.length === 0) return base[prop];
  const pts: { t: number; v: number; ease?: string; hold?: boolean; handles?: Keyframe['easeHandles'] }[] = [{ t: 0, v: base[prop] }];
  for (const k of kfs) {
    const v = k[prop as keyof Keyframe];
    if (typeof v === 'number') pts.push({ t: k.t, v, ease: k.ease, hold: k.hold, handles: k.easeHandles });
  }
  pts.sort((a, b) => a.t - b.t);
  // hold last keyframe value to the end of the clip
  if (pts[pts.length - 1].t < clipDur) pts.push({ t: clipDur, v: pts[pts.length - 1].v });
  if (localT <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (localT <= pts[i].t) {
      const p0 = pts[i - 1], p1 = pts[i];
      if (p1.t === p0.t) return p1.v;
      if (p0.hold) return p0.v; // M.10: hold segments stay flat regardless of ease
      const x = (localT - p0.t) / (p1.t - p0.t);
      return p0.v + (p1.v - p0.v) * applyEase(p1.ease, x, p1.handles);
    }
  }
  return pts[pts.length - 1].v;
}

export function evalTransform(clip: VideoClip | CompoundClip, localT: number): Transform {
  const dur = clipDuration(clip);
  const b = clip.transform;
  return {
    x: kfValue(clip.keyframes, b, 'x', localT, dur),
    y: kfValue(clip.keyframes, b, 'y', localT, dur),
    scale: kfValue(clip.keyframes, b, 'scale', localT, dur),
    rotation: kfValue(clip.keyframes, b, 'rotation', localT, dur),
    opacity: kfValue(clip.keyframes, b, 'opacity', localT, dur),
  };
}

export interface TextState {
  visible: boolean;
  shown: string;
  scale: number;
  alpha: number;
  yOffPx: number; // at 720-wide reference; caller scales
  loopScale: number; // continuous loop-animation modifier (H.13)
  loopXOffPx: number;
}

/** Per-glyph placement for text on an arc (H.11). The caller supplies the
 *  measured advance of each glyph (px at the 720-wide reference, including
 *  letter-spacing); the layout walks the arc of radius |curve| px, centred on
 *  the string's middle. rotation is in radians, applied per glyph. A positive
 *  radius arcs the text upward (centre of the circle below the baseline). */
export function arcLayout(
  text: string,
  advances: number[],
  radiusPx: number,
): { x: number; y: number; rotation: number }[] {
  const r = Math.max(40, Math.abs(radiusPx));
  const dir = radiusPx >= 0 ? 1 : -1; // +1: ∩ (circle below), −1: ∪ (circle above)
  const total = advances.reduce((a, b) => a + b, 0);
  const out: { x: number; y: number; rotation: number }[] = [];
  let s = -total / 2;
  for (let i = 0; i < text.length; i++) {
    const adv = advances[i] ?? 0;
    const th = (s + adv / 2) / r; // signed angle from the arc's top point
    out.push({
      x: Math.sin(th) * r,
      y: dir * r * (1 - Math.cos(th)), // screen px: edges drop for ∩, rise for ∪
      rotation: dir * th, // radians, CSS sign convention (y down)
    });
    s += adv;
  }
  return out;
}

export function evalText(clip: TextClip, localT: number): TextState {
  const dur = clip.dur;
  const animIn = clip.animIn ?? 'none';
  const animOut = clip.animOut ?? 'none';
  const inDur = clip.animInDur ?? 0.28;
  const outDur = clip.animOutDur ?? 0.25;
  let pin = 1;
  if (animIn !== 'none') pin = clamp(localT / Math.max(0.01, inDur), 0, 1);
  let pout = 1;
  if (animOut !== 'none') pout = clamp((dur - localT) / Math.max(0.01, outDur), 0, 1);
  let alpha = 1, scale = 1, yOff = 0, shown = clip.text;
  if (animIn === 'pop') { scale = Math.max(0.05, easeOutBack(pin)); alpha = Math.min(1, pin * 1.6); }
  else if (animIn === 'fade') alpha = easeOutCubic(pin);
  else if (animIn === 'slide') { yOff = (1 - easeOutCubic(pin)) * 46; alpha = Math.min(1, pin * 1.8); }
  else if (animIn === 'typewriter') shown = clip.text.slice(0, Math.max(0, Math.floor(clip.text.length * pin + 1e-4)));
  else if (animIn === 'word-reveal') {
    // H.14: words land one by one across the in-window — animInDur when set,
    // otherwise the clip's FULL duration (words as they are spoken).
    const span = clip.animInDur ?? dur;
    const words = clip.text.split(/\s+/).filter(Boolean);
    const n = Math.max(0, Math.min(words.length, Math.ceil(words.length * clamp(localT / Math.max(0.01, span), 0, 1))));
    shown = words.slice(0, n).join(' ');
  }
  if (animOut === 'fade') alpha *= easeOutCubic(pout);
  else if (animOut === 'pop') { scale *= pout < 1 ? Math.max(0.05, easeOutBack(pout)) : 1; alpha *= Math.min(1, pout * 1.6); }
  else if (animOut === 'slide') yOff += (1 - easeOutCubic(pout)) * 46;
  // H.13 loop/combo modifiers: continuous motion layered over in/out.
  let loopScale = 1;
  let loopX = 0;
  const loop = clip.animLoop ?? 'none';
  if (loop === 'pulse') loopScale = 1 + 0.07 * Math.sin(localT * (Math.PI * 2 / 1.1));
  else if (loop === 'wave') yOff += Math.sin(localT * 3.2) * 7;
  else if (loop === 'sway') loopX = Math.sin(localT * 2.1) * 9;
  return { visible: alpha > 0.003 && shown.length > 0, shown, scale, alpha, yOffPx: yOff, loopScale, loopXOffPx: loopX };
}

/** Fade/volume envelope of an audio clip at local time. */
export function audioLevelAt(fadeIn: number, fadeOut: number, dur: number, localT: number): number {
  let v = 1;
  if (fadeIn > 0 && localT < fadeIn) v = Math.min(v, localT / fadeIn);
  if (fadeOut > 0 && localT > dur - fadeOut) v = Math.min(v, Math.max(0, (dur - localT) / fadeOut));
  return v;
}

export { resolveTextStyle };


/** Full clip audio level at a local time: base volume × fade envelope × the
 *  volume-line keys (K.5), linearly interpolated, ends held. */
export function volumeAt(
  clip: { volume: number; fadeIn?: number; fadeOut?: number; volumeKeys?: { t: number; v: number }[] },
  clipDur: number,
  local: number,
): number {
  let level = clip.volume * audioLevelAt(clip.fadeIn ?? 0, clip.fadeOut ?? 0, clipDur, local);
  const keys = clip.volumeKeys;
  if (keys && keys.length > 0) {
    const sorted = [...keys].sort((a, b) => a.t - b.t);
    let kv = sorted[sorted.length - 1].v;
    if (local <= sorted[0].t) kv = sorted[0].v;
    else {
      for (let i = 1; i < sorted.length; i++) {
        if (local <= sorted[i].t) {
          const a = sorted[i - 1], b = sorted[i];
          kv = b.t === a.t ? b.v : a.v + (b.v - a.v) * ((local - a.t) / (b.t - a.t));
          break;
        }
      }
    }
    level *= kv;
  }
  return clamp(level, 0, 1);
}


/** Generic two-point interpolation over sorted {t, v} samples with easing. */
function interpPts(
  pts: { t: number; v: number; ease?: string; hold?: boolean; handles?: BezierHandles }[],
  localT: number,
): number {
  if (pts.length === 0) return 0;
  if (localT <= pts[0].t) return pts[0].v;
  for (let i = 1; i < pts.length; i++) {
    if (localT <= pts[i].t) {
      const p0 = pts[i - 1], p1 = pts[i];
      if (p1.t === p0.t) return p1.v;
      if (p0.hold) return p0.v;
      const x = (localT - p0.t) / (p1.t - p0.t);
      return p0.v + (p1.v - p0.v) * applyEase(p1.ease, x, p1.handles);
    }
  }
  return pts[pts.length - 1].v;
}

/** Mask geometry at a local time (M.8): base mask interpolated by keyframe masks.
 *  Structural param: video clips and (D2.1) adjustment clips both carry
 *  mask + keyframes. */
export function maskAt(
  clip: { mask?: ClipMask | null; keyframes?: Keyframe[] },
  localT: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!clip.mask) return null;
  const base = clip.mask;
  const kfs = clip.keyframes ?? [];
  if (!kfs.some((k) => k.mask)) return { x: base.x, y: base.y, w: base.w, h: base.h };
  const mk = (pick: (m: { x: number; y: number; w: number; h: number }) => number, baseV: number) => {
    const pts: { t: number; v: number; ease?: string; hold?: boolean; handles?: BezierHandles }[] = [{ t: 0, v: baseV }];
    for (const k of kfs) if (k.mask) pts.push({ t: k.t, v: pick(k.mask), ease: k.ease, hold: k.hold, handles: k.easeHandles });
    pts.sort((a, b) => a.t - b.t);
    return interpPts(pts, localT);
  };
  return {
    x: mk((m) => m.x, base.x),
    y: mk((m) => m.y, base.y),
    w: mk((m) => m.w, base.w),
    h: mk((m) => m.h, base.h),
  };
}

/** One effect's value at a local time (M.8): static value unless keyframed. */
export function effectValueAt(clip: VideoClip, type: string, localT: number): number | undefined {
  const stat = (clip.effects ?? []).find((e) => e.type === type);
  if (!stat) return undefined;
  const kfs = clip.keyframes ?? [];
  if (!kfs.some((k) => k.fx && type in k.fx)) return stat.value;
  const pts: { t: number; v: number; ease?: string; hold?: boolean; handles?: BezierHandles }[] = [{ t: 0, v: stat.value }];
  for (const k of kfs) if (k.fx && type in k.fx) pts.push({ t: k.t, v: k.fx[type], ease: k.ease, hold: k.hold, handles: k.easeHandles });
  pts.sort((a, b) => a.t - b.t);
  return interpPts(pts, localT);
}

/** Playback speed map (P.2/P.5): inverts the source-time speed curve so the
 *  engine can ask "which source frame shows at output time τ, and how fast
 *  is it moving". Freeze clips pin to one source frame. */
export interface SpeedMap { duration: number; sourceAt: (outT: number) => number; speedAt: (outT: number) => number }
const speedMapCache = new Map<string, SpeedMap>();
export function buildSpeedMap(clip: { in: number; out: number; speed: number; speedKeys?: { t: number; speed: number }[]; freezeAt?: number }): SpeedMap {
  const span = clip.out - clip.in;
  if (clip.freezeAt != null) {
    const dur = span / (clip.speed || 1);
    return { duration: dur, sourceAt: () => clip.freezeAt! - clip.in, speedAt: () => 0 };
  }
  const keys = clip.speedKeys ?? [];
  if (keys.length === 0) {
    const v = clip.speed || 1;
    return { duration: span / v, sourceAt: (t) => t * v, speedAt: () => v };
  }
  const key = `${clip.in}|${span}|${JSON.stringify(keys)}`;
  const hit = speedMapCache.get(key);
  if (hit) return hit;
  const duration = speedDuration(span, keys);
  const N = 240;
  const cum: number[] = [0];
  for (let i = 0; i < N; i++) {
    const s0 = (i / N) * span, s1 = ((i + 1) / N) * span;
    cum.push(cum[i] + (s1 - s0) / Math.max(0.05, speedAtSource(keys, (s0 + s1) / 2)));
  }
  const map: SpeedMap = {
    duration,
    sourceAt: (outT) => {
      const t = Math.min(Math.max(outT, 0), duration);
      let lo = 0, hi = N;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid + 1] < t) lo = mid + 1; else hi = mid;
      }
      const segT0 = cum[lo], segT1 = cum[lo + 1] ?? duration;
      const frac = segT1 > segT0 ? (t - segT0) / (segT1 - segT0) : 0;
      return ((lo + frac) / N) * span;
    },
    speedAt: (outT) => speedAtSource(keys, map.sourceAt(outT)),
  };
  if (speedMapCache.size > 64) speedMapCache.clear();
  speedMapCache.set(key, map);
  return map;
}

/** Source time (absolute, in the media file) a media clip shows at a
 *  clip-local time — the same maths the playback engine applies to top-level
 *  clips, exported so compound followers (Preview) drive nested media
 *  identically: speed map + freeze pin. Reverse is render-only (the engine
 *  badges it and plays forward), so followers do the same. */
export function sourceTimeAt(
  clip: { in: number; out: number; speed: number; speedKeys?: { t: number; speed: number }[]; freezeAt?: number },
  local: number,
): number {
  return clip.in + buildSpeedMap(clip).sourceAt(Math.max(0, local));
}

/** Instantaneous playback-rate multiplier of a media clip at a local time. */
export function speedRateAt(
  clip: { in: number; out: number; speed: number; speedKeys?: { t: number; speed: number }[]; freezeAt?: number },
  local: number,
): number {
  return buildSpeedMap(clip).speedAt(Math.max(0, local));
}
