// Media import — server-first: the browser only probes file metadata
// (duration / dimensions) and persists the original blob to IndexedDB.
// Proxy generation, thumbnails and waveform peaks are SERVER JOBS
// (services/jobsServer.ts + server/make_proxies.py); their results are
// attached back onto these records by ingestServerResults.
import type { MediaItem, MediaKind } from '../types';
import { newId } from '../types';
import { aliasMediaRuntime, mediaStore, registerMedia, type StoredMedia } from './mediaStore';
import { MAX_FILE_BYTES } from './relayAccess';
import { store } from '../state/store';

export type ProxyStatus = 'queued' | 'done' | 'none';
const proxyStatus = new Map<string, ProxyStatus>();
const statusListeners = new Set<() => void>();

export function getProxyStatus(id: string): ProxyStatus {
  return proxyStatus.get(id) ?? 'none';
}
export function subscribeProxyStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
function setProxyStatus(id: string, s: ProxyStatus) {
  proxyStatus.set(id, s);
  for (const fn of statusListeners) fn();
}
/** Called by the job service when server results land for a media item. */
export function noteProxyReady(id: string) {
  setProxyStatus(id, 'done');
}

function kindOf(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  if (/\.(mp4|mov|webm|mkv)$/i.test(file.name)) return 'video';
  if (/\.(mp3|wav|m4a|ogg)$/i.test(file.name)) return 'audio';
  if (/\.(png|jpe?g|webp|gif)$/i.test(file.name)) return 'image';
  return null;
}

async function probe(file: File, kind: MediaKind): Promise<Partial<MediaItem>> {
  const url = URL.createObjectURL(file);
  try {
    if (kind === 'image') {
      const img = new Image();
      // FIX B1 #7: reject with a real Error — the raw DOM Event used to
      // reach the toast and render as "[object Event]".
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('The file appears to be corrupt or unreadable.')); img.src = url; });
      return { width: img.naturalWidth, height: img.naturalHeight, duration: 5 };
    }
    const el = document.createElement(kind === 'video' ? 'video' : 'audio') as HTMLMediaElement;
    el.preload = 'metadata';
    el.src = url;
    await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error('The file appears to be corrupt or unreadable.')); });
    const meta: Partial<MediaItem> = { duration: isFinite(el.duration) ? el.duration : undefined };
    if (kind === 'video') {
      const v = el as HTMLVideoElement;
      meta.width = v.videoWidth;
      meta.height = v.videoHeight;
    }
    return meta;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function kindOfFile(file: File): MediaKind | null {
  return kindOf(file);
}
export async function probeFile(file: File, kind: MediaKind): Promise<Partial<MediaItem>> {
  return probe(file, kind);
}

export async function importFiles(files: File[]): Promise<void> {
  // FIX B1 #8b: media binds BY FILE NAME (a bare project JSON rebinds to
  // bin files with matching names), so a second entry with the same name
  // would make binding ambiguous. The safe behaviour for that model is:
  // keep the first copy, tell the user, skip the duplicate.
  //
  // CROSS-PROJECT ADOPTION (2026-11-06, user report): the duplicate
  // check used to treat "known to the mediaStore" the same as "in this
  // project's bin" — so in a fresh project, importing a file that ANY
  // earlier project had imported was skipped entirely while the toast
  // claimed it was "already in the bin". The bin stayed at 0 and the
  // file was unusable in that project. The two cases are now distinct:
  // a name in the CURRENT project is a true duplicate (skip, as
  // before); a name known only to the store is ADOPTED — the stored
  // copy joins this project's bin. Both sets grow as the batch
  // imports, so a repeat inside one batch is a current-project
  // duplicate by the time it is seen.
  const projectNames = new Set<string>(store.get().project.media.map((m) => m.src));
  const storedByName = new Map<string, StoredMedia>();
  try {
    for (const rec of await mediaStore.all()) {
      if (!storedByName.has(rec.meta.src)) storedByName.set(rec.meta.src, rec);
    }
  } catch { /* store unreadable: the project check above still applies */ }
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) {
      store.toastMsg('error', `Skipped "${file.name}" — not a video, audio or image file.`);
      continue;
    }
    if (projectNames.has(file.name)) {
      store.toastMsg('info', `"${file.name}" is already in the bin — the existing copy is used, so clips keep binding to it.`);
      continue;
    }
    const stored = storedByName.get(file.name);
    if (stored) {
      // ADOPT the stored copy into this project. The runtime is bound
      // under the project entry's id — registerMedia when the stored
      // id is free here; if a different item in this project already
      // holds that id, the entry takes a fresh id and the runtime is
      // aliased under it (bindProjectMedia resolves stored records by
      // name and aliases the same way, so re-binding stays
      // consistent; the stored record itself keeps its own id).
      let meta: MediaItem = { ...stored.meta };
      if (store.get().project.media.some((m) => m.id === meta.id)) {
        meta = { ...stored.meta, id: newId('med') };
        aliasMediaRuntime(meta.id, stored);
      } else {
        registerMedia(stored);
      }
      const adoptedId = meta.id;
      store.commit((draft) => {
        draft.media.push(meta);
      });
      // Honest proxy state: a stored proxy means ready; without one
      // nothing is queued (no job was started by an adoption).
      if (stored.proxyBlob) setProxyStatus(adoptedId, 'done');
      projectNames.add(file.name);
      store.toastMsg('info', `"${file.name}" was already stored in this browser — added to this project's bin.`);
      continue;
    }
    try {
      const id = newId('med');
      const meta: MediaItem = { id, src: file.name, kind, ...(await probe(file, kind)) };
      const rec: StoredMedia = { meta, blob: file };
      await mediaStore.put(rec);
      registerMedia(rec);
      projectNames.add(file.name);
      storedByName.set(file.name, rec);
      store.commit((draft) => {
        draft.media.push(meta);
      });
      // No in-browser processing: proxies/thumbs/peaks arrive via server job.
      setProxyStatus(id, kind === 'video' ? 'queued' : 'none');
      // FIX B1 #8a: over the cloud cap the file still imports and works
      // locally — but say plainly that server jobs cannot take it.
      if (file.size > MAX_FILE_BYTES) {
        store.toastMsg('info', `Imported "${file.name}" (${(file.size / (1024 * 1024)).toFixed(1)} MB) — it works in this browser, but cloud jobs take files up to ${MAX_FILE_BYTES / (1024 * 1024)} MB, so renders and proxies can't use it until it's trimmed or compressed under the cap.`);
      }
    } catch (e) {
      // FIX B1 #7: a probe failure (or any stray DOM Event) reads as a
      // corrupt file, never as "[object Event]".
      if (e instanceof Event || (e instanceof Error && e.message.includes('corrupt or unreadable'))) {
        store.toastMsg('error', `Could not import "${file.name}" — the file appears to be corrupt or unreadable.`);
      } else {
        store.toastMsg('error', `Could not import "${file.name}" — ${e instanceof Error ? e.message : 'something went wrong saving it in this browser.'}`);
      }
    }
  }
}
