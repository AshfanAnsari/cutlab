// MediaStore interface — the persistence seam for media blobs, proxies and
// thumbnails. Milestone 1 implementation: IndexedDB (local). A future backend
// implements the same interface; components never touch storage directly.
import type { MediaItem } from '../types';
import { idb } from './db';

/** Where a media original lives when it is NOT in this browser: on the
 *  relay, under the owning project's prefix (Jarvis-authored projects). */
export interface RemoteOriginalRef {
  projectId: string;
  path: string; // bucket path: projects/<project_id>/media/<src>
}

export interface StoredMedia {
  meta: MediaItem;
  blob: Blob;
  proxyBlob?: Blob;
  proxyHasAudio?: boolean;
  peaks?: number[]; // real waveform peaks (0..1), ~240 samples
  thumb?: Blob; // poster frame for video/image
  /** Set when the original bytes are not stored locally (relay-hydrated
   *  record): `blob` is then an empty placeholder, preview runs on the
   *  proxy, and any job needing the real bytes downloads the original
   *  first (jobsSupabase → ensureLocalOriginals), which clears this. */
  remoteOriginal?: RemoteOriginalRef;
}

export interface MediaStore {
  put(rec: StoredMedia): Promise<void>;
  get(id: string): Promise<StoredMedia | undefined>;
  all(): Promise<StoredMedia[]>;
  remove(id: string): Promise<void>;
}

export const localMediaStore: MediaStore = {
  async put(rec) {
    await idb.set('media', rec.meta.id, rec);
  },
  async get(id) {
    try {
      return await idb.get<StoredMedia>('media', id);
    } catch {
      return undefined;
    }
  },
  async all() {
    try {
      const keys = await idb.keys('media');
      const out: StoredMedia[] = [];
      for (const k of keys) {
        const r = await idb.get<StoredMedia>('media', k);
        if (r) out.push(r);
      }
      return out;
    } catch {
      return [];
    }
  },
  async remove(id) {
    await idb.del('media', id);
  },
};

export const mediaStore: MediaStore = localMediaStore;

// ---- runtime registry: object URLs for the current session ----
export interface MediaRuntime {
  url: string;
  proxyUrl?: string;
  thumbUrl?: string;
  peaks?: number[];
  proxyHasAudio?: boolean;
}

const runtime = new Map<string, MediaRuntime>();

/** (Re)bind a stored record's blobs under an arbitrary runtime id. */
export function registerMediaFor(id: string, rec: StoredMedia): MediaRuntime {
  const old = runtime.get(id);
  if (old) {
    URL.revokeObjectURL(old.url);
    if (old.proxyUrl) URL.revokeObjectURL(old.proxyUrl);
    if (old.thumbUrl) URL.revokeObjectURL(old.thumbUrl);
  }
  const rt: MediaRuntime = {
    url: URL.createObjectURL(rec.blob),
    proxyUrl: rec.proxyBlob ? URL.createObjectURL(rec.proxyBlob) : undefined,
    thumbUrl: rec.thumb ? URL.createObjectURL(rec.thumb) : undefined,
    peaks: rec.peaks,
    proxyHasAudio: rec.proxyHasAudio,
  };
  runtime.set(id, rt);
  return rt;
}

export function registerMedia(rec: StoredMedia): MediaRuntime {
  return registerMediaFor(rec.meta.id, rec);
}

export function getMediaRuntime(id: string): MediaRuntime | undefined {
  return runtime.get(id);
}

/** Register a stored record under an additional id (project files carry their
 * own media ids; binding matches by file name). Creates fresh object URLs. */
export function aliasMediaRuntime(id: string, rec: StoredMedia) {
  if (runtime.has(id)) return;
  runtime.set(id, {
    url: URL.createObjectURL(rec.blob),
    proxyUrl: rec.proxyBlob ? URL.createObjectURL(rec.proxyBlob) : undefined,
    thumbUrl: rec.thumb ? URL.createObjectURL(rec.thumb) : undefined,
    peaks: rec.peaks,
    proxyHasAudio: rec.proxyHasAudio,
  });
}

/** Preview quality (D2.6): which source the stage plays.
 *  'proxy' (default) = the lightweight proxy when one exists;
 *  'half' = proxy + the media element laid out at half size and
 *  CSS-scaled up (decode raster halves — the layers honour it);
 *  'original' = the full-res original bytes. Persisted per user. */
export type PreviewQuality = 'proxy' | 'half' | 'original';
let previewQuality: PreviewQuality = (() => {
  try {
    const v = localStorage.getItem('cutlab.previewQuality');
    return v === 'half' || v === 'original' ? v : 'proxy';
  } catch { return 'proxy'; }
})();
const qualitySubs = new Set<() => void>();
export function getPreviewQuality(): PreviewQuality { return previewQuality; }
export function setPreviewQuality(q: PreviewQuality): void {
  previewQuality = q;
  try { localStorage.setItem('cutlab.previewQuality', q); } catch { /* ignore */ }
  qualitySubs.forEach((fn) => fn());
}
export function subscribePreviewQuality(fn: () => void): () => void {
  qualitySubs.add(fn);
  return () => { qualitySubs.delete(fn); };
}
/** The stage URL for a runtime under the current quality setting. */
export function pickRuntimeUrl(rt: MediaRuntime): string {
  return previewQuality === 'original' ? rt.url : (rt.proxyUrl ?? rt.url);
}

/** R7 (UI redesign W2): like pickRuntimeUrl, but also reports whether the
 *  user asked for a proxy-grade source while none exists yet — the stage
 *  silently serves the original in that case, and the viewer strip shows
 *  a badge so the fallback is never invisible. */
export function pickRuntimeUrlInfo(rt: MediaRuntime): { url: string; fellBack: boolean } {
  return {
    url: pickRuntimeUrl(rt),
    fellBack: previewQuality !== 'original' && !rt.proxyUrl,
  };
}

/** Find a stored record for a project media entry: by id, else by file name. */
export function findStoredFor(all: StoredMedia[], mediaId: string, src: string): StoredMedia | undefined {
  return all.find((r) => r.meta.id === mediaId) ?? all.find((r) => r.meta.src === src);
}

export function unregisterMedia(id: string) {
  const old = runtime.get(id);
  if (old) {
    URL.revokeObjectURL(old.url);
    if (old.proxyUrl) URL.revokeObjectURL(old.proxyUrl);
    if (old.thumbUrl) URL.revokeObjectURL(old.thumbUrl);
  }
  runtime.delete(id);
}
