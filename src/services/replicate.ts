// Replicate-an-edit logic (parked-features plan, Feature 2): raw-file
// intake that does NOT touch the open project, the suggested slot
// mapping, and the project build. UI lives in components/ReplicateView;
// this file is pure logic + the media-store intake, per the structure
// rule (UI separated from logic).
//
// Acceptance rules baked in here:
//  - unmapped segments BLOCK the build, with the segment named;
//  - the built project carries NO reference audio, watermark, or caption
//    text: tracks are one video track (the user's own clips) plus an
//    empty text track; spec captions exist only as review information.

import { DEFAULT_TRANSFORM, newId } from '../types';
import type { MediaItem, Project, VideoClip } from '../types';
import { kindOfFile, probeFile } from './importer';
import { mediaStore, registerMedia, type StoredMedia } from './mediaStore';
import type { ReplicateSpec } from './promptJobs';

export interface RawClip {
  file: File;
  meta: MediaItem;
}

export interface SlotMap {
  segmentIndex: number;
  /** Media id of the mapped raw clip; null = unmapped (blocks Build). */
  mediaId: string | null;
  in: number;
  out: number;
  /** True when the mapped clip is shorter than the segment needs. */
  shortfall: boolean;
}

/** Import one raw file into the media store WITHOUT adding it to the
 *  open project (importer.importFiles commits into the project; the
 *  Replicate view must never pollute an open project). */
export async function importRawClip(file: File): Promise<RawClip> {
  const kind = kindOfFile(file);
  if (!kind) throw new Error(`"${file.name}" is not a video, audio or image file.`);
  if (kind === 'audio') throw new Error(`"${file.name}" is audio-only — raw footage must be video or photos.`);
  const id = newId('med');
  const meta: MediaItem = { id, src: file.name, kind, ...(await probeFile(file, kind)) };
  const rec: StoredMedia = { meta, blob: file };
  await mediaStore.put(rec);
  registerMedia(rec);
  return { file, meta };
}

function mediaDuration(m: MediaItem): number {
  // Photos have no duration: they can fill any segment length.
  if (m.kind === 'image') return Number.POSITIVE_INFINITY;
  return m.duration ?? 0;
}

/** The suggested mapping: order-preserving greedy — each segment takes
 *  the earliest unused raw video that can cover its length; photos fill
 *  any length; anything else stays unmapped (flagged, never silently
 *  filled). Pure function of (spec, raws) so it is harness-testable. */
export function suggestMapping(spec: ReplicateSpec, raws: MediaItem[]): SlotMap[] {
  const used = new Set<string>();
  return spec.segments.map((seg, i) => {
    const len = Math.max(0.05, seg.end - seg.start);
    const video = raws.find((m) => m.kind === 'video' && !used.has(m.id) && mediaDuration(m) >= len);
    const photo = video ? undefined : raws.find((m) => m.kind === 'image' && !used.has(m.id));
    const pick = video ?? photo;
    if (!pick) return { segmentIndex: i, mediaId: null, in: 0, out: len, shortfall: false };
    used.add(pick.id);
    return { segmentIndex: i, mediaId: pick.id, in: 0, out: len, shortfall: false };
  });
}

/** Recompute a slot's shortfall after the user edits trims or swaps. */
export function slotShortfall(slot: SlotMap, raws: MediaItem[]): boolean {
  const m = raws.find((x) => x.id === slot.mediaId);
  if (!m) return false;
  return slot.out - slot.in > mediaDuration(m) + 0.001;
}

/** Build the draft project. Throws an Error naming the first unmapped
 *  segment — the view also disables Build in that state, so this is the
 *  second gate. Beat markers come from the spec; caption text does NOT
 *  (acceptance rule above). */
export function buildProjectFromSpec(
  spec: ReplicateSpec,
  mapping: SlotMap[],
  raws: MediaItem[],
  name = 'Replicated draft',
): Project {
  const unmapped = mapping.find((s) => !s.mediaId);
  if (unmapped) {
    throw new Error(`Segment ${unmapped.segmentIndex + 1} is not mapped to a clip yet — map it before building.`);
  }
  const byId = new Map(raws.map((m) => [m.id, m]));
  const clips: VideoClip[] = [];
  for (const slot of mapping) {
    const seg = spec.segments[slot.segmentIndex];
    const media = byId.get(slot.mediaId!)!;
    const maxDur = mediaDuration(media);
    const out = Math.min(slot.out, Number.isFinite(maxDur) ? Math.max(slot.in + 0.05, maxDur) : slot.out);
    clips.push({
      id: newId('clip'),
      media: media.id,
      start: seg.start,
      in: slot.in,
      out,
      speed: 1,
      muted: false,
      volume: 1,
      transform: { ...DEFAULT_TRANSFORM },
      transitionIn: seg.cutType === 'dissolve' ? 'dissolve' : null,
    });
  }
  return {
    version: 1,
    name,
    canvas: {
      w: spec.width > 0 ? spec.width : 720,
      h: spec.height > 0 ? spec.height : 1280,
      fps: 30,
    },
    media: raws.map((m) => ({ ...m })),
    tracks: [
      { id: newId('trk'), kind: 'video', clips },
      { id: newId('trk'), kind: 'audio', clips: [] },
      { id: newId('trk'), kind: 'text', clips: [] },
    ],
    markers: spec.beats.map((t) => ({ t, label: 'beat', color: '#a8a8a8' })),
  };
}
