// CutLab project model — the PLAN §3 JSON shape, minimally extended.
// This exact shape is what gets saved to disk, autosaved, and rendered by Lane B.

export type MediaKind = 'video' | 'audio' | 'image' | 'matte' | 'depth';
export type TrackKind = 'video' | 'audio' | 'text';
export type TransitionType =
  | 'cut' | 'dissolve' | 'flash' | 'glare' | 'slide' | 'shake' | 'blur-pulse'
  | 'zoom' | 'flip' | 'invert-flash' | 'mask-wipe' | 'blur-cut';
export type AnimType = 'none' | 'pop' | 'fade' | 'slide' | 'typewriter' | 'word-reveal';
export type AnimLoop = 'none' | 'wave' | 'pulse' | 'sway';
export type EffectType = 'brightness' | 'contrast' | 'saturation' | 'blur' | 'glow' | 'sharpen' | 'vignette' | 'tv-lines' | 'haze' | 'wide-angle' | 'motion-blur' | 'relight' | 'turbulent-displace';

export interface MediaItem {
  id: string;
  src: string; // original file name
  kind: MediaKind;
  /** Bin (in-project folder) this item belongs to; absent = the root bin. */
  bin?: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface Transform {
  x: number; // px offset from centre
  y: number; // px offset from centre
  scale: number;
  rotation: number; // DEGREES — the one unit everywhere (D2.6): stage, preview (CSS rotate deg), Lane B (converted to radians at the ffmpeg call), keyframes and this Inspector all speak degrees.
  opacity: number; // 0..1
}

export interface Keyframe {
  t: number; // seconds from clip start (timeline span of the clip)
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
  ease?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'cubicOut' | 'reboundOut' | 'backIn' | 'bezier';
  /** Bezier handles for the segment ENDING at this keyframe (M.3), unit space. */
  easeHandles?: { x1: number; y1: number; x2: number; y2: number };
  /** Hold: this keyframe's value stays flat until the next keyframe (M.10). */
  hold?: boolean;
  /** Mask geometry at this keyframe (M.8) — enables animated masks + wipes. */
  mask?: { x: number; y: number; w: number; h: number };
  /** Effect values at this keyframe (M.8), keyed by effect type. */
  fx?: Record<string, number>;
}

export interface ClipEffect {
  type: EffectType;
  value: number;
  /** Bypass without removing (I.11); absent = on. */
  enabled?: boolean;
  /** Extra parameters for spatial effects (haze centre cx/cy, 0..1;
   *  turbulent-displace field: scale 0..1, seed, evolution 0..1,
   *  falloff 0..1 — vertical strength fade, full at the layer's bottom,
   *  default 0.85, 0 = uniform. AE recipe mode (params.amount present):
   *  amount/size in px at face value, complexity = fBm detail, pin 1 =
   *  Pin All, evolution_rate in deg/sec; value becomes a plain master
   *  scale and falloff defaults off). */
  params?: Record<string, number>;
  /** Placed lights for the 'relight' effect (N.11), up to 2. */
  lights?: { x: number; y: number; color: string; radius: number; intensity: number }[];
}

export interface WheelVal { r: number; g: number; b: number; master: number }
export interface CurvePt { x: number; y: number }
/** The grade object (N.2–N.8): one model shared by clip grades and the
 *  project look. Chain order is fixed: LUT → primaries → curves → HSL. */
export interface Grade {
  temperature: number; // −1..1
  tint: number; // −1..1
  exposure: number; // −2..2 (stops-ish)
  highlights: number; // −1..1
  shadows: number; // −1..1
  contrast: number; // −1..1
  pivot: number; // 0..1
  lift: WheelVal;
  gamma: WheelVal;
  gain: WheelVal;
  offset: WheelVal;
  curves?: { master?: CurvePt[]; r?: CurvePt[]; g?: CurvePt[]; b?: CurvePt[] };
  /** Hue-vs curves (N.12): x = source hue 0..1; hueHue y = hue shift −1..1
   *  (±180°), hueSat y = saturation delta −1..1. Points sorted by x.
   *  lumSat (D2.4): x = source luma (Rec.601) 0..1, y = saturation
   *  delta −1..1 — desaturate the shadows, keep the highlights vivid. */
  hueCurves?: { hueHue?: CurvePt[]; hueSat?: CurvePt[]; lumSat?: CurvePt[] };
  hsl?: Record<string, { h: number; s: number; l: number }>;
  lutId?: string;
  lutStrength?: number; // default 0.5 — LUTs at half strength (house lesson)
  /** Per-layer bypass in a grade stack (D1.1); absent = on. Ignored for
   *  the project look, which is a single grade, not a stack. */
  enabled?: boolean;
  /** Qualifier-lite key (D1.2): when present, this layer grades ONLY the
   *  selected HSV/luma range. hue = centre 0..1, hueWidth/hueSoft in
   *  0..0.5 of the wheel; sat/luma are [min, max] ranges 0..1 with
   *  satSoft/lumaSoft feather widths. Absent = whole frame. */
  key?: GradeKey;
}

/** Qualifier-lite selection (D1.2). See Grade.key. */
export interface GradeKey {
  hue: number;
  hueWidth: number;
  hueSoft: number;
  satMin: number;
  satMax: number;
  satSoft: number;
  lumaMin: number;
  lumaMax: number;
  lumaSoft: number;
}
export const HSL_CHANNELS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;

export interface ClipMask {
  shape: 'rect' | 'circle' | 'linear' | 'pen';
  x: number; // fractions of canvas (for linear: band centre; for pen: unused)
  y: number;
  w: number;
  h: number;
  feather: number; // fraction of canvas width
  invert: boolean;
  /** Linear band rotation in degrees (O.6). */
  angle?: number;
  /** Pen points, canvas fractions (O.6). */
  points?: { x: number; y: number }[];
}

/** Chroma key settings (O.8) — applied by Lane B; preview shows a badge. */
export interface ChromaKey {
  color: string;
  intensity: number; // 0..1 (~0.5 working value from the studies)
  shadow: number; // 0..1
  spill: number; // 0..1
}

interface BaseClip {
  id: string;
  start: number; // timeline seconds
  transitionIn?: TransitionType | null;
  /** Link group (K.7/K.8): clips sharing a groupId select together until unlinked. */
  groupId?: string;
  /** Slide-family direction (J.5); absent = 'down', the reference favourite. */
  transitionDir?: 'left' | 'right' | 'up' | 'down';
  transitionDur?: number;
  /** Blur-cut strength (J.12): peak gblur sigma of the masked join. The
   *  blur peaks AT the boundary on both sides — the previous clip's tail
   *  ramps 0 → peak over its last transitionDur seconds and this clip's
   *  head settles peak → 0 over its first transitionDur. Absent = 9. */
  transitionBlur?: number;
  /** Blur-cut character (J.12): 'soft' = plain gaussian settle; 'whip' =
   *  directional streak along transitionDir (absent dir = right); 'zoom' =
   *  scale-settle (1.12 → 1) under the blur. Absent = 'soft'. */
  transitionMode?: 'soft' | 'whip' | 'zoom';
  /** Mask-wipe origin (J.11): canvas fractions the wipe circle grows from. */
  wipeCx?: number;
  /** Mask-wipe reveal shape (D2.3); absent = circle. Lane B draws the
   *  true shape; the preview approximates with the circle. */
  wipeShape?: 'circle' | 'petal' | 'blob';
  wipeCy?: number;
}

export interface VideoClip extends BaseClip {
  media: string;
  in: number;
  out: number;
  speed: number;
  /** Speed ramp keys (P.2): source-time (from clip in-point) → speed. */
  speedKeys?: { t: number; speed: number }[];
  /** Reverse playback (P.4) — Lane B reverses; preview badges it. */
  reversed?: boolean;
  /** Freeze frame: hold this source time for the clip's whole length (P.5). */
  freezeAt?: number;
  /** Keep natural pitch while speed changes (P.6). */
  pitchPreserve?: boolean;
  /** Optical-flow smooth slow-motion at render (P.7, minterpolate). */
  smoothSlowmo?: boolean;
  muted: boolean;
  volume: number;
  transform: Transform;
  keyframes?: Keyframe[];
  effects?: ClipEffect[];
  mask?: ClipMask | null;
  /** Matte media driving this clip's alpha (O.9); Lane B composites through it. */
  matteId?: string;
  /** Chroma key (O.8); absent = no key. */
  chromaKey?: ChromaKey;
  /** The clip's colour grade (§N); absent = no grade. LEGACY single-grade
   *  field — superseded by `grades` (D1.1); loads migrate it into a
   *  one-element stack. Readers should use gradeLayersOf(). */
  grade?: Grade;
  /** Serial grade stack (D1.1): up to 3 layers applied in order, then
   *  the project look on top. When present (even empty), it wins over
   *  the legacy `grade` field. */
  grades?: Grade[];
  /** Crop fractions per edge + edge softness (G.5); absent = uncropped. */
  crop?: { l: number; t: number; r: number; b: number; softness: number } | null;
  /** Composite blend mode (G.6); absent/'normal' = plain alpha. */
  blend?: 'normal' | 'screen' | 'multiply' | 'overlay' | 'lighten' | 'darken' | 'hard-light';
  flipH?: boolean;
  flipV?: boolean;
  /** Audio fades for the clip's own sound (G.9), mirroring AudioClip. */
  fadeIn?: number;
  fadeOut?: number;
  volumeKeys?: { t: number; v: number }[];
  pan?: number;
  eqLow?: number;
  eqMid?: number;
  eqHigh?: number;
  /** 6-band parametric EQ (D2.5) — supersedes the 3-band fields when
   *  present (the editor migrates legacy values into bands). */
  eqBands?: EqBand[];
  denoise?: boolean;
  /** Stage fit (C.11): 'cover' fills the canvas-aspect layer box (default engine
   *  behaviour); 'blur-fill' letterboxes the whole frame over a blurred,
   *  stretched copy of itself. */
  fit?: 'cover' | 'blur-fill';
  /** Multicam (F.17): alternate angles of the same take. `media` always
   *  mirrors the ACTIVE angle's media id, so every existing consumer (engine,
   *  timeline, Lane B) keeps working; switching an angle only re-points
   *  media/activeAngle. D1.4: each angle may carry a syncOffset (seconds,
   *  measured by the server's audio cross-correlation) — the source time
   *  to read the same moment from that angle is the anchor's + offset.
   *  The clip's in/out always express the ACTIVE angle's window:
   *  switching angles shifts in/out by the offset delta, so alignment
   *  survives switches and every consumer stays sync-correct. */
  angles?: { media: string; label: string; syncOffset?: number }[];
  activeAngle?: number;
  /** D1.5 voice isolation: the demucs vocals stem registered as a
   *  project media asset; the render blends stem vs original by
   *  strength, the preview plays the stem. Original audio untouched. */
  audioOverride?: AudioOverride;
}

/** One parametric EQ band (D2.5): peaking filter, freq Hz, gain dB,
 *  Q (bandwidth). Six bands per clip; the preview's WebAudio biquads
 *  and Lane B's equalizer chain implement the same RBJ peaking maths. */
export interface EqBand {
  freq: number;
  gain: number;
  q: number;
}

/** D1.5: a clip's voice-isolation override. `stemMedia` is a MediaAsset
 *  id (the demucs vocals stem, full length, same timing as the source);
 *  `strength` 0..1 = stem share of the rendered blend; `enabled` toggles
 *  back to the original mix without destroying anything. */
export interface AudioOverride {
  stemMedia: string;
  strength: number;
  enabled: boolean;
}

/** Compound clip (F.16): a window (in..out, always 1:1 — no speed) into a
 *  nested sub-project. The nest's tracks keep their original ids so
 *  uncompound is a plain merge-back. Nest media ids reference the PARENT
 *  project's media registry. */
export interface CompoundClip extends BaseClip {
  nest: { name: string; tracks: Track[] };
  in: number;
  out: number;
  /** Master gain for the nest's sound in preview (followers only). */
  volume?: number;
  transform: Transform;
  keyframes?: Keyframe[];
  effects?: ClipEffect[];
  mask?: ClipMask | null;
  grade?: Grade;
  /** Serial grade stack (D1.1) — see VideoClip.grades. */
  grades?: Grade[];
  crop?: { l: number; t: number; r: number; b: number; softness: number } | null;
  blend?: VideoClip['blend'];
  flipH?: boolean;
  flipV?: boolean;
}

/** Adjustment clip (I.12): carries effects + grade only; in preview and in
 *  Lane B it applies to the composite of everything BENEATH it on the
 *  timeline for its duration. Lives on a video track; duration-based like a
 *  text clip. The `adj: true` discriminant keeps it out of the media paths. */
export interface AdjustmentClip extends BaseClip {
  adj: true;
  dur: number;
  effects?: ClipEffect[];
  grade?: Grade;
  /** Serial grade stack (D1.1) — see VideoClip.grades. */
  grades?: Grade[];
  /** D2.1: an optional window — the adjustment applies only inside
   *  the mask (feathered); keyframes animate its geometry (maskAt),
   *  which is how a tracked window follows the subject. */
  mask?: ClipMask | null;
  keyframes?: Keyframe[];
}

export interface AudioClip extends BaseClip {
  media: string;
  in: number;
  out: number;
  speed: number;
  /** Speed ramp keys (P.2), reverse (P.4), freeze (P.5), pitch (P.6). */
  speedKeys?: { t: number; speed: number }[];
  reversed?: boolean;
  freezeAt?: number;
  pitchPreserve?: boolean;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** Volume-line keyframes (K.5): clip-local t (s) → level multiplier. */
  volumeKeys?: { t: number; v: number }[];
  pan?: number; // −1..1 (K.9)
  eqLow?: number; // dB (K.10)
  eqMid?: number;
  eqHigh?: number;
  /** 6-band parametric EQ (D2.5) — see VideoClip.eqBands. */
  eqBands?: EqBand[];
  /** Render-time noise reduction flag (K.12) — Lane B afftdn. */
  denoise?: boolean;
  voiceFx?: 'none' | 'echo' | 'hall'; // K.13 (render-time)
  /** D1.5 voice isolation (see VideoClip.audioOverride). */
  audioOverride?: AudioOverride;
}

export interface TextClip extends BaseClip {
  text: string;
  dur: number;
  style: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  color?: string;
  strokeColor?: string;
  strokeWidth?: number;
  shadow?: boolean;
  x?: number; // fraction of canvas width (anchor centre)
  y?: number; // fraction of canvas height (anchor centre)
  animIn?: AnimType;
  animOut?: AnimType;
  /** Animation durations in seconds (H.13); absent = engine defaults 0.28 in / 0.25 out. */
  animInDur?: number;
  animOutDur?: number;
  animLoop?: AnimLoop;
  effects?: string[]; // e.g. ['glow']
  /** Designed shadow (H.6); supersedes the legacy boolean when present. */
  shadowObj?: { color: string; opacity: number; blur: number; distance: number; angle: number };
  /** Glow parameters (H.7) — colour always derives from the fill, never picked. */
  glowObj?: { intensity: number; range: number };
  /** Background plate (H.8): pads/offsets in px at the 720-wide reference.
   *  shape 'bubble' (H.12) adds a speech-bubble tail on the named edge. */
  plate?: {
    color: string; opacity: number; radius: number; padX: number; padY: number; offX: number; offY: number;
    shape?: 'rect' | 'bubble';
    tail?: 'bottom' | 'top' | 'left' | 'right';
    tailAt?: number; // 0..1 along the edge
    tailSize?: number; // px at the 720-wide reference
  } | null;
  /** Text on an arc (H.11): radius in px at the 720-wide reference (sign
   *  flips the arc: + curves up, − curves down); absent/0 = straight. */
  curve?: number;
  /** Spacing group (H.9). */
  align?: 'left' | 'center' | 'right';
  charSpacing?: number; // px at the 720-wide reference
  lineSpacing?: number; // unitless multiplier
  /** Per-word highlight (H.10): **word** spans render in this colour. */
  highlightColor?: string;
  /** Outline-only text (H.17): fill alpha 0, stroke remains. */
  noFill?: boolean;
  /** Word timings (L.6) from transcription: clip-local seconds per word. */
  words?: { w: string; t0: number; t1: number }[];
}

export type Clip = VideoClip | AudioClip | TextClip | CompoundClip | AdjustmentClip;

export interface Track {
  id: string;
  kind: TrackKind;
  /** Header flags (E.4–E.7): mute/solo are audio semantics; lock blocks edits; hide removes video/text from preview + render. */
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  hidden?: boolean;
  /** Display name + header colour (E.8) — metadata only. */
  name?: string;
  color?: string;
  /** Per-track lane height in px (E.9); absent = per-kind default. */
  height?: number;
  /** Track-level gain 0..1 (K.16 level 2); absent = 1. */
  volume?: number;
  /** Fairlight bus assignment (D2.5): 'dialogue' tracks key the
   *  ducking sidechain; 'music'/'fx' tracks get ducked. Absent = the
   *  track rides the plain mix (never ducked, never a key). */
  bus?: 'dialogue' | 'music' | 'fx';
  clips: Clip[];
}

export interface Marker {
  t: number;
  label: string;
  /** Swatch colour (hex); absent = red for notes, grey for beats. */
  color?: string;
  /** Range markers: duration in seconds; the marker spans t..t+dur. */
  dur?: number;
}

/** One prompt-editing history entry (parked-features plan, Feature 1 §2).
 *  Stored in the project JSON so the history travels with the project;
 *  `applied` flips true only when the user Accepted the diff. */
export interface PromptHistoryEntry {
  id: string;
  prompt: string;
  /** ISO timestamp of when the revised project came back. */
  at: string;
  /** The worker's plain-language summary of the change. */
  summary?: string;
  applied: boolean;
}

export interface Project {
  version: 1;
  name: string;
  canvas: { w: number; h: number; fps: number; bg?: string };
  media: MediaItem[];
  /** Named media bins, including empty ones (items name theirs via MediaItem.bin). */
  mediaBins?: string[];
  /** Timeline I/O range (seconds), set with the I/O keys; export + loop consumers. */
  rangeIn?: number;
  rangeOut?: number;
  /** Project look (N.10): a grade applied over the whole composite, after clip grades. */
  look?: Grade;
  /** Bus-level audio (K.6/K.11/K.16): master gain, loudness normalise, dialogue compressor. */
  audioBus?: {
    masterGain: number;
    normalise: boolean;
    compEnabled: boolean;
    compThreshold: number; // dB
    compRatio: number;
    compMakeup: number; // dB
    /** Ducking (D2.5): dialogue-bus tracks key a sidechain that dips
     *  the music/fx buses by `amount` dB (attack/release in ms). */
    ducking?: { enabled: boolean; amount: number; attack: number; release: number };
  };
  tracks: Track[];
  markers: Marker[];
  /** Prompt-editing history (Feature 1 §2); absent = never prompt-edited. */
  promptHistory?: PromptHistoryEntry[];
  /** MCP Phase 1 edit log: one entry per agent write through the
   *  cutlab-mcp connector (newest last, capped at 100 entries by the
   *  writer). `revision` is the project row's revision after that
   *  write, or null on a pre-migration relay that does not track it. */
  editLog?: { at: string; by: string; ops: string[]; revision: number | null }[];
  /** D2.2 smart reframe: the smoothed 9:16 crop-centre path (timeline
   *  seconds → centre x as a frame fraction), measured by the track
   *  lane on `clipId`. The export option consumes it. */
  reframe?: { clipId: string; points: { t: number; cx: number }[] };
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export interface TextStylePreset {
  fontFamily: string;
  fontWeight: number;
  fontSize: number; // px at 720-wide canvas; scaled by canvas.w/720
  color: string;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
}

export const FONT_STACKS: { label: string; stack: string }[] = [
  { label: 'System sans (default)', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: 'Arial / Helvetica', stack: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
  { label: 'Georgia (serif)', stack: 'Georgia, "Times New Roman", serif' },
  { label: 'Times New Roman', stack: '"Times New Roman", Times, serif' },
  { label: 'Courier New (mono)', stack: '"Courier New", Courier, monospace' },
  { label: 'Impact (poster)', stack: 'Impact, "Arial Black", sans-serif' },
  { label: 'Trebuchet MS', stack: '"Trebuchet MS", "Segoe UI", sans-serif' },
];

export const TEXT_PRESETS: Record<string, TextStylePreset> = {
  'pop-bold': {
    fontFamily: 'Impact, "Arial Black", sans-serif',
    fontWeight: 800, fontSize: 92, color: '#FFFFFF',
    strokeColor: '#111111', strokeWidth: 6, shadow: true,
  },
  plain: {
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontWeight: 600, fontSize: 54, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 0, shadow: false,
  },
  caption: {
    fontFamily: '"Segoe UI", system-ui, sans-serif',
    fontWeight: 700, fontSize: 44, color: '#FFFFFF',
    strokeColor: '#000000', strokeWidth: 3, shadow: true,
  },
};

export interface ResolvedShadow { color: string; opacity: number; blur: number; distance: number; angle: number }
export const DEFAULT_SHADOW: ResolvedShadow = { color: '#000000', opacity: 0.55, blur: 10, distance: 4, angle: 90 };
/** H.6: the designed shadow object wins; legacy boolean true = the old fixed look. */
export function resolveShadow(clip: TextClip): ResolvedShadow | null {
  if (clip.shadowObj) return clip.shadowObj;
  if (clip.shadow) return { ...DEFAULT_SHADOW };
  return null;
}

export function resolveTextStyle(clip: TextClip): TextStylePreset {
  const p = TEXT_PRESETS[clip.style] ?? TEXT_PRESETS['pop-bold'];
  return {
    fontFamily: clip.fontFamily ?? p.fontFamily,
    fontWeight: clip.fontWeight ?? p.fontWeight,
    fontSize: clip.fontSize ?? p.fontSize,
    color: clip.color ?? p.color,
    strokeColor: clip.strokeColor ?? p.strokeColor,
    strokeWidth: clip.strokeWidth ?? p.strokeWidth,
    shadow: clip.shadow ?? p.shadow,
  };
}

/** On-timeline duration of a clip in seconds. */
export function clipDuration(c: Clip): number {
  if ('dur' in c) return c.dur;
  const span = c.out - c.in;
  if ('nest' in c) return span; // compound window is always 1:1
  const keys = 'speedKeys' in c ? c.speedKeys : undefined;
  if (keys && keys.length > 0) return speedDuration(span, keys);
  return span / (c.speed || 1);
}

/** Speed as a function of SOURCE time (P.2): piecewise-linear between keys,
 *  clamped to the end values outside the keyed range. */
export function speedAtSource(keys: { t: number; speed: number }[], s: number): number {
  if (keys.length === 0) return 1;
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  if (s <= sorted[0].t) return sorted[0].speed;
  for (let i = 1; i < sorted.length; i++) {
    if (s <= sorted[i].t) {
      const a = sorted[i - 1], b = sorted[i];
      return b.t === a.t ? b.speed : a.speed + (b.speed - a.speed) * ((s - a.t) / (b.t - a.t));
    }
  }
  return sorted[sorted.length - 1].speed;
}

/** Output duration of a source span under a speed curve: ∫ ds / v(s). */
export function speedDuration(span: number, keys: { t: number; speed: number }[]): number {
  const N = 240;
  let total = 0;
  for (let i = 0; i < N; i++) {
    const s0 = (i / N) * span;
    const s1 = ((i + 1) / N) * span;
    const v = Math.max(0.05, speedAtSource(keys, (s0 + s1) / 2));
    total += (s1 - s0) / v;
  }
  return total;
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c);
}

export function projectDuration(p: Project): number {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function newId(prefix = 'id'): string {
  return prefix + '_' + Math.random().toString(36).slice(2, 9);
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: 'Untitled project',
    canvas: { w: 720, h: 1280, fps: 30 },
    media: [],
    tracks: [
      { id: newId('trk'), kind: 'video', clips: [] },
      { id: newId('trk'), kind: 'audio', clips: [] },
      { id: newId('trk'), kind: 'text', clips: [] },
    ],
    markers: [],
  };
}
