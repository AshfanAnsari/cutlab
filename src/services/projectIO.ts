// Project file IO: normalise any PLAN §3-shaped JSON into the internal model,
// save .json / .cutlab (zip bundle with media), load both back.
// The normaliser is the contract Lane B mirrors (render-lane-b/render.py).
import JSZip from 'jszip';
import type { AdjustmentClip, AudioClip, Clip, CompoundClip, EqBand, Grade, MediaItem, Project, TextClip, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM, newId } from '../types';
import { store } from '../state/store';
import { mediaStore, registerMedia, type StoredMedia } from './mediaStore';

/**
 * FIX B1 #6: shape gate for the project LOAD path. normalizeProject is
 * deliberately tolerant (it migrates old files), but a file that is not
 * a CutLab project at all must be refused BEFORE anything is replaced —
 * previously a wrong-shape JSON loaded silently as a trackless husk and
 * the 600 ms autosave then persisted the husk over the real project.
 * Throws a plain-language Error; the caller leaves the current project
 * and the autosave untouched.
 */
export function assertProjectShape(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error("That file isn't a CutLab project — it has no tracks.");
  }
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.tracks)) {
    throw new Error("That file isn't a CutLab project — it has no tracks.");
  }
  if (r.media !== undefined && !Array.isArray(r.media)) {
    throw new Error("That file isn't a CutLab project — its media list is unreadable.");
  }
  if (r.canvas !== undefined && (typeof r.canvas !== 'object' || r.canvas === null)) {
    throw new Error("That file isn't a CutLab project — its canvas settings are unreadable.");
  }
}

export function normalizeProject(raw: unknown): Project {
  const r = (raw ?? {}) as Record<string, unknown>;
  const canvas = (r.canvas ?? {}) as Record<string, number | string>;
  const p: Project = {
    version: 1,
    name: typeof r.name === 'string' ? r.name : 'Untitled project',
    canvas: {
      w: Number(canvas.w ?? 720),
      h: Number(canvas.h ?? 1280),
      fps: Number(canvas.fps ?? 30),
      bg: typeof canvas.bg === 'string' ? canvas.bg : undefined,
    },
    media: [],
    mediaBins: Array.isArray(r.mediaBins) ? (r.mediaBins as unknown[]).map(String) : undefined,
    tracks: [],
    markers: [],
  };
  const usedIds = new Set<string>();
  const uid = (prefix: string, want?: unknown): string => {
    let id = typeof want === 'string' && want && !usedIds.has(want) ? want : newId(prefix);
    while (usedIds.has(id)) id = newId(prefix);
    usedIds.add(id);
    return id;
  };
  for (const m of (r.media as Record<string, unknown>[] | undefined) ?? []) {
    const item: MediaItem = {
      id: uid('med', m.id),
      src: String(m.src ?? ''),
      kind: (['video', 'audio', 'image'].includes(String(m.kind)) ? m.kind : 'video') as MediaItem['kind'],
      bin: typeof m.bin === 'string' && m.bin ? m.bin : undefined,
      duration: typeof m.duration === 'number' ? m.duration : undefined,
      width: typeof m.width === 'number' ? m.width : undefined,
      height: typeof m.height === 'number' ? m.height : undefined,
    };
    p.media.push(item);
  }
  for (const t of (r.tracks as Record<string, unknown>[] | undefined) ?? []) {
    const track = normalizeTrackShell(t, uid);
    for (const c of (t.clips as Record<string, unknown>[] | undefined) ?? []) {
      track.clips.push(normalizeClip(track.kind, c, uid));
    }
    track.clips.sort((a, b) => a.start - b.start);
    p.tracks.push(track);
  }
  for (const mk of (r.markers as Record<string, unknown>[] | undefined) ?? []) {
    p.markers.push({
      t: Number(mk.t ?? 0),
      label: String(mk.label ?? ''),
      color: typeof mk.color === 'string' ? mk.color : undefined,
      dur: typeof mk.dur === 'number' && mk.dur > 0 ? mk.dur : undefined,
    });
  }
  if (typeof r.rangeIn === 'number') p.rangeIn = r.rangeIn;
  if (typeof r.rangeOut === 'number') p.rangeOut = r.rangeOut;
  if (r.reframe && typeof r.reframe === 'object') {
    const rf = r.reframe as { clipId?: unknown; points?: unknown };
    if (typeof rf.clipId === 'string' && Array.isArray(rf.points)) {
      const points = (rf.points as { t?: unknown; cx?: unknown }[])
        .filter((pt) => typeof pt?.t === 'number' && typeof pt?.cx === 'number')
        .map((pt) => ({ t: pt.t as number, cx: pt.cx as number }));
      if (points.length) p.reframe = { clipId: rf.clipId, points };
    }
  }
  if (r.look && typeof r.look === 'object') p.look = r.look as Project['look'];
  if (r.audioBus && typeof r.audioBus === 'object') {
    const b = r.audioBus as Record<string, unknown>;
    p.audioBus = {
      masterGain: typeof b.masterGain === 'number' ? b.masterGain : 1,
      normalise: b.normalise !== false,
      compEnabled: b.compEnabled === true,
      compThreshold: typeof b.compThreshold === 'number' ? b.compThreshold : -18,
      compRatio: typeof b.compRatio === 'number' ? b.compRatio : 3,
      compMakeup: typeof b.compMakeup === 'number' ? b.compMakeup : 4,
    };
    const dk = b.ducking as { enabled?: unknown; amount?: unknown; attack?: unknown; release?: unknown } | undefined;
    if (dk && typeof dk === 'object') {
      p.audioBus.ducking = {
        enabled: dk.enabled === true,
        amount: typeof dk.amount === 'number' ? Math.min(24, Math.max(0, dk.amount)) : 10,
        attack: typeof dk.attack === 'number' ? Math.min(500, Math.max(0, dk.attack)) : 20,
        release: typeof dk.release === 'number' ? Math.min(2000, Math.max(20, dk.release)) : 300,
      };
    }
  }
  if (Array.isArray(r.promptHistory)) {
    p.promptHistory = (r.promptHistory as Record<string, unknown>[])
      .filter((e) => e && typeof e.prompt === 'string')
      .map((e) => ({
        id: typeof e.id === 'string' && e.id ? e.id : newId('ph'),
        prompt: e.prompt as string,
        at: typeof e.at === 'string' ? e.at : '',
        summary: typeof e.summary === 'string' ? e.summary : undefined,
        applied: e.applied === true,
      }));
  }
  p.markers.sort((a, b) => a.t - b.t);
  return p;
}

/** Track shell (kind + header metadata) — ONE normaliser shared by the
 *  project root and by compound nests, whose tracks follow the same shape. */
function normalizeTrackShell(t: Record<string, unknown>, uid: (p: string, w?: unknown) => string): Track {
  const kind = (['video', 'audio', 'text'].includes(String(t.kind)) ? t.kind : 'video') as Track['kind'];
  return {
    id: uid('trk', t.id), kind, clips: [],
    muted: t.muted === true ? true : undefined,
    solo: t.solo === true ? true : undefined,
    locked: t.locked === true ? true : undefined,
    hidden: t.hidden === true ? true : undefined,
    name: typeof t.name === 'string' && t.name ? t.name : undefined,
    color: typeof t.color === 'string' && t.color ? t.color : undefined,
    height: typeof t.height === 'number' ? t.height : undefined,
    volume: typeof t.volume === 'number' ? t.volume : undefined,
    bus: (['dialogue', 'music', 'fx'].includes(String(t.bus)) ? t.bus : undefined) as Track['bus'],
  };
}

/** Grade stack migration (D1.1): a `grades` array wins; a legacy single
 *  `grade` becomes a one-element stack; the emitted project carries only
 *  `grades`, so old projects migrate on load by construction. */
/** D2.5: parametric EQ bands, shape-checked + clamped (max 6). */
function normEqBands(c: Record<string, unknown>): EqBand[] | undefined {
  if (!Array.isArray(c.eqBands)) return undefined;
  const out: EqBand[] = [];
  for (const b of c.eqBands as { freq?: unknown; gain?: unknown; q?: unknown }[]) {
    if (!b || typeof b.freq !== 'number') continue;
    out.push({
      freq: Math.min(16000, Math.max(30, b.freq)),
      gain: typeof b.gain === 'number' ? Math.min(18, Math.max(-18, b.gain)) : 0,
      q: typeof b.q === 'number' ? Math.min(10, Math.max(0.2, b.q)) : 0.9,
    });
    if (out.length >= 6) break;
  }
  return out.length ? out : undefined;
}

/** D1.5: a clip's voice-isolation override, shape-checked. */
function normAudioOverride(c: Record<string, unknown>): VideoClip['audioOverride'] {
  const o = c.audioOverride as { stemMedia?: unknown; strength?: unknown; enabled?: unknown } | undefined;
  if (!o || typeof o.stemMedia !== 'string' || !o.stemMedia) return undefined;
  return {
    stemMedia: o.stemMedia,
    strength: typeof o.strength === 'number' ? Math.min(1, Math.max(0, o.strength)) : 1,
    enabled: o.enabled !== false,
  };
}

function normGrades(c: Record<string, unknown>): Grade[] | undefined {
  if (Array.isArray(c.grades) && c.grades.length > 0) return c.grades as Grade[];
  if (c.grade) return [c.grade as Grade];
  return undefined;
}

function normalizeClip(kind: Track['kind'], c: Record<string, unknown>, uid: (p: string, w?: unknown) => string): Clip {
  const base = {
    id: uid('clip', c.id),
    start: Number(c.start ?? 0),
    groupId: typeof c.groupId === 'string' ? c.groupId : undefined,
    transitionIn: (c.transitionIn as VideoClip['transitionIn']) ?? null,
    transitionDir: (c.transitionDir as VideoClip['transitionDir']) ?? undefined,
    transitionDur: typeof c.transitionDur === 'number' ? c.transitionDur : 0.25,
    wipeCx: typeof c.wipeCx === 'number' ? c.wipeCx : undefined,
    wipeCy: typeof c.wipeCy === 'number' ? c.wipeCy : undefined,
    wipeShape: (c.wipeShape as VideoClip['wipeShape']) ?? undefined,
  };
  // Compound + adjustment clips live on video tracks and must be claimed
  // BEFORE the media branch below, which would strip them to a bare
  // VideoClip with an empty media id.
  if (kind === 'video' && c.nest && typeof c.nest === 'object') {
    const n = c.nest as { name?: unknown; tracks?: unknown };
    const nestTracks: Track[] = [];
    for (const t of (Array.isArray(n.tracks) ? n.tracks : []) as Record<string, unknown>[]) {
      const track = normalizeTrackShell(t, uid);
      for (const cc of (t.clips as Record<string, unknown>[] | undefined) ?? []) {
        track.clips.push(normalizeClip(track.kind, cc, uid));
      }
      track.clips.sort((a, b) => a.start - b.start);
      nestTracks.push(track);
    }
    const t = (c.transform ?? {}) as Partial<VideoClip['transform']>;
    const cc: CompoundClip = {
      ...base,
      nest: { name: String(n.name ?? 'Compound'), tracks: nestTracks },
      in: Number(c.in ?? 0),
      out: Number(c.out ?? 1),
      volume: typeof c.volume === 'number' ? c.volume : undefined,
      transform: {
        x: Number(t.x ?? DEFAULT_TRANSFORM.x),
        y: Number(t.y ?? DEFAULT_TRANSFORM.y),
        scale: Number(t.scale ?? DEFAULT_TRANSFORM.scale),
        rotation: Number(t.rotation ?? DEFAULT_TRANSFORM.rotation),
        opacity: Number(t.opacity ?? DEFAULT_TRANSFORM.opacity),
      },
      keyframes: (c.keyframes as CompoundClip['keyframes']) ?? undefined,
      effects: (c.effects as CompoundClip['effects']) ?? undefined,
      mask: (c.mask as CompoundClip['mask']) ?? null,
      grades: normGrades(c),
      crop: (c.crop as CompoundClip['crop']) ?? undefined,
      blend: (c.blend as CompoundClip['blend']) ?? undefined,
      flipH: c.flipH === true ? true : undefined,
      flipV: c.flipV === true ? true : undefined,
    };
    return cc;
  }
  if (kind === 'video' && c.adj === true) {
    const ac: AdjustmentClip = {
      ...base,
      adj: true,
      dur: Number(c.dur ?? 2),
      effects: (c.effects as AdjustmentClip['effects']) ?? [],
      grades: normGrades(c),
      mask: (c.mask as AdjustmentClip['mask']) ?? null,
      keyframes: (c.keyframes as AdjustmentClip['keyframes']) ?? undefined,
    };
    return ac;
  }
  if (kind === 'text') {
    const tc: TextClip = {
      ...base,
      text: String(c.text ?? 'Text'),
      dur: Number(c.dur ?? 1.5),
      style: String(c.style ?? 'pop-bold'),
      fontFamily: c.fontFamily as string | undefined,
      fontWeight: c.fontWeight as number | undefined,
      fontSize: c.fontSize as number | undefined,
      color: c.color as string | undefined,
      strokeColor: c.strokeColor as string | undefined,
      strokeWidth: c.strokeWidth as number | undefined,
      shadow: c.shadow as boolean | undefined,
      x: typeof c.x === 'number' ? c.x : 0.5,
      y: typeof c.y === 'number' ? c.y : 0.8,
      animIn: (c.animIn as TextClip['animIn']) ?? 'pop',
      animOut: (c.animOut as TextClip['animOut']) ?? 'fade',
      animInDur: typeof c.animInDur === 'number' ? c.animInDur : undefined,
      animOutDur: typeof c.animOutDur === 'number' ? c.animOutDur : undefined,
      animLoop: (c.animLoop as TextClip['animLoop']) ?? undefined,
      effects: (c.effects as string[] | undefined) ?? [],
      shadowObj: (c.shadowObj as TextClip['shadowObj']) ?? undefined,
      glowObj: (c.glowObj as TextClip['glowObj']) ?? undefined,
      plate: (c.plate as TextClip['plate']) ?? undefined,
      align: (c.align as TextClip['align']) ?? undefined,
      charSpacing: typeof c.charSpacing === 'number' ? c.charSpacing : undefined,
      lineSpacing: typeof c.lineSpacing === 'number' ? c.lineSpacing : undefined,
      highlightColor: typeof c.highlightColor === 'string' ? c.highlightColor : undefined,
      noFill: c.noFill === true ? true : undefined,
      words: (c.words as TextClip['words']) ?? undefined,
      curve: typeof c.curve === 'number' ? c.curve : undefined,
    };
    return tc;
  }
  if (kind === 'audio') {
    const ac: AudioClip = {
      ...base,
      media: String(c.media ?? ''),
      in: Number(c.in ?? 0),
      out: Number(c.out ?? 0),
      speed: Number(c.speed ?? 1),
      speedKeys: Array.isArray(c.speedKeys) ? (c.speedKeys as { t: number; speed: number }[]) : undefined,
      reversed: c.reversed === true ? true : undefined,
      freezeAt: typeof c.freezeAt === 'number' ? c.freezeAt : undefined,
      pitchPreserve: c.pitchPreserve === true ? true : undefined,
      volume: Number(c.volume ?? 1),
      fadeIn: Number(c.fadeIn ?? 0),
      fadeOut: Number(c.fadeOut ?? 0),
      volumeKeys: (c.volumeKeys as AudioClip['volumeKeys']) ?? undefined,
      pan: typeof c.pan === 'number' ? c.pan : undefined,
      eqLow: typeof c.eqLow === 'number' ? c.eqLow : undefined,
      eqMid: typeof c.eqMid === 'number' ? c.eqMid : undefined,
      eqHigh: typeof c.eqHigh === 'number' ? c.eqHigh : undefined,
      eqBands: normEqBands(c),
      denoise: c.denoise === true ? true : undefined,
      voiceFx: (c.voiceFx as AudioClip['voiceFx']) ?? undefined,
      audioOverride: normAudioOverride(c),
    };
    return ac;
  }
  const t = (c.transform ?? {}) as Partial<VideoClip['transform']>;
  const vc: VideoClip = {
    ...base,
    media: String(c.media ?? ''),
    in: Number(c.in ?? 0),
    out: Number(c.out ?? 0),
    speed: Number(c.speed ?? 1),
      speedKeys: Array.isArray(c.speedKeys) ? (c.speedKeys as { t: number; speed: number }[]) : undefined,
      reversed: c.reversed === true ? true : undefined,
      freezeAt: typeof c.freezeAt === 'number' ? c.freezeAt : undefined,
      pitchPreserve: c.pitchPreserve === true ? true : undefined,
    smoothSlowmo: c.smoothSlowmo === true ? true : undefined,
    muted: Boolean(c.muted ?? false),
    volume: Number(c.volume ?? 1),
    transform: {
      x: Number(t.x ?? DEFAULT_TRANSFORM.x),
      y: Number(t.y ?? DEFAULT_TRANSFORM.y),
      scale: Number(t.scale ?? DEFAULT_TRANSFORM.scale),
      rotation: Number(t.rotation ?? DEFAULT_TRANSFORM.rotation),
      opacity: Number(t.opacity ?? DEFAULT_TRANSFORM.opacity),
    },
    keyframes: (c.keyframes as VideoClip['keyframes']) ?? undefined,
    effects: (c.effects as VideoClip['effects']) ?? undefined,
    mask: (c.mask as VideoClip['mask']) ?? null,
    matteId: typeof c.matteId === 'string' ? c.matteId : undefined,
    chromaKey: (c.chromaKey as VideoClip['chromaKey']) ?? undefined,
    grades: normGrades(c),
    crop: (c.crop as VideoClip['crop']) ?? undefined,
    blend: (c.blend as VideoClip['blend']) ?? undefined,
    flipH: c.flipH === true ? true : undefined,
    flipV: c.flipV === true ? true : undefined,
    fadeIn: typeof c.fadeIn === 'number' ? c.fadeIn : undefined,
    fadeOut: typeof c.fadeOut === 'number' ? c.fadeOut : undefined,
    volumeKeys: (c.volumeKeys as VideoClip['volumeKeys']) ?? undefined,
    pan: typeof c.pan === 'number' ? c.pan : undefined,
    eqLow: typeof c.eqLow === 'number' ? c.eqLow : undefined,
    eqMid: typeof c.eqMid === 'number' ? c.eqMid : undefined,
    eqHigh: typeof c.eqHigh === 'number' ? c.eqHigh : undefined,
    eqBands: normEqBands(c),
    denoise: c.denoise === true ? true : undefined,
    fit: (c.fit as VideoClip['fit']) ?? undefined,
    angles: Array.isArray(c.angles) ? (c.angles as VideoClip['angles']) : undefined,
    audioOverride: normAudioOverride(c),
    activeAngle: typeof c.activeAngle === 'number' ? c.activeAngle : undefined,
  };
  return vc;
}

/** Recompute media durations/dimensions in the project from what mediaStore knows. */
export function syncMediaMeta(p: Project, known: Map<string, StoredMedia>): Project {
  return {
    ...p,
    media: p.media.map((m) => {
      const rec = known.get(m.id) ?? [...known.values()].find((r) => r.meta.src === m.src);
      if (!rec) return m;
      return { ...m, duration: rec.meta.duration ?? m.duration, width: rec.meta.width ?? m.width, height: rec.meta.height ?? m.height };
    }),
  };
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function saveProjectJson(p: Project) {
  downloadBlob(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }),
    p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.cutlab.json');
}

export async function saveProjectBundle(p: Project, mediaRecs: StoredMedia[]) {
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify(p, null, 2));
  const folder = zip.folder('media');
  const bySrc = new Map<string, StoredMedia>();
  for (const r of mediaRecs) bySrc.set(r.meta.src, r);
  for (const m of p.media) {
    const rec = bySrc.get(m.src);
    if (rec && folder) folder.file(m.src, rec.blob);
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.cutlab');
}

/**
 * Load a project from a File (.json or .cutlab zip). Media inside a bundle is
 * imported into mediaStore; a bare .json binds to already-imported media whose
 * file name matches `src`. Returns the normalised project.
 */
export async function loadProjectFile(file: File): Promise<Project> {
  try {
    if (/\.cutlab$/i.test(file.name) || file.type === 'application/zip') {
      const zip = await JSZip.loadAsync(file);
      const pj = zip.file('project.json');
      if (!pj) throw new Error('Bundle has no project.json');
      const rawProject: unknown = JSON.parse(await pj.async('string'));
      assertProjectShape(rawProject);
      const project = normalizeProject(rawProject);
      const known = await mediaStore.all();
      const bySrc = new Map(known.map((r) => [r.meta.src, r]));
      for (const m of project.media) {
        const entry = zip.file('media/' + m.src);
        if (!entry) continue;
        const blob = await entry.async('blob');
        const existing = bySrc.get(m.src);
        const rec: StoredMedia = existing && existing.meta.id === m.id
          ? existing
          : { meta: { ...m }, blob };
        rec.meta = { ...rec.meta, id: m.id, src: m.src, kind: m.kind };
        rec.blob = blob;
        await mediaStore.put(rec);
        registerMedia(rec);
      }
      return project;
    }
    const text = await file.text();
    const rawProject: unknown = JSON.parse(text);
    assertProjectShape(rawProject);
    return normalizeProject(rawProject);
  } catch (e) {
    store.toastMsg('error', 'Could not load that project file — ' + (e instanceof Error ? e.message : String(e)));
    throw e;
  }
}

/** Which project-media entries have no stored blob bound (by id or file name)? */
export async function missingMedia(p: Project): Promise<MediaItem[]> {
  const known = await mediaStore.all();
  const ids = new Set(known.map((r) => r.meta.id));
  const srcs = new Set(known.map((r) => r.meta.src));
  return p.media.filter((m) => !ids.has(m.id) && !srcs.has(m.src));
}
