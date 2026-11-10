// CutLab edit operations — pure JSON mutations for the MCP connector
// (Phase 1, UPGRADE-PLAN.md §3). Every editing tool in index.ts is a
// thin wrapper: load project → applyEditOp(s) here → schema-validate →
// guarded save. This file has NO Deno APIs, NO fetch, NO imports — it
// runs identically in the Edge Function and under vite SSR in the
// fixture harness (scripts/mcp-harness.entry.ts).
//
// The maths mirrors the editor's canonical implementations:
//   split      → src/state/actions.ts splitClipAt (frame-quantised,
//                keyframes rebased, right half loses its transition)
//   angle cut  → actions.ts performAngleCut + shiftedWindow (D1.4)
//   compound   → actions.ts makeCompoundFromSelection / uncompoundSelected
//   durations  → src/types.ts clipDuration / speedDuration
//   EQ bands   → src/services/eq.ts bandsOf / defaultEqBands
//   grade      → src/services/grade.ts DEFAULT_GRADE, MAX_GRADE_LAYERS = 3
//   effects    → src/components/Inspector.tsx EFFECTS default values
//   text       → src/types.ts TEXT_PRESETS; user presets are
//                client-localStorage only (src/services/textPresets.ts),
//                so save_text_preset (index.ts) captures a clip's fields
//                and returns them as a portable preset payload instead
//                of inventing a project field the schema does not have.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Obj = Record<string, any>;
export type Project = Obj;
export interface EditOp {
  op: string;
  [k: string]: any;
}

// ---------------------------------------------------------------------------
// small pure helpers (ports of types.ts / time.ts — one behaviour, two homes)
// ---------------------------------------------------------------------------

export const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)) as T);

let idCounter = 0;
export function newId(prefix = 'id'): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${idCounter.toString(36)}`;
}

/** Frame quantisation (src/utils/time.ts qFrame). */
export const qFrame = (t: number, fps: number) => Math.round(t * fps) / fps;

export function speedAtSource(keys: { t: number; speed: number }[], s: number): number {
  if (!keys.length) return 1;
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

export function speedDuration(span: number, keys: { t: number; speed: number }[]): number {
  const N = 240;
  let total = 0;
  for (let i = 0; i < N; i++) {
    const s0 = (i / N) * span, s1 = ((i + 1) / N) * span;
    const v = Math.max(0.05, speedAtSource(keys, (s0 + s1) / 2));
    total += (s1 - s0) / v;
  }
  return total;
}

/** On-timeline duration of a clip (types.ts clipDuration). */
export function clipDuration(c: Obj): number {
  if ('dur' in c) return c.dur;
  const span = c.out - c.in;
  if ('nest' in c) return span;
  const keys = c.speedKeys as { t: number; speed: number }[] | undefined;
  if (keys && keys.length > 0) return speedDuration(span, keys);
  return span / (c.speed || 1);
}
export const clipEnd = (c: Obj) => c.start + clipDuration(c);

export function projectDuration(p: Project): number {
  let d = 0;
  const walk = (tracks: Obj[]) => {
    for (const t of tracks) for (const c of t.clips ?? []) {
      d = Math.max(d, clipEnd(c));
      if (c.nest?.tracks) walk(c.nest.tracks);
    }
  };
  walk(p.tracks ?? []);
  return d;
}

export const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };

export const DEFAULT_GRADE: Obj = {
  temperature: 0, tint: 0, exposure: 0, highlights: 0, shadows: 0,
  contrast: 0, pivot: 0.5,
  lift: { r: 0, g: 0, b: 0, master: 0 },
  gamma: { r: 0, g: 0, b: 0, master: 0 },
  gain: { r: 0, g: 0, b: 0, master: 0 },
  offset: { r: 0, g: 0, b: 0, master: 0 },
  lutStrength: 0.5,
};
export const MAX_GRADE_LAYERS = 3;

/** Effect default values (Inspector.tsx EFFECTS table). */
export const EFFECT_DEFAULTS: Record<string, number> = {
  brightness: 0.15, contrast: 0.15, saturation: 0.2, blur: 6, glow: 0.6,
  sharpen: 0.8, vignette: 0.45, 'tv-lines': 0.5, haze: 8,
  'wide-angle': 0.5, 'motion-blur': 0.5, relight: 0.6, 'turbulent-displace': 0.6,
};
export const EFFECT_TYPES = Object.keys(EFFECT_DEFAULTS);

/** Built-in text style presets (types.ts TEXT_PRESETS). */
export const TEXT_PRESETS: Record<string, Obj> = {
  'pop-bold': {
    fontFamily: 'Impact, "Arial Black", sans-serif', fontWeight: 800, fontSize: 92,
    color: '#FFFFFF', strokeColor: '#111111', strokeWidth: 6, shadow: true,
  },
  plain: {
    fontFamily: '"Segoe UI", system-ui, sans-serif', fontWeight: 600, fontSize: 54,
    color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 0, shadow: false,
  },
  caption: {
    fontFamily: '"Segoe UI", system-ui, sans-serif', fontWeight: 700, fontSize: 44,
    color: '#FFFFFF', strokeColor: '#000000', strokeWidth: 3, shadow: true,
  },
};
/** Fields a user text preset captures (textPresets.ts CAPTURED). */
export const TEXT_PRESET_FIELDS = [
  'style', 'fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth',
  'shadow', 'shadowObj', 'glowObj', 'plate', 'align', 'charSpacing', 'lineSpacing',
  'highlightColor', 'noFill', 'animIn', 'animOut', 'animInDur', 'animOutDur', 'animLoop',
];

const EQ_DEFAULT_FREQS = [80, 250, 800, 2500, 6000, 12000];
export const defaultEqBands = () => EQ_DEFAULT_FREQS.map((freq) => ({ freq, gain: 0, q: 0.9 }));
/** eq.ts bandsOf: own bands win; legacy 3-band maps onto bands 1/3/5. */
export function bandsOf(clip: Obj): { freq: number; gain: number; q: number }[] {
  if (Array.isArray(clip.eqBands) && clip.eqBands.length > 0) {
    const out = clip.eqBands.slice(0, 6).map((b: Obj) => ({
      freq: Math.min(16000, Math.max(30, b.freq || 1000)),
      gain: Math.min(18, Math.max(-18, b.gain || 0)),
      q: Math.min(10, Math.max(0.2, b.q || 0.9)),
    }));
    while (out.length < 6) out.push({ freq: EQ_DEFAULT_FREQS[out.length], gain: 0, q: 0.9 });
    return out;
  }
  if (clip.eqLow || clip.eqMid || clip.eqHigh) {
    const out = defaultEqBands();
    out[0] = { freq: 200, gain: clip.eqLow ?? 0, q: 0.7 };
    out[2] = { freq: 1000, gain: clip.eqMid ?? 0, q: 0.9 };
    out[4] = { freq: 4000, gain: clip.eqHigh ?? 0, q: 0.7 };
    return out;
  }
  return defaultEqBands();
}

/** A minimal valid empty project (types.ts emptyProject, ids injectable). */
export function buildEmptyProject(opts: {
  name?: string; w?: number; h?: number; fps?: number; ids?: [string, string, string];
} = {}): Project {
  const [v, a, t] = opts.ids ?? [newId('trk'), newId('trk'), newId('trk')];
  return {
    version: 1,
    name: opts.name ?? 'Untitled project',
    canvas: { w: opts.w ?? 720, h: opts.h ?? 1280, fps: opts.fps ?? 30 },
    media: [],
    tracks: [
      { id: v, kind: 'video', clips: [] },
      { id: a, kind: 'audio', clips: [] },
      { id: t, kind: 'text', clips: [] },
    ],
    markers: [],
  };
}

// ---------------------------------------------------------------------------
// lookup helpers (operate on a draft; throw friendly errors)
// ---------------------------------------------------------------------------

function fail(msg: string): never { throw new Error(msg); }

export function findTrack(p: Project, trackId: string): Obj {
  const t = (p.tracks ?? []).find((x: Obj) => x.id === trackId);
  if (!t) fail(`track '${trackId}' not found in this project`);
  return t;
}

/** Find a clip on the top-level tracks (optionally within one track). */
export function findClip(p: Project, clipId: string, trackId?: string): { track: Obj; clip: Obj } {
  const tracks = trackId ? [findTrack(p, trackId)] : (p.tracks ?? []);
  for (const track of tracks) {
    const clip = (track.clips ?? []).find((c: Obj) => c.id === clipId);
    if (clip) return { track, clip };
  }
  fail(`clip '${clipId}' not found${trackId ? ` on track '${trackId}'` : ' in this project'}`);
}

/** Visit every clip including compound nests (media-reference checks). */
export function walkClips(p: Project, fn: (clip: Obj, track: Obj) => void) {
  const walk = (tracks: Obj[]) => {
    for (const t of tracks) for (const c of t.clips ?? []) {
      fn(c, t);
      if (c.nest?.tracks) walk(c.nest.tracks);
    }
  };
  walk(p.tracks ?? []);
}

export function findMedia(p: Project, mediaId: string): Obj {
  const m = (p.media ?? []).find((x: Obj) => x.id === mediaId);
  if (!m) fail(`media '${mediaId}' is not in the project media registry`);
  return m;
}

const isTextClip = (clip: Obj, track: Obj) => track.kind === 'text' || typeof clip.text === 'string';
const isAdjClip = (clip: Obj) => clip.adj === true;
const isCompoundClip = (clip: Obj) => !!clip.nest && typeof clip.nest === 'object';

/** Grade layers of a holder (grade.ts gradeLayersOf: `grades` wins). */
export function gradeLayersOf(holder: Obj): Obj[] {
  if (Array.isArray(holder.grades)) return holder.grades;
  return holder.grade ? [holder.grade] : [];
}
function writeGradeLayers(holder: Obj, layers: Obj[]) {
  holder.grades = layers;
  delete holder.grade;
}
function mergeGrade(base: Obj, partial: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(partial ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = { ...base[k], ...v };
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}

/** D1.4 shiftedWindow (actions.ts): window shift when sync offset changes. */
export function shiftedWindow(winIn: number, winOut: number, delta: number): { in: number; out: number } {
  if (!delta) return { in: winIn, out: winOut };
  const ni = winIn + delta;
  if (ni < 0) return { in: 0, out: Math.max(0.05, winOut + delta) };
  return { in: ni, out: winOut + delta };
}

function sortClips(track: Obj) {
  track.clips.sort((a: Obj, b: Obj) => a.start - b.start);
}

/** Apply a partial patch: an absent or undefined key is skipped; a key
 *  present with value null DELETES the field. */
function patch(clip: Obj, fields: Obj, allowed: string[]) {
  for (const k of allowed) {
    if (!(k in fields) || fields[k] === undefined) continue;
    if (fields[k] === null) delete clip[k];
    else clip[k] = clone(fields[k]);
  }
}

// ---------------------------------------------------------------------------
// revision / edit-log helpers (pure — the write path in index.ts uses them)
// ---------------------------------------------------------------------------

/** Optimistic-concurrency gate: refuse a stale write with a clear error. */
export function checkRevision(current: number | null, expected?: number | null) {
  if (expected === undefined || expected === null) return;
  if (current === null) return; // pre-migration relay: nothing to check against
  if (expected !== current) {
    throw new Error(
      `stale write refused: this project is at revision ${current}, but the edit was based on revision ${expected}. ` +
      `Reload the project (get_project) and re-apply the edit so a newer change is not overwritten.`,
    );
  }
}

export interface EditLogEntry { at: string; by: string; ops: string[]; revision: number | null }

/** Append one entry to project.editLog, capped at the newest 100. */
export function appendEditLog(p: Project, entry: EditLogEntry): Project {
  const log = Array.isArray(p.editLog) ? p.editLog : [];
  p.editLog = [...log, entry].slice(-100);
  return p;
}

// ---------------------------------------------------------------------------
// op implementations — each mutates the draft it is given
// ---------------------------------------------------------------------------

function opSetCanvas(p: Project, op: EditOp) {
  if (!p.canvas || typeof p.canvas !== 'object') fail('project has no canvas object');
  for (const k of ['w', 'h', 'fps', 'bg']) if (op[k] !== undefined) p.canvas[k] = op[k];
}

function opSetTimelineRange(p: Project, op: EditOp) {
  if ('rangeIn' in op) { if (op.rangeIn === null) delete p.rangeIn; else p.rangeIn = op.rangeIn; }
  if ('rangeOut' in op) { if (op.rangeOut === null) delete p.rangeOut; else p.rangeOut = op.rangeOut; }
  if (p.rangeIn !== undefined && p.rangeOut !== undefined && p.rangeOut <= p.rangeIn) {
    fail('timeline range is empty: rangeOut must be after rangeIn');
  }
}

function opRenameProject(p: Project, op: EditOp) {
  if (typeof op.name !== 'string' || !op.name.trim()) fail('rename_project needs a non-empty name');
  p.name = op.name;
}

function opAddMarker(p: Project, op: EditOp) {
  if (typeof op.t !== 'number') fail('add_marker needs a numeric t (seconds)');
  if (typeof op.label !== 'string') fail('add_marker needs a label string');
  const mk: Obj = { t: op.t, label: op.label };
  if (op.color !== undefined) mk.color = op.color;
  if (op.dur !== undefined) mk.dur = op.dur;
  p.markers = [...(p.markers ?? []), mk].sort((a: Obj, b: Obj) => a.t - b.t);
}

function opRemoveMarker(p: Project, op: EditOp) {
  const markers: Obj[] = p.markers ?? [];
  let idx = -1;
  if (typeof op.index === 'number') idx = op.index;
  else idx = markers.findIndex((m) => m.t === op.t && (op.label === undefined || m.label === op.label));
  if (idx < 0 || idx >= markers.length) fail('no marker matches that t/label (or index)');
  markers.splice(idx, 1);
  p.markers = markers;
}

// ---- media ops (group B — the ONLY ops allowed to change project.media) ----

export const MEDIA_OPS = new Set(['register_media', 'remove_media', 'move_media_to_bin', 'create_bin']);

function opRegisterMedia(p: Project, op: EditOp) {
  const m = op.media as Obj;
  if (!m || typeof m !== 'object') fail('register_media needs a media object {id?, src, kind, duration?, width?, height?, bin?}');
  if (typeof m.src !== 'string' || !m.src) fail('register_media: media.src must be a non-empty file name');
  if (!['video', 'audio', 'image', 'matte', 'depth'].includes(m.kind)) {
    fail(`register_media: media.kind '${String(m.kind)}' is not a media kind (video/audio/image/matte/depth)`);
  }
  const entry: Obj = { id: m.id ?? newId('med'), src: m.src, kind: m.kind };
  for (const k of ['bin', 'duration', 'width', 'height']) if (m[k] !== undefined) entry[k] = m[k];
  if ((p.media ?? []).some((x: Obj) => x.id === entry.id)) fail(`media id '${entry.id}' already exists in this project`);
  if (entry.bin && !(p.mediaBins ?? []).includes(entry.bin)) {
    p.mediaBins = [...(p.mediaBins ?? []), entry.bin];
  }
  p.media = [...(p.media ?? []), entry];
}

function opRemoveMedia(p: Project, op: EditOp) {
  const mediaId = op.media_id as string;
  findMedia(p, mediaId);
  const refs: string[] = [];
  walkClips(p, (c) => {
    if (c.media === mediaId) refs.push(c.id);
    if (c.matteId === mediaId) refs.push(`${c.id} (matte)`);
    if (c.audioOverride?.stemMedia === mediaId) refs.push(`${c.id} (voice stem)`);
    if (Array.isArray(c.angles) && c.angles.some((a: Obj) => a.media === mediaId)) refs.push(`${c.id} (angle)`);
  });
  if (refs.length) {
    fail(`media '${mediaId}' is still used by clip(s) ${refs.join(', ')} — remove or re-point those clips first`);
  }
  p.media = p.media.filter((x: Obj) => x.id !== mediaId);
}

function opCreateBin(p: Project, op: EditOp) {
  if (typeof op.name !== 'string' || !op.name.trim()) fail('create_bin needs a bin name');
  const bins: string[] = p.mediaBins ?? [];
  if (bins.includes(op.name)) fail(`bin '${op.name}' already exists`);
  p.mediaBins = [...bins, op.name];
}

function opMoveMediaToBin(p: Project, op: EditOp) {
  const m = findMedia(p, op.media_id as string);
  if (op.bin === null || op.bin === undefined) { delete m.bin; return; }
  if (typeof op.bin !== 'string' || !op.bin) fail('move_media_to_bin needs a bin name (or null for the root bin)');
  if (!(p.mediaBins ?? []).includes(op.bin)) p.mediaBins = [...(p.mediaBins ?? []), op.bin];
  m.bin = op.bin;
}

// ---- track ops ----

function opAddTrack(p: Project, op: EditOp) {
  if (!['video', 'audio', 'text'].includes(op.kind)) fail("add_track needs kind 'video', 'audio' or 'text'");
  const track: Obj = { id: op.track_id ?? newId('trk'), kind: op.kind, clips: [] };
  for (const k of ['muted', 'solo', 'locked', 'hidden', 'name', 'color', 'height', 'volume', 'bus']) {
    if (op[k] !== undefined) track[k] = op[k];
  }
  if ((p.tracks ?? []).some((t: Obj) => t.id === track.id)) fail(`track id '${track.id}' already exists`);
  p.tracks = [...(p.tracks ?? []), track];
}

function opRemoveTrack(p: Project, op: EditOp) {
  const track = findTrack(p, op.track_id as string);
  if ((track.clips ?? []).length > 0 && !op.force) {
    fail(`track '${track.id}' still has ${track.clips.length} clip(s) — remove them first or pass force: true`);
  }
  p.tracks = p.tracks.filter((t: Obj) => t.id !== track.id);
  if (!p.tracks.length) fail('a project needs at least one track — add another track before removing the last one');
}

function opSetTrackFlags(p: Project, op: EditOp) {
  const track = findTrack(p, op.track_id as string);
  patch(track, op, ['muted', 'solo', 'locked', 'hidden', 'name', 'color', 'height', 'volume', 'bus']);
}

// ---- clip ops ----

function buildMediaClip(track: Obj, op: EditOp): Obj {
  const media = findMedia(op.project, op.media_id as string);
  void media;
  const base: Obj = {
    id: op.clip_id ?? newId('clip'),
    start: op.start ?? 0,
    media: op.media_id,
    in: op.in ?? 0,
    out: op.out ?? 0,
    speed: op.speed ?? 1,
    transitionIn: null,
  };
  if (!(base.out > base.in)) fail('add_clip needs out > in (the source window, in seconds)');
  if (track.kind === 'video') {
    return { ...base, muted: op.muted ?? false, volume: op.volume ?? 1, transform: { ...DEFAULT_TRANSFORM } };
  }
  return { ...base, volume: op.volume ?? 1, fadeIn: op.fadeIn ?? 0, fadeOut: op.fadeOut ?? 0 };
}

function opAddClip(p: Project, op: EditOp) {
  const track = findTrack(p, op.track_id as string);
  if (track.kind === 'text') fail('add_clip cannot add to a text track — use add_text');
  let clip: Obj;
  if (op.clip && typeof op.clip === 'object') {
    clip = clone(op.clip);
    if (!clip.id) clip.id = op.clip_id ?? newId('clip');
    if (typeof clip.start !== 'number') fail('add_clip: clip.start must be a number (timeline seconds)');
  } else {
    clip = buildMediaClip(track, { ...op, project: p });
  }
  walkClips(p, (c) => { if (c.id === clip.id) fail(`clip id '${clip.id}' already exists in this project`); });
  track.clips = [...(track.clips ?? []), clip];
  sortClips(track);
}

function opRemoveClip(p: Project, op: EditOp) {
  const { track } = findClip(p, op.clip_id as string, op.track_id);
  track.clips = track.clips.filter((c: Obj) => c.id !== op.clip_id);
}

function opMoveClip(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  const dest = op.to_track_id ? findTrack(p, op.to_track_id as string) : track;
  if (op.start !== undefined) {
    if (typeof op.start !== 'number' || op.start < 0) fail('move_clip: start must be a number >= 0');
    clip.start = op.start;
  }
  if (dest !== track) {
    if (dest.kind !== track.kind && !(track.kind === 'video' && dest.kind === 'video')) {
      fail(`cannot move a ${track.kind}-track clip onto a ${dest.kind} track`);
    }
    track.clips = track.clips.filter((c: Obj) => c.id !== clip.id);
    dest.clips = [...(dest.clips ?? []), clip];
    sortClips(dest);
  }
  sortClips(track);
}

function opTrimClip(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if ('dur' in clip) {
    // text / adjustment clips are duration-based
    if (op.start !== undefined) clip.start = op.start;
    if (op.dur !== undefined) {
      if (!(op.dur > 0)) fail('trim_clip: dur must be > 0');
      clip.dur = op.dur;
    }
    if (op.in !== undefined || op.out !== undefined) fail('trim_clip: duration-based clips trim with start/dur, not in/out');
    return;
  }
  if (op.in !== undefined) clip.in = op.in;
  if (op.out !== undefined) clip.out = op.out;
  if (op.start !== undefined) clip.start = op.start;
  if (!(clip.out > clip.in)) fail(`trim_clip would leave clip '${clip.id}' with out <= in — refused`);
  if (clip.in < 0) fail('trim_clip: in must be >= 0');
}

/** The canonical split (actions.ts splitClipAt, frame-quantised). */
export function splitClipInPlace(p: Project, track: Obj, clip: Obj, atTime: number, rightId?: string): string {
  const fps = p.canvas?.fps ?? 30;
  const t = qFrame(atTime, fps);
  if (!(t > clip.start + 0.001 && t < clip.start + clipDuration(clip) - 0.001)) {
    fail(`split point ${atTime}s is not strictly inside clip '${clip.id}' (${clip.start}s–${clipEnd(clip)}s)`);
  }
  const idx = track.clips.findIndex((c: Obj) => c.id === clip.id);
  const right: Obj = clone(clip);
  right.id = rightId ?? newId('clip');
  const offset = t - clip.start;
  if ('dur' in clip && 'dur' in right) {
    right.dur = clipDuration(clip) - offset;
    clip.dur = offset;
  } else if ('nest' in clip && 'nest' in right) {
    const mid = clip.in + offset;
    right.in = mid;
    clip.out = mid;
    if (clip.keyframes) {
      right.keyframes = clip.keyframes.filter((k: Obj) => k.t >= offset).map((k: Obj) => ({ ...k, t: k.t - offset }));
      clip.keyframes = clip.keyframes.filter((k: Obj) => k.t < offset);
    }
  } else if ('in' in clip && 'in' in right) {
    const mid = clip.in + offset * clip.speed;
    right.in = mid;
    clip.out = mid;
    if (clip.keyframes) {
      right.keyframes = clip.keyframes.filter((k: Obj) => k.t >= offset).map((k: Obj) => ({ ...k, t: k.t - offset }));
      clip.keyframes = clip.keyframes.filter((k: Obj) => k.t < offset);
    }
  }
  right.start = t;
  if ('transitionIn' in right) right.transitionIn = null;
  track.clips.splice(idx + 1, 0, right);
  return right.id;
}

function opSplitClip(p: Project, op: EditOp) {
  if (typeof op.at !== 'number') fail('split_clip needs at (timeline seconds)');
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  splitClipInPlace(p, track, clip, op.at, op.new_clip_id);
}

function opDuplicateClip(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  const copy: Obj = clone(clip);
  copy.id = op.new_clip_id ?? newId('clip');
  copy.start = op.start ?? clipEnd(clip);
  const idx = track.clips.findIndex((c: Obj) => c.id === clip.id);
  track.clips.splice(idx + 1, 0, copy);
  sortClips(track);
}

function opSetClipTiming(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if ('dur' in clip && !('in' in clip)) fail('timing (speed/reverse/freeze) applies to media and compound clips, not duration-based clips');
  patch(clip, op, ['speed', 'speedKeys', 'reversed', 'freezeAt', 'pitchPreserve', 'smoothSlowmo']);
  if (clip.speed !== undefined && !(clip.speed > 0)) fail('set_clip_timing: speed must be > 0');
}

function opLinkClips(p: Project, op: EditOp) {
  const ids: string[] = op.clip_ids ?? [];
  if (!Array.isArray(ids) || ids.length < 2) fail('link_clips needs at least two clip_ids');
  const groupId = op.group_id ?? newId('grp');
  for (const id of ids) findClip(p, id).clip.groupId = groupId;
}

function opUnlinkClips(p: Project, op: EditOp) {
  if (op.group_id) {
    let n = 0;
    walkClips(p, (c) => { if (c.groupId === op.group_id) { delete c.groupId; n++; } });
    if (!n) fail(`no clips carry group '${op.group_id}'`);
    return;
  }
  const ids: string[] = op.clip_ids ?? [];
  if (!ids.length) fail('unlink_clips needs clip_ids (or a group_id)');
  for (const id of ids) delete findClip(p, id).clip.groupId;
}

function opMakeCompound(p: Project, op: EditOp) {
  const ids: string[] = op.clip_ids ?? [];
  if (!Array.isArray(ids) || ids.length < 2) {
    fail('make_compound needs at least two clip_ids — a compound of one clip is a no-op wrapper');
  }
  const found = ids.map((id) => ({ id, ...findClip(p, id) }));
  const videoFound = found.filter((x) => x.track.kind === 'video');
  if (!videoFound.length) fail('a compound clip lives on a video track — include at least one video-track clip');
  const host = op.host_track_id ? findTrack(p, op.host_track_id as string) : videoFound[0].track;
  if (host.kind !== 'video') fail('the compound host track must be a video track');
  const fps = p.canvas?.fps ?? 30;
  const start = qFrame(Math.min(...found.map((x) => x.clip.start)), fps);
  const end = Math.max(...found.map((x) => clipEnd(x.clip)));
  const nestTracks: Obj[] = [];
  for (const tr of p.tracks ?? []) {
    const sel = found.filter((x) => x.track.id === tr.id).map((x) => x.clip);
    if (!sel.length) continue;
    const nt: Obj = clone({ ...tr, clips: sel });
    for (const c of nt.clips) c.start = Math.max(0, qFrame(c.start - start, fps));
    nt.clips.sort((a: Obj, b: Obj) => a.start - b.start);
    nestTracks.push(nt);
  }
  const name = op.name ?? `Compound ${(p.tracks ?? []).reduce((n: number, tr: Obj) => n + (tr.clips ?? []).filter((c: Obj) => 'nest' in c).length, 0) + 1}`;
  const compound: Obj = {
    id: op.compound_id ?? newId('clip'),
    start,
    in: 0,
    out: Math.max(1 / fps, end - start),
    nest: { name, tracks: nestTracks },
    transform: { ...DEFAULT_TRANSFORM },
    volume: 1,
    transitionIn: null,
    transitionDur: 0.25,
  };
  const idSet = new Set(ids);
  for (const tr of p.tracks ?? []) tr.clips = (tr.clips ?? []).filter((c: Obj) => !idSet.has(c.id));
  host.clips = [...(host.clips ?? []), compound];
  sortClips(host);
}

function opUncompound(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!isCompoundClip(clip)) fail(`clip '${clip.id}' is not a compound — nothing to uncompound`);
  track.clips = track.clips.filter((c: Obj) => c.id !== clip.id);
  const existing = new Set<string>();
  walkClips(p, (c) => existing.add(c.id));
  for (const nt of clip.nest.tracks ?? []) {
    let target = (p.tracks ?? []).find((t: Obj) => t.id === nt.id);
    if (!target) {
      target = clone({ ...nt, clips: [] });
      p.tracks.push(target);
    }
    for (const nc0 of nt.clips ?? []) {
      const nc: Obj = clone(nc0);
      if (existing.has(nc.id)) nc.id = newId('clip');
      existing.add(nc.id);
      nc.start = Math.max(0, clip.start + (nc.start - clip.in));
      target.clips.push(nc);
    }
    sortClips(target);
  }
}

function opAddAdjustmentClip(p: Project, op: EditOp) {
  const track = findTrack(p, op.track_id as string);
  if (track.kind !== 'video') fail('adjustment clips live on a video track');
  if (!(op.dur > 0)) fail('add_adjustment_clip needs dur > 0');
  const clip: Obj = {
    id: op.clip_id ?? newId('clip'), adj: true,
    start: op.start ?? 0, dur: op.dur, transitionIn: null,
  };
  if (op.effects !== undefined) clip.effects = clone(op.effects);
  if (op.grade !== undefined) clip.grades = [clone(op.grade)];
  if (op.mask !== undefined) clip.mask = clone(op.mask);
  track.clips = [...(track.clips ?? []), clip];
  sortClips(track);
}

function opSetActiveAngle(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  const idx = op.angle_index as number;
  if (!Array.isArray(clip.angles) || !clip.angles[idx]) {
    fail(`clip '${clip.id}' has no angle at index ${String(idx)} (it is not a multicam clip, or the index is out of range)`);
  }
  const prev = clip.angles[clip.activeAngle ?? 0];
  const delta = (clip.angles[idx].syncOffset ?? 0) - (prev?.syncOffset ?? 0);
  const w = shiftedWindow(clip.in, clip.out, delta);
  clip.in = w.in;
  clip.out = w.out;
  clip.activeAngle = idx;
  clip.media = clip.angles[idx].media;
}

/** cut_to_angle = the model's multicam cut (actions.ts performAngleCut):
 *  split at the time, then the RIGHT part takes the new angle with its
 *  window shifted by the sync-offset delta. */
function opCutToAngle(p: Project, op: EditOp) {
  if (typeof op.at !== 'number') fail('cut_to_angle needs at (timeline seconds)');
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  const idx = op.angle_index as number;
  if (!Array.isArray(clip.angles) || !clip.angles[idx]) {
    fail(`clip '${clip.id}' has no angle at index ${String(idx)}`);
  }
  const fps = p.canvas?.fps ?? 30;
  const t = qFrame(op.at, fps);
  const rightId = splitClipInPlace(p, track, clip, t, op.new_clip_id);
  const right = track.clips.find((c: Obj) => c.id === rightId);
  const delta = (clip.angles[idx].syncOffset ?? 0) - (clip.angles[clip.activeAngle ?? 0].syncOffset ?? 0);
  const w = shiftedWindow(right.in, right.out, delta);
  right.in = w.in;
  right.out = w.out;
  right.activeAngle = idx;
  right.media = clip.angles[idx].media;
}

// ---- transform & animation ops ----

function opSetTransform(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (isTextClip(clip, findClip(p, op.clip_id as string, op.track_id).track) && !clip.transform) {
    fail('text clips position with x/y fractions — use set_text_style for those');
  }
  if (!clip.transform || typeof clip.transform !== 'object') fail(`clip '${clip.id}' has no transform to set`);
  const t = op.transform as Obj;
  if (!t || typeof t !== 'object') fail('set_transform needs a transform object {x?, y?, scale?, rotation?, opacity?}');
  for (const k of ['x', 'y', 'scale', 'rotation', 'opacity']) if (t[k] !== undefined) clip.transform[k] = t[k];
}

const KEYFRAME_PROPS = ['x', 'y', 'scale', 'rotation', 'opacity'] as const;

function opAddKeyframe(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!('transform' in clip) && !isAdjClip(clip)) fail(`clip '${clip.id}' does not carry keyframes`);
  let kf: Obj;
  if (op.keyframe && typeof op.keyframe === 'object') {
    kf = clone(op.keyframe);
  } else {
    if (typeof op.t !== 'number') fail('add_keyframe needs t (clip-local seconds)');
    if (!KEYFRAME_PROPS.includes(op.prop)) fail(`add_keyframe needs prop one of ${KEYFRAME_PROPS.join('/')}`);
    if (typeof op.value !== 'number') fail('add_keyframe needs a numeric value');
    kf = { t: op.t, [op.prop]: op.value };
    if (op.ease !== undefined) kf.ease = op.ease;
    if (op.ease_handles !== undefined) kf.easeHandles = clone(op.ease_handles);
    if (op.hold !== undefined) kf.hold = op.hold;
  }
  if (typeof kf.t !== 'number' || kf.t < 0) fail('keyframe t must be a number >= 0 (clip-local seconds)');
  const dur = clipDuration(clip);
  if (kf.t > dur + 1e-6) fail(`keyframe t ${kf.t}s is past the end of clip '${clip.id}' (${dur}s)`);
  const list: Obj[] = clip.keyframes ?? [];
  const existing = list.find((k) => Math.abs(k.t - kf.t) < 1e-6);
  if (existing) Object.assign(existing, kf);
  else list.push(kf);
  list.sort((a, b) => a.t - b.t);
  clip.keyframes = list;
}

function opRemoveKeyframe(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  const list: Obj[] = clip.keyframes ?? [];
  const idx = list.findIndex((k) => Math.abs(k.t - op.t) < 1e-6);
  if (idx < 0) fail(`clip '${clip.id}' has no keyframe at t=${String(op.t)}`);
  if (op.prop) {
    if (!KEYFRAME_PROPS.includes(op.prop)) fail(`remove_keyframe prop must be one of ${KEYFRAME_PROPS.join('/')}`);
    const kf = list[idx];
    delete kf[op.prop];
    const hasValue = KEYFRAME_PROPS.some((pr) => typeof kf[pr] === 'number') || kf.mask || kf.fx;
    if (!hasValue) list.splice(idx, 1);
  } else {
    list.splice(idx, 1);
  }
  if (list.length) clip.keyframes = list;
  else delete clip.keyframes;
}

/** list_keyframes read helper (also the tool's implementation core). */
export function listKeyframes(p: Project, clipId: string): Obj[] {
  const { clip } = findClip(p, clipId);
  return clone(clip.keyframes ?? []);
}

function opSetCrop(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if ('media' in clip === false && !isCompoundClip(clip)) fail(`clip '${clip.id}' has no crop`);
  clip.crop = op.crop === null ? null : clone(op.crop);
}

function opSetBlendMode(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  const modes = ['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'hard-light'];
  if (!modes.includes(op.blend)) fail(`blend must be one of ${modes.join('/')}`);
  clip.blend = op.blend;
}

function opSetFlip(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (op.flipH !== undefined) clip.flipH = !!op.flipH;
  if (op.flipV !== undefined) clip.flipV = !!op.flipV;
}

function opSetFit(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!['cover', 'blur-fill'].includes(op.fit)) fail("fit must be 'cover' or 'blur-fill'");
  if (!('media' in clip)) fail('fit applies to media clips');
  clip.fit = op.fit;
}

function opSetMask(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  clip.mask = op.mask === null ? null : clone(op.mask);
}

function opSetChromaKey(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!('media' in clip)) fail('chroma key applies to media clips');
  if (op.chroma_key === null) delete clip.chromaKey;
  else clip.chromaKey = clone(op.chroma_key);
}

function opSetMatte(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!('media' in clip)) fail('a matte applies to media clips');
  if (op.matte_id === null) { delete clip.matteId; return; }
  const m = findMedia(p, op.matte_id as string);
  if (m.kind !== 'matte' && m.kind !== 'video') fail(`matte media '${m.id}' should be a matte (or video) media item`);
  clip.matteId = m.id;
}

// ---- effects & transitions ----

function effectsOf(clip: Obj, track: Obj): Obj[] {
  if (isTextClip(clip, track)) fail('text clips carry string effects (e.g. "glow") — add_effect on a text clip only toggles glow via set_text_style/effects');
  if (track.kind === 'audio') fail('audio clips do not carry an effects stack');
  if (isAdjClip(clip) || 'media' in clip || isCompoundClip(clip)) {
    if (!Array.isArray(clip.effects)) clip.effects = [];
    return clip.effects;
  }
  fail(`clip '${clip.id}' does not carry an effects stack`);
}

function opAddEffect(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (isTextClip(clip, track)) {
    // Text effects are a string list; 'glow' is the one the model uses.
    const list: string[] = Array.isArray(clip.effects) ? clip.effects : [];
    const name = String(op.type);
    if (!list.includes(name)) list.push(name);
    clip.effects = list;
    return;
  }
  if (!EFFECT_TYPES.includes(op.type)) fail(`unknown effect type '${String(op.type)}' — one of ${EFFECT_TYPES.join(', ')}`);
  const fx = effectsOf(clip, track);
  if (fx.some((e) => e.type === op.type)) fail(`clip '${clip.id}' already has a '${op.type}' effect — update_effect changes it`);
  const entry: Obj = { type: op.type, value: op.value ?? EFFECT_DEFAULTS[op.type as string] };
  if (op.params !== undefined) entry.params = clone(op.params);
  if (op.lights !== undefined) entry.lights = clone(op.lights);
  if (op.enabled !== undefined) entry.enabled = !!op.enabled;
  fx.push(entry);
}

function findEffect(clip: Obj, op: EditOp): { fx: Obj[]; idx: number } {
  const fx: Obj[] = Array.isArray(clip.effects) ? clip.effects : [];
  let idx = -1;
  if (typeof op.index === 'number') idx = op.index;
  else if (op.type) idx = fx.findIndex((e) => typeof e === 'object' && e?.type === op.type);
  if (idx < 0 || idx >= fx.length) fail(`clip '${clip.id}' has no effect matching that type/index`);
  return { fx, idx };
}

function opUpdateEffect(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  const { fx, idx } = findEffect(clip, op);
  const entry = fx[idx];
  if (typeof entry !== 'object' || entry === null) fail('that effect entry is a text-style string effect and has no parameters to update');
  if (op.value !== undefined) entry.value = op.value;
  if (op.params !== undefined) entry.params = { ...(entry.params ?? {}), ...clone(op.params) };
  if (op.lights !== undefined) entry.lights = clone(op.lights);
  if (op.enabled !== undefined) entry.enabled = !!op.enabled;
}

function opRemoveEffect(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (isTextClip(clip, track)) {
    const list: string[] = Array.isArray(clip.effects) ? clip.effects : [];
    clip.effects = list.filter((e) => e !== op.type);
    return;
  }
  const { fx, idx } = findEffect(clip, op);
  fx.splice(idx, 1);
}

function opSetTransition(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  const transitions = ['cut', 'dissolve', 'flash', 'glare', 'slide', 'shake', 'blur-pulse', 'zoom', 'flip', 'invert-flash', 'mask-wipe', 'blur-cut'];
  if (op.transitionIn !== undefined && op.transitionIn !== null && !transitions.includes(op.transitionIn)) {
    fail(`transitionIn '${String(op.transitionIn)}' is not a known transition (${transitions.join(', ')})`);
  }
  if (op.transitionBlur !== undefined && op.transitionBlur !== null &&
      (typeof op.transitionBlur !== 'number' || op.transitionBlur < 0 || op.transitionBlur > 30)) {
    fail('transitionBlur must be a number within 0..30 (peak gblur sigma) or null to clear');
  }
  if (op.transitionMode !== undefined && op.transitionMode !== null &&
      !['soft', 'whip', 'zoom'].includes(op.transitionMode)) {
    fail(`transitionMode '${String(op.transitionMode)}' must be soft, whip or zoom (or null to clear)`);
  }
  patch(clip, op, ['transitionIn', 'transitionDir', 'transitionDur', 'transitionBlur', 'transitionMode', 'wipeCx', 'wipeCy', 'wipeShape']);
}

/** J.12: write a whole synthetic camera move as keyframes in one op — an
 * eased push/pull/glide over a clip-local window, optionally with an entry
 * blur that settles across the window (blur effect base carries the peak;
 * fx keyframes ride it peak -> 0). Mirrors editOps.add_camera_move. */
function opAddCameraMove(p: Project, op: EditOp) {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!('transform' in clip) && !isAdjClip(clip)) fail(`clip '${clip.id}' does not carry keyframes`);
  const KINDS = ['push-in', 'pull-out', 'glide-left', 'glide-right', 'glide-up', 'glide-down'];
  const kind = (op.kind ?? op.move) as string;
  if (!kind || !KINDS.includes(kind)) fail(`add_camera_move needs kind one of ${KINDS.join('/')}`);
  const dur = clipDuration(clip);
  const start = typeof op.start === 'number' ? op.start : 0;
  if (start < 0 || start >= dur) fail(`add_camera_move start ${start}s is outside clip '${clip.id}' (0..${dur.toFixed(3)}s)`);
  const span = typeof (op.dur ?? op.duration) === 'number' ? (op.dur ?? op.duration) as number : dur - start;
  if (span <= 0 || start + span > dur + 1e-6) fail(`add_camera_move window ${start}s + ${span}s exceeds clip '${clip.id}' (${dur.toFixed(3)}s)`);
  const ease = typeof op.ease === 'string' ? op.ease : 'easeInOut';
  const canvas = (p.canvas ?? {}) as Obj;
  const W = typeof canvas.w === 'number' ? canvas.w : 720;
  const H = typeof canvas.h === 'number' ? canvas.h : 1280;
  const num = (v: unknown, dflt: number) => (typeof v === 'number' ? v : dflt);
  let prop: 'scale' | 'x' | 'y', from: number, to: number;
  if (kind === 'push-in') { prop = 'scale'; from = num(op.from, 1); to = num(op.to, 1.15); }
  else if (kind === 'pull-out') { prop = 'scale'; from = num(op.from, 1.15); to = num(op.to, 1); }
  else if (kind === 'glide-left') { prop = 'x'; from = num(op.from, 0); to = num(op.to, -0.05 * W); }
  else if (kind === 'glide-right') { prop = 'x'; from = num(op.from, 0); to = num(op.to, 0.05 * W); }
  else if (kind === 'glide-up') { prop = 'y'; from = num(op.from, 0); to = num(op.to, -0.05 * H); }
  else { prop = 'y'; from = num(op.from, 0); to = num(op.to, 0.05 * H); }
  if (prop === 'scale' && (from <= 0 || to <= 0)) fail('add_camera_move scale from/to must be > 0');
  const list: Obj[] = clip.keyframes ?? [];
  const put = (t: number, patchFields: Obj) => {
    const existing = list.find((k) => Math.abs(k.t - t) < 1e-6);
    if (existing) Object.assign(existing, patchFields);
    else list.push({ t, ...patchFields });
  };
  put(start, { [prop]: from });
  put(start + span, { [prop]: to, ease });
  const entryBlur = op.entryBlur ?? op.entry_blur;
  if (entryBlur !== undefined) {
    if (typeof entryBlur !== 'number' || entryBlur < 0 || entryBlur > 1) fail('add_camera_move entryBlur must be within 0..1');
    if (entryBlur > 0) {
      const peakVal = (entryBlur * 12) / 10;
      const fx: Obj[] = clip.effects ?? [];
      let blurFx = fx.find((e) => typeof e === 'object' && e?.type === 'blur');
      if (!blurFx) { blurFx = { type: 'blur', value: peakVal }; fx.push(blurFx); }
      else blurFx.value = peakVal;
      clip.effects = fx;
      const ride = (t: number, v: number) => {
        const existing = list.find((k) => Math.abs(k.t - t) < 1e-6);
        const fxObj = { ...((existing?.fx as Obj) ?? {}), blur: v };
        if (existing) existing.fx = fxObj;
        else list.push({ t, fx: fxObj });
      };
      ride(start, peakVal);
      ride(start + span, 0);
    }
  }
  list.sort((a, b) => a.t - b.t);
  clip.keyframes = list;
}

// ---- colour ops ----

function gradeTarget(p: Project, op: EditOp): Obj {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if (isTextClip(clip, findClip(p, op.clip_id as string, op.track_id).track)) fail('text clips do not carry a grade');
  return clip;
}

function opSetGradeLayer(p: Project, op: EditOp) {
  const holder = gradeTarget(p, op);
  const layers = gradeLayersOf(holder).map((g) => clone(g));
  const idx = op.index ?? 0;
  if (idx < 0 || idx >= Math.max(1, layers.length)) fail(`grade layer index ${idx} is out of range (${layers.length} layer(s))`);
  const base = layers[idx] ?? clone(DEFAULT_GRADE);
  layers[idx] = mergeGrade(base, op.grade ?? {});
  writeGradeLayers(holder, layers);
}

function opAddGradeLayer(p: Project, op: EditOp) {
  const holder = gradeTarget(p, op);
  const layers = gradeLayersOf(holder).map((g) => clone(g));
  if (layers.length >= MAX_GRADE_LAYERS) {
    fail(`clip '${holder.id}' already has the maximum ${MAX_GRADE_LAYERS} grade layers — remove one first`);
  }
  layers.push(op.grade ? mergeGrade(clone(DEFAULT_GRADE), op.grade) : clone(DEFAULT_GRADE));
  writeGradeLayers(holder, layers);
}

function opRemoveGradeLayer(p: Project, op: EditOp) {
  const holder = gradeTarget(p, op);
  const layers = gradeLayersOf(holder).map((g) => clone(g));
  const idx = op.index ?? layers.length - 1;
  if (idx < 0 || idx >= layers.length) fail(`grade layer index ${idx} is out of range (${layers.length} layer(s))`);
  layers.splice(idx, 1);
  writeGradeLayers(holder, layers);
}

function opSetQualifierKey(p: Project, op: EditOp) {
  const holder = gradeTarget(p, op);
  const layers = gradeLayersOf(holder).map((g) => clone(g));
  const idx = op.index ?? 0;
  if (!layers.length) layers.push(clone(DEFAULT_GRADE));
  if (idx < 0 || idx >= layers.length) fail(`grade layer index ${idx} is out of range`);
  if (op.key === null) delete layers[idx].key;
  else layers[idx].key = clone(op.key);
  writeGradeLayers(holder, layers);
}

function opSetLut(p: Project, op: EditOp) {
  if (op.project === true) {
    const look = p.look ? clone(p.look) : clone(DEFAULT_GRADE);
    if (op.lut_id === null) { delete look.lutId; } else look.lutId = op.lut_id;
    if (op.lut_strength !== undefined) look.lutStrength = op.lut_strength;
    p.look = look;
    return;
  }
  const holder = gradeTarget(p, op);
  const layers = gradeLayersOf(holder).map((g) => clone(g));
  const idx = op.index ?? 0;
  if (!layers.length) layers.push(clone(DEFAULT_GRADE));
  if (idx < 0 || idx >= layers.length) fail(`grade layer index ${idx} is out of range`);
  if (op.lut_id === null) delete layers[idx].lutId;
  else if (typeof op.lut_id === 'string') layers[idx].lutId = op.lut_id;
  if (op.lut_strength !== undefined) layers[idx].lutStrength = op.lut_strength;
  writeGradeLayers(holder, layers);
}

function opSetProjectLook(p: Project, op: EditOp) {
  const base = p.look ? clone(p.look) : clone(DEFAULT_GRADE);
  p.look = op.look === null ? undefined : mergeGrade(base, op.look ?? {});
  if (p.look === undefined) delete p.look;
}

/** LUT ids referenced anywhere in the project (grades + look + nests). */
export function collectLuts(p: Project): { lutId: string; usedBy: number }[] {
  const counts = new Map<string, number>();
  const scan = (holder: Obj) => {
    for (const g of gradeLayersOf(holder)) {
      if (typeof g.lutId === 'string') counts.set(g.lutId, (counts.get(g.lutId) ?? 0) + 1);
    }
  };
  if (p.look) scan({ grades: [p.look] });
  walkClips(p, (c) => scan(c));
  return [...counts.entries()].map(([lutId, usedBy]) => ({ lutId, usedBy }));
}

// ---- text ops ----

function textTrackOf(p: Project, op: EditOp): Obj {
  if (op.track_id) {
    const t = findTrack(p, op.track_id as string);
    if (t.kind !== 'text') fail(`track '${t.id}' is a ${t.kind} track, not a text track`);
    return t;
  }
  const t = (p.tracks ?? []).find((x: Obj) => x.kind === 'text');
  if (!t) fail('this project has no text track — add_track with kind "text" first');
  return t;
}

function opAddText(p: Project, op: EditOp) {
  const track = textTrackOf(p, op);
  if (typeof op.text !== 'string') fail('add_text needs a text string');
  const style = op.style ?? 'pop-bold';
  const preset = TEXT_PRESETS[style] ?? TEXT_PRESETS['pop-bold'];
  const clip: Obj = {
    id: op.clip_id ?? newId('clip'),
    start: op.start ?? 0,
    text: op.text,
    dur: op.dur ?? 3,
    style,
    ...clone(preset),
    x: op.x ?? 0.5,
    y: op.y ?? 0.8,
    animIn: op.animIn ?? 'pop',
    animOut: op.animOut ?? 'fade',
    effects: op.effects !== undefined ? clone(op.effects) : [],
    transitionIn: null,
  };
  // Explicit style fields on the op win over the preset.
  patch(clip, op, ['fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth', 'shadow',
    'shadowObj', 'glowObj', 'plate', 'curve', 'align', 'charSpacing', 'lineSpacing', 'highlightColor', 'noFill', 'words']);
  walkClips(p, (c) => { if (c.id === clip.id) fail(`clip id '${clip.id}' already exists in this project`); });
  track.clips = [...(track.clips ?? []), clip];
  sortClips(track);
}

function opUpdateText(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!isTextClip(clip, track)) fail(`clip '${clip.id}' is not a text clip`);
  if (op.text !== undefined) {
    if (typeof op.text !== 'string') fail('update_text: text must be a string');
    clip.text = op.text;
  }
  patch(clip, op, ['dur', 'start', 'x', 'y', 'words']);
  if (op.dur !== undefined && !(clip.dur > 0)) fail('update_text: dur must be > 0');
}

function opSetTextStyle(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!isTextClip(clip, track)) fail(`clip '${clip.id}' is not a text clip`);
  patch(clip, op.fields ?? op, ['fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth',
    'shadow', 'shadowObj', 'glowObj', 'plate', 'curve', 'align', 'charSpacing', 'lineSpacing', 'highlightColor', 'noFill']);
  if (typeof op.style === 'string') clip.style = op.style;
}

function opApplyTextPreset(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!isTextClip(clip, track)) fail(`clip '${clip.id}' is not a text clip`);
  if (op.fields && typeof op.fields === 'object') {
    // A portable preset payload (e.g. from save_text_preset).
    for (const k of TEXT_PRESET_FIELDS) {
      if (op.fields[k] !== undefined) clip[k] = clone(op.fields[k]);
    }
    if (Array.isArray(op.fields.effects)) clip.effects = clone(op.fields.effects);
    return;
  }
  const name = op.preset as string;
  const preset = TEXT_PRESETS[name];
  if (!preset) fail(`unknown built-in text preset '${String(name)}' — one of ${Object.keys(TEXT_PRESETS).join(', ')}, or pass fields from save_text_preset`);
  clip.style = name;
  Object.assign(clip, clone(preset));
}

function opSetTextAnimation(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (!isTextClip(clip, track)) fail(`clip '${clip.id}' is not a text clip`);
  patch(clip, op, ['animIn', 'animOut', 'animInDur', 'animOutDur', 'animLoop']);
}

/** Capture a text clip's preset fields (textPresets.ts CAPTURED list). */
export function captureTextPreset(p: Project, clipId: string): Obj {
  const { track, clip } = findClip(p, clipId);
  if (!isTextClip(clip, track)) fail(`clip '${clipId}' is not a text clip`);
  const fields: Obj = {};
  for (const k of TEXT_PRESET_FIELDS) if (clip[k] !== undefined) fields[k] = clone(clip[k]);
  if ((clip.effects ?? []).includes('glow')) fields.effects = ['glow'];
  return fields;
}

// ---- audio ops ----

function audioClipOf(p: Project, op: EditOp): Obj {
  const { clip } = findClip(p, op.clip_id as string, op.track_id);
  if ('dur' in clip && !('in' in clip) && !isAdjClip(clip)) fail(`clip '${clip.id}' is duration-based and has no audio controls`);
  if (isAdjClip(clip)) fail('adjustment clips have no audio controls');
  return clip;
}

function opSetClipVolume(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  if (typeof op.volume !== 'number' || op.volume < 0) fail('set_clip_volume needs volume >= 0');
  clip.volume = op.volume;
}

function opSetVolumeKeyframes(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  if (op.volume_keys === null) { delete clip.volumeKeys; return; }
  if (!Array.isArray(op.volume_keys)) fail('set_volume_keyframes needs volume_keys: [{t, v}] (or null to clear)');
  clip.volumeKeys = clone(op.volume_keys).sort((a: Obj, b: Obj) => a.t - b.t);
}

function opSetFades(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  patch(clip, op, ['fadeIn', 'fadeOut']);
}

function opSetPan(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  if (typeof op.pan !== 'number' || op.pan < -1 || op.pan > 1) fail('set_pan needs pan between -1 and 1');
  clip.pan = op.pan;
}

function opSetEq(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  if (Array.isArray(op.bands)) {
    if (op.bands.length !== 6) fail('set_eq bands must be the full 6-band set [{freq, gain, q} × 6]');
    clip.eqBands = clone(op.bands);
    delete clip.eqLow; delete clip.eqMid; delete clip.eqHigh;
    return;
  }
  if (op.low !== undefined || op.mid !== undefined || op.high !== undefined) {
    // Legacy 3-band form: mapped onto the 6-band model exactly as
    // eq.ts bandsOf does (bands 1/3/5), so preview and render agree.
    const bands = bandsOf(clip);
    if (op.low !== undefined) bands[0] = { freq: 200, gain: op.low, q: 0.7 };
    if (op.mid !== undefined) bands[2] = { freq: 1000, gain: op.mid, q: 0.9 };
    if (op.high !== undefined) bands[4] = { freq: 4000, gain: op.high, q: 0.7 };
    clip.eqBands = bands;
    delete clip.eqLow; delete clip.eqMid; delete clip.eqHigh;
    return;
  }
  fail('set_eq needs either bands (6 × {freq, gain, q}) or low/mid/high gains in dB');
}

function opSetDenoise(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  clip.denoise = !!op.denoise;
}

function opSetVoiceFx(p: Project, op: EditOp) {
  const { track, clip } = findClip(p, op.clip_id as string, op.track_id);
  if (track.kind !== 'audio') fail('voiceFx (echo/hall) lives on audio clips');
  if (!['none', 'echo', 'hall'].includes(op.voice_fx)) fail("voice_fx must be 'none', 'echo' or 'hall'");
  clip.voiceFx = op.voice_fx;
}

function opSetAudioOverride(p: Project, op: EditOp) {
  const clip = audioClipOf(p, op);
  const cur: Obj = clip.audioOverride ?? {};
  if (op.stem_media !== undefined) cur.stemMedia = op.stem_media;
  if (op.strength !== undefined) cur.strength = op.strength;
  if (op.enabled !== undefined) cur.enabled = !!op.enabled;
  if (!cur.stemMedia) fail('this clip has no voice-isolation stem yet — queue separate_voice first, then set the strength once its stem is registered');
  if (cur.strength === undefined) cur.strength = 1;
  if (cur.enabled === undefined) cur.enabled = true;
  clip.audioOverride = cur;
}

function opSetAudioBus(p: Project, op: EditOp) {
  const bus = op.audio_bus as Obj;
  if (!bus || typeof bus !== 'object') fail('set_audio_bus needs an audio_bus object (partial merge)');
  const cur: Obj = p.audioBus ?? { masterGain: 1, normalise: true, compEnabled: false };
  p.audioBus = mergeGrade(cur, bus);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const OPS: Record<string, (p: Project, op: EditOp) => void> = {
  set_canvas: opSetCanvas,
  set_timeline_range: opSetTimelineRange,
  rename_project: opRenameProject,
  add_marker: opAddMarker,
  remove_marker: opRemoveMarker,
  register_media: opRegisterMedia,
  remove_media: opRemoveMedia,
  create_bin: opCreateBin,
  move_media_to_bin: opMoveMediaToBin,
  add_track: opAddTrack,
  remove_track: opRemoveTrack,
  set_track_flags: opSetTrackFlags,
  add_clip: opAddClip,
  remove_clip: opRemoveClip,
  remove_text: opRemoveClip,
  move_clip: opMoveClip,
  trim_clip: opTrimClip,
  split_clip: opSplitClip,
  duplicate_clip: opDuplicateClip,
  set_clip_timing: opSetClipTiming,
  link_clips: opLinkClips,
  unlink_clips: opUnlinkClips,
  make_compound: opMakeCompound,
  uncompound: opUncompound,
  add_adjustment_clip: opAddAdjustmentClip,
  set_active_angle: opSetActiveAngle,
  cut_to_angle: opCutToAngle,
  set_transform: opSetTransform,
  add_keyframe: opAddKeyframe,
  remove_keyframe: opRemoveKeyframe,
  add_camera_move: opAddCameraMove,
  set_crop: opSetCrop,
  set_blend_mode: opSetBlendMode,
  set_flip: opSetFlip,
  set_fit: opSetFit,
  set_mask: opSetMask,
  set_chroma_key: opSetChromaKey,
  set_matte: opSetMatte,
  add_effect: opAddEffect,
  update_effect: opUpdateEffect,
  remove_effect: opRemoveEffect,
  set_transition: opSetTransition,
  set_grade_layer: opSetGradeLayer,
  add_grade_layer: opAddGradeLayer,
  remove_grade_layer: opRemoveGradeLayer,
  set_qualifier_key: opSetQualifierKey,
  set_lut: opSetLut,
  set_project_look: opSetProjectLook,
  add_text: opAddText,
  update_text: opUpdateText,
  set_text_style: opSetTextStyle,
  apply_text_preset: opApplyTextPreset,
  set_text_animation: opSetTextAnimation,
  set_clip_volume: opSetClipVolume,
  set_volume_keyframes: opSetVolumeKeyframes,
  set_fades: opSetFades,
  set_pan: opSetPan,
  set_eq: opSetEq,
  set_denoise: opSetDenoise,
  set_voice_fx: opSetVoiceFx,
  set_audio_override: opSetAudioOverride,
  set_audio_bus: opSetAudioBus,
};

export const OP_NAMES = Object.keys(OPS);

export function isKnownOp(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(OPS, name);
}

/** Apply ONE op to a deep clone of the project; the input is never
 *  mutated. Throws an Error with a friendly message on any refusal. */
export function applyEditOp(project: Project, op: EditOp): Project {
  const draft = clone(project);
  applyToDraft(draft, op);
  return draft;
}

/** Apply an ordered batch atomically: any failing op throws and the
 *  caller's original project is untouched (work happens on a clone). */
export function applyEditOps(project: Project, ops: EditOp[]): Project {
  if (!Array.isArray(ops) || !ops.length) fail('apply_edit_operations needs a non-empty ops array');
  const draft = clone(project);
  ops.forEach((op, i) => {
    try {
      applyToDraft(draft, op);
    } catch (e) {
      throw new Error(`op ${i + 1} (${op?.op ?? '?'}): ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return draft;
}

function applyToDraft(draft: Project, op: EditOp) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
    fail('each op must be an object with an "op" name');
  }
  const fn = OPS[op.op];
  if (!fn) fail(`unknown op '${op.op}' — see the tool list for the vocabulary`);
  fn(draft, op);
}

/** Cheap planning read: counts + duration without the full document. */
export function projectSummary(p: Project): Obj {
  let clips = 0;
  const mediaByKind: Record<string, number> = {};
  for (const m of p.media ?? []) mediaByKind[m.kind] = (mediaByKind[m.kind] ?? 0) + 1;
  const tracks = (p.tracks ?? []).map((t: Obj) => {
    clips += (t.clips ?? []).length;
    return { id: t.id, kind: t.kind, name: t.name ?? null, clips: (t.clips ?? []).length };
  });
  return {
    name: p.name,
    canvas: p.canvas,
    duration: Math.round(projectDuration(p) * 1000) / 1000,
    rangeIn: p.rangeIn ?? null,
    rangeOut: p.rangeOut ?? null,
    tracks,
    trackCount: tracks.length,
    clipCount: clips,
    mediaCount: (p.media ?? []).length,
    mediaByKind,
    mediaBins: p.mediaBins ?? [],
    markerCount: (p.markers ?? []).length,
    editLogEntries: Array.isArray(p.editLog) ? p.editLog.length : 0,
  };
}
