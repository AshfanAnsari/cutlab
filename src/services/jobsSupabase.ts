// Live JobService implementation: jobs run against the deployed Supabase
// relay (DEPLOYMENT.md Option B, provisioned 2026-11-04).
//
// Flow, for both job types:
//   1. the app generates the job id (uuid) client-side
//   2. originals upload to the private `cutlab` bucket at
//      users/<uid>/jobs/<job_id>/input/<src>   (BEFORE the row is
//      queued — the worker claims fast, and an input that lands late
//      reads as a missing file)
//   3. a row lands in cutlab_jobs with the job.json as `payload`,
//      stamped with the signed-in user's id (RLS owns the rest)
//   4. the standing server worker claims it, executes it (make_proxies.py
//      / Lane B render.py) and writes status + result back to the row
//   5. the app polls the row, then pulls results from
//      jobs/<job_id>/output/… and attaches/downloads them
//
// Result shapes are the deployed contract (supabase/result-examples.json):
//   media-analysis → result = { manifest, outputPrefix }
//   render         → result = { outputs: [{ kind, path, bytes }] }
//
// Project persistence rides the same relay: the project JSON is upserted
// into cutlab_projects; the render worker reads it from there by id.
// Loading a cloud project also hydrates its media: the worker publishes
// proxy/thumb/peaks under projects/<project_id>/… with a cutlab_media row
// per asset, and loadProjectRemote attaches them (attachResults.ts), so a
// Jarvis-authored project opens with its media actually present. Video
// originals stay on the relay until a job needs the bytes
// (ensureLocalOriginals below).

import { DEFAULT_RENDER_OPTIONS } from './jobs';
import { parseRevisedProject } from './revisedProject';
import type { JobInfo, JobService, RemoteProjectInfo, RenderOptions } from './jobs';
import type { PromptEditPayload, ReplicatePayload, ReplicateResult, ReplicateSpec } from './promptJobs';
import type { Clip, Grade, Project, TextClip } from '../types';
import { listLuts } from './luts';
import { uploadedFontFamilies, type StoredFont } from './fonts';
import { mediaStore, registerMedia, registerMediaFor, type StoredMedia } from './mediaStore';
import { serverJobService } from './jobsServer';
import {
  attachRemoteProjectMedia,
  attachServerResults,
  recsBySrc,
  type RemoteMediaAsset,
  type ResultsManifest,
} from './attachResults';
import { assertProjectShape, downloadBlob, normalizeProject } from './projectIO';
import { restInsert, restPatch, restSelect, restUpsert, storageDownload, storageUpload } from './supabase';
import { assertFileCap, jobInputPath, requireUserId } from './relayAccess';
import { idb } from './db';
import { store } from '../state/store';

const MEDIA_TIMEOUT_MS = 10 * 60_000; // proxies: measured ~10-25s server-side
const RENDER_TIMEOUT_MS = 30 * 60_000; // Lane B: ~4.5-6.5 min for 15s@720p
const PROMPT_TIMEOUT_MS = 10 * 60_000; // LLM round-trip + validation
const REPLICATE_TIMEOUT_MS = 15 * 60_000; // cuts + beats + transcription
const RELAY_SLOT_KEY = 'relayProject';

/** Relay job id (also used by analysisJobs.ts — one canonical copy). */
export function relayUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  // Fallback for non-secure contexts: RFC 4122 v4 from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function safeName(name: string) {
  return name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'cutlab';
}

/** FIX B1 #9c: the download file name for a render — the name the user
 *  typed in Export (any extension they added is replaced by the
 *  container's), or the historic <Project>_render.<ext> default. */
export function renderOutputName(projectName: string, opts?: RenderOptions): string {
  const ext = (opts?.container ?? 'mp4') === 'mov' ? 'mov' : 'mp4';
  const typed = (opts?.outputName ?? '').trim().replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').replace(/\.(mp4|mov)$/i, '');
  return `${typed || `${safeName(projectName)}_render`}.${ext}`;
}

export interface RelayJobRow {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  result: Record<string, unknown> | null;
  error: string | null;
}

/** Poll a job row until the worker finishes it. Throws with the worker's
 *  own error text when the job fails, or a timeout message. */
export async function waitForRelayJob(
  jobId: string,
  opts: { pollMs: number; timeoutMs: number; onStatus?: (s: RelayJobRow['status']) => void },
): Promise<RelayJobRow> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: RelayJobRow['status'] | undefined;
  for (;;) {
    const rows = await restSelect<RelayJobRow>(
      `/rest/v1/cutlab_jobs?id=eq.${jobId}&select=id,status,result,error`,
    );
    const row = rows[0];
    if (!row) throw new Error('The job vanished from the relay queue.');
    if (row.status !== last) {
      last = row.status;
      opts.onStatus?.(row.status);
    }
    if (row.status === 'done') return row;
    if (row.status === 'failed') {
      throw new Error(`Server job failed — ${row.error ?? 'no error detail recorded'}`);
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the server job. It may still finish on the server; check again later.');
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

/** Records hydrated from a cloud project may hold no original bytes —
 *  the file lives only on the relay (see StoredMedia.remoteOriginal) and
 *  cannot feed a job upload. Download those originals into the local
 *  store first; the returned records carry real blobs and the remote
 *  marker is cleared, so the original stays local from then on. Throws a
 *  friendly error naming the file when a download fails. */
export async function ensureLocalOriginals(project: Project, recs: StoredMedia[]): Promise<StoredMedia[]> {
  const bySrc = recsBySrc(recs);
  const out = [...recs];
  for (const m of project.media) {
    const rec = bySrc.get(m.src);
    if (!rec?.remoteOriginal) continue;
    store.toastMsg('info', `Fetching ${m.src} from the relay — its original lives only in the cloud project…`);
    let blob: Blob;
    try {
      blob = await storageDownload(rec.remoteOriginal.path);
    } catch {
      throw new Error(`Could not download ${m.src} from the relay — this job needs the original file. Check the connection and try again.`);
    }
    const updated: StoredMedia = {
      ...rec,
      blob: new Blob([await blob.arrayBuffer()], { type: blob.type || rec.blob.type }),
    };
    delete updated.remoteOriginal;
    await mediaStore.put(updated);
    registerMedia(updated);
    registerMediaFor(m.id, updated);
    const i = out.indexOf(rec);
    if (i >= 0) out[i] = updated;
    bySrc.set(m.src, updated);
  }
  return out;
}

/** Upload every project original the relay needs for one job, into the
 *  signed-in user's scope. Fails fast (before anything is queued) when
 *  a file is not in the local bin or exceeds the per-file cap. */
async function uploadInputs(uid: string, jobId: string, project: Project, recs: StoredMedia[]): Promise<void> {
  const bySrc = recsBySrc(recs);
  const missing = project.media.filter((m) => !bySrc.has(m.src)).map((m) => m.src);
  if (missing.length) {
    throw new Error(`These media files are not in the bin — import them first: ${missing.join(', ')}`);
  }
  for (const m of project.media) {
    const rec = bySrc.get(m.src)!;
    assertFileCap(rec.blob.size, m.src);
    await storageUpload(jobInputPath(uid, jobId, m.src), rec.blob);
  }
}

// ---------------------------------------------------------------------------
// Relay project persistence
// ---------------------------------------------------------------------------

interface RelaySlot { id: string; name: string }

async function readRelaySlot(): Promise<RelaySlot | null> {
  try {
    return (await idb.get<RelaySlot>('kv', RELAY_SLOT_KEY)) ?? null;
  } catch {
    return null;
  }
}

/** Forget which relay row the current workspace saves to (New / Open file). */
export async function clearRelayProjectSlot(): Promise<void> {
  try { await idb.del('kv', RELAY_SLOT_KEY); } catch { /* local only */ }
}

/** Point the workspace's relay slot at a row loaded from the relay, so the
 *  next Cloud save updates that same project instead of creating a copy. */
export async function setRelayProjectSlot(id: string, name: string): Promise<void> {
  try { await idb.set('kv', RELAY_SLOT_KEY, { id, name } satisfies RelaySlot); } catch { /* local only */ }
}

async function saveProjectRemote(project: Project): Promise<string> {
  const uid = requireUserId('save projects to the cloud');
  const slot = await readRelaySlot();
  const id = slot?.id ?? relayUuid();
  await restUpsert('cutlab_projects', {
    id,
    user_id: uid,
    name: project.name,
    project,
    updated_at: new Date().toISOString(),
  }, 'id');
  try { await idb.set('kv', RELAY_SLOT_KEY, { id, name: project.name } satisfies RelaySlot); } catch { /* local only */ }
  return id;
}

async function loadProjectRemote(id: string): Promise<Project | null> {
  requireUserId('open cloud projects');
  const rows = await restSelect<{ project: Project }>(
    `/rest/v1/cutlab_projects?id=eq.${id}&select=project`,
  );
  if (!rows.length) return null;
  assertProjectShape(rows[0].project);
  const project = normalizeProject(rows[0].project);
  // Hydrate the project's media from the relay: a cloud project carries
  // its assets with it (cutlab_media rows + project-scoped proxy/thumb/
  // peaks in the bucket), so opening one in a fresh browser still binds
  // every file. A hydration failure must not sink the load itself — the
  // project's missing-media report names anything left unbound.
  try {
    const mediaRows = await restSelect<{
      asset_id: string;
      src: string;
      kind: RemoteMediaAsset['kind'];
      input_path: string | null;
      proxy_path: string | null;
      thumb_path: string | null;
      peaks_path: string | null;
    }>(`/rest/v1/cutlab_media?project_id=eq.${id}&select=asset_id,src,kind,input_path,proxy_path,thumb_path,peaks_path`);
    if (mediaRows.length) {
      const getFile = async (path: string): Promise<Blob | null> => {
        try { return await storageDownload(path); } catch { return null; }
      };
      await attachRemoteProjectMedia(project, id, mediaRows.map((r) => ({
        assetId: r.asset_id,
        src: r.src,
        kind: r.kind,
        inputPath: r.input_path,
        proxyPath: r.proxy_path,
        thumbPath: r.thumb_path,
        peaksPath: r.peaks_path,
      })), getFile);
    }
  } catch (e) {
    console.warn('CutLab cloud media hydration failed:', e);
  }
  return project;
}

async function listRemoteProjects(): Promise<RemoteProjectInfo[]> {
  requireUserId('browse cloud projects');
  const rows = await restSelect<{ id: string; name: string; updated_at: string }>(
    '/rest/v1/cutlab_projects?select=id,name,updated_at&order=updated_at.desc&limit=50',
  );
  return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at }));
}

/**
 * D1.3(d): bundle the project's uploaded fonts + LUTs with a render job.
 * Uploads each used asset to the job's input slot and returns the file
 * names for the payload's bundledAssets — the worker drops them into the
 * render's media dir, where Lane B's FontRegistry (walks the dir, reads
 * the family from the file) and resolve_lut (<lutId>.cube) pick them up.
 * Only assets the project actually uses are sent.
 */
async function uploadBundledAssets(uid: string, jobId: string, project: Project): Promise<string[]> {
  const names: string[] = [];
  const lutIds = new Set<string>();
  const takeGrade = (g?: Grade) => { if (g?.lutId) lutIds.add(g.lutId); };
  const walkClips = (clips: Clip[]) => {
    for (const c of clips) {
      const holder = c as { grade?: Grade; grades?: Grade[]; nest?: { tracks: { clips: Clip[] }[] } };
      takeGrade(holder.grade);
      for (const g of holder.grades ?? []) takeGrade(g);
      if (holder.nest) for (const t of holder.nest.tracks) walkClips(t.clips);
    }
  };
  takeGrade(project.look);
  for (const t of project.tracks) walkClips(t.clips);
  for (const id of lutIds) {
    const lut = listLuts().find((l) => l.id === id);
    if (!lut) continue; // named but not in this browser's library: Lane B logs + skips, as before
    const name = `${id}.cube`;
    await storageUpload(jobInputPath(uid, jobId, name), new Blob([lut.text], { type: 'text/plain' }));
    names.push(name);
  }
  const usedFamilies = new Set<string>();
  const walkText = (clips: Clip[]) => {
    for (const c of clips) {
      const tc = c as TextClip & { nest?: { tracks: { clips: Clip[] }[] } };
      if (typeof tc.fontFamily === 'string' && tc.fontFamily) {
        const first = tc.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
        if (first) usedFamilies.add(first);
      }
      if (tc.nest) for (const t of tc.nest.tracks) walkText(t.clips);
    }
  };
  for (const t of project.tracks) walkText(t.clips);
  const uploaded = uploadedFontFamilies();
  for (const fam of usedFamilies) {
    if (!uploaded.includes(fam)) continue;
    const rec = await idb.get<StoredFont>('fonts', fam).catch(() => undefined);
    if (!rec) continue;
    const safe = fam.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'font';
    const name = `${safe}.${rec.ext ?? 'ttf'}`;
    await storageUpload(jobInputPath(uid, jobId, name), rec.blob);
    names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The live JobService
// ---------------------------------------------------------------------------

export const supabaseJobService: JobService = {
  async createMediaJobBundle(project, recs) {
    try {
      const uid = requireUserId('run media jobs on the server');
      const jobId = relayUuid();
      const localRecs = await ensureLocalOriginals(project, recs);
      store.toastMsg('info', 'Uploading originals to the relay…');
      await uploadInputs(uid, jobId, project, localRecs);
      const payload = {
        version: 1, type: 'media-analysis', createdAt: new Date().toISOString(),
        fps: project.canvas.fps,
        items: project.media.map((m) => ({
          id: m.id,
          src: m.src,
          kind: m.kind,
          requests: m.kind === 'image' ? ['thumbnail'] : ['proxy', 'thumbnail', 'peaks', 'beats'],
        })),
      };
      // Once the workspace has a cloud id, tag the job with it so the
      // worker also publishes the results into the project's own scope
      // (invisible to the user; jobs without a cloud id behave as before).
      const slot = await readRelaySlot();
      await restInsert('cutlab_jobs', {
        id: jobId, type: 'media-analysis', status: 'queued', payload, user_id: uid,
        ...(slot ? { project_id: slot.id } : {}),
      });
      store.toastMsg('info', 'Media job queued on the server — making proxies…');
      const row = await waitForRelayJob(jobId, {
        pollMs: 2500, timeoutMs: MEDIA_TIMEOUT_MS,
        onStatus: (s) => {
          if (s === 'running') store.toastMsg('info', 'Server is making proxies, thumbnails and waveforms…');
        },
      });
      const result = (row.result ?? {}) as { manifest?: ResultsManifest; outputPrefix?: string };
      if (!result.manifest || !result.outputPrefix) {
        throw new Error('The job finished but returned no results manifest.');
      }
      const prefix = result.outputPrefix;
      const getFile = async (rel: string): Promise<Blob | null> => {
        try { return await storageDownload(prefix + rel); } catch { return null; }
      };
      const { attached, beats } = await attachServerResults(project, result.manifest, getFile);
      store.toastMsg('info', attached
        ? `Server results attached to ${attached} media item(s) — preview now uses the server proxies.`
        : 'The server job finished but no results matched this project’s media.');
      for (const b of beats ?? []) {
        store.toastMsg('info', `Beat markers added from ${b.src} — ${b.bpm.toFixed(2)} BPM, ${b.count} beats (Beat 1 = downbeat).`);
      }
    } catch (e) {
      store.toastMsg('error', e instanceof Error ? e.message : String(e));
    }
  },

  async createRenderJobBundle(project, recs, opts?: RenderOptions) {
    try {
      // FIX B1 #9a backstop: an empty timeline must never queue, even if
      // a caller bypasses the dialog's disabled Render button.
      const clipCount = project.tracks.reduce((n, t) => n + t.clips.length, 0);
      if (clipCount === 0) {
        throw new Error('Add a clip to the timeline first — there is nothing to render yet.');
      }
      const o = opts ?? DEFAULT_RENDER_OPTIONS;
      // FIX B1 #16: the sign-in refusal names the lane actually chosen.
      const uid = o.target === 'agent'
        ? requireUserId('queue a render for your Muse')
        : requireUserId('render on the server');
      store.toastMsg('info', 'Saving the project to the relay…');
      const projectId = await saveProjectRemote(project);
      const jobId = relayUuid();
      const localRecs = await ensureLocalOriginals(project, recs);
      store.toastMsg('info', 'Uploading originals to the relay…');
      await uploadInputs(uid, jobId, project, localRecs);
      // D1.3(d): the project's uploaded fonts + LUTs ride the same slot.
      const bundledAssets = await uploadBundledAssets(uid, jobId, project);
      const payload = {
        version: 1, type: 'render', lane: 'B', createdAt: new Date().toISOString(),
        // Phase 2 (BYOM): agent-lane jobs are stamped execLane:'agent' —
        // the server worker skips them; the user's own Muse claims and
        // renders them via the cutlab-mcp connector. Server jobs carry
        // no key at all (the historic payload shape).
        ...(o.target === 'agent' ? { execLane: 'agent' } : {}),
        ...(bundledAssets.length ? { bundledAssets } : {}),
        // D2.2: the smoothed subject path rides the render job.
        ...(o.reframe && project.reframe ? { reframe: { points: project.reframe.points } } : {}),
        output: {
          container: o.container, codec: o.codec, size: o.size,
          // FIX B1 #9c: the user's chosen output name rides the payload;
          // the queue download (either lane) uses it verbatim.
          filename: renderOutputName(project.name, o),
          fps: o.fps > 0 ? o.fps : project.canvas.fps,
          ...(o.bitrateMode === 'crf' ? { crf: o.crf } : { bitrateKbps: o.bitrateKbps }),
          color: 'bt709', stripMetadata: true,
          ...(o.rangeOnly && project.rangeIn != null && project.rangeOut != null
            ? { range: { in: project.rangeIn, out: project.rangeOut } }
            : {}),
          ...(o.alsoFormats.length > 0 ? { alsoFormats: o.alsoFormats } : {}),
          // Phase 3 delivery (UPGRADE-PLAN §4): the loudness preset and
          // the GIF companion ride the payload's output object — render.py
          // reads both; absent = historic behaviour. ExportPanel passes
          // them on its widened DeliveryRenderOptions type.
          ...((o as { loudness?: string }).loudness
            ? { loudness: (o as { loudness?: string }).loudness }
            : {}),
          ...((o as { gif?: boolean }).gif ? { gif: true } : {}),
          // D2.3 render polish (Lane B encode stage).
          ...((o.polishDenoise || o.polishGrain)
            ? { polish: { denoise: o.polishDenoise ?? 0, grain: o.polishGrain ?? 0 } }
            : {}),
          // §K bus settings ride the render job (loudnorm/compressor are Lane B's).
          audio: {
            normalise: project.audioBus?.normalise ?? true,
            masterGain: project.audioBus?.masterGain ?? 1,
            compressor: project.audioBus?.compEnabled ?? false,
          },
        },
        command: 'python3 server/render_job.py <this-bundle.zip> --out render.mp4',
      };
      await restInsert('cutlab_jobs', {
        id: jobId, type: 'render', status: 'queued', project_id: projectId, payload, user_id: uid,
      });
      if (o.target === 'agent') {
        // BYOM: do NOT wait on the row — the user's Muse picks the job
        // up whenever it is next asked. The queue drawer shows its
        // agent-lane state; the finished MP4 lands there for download.
        store.toastMsg('info', 'Queued for your Muse. In your Muse, say: “Render my waiting CutLab job” — it renders on its machine and the MP4 lands in the queue below.');
        return;
      }
      store.toastMsg('info', 'Render job queued on the server…');
      const row = await waitForRelayJob(jobId, {
        pollMs: 5000, timeoutMs: RENDER_TIMEOUT_MS,
        onStatus: (s) => {
          if (s === 'running') store.toastMsg('info', 'Server is rendering… this takes a few minutes for a Short.');
        },
      });
      const result = (row.result ?? {}) as { outputs?: { kind: string; path: string; bytes: number }[] };
      const out = result.outputs?.[0];
      if (!out?.path) throw new Error('The render finished but reported no output file.');
      const blob = await storageDownload(out.path);
      downloadBlob(new Blob([await blob.arrayBuffer()], { type: 'video/mp4' }), renderOutputName(project.name, o));
      store.toastMsg('info', `Render finished on the server — MP4 downloaded (${(out.bytes / 1_000_000).toFixed(1)} MB).`);
    } catch (e) {
      store.toastMsg('error', e instanceof Error ? e.message : String(e));
    }
  },

  async listJobs(): Promise<JobInfo[]> {
    const rows = await restSelect<{ id: string; type: string; status: string; created_at: string; claimed_at?: string | null; project_id?: string | null; error?: string | null; payload?: Record<string, unknown> & { output?: { filename?: string } }; result?: { outputs?: { path: string; bytes: number }[] } }>(
      '/rest/v1/cutlab_jobs?select=id,type,status,created_at,claimed_at,project_id,error,payload,result&order=created_at.desc&limit=20',
    );
    return rows.map((r) => ({
      id: r.id, type: r.type, status: r.status, createdAt: r.created_at,
      outputPath: r.result?.outputs?.[0]?.path,
      outputBytes: r.result?.outputs?.[0]?.bytes,
      // D1.3: payload + full result ride along so job rows can offer
      // result actions (a finished track job's Apply button needs both).
      payload: r.payload,
      result: r.result as Record<string, unknown> | undefined,
      // Phase 2 (BYOM): lane + claim state for the drawer's agent rows.
      execLane: (r.payload?.execLane === 'agent' ? 'agent' : 'server') as 'server' | 'agent',
      agentClaim: (r.payload?.agentClaim as { by?: string; leaseUntil?: string } | undefined) ?? undefined,
      // FIX B1 #14: failure text + claim time for the queue rows.
      error: r.error ?? null,
      claimedAt: r.claimed_at ?? undefined,
      projectId: r.project_id ?? undefined,
      outputName: typeof r.payload?.output?.filename === 'string' ? r.payload.output.filename : undefined,
    }));
  },

  async cancelJob(id: string): Promise<void> {
    // FIX B1 #1: restPatch takes a full PostgREST path — the missing
    // /rest/v1/ prefix sent the PATCH to a non-existent URL, so Cancel
    // silently did nothing (the caller swallowed the failure too).
    await restPatch(`/rest/v1/cutlab_jobs?id=eq.${id}`, { status: 'cancelled' });
  },

  /** FIX B1 #14: re-queue the same job (same type + payload) as a fresh
   *  row under the signed-in account. */
  async requeueJob(job: JobInfo): Promise<void> {
    const uid = job.execLane === 'agent'
      ? requireUserId('queue a render for your Muse')
      : requireUserId('run jobs on the server');
    if (!job.payload) throw new Error('That job has no saved settings to retry with.');
    await restInsert('cutlab_jobs', {
      id: relayUuid(), type: job.type, status: 'queued', payload: job.payload, user_id: uid,
      ...(job.projectId ? { project_id: job.projectId } : {}),
    });
  },

  async downloadJobOutput(job: JobInfo, projectName: string): Promise<void> {
    if (!job.outputPath) throw new Error('That job has no output file recorded.');
    const blob = await storageDownload(job.outputPath);
    downloadBlob(new Blob([await blob.arrayBuffer()], { type: 'video/mp4' }), job.outputName || `${safeName(projectName)}_render.mp4`);
  },

  // Manual results packs still belong to the bundle transport; delegate so
  // there is exactly one zip-ingest implementation.
  ingestServerResults: (file, project) => serverJobService.ingestServerResults(file, project),

  // ---- v3: prompt editing (parked-features plan, Feature 1) --------------
  // The project JSON rides inline in the payload — no media upload. The
  // worker runs the LLM lane, validates the reply against the project
  // schema, and writes revised.json; anything invalid fails the job, so a
  // resolved promise here always carries an on-schema project. Until the
  // jobs-v3 migration runs, the insert itself is rejected by the relay's
  // type CHECK and this throws — the Prompt tab shows its error state and
  // nothing changes (the plan's deploy-order contract).
  async createPromptEditJob(instruction, project, tokenHash, onProgress) {
    const uid = requireUserId('use prompt editing');
    const jobId = relayUuid();
    const payload: PromptEditPayload = {
      version: 1,
      type: 'prompt_edit',
      instruction,
      project,
      ...(tokenHash ? { tokenHash } : {}),
    };
    await restInsert('cutlab_jobs', {
      id: jobId, type: 'prompt_edit', status: 'queued', payload, user_id: uid,
    });
    onProgress?.('Edit queued — the assistant is working on it…');
    const row = await waitForRelayJob(jobId, {
      pollMs: 2500, timeoutMs: PROMPT_TIMEOUT_MS,
      onStatus: (s) => {
        if (s === 'running') onProgress?.('Working on your edit…');
      },
    });
    const result = (row.result ?? {}) as { summary?: string; revised?: string; lane?: string };
    if (!result.revised) throw new Error('The edit job finished but returned no revised project.');
    const blob = await storageDownload(result.revised);
    let revised: Project;
    try {
      revised = parseRevisedProject(await blob.text());
    } catch {
      throw new Error('The revised project that came back was not readable JSON.');
    }
    return { summary: result.summary ?? '', project: revised, lane: result.lane };
  },

  // ---- v3: replicate an edit (parked-features plan, Feature 2) -----------
  async createReplicateJob(reference, raws, onProgress) {
    const uid = requireUserId('use replicate-an-edit');
    const jobId = relayUuid();
    assertFileCap(reference.size, reference.name);
    const refPath = jobInputPath(uid, jobId, `reference_${safeName(reference.name)}`);
    const rawPaths: string[] = [];
    onProgress?.('Uploading the reference and your clips…');
    await storageUpload(refPath, reference);
    for (const f of raws) {
      assertFileCap(f.size, f.name);
      const p = jobInputPath(uid, jobId, `raw_${safeName(f.name)}`);
      await storageUpload(p, f);
      rawPaths.push(p);
    }
    const payload: ReplicatePayload = {
      version: 1, type: 'replicate_analyse', reference: refPath, raws: rawPaths,
    };
    await restInsert('cutlab_jobs', {
      id: jobId, type: 'replicate_analyse', status: 'queued', payload, user_id: uid,
    });
    onProgress?.('Analysis queued on the server…');
    const row = await waitForRelayJob(jobId, {
      pollMs: 3000, timeoutMs: REPLICATE_TIMEOUT_MS,
      onStatus: (s) => {
        if (s === 'running') onProgress?.('Analysing cuts, beats and captions…');
      },
    });
    const result = (row.result ?? {}) as unknown as ReplicateResult;
    if (!result.spec) throw new Error('The analysis finished but returned no spec.');
    const blob = await storageDownload(result.spec);
    let spec: ReplicateSpec;
    try {
      spec = JSON.parse(await blob.text()) as ReplicateSpec;
    } catch {
      throw new Error('The analysis spec that came back was not readable JSON.');
    }
    return { spec, result };
  },

  saveProjectRemote,
  loadProjectRemote,
  listRemoteProjects,
};

export const jobService: JobService = supabaseJobService;
