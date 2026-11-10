// attachServerResults — the ONE canonical routine that attaches a server
// media-analysis result set (proxy / thumbnail / waveform peaks) onto the
// stored media records, whichever transport produced it:
//
//   - the bundle fallback (jobsServer.ts) feeds it files from a results .zip
//   - the live relay (jobsSupabase.ts) feeds it files from the relay bucket
//
// Keeping this in one place is what makes the two transports interchangeable.

import type { Marker, MediaKind, Project } from '../types';
import type { IngestResult } from './jobs';
import { mediaStore, registerMedia, registerMediaFor, type StoredMedia } from './mediaStore';
import { noteProxyReady } from './importer';
import { store } from '../state/store';

export interface ResultsManifestEntry {
  proxy?: string | null;
  thumb?: string | null;
  peaks?: string | null;
  proxyHasAudio?: boolean;
  /** D1.3(a): beat analysis file (analysis/<stem>.beats.json) or null
   *  with beatsError when the server could not analyse the file. */
  beats?: string | null;
  beatsError?: string;
}

/** One server beat analysis: {bpm, beats: [{t, tier}]} in SOURCE seconds;
 *  tier 1 = downbeat, tier 2 = the remaining beats. */
export interface BeatData {
  bpm: number;
  beats: { t: number; tier: number }[];
}

/** Map one media item's beats onto the timeline spans of the clips that
 *  use it: source time -> clip.start + (t - clip.in) / speed, keeping the
 *  beats inside each clip's source window. Pure — harness-tested. */
export function markersFromBeats(
  clips: { start: number; in: number; out: number; speed?: number }[],
  data: BeatData,
): Marker[] {
  const out: Marker[] = [];
  for (const c of clips) {
    const speed = c.speed && c.speed > 0 ? c.speed : 1;
    for (const b of data.beats) {
      if (b.t < c.in - 1e-9 || b.t > c.out + 1e-9) continue;
      out.push({
        t: Math.round((c.start + (b.t - c.in) / speed) * 1000) / 1000,
        label: b.tier === 1 ? 'Beat 1' : 'Beat 2',
        color: '#a8a8a8',
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface ResultsManifest {
  version?: number;
  items?: Record<string, ResultsManifestEntry>;
}

/** Fetch one file of a results pack by its pack-relative path (or null). */
export type PackFileGetter = (path: string) => Promise<Blob | null>;

/** Stored records keyed by original file name — media identity in CutLab. */
export function recsBySrc(recs: StoredMedia[]) {
  return new Map(recs.map((r) => [r.meta.src, r]));
}

interface ResultPartPaths {
  proxy?: string | null;
  thumb?: string | null;
  peaks?: string | null;
  proxyHasAudio?: boolean;
}

/** Fetch + apply whichever result parts exist onto a copy of `rec`. A null
 *  or missing path means the part does not exist for this asset (audio has
 *  no proxy, images have no peaks). Returns the updated record, or null
 *  when nothing could be fetched. Shared by the pack ingest and the relay
 *  hydration below — one canonical copy of the part logic. */
async function applyResultParts(
  rec: StoredMedia,
  parts: ResultPartPaths,
  getFile: PackFileGetter,
): Promise<StoredMedia | null> {
  const updated: StoredMedia = { ...rec };
  let got = false;
  if (parts.proxy) {
    const pf = await getFile(parts.proxy);
    if (pf) {
      updated.proxyBlob = new Blob([await pf.arrayBuffer()], { type: 'video/mp4' });
      updated.proxyHasAudio = parts.proxyHasAudio ?? true;
      got = true;
    }
  }
  if (parts.thumb) {
    const tf = await getFile(parts.thumb);
    if (tf) {
      updated.thumb = new Blob([await tf.arrayBuffer()], { type: 'image/jpeg' });
      got = true;
    }
  }
  if (parts.peaks) {
    const kf = await getFile(parts.peaks);
    if (kf) {
      try {
        const parsed = JSON.parse(await kf.text()) as number[] | { peaks: number[] };
        updated.peaks = Array.isArray(parsed) ? parsed : parsed.peaks;
        got = true;
      } catch { /* ignore a broken peaks file */ }
    }
  }
  return got ? updated : null;
}

export async function attachServerResults(
  project: Project,
  manifest: ResultsManifest,
  getFile: PackFileGetter,
): Promise<IngestResult> {
  const all = await mediaStore.all();
  const bySrc = recsBySrc(all);
  let attached = 0;
  const missing: string[] = [];
  const beatsByMediaId = new Map<string, BeatData>();
  const beatsInfo: { src: string; bpm: number; count: number }[] = [];
  for (const m of project.media) {
    const rec = bySrc.get(m.src);
    if (!rec) { missing.push(m.src); continue; }
    const stem = m.src.replace(/\.[^.]+$/, '');
    const entry = manifest.items?.[m.src];
    const updated = await applyResultParts(rec, {
      proxy: entry ? entry.proxy : `proxies/${stem}.proxy.mp4`,
      thumb: entry ? entry.thumb : `thumbs/${stem}.thumb.jpg`,
      peaks: entry ? entry.peaks : `analysis/${stem}.peaks.json`,
      proxyHasAudio: entry?.proxyHasAudio,
    }, getFile);
    if (updated) {
      await mediaStore.put(updated);
      registerMedia(updated);
      registerMediaFor(m.id, updated);
      noteProxyReady(rec.meta.id);
      noteProxyReady(m.id);
      attached++;
    } else {
      missing.push(m.src);
    }
    // D1.3(a): a beats file in the pack becomes two-tier timeline
    // markers below (the server only writes one when the file really
    // has audio; a beatsError is reported, never papered over).
    if (entry?.beats) {
      const bf = await getFile(entry.beats);
      if (bf) {
        try {
          const data = JSON.parse(await bf.text()) as BeatData;
          if (data && Array.isArray(data.beats) && data.beats.length) {
            beatsByMediaId.set(m.id, data);
            beatsInfo.push({ src: m.src, bpm: data.bpm, count: data.beats.length });
          }
        } catch { /* a broken beats file attaches nothing */ }
      }
    }
  }
  if (beatsByMediaId.size) {
    // Land the markers on the live project (the commit's draft):
    // replace this media's previous Beat 1/2 markers inside the spans of
    // the clips that use it, then add the fresh grid — one undo step.
    store.commit((draft) => {
      for (const [mediaId, data] of beatsByMediaId) {
        const spans: { start: number; in: number; out: number; speed?: number }[] = [];
        for (const tr of draft.tracks) {
          for (const c of tr.clips) {
            const vc = c as { media?: string; start: number; in?: number; out?: number; speed?: number };
            if (vc.media === mediaId && vc.in !== undefined && vc.out !== undefined) {
              spans.push({ start: c.start, in: vc.in, out: vc.out, speed: vc.speed });
            }
          }
        }
        if (!spans.length) continue;
        const fresh = markersFromBeats(spans, data);
        const lo = Math.min(...spans.map((s) => s.start));
        const hi = Math.max(...spans.map((s) => s.start + (s.out - s.in) / (s.speed && s.speed > 0 ? s.speed : 1)));
        draft.markers = draft.markers.filter((mk) =>
          !((mk.label === 'Beat 1' || mk.label === 'Beat 2') && mk.t >= lo - 1e-6 && mk.t <= hi + 1e-6));
        draft.markers.push(...fresh);
      }
      draft.markers.sort((a, b) => a.t - b.t);
    });
  }
  return { attached, missing, beats: beatsInfo.length ? beatsInfo : undefined };
}

/** One cutlab_media row: where a cloud project's asset parts live on the
 *  relay (full bucket paths, written by the server worker). */
export interface RemoteMediaAsset {
  assetId: string;
  src: string;
  kind: MediaKind;
  inputPath?: string | null;
  proxyPath?: string | null;
  thumbPath?: string | null;
  peaksPath?: string | null;
}

/**
 * Hydrate a cloud project's media from the relay (Open cloud): for every
 * project asset with a cutlab_media row, fetch proxy/thumb/peaks and store
 * + register a record — creating one for assets this browser has never
 * seen, so a Jarvis-authored project opens with its media actually there.
 *
 * Assets whose playable form is the original itself (audio and images have
 * no proxy) get the original downloaded as their local blob. Video
 * originals stay on the relay: the record's blob is a placeholder and it
 * carries a `remoteOriginal` marker, so a later job downloads the real
 * bytes first (jobsSupabase → ensureLocalOriginals).
 *
 * `getFile` resolves FULL bucket paths here (the pack ingest's getter
 * resolves pack-relative paths instead).
 */
export async function attachRemoteProjectMedia(
  project: Project,
  projectId: string,
  assets: RemoteMediaAsset[],
  getFile: PackFileGetter,
): Promise<IngestResult> {
  const all = await mediaStore.all();
  const bySrc = recsBySrc(all);
  const byId = new Map(all.map((r) => [r.meta.id, r]));
  let attached = 0;
  const missing: string[] = [];
  for (const m of project.media) {
    const row = assets.find((a) => a.assetId === m.id) ?? assets.find((a) => a.src === m.src);
    if (!row) { missing.push(m.src); continue; }
    const existing = byId.get(m.id) ?? bySrc.get(m.src);
    // Already fully local (real original + proxy on disk): nothing to do.
    if (existing && !existing.remoteOriginal && existing.proxyBlob) continue;
    const originalPath = row.inputPath ?? `projects/${projectId}/media/${m.src}`;
    const base: StoredMedia = existing ?? {
      meta: { id: m.id, src: m.src, kind: m.kind },
      blob: new Blob([]),
      remoteOriginal: { projectId, path: originalPath },
    };
    let rec = await applyResultParts(base, {
      proxy: row.proxyPath,
      thumb: row.thumbPath,
      peaks: row.peaksPath,
    }, getFile);
    let got = rec !== null;
    rec ??= { ...base };
    if (!row.proxyPath) {
      // No proxy exists for this asset (audio / image): the original is
      // the playable form, so it becomes the local blob right away.
      const of = await getFile(originalPath);
      if (of) {
        rec = { ...rec, blob: new Blob([await of.arrayBuffer()], { type: of.type || 'application/octet-stream' }) };
        delete rec.remoteOriginal;
        got = true;
      }
    }
    if (!got) { missing.push(m.src); continue; }
    await mediaStore.put(rec);
    registerMedia(rec);
    registerMediaFor(m.id, rec);
    noteProxyReady(rec.meta.id);
    noteProxyReady(m.id);
    attached++;
  }
  return { attached, missing };
}
