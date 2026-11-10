// CutLab project-schema validation — the Deno/Node port for the MCP
// connector (Phase 1, UPGRADE-PLAN.md §3). This is the THIRD home of one
// rule set: server/project_schema.py (worker) and
// src/services/promptSchema.ts (client) are the other two. Same key
// sets, same verdicts — pinned by scripts/mcp-harness.entry.ts, which
// runs the same fixtures through this file and the Python validator
// and compares the verdicts.
//
// Deliberately free of Deno-specific APIs (and of any imports) so the
// exact file the Edge Function runs also compiles under vite SSR for
// the harness.

export const PROJECT_KEYS = new Set([
  'version', 'name', 'canvas', 'media', 'mediaBins', 'rangeIn', 'rangeOut',
  'look', 'audioBus', 'tracks', 'markers', 'promptHistory', 'reframe',
  'editLog',
]);
export const CANVAS_KEYS = new Set(['w', 'h', 'fps', 'bg']);
export const MEDIA_KEYS = new Set(['id', 'src', 'kind', 'bin', 'duration', 'width', 'height']);
export const MEDIA_KINDS = new Set(['video', 'audio', 'image', 'matte', 'depth']);
export const TRACK_KEYS = new Set([
  'id', 'kind', 'muted', 'solo', 'locked', 'hidden', 'name', 'color', 'height', 'volume', 'clips', 'bus',
]);
export const TRACK_KINDS = new Set(['video', 'audio', 'text']);
export const MARKER_KEYS = new Set(['t', 'label', 'color', 'dur']);
export const BASE_CLIP_KEYS = new Set([
  'id', 'start', 'transitionIn', 'groupId', 'transitionDir', 'transitionDur', 'transitionBlur', 'transitionMode', 'wipeCx', 'wipeCy', 'wipeShape',
]);
export const VIDEO_CLIP_KEYS = new Set([
  ...BASE_CLIP_KEYS, 'media', 'in', 'out', 'speed', 'speedKeys', 'reversed', 'freezeAt',
  'pitchPreserve', 'smoothSlowmo', 'muted', 'volume', 'transform', 'keyframes', 'effects',
  'mask', 'matteId', 'chromaKey', 'grade', 'grades', 'crop', 'blend', 'flipH', 'flipV',
  'fadeIn', 'fadeOut', 'volumeKeys', 'pan', 'eqLow', 'eqMid', 'eqHigh', 'denoise', 'eqBands',
  'fit', 'angles', 'activeAngle', 'audioOverride',
]);
export const AUDIO_CLIP_KEYS = new Set([
  ...BASE_CLIP_KEYS, 'media', 'in', 'out', 'speed', 'speedKeys', 'reversed', 'freezeAt',
  'pitchPreserve', 'volume', 'fadeIn', 'fadeOut', 'volumeKeys', 'pan', 'eqLow', 'eqMid',
  'eqHigh', 'denoise', 'voiceFx', 'audioOverride', 'eqBands',
]);
export const TEXT_CLIP_KEYS = new Set([
  ...BASE_CLIP_KEYS, 'text', 'dur', 'style', 'fontFamily', 'fontWeight', 'fontSize',
  'color', 'strokeColor', 'strokeWidth', 'shadow', 'x', 'y', 'animIn', 'animOut',
  'animInDur', 'animOutDur', 'animLoop', 'effects', 'shadowObj', 'glowObj', 'plate',
  'curve', 'align', 'charSpacing', 'lineSpacing', 'highlightColor', 'noFill', 'words',
]);
export const COMPOUND_CLIP_KEYS = new Set([
  ...BASE_CLIP_KEYS, 'nest', 'in', 'out', 'volume', 'transform', 'keyframes', 'effects',
  'mask', 'grade', 'grades', 'crop', 'blend', 'flipH', 'flipV',
]);
export const ADJUSTMENT_CLIP_KEYS = new Set([...BASE_CLIP_KEYS, 'adj', 'dur', 'effects', 'grade', 'grades', 'mask', 'keyframes']);
export const TRANSITIONS = new Set([
  'cut', 'dissolve', 'flash', 'glare', 'slide', 'shake', 'blur-pulse', 'zoom', 'flip',
  'invert-flash', 'mask-wipe', 'blur-cut',
]);

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

class Errors {
  list: string[] = [];
  add(msg: string) {
    if (this.list.length < 25) this.list.push(msg);
  }
}

function checkKeys(obj: Obj, allowed: Set<string>, where: string, errs: Errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errs.add(`${where}: unknown field "${k}"`);
  }
}

function checkTransform(t: unknown, where: string, errs: Errors) {
  if (!isObj(t)) { errs.add(`${where}: transform must be an object`); return; }
  for (const f of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
    if (!isNum(t[f])) errs.add(`${where}: transform.${f} must be a number`);
  }
}

function checkMediaClip(raw: Obj, id: string, mediaIds: Set<string>, where: string, errs: Errors) {
  if (typeof raw.media !== 'string' || !mediaIds.has(raw.media)) {
    errs.add(`${where}: clip ${id} references media "${String(raw.media)}" which is not in the project media registry`);
  }
  if (!isNum(raw.in) || raw.in < 0) errs.add(`${where}: clip ${id} needs in ≥ 0`);
  if (!isNum(raw.out) || (isNum(raw.in) && raw.out <= raw.in)) errs.add(`${where}: clip ${id} needs out > in`);
  if (!isNum(raw.speed) || raw.speed <= 0) errs.add(`${where}: clip ${id} needs speed > 0`);
  if (!isNum(raw.volume) || raw.volume < 0) errs.add(`${where}: clip ${id} needs volume ≥ 0`);
}

function checkClip(raw: unknown, trackKind: string, mediaIds: Set<string>, where: string, errs: Errors, depth: number) {
  if (!isObj(raw)) { errs.add(`${where}: clip must be an object`); return; }
  if (typeof raw.id !== 'string' || !raw.id) errs.add(`${where}: clip.id must be a non-empty string`);
  if (!isNum(raw.start) || raw.start < 0) errs.add(`${where}: clip.start must be a number ≥ 0`);
  if (raw.transitionIn != null && !(typeof raw.transitionIn === 'string' && TRANSITIONS.has(raw.transitionIn))) {
    errs.add(`${where}: clip.transitionIn "${String(raw.transitionIn)}" is not a known transition`);
  }
  const id = typeof raw.id === 'string' ? raw.id : '?';

  if (trackKind === 'text') {
    checkKeys(raw, TEXT_CLIP_KEYS, `${where} (text clip ${id})`, errs);
    if (typeof raw.text !== 'string') errs.add(`${where}: text clip ${id} needs a text string`);
    if (!isNum(raw.dur) || raw.dur <= 0) errs.add(`${where}: text clip ${id} needs dur > 0`);
    if (typeof raw.style !== 'string') errs.add(`${where}: text clip ${id} needs a style string`);
    return;
  }
  if (trackKind === 'audio') {
    checkKeys(raw, AUDIO_CLIP_KEYS, `${where} (audio clip ${id})`, errs);
    checkMediaClip(raw, id, mediaIds, where, errs);
    if (!isNum(raw.fadeIn) || !isNum(raw.fadeOut)) errs.add(`${where}: audio clip ${id} needs fadeIn/fadeOut numbers`);
    return;
  }
  if (raw.adj === true) {
    checkKeys(raw, ADJUSTMENT_CLIP_KEYS, `${where} (adjustment clip ${id})`, errs);
    if (!isNum(raw.dur) || raw.dur <= 0) errs.add(`${where}: adjustment clip ${id} needs dur > 0`);
    return;
  }
  if (isObj(raw.nest)) {
    checkKeys(raw, COMPOUND_CLIP_KEYS, `${where} (compound clip ${id})`, errs);
    if (!isNum(raw.in) || !isNum(raw.out) || raw.out <= raw.in) {
      errs.add(`${where}: compound clip ${id} needs out > in`);
    }
    checkTransform(raw.transform, `${where} compound clip ${id}`, errs);
    if (depth >= 4) { errs.add(`${where}: compound clip ${id} nests deeper than 4`); return; }
    const nestTracks = (raw.nest as Obj).tracks;
    if (!Array.isArray(nestTracks)) { errs.add(`${where}: compound clip ${id} nest.tracks must be an array`); return; }
    nestTracks.forEach((t, i) => checkTrack(t, mediaIds, `${where} > nest track ${i}`, errs, depth + 1));
    return;
  }
  checkKeys(raw, VIDEO_CLIP_KEYS, `${where} (video clip ${id})`, errs);
  checkMediaClip(raw, id, mediaIds, where, errs);
  if (typeof raw.muted !== 'boolean') errs.add(`${where}: video clip ${id} needs a muted boolean`);
  checkTransform(raw.transform, `${where} video clip ${id}`, errs);
}

function checkTrack(raw: unknown, mediaIds: Set<string>, where: string, errs: Errors, depth = 0) {
  if (!isObj(raw)) { errs.add(`${where}: track must be an object`); return; }
  checkKeys(raw, TRACK_KEYS, where, errs);
  if (typeof raw.id !== 'string' || !raw.id) errs.add(`${where}: track.id must be a non-empty string`);
  if (!(typeof raw.kind === 'string' && TRACK_KINDS.has(raw.kind))) {
    errs.add(`${where}: track.kind "${String(raw.kind)}" is not video/audio/text`);
    return;
  }
  if (!Array.isArray(raw.clips)) { errs.add(`${where}: track.clips must be an array`); return; }
  raw.clips.forEach((c, i) => checkClip(c, raw.kind as string, mediaIds, `${where} clip ${i}`, errs, depth));
}

export interface SchemaVerdict {
  ok: boolean;
  errors: string[];
}

/** Strictly validate an unknown value as a CutLab Project (see header). */
export function validateProject(raw: unknown): SchemaVerdict {
  const errs = new Errors();
  if (!isObj(raw)) return { ok: false, errors: ['the project is not a JSON object'] };
  checkKeys(raw, PROJECT_KEYS, 'project', errs);
  if (raw.version !== 1) errs.add('project.version must be 1');
  if (typeof raw.name !== 'string') errs.add('project.name must be a string');
  if (!isObj(raw.canvas)) {
    errs.add('project.canvas must be an object');
  } else {
    checkKeys(raw.canvas, CANVAS_KEYS, 'canvas', errs);
    for (const f of ['w', 'h', 'fps'] as const) {
      if (!isNum(raw.canvas[f]) || (raw.canvas[f] as number) <= 0) errs.add(`canvas.${f} must be a positive number`);
    }
  }
  if (!Array.isArray(raw.media)) {
    errs.add('project.media must be an array');
    return { ok: false, errors: errs.list };
  }
  const mediaIds = new Set<string>();
  raw.media.forEach((m, i) => {
    const where = `media ${i}`;
    if (!isObj(m)) { errs.add(`${where}: must be an object`); return; }
    checkKeys(m, MEDIA_KEYS, where, errs);
    if (typeof m.id !== 'string' || !m.id) errs.add(`${where}: id must be a non-empty string`);
    else if (mediaIds.has(m.id)) errs.add(`${where}: duplicate media id "${m.id}"`);
    else mediaIds.add(m.id);
    if (typeof m.src !== 'string' || !m.src) errs.add(`${where}: src must be a non-empty string`);
    if (!(typeof m.kind === 'string' && MEDIA_KINDS.has(m.kind))) errs.add(`${where}: kind "${String(m.kind)}" is not a media kind`);
  });
  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    errs.add('project.tracks must be a non-empty array');
  } else {
    raw.tracks.forEach((t, i) => checkTrack(t, mediaIds, `track ${i}`, errs));
    const trackIds = new Set<string>();
    const clipIds = new Set<string>();
    const walk = (tracks: unknown[]) => {
      for (const t of tracks as Obj[]) {
        if (!isObj(t)) continue;
        if (typeof t.id === 'string') {
          if (trackIds.has(t.id)) errs.add(`duplicate track id "${t.id}"`);
          trackIds.add(t.id);
        }
        for (const c of (Array.isArray(t.clips) ? t.clips : []) as Obj[]) {
          if (!isObj(c)) continue;
          if (typeof c.id === 'string') {
            if (clipIds.has(c.id)) errs.add(`duplicate clip id "${c.id}"`);
            clipIds.add(c.id);
          }
          if (isObj(c.nest) && Array.isArray((c.nest as Obj).tracks)) walk((c.nest as Obj).tracks as unknown[]);
        }
      }
    };
    walk(raw.tracks);
  }
  if (raw.markers !== undefined) {
    if (!Array.isArray(raw.markers)) errs.add('project.markers must be an array');
    else raw.markers.forEach((mk, i) => {
      if (!isObj(mk)) { errs.add(`marker ${i}: must be an object`); return; }
      checkKeys(mk, MARKER_KEYS, `marker ${i}`, errs);
      if (!isNum(mk.t)) errs.add(`marker ${i}: t must be a number`);
      if (typeof mk.label !== 'string') errs.add(`marker ${i}: label must be a string`);
    });
  }
  return { ok: errs.list.length === 0, errors: errs.list };
}

/** Write-path verdict for the MCP connector: validateProject, minus
 *  ONE known false-positive class. The editor's compounds deliberately
 *  keep the nest tracks' original ids (types.ts: "The nest's tracks
 *  keep their original ids so uncompound is a plain merge-back"), and
 *  the host track stays on the timeline holding the compound — so the
 *  duplicate-id walk always reports the host track's id for ANY
 *  editor-made compound. That is the data model working as designed,
 *  not corruption; refusing it would make make_compound (and any edit
 *  to a project already containing a compound) unsavable. The filter
 *  drops only errors of the exact form `duplicate track id "X"` where
 *  X occurs exactly ONCE at the top level and also inside a compound
 *  nest. Genuine duplicates (an id twice at the top level, or a clip
 *  id) still refuse the write. validateProject itself is untouched —
 *  its verdicts stay identical to the Python validator's. */
export function writePathErrors(raw: unknown): string[] {
  const { errors } = validateProject(raw);
  if (!errors.length || !isObj(raw) || !Array.isArray(raw.tracks)) return errors;
  const topCount = new Map<string, number>();
  const nestIds = new Set<string>();
  const scanNest = (tracks: unknown[]) => {
    for (const t of tracks as Obj[]) {
      if (!isObj(t)) continue;
      if (typeof t.id === 'string') nestIds.add(t.id);
      for (const c of (Array.isArray(t.clips) ? t.clips : []) as Obj[]) {
        if (isObj(c) && isObj(c.nest) && Array.isArray((c.nest as Obj).tracks)) {
          scanNest((c.nest as Obj).tracks as unknown[]);
        }
      }
    }
  };
  for (const t of raw.tracks as Obj[]) {
    if (!isObj(t)) continue;
    if (typeof t.id === 'string') topCount.set(t.id, (topCount.get(t.id) ?? 0) + 1);
    for (const c of (Array.isArray(t.clips) ? t.clips : []) as Obj[]) {
      if (isObj(c) && isObj(c.nest) && Array.isArray((c.nest as Obj).tracks)) {
        scanNest((c.nest as Obj).tracks as unknown[]);
      }
    }
  }
  return errors.filter((e) => {
    const m = /^duplicate track id "(.*)"$/.exec(e);
    if (!m) return true;
    return !(topCount.get(m[1]) === 1 && nestIds.has(m[1]));
  });
}

/** The media-registry signature (id:src:kind set) — the MCP write
 *  path's media law compares this before/after every edit: timeline
 *  ops may never change it; only the group-B media tools may. Mirrors
 *  mediaRegistryError in promptSchema.ts / project_schema.py. */
export function mediaSignature(project: { media?: unknown }): string {
  const media = Array.isArray(project.media) ? project.media : [];
  return media
    .filter(isObj)
    .map((m) => `${String(m.id)}:${String(m.src)}:${String(m.kind)}`)
    .sort()
    .join('|');
}

export function mediaRegistryError(
  before: { media?: unknown },
  after: { media?: unknown },
): string | null {
  return mediaSignature(before) === mediaSignature(after)
    ? null
    : 'the edit changed the media registry (media may not be added, removed, or renamed by a timeline edit — use the media tools)';
}
