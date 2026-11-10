/**
 * editOps.ts — the pure project-JSON edit-op engine (Phase 2, live-control
 * parity; UPGRADE-PLAN §3 vocabulary, §4 Phase 2).
 *
 * One op vocabulary, shared by every agent surface: the names and arg
 * conventions here are IDENTICAL to the Phase 1 MCP vocabulary
 * (snake_case op names: add_clip, trim_clip, split_clip, set_grade_layer,
 * …). This module is the CLIENT-side implementation of that vocabulary:
 * it mutates a plain Project JSON document and nothing else — no store,
 * no DOM, no network — so it can run inside the live-control executor
 * (services/control.ts `applyOps`), in a harness under Node, or anywhere
 * a project document needs editing without the editor.
 *
 * Op shape: `{ op: 'trim_clip', clipId: '…', in: 1, out: 4 }` — args ride
 * flat on the op object, or nested under `args:`; both are accepted and
 * merged (nested wins). Arg keys accept the camelCase spelling the
 * project JSON / live channel use (clipId, trackId) AND the snake_case
 * spelling (clip_id, track_id) — they name the same argument.
 *
 * Laws:
 *  - Purity / atomicity: applyEditOp deep-clones before mutating;
 *    applyEditOps folds ops over one clone and throws on the first
 *    failure, so a failed batch leaves the caller's project untouched
 *    (the partially-built clone is simply discarded).
 *  - Media-registry law (same law as the server / prompt-edit side):
 *    an edit op may REFERENCE media already in project.media but may
 *    never add, remove or rename registry entries. Ops whose whole job
 *    is registry mutation are refused by name, and the registry
 *    signature is re-checked after every op as a backstop.
 *  - Errors are friendly thrown Errors — in the control channel they
 *    land verbatim in the command row's `error` field.
 *
 * Coverage (UPGRADE-PLAN §3 groups): A (project: set_canvas,
 * set_timeline_range, add_marker, remove_marker), C (all timeline/clip
 * ops), D (all transform/animation ops), E (effects + transitions),
 * F (grade stack / qualifier / LUT / project look — NOT grab_still,
 * upload_lut, list_luts, which are job/registry surfaces, not document
 * edits), G (all text ops), H (all audio ops EXCEPT separate_voice,
 * which queues a demucs job and so is not a pure document edit).
 * Read-only vocabulary entries (list_markers, list_keyframes) are
 * accepted and validated as no-ops here — the data they return travels
 * on the control channel's own read commands instead.
 */
import {
  clipDuration,
  DEFAULT_TRANSFORM,
  newId,
  TEXT_PRESETS,
  type AdjustmentClip,
  type AudioClip,
  type Clip,
  type CompoundClip,
  type EffectType,
  type Grade,
  type Keyframe,
  type Project,
  type TextClip,
  type Track,
  type TransitionType,
  type VideoClip,
} from '../types';
import { DEFAULT_GRADE, gradeLayersOf, MAX_GRADE_LAYERS } from './grade';
import { defaultEqBands, EQ_BAND_COUNT } from './eq';

// ---------------------------------------------------------------------------
// Op vocabulary
// ---------------------------------------------------------------------------

export const EDIT_OPS = [
  // A — project
  'set_canvas', 'set_timeline_range', 'add_marker', 'remove_marker', 'list_markers',
  // C — timeline & clips
  'add_track', 'remove_track', 'set_track_flags',
  'add_clip', 'remove_clip', 'move_clip', 'trim_clip', 'split_clip',
  'duplicate_clip', 'set_clip_timing', 'link_clips', 'unlink_clips',
  'make_compound', 'uncompound', 'add_adjustment_clip',
  'set_active_angle', 'cut_to_angle',
  // D — transform & animation
  'set_transform', 'add_keyframe', 'remove_keyframe', 'list_keyframes', 'add_camera_move',
  'set_crop', 'set_blend_mode', 'set_flip', 'set_fit', 'set_mask',
  'set_chroma_key', 'set_matte',
  // E — effects & transitions
  'add_effect', 'update_effect', 'remove_effect', 'set_transition',
  // F — colour
  'set_grade_layer', 'add_grade_layer', 'remove_grade_layer',
  'set_qualifier_key', 'set_lut', 'set_project_look',
  // G — text & captions
  'add_text', 'update_text', 'remove_text', 'set_text_style',
  'apply_text_preset', 'set_text_animation',
  // H — audio (separate_voice excluded: it queues a job, not a document edit)
  'set_clip_volume', 'set_volume_keyframes', 'set_fades', 'set_pan',
  'set_eq', 'set_denoise', 'set_voice_fx', 'set_audio_bus',
] as const;

export type EditOpName = (typeof EDIT_OPS)[number];

/** Ops refused outright: their job is mutating the media registry, which
 *  the media-registry law reserves for the media tools / the UI bin. */
const MEDIA_REGISTRY_OPS = new Set([
  'add_media', 'remove_media', 'register_media', 'request_media_upload',
  'move_media_to_bin', 'create_bin', 'upload_lut', 'update_project',
  'create_project', 'delete_project', 'duplicate_project', 'rename_project',
]);

/** Job-queueing ops from the vocabulary: real operations, but not pure
 *  document edits — they belong to the job surfaces, not this engine. */
const JOB_OPS = new Set(['separate_voice', 'grab_still', 'transcribe', 'detect_beats', 'track_region', 'compute_reframe']);

export interface EditOp {
  op: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Small helpers — validation errors are friendly and specific.
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

function fail(msg: string): never {
  throw new Error(msg);
}

function isObj(v: unknown): v is Args {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Read an arg under either its camelCase or snake_case spelling. */
function pick(args: Args, ...keys: string[]): unknown {
  for (const k of keys) if (args[k] !== undefined) return args[k];
  return undefined;
}

function reqStr(args: Args, op: string, ...keys: string[]): string {
  const v = pick(args, ...keys);
  if (typeof v !== 'string' || !v) fail(`Op '${op}' needs a non-empty string arg '${keys[0]}'.`);
  return v as string;
}

function optStr(args: Args, ...keys: string[]): string | undefined {
  const v = pick(args, ...keys);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') fail(`Arg '${keys[0]}' must be a string.`);
  return v;
}

function reqNum(args: Args, op: string, ...keys: string[]): number {
  const v = pick(args, ...keys);
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`Op '${op}' needs a numeric arg '${keys[0]}'.`);
  return v as number;
}

function optNum(args: Args, ...keys: string[]): number | undefined {
  const v = pick(args, ...keys);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`Arg '${keys[0]}' must be a number.`);
  return v;
}

function optBool(args: Args, ...keys: string[]): boolean | undefined {
  const v = pick(args, ...keys);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') fail(`Arg '${keys[0]}' must be a boolean.`);
  return v;
}

function optObj(args: Args, ...keys: string[]): Args | undefined {
  const v = pick(args, ...keys);
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) fail(`Arg '${keys[0]}' must be an object.`);
  return v;
}

/** Copy the defined fields of `src` onto `target` (deep-cloned values). */
function assignDefined(target: Args, src: Args, fields: string[]): void {
  for (const f of fields) {
    if (src[f] !== undefined) target[f] = clone(src[f]);
  }
}

function findTrack(p: Project, trackId: string): Track {
  const tr = p.tracks.find((t) => t.id === trackId);
  if (!tr) fail(`No track with id '${trackId}' in this project.`);
  return tr!;
}

function findClip(p: Project, clipId: string): { track: Track; clip: Clip; index: number } {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return fail(`No clip with id '${clipId}' in this project.`);
}

function clipByArg(p: Project, args: Args, op: string): { track: Track; clip: Clip; index: number } {
  return findClip(p, reqStr(args, op, 'clipId', 'clip_id'));
}

function isTextClip(c: Clip): c is TextClip {
  return 'text' in c;
}
function requireTextClip(c: Clip, op: string): TextClip {
  if (!isTextClip(c)) fail(`Op '${op}' applies to text clips only — clip '${c.id}' is not a text clip.`);
  return c as TextClip;
}
function requireMediaClip(c: Clip, op: string): VideoClip | AudioClip {
  if (!('media' in c) || !('in' in c)) {
    fail(`Op '${op}' applies to video/audio media clips only — clip '${c.id}' is not one.`);
  }
  return c as VideoClip | AudioClip;
}
function requireTransformClip(c: Clip, op: string): VideoClip | CompoundClip {
  if (!('transform' in c)) fail(`Op '${op}' needs a clip with a transform — clip '${c.id}' has none (text/audio/adjustment?).`);
  return c as VideoClip | CompoundClip;
}

function mediaSignature(p: Project): string {
  return p.media.map((m) => `${m.id}:${m.src}:${m.kind}`).sort().join('|');
}

const TRANSITIONS = new Set<string>([
  'cut', 'dissolve', 'flash', 'glare', 'slide', 'shake', 'blur-pulse',
  'zoom', 'flip', 'invert-flash', 'mask-wipe', 'blur-cut',
]);
const BLUR_CUT_MODES = new Set<string>(['soft', 'whip', 'zoom']);
const EFFECT_TYPES = new Set<string>([
  'brightness', 'contrast', 'saturation', 'blur', 'glow', 'sharpen',
  'vignette', 'tv-lines', 'haze', 'wide-angle', 'motion-blur', 'relight',
  'turbulent-displace',
]);
const BLEND_MODES = new Set<string>(['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'hard-light']);
const ANIM_TYPES = new Set<string>(['none', 'pop', 'fade', 'slide', 'typewriter', 'word-reveal']);
const ANIM_LOOPS = new Set<string>(['none', 'wave', 'pulse', 'sway']);
const EASE_KINDS = new Set<string>(['linear', 'easeIn', 'easeOut', 'easeInOut', 'cubicOut', 'reboundOut', 'backIn', 'bezier']);

/** The window shift when a multicam clip's sync offset changes — mirrors
 *  state/actions.ts shiftedWindow (kept local so this engine stays pure). */
function shiftedWindow(winIn: number, winOut: number, delta: number): { in: number; out: number } {
  if (!delta) return { in: winIn, out: winOut };
  const ni = winIn + delta;
  if (ni < 0) return { in: 0, out: Math.max(0.05, winOut + delta) };
  return { in: ni, out: winOut + delta };
}

/** Split a clip inside a draft project (mirrors the canonical split in
 *  state/actions.ts splitClipAt, minus the store). Returns the right id. */
function splitInDraft(p: Project, clipId: string, at: number, op: string): string {
  const { track, clip, index } = findClip(p, clipId);
  if (!(at > clip.start + 0.001 && at < clip.start + clipDuration(clip) - 0.001)) {
    fail(`Op '${op}': split point ${at}s is not inside clip '${clipId}' (it spans ${clip.start}s–${clip.start + clipDuration(clip)}s).`);
  }
  const right = clone(clip);
  right.id = newId('clip');
  const offset = at - clip.start;
  if ('dur' in clip && 'dur' in right) {
    (right as TextClip).dur = clipDuration(clip) - offset;
    (clip as TextClip).dur = offset;
  } else if ('nest' in clip && 'nest' in right) {
    const mid = (clip as CompoundClip).in + offset;
    (right as CompoundClip).in = mid;
    (clip as CompoundClip).out = mid;
    const kc = clip as CompoundClip;
    if (kc.keyframes) {
      const rk = right as CompoundClip;
      rk.keyframes = kc.keyframes.filter((k) => k.t >= offset).map((k) => ({ ...k, t: k.t - offset }));
      kc.keyframes = kc.keyframes.filter((k) => k.t < offset);
    }
  } else if ('in' in clip && 'in' in right) {
    const vc = clip as VideoClip;
    const mid = vc.in + offset * (vc.speed || 1);
    (right as VideoClip).in = mid;
    vc.out = mid;
    if (vc.keyframes) {
      const rk = right as VideoClip;
      rk.keyframes = vc.keyframes.filter((k) => k.t >= offset).map((k) => ({ ...k, t: k.t - offset }));
      vc.keyframes = vc.keyframes.filter((k) => k.t < offset);
    }
  }
  right.start = at;
  right.transitionIn = null;
  track.clips.splice(index + 1, 0, right);
  return right.id;
}

/** Materialise a clip's grade stack (legacy `grade` → one-element stack)
 *  and return the live layers array, stored back on `grades`. */
function gradeStackFor(clip: { grade?: Grade; grades?: Grade[] }): Grade[] {
  const layers = clone(gradeLayersOf(clip));
  clip.grades = layers;
  delete clip.grade;
  return layers;
}

function gradePatchFrom(args: Args): Partial<Grade> {
  const nested = optObj(args, 'grade', 'patch', 'fields');
  const src: Args = nested ?? args;
  const out: Args = {};
  assignDefined(out, src, [
    'temperature', 'tint', 'exposure', 'highlights', 'shadows', 'contrast',
    'pivot', 'lift', 'gamma', 'gain', 'offset', 'curves', 'hueCurves',
    'hsl', 'lutId', 'lutStrength', 'enabled', 'key',
  ]);
  return out as Partial<Grade>;
}

function layerIndex(args: Args, layers: Grade[], op: string): number {
  const idx = optNum(args, 'layer', 'index') ?? 0;
  if (!Number.isInteger(idx) || idx < 0 || idx >= Math.max(1, layers.length)) {
    fail(`Op '${op}': grade layer index ${idx} is out of range (stack has ${layers.length} layer(s)).`);
  }
  return idx;
}

/** Ensure the holder has at least one grade layer; returns the stack. */
function ensureGradeStack(clip: { grade?: Grade; grades?: Grade[] }): Grade[] {
  const layers = gradeStackFor(clip);
  if (layers.length === 0) layers.push(clone(DEFAULT_GRADE));
  return layers;
}

const DEFAULT_AUDIO_BUS = {
  masterGain: 1, normalise: true, compEnabled: false,
  compThreshold: -18, compRatio: 3, compMakeup: 4,
};

// ---------------------------------------------------------------------------
// The op implementations — each mutates the (already cloned) draft.
// ---------------------------------------------------------------------------

function applyOp(draft: Project, name: string, args: Args): void {
  switch (name) {
    // ---- A: project ------------------------------------------------------
    case 'set_canvas': {
      const w = optNum(args, 'w', 'width');
      const h = optNum(args, 'h', 'height');
      const fps = optNum(args, 'fps');
      const bg = optStr(args, 'bg');
      const nested = optObj(args, 'canvas');
      const cw = w ?? (nested ? optNum(nested, 'w', 'width') : undefined);
      const ch = h ?? (nested ? optNum(nested, 'h', 'height') : undefined);
      const cf = fps ?? (nested ? optNum(nested, 'fps') : undefined);
      const cb = bg ?? (nested ? optStr(nested, 'bg') : undefined);
      if (cw !== undefined) { if (cw <= 0) fail(`Op 'set_canvas': canvas w must be > 0.`); draft.canvas.w = cw; }
      if (ch !== undefined) { if (ch <= 0) fail(`Op 'set_canvas': canvas h must be > 0.`); draft.canvas.h = ch; }
      if (cf !== undefined) { if (cf <= 0) fail(`Op 'set_canvas': canvas fps must be > 0.`); draft.canvas.fps = cf; }
      if (cb !== undefined) draft.canvas.bg = cb;
      if (cw === undefined && ch === undefined && cf === undefined && cb === undefined) {
        fail(`Op 'set_canvas' needs at least one of w, h, fps, bg.`);
      }
      return;
    }

    case 'set_timeline_range': {
      if (optBool(args, 'clear')) { delete draft.rangeIn; delete draft.rangeOut; return; }
      const rin = optNum(args, 'rangeIn', 'range_in', 'in');
      const rout = optNum(args, 'rangeOut', 'range_out', 'out');
      if (rin === undefined && rout === undefined) {
        fail(`Op 'set_timeline_range' needs rangeIn / rangeOut (or clear: true).`);
      }
      if (rin !== undefined) { if (rin < 0) fail(`Op 'set_timeline_range': rangeIn must be >= 0.`); draft.rangeIn = rin; }
      if (rout !== undefined) { if (rout < 0) fail(`Op 'set_timeline_range': rangeOut must be >= 0.`); draft.rangeOut = rout; }
      if (draft.rangeIn !== undefined && draft.rangeOut !== undefined && draft.rangeOut <= draft.rangeIn) {
        fail(`Op 'set_timeline_range': rangeOut (${draft.rangeOut}) must be after rangeIn (${draft.rangeIn}).`);
      }
      return;
    }

    case 'add_marker': {
      const t = reqNum(args, name, 't', 'time');
      if (t < 0) fail(`Op 'add_marker': marker t must be >= 0.`);
      const marker: Project['markers'][number] = { t, label: optStr(args, 'label') ?? '' };
      const color = optStr(args, 'color');
      if (color !== undefined) marker.color = color;
      const dur = optNum(args, 'dur', 'duration');
      if (dur !== undefined) { if (dur <= 0) fail(`Op 'add_marker': dur must be > 0.`); marker.dur = dur; }
      draft.markers.push(marker);
      draft.markers.sort((a, b) => a.t - b.t);
      return;
    }

    case 'remove_marker': {
      const index = optNum(args, 'index');
      const t = optNum(args, 't', 'time');
      const label = optStr(args, 'label');
      if (index !== undefined) {
        if (!Number.isInteger(index) || index < 0 || index >= draft.markers.length) {
          fail(`Op 'remove_marker': marker index ${index} is out of range (${draft.markers.length} marker(s)).`);
        }
        draft.markers.splice(index, 1);
        return;
      }
      if (t === undefined && label === undefined) {
        fail(`Op 'remove_marker' needs an index, a t, or a label to identify the marker.`);
      }
      const before = draft.markers.length;
      draft.markers = draft.markers.filter((m) => {
        if (t !== undefined && Math.abs(m.t - t) > 1e-6) return true;
        if (label !== undefined && m.label !== label) return true;
        return false;
      });
      if (draft.markers.length === before) {
        fail(`Op 'remove_marker': no marker matches ${t !== undefined ? `t=${t}` : ''}${label !== undefined ? ` label='${label}'` : ''}.`);
      }
      return;
    }

    case 'list_markers':
      return; // read-only vocabulary entry — validated no-op (see header)

    // ---- C: timeline & clips ---------------------------------------------
    case 'add_track': {
      const kind = reqStr(args, name, 'kind');
      if (kind !== 'video' && kind !== 'audio' && kind !== 'text') {
        fail(`Op 'add_track': kind must be video, audio or text (got '${kind}').`);
      }
      const wantedId = optStr(args, 'trackId', 'track_id', 'id');
      if (wantedId && draft.tracks.some((t) => t.id === wantedId)) {
        fail(`Op 'add_track': a track with id '${wantedId}' already exists.`);
      }
      const track: Track = { id: wantedId ?? newId('trk'), kind, clips: [] };
      assignDefined(track as unknown as Args, args, ['name', 'color', 'height', 'muted', 'solo', 'locked', 'hidden', 'volume', 'bus']);
      const index = optNum(args, 'index');
      if (index !== undefined) {
        if (!Number.isInteger(index) || index < 0 || index > draft.tracks.length) {
          fail(`Op 'add_track': index ${index} is out of range.`);
        }
        draft.tracks.splice(index, 0, track);
      } else {
        draft.tracks.push(track);
      }
      return;
    }

    case 'remove_track': {
      const trackId = reqStr(args, name, 'trackId', 'track_id');
      const idx = draft.tracks.findIndex((t) => t.id === trackId);
      if (idx < 0) fail(`No track with id '${trackId}' in this project.`);
      draft.tracks.splice(idx, 1);
      return;
    }

    case 'set_track_flags': {
      const track = findTrack(draft, reqStr(args, name, 'trackId', 'track_id'));
      const nested = optObj(args, 'flags');
      const src: Args = nested ? { ...args, ...nested } : args;
      assignDefined(track as unknown as Args, src, ['muted', 'solo', 'locked', 'hidden', 'name', 'color', 'height', 'volume', 'bus']);
      if (track.bus !== undefined && track.bus !== 'dialogue' && track.bus !== 'music' && track.bus !== 'fx') {
        fail(`Op 'set_track_flags': bus must be dialogue, music or fx.`);
      }
      return;
    }

    case 'add_clip': {
      // An explicit clip object is honoured as-is (after its media ref
      // checks out); otherwise a clip is built from a media reference.
      const clipArg = optObj(args, 'clip');
      if (clipArg) {
        const mediaRef = clipArg.media;
        if (typeof mediaRef !== 'string' || !draft.media.some((m) => m.id === mediaRef)) {
          fail(`Op 'add_clip': the clip references media '${String(mediaRef)}', which is not in the project media registry — add media through the media tools / bin first (edit ops may not change the registry).`);
        }
        const trackId = optStr(args, 'trackId', 'track_id') ?? optStr(clipArg, 'trackId', 'track_id');
        const track = trackId ? findTrack(draft, trackId) : draft.tracks.find((t) => t.kind !== 'text') ?? draft.tracks[0];
        if (!track) fail(`Op 'add_clip': the project has no tracks to add a clip to.`);
        const clip = clone(clipArg) as unknown as Clip;
        if (!clip.id || draft.tracks.some((t) => t.clips.some((c) => c.id === clip.id))) clip.id = newId('clip');
        delete (clip as unknown as Args).trackId;
        delete (clip as unknown as Args).track_id;
        track.clips.push(clip);
        track.clips.sort((a, b) => a.start - b.start);
        return;
      }
      const mediaId = reqStr(args, name, 'mediaId', 'media_id', 'media', 'assetId', 'asset_id');
      const item = draft.media.find((m) => m.id === mediaId);
      if (!item) {
        fail(`Op 'add_clip': no media '${mediaId}' in the project media registry — add media through the media tools / bin first (edit ops may not change the registry).`);
      }
      const wantKind = item.kind === 'audio' ? 'audio' : 'video';
      let track: Track | undefined;
      const trackId = optStr(args, 'trackId', 'track_id');
      if (trackId) track = findTrack(draft, trackId);
      else track = draft.tracks.find((t) => t.kind === wantKind) ?? draft.tracks[0];
      if (!track) fail(`Op 'add_clip': the project has no tracks to add a clip to.`);
      if (track.kind === 'text') fail(`Op 'add_clip': media clips cannot go on a text track — use add_text for text clips.`);
      const start = optNum(args, 'start') ?? Math.max(0, ...track.clips.map((c) => c.start + clipDuration(c)));
      if (start < 0) fail(`Op 'add_clip': start must be >= 0.`);
      const inPt = optNum(args, 'in') ?? 0;
      const outPt = optNum(args, 'out') ?? item.duration ?? inPt + 5;
      if (inPt < 0 || outPt <= inPt) fail(`Op 'add_clip': needs 0 <= in < out (got in=${inPt}, out=${outPt}).`);
      const speed = optNum(args, 'speed') ?? 1;
      if (speed <= 0) fail(`Op 'add_clip': speed must be > 0.`);
      const id = optStr(args, 'clipId', 'clip_id') ?? newId('clip');
      if (draft.tracks.some((t) => t.clips.some((c) => c.id === id))) fail(`Op 'add_clip': a clip with id '${id}' already exists.`);
      if (track.kind === 'audio' || item.kind === 'audio') {
        const clip: AudioClip = {
          id, media: item.id, start, in: inPt, out: outPt, speed,
          volume: optNum(args, 'volume') ?? 1, fadeIn: optNum(args, 'fadeIn', 'fade_in') ?? 0,
          fadeOut: optNum(args, 'fadeOut', 'fade_out') ?? 0, transitionIn: null,
        };
        track.clips.push(clip);
      } else {
        const clip: VideoClip = {
          id, media: item.id, start, in: inPt, out: outPt, speed,
          muted: optBool(args, 'muted') ?? false, volume: optNum(args, 'volume') ?? 1,
          transitionIn: null, transform: { ...DEFAULT_TRANSFORM },
        };
        track.clips.push(clip);
      }
      track.clips.sort((a, b) => a.start - b.start);
      return;
    }

    case 'remove_clip': {
      const { track, index } = clipByArg(draft, args, name);
      track.clips.splice(index, 1);
      return;
    }

    case 'move_clip': {
      const { track, clip } = clipByArg(draft, args, name);
      const start = reqNum(args, name, 'start');
      if (start < 0) fail(`Op 'move_clip': start must be >= 0.`);
      const toTrackId = optStr(args, 'toTrackId', 'to_track_id', 'trackId', 'track_id');
      clip.start = start;
      if (toTrackId && toTrackId !== track.id) {
        const target = findTrack(draft, toTrackId);
        if (isTextClip(clip) && target.kind !== 'text') fail(`Op 'move_clip': a text clip can only move to a text track.`);
        if (!isTextClip(clip) && target.kind === 'text') fail(`Op 'move_clip': a media/adjustment clip cannot move to a text track.`);
        track.clips = track.clips.filter((c) => c.id !== clip.id);
        target.clips.push(clip);
        target.clips.sort((a, b) => a.start - b.start);
      }
      track.clips.sort((a, b) => a.start - b.start);
      return;
    }

    case 'trim_clip': {
      const { clip } = clipByArg(draft, args, name);
      const start = optNum(args, 'start');
      if (start !== undefined) { if (start < 0) fail(`Op 'trim_clip': start must be >= 0.`); clip.start = start; }
      if ('dur' in clip) {
        const dur = optNum(args, 'dur', 'duration');
        if (dur !== undefined) {
          if (dur <= 0) fail(`Op 'trim_clip': dur must be > 0.`);
          (clip as TextClip | AdjustmentClip).dur = dur;
          return;
        }
        const inV = optNum(args, 'in');
        const outV = optNum(args, 'out');
        if (inV !== undefined || outV !== undefined) {
          const ni = inV ?? 0;
          const no = outV ?? ni + (clip as TextClip).dur;
          if (ni < 0 || no <= ni) fail(`Op 'trim_clip': needs 0 <= in < out (got in=${ni}, out=${no}).`);
          (clip as TextClip | AdjustmentClip).dur = no - ni;
          return;
        }
        if (start === undefined) fail(`Op 'trim_clip' on a duration clip needs dur (or in/out, or start).`);
        return;
      }
      const mc = requireMediaClip(clip, name) as VideoClip | AudioClip | CompoundClip;
      const inV = optNum(args, 'in') ?? mc.in;
      const outV = optNum(args, 'out') ?? mc.out;
      if (inV < 0 || outV <= inV) fail(`Op 'trim_clip': needs 0 <= in < out (got in=${inV}, out=${outV}).`);
      mc.in = inV;
      mc.out = outV;
      return;
    }

    case 'split_clip': {
      const clipId = reqStr(args, name, 'clipId', 'clip_id');
      const at = reqNum(args, name, 'at', 'time', 't');
      splitInDraft(draft, clipId, at, name);
      return;
    }

    case 'duplicate_clip': {
      const { track, clip } = clipByArg(draft, args, name);
      const copy = clone(clip);
      copy.id = optStr(args, 'newClipId', 'new_clip_id') ?? newId('clip');
      if (draft.tracks.some((t) => t.clips.some((c) => c.id === copy.id))) {
        fail(`Op 'duplicate_clip': a clip with id '${copy.id}' already exists.`);
      }
      copy.start = optNum(args, 'start') ?? clip.start + clipDuration(clip);
      if (copy.start < 0) fail(`Op 'duplicate_clip': start must be >= 0.`);
      track.clips.push(copy);
      track.clips.sort((a, b) => a.start - b.start);
      return;
    }

    case 'set_clip_timing': {
      const { clip } = clipByArg(draft, args, name);
      if ('dur' in clip) fail(`Op 'set_clip_timing': clip '${clip.id}' is duration-based (text/adjustment) — it has no speed timing.`);
      if ('nest' in clip) fail(`Op 'set_clip_timing': compound clips are always 1:1 — clip '${clip.id}' has no speed timing.`);
      const mc = requireMediaClip(clip, name);
      const speed = optNum(args, 'speed');
      if (speed !== undefined) { if (speed <= 0) fail(`Op 'set_clip_timing': speed must be > 0.`); mc.speed = speed; }
      const keys = pick(args, 'speedKeys', 'speed_keys');
      if (keys !== undefined) {
        if (keys === null) delete mc.speedKeys;
        else {
          if (!Array.isArray(keys)) fail(`Op 'set_clip_timing': speedKeys must be an array of {t, speed}.`);
          for (const k of keys as { t?: unknown; speed?: unknown }[]) {
            if (!isObj(k) || typeof k.t !== 'number' || typeof k.speed !== 'number' || (k.speed as number) <= 0) {
              fail(`Op 'set_clip_timing': every speed key needs a numeric t and a speed > 0.`);
            }
          }
          mc.speedKeys = clone(keys) as { t: number; speed: number }[];
          mc.speedKeys.sort((a, b) => a.t - b.t);
        }
      }
      const reversed = optBool(args, 'reversed', 'reverse');
      if (reversed !== undefined) mc.reversed = reversed;
      const freeze = pick(args, 'freezeAt', 'freeze_at');
      if (freeze !== undefined) {
        if (freeze === null) delete mc.freezeAt;
        else if (typeof freeze === 'number' && Number.isFinite(freeze) && freeze >= 0) mc.freezeAt = freeze;
        else fail(`Op 'set_clip_timing': freezeAt must be a number >= 0 (or null to clear).`);
      }
      const pitch = optBool(args, 'pitchPreserve', 'pitch_preserve');
      if (pitch !== undefined) mc.pitchPreserve = pitch;
      const smooth = optBool(args, 'smoothSlowmo', 'smooth_slowmo');
      if (smooth !== undefined && 'smoothSlowmo' in mc) (mc as VideoClip).smoothSlowmo = smooth;
      return;
    }

    case 'link_clips': {
      const ids = pick(args, 'clipIds', 'clip_ids');
      if (!Array.isArray(ids) || ids.length < 2 || ids.some((x) => typeof x !== 'string')) {
        fail(`Op 'link_clips' needs clipIds: an array of at least two clip ids.`);
      }
      const groupId = optStr(args, 'groupId', 'group_id') ?? newId('grp');
      for (const id of ids as string[]) findClip(draft, id).clip.groupId = groupId;
      return;
    }

    case 'unlink_clips': {
      const groupId = optStr(args, 'groupId', 'group_id');
      const ids = pick(args, 'clipIds', 'clip_ids');
      const single = optStr(args, 'clipId', 'clip_id');
      const targets = new Set<string>();
      if (Array.isArray(ids)) for (const x of ids) if (typeof x === 'string') targets.add(x);
      if (single) targets.add(single);
      if (groupId === undefined && targets.size === 0) {
        fail(`Op 'unlink_clips' needs clipIds, a clipId, or a groupId.`);
      }
      // The groups to dissolve: the named group, or the group(s) the
      // named clips belong to (unlinking one member frees them all).
      const groups = new Set<string>();
      if (groupId !== undefined) groups.add(groupId);
      for (const id of targets) {
        const c = findClipQuiet(draft, id);
        if (c?.groupId) groups.add(c.groupId);
      }
      let cleared = 0;
      for (const track of draft.tracks) {
        for (const c of track.clips) {
          if (c.groupId !== undefined && groups.has(c.groupId)) { delete c.groupId; cleared++; }
        }
      }
      if (cleared === 0) fail(`Op 'unlink_clips': no linked clips matched.`);
      return;
    }

    case 'make_compound': {
      const ids = pick(args, 'clipIds', 'clip_ids');
      if (!Array.isArray(ids) || ids.length < 2 || ids.some((x) => typeof x !== 'string')) {
        fail(`Op 'make_compound' needs clipIds: an array of at least two clip ids (a compound of one clip is a no-op wrapper).`);
      }
      const found = (ids as string[]).map((id) => ({ id, ...findClip(draft, id) }));
      const videoFound = found.filter((x) => x.track.kind === 'video');
      if (videoFound.length === 0) fail(`Op 'make_compound': a compound clip lives on a video track — include at least one video-track clip.`);
      const anchor = videoFound[0];
      const start = Math.min(...found.map((x) => x.clip.start));
      const end = Math.max(...found.map((x) => x.clip.start + clipDuration(x.clip)));
      const nestTracks: Track[] = [];
      for (const tr of draft.tracks) {
        const sel = found.filter((x) => x.track.id === tr.id).map((x) => x.clip);
        if (sel.length === 0) continue;
        const nt = clone({ ...tr, clips: sel }) as Track;
        for (const c of nt.clips) c.start = Math.max(0, c.start - start);
        nt.clips.sort((a, b) => a.start - b.start);
        nestTracks.push(nt);
      }
      const nCompounds = draft.tracks.reduce((n, tr) => n + tr.clips.filter((c) => 'nest' in c).length, 0);
      const compound: CompoundClip = {
        id: optStr(args, 'newClipId', 'new_clip_id') ?? newId('clip'),
        start,
        in: 0,
        out: Math.max(0.001, end - start),
        nest: { name: optStr(args, 'name') ?? `Compound ${nCompounds + 1}`, tracks: nestTracks },
        transform: { ...DEFAULT_TRANSFORM },
        volume: 1,
        transitionIn: null,
        transitionDur: 0.25,
      };
      const idSet = new Set(found.map((x) => x.clip.id));
      for (const tr of draft.tracks) tr.clips = tr.clips.filter((c) => !idSet.has(c.id));
      const host = draft.tracks.find((t) => t.id === anchor.track.id)!;
      host.clips.push(compound);
      host.clips.sort((a, b) => a.start - b.start);
      return;
    }

    case 'uncompound': {
      const { track, clip } = clipByArg(draft, args, name);
      if (!('nest' in clip)) fail(`Op 'uncompound': clip '${clip.id}' is not a compound clip.`);
      const cc = clip as CompoundClip;
      track.clips = track.clips.filter((c) => c.id !== cc.id);
      const existing = new Set<string>();
      for (const tr of draft.tracks) for (const c of tr.clips) existing.add(c.id);
      for (const nt of cc.nest.tracks) {
        let target = draft.tracks.find((t) => t.id === nt.id);
        if (!target) {
          target = clone({ ...nt, clips: [] }) as Track;
          draft.tracks.push(target);
        }
        for (const nc0 of nt.clips) {
          const nc = clone(nc0);
          if (existing.has(nc.id)) nc.id = newId('clip');
          existing.add(nc.id);
          nc.start = Math.max(0, cc.start + (nc.start - cc.in));
          target.clips.push(nc);
        }
        target.clips.sort((a, b) => a.start - b.start);
      }
      return;
    }

    case 'add_adjustment_clip': {
      let track: Track | undefined;
      const trackId = optStr(args, 'trackId', 'track_id');
      if (trackId) track = findTrack(draft, trackId);
      else track = draft.tracks.find((t) => t.kind === 'video');
      if (!track) fail(`Op 'add_adjustment_clip': no video track to hold an adjustment clip.`);
      if (track.kind !== 'video') fail(`Op 'add_adjustment_clip': adjustment clips live on video tracks.`);
      const start = optNum(args, 'start') ?? 0;
      const dur = optNum(args, 'dur', 'duration') ?? 2;
      if (start < 0) fail(`Op 'add_adjustment_clip': start must be >= 0.`);
      if (dur <= 0) fail(`Op 'add_adjustment_clip': dur must be > 0.`);
      const clip: AdjustmentClip = {
        id: optStr(args, 'clipId', 'clip_id') ?? newId('clip'),
        adj: true, start, dur, effects: [], transitionIn: null, transitionDur: 0.25,
      };
      const fx = pick(args, 'effects');
      if (Array.isArray(fx)) clip.effects = clone(fx) as AdjustmentClip['effects'];
      track.clips.push(clip);
      track.clips.sort((a, b) => a.start - b.start);
      return;
    }

    case 'set_active_angle': {
      const { clip } = clipByArg(draft, args, name);
      const vc = clip as VideoClip;
      const idx = optNum(args, 'angle', 'index', 'activeAngle', 'active_angle');
      if (idx === undefined || !Number.isInteger(idx)) fail(`Op 'set_active_angle' needs an integer angle index.`);
      if (!vc.angles || !vc.angles[idx]) fail(`Op 'set_active_angle': clip '${clip.id}' has no angle ${idx} (it is not a multicam clip, or the index is out of range).`);
      const prev = vc.angles[vc.activeAngle ?? 0];
      const delta = (vc.angles[idx].syncOffset ?? 0) - (prev?.syncOffset ?? 0);
      const w = shiftedWindow(vc.in, vc.out, delta);
      vc.in = w.in;
      vc.out = w.out;
      vc.activeAngle = idx;
      vc.media = vc.angles[idx].media;
      return;
    }

    case 'cut_to_angle': {
      const clipId = reqStr(args, name, 'clipId', 'clip_id');
      const at = reqNum(args, name, 'at', 'time', 't');
      const idx = optNum(args, 'angle', 'index');
      if (idx === undefined || !Number.isInteger(idx)) fail(`Op 'cut_to_angle' needs an integer angle index.`);
      const before = findClip(draft, clipId).clip as VideoClip;
      if (!before.angles || !before.angles[idx]) fail(`Op 'cut_to_angle': clip '${clipId}' has no angle ${idx}.`);
      const rightId = splitInDraft(draft, clipId, at, name);
      const right = findClip(draft, rightId).clip as VideoClip;
      const src = findClip(draft, clipId).clip as VideoClip;
      const delta = (src.angles![idx].syncOffset ?? 0) - (src.angles![src.activeAngle ?? 0].syncOffset ?? 0);
      const w = shiftedWindow(right.in, right.out, delta);
      right.in = w.in;
      right.out = w.out;
      right.activeAngle = idx;
      right.media = src.angles![idx].media;
      return;
    }
  }

  // The remaining groups live in their own switch so this one stays readable.
  applyVisualOp(draft, name, args);
}

function findClipQuiet(p: Project, clipId: string): Clip | undefined {
  for (const track of p.tracks) {
    const c = track.clips.find((x) => x.id === clipId);
    if (c) return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// D / E / F / G / H
// ---------------------------------------------------------------------------

function applyVisualOp(draft: Project, name: string, args: Args): void {
  switch (name) {
    // ---- D: transform & animation ----------------------------------------
    case 'set_transform': {
      const { clip } = clipByArg(draft, args, name);
      const tc = requireTransformClip(clip, name);
      const nested = optObj(args, 'transform', 'patch');
      const src: Args = nested ?? args;
      for (const f of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
        const v = optNum(src, f);
        if (v !== undefined) tc.transform[f] = v;
      }
      if (tc.transform.opacity < 0 || tc.transform.opacity > 1) fail(`Op 'set_transform': opacity must be within 0..1.`);
      if (tc.transform.scale <= 0) fail(`Op 'set_transform': scale must be > 0.`);
      return;
    }

    case 'add_keyframe': {
      const { clip } = clipByArg(draft, args, name);
      if (!('transform' in clip) && !('adj' in clip)) {
        fail(`Op 'add_keyframe': clip '${clip.id}' cannot carry keyframes (video, compound and adjustment clips can).`);
      }
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      const nested = optObj(args, 'keyframe', 'kf');
      const src: Args = nested ?? args;
      const t = optNum(src, 't', 'time');
      if (t === undefined || t < 0) fail(`Op 'add_keyframe' needs a keyframe t >= 0 (clip-local seconds).`);
      const kf: Keyframe = { t };
      for (const f of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
        const v = optNum(src, f);
        if (v !== undefined) kf[f] = v;
      }
      const ease = optStr(src, 'ease');
      if (ease !== undefined) {
        if (!EASE_KINDS.has(ease)) fail(`Op 'add_keyframe': ease '${ease}' is not a known easing (${[...EASE_KINDS].join(', ')}).`);
        kf.ease = ease as Keyframe['ease'];
      }
      const handles = optObj(src, 'easeHandles', 'ease_handles');
      if (handles) kf.easeHandles = clone(handles) as Keyframe['easeHandles'];
      const hold = optBool(src, 'hold');
      if (hold !== undefined) kf.hold = hold;
      const mask = optObj(src, 'mask');
      if (mask) kf.mask = clone(mask) as Keyframe['mask'];
      const fx = optObj(src, 'fx');
      if (fx) kf.fx = clone(fx) as Keyframe['fx'];
      const kfs = holder.keyframes ?? [];
      const existingIdx = kfs.findIndex((k) => Math.abs(k.t - t) < 1e-6);
      if (existingIdx >= 0) kfs[existingIdx] = { ...kfs[existingIdx], ...kf };
      else kfs.push(kf);
      kfs.sort((a, b) => a.t - b.t);
      holder.keyframes = kfs;
      return;
    }

    case 'add_camera_move': {
      // J.12: write a whole synthetic camera move as keyframes in one op —
      // an eased push/pull/glide over a clip-local window, optionally with
      // an entry blur that settles across the same window (the clip enters
      // blurred and lands sharp, the reference-reel chain entry).
      const { clip } = clipByArg(draft, args, name);
      if (!('transform' in clip) && !('adj' in clip)) {
        fail(`Op 'add_camera_move': clip '${clip.id}' cannot carry keyframes (video, compound and adjustment clips can).`);
      }
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      const kind = optStr(args, 'kind', 'move');
      const KINDS = ['push-in', 'pull-out', 'glide-left', 'glide-right', 'glide-up', 'glide-down'];
      if (!kind || !KINDS.includes(kind)) fail(`Op 'add_camera_move' needs kind one of ${KINDS.join('/')}.`);
      const dur = clipDuration(clip);
      const start = optNum(args, 'start') ?? 0;
      if (start < 0 || start >= dur) fail(`Op 'add_camera_move': start ${start}s is outside clip '${clip.id}' (0..${dur.toFixed(3)}s).`);
      const span = optNum(args, 'dur', 'duration') ?? (dur - start);
      if (span <= 0 || start + span > dur + 1e-6) fail(`Op 'add_camera_move': window ${start}s + ${span}s exceeds clip '${clip.id}' (${dur.toFixed(3)}s).`);
      const ease = optStr(args, 'ease') ?? 'easeInOut';
      if (!EASE_KINDS.has(ease)) fail(`Op 'add_camera_move': ease '${ease}' is not a known easing (${[...EASE_KINDS].join(', ')}).`);
      const W = draft.canvas?.w ?? 720, H = draft.canvas?.h ?? 1280;
      let prop: 'scale' | 'x' | 'y', from: number, to: number;
      if (kind === 'push-in') { prop = 'scale'; from = optNum(args, 'from') ?? 1; to = optNum(args, 'to') ?? 1.15; }
      else if (kind === 'pull-out') { prop = 'scale'; from = optNum(args, 'from') ?? 1.15; to = optNum(args, 'to') ?? 1; }
      else if (kind === 'glide-left') { prop = 'x'; from = optNum(args, 'from') ?? 0; to = optNum(args, 'to') ?? -0.05 * W; }
      else if (kind === 'glide-right') { prop = 'x'; from = optNum(args, 'from') ?? 0; to = optNum(args, 'to') ?? 0.05 * W; }
      else if (kind === 'glide-up') { prop = 'y'; from = optNum(args, 'from') ?? 0; to = optNum(args, 'to') ?? -0.05 * H; }
      else { prop = 'y'; from = optNum(args, 'from') ?? 0; to = optNum(args, 'to') ?? 0.05 * H; }
      if (prop === 'scale' && (from <= 0 || to <= 0)) fail(`Op 'add_camera_move': scale from/to must be > 0.`);
      const kfs = holder.keyframes ?? [];
      const put = (t: number, patch: Partial<Keyframe>) => {
        const idx = kfs.findIndex((k) => Math.abs(k.t - t) < 1e-6);
        if (idx >= 0) kfs[idx] = { ...kfs[idx], ...patch };
        else kfs.push({ t, ...patch });
      };
      put(start, { [prop]: from } as Partial<Keyframe>);
      put(start + span, { [prop]: to, ease: ease as Keyframe['ease'] } as Partial<Keyframe>);
      const entryBlur = optNum(args, 'entryBlur', 'entry_blur');
      if (entryBlur !== undefined) {
        if (entryBlur < 0 || entryBlur > 1) fail(`Op 'add_camera_move': entryBlur must be within 0..1.`);
        if (entryBlur > 0) {
          // The blur effect's value unit is sigma/10 in Lane B. The effect
          // base carries the peak so the fx ride settles peak -> 0 across
          // the window; removing the keyframes restores the base blur.
          const peakVal = (entryBlur * 12) / 10;
          const fx = (holder.effects ?? []) as unknown as Args[];
          let blurFx = fx.find((e) => e.type === 'blur');
          if (!blurFx) { blurFx = { type: 'blur', value: peakVal }; fx.push(blurFx); }
          else blurFx.value = peakVal;
          holder.effects = fx as never;
          const ride = (t: number, v: number) => {
            const idx = kfs.findIndex((k) => Math.abs(k.t - t) < 1e-6);
            const cur = idx >= 0 ? kfs[idx] : { t };
            const merged: Keyframe = { ...cur, fx: { ...(cur.fx ?? {}), blur: v } };
            if (idx >= 0) kfs[idx] = merged; else kfs.push(merged);
          };
          ride(start, peakVal);
          ride(start + span, 0);
        }
      }
      kfs.sort((a, b) => a.t - b.t);
      holder.keyframes = kfs;
      return;
    }

    case 'remove_keyframe': {
      const { clip } = clipByArg(draft, args, name);
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      if (!holder.keyframes || holder.keyframes.length === 0) {
        fail(`Op 'remove_keyframe': clip '${clip.id}' has no keyframes.`);
      }
      const index = optNum(args, 'index');
      if (index !== undefined) {
        if (!Number.isInteger(index) || index < 0 || index >= holder.keyframes.length) {
          fail(`Op 'remove_keyframe': keyframe index ${index} is out of range (${holder.keyframes.length} keyframe(s)).`);
        }
        holder.keyframes.splice(index, 1);
      } else {
        const t = optNum(args, 't', 'time');
        if (t === undefined) fail(`Op 'remove_keyframe' needs a keyframe t or an index.`);
        const idx = holder.keyframes.findIndex((k) => Math.abs(k.t - t) < 1e-6);
        if (idx < 0) fail(`Op 'remove_keyframe': clip '${clip.id}' has no keyframe at t=${t}.`);
        holder.keyframes.splice(idx, 1);
      }
      if (holder.keyframes.length === 0) delete holder.keyframes;
      return;
    }

    case 'list_keyframes': {
      clipByArg(draft, args, name);
      return; // read-only vocabulary entry — validated no-op (see header)
    }

    case 'set_crop': {
      const { clip } = clipByArg(draft, args, name);
      if (!('transform' in clip) && !('adj' in clip)) fail(`Op 'set_crop': clip '${clip.id}' has no crop (video/compound clips do).`);
      const holder = clip as VideoClip | CompoundClip;
      const raw = pick(args, 'crop');
      if (raw === null) { holder.crop = null; return; }
      const src: Args = isObj(raw) ? raw : args;
      const crop = {
        l: optNum(src, 'l', 'left') ?? holder.crop?.l ?? 0,
        t: optNum(src, 't', 'top') ?? holder.crop?.t ?? 0,
        r: optNum(src, 'r', 'right') ?? holder.crop?.r ?? 0,
        b: optNum(src, 'b', 'bottom') ?? holder.crop?.b ?? 0,
        softness: optNum(src, 'softness') ?? holder.crop?.softness ?? 0,
      };
      for (const [k, v] of Object.entries(crop)) {
        if (v < 0 || v > 1) fail(`Op 'set_crop': crop.${k} must be a fraction within 0..1 (got ${v}).`);
      }
      if (crop.l + crop.r >= 1 || crop.t + crop.b >= 1) fail(`Op 'set_crop': opposite crop edges must sum to less than 1.`);
      holder.crop = crop;
      return;
    }

    case 'set_blend_mode': {
      const { clip } = clipByArg(draft, args, name);
      if (!('transform' in clip)) fail(`Op 'set_blend_mode': clip '${clip.id}' has no blend mode (video/compound clips do).`);
      const mode = reqStr(args, name, 'blend', 'mode', 'blendMode', 'blend_mode');
      if (!BLEND_MODES.has(mode)) fail(`Op 'set_blend_mode': blend '${mode}' is not one of ${[...BLEND_MODES].join(', ')}.`);
      (clip as VideoClip).blend = mode as VideoClip['blend'];
      return;
    }

    case 'set_flip': {
      const { clip } = clipByArg(draft, args, name);
      if (!('transform' in clip)) fail(`Op 'set_flip': clip '${clip.id}' cannot be flipped (video/compound clips can).`);
      const h = optBool(args, 'flipH', 'flip_h', 'horizontal');
      const v = optBool(args, 'flipV', 'flip_v', 'vertical');
      if (h === undefined && v === undefined) fail(`Op 'set_flip' needs flipH and/or flipV.`);
      const holder = clip as VideoClip | CompoundClip;
      if (h !== undefined) holder.flipH = h;
      if (v !== undefined) holder.flipV = v;
      return;
    }

    case 'set_fit': {
      const { clip } = clipByArg(draft, args, name);
      if (!('media' in clip) || 'nest' in clip || 'dur' in clip) fail(`Op 'set_fit': clip '${clip.id}' is not a video media clip.`);
      const fit = reqStr(args, name, 'fit');
      if (fit !== 'cover' && fit !== 'blur-fill') fail(`Op 'set_fit': fit must be 'cover' or 'blur-fill' (got '${fit}').`);
      (clip as VideoClip).fit = fit;
      return;
    }

    case 'set_mask': {
      const { clip } = clipByArg(draft, args, name);
      if (!('transform' in clip) && !('adj' in clip)) fail(`Op 'set_mask': clip '${clip.id}' cannot carry a mask.`);
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      const raw = pick(args, 'mask');
      if (raw === null) { holder.mask = null; return; }
      const src: Args = isObj(raw) ? raw : args;
      const shape = optStr(src, 'shape') ?? holder.mask?.shape ?? 'rect';
      if (shape !== 'rect' && shape !== 'circle' && shape !== 'linear' && shape !== 'pen') {
        fail(`Op 'set_mask': shape must be rect, circle, linear or pen (got '${shape}').`);
      }
      const mask = {
        shape: shape as 'rect' | 'circle' | 'linear' | 'pen',
        x: optNum(src, 'x') ?? holder.mask?.x ?? 0.5,
        y: optNum(src, 'y') ?? holder.mask?.y ?? 0.5,
        w: optNum(src, 'w', 'width') ?? holder.mask?.w ?? 0.5,
        h: optNum(src, 'h', 'height') ?? holder.mask?.h ?? 0.5,
        feather: optNum(src, 'feather') ?? holder.mask?.feather ?? 0,
        invert: optBool(src, 'invert') ?? holder.mask?.invert ?? false,
      } as VideoClip['mask'] & object;
      const angle = optNum(src, 'angle');
      if (angle !== undefined) (mask as Args).angle = angle;
      else if (holder.mask?.angle !== undefined) (mask as Args).angle = holder.mask.angle;
      const points = pick(src, 'points');
      if (Array.isArray(points)) (mask as Args).points = clone(points);
      else if (holder.mask?.points) (mask as Args).points = clone(holder.mask.points);
      holder.mask = mask as VideoClip['mask'];
      return;
    }

    case 'set_chroma_key': {
      const { clip } = clipByArg(draft, args, name);
      if (!('media' in clip) || 'nest' in clip || 'dur' in clip) fail(`Op 'set_chroma_key': clip '${clip.id}' is not a video media clip.`);
      const vc = clip as VideoClip;
      const raw = pick(args, 'chromaKey', 'chroma_key', 'key');
      if (raw === null) { delete vc.chromaKey; return; }
      const src: Args = isObj(raw) ? raw : args;
      vc.chromaKey = {
        color: optStr(src, 'color') ?? vc.chromaKey?.color ?? '#00ff00',
        intensity: optNum(src, 'intensity') ?? vc.chromaKey?.intensity ?? 0.5,
        shadow: optNum(src, 'shadow') ?? vc.chromaKey?.shadow ?? 0,
        spill: optNum(src, 'spill') ?? vc.chromaKey?.spill ?? 0,
      };
      for (const f of ['intensity', 'shadow', 'spill'] as const) {
        if (vc.chromaKey[f] < 0 || vc.chromaKey[f] > 1) fail(`Op 'set_chroma_key': ${f} must be within 0..1.`);
      }
      return;
    }

    case 'set_matte': {
      const { clip } = clipByArg(draft, args, name);
      if (!('media' in clip) || 'nest' in clip || 'dur' in clip) fail(`Op 'set_matte': clip '${clip.id}' is not a video media clip.`);
      const vc = clip as VideoClip;
      const raw = pick(args, 'matteId', 'matte_id', 'matte');
      if (raw === null || raw === undefined) {
        if (raw === null) { delete vc.matteId; return; }
        fail(`Op 'set_matte' needs a matteId (an existing media id, or null to clear).`);
      }
      if (typeof raw !== 'string' || !draft.media.some((m) => m.id === raw)) {
        fail(`Op 'set_matte': matte media '${String(raw)}' is not in the project media registry.`);
      }
      vc.matteId = raw;
      return;
    }

    // ---- E: effects & transitions -----------------------------------------
    case 'add_effect': {
      const { clip } = clipByArg(draft, args, name);
      if (isTextClip(clip)) fail(`Op 'add_effect': text clips carry string effect flags, not the effect stack — clip '${clip.id}' is a text clip.`);
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      const nested = optObj(args, 'effect');
      const src: Args = nested ?? args;
      const type = reqStr(src, name, 'type', 'effectType', 'effect_type');
      if (!EFFECT_TYPES.has(type)) fail(`Op 'add_effect': effect type '${type}' is not one of ${[...EFFECT_TYPES].join(', ')}.`);
      const effect: { type: EffectType; value: number; enabled?: boolean; params?: Record<string, number>; lights?: { x: number; y: number; color: string; radius: number; intensity: number }[] } = {
        type: type as EffectType,
        value: optNum(src, 'value') ?? 0.5,
      };
      const enabled = optBool(src, 'enabled');
      if (enabled !== undefined) effect.enabled = enabled;
      const params = optObj(src, 'params');
      if (params) effect.params = clone(params) as Record<string, number>;
      const lights = pick(src, 'lights');
      if (Array.isArray(lights)) effect.lights = clone(lights) as typeof effect.lights;
      holder.effects = [...(holder.effects ?? []), effect as never];
      return;
    }

    case 'update_effect': {
      const { clip } = clipByArg(draft, args, name);
      if (isTextClip(clip)) fail(`Op 'update_effect': clip '${clip.id}' is a text clip — it has no effect stack.`);
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      const effects = (holder.effects ?? []) as unknown as Args[];
      if (effects.length === 0) fail(`Op 'update_effect': clip '${clip.id}' has no effects to update.`);
      const idx = effectIndex(args, effects, name);
      const nested = optObj(args, 'effect', 'patch');
      const src: Args = nested ?? args;
      if (optNum(src, 'value') !== undefined) effects[idx].value = optNum(src, 'value');
      const enabled = optBool(src, 'enabled');
      if (enabled !== undefined) effects[idx].enabled = enabled;
      const params = optObj(src, 'params');
      if (params) effects[idx].params = { ...(effects[idx].params as Args ?? {}), ...clone(params) };
      const lights = pick(src, 'lights');
      if (Array.isArray(lights)) effects[idx].lights = clone(lights);
      return;
    }

    case 'remove_effect': {
      const { clip } = clipByArg(draft, args, name);
      if (isTextClip(clip)) fail(`Op 'remove_effect': clip '${clip.id}' is a text clip — it has no effect stack.`);
      const holder = clip as VideoClip | CompoundClip | AdjustmentClip;
      const effects = (holder.effects ?? []) as unknown as Args[];
      if (effects.length === 0) fail(`Op 'remove_effect': clip '${clip.id}' has no effects to remove.`);
      const idx = effectIndex(args, effects, name);
      effects.splice(idx, 1);
      holder.effects = effects as never;
      return;
    }

    case 'set_transition': {
      const { clip } = clipByArg(draft, args, name);
      const raw = pick(args, 'transitionIn', 'transition_in', 'type', 'transition');
      if (raw === null) clip.transitionIn = null;
      else if (typeof raw === 'string') {
        if (!TRANSITIONS.has(raw)) fail(`Op 'set_transition': transition '${raw}' is not one of ${[...TRANSITIONS].join(', ')} (or null for none).`);
        clip.transitionIn = raw as TransitionType;
      } else if (raw !== undefined) {
        fail(`Op 'set_transition': transitionIn must be a transition name or null.`);
      }
      const dur = optNum(args, 'transitionDur', 'transition_dur', 'duration', 'dur');
      if (dur !== undefined) { if (dur < 0) fail(`Op 'set_transition': transitionDur must be >= 0.`); clip.transitionDur = dur; }
      const dir = optStr(args, 'transitionDir', 'transition_dir', 'direction');
      if (dir !== undefined) {
        if (dir !== 'left' && dir !== 'right' && dir !== 'up' && dir !== 'down') fail(`Op 'set_transition': direction must be left, right, up or down.`);
        clip.transitionDir = dir;
      }
      const cx = optNum(args, 'wipeCx', 'wipe_cx');
      if (cx !== undefined) clip.wipeCx = cx;
      const cy = optNum(args, 'wipeCy', 'wipe_cy');
      if (cy !== undefined) clip.wipeCy = cy;
      const shape = optStr(args, 'wipeShape', 'wipe_shape');
      if (shape !== undefined) {
        if (shape !== 'circle' && shape !== 'petal' && shape !== 'blob') fail(`Op 'set_transition': wipeShape must be circle, petal or blob.`);
        clip.wipeShape = shape as Clip['wipeShape'];
      }
      const blur = optNum(args, 'transitionBlur', 'transition_blur');
      if (blur !== undefined) {
        if (blur < 0 || blur > 30) fail(`Op 'set_transition': transitionBlur must be within 0..30 (peak gblur sigma).`);
        clip.transitionBlur = blur;
      }
      const mode = optStr(args, 'transitionMode', 'transition_mode');
      if (mode !== undefined) {
        if (!BLUR_CUT_MODES.has(mode)) fail(`Op 'set_transition': transitionMode must be soft, whip or zoom.`);
        clip.transitionMode = mode as Clip['transitionMode'];
      }
      return;
    }

    // ---- F: colour ---------------------------------------------------------
    case 'set_grade_layer': {
      const { clip } = clipByArg(draft, args, name);
      const holder = gradeHolderOf(clip, name);
      const layers = gradeStackFor(holder);
      const patch = gradePatchFrom(args);
      const idxArg = optNum(args, 'layer', 'index');
      let idx: number;
      if (idxArg === undefined) idx = 0;
      else if (Number.isInteger(idxArg) && idxArg === layers.length && layers.length < MAX_GRADE_LAYERS) {
        layers.push(clone(DEFAULT_GRADE));
        idx = idxArg;
      } else idx = layerIndex(args, layers, name);
      const base = layers[idx] ?? clone(DEFAULT_GRADE);
      layers[idx] = { ...base, ...patch } as Grade;
      return;
    }

    case 'add_grade_layer': {
      const { clip } = clipByArg(draft, args, name);
      const holder = gradeHolderOf(clip, name);
      const layers = gradeStackFor(holder);
      if (layers.length >= MAX_GRADE_LAYERS) {
        fail(`Op 'add_grade_layer': clip '${clip.id}' already has the maximum ${MAX_GRADE_LAYERS} grade layers.`);
      }
      layers.push({ ...clone(DEFAULT_GRADE), ...gradePatchFrom(args) } as Grade);
      return;
    }

    case 'remove_grade_layer': {
      const { clip } = clipByArg(draft, args, name);
      const holder = gradeHolderOf(clip, name);
      const layers = gradeStackFor(holder);
      if (layers.length === 0) fail(`Op 'remove_grade_layer': clip '${clip.id}' has no grade layers.`);
      const idx = optNum(args, 'layer', 'index') ?? layers.length - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= layers.length) {
        fail(`Op 'remove_grade_layer': grade layer index ${idx} is out of range (stack has ${layers.length} layer(s)).`);
      }
      layers.splice(idx, 1);
      return;
    }

    case 'set_qualifier_key': {
      const { clip } = clipByArg(draft, args, name);
      const holder = gradeHolderOf(clip, name);
      const layers = ensureGradeStack(holder);
      const idx = layerIndex(args, layers, name);
      const raw = pick(args, 'key');
      if (raw === null) { delete layers[idx].key; return; }
      const src: Args = isObj(raw) ? raw : args;
      const cur = layers[idx].key ?? {
        hue: 0, hueWidth: 0.1, hueSoft: 0.05, satMin: 0, satMax: 1, satSoft: 0.1, lumaMin: 0, lumaMax: 1, lumaSoft: 0.1,
      };
      const key = { ...cur };
      assignDefined(key as unknown as Args, src, ['hue', 'hueWidth', 'hueSoft', 'satMin', 'satMax', 'satSoft', 'lumaMin', 'lumaMax', 'lumaSoft']);
      assignDefined(key as unknown as Args, {
        hueWidth: pick(src, 'hue_width'), hueSoft: pick(src, 'hue_soft'),
        satMin: pick(src, 'sat_min'), satMax: pick(src, 'sat_max'), satSoft: pick(src, 'sat_soft'),
        lumaMin: pick(src, 'luma_min'), lumaMax: pick(src, 'luma_max'), lumaSoft: pick(src, 'luma_soft'),
      }, ['hueWidth', 'hueSoft', 'satMin', 'satMax', 'satSoft', 'lumaMin', 'lumaMax', 'lumaSoft']);
      layers[idx].key = key;
      return;
    }

    case 'set_lut': {
      const lutRaw = pick(args, 'lutId', 'lut_id');
      const strength = optNum(args, 'lutStrength', 'lut_strength', 'strength');
      if (strength !== undefined && (strength < 0 || strength > 1)) fail(`Op 'set_lut': lutStrength must be within 0..1.`);
      const clipId = optStr(args, 'clipId', 'clip_id');
      let grade: Grade;
      if (clipId) {
        const { clip } = findClip(draft, clipId);
        const holder = gradeHolderOf(clip, name);
        const layers = ensureGradeStack(holder);
        grade = layers[layerIndex(args, layers, name)];
      } else {
        if (!draft.look) draft.look = clone(DEFAULT_GRADE);
        grade = draft.look;
      }
      if (lutRaw === null) delete grade.lutId;
      else if (typeof lutRaw === 'string' && lutRaw) grade.lutId = lutRaw;
      else if (lutRaw !== undefined) fail(`Op 'set_lut': lutId must be a LUT id string (or null to clear).`);
      if (strength !== undefined) grade.lutStrength = strength;
      if (lutRaw === undefined && strength === undefined) fail(`Op 'set_lut' needs a lutId and/or a lutStrength.`);
      return;
    }

    case 'set_project_look': {
      const raw = pick(args, 'look', 'grade');
      if (raw === null) { delete draft.look; return; }
      const patch = gradePatchFrom(raw === undefined ? args : { grade: raw });
      draft.look = { ...(draft.look ?? clone(DEFAULT_GRADE)), ...patch } as Grade;
      return;
    }

    // ---- G: text -----------------------------------------------------------
    case 'add_text': {
      const text = reqStr(args, name, 'text');
      const start = optNum(args, 'start') ?? 0;
      const dur = optNum(args, 'dur', 'duration') ?? 2;
      if (start < 0) fail(`Op 'add_text': start must be >= 0.`);
      if (dur <= 0) fail(`Op 'add_text': dur must be > 0.`);
      let track: Track | undefined;
      const trackId = optStr(args, 'trackId', 'track_id');
      if (trackId) track = findTrack(draft, trackId);
      else track = draft.tracks.find((t) => t.kind === 'text');
      if (track && track.kind !== 'text') fail(`Op 'add_text': text clips live on text tracks — track '${track.id}' is a ${track.kind} track.`);
      if (!track) {
        track = { id: newId('trk'), kind: 'text', clips: [] };
        draft.tracks.push(track);
      }
      const clip: TextClip = {
        id: optStr(args, 'clipId', 'clip_id') ?? newId('clip'),
        text, start, dur,
        style: optStr(args, 'style') ?? 'pop-bold',
        x: optNum(args, 'x') ?? 0.5,
        y: optNum(args, 'y') ?? 0.8,
        animIn: 'pop', animOut: 'fade', effects: [], transitionIn: null,
      };
      assignDefined(clip as unknown as Args, args, [
        'fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth',
        'shadow', 'shadowObj', 'glowObj', 'plate', 'curve', 'align', 'charSpacing',
        'lineSpacing', 'highlightColor', 'noFill', 'animIn', 'animOut', 'animInDur', 'animOutDur', 'animLoop',
      ]);
      track.clips.push(clip);
      track.clips.sort((a, b) => a.start - b.start);
      return;
    }

    case 'update_text': {
      const { clip } = clipByArg(draft, args, name);
      const tc = requireTextClip(clip, name);
      const text = optStr(args, 'text');
      if (text !== undefined) tc.text = text;
      const start = optNum(args, 'start');
      if (start !== undefined) { if (start < 0) fail(`Op 'update_text': start must be >= 0.`); tc.start = start; }
      const dur = optNum(args, 'dur', 'duration');
      if (dur !== undefined) { if (dur <= 0) fail(`Op 'update_text': dur must be > 0.`); tc.dur = dur; }
      assignDefined(tc as unknown as Args, args, ['x', 'y', 'words']);
      if (text === undefined && start === undefined && dur === undefined
        && pick(args, 'x') === undefined && pick(args, 'y') === undefined && pick(args, 'words') === undefined) {
        fail(`Op 'update_text' needs at least one of text, start, dur, x, y, words.`);
      }
      return;
    }

    case 'remove_text': {
      const { track, clip, index } = clipByArg(draft, args, name);
      requireTextClip(clip, name);
      track.clips.splice(index, 1);
      return;
    }

    case 'set_text_style': {
      const { clip } = clipByArg(draft, args, name);
      const tc = requireTextClip(clip, name);
      const nested = optObj(args, 'fields', 'patch');
      const src: Args = nested ? { ...args, ...nested } : { ...args };
      // `style` doubles as the preset-name field: a string sets it, an
      // object is treated as a bag of style fields.
      const styleRaw = pick(src, 'style');
      if (typeof styleRaw === 'string') tc.style = styleRaw;
      else if (isObj(styleRaw)) assignTextStyle(tc, styleRaw);
      assignTextStyle(tc, src);
      assignDefined(tc as unknown as Args, {
        fontFamily: pick(src, 'font_family'), fontWeight: pick(src, 'font_weight'),
        fontSize: pick(src, 'font_size'), strokeColor: pick(src, 'stroke_color'),
        strokeWidth: pick(src, 'stroke_width'), charSpacing: pick(src, 'char_spacing'),
        lineSpacing: pick(src, 'line_spacing'), highlightColor: pick(src, 'highlight_color'),
      }, ['fontFamily', 'fontWeight', 'fontSize', 'strokeColor', 'strokeWidth', 'charSpacing', 'lineSpacing', 'highlightColor']);
      return;
    }

    case 'apply_text_preset': {
      const { clip } = clipByArg(draft, args, name);
      const tc = requireTextClip(clip, name);
      const fields = optObj(args, 'fields', 'presetFields', 'preset_fields');
      if (fields) {
        assignTextStyle(tc, fields);
        const nm = optStr(args, 'preset', 'presetName', 'preset_name', 'name');
        if (nm !== undefined) tc.style = nm;
        return;
      }
      const presetArg = pick(args, 'preset', 'presetName', 'preset_name', 'name');
      if (isObj(presetArg) && isObj((presetArg as Args).fields)) {
        assignTextStyle(tc, (presetArg as Args).fields as Args);
        return;
      }
      if (typeof presetArg !== 'string' || !presetArg) {
        fail(`Op 'apply_text_preset' needs a preset name (built-ins: ${Object.keys(TEXT_PRESETS).join(', ')}) or explicit fields.`);
      }
      const preset = TEXT_PRESETS[presetArg];
      if (!preset) {
        fail(`Op 'apply_text_preset': no built-in text preset '${presetArg}' (built-ins: ${Object.keys(TEXT_PRESETS).join(', ')}). User presets live in the app's local storage, not the project JSON — pass their fields explicitly instead.`);
      }
      tc.style = presetArg;
      tc.fontFamily = preset.fontFamily;
      tc.fontWeight = preset.fontWeight;
      tc.fontSize = preset.fontSize;
      tc.color = preset.color;
      tc.strokeColor = preset.strokeColor;
      tc.strokeWidth = preset.strokeWidth;
      tc.shadow = preset.shadow;
      return;
    }

    case 'set_text_animation': {
      const { clip } = clipByArg(draft, args, name);
      const tc = requireTextClip(clip, name);
      const animIn = optStr(args, 'animIn', 'anim_in');
      if (animIn !== undefined) {
        if (!ANIM_TYPES.has(animIn)) fail(`Op 'set_text_animation': animIn '${animIn}' is not one of ${[...ANIM_TYPES].join(', ')}.`);
        tc.animIn = animIn as TextClip['animIn'];
      }
      const animOut = optStr(args, 'animOut', 'anim_out');
      if (animOut !== undefined) {
        if (!ANIM_TYPES.has(animOut)) fail(`Op 'set_text_animation': animOut '${animOut}' is not one of ${[...ANIM_TYPES].join(', ')}.`);
        tc.animOut = animOut as TextClip['animOut'];
      }
      const loop = optStr(args, 'animLoop', 'anim_loop');
      if (loop !== undefined) {
        if (!ANIM_LOOPS.has(loop)) fail(`Op 'set_text_animation': animLoop '${loop}' is not one of ${[...ANIM_LOOPS].join(', ')}.`);
        tc.animLoop = loop as TextClip['animLoop'];
      }
      const inDur = optNum(args, 'animInDur', 'anim_in_dur');
      if (inDur !== undefined) { if (inDur < 0) fail(`Op 'set_text_animation': animInDur must be >= 0.`); tc.animInDur = inDur; }
      const outDur = optNum(args, 'animOutDur', 'anim_out_dur');
      if (outDur !== undefined) { if (outDur < 0) fail(`Op 'set_text_animation': animOutDur must be >= 0.`); tc.animOutDur = outDur; }
      if (animIn === undefined && animOut === undefined && loop === undefined && inDur === undefined && outDur === undefined) {
        fail(`Op 'set_text_animation' needs at least one of animIn, animOut, animLoop, animInDur, animOutDur.`);
      }
      return;
    }

    // ---- H: audio ----------------------------------------------------------
    case 'set_clip_volume': {
      const { clip } = clipByArg(draft, args, name);
      if (!('volume' in clip)) fail(`Op 'set_clip_volume': clip '${clip.id}' has no volume (text clip?).`);
      const holder = clip as VideoClip | AudioClip | CompoundClip;
      const volume = reqNum(args, name, 'volume');
      holder.volume = Math.min(1, Math.max(0, volume));
      const muted = optBool(args, 'muted');
      if (muted !== undefined && 'muted' in holder) (holder as VideoClip).muted = muted;
      return;
    }

    case 'set_volume_keyframes': {
      const { clip } = clipByArg(draft, args, name);
      if (!('volume' in clip) || isTextClip(clip)) fail(`Op 'set_volume_keyframes': clip '${clip.id}' cannot carry volume keyframes.`);
      const holder = clip as VideoClip | AudioClip;
      const raw = pick(args, 'volumeKeys', 'volume_keys', 'keys');
      if (raw === null) { delete holder.volumeKeys; return; }
      if (!Array.isArray(raw)) fail(`Op 'set_volume_keyframes': volumeKeys must be an array of {t, v} (or null to clear).`);
      for (const k of raw as { t?: unknown; v?: unknown }[]) {
        if (!isObj(k) || typeof k.t !== 'number' || typeof k.v !== 'number' || (k.t as number) < 0 || (k.v as number) < 0) {
          fail(`Op 'set_volume_keyframes': every key needs a numeric t >= 0 and v >= 0.`);
        }
      }
      holder.volumeKeys = clone(raw) as { t: number; v: number }[];
      holder.volumeKeys.sort((a, b) => a.t - b.t);
      return;
    }

    case 'set_fades': {
      const { clip } = clipByArg(draft, args, name);
      if (!('volume' in clip) || isTextClip(clip) || 'nest' in clip || 'adj' in clip) {
        fail(`Op 'set_fades': clip '${clip.id}' has no audio fades (video/audio media clips do).`);
      }
      const holder = clip as VideoClip | AudioClip;
      const fadeIn = optNum(args, 'fadeIn', 'fade_in');
      const fadeOut = optNum(args, 'fadeOut', 'fade_out');
      if (fadeIn === undefined && fadeOut === undefined) fail(`Op 'set_fades' needs fadeIn and/or fadeOut.`);
      if (fadeIn !== undefined) { if (fadeIn < 0) fail(`Op 'set_fades': fadeIn must be >= 0.`); holder.fadeIn = fadeIn; }
      if (fadeOut !== undefined) { if (fadeOut < 0) fail(`Op 'set_fades': fadeOut must be >= 0.`); holder.fadeOut = fadeOut; }
      return;
    }

    case 'set_pan': {
      const { clip } = clipByArg(draft, args, name);
      if (!('volume' in clip) || isTextClip(clip) || 'nest' in clip || 'adj' in clip) {
        fail(`Op 'set_pan': clip '${clip.id}' has no pan (video/audio media clips do).`);
      }
      const pan = reqNum(args, name, 'pan');
      if (pan < -1 || pan > 1) fail(`Op 'set_pan': pan must be within -1..1 (got ${pan}).`);
      (clip as VideoClip | AudioClip).pan = pan;
      return;
    }

    case 'set_eq': {
      const { clip } = clipByArg(draft, args, name);
      if (!('volume' in clip) || isTextClip(clip) || 'nest' in clip || 'adj' in clip) {
        fail(`Op 'set_eq': clip '${clip.id}' has no EQ (video/audio media clips do).`);
      }
      const holder = clip as VideoClip | AudioClip;
      const raw = pick(args, 'eqBands', 'eq_bands', 'bands');
      if (raw !== undefined) {
        if (!Array.isArray(raw)) fail(`Op 'set_eq': eqBands must be an array of {freq, gain, q}.`);
        const bands = (raw as { freq?: unknown; gain?: unknown; q?: unknown }[]).slice(0, EQ_BAND_COUNT).map((b, i) => {
          if (!isObj(b)) fail(`Op 'set_eq': every EQ band must be an object {freq, gain, q}.`);
          return {
            freq: typeof b.freq === 'number' ? Math.min(16000, Math.max(30, b.freq)) : defaultEqBands()[i]?.freq ?? 1000,
            gain: typeof b.gain === 'number' ? Math.min(18, Math.max(-18, b.gain)) : 0,
            q: typeof b.q === 'number' ? Math.min(10, Math.max(0.2, b.q)) : 0.9,
          };
        });
        const defaults = defaultEqBands();
        while (bands.length < EQ_BAND_COUNT) bands.push(defaults[bands.length]);
        holder.eqBands = bands;
        return;
      }
      const low = optNum(args, 'eqLow', 'eq_low');
      const mid = optNum(args, 'eqMid', 'eq_mid');
      const high = optNum(args, 'eqHigh', 'eq_high');
      if (low === undefined && mid === undefined && high === undefined) {
        fail(`Op 'set_eq' needs eqBands (6-band parametric) or any of eqLow / eqMid / eqHigh.`);
      }
      if (low !== undefined) holder.eqLow = low;
      if (mid !== undefined) holder.eqMid = mid;
      if (high !== undefined) holder.eqHigh = high;
      return;
    }

    case 'set_denoise': {
      const { clip } = clipByArg(draft, args, name);
      if (!('volume' in clip) || isTextClip(clip) || 'nest' in clip || 'adj' in clip) {
        fail(`Op 'set_denoise': clip '${clip.id}' has no denoise flag (video/audio media clips do).`);
      }
      const on = optBool(args, 'denoise', 'enabled', 'on') ?? true;
      (clip as VideoClip | AudioClip).denoise = on;
      return;
    }

    case 'set_voice_fx': {
      const { clip } = clipByArg(draft, args, name);
      if (!('media' in clip) || 'transform' in clip || 'dur' in clip || 'nest' in clip) {
        fail(`Op 'set_voice_fx': clip '${clip.id}' is not an audio clip — voiceFx lives on audio clips.`);
      }
      const fx = reqStr(args, name, 'voiceFx', 'voice_fx', 'fx', 'effect');
      if (fx !== 'none' && fx !== 'echo' && fx !== 'hall') {
        fail(`Op 'set_voice_fx': voiceFx must be none, echo or hall (got '${fx}').`);
      }
      (clip as AudioClip).voiceFx = fx;
      return;
    }

    case 'set_audio_bus': {
      const nested = optObj(args, 'bus', 'audioBus', 'audio_bus');
      const src: Args = nested ?? args;
      const bus = { ...(draft.audioBus ?? { ...DEFAULT_AUDIO_BUS }) };
      assignDefined(bus as unknown as Args, src, [
        'masterGain', 'normalise', 'compEnabled', 'compThreshold', 'compRatio', 'compMakeup',
      ]);
      assignDefined(bus as unknown as Args, {
        masterGain: pick(src, 'master_gain'), compEnabled: pick(src, 'comp_enabled'),
        compThreshold: pick(src, 'comp_threshold'), compRatio: pick(src, 'comp_ratio'),
        compMakeup: pick(src, 'comp_makeup'),
      }, ['masterGain', 'compEnabled', 'compThreshold', 'compRatio', 'compMakeup']);
      const duck = optObj(src, 'ducking');
      if (duck) {
        const cur = bus.ducking ?? { enabled: false, amount: 10, attack: 20, release: 300 };
        const next = { ...cur };
        assignDefined(next as unknown as Args, duck, ['enabled', 'amount', 'attack', 'release']);
        bus.ducking = next;
      }
      if (bus.masterGain !== undefined && (bus.masterGain < 0 || bus.masterGain > 2)) {
        fail(`Op 'set_audio_bus': masterGain must be within 0..2.`);
      }
      draft.audioBus = bus as Project['audioBus'];
      return;
    }

    default:
      fail(`Unknown edit op '${name}'. Known ops: ${EDIT_OPS.join(', ')}.`);
  }
}

function effectIndex(args: Args, effects: Args[], op: string): number {
  const index = optNum(args, 'index');
  if (index !== undefined) {
    if (!Number.isInteger(index) || index < 0 || index >= effects.length) {
      fail(`Op '${op}': effect index ${index} is out of range (${effects.length} effect(s)).`);
    }
    return index;
  }
  const type = optStr(args, 'type', 'effectType', 'effect_type');
  if (type !== undefined) {
    const idx = effects.findIndex((e) => e.type === type);
    if (idx < 0) fail(`Op '${op}': clip has no '${type}' effect to target.`);
    return idx;
  }
  fail(`Op '${op}' needs an effect index or a type to identify the effect.`);
}

function gradeHolderOf(clip: Clip, op: string): { grade?: Grade; grades?: Grade[] } {
  if (isTextClip(clip) || !('media' in clip || 'nest' in clip || 'adj' in clip)) {
    fail(`Op '${op}': clip '${clip.id}' cannot carry a grade (video, compound and adjustment clips can).`);
  }
  return clip as VideoClip | CompoundClip | AdjustmentClip;
}

const TEXT_STYLE_FIELDS = [
  'fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth',
  'shadow', 'shadowObj', 'glowObj', 'plate', 'curve', 'align', 'charSpacing',
  'lineSpacing', 'highlightColor', 'noFill', 'x', 'y',
] as const;

function assignTextStyle(tc: TextClip, src: Args): void {
  assignDefined(tc as unknown as Args, src, [...TEXT_STYLE_FIELDS]);
  const effects = pick(src, 'effects');
  if (Array.isArray(effects)) tc.effects = clone(effects) as string[];
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

function normaliseOp(raw: unknown): { name: string; args: Args } {
  if (!isObj(raw)) fail(`Each edit op must be an object like {op: 'trim_clip', clipId: '…', in: 1, out: 4}.`);
  // The op name rides on `op` (canonical), or `name` / `type` as aliases.
  // Only the key that actually carried the name is stripped — `type` and
  // `name` are legitimate ARGS for other ops (add_effect's type,
  // add_track's name) and must survive when `op` is present.
  let name = '';
  let nameKey = '';
  for (const k of ['op', 'name', 'type'] as const) {
    if (typeof raw[k] === 'string' && raw[k]) { name = raw[k] as string; nameKey = k; break; }
  }
  if (!name) fail(`Each edit op needs an 'op' name (one of: ${EDIT_OPS.join(', ')}).`);
  const args: Args = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === nameKey || k === 'args') continue;
    args[k] = v;
  }
  if (isObj(raw.args)) Object.assign(args, raw.args);
  return { name, args };
}

function applyOne(draft: Project, raw: unknown): void {
  const { name, args } = normaliseOp(raw);
  if (MEDIA_REGISTRY_OPS.has(name)) {
    fail(`Op '${name}' would change the media registry — edit ops may not add, remove or rename media. Use the media tools / the editor bin for registry changes.`);
  }
  if (JOB_OPS.has(name)) {
    fail(`Op '${name}' queues a server job — it is not a pure project edit and does not belong in an edit-op batch. Queue it through the job surface instead.`);
  }
  if (name === 'separate_voice') {
    fail(`Op 'separate_voice' queues a demucs job — it is not a pure project edit. Queue it through the job surface instead.`);
  }
  // A nested `media` array/object in the args is a registry write in
  // disguise (a bare string media id is a reference, which is fine).
  if (args.media !== undefined && typeof args.media !== 'string') {
    fail(`Op '${name}': the 'media' arg may only reference an existing media id — edit ops may not change the media registry.`);
  }
  const before = mediaSignature(draft);
  applyOp(draft, name, args);
  if (mediaSignature(draft) !== before) {
    fail(`Op '${name}' changed the media registry — that is refused (edit ops may reference media, never alter the registry).`);
  }
}

/** Apply ONE op to a project document. Pure: the input is deep-cloned
 *  first and never mutated; failures throw a friendly Error. */
export function applyEditOp(project: Project, op: EditOp | Record<string, unknown>): Project {
  const draft = clone(project);
  applyOne(draft, op);
  return draft;
}

/** Apply an ordered batch of ops ATOMICALLY: the batch folds over a
 *  single clone, so any failure throws and the caller's original project
 *  is left exactly as it was — no half-applied batches, ever. */
export function applyEditOps(project: Project, ops: readonly (EditOp | Record<string, unknown>)[]): Project {
  if (!Array.isArray(ops) || ops.length === 0) {
    fail(`applyEditOps needs a non-empty ops array.`);
  }
  const draft = clone(project);
  ops.forEach((op, i) => {
    try {
      applyOne(draft, op);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(`Edit op ${i + 1} of ${ops.length} failed — the whole batch was refused, nothing was applied. ${msg}`);
    }
  });
  return draft;
}
