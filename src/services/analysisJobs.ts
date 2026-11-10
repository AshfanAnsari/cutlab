// Analysis jobs (D1.3): the client side of the relay's transcribe and
// track lanes — the server machinery existed since the parity pass; this
// is the wiring that lets the app consume it.
//
//   transcribe -> captions: queue the job for ONE clip's media, map the
//     returned segments from source time onto the clip's timeline span,
//     and land them as caption clips through the §L system
//     (captions.ts addTranscribedCaptions — design inherited from the
//     last caption, one undo step).
//   track -> keyframes: queue with a seed box drawn on the stage; the
//     finished job row (queue drawer) offers Apply, which merges the
//     returned positions into the clip's keyframes.
//
// Uploads follow the relay protocol: the original goes to
// users/<uid>/jobs/<job_id>/input/<src> BEFORE the row is inserted,
// and every job row carries the signed-in user's id (Phase 1).
import type { JobInfo } from './jobs';
import type { AdjustmentClip, AudioClip, Keyframe, MediaItem, Project, VideoClip } from '../types';
import { clipDuration, newId } from '../types';
import { store } from '../state/store';
import { mediaStore, registerMedia, type StoredMedia } from './mediaStore';
import { setSepStatus } from './sepJobs';
import { recsBySrc } from './attachResults';
import { restInsert, storageDownload, storageUpload } from './supabase';
import { assertFileCap, jobInputPath, requireUserId } from './relayAccess';
import { ensureLocalOriginals, relayUuid, waitForRelayJob } from './jobsSupabase';
import { addTranscribedCaptions, type Cue } from './captions';
import { applyAngleSync } from '../state/actions';

export type MediaClip = VideoClip | AudioClip;

const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;

/** The stored record for a clip's media (original bytes made local). */
async function localRecForClip(project: Project, clip: MediaClip): Promise<{ src: string; rec: StoredMedia }> {
  const media = project.media.find((m) => m.id === clip.media);
  if (!media) throw new Error('That clip’s media is not in the project bin.');
  const recs = await ensureLocalOriginals(project, await mediaStore.all());
  const rec = recsBySrc(recs).get(media.src);
  if (!rec) throw new Error(`"${media.src}" is not in the local media bin — import it first.`);
  return { src: media.src, rec };
}

// ------------------------------------------------------------- transcribe
export interface TranscribeSegment { start: number; end: number; text: string }

/** Map source-time segments onto one clip's timeline span (pure). */
export function segmentsToCues(clip: { start: number; in: number; out: number; speed?: number },
  segments: TranscribeSegment[]): Cue[] {
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const cues: Cue[] = [];
  for (const s of segments) {
    if (s.end <= clip.in || s.start >= clip.out) continue;
    const start = clip.start + (Math.max(s.start, clip.in) - clip.in) / speed;
    const end = clip.start + (Math.min(s.end, clip.out) - clip.in) / speed;
    if (end - start < 0.1) continue;
    cues.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: s.text });
  }
  return cues;
}

/**
 * Transcribe one clip's media on the server and land the speech inside
 * the clip's span as caption clips. Resolves with the caption count.
 * Throws friendly errors (the caller toasts them).
 */
export async function transcribeClipToCaptions(clip: MediaClip): Promise<number> {
  const uid = requireUserId('transcribe on the server');
  const project = store.get().project;
  const { src, rec } = await localRecForClip(project, clip);
  const jobId = relayUuid();
  assertFileCap(rec.blob.size, src);
  await storageUpload(jobInputPath(uid, jobId, src), rec.blob);
  await restInsert('cutlab_jobs', {
    id: jobId, type: 'transcribe', status: 'queued', user_id: uid,
    payload: { version: 1, type: 'transcribe', src, clipId: clip.id },
  });
  const row = await waitForRelayJob(jobId, { pollMs: 2500, timeoutMs: TRANSCRIBE_TIMEOUT_MS });
  const result = (row.result ?? {}) as { captions?: string };
  if (!result.captions) throw new Error('The transcription finished but returned no captions file.');
  const blob = await storageDownload(result.captions);
  let segments: TranscribeSegment[] = [];
  try {
    const caps = JSON.parse(await blob.text()) as {
      items?: Record<string, { segments?: TranscribeSegment[] }>;
    };
    segments = caps.items?.[src]?.segments ?? [];
  } catch {
    throw new Error('The captions file that came back was not readable.');
  }
  if (!segments.length) {
    store.toastMsg('info', 'Transcription finished — no speech was found in that file.');
    return 0;
  }
  const cues = segmentsToCues(clip, segments);
  if (!cues.length) {
    store.toastMsg('info', 'Transcription finished — no speech falls inside this clip’s span.');
    return 0;
  }
  return addTranscribedCaptions(cues);
}

// ------------------------------------------------------- multicam sync
const SYNC_TIMEOUT_MS = 10 * 60_000;

/**
 * D1.4: measure a multicam clip's angle offsets on the server (audio
 * cross-correlation against angle 1, inside a media-analysis job) and
 * land them on the clip. Angles the server could not measure are
 * reported by name — their offsets stay untouched, never invented.
 */
export async function syncMulticamClip(clip: VideoClip, trackId: string): Promise<void> {
  const uid = requireUserId('sync multicam angles on the server');
  const project = store.get().project;
  const angles = clip.angles ?? [];
  if (angles.length < 2) throw new Error('That clip has fewer than two angles to sync.');
  const recs = await ensureLocalOriginals(project, await mediaStore.all());
  const bySrc = recsBySrc(recs);
  const items: { id: string; src: string; kind: string; requests: string[] }[] = [];
  const srcByMedia = new Map<string, string>();
  for (const a of angles) {
    const media = project.media.find((m) => m.id === a.media);
    if (!media) throw new Error(`Angle "${a.label}" is missing from the project bin.`);
    const rec = bySrc.get(media.src);
    if (!rec) throw new Error(`"${media.src}" is not in the local media bin — import it first.`);
    items.push({ id: media.id, src: media.src, kind: media.kind, requests: [] });
    srcByMedia.set(media.src, media.id);
  }
  const jobId = relayUuid();
  for (const it of items) {
    const blob = bySrc.get(it.src)!.blob;
    assertFileCap(blob.size, it.src);
    await storageUpload(jobInputPath(uid, jobId, it.src), blob);
  }
  const anchorSrc = items[0].src;
  await restInsert('cutlab_jobs', {
    id: jobId, type: 'media-analysis', status: 'queued', user_id: uid,
    payload: {
      version: 1, type: 'media-analysis', createdAt: new Date().toISOString(),
      fps: project.canvas.fps, items,
      syncGroup: { anchor: anchorSrc, angles: items.map((i) => i.src) },
      clipId: clip.id,
    },
  });
  store.toastMsg('info', 'Sync queued on the server — correlating the angles’ audio…');
  const row = await waitForRelayJob(jobId, { pollMs: 2500, timeoutMs: SYNC_TIMEOUT_MS });
  const result = (row.result ?? {}) as { manifest?: { sync?: string | null; syncError?: string }; outputPrefix?: string };
  if (!result.manifest || !result.outputPrefix) {
    throw new Error('The sync job finished but returned no results manifest.');
  }
  if (!result.manifest.sync) {
    throw new Error(`The server could not sync these angles — ${result.manifest.syncError ?? 'no detail recorded'}`);
  }
  const blob = await storageDownload(result.outputPrefix + result.manifest.sync);
  let parsed: { offsets?: Record<string, number>; errors?: Record<string, string> };
  try {
    parsed = JSON.parse(await blob.text()) as typeof parsed;
  } catch {
    throw new Error('The sync result that came back was not readable.');
  }
  const byMedia: Record<string, number> = {};
  for (const [src, off] of Object.entries(parsed.offsets ?? {})) {
    const mid = srcByMedia.get(src);
    if (mid) byMedia[mid] = off;
  }
  const applied = applyAngleSync(trackId, clip.id, byMedia);
  const errs = Object.entries(parsed.errors ?? {});
  if (applied) {
    store.toastMsg('info', `Angles synced — ${applied} offset(s) measured against angle 1.`);
  }
  for (const [src, why] of errs) {
    store.toastMsg('error', `Could not sync ${src}: ${why}. Its offset was left unchanged.`);
  }
  if (!applied && !errs.length) {
    store.toastMsg('info', 'Sync finished — no offsets came back for these angles.');
  }
}

// ----------------------------------------------------------------- track
export interface TrackSeedBox { x: number; y: number; w: number; h: number }

/**
 * Queue a track job for a clip. `seedBox` is in canvas fractions; the
 * seed time is the clip-local time `seedClipT` mapped back to source
 * seconds. The payload records the clip + seedClipT so the queue row's
 * Apply button can merge the result later (even after a reload).
 */
export async function queueTrackJob(
  clip: VideoClip,
  seedBox: TrackSeedBox,
  seedClipT: number,
): Promise<void> {
  const uid = requireUserId('track on the server');
  const project = store.get().project;
  const { src, rec } = await localRecForClip(project, clip);
  const jobId = relayUuid();
  assertFileCap(rec.blob.size, src);
  await storageUpload(jobInputPath(uid, jobId, src), rec.blob);
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const seedSourceT = clip.in + seedClipT * speed;
  await restInsert('cutlab_jobs', {
    id: jobId, type: 'track', status: 'queued', user_id: uid,
    payload: {
      version: 1, type: 'track', src,
      seed: { t: Math.round(seedSourceT * 1000) / 1000, ...seedBox },
      canvas: { w: project.canvas.w, h: project.canvas.h },
      clipId: clip.id, seedClipT: Math.round(seedClipT * 1000) / 1000,
    },
  });
  store.toastMsg('info', 'Tracking queued on the server — Apply the result from the render queue when it finishes.');
}

/**
 * D2.1: queue a track job whose result becomes MASK keyframes on an
 * adjustment clip (a grade window that follows the subject). The job
 * itself is the ordinary track lane against the clip BENEATH the
 * adjustment; the payload records the purpose + target + seed box so
 * Apply converts the path instead of writing transform keyframes.
 */
export async function queueMaskTrackJob(
  adj: AdjustmentClip,
  beneath: VideoClip,
  seedBox: TrackSeedBox,
  seedClipT: number,
): Promise<void> {
  const uid = requireUserId('track on the server');
  const project = store.get().project;
  const { src, rec } = await localRecForClip(project, beneath);
  const jobId = relayUuid();
  assertFileCap(rec.blob.size, src);
  await storageUpload(jobInputPath(uid, jobId, src), rec.blob);
  const speed = beneath.speed && beneath.speed > 0 ? beneath.speed : 1;
  const seedSourceT = beneath.in + seedClipT * speed;
  await restInsert('cutlab_jobs', {
    id: jobId, type: 'track', status: 'queued', user_id: uid,
    payload: {
      version: 1, type: 'track', src,
      seed: { t: Math.round(seedSourceT * 1000) / 1000, ...seedBox },
      canvas: { w: project.canvas.w, h: project.canvas.h },
      clipId: beneath.id, seedClipT: Math.round(seedClipT * 1000) / 1000,
      purpose: 'mask-window', targetClipId: adj.id, box: seedBox,
    },
  });
  store.toastMsg('info', 'Window tracking queued — Apply the result from the render queue when it finishes.');
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Convert track-lane points into mask keyframes for a target clip
 * (pure): the window keeps the seed box's size; its centre follows the
 * tracked offsets (canvas px from centre, cover-mapped) around the
 * seed centre. Points landing outside the target's span are dropped.
 * `timelineSeedT` is the TIMELINE time of the seed on the tracked
 * clip; keyframe t is target-local.
 */
export function trackPointsToMaskKeyframes(
  points: TrackPoint[],
  box: TrackSeedBox,
  canvas: { w: number; h: number },
  timelineSeedT: number,
  targetStart: number,
  targetDur: number,
): Keyframe[] {
  const cx0 = box.x + box.w / 2;
  const cy0 = box.y + box.h / 2;
  const out: Keyframe[] = [];
  for (const p of points) {
    const local = timelineSeedT + p.t - targetStart;
    if (local < -0.001 || local > targetDur + 0.001) continue;
    const cx = cx0 + p.x / canvas.w;
    const cy = cy0 + p.y / canvas.h;
    out.push({
      t: r3(Math.max(0, local)),
      mask: { x: r4(cx - box.w / 2), y: r4(cy - box.h / 2), w: box.w, h: box.h },
      ease: 'linear',
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * D2.2: queue a track job whose result becomes the project's 9:16
 * reframe path. Same lane, purpose 'reframe'; Apply smooths + stores.
 */
export async function queueReframeTrackJob(
  clip: VideoClip,
  seedBox: TrackSeedBox,
  seedClipT: number,
): Promise<void> {
  const uid = requireUserId('track on the server');
  const project = store.get().project;
  const { src, rec } = await localRecForClip(project, clip);
  const jobId = relayUuid();
  assertFileCap(rec.blob.size, src);
  await storageUpload(jobInputPath(uid, jobId, src), rec.blob);
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const seedSourceT = clip.in + seedClipT * speed;
  await restInsert('cutlab_jobs', {
    id: jobId, type: 'track', status: 'queued', user_id: uid,
    payload: {
      version: 1, type: 'track', src,
      seed: { t: Math.round(seedSourceT * 1000) / 1000, ...seedBox },
      canvas: { w: project.canvas.w, h: project.canvas.h },
      clipId: clip.id, seedClipT: Math.round(seedClipT * 1000) / 1000,
      purpose: 'reframe',
    },
  });
  store.toastMsg('info', 'Reframe tracking queued — Apply the result from the render queue when it finishes.');
}

/**
 * Convert track-lane points to a smoothed 9:16 crop path (pure):
 * centres start from the tracked offsets, clamp so the vertical
 * window never leaves the frame, get a 3-tap smoothing pass, then a
 * velocity clamp — the crop centre never moves faster than 40 px per
 * frame at the project fps (the plan's no-jump bound). Times are
 * TIMELINE seconds.
 */
export function smoothReframePath(
  points: TrackPoint[],
  timelineSeedT: number,
  canvas: { w: number; h: number; fps: number },
): { t: number; cx: number }[] {
  const w2 = Math.max(2, Math.round((canvas.h * 9) / 16 / 2) * 2);
  const half = w2 / canvas.w / 2;
  const clampCx = (cx: number) => Math.min(1 - half, Math.max(half, cx));
  let pts = points
    .map((p) => ({ t: timelineSeedT + p.t, cx: clampCx(0.5 + p.x / canvas.w) }))
    .sort((a, b) => a.t - b.t);
  for (let pass = 0; pass < 3 && pts.length > 2; pass++) {
    pts = pts.map((p, i) => {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      return { t: p.t, cx: clampCx((a.cx + 2 * p.cx + b.cx) / 4) };
    });
  }
  const out: { t: number; cx: number }[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev) { out.push({ t: r3(p.t), cx: Math.round(p.cx * 10000) / 10000 }); continue; }
    const maxDelta = (40 * canvas.fps * Math.max(0, p.t - prev.t)) / canvas.w;
    const cx = Math.abs(p.cx - prev.cx) > maxDelta
      ? prev.cx + Math.sign(p.cx - prev.cx) * maxDelta
      : p.cx;
    out.push({ t: r3(p.t), cx: Math.round(cx * 10000) / 10000 });
  }
  return out;
}

/** One tracked position from the track lane (clip-local seconds). */
export interface TrackPoint { t: number; x: number; y: number }

/**
 * Merge tracked positions into a clip's keyframes (pure): tracked keys
 * replace any existing keys inside the tracked span (the span is the
 * tracker's own measurement — older hand keys there would fight it),
 * keys outside survive, everything stays sorted and inside the clip.
 */
export function mergeTrackKeyframes(
  existing: Keyframe[],
  seedClipT: number,
  points: TrackPoint[],
  clipDur: number,
): Keyframe[] {
  const fresh: Keyframe[] = points
    .map((p) => ({ t: Math.round((seedClipT + p.t) * 1000) / 1000, x: p.x, y: p.y }))
    .filter((k) => k.t >= 0 && k.t <= clipDur + 1e-9);
  if (!fresh.length) return existing;
  const lo = fresh[0].t, hi = fresh[fresh.length - 1].t;
  const kept = existing.filter((k) => k.t < lo - 1e-9 || k.t > hi + 1e-9);
  return [...kept, ...fresh].sort((a, b) => a.t - b.t);
}

/**
 * Apply a finished track job to its clip (the queue row's Apply
 * button): fetch the keyframes (inline on the result when small, else
 * the uploaded keyframes.json) and merge them in — one undo step.
 */
export async function applyTrackJob(job: JobInfo): Promise<void> {
  const payload = (job.payload ?? {}) as {
    clipId?: string; seedClipT?: number;
    purpose?: string; targetClipId?: string; box?: TrackSeedBox;
  };
  const result = (job.result ?? {}) as { keyframes?: TrackPoint[]; keyframesPath?: string; lost?: number; tracked?: number };
  if (!payload.clipId) throw new Error('That track job does not name its clip — it predates the wiring.');
  let points = result.keyframes;
  if (!points && result.keyframesPath) {
    const blob = await storageDownload(result.keyframesPath);
    try {
      points = (JSON.parse(await blob.text()) as { keyframes?: TrackPoint[] }).keyframes;
    } catch {
      throw new Error('The tracking result that came back was not readable.');
    }
  }
  if (!points?.length) throw new Error('That track job returned no keyframes.');
  const project = store.get().project;
  // D2.2: a reframe job stores its smoothed path on the project.
  if (payload.purpose === 'reframe') {
    let clip: VideoClip | undefined;
    for (const tr of project.tracks) {
      const c = tr.clips.find((x) => x.id === payload.clipId) as VideoClip | undefined;
      if (c) { clip = c; break; }
    }
    if (!clip) throw new Error('The reframed clip is no longer in this project.');
    const path = smoothReframePath(points, clip.start + (payload.seedClipT ?? 0), project.canvas);
    if (!path.length) throw new Error('The track returned no usable path.');
    const clipId = clip.id;
    store.commit((d) => { d.reframe = { clipId, points: path }; });
    store.toastMsg('info',
      `Reframe path ready — ${path.length} points. Tick "Reframe to 9:16" in the export panel.` +
      (result.lost ? ` (the tracker lost the subject on ${result.lost} frame(s); those hold position).` : ''));
    return;
  }
  // D2.1: a mask-window job lands its path as MASK keyframes on the
  // target adjustment clip instead of transform keys on the seed clip.
  if (payload.purpose === 'mask-window' && payload.targetClipId && payload.box) {
    let beneath: VideoClip | undefined;
    let target: AdjustmentClip | undefined;
    for (const tr of project.tracks) {
      for (const c of tr.clips) {
        if (c.id === payload.clipId) beneath = c as VideoClip;
        if (c.id === payload.targetClipId) target = c as AdjustmentClip;
      }
    }
    if (!beneath || !target) throw new Error('The window’s clips are no longer in this project.');
    const box = payload.box;
    const kfs = trackPointsToMaskKeyframes(
      points, box, project.canvas,
      beneath.start + (payload.seedClipT ?? 0), target.start, target.dur);
    if (!kfs.length) throw new Error('The tracked path never crosses the adjustment clip’s span.');
    const targetId = target.id;
    const lo = kfs[0].t, hi = kfs[kfs.length - 1].t;
    store.commit((d) => {
      for (const tr of d.tracks) {
        const c = tr.clips.find((x) => x.id === targetId) as AdjustmentClip | undefined;
        if (!c) continue;
        c.mask = {
          shape: 'rect', x: box.x, y: box.y, w: box.w, h: box.h,
          feather: c.mask?.feather ?? 0.02, invert: false,
        };
        const kept = (c.keyframes ?? []).filter((k) => !k.mask || k.t < lo - 1e-9 || k.t > hi + 1e-9);
        c.keyframes = [...kept, ...kfs].sort((a, b) => a.t - b.t);
      }
    });
    store.toastMsg('info',
      `Window tracked — ${kfs.length} mask keyframes on the adjustment clip` +
      (result.lost ? ` (the tracker lost the subject on ${result.lost} frame(s); those hold the last position).` : '.'));
    return;
  }
  let found: { trackId: string; clip: VideoClip } | null = null;
  for (const tr of project.tracks) {
    const c = tr.clips.find((x) => x.id === payload.clipId) as VideoClip | undefined;
    if (c) { found = { trackId: tr.id, clip: c }; break; }
  }
  if (!found) throw new Error('The tracked clip is no longer in this project.');
  const dur = clipDuration(found.clip);
  const merged = mergeTrackKeyframes(found.clip.keyframes ?? [], payload.seedClipT ?? 0, points, dur);
  const clipId = found.clip.id;
  store.commit((d) => {
    for (const tr of d.tracks) {
      const c = tr.clips.find((x) => x.id === clipId) as VideoClip | undefined;
      if (c) { c.keyframes = merged; break; }
    }
  });
  store.toastMsg('info',
    `Tracking applied — ${points.length} keyframes on the clip` +
    (result.lost ? ` (the tracker lost the subject on ${result.lost} frame(s); those hold the last position).` : '.'));
}

// ------------------------------------------------------ voice isolation
const SEPARATE_TIMEOUT_MS = 20 * 60_000;

/**
 * D1.5: run the demucs separation lane for a clip's media and register
 * the vocals stem as the clip's audioOverride. The stem lands as a NEW
 * project media asset (full length, same timing as the source), so the
 * render bundle carries it like any other file and the original audio
 * is never touched. Job state rides sepJobs (timeline chip + button).
 * Throws friendly errors (the caller toasts them).
 */
export async function isolateClipVoice(clip: MediaClip, trackId: string): Promise<void> {
  const project = store.get().project;
  setSepStatus(clip.id, 'queued');
  try {
    const uid = requireUserId('separate voices on the server');
    const { src, rec } = await localRecForClip(project, clip);
    const jobId = relayUuid();
    assertFileCap(rec.blob.size, src);
    await storageUpload(jobInputPath(uid, jobId, src), rec.blob);
    await restInsert('cutlab_jobs', {
      id: jobId, type: 'separate', status: 'queued', user_id: uid,
      payload: { version: 1, type: 'separate', src, clipId: clip.id },
    });
    const row = await waitForRelayJob(jobId, {
      pollMs: 2500, timeoutMs: SEPARATE_TIMEOUT_MS,
      onStatus: (s) => { if (s === 'running') setSepStatus(clip.id, 'working'); },
    });
    const items = ((row.result ?? {}) as { items?: Record<string, { vocals?: string }> }).items ?? {};
    const vocalsPath = items[src]?.vocals;
    if (!vocalsPath) throw new Error('The separation finished but returned no vocals stem.');
    const blob = await storageDownload(vocalsPath);
    const taken = new Set(project.media.map((m) => m.src));
    let stemSrc = `${src.replace(/\.[^.]+$/, '')}.vocals.wav`;
    for (let n = 2; taken.has(stemSrc); n++) stemSrc = stemSrc.replace(/\.wav$/, ` (${n}).wav`);
    const asset: MediaItem = { id: newId('med'), src: stemSrc, kind: 'audio' };
    const stemRec: StoredMedia = { meta: asset, blob };
    await mediaStore.put(stemRec);
    registerMedia(stemRec);
    store.commit((d) => {
      d.media.push(asset);
      for (const t of d.tracks) {
        if (t.id !== trackId) continue;
        const c = t.clips.find((x) => x.id === clip.id) as MediaClip | undefined;
        if (c) c.audioOverride = { stemMedia: asset.id, strength: 1, enabled: true };
      }
    });
    setSepStatus(clip.id, 'ready');
    window.setTimeout(() => setSepStatus(clip.id, undefined), 4000);
    store.toastMsg('info', 'Voice isolated — the preview plays the voice stem; blend strength lives in the Inspector.');
  } catch (e) {
    setSepStatus(clip.id, 'failed');
    throw e;
  }
}
