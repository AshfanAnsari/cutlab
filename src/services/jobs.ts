// JobService — the seam for background work in the server-first design.
//
// The user's PC only runs the light editor UI. Heavy work (proxy generation,
// thumbnails, waveform analysis, final renders) runs as SERVER JOBS on the
// CutLab server (this VM, Lane B machinery). Components call this interface
// only, never a transport:
//
//   - jobsSupabase.ts (ACTIVE): jobs run against the live Supabase relay —
//     originals upload to the relay bucket, a row lands in cutlab_jobs, the
//     standing worker executes it, results come back over the same relay.
//   - jobsServer.ts (FALLBACK): the M1 file-bundle transport — a .zip the
//     user carries to the server by hand, results loaded back from a file.
//   - jobsLocal.ts: a disabled stub (in-browser engines are not a path).

import type { Project } from '../types';
import type { StoredMedia } from './mediaStore';
import type { ReplicateResult, ReplicateSpec } from './promptJobs';

export interface IngestResult {
  attached: number; // media items that received server results
  missing: string[]; // src names with no results in the pack
  /** D1.3: beat analyses that landed as timeline markers. */
  beats?: { src: string; bpm: number; count: number }[];
}

export interface RemoteProjectInfo {
  id: string;
  name: string;
  updatedAt: string;
}

export interface RenderOptions {
  container: 'mp4' | 'mov';
  codec: 'h264' | 'h265';
  /** Output size preset: canvas | p720 | p1080 | uhd. */
  size: 'canvas' | 'p720' | 'p1080' | 'uhd';
  /** fps override: 0 = canvas fps. */
  fps: number;
  bitrateMode: 'crf' | 'bitrate';
  crf: number;
  bitrateKbps: number;
  /** Export only the I/O range (§D.14 consumer) when both points exist. */
  rangeOnly: boolean;
  /** D2.2: render the 9:16 subject-following cut (needs project.reframe). */
  reframe?: boolean;
  /** D2.3 render polish: temporal denoise strength 0..1 (0 = off). */
  polishDenoise?: number;
  /** D2.3 render polish: film grain amount 0..1 (0 = off). */
  polishGrain?: number;
  /** Extra aspect formats to render from the same project (Q.8). */
  alsoFormats: string[];
  /** Phase 2 (BYOM): who renders — the CutLab server (default) or the
   *  user's own Muse on its machine ('agent'). Stamped on the job
   *  payload as execLane; the server worker never claims agent jobs. */
  target?: 'server' | 'agent';
  /** FIX B1 #9c: the output file name the user typed in Export
   *  (extension optional — the container's is applied). Blank/absent
   *  derives from the project name, as before. Rides the payload as
   *  output.filename and names the download on both lanes. */
  outputName?: string;
}

export interface JobInfo {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  outputPath?: string;
  outputBytes?: number;
  /** D1.3: the job's payload + full result, when the transport has them
   *  (queue rows offer result actions — e.g. Apply for track jobs). */
  payload?: Record<string, unknown>;
  result?: Record<string, unknown>;
  /** Phase 2 (BYOM): execution lane from the payload ('server' when the
   *  payload carries no execLane — every pre-Phase-2 job). */
  execLane?: 'server' | 'agent';
  /** Phase 2: for agent-lane jobs, who claimed it and until when. */
  agentClaim?: { by?: string; leaseUntil?: string };
  /** FIX B1 #14: the worker's own error text for a failed row. */
  error?: string | null;
  /** FIX B1 #14: when the worker claimed the job (running elapsed). */
  claimedAt?: string;
  /** The relay project row this job belongs to, when it has one —
   *  a re-queue keeps the same project link. */
  projectId?: string;
  /** FIX B1 #9c: the output file name recorded on the job payload. */
  outputName?: string;
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  container: 'mp4', codec: 'h264', size: 'canvas', fps: 0,
  bitrateMode: 'crf', crf: 18, bitrateKbps: 12000,
  rangeOnly: false, alsoFormats: [], target: 'server',
};

export interface JobService {
  /** Ask the server for proxies/thumbs/peaks for the project's media.
   *  Live transport: queues a media-analysis job and attaches the results
   *  to the media store before resolving. Fallback: downloads a job bundle. */
  createMediaJobBundle(project: Project, recs: StoredMedia[]): Promise<void>;
  /** Render the project on the server (Lane B).
   *  Live transport: queues a render job; the finished MP4 is handed back
   *  as a download before resolving. Fallback: downloads a job bundle. */
  createRenderJobBundle(project: Project, recs: StoredMedia[], opts?: RenderOptions): Promise<void>;
  /** Recent jobs on the relay for the queue drawer (Q.9); live transport only. */
  listJobs?(): Promise<JobInfo[]>;
  /** Ask the worker to drop a queued job (status flip; worker honours it). */
  cancelJob?(id: string): Promise<void>;
  /** FIX B1 #14: queue the same job again (same type + payload) after a
   *  failure — a fresh row; the failed one stays visible until dismissed
   *  from the queue's local view. */
  requeueJob?(job: JobInfo): Promise<void>;
  /** Re-download a finished render's output (Q.9). */
  downloadJobOutput?(job: JobInfo, projectName: string): Promise<void>;
  /** Attach a server results pack (proxies/thumbs/peaks) to stored media. */
  ingestServerResults(file: File, project: Project): Promise<IngestResult>;

  // --- Relay project persistence (live transport only; optional so the
  // --- bundle fallback stays a valid JobService). The autosave's cloud
  // --- counterpart: the project JSON in cutlab_projects, keyed by a relay
  // --- id the app remembers for the current workspace.
  /** Upsert the project JSON into cutlab_projects; returns the relay id. */
  saveProjectRemote?(project: Project): Promise<string>;
  /** Load a project JSON from cutlab_projects by relay id. */
  loadProjectRemote?(id: string): Promise<Project | null>;
  /** List projects stored on the relay, newest first. */
  listRemoteProjects?(): Promise<RemoteProjectInfo[]>;

  // --- v3 job types (parked-features plan; live transport only) ------------
  /** Prompt edit: queue a prompt_edit job with the project JSON inline;
   *  resolve with the LLM summary + the revised project (validated by the
   *  worker, re-validated by the caller before it is shown). */
  createPromptEditJob?(
    instruction: string,
    project: Project,
    tokenHash?: string,
    onProgress?: (note: string) => void,
  ): Promise<{ summary: string; project: Project; lane?: string }>;
  /** Replicate: upload the reference + raw clips, queue a replicate_analyse
   *  job, resolve with the analysis spec. */
  createReplicateJob?(
    reference: File,
    raws: File[],
    onProgress?: (note: string) => void,
  ): Promise<{ spec: ReplicateSpec; result: ReplicateResult }>;
}
