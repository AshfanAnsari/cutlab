// CutLab MCP connector — "Bring Your Own Muse" (Phase 2, PLAN-PHASE2-BYOM.md)
//
// A minimal MCP streamable-HTTP endpoint (JSON-RPC 2.0 over POST) that
// lets a user's OWN agent (Muse or any MCP client) render that user's
// CutLab jobs on the agent's machine:
//
//   list_my_projects · get_project · get_media_links
//   list_waiting_render_jobs · claim_render_job (lease)
//   complete_render_job · fail_render_job
//
// Auth: the caller's CutLab connect token (`clt_…`) as a Bearer token
// (or `x-cutlab-token` header). Only its SHA-256 hash is ever looked up
// (cutlab_tokens, the BYO registry the app already maintains); the row's
// user_id scopes EVERY query below. A token only ever sees its own
// account's projects, jobs and storage scope — there is no parameter
// that widens that.
//
// All data access goes through PostgREST / Storage with the service key
// from this function's environment (SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY are injected by the platform). This function
// must be deployed with "Verify JWT" OFF — the gateway's JWT check would
// reject the connect token before this code runs; auth lives here.
//
// Storage paths mirror server/worker.py exactly:
//   inputs : users/<uid>/jobs/<job_id>/input/<src>
//   project media (fallback): users/<uid>/projects/<pid>/media/<src>,
//                             projects/<pid>/media/<src> (legacy)
//   outputs: users/<uid>/jobs/<job_id>/output/<file>
// and the render result shape mirrors the worker's:
//   result = { outputs: [{ kind, path, bytes, format? }] }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "cutlab";
const LEASE_SECONDS = 3600; // matches the server worker's render budget
const SIGN_SECONDS = 3600;

// Account guard (beta): non-owner accounts are capped at PROJECT_LIMIT
// projects — free-tier relay protection (2026-11-09: the owner runs the
// product personally and is exempt; the guard stays for future beta users).
const PROJECT_LIMIT = 2;
const OWNER_USER_ID = ""; // set to the owner account's Supabase Auth user id (empty = no exemption)
const projectLimitFor = (caller: Caller): number =>
  caller.userId === OWNER_USER_ID ? Number.POSITIVE_INFINITY : PROJECT_LIMIT;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface Caller { userId: string; tokenHash: string; label: string | null }

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function restJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await rest(path, init);
  if (!r.ok) throw new Error(`relay ${init.method ?? "GET"} ${path.split("?")[0]} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

async function storageJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error(`storage ${path.split("?")[0]} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return (await r.json()) as T;
}

async function authenticate(req: Request): Promise<Caller> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : (req.headers.get("x-cutlab-token") ?? "").trim();
  if (!token.startsWith("clt_")) throw new HttpError(401, "missing or malformed CutLab connect token (expected a clt_… bearer token)");
  const tokenHash = await sha256Hex(token);
  const rows = await restJson<{ user_id: string | null; revoked_at: string | null; label: string | null }[]>(
    `cutlab_tokens?token_hash=eq.${tokenHash}&select=user_id,revoked_at,label&limit=1`,
  );
  if (!rows.length) throw new HttpError(401, "connect token not recognised by the relay");
  if (rows[0].revoked_at) throw new HttpError(401, "connect token has been revoked");
  if (!rows[0].user_id) throw new HttpError(401, "connect token is not scoped to an account yet — open CutLab, sign in, and re-register the token");
  return { userId: rows[0].user_id, tokenHash, label: rows[0].label };
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const nowIso = () => new Date().toISOString();
const inputPrefix = (uid: string, jobId: string) => `users/${uid}/jobs/${jobId}/input`;
const outputPrefix = (uid: string, jobId: string) => `users/${uid}/jobs/${jobId}/output`;

interface JobRow {
  id: string; type: string; status: string; project_id: string | null;
  user_id: string | null; payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null; created_at: string;
}

const execLane = (job: JobRow) => (job.payload?.execLane as string) || "server";

async function getOwnJob(caller: Caller, jobId: string): Promise<JobRow> {
  const rows = await restJson<JobRow[]>(
    `cutlab_jobs?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${caller.userId}&select=*&limit=1`,
  );
  if (!rows.length) throw new Error("job not found (it does not exist, or it belongs to a different account)");
  return rows[0];
}

async function getProjectRow(caller: Caller, projectId: string): Promise<{ project: Record<string, unknown> }> {
  const rows = await restJson<{ project: Record<string, unknown> }[]>(
    `cutlab_projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${caller.userId}&select=project&limit=1`,
  );
  if (!rows.length) throw new Error("project not found (it does not exist, or it belongs to a different account)");
  return rows[0];
}

async function signDownload(path: string): Promise<string> {
  const r = await storageJson<{ signedURL: string }>(`object/sign/${BUCKET}/${path}`, {
    method: "POST", body: JSON.stringify({ expiresIn: SIGN_SECONDS }),
  });
  return `${SUPABASE_URL}/storage/v1${r.signedURL}`;
}

async function signUpload(path: string): Promise<string> {
  const r = await storageJson<{ url: string }>(`object/upload/sign/${BUCKET}/${path}`, { method: "POST", body: "{}" });
  return `${SUPABASE_URL}/storage/v1${r.url}`;
}

async function listObjects(prefix: string): Promise<{ name: string; size: number }[]> {
  const rows = await storageJson<{ name: string; metadata?: { size?: number } }[]>(
    `object/list/${BUCKET}`, { method: "POST", body: JSON.stringify({ prefix, limit: 500 }) },
  );
  return (rows ?? []).filter((r) => r.name).map((r) => ({ name: r.name, size: r.metadata?.size ?? 0 }));
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;
const needId = (args: Args, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`argument '${key}' (a relay id) is required`);
  return v;
};

const TOOLS = [
  {
    name: "list_my_projects",
    description: "List the CutLab projects owned by the account this connect token belongs to (id, name, last updated).",
    inputSchema: { type: "object", properties: {} },
    run: async (caller: Caller) => {
      const rows = await restJson<{ id: string; name: string; updated_at: string }[]>(
        `cutlab_projects?user_id=eq.${caller.userId}&select=id,name,updated_at&order=updated_at.desc&limit=50`,
      );
      return { projects: rows.map((r) => ({ id: r.id, name: r.name, updatedAt: r.updated_at })) };
    },
  },
  {
    name: "get_project",
    description: "Fetch one of your projects' full project JSON (the exact document the renderer consumes).",
    inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] },
    run: async (caller: Caller, args: Args) => {
      const row = await getProjectRow(caller, needId(args, "project_id"));
      return { project: row.project };
    },
  },
  {
    name: "get_media_links",
    description:
      "Time-limited download URLs for every input file of one of your render jobs (the project's media + bundled fonts/LUTs). " +
      "Download each file into a media folder keeping its `src` file name, then render.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    run: async (caller: Caller, args: Args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      if (!job.project_id) throw new Error("job has no project attached");
      const { project } = await getProjectRow(caller, job.project_id);
      const media = (project.media as { src: string }[] | undefined) ?? [];
      const bundled = (job.payload?.bundledAssets as string[] | undefined) ?? [];
      const wanted = [...media.map((m) => m.src), ...bundled];
      // Locate each file: the job's own input slot first, then the
      // project scopes (the same fallback chain the server worker uses).
      const prefixes = [
        inputPrefix(caller.userId, job.id),
        `users/${caller.userId}/projects/${job.project_id}/media`,
        `projects/${job.project_id}/media`,
      ];
      const found = new Map<string, { path: string; size: number }>();
      for (const prefix of prefixes) {
        const objs = await listObjects(prefix).catch(() => []);
        for (const o of objs) if (!found.has(o.name)) found.set(o.name, { path: `${prefix}/${o.name}`, size: o.size });
      }
      const files = [];
      const missing: string[] = [];
      for (const src of wanted) {
        const hit = found.get(src);
        if (!hit) { missing.push(src); continue; }
        files.push({ src, bytes: hit.size, url: await signDownload(hit.path), expiresInSeconds: SIGN_SECONDS });
      }
      return { job_id: job.id, project_id: job.project_id, files, missing };
    },
  },
  {
    name: "list_waiting_render_jobs",
    description: "Render jobs queued for YOUR agent (execLane = 'agent') on this account, oldest first. The CutLab server never touches these.",
    inputSchema: { type: "object", properties: {} },
    run: async (caller: Caller) => {
      const rows = await restJson<JobRow[]>(
        `cutlab_jobs?user_id=eq.${caller.userId}&type=eq.render&status=eq.queued&select=id,project_id,payload,created_at&order=created_at.asc&limit=50`,
      );
      return {
        jobs: rows.filter((j) => execLane(j) === "agent").map((j) => ({
          job_id: j.id, project_id: j.project_id, created_at: j.created_at, payload: j.payload,
        })),
      };
    },
  },
  {
    name: "claim_render_job",
    description:
      "Claim one waiting agent-lane render job (lease: 1 hour). Returns the job payload (your job.json), the project id, " +
      "and signed UPLOAD urls for the finished files — PUT each rendered file to its url, then call complete_render_job.",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    run: async (caller: Caller, args: Args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      if (job.type !== "render") throw new Error("that job is not a render job");
      if (execLane(job) !== "agent") throw new Error("that job is not an agent-lane job (the CutLab server renders it)");
      if (job.status !== "queued") throw new Error(`job is not waiting (status: ${job.status})`);
      const payload = {
        ...(job.payload ?? {}),
        agentClaim: {
          by: caller.label ?? "agent",
          tokenHash: caller.tokenHash,
          at: nowIso(),
          leaseUntil: new Date(Date.now() + LEASE_SECONDS * 1000).toISOString(),
        },
      };
      const claimed = await restJson<JobRow[]>(
        `cutlab_jobs?id=eq.${job.id}&status=eq.queued`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "running", claimed_at: nowIso(), heartbeat_at: nowIso(), updated_at: nowIso(), payload }),
        },
      );
      if (!claimed.length) throw new Error("claim lost — another agent claimed this job first");
      const outPrefix = outputPrefix(caller.userId, job.id);
      const also = ((job.payload?.output as { alsoFormats?: string[] } | undefined)?.alsoFormats) ?? [];
      const names = ["render.mp4", ...also.map((r) => `render_${r.replace(":", "x")}.mp4`)];
      const uploadLinks = [];
      for (const file of names) {
        uploadLinks.push({ file, path: `${outPrefix}/${file}`, uploadUrl: await signUpload(`${outPrefix}/${file}`) });
      }
      return {
        job_id: job.id, project_id: job.project_id, payload,
        outputPrefix: outPrefix, uploadLinks,
        next: "get_project + get_media_links, render with the CutLab renderer package, PUT each output to its uploadUrl, then complete_render_job.",
      };
    },
  },
  {
    name: "complete_render_job",
    description:
      "Mark a job you claimed as done. The named output files must already be uploaded (via the claim's uploadUrls); " +
      "their real sizes are read back from storage, and the job result mirrors the server worker's shape.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        outputs: { type: "array", items: { type: "object", properties: { file: { type: "string" } }, required: ["file"] } },
      },
      required: ["job_id"],
    },
    run: async (caller: Caller, args: Args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      assertClaimedBy(caller, job);
      const requested = (args.outputs as { file: string }[] | undefined) ?? [{ file: "render.mp4" }];
      const outPrefix = outputPrefix(caller.userId, job.id);
      const stored = new Map((await listObjects(outPrefix)).map((o) => [o.name, o.size]));
      const outputs = [];
      for (const o of requested) {
        const file = o.file.replace(/^.*\//, "");
        const size = stored.get(file);
        if (size === undefined) throw new Error(`output '${file}' is not in storage yet — upload it with the claim's uploadUrl first`);
        const also = /^render_(\d+)x(\d+)\.mp4$/.exec(file);
        outputs.push(also
          ? { kind: "also-format", path: `${outPrefix}/${file}`, bytes: size, format: `${also[1]}:${also[2]}` }
          : { kind: "render", path: `${outPrefix}/${file}`, bytes: size });
      }
      if (!outputs.some((o) => o.kind === "render")) throw new Error("outputs must include the main render.mp4");
      const done = await restJson<JobRow[]>(
        `cutlab_jobs?id=eq.${job.id}&status=eq.running`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "done", result: { outputs }, updated_at: nowIso() }) },
      );
      if (!done.length) throw new Error("job is no longer running — completion refused");
      return { job_id: job.id, status: "done", outputs };
    },
  },
  {
    name: "fail_render_job",
    description: "Mark a job you claimed as failed, with the reason. Use this instead of abandoning a claimed job.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string" }, reason: { type: "string" } },
      required: ["job_id", "reason"],
    },
    run: async (caller: Caller, args: Args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      assertClaimedBy(caller, job);
      const failed = await restJson<JobRow[]>(
        `cutlab_jobs?id=eq.${job.id}&status=eq.running`,
        {
          method: "PATCH", headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "failed", error: String(args.reason).slice(0, 2000), updated_at: nowIso() }),
        },
      );
      if (!failed.length) throw new Error("job is no longer running — failure report refused");
      return { job_id: job.id, status: "failed" };
    },
  },
];


// ---------------------------------------------------------------------------
// Phase 1 — the full MCP command vocabulary (UPGRADE-PLAN.md §3)
//
// Every editing tool follows the same write path:
//   1. load the project row scoped to caller.userId (with its revision
//      when the mcp-upgrade migration has run; without it the load
//      falls back and writes proceed unguarded, reported as
//      revisionTracked: false);
//   2. an optional expected_revision refuses stale writes;
//   3. ops (ops.ts, pure) mutate a clone; the FULL document is then
//      validated with schema.ts — any error refuses the write;
//   4. the edit is appended to project.editLog (newest 100 kept);
//   5. the save is guarded PATCH revision=eq.<old>; no rows back
//      means a concurrent write won and nothing was stomped.
// Media-registry law: timeline ops may never change project.media —
// only the group-B media tools may (register/remove/move/create_bin),
// enforced by comparing the media signature before/after.
// ---------------------------------------------------------------------------

import { validateProject, mediaSignature, writePathErrors } from "./schema.ts";
import {
  applyEditOp, applyEditOps, appendEditLog, captureTextPreset, checkRevision,
  collectLuts, findClip as findClipInProject, findMedia as findMediaInProject,
  listKeyframes, projectSummary, MEDIA_OPS,
  buildEmptyProject, type EditOp,
} from "./ops.ts";

interface ProjectRowFull {
  id: string; name: string; project: Record<string, unknown>;
  updated_at: string; revision?: number;
}
interface LoadedProject { row: ProjectRowFull; revision: number | null; tracked: boolean }

async function loadProjectFull(caller: Caller, projectId: string): Promise<LoadedProject> {
  try {
    const rows = await restJson<ProjectRowFull[]>(
      `cutlab_projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${caller.userId}&select=id,name,project,updated_at,revision&limit=1`,
    );
    if (!rows.length) throw new Error("project not found (it does not exist, or it belongs to a different account)");
    return { row: rows[0], revision: rows[0].revision ?? 1, tracked: true };
  } catch (e) {
    // Pre-migration relay: the revision column does not exist yet —
    // fall back to an unguarded load (writes become last-writer-wins
    // and report revisionTracked: false until the migration runs).
    if (e instanceof Error && /revision/.test(e.message) && !/not found/.test(e.message)) {
      const rows = await restJson<ProjectRowFull[]>(
        `cutlab_projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${caller.userId}&select=id,name,project,updated_at&limit=1`,
      );
      if (!rows.length) throw new Error("project not found (it does not exist, or it belongs to a different account)");
      return { row: rows[0], revision: null, tracked: false };
    }
    throw e;
  }
}

async function saveEditedProject(
  caller: Caller, loaded: LoadedProject, next: Record<string, unknown>,
  opNames: string[], expectedRevision?: number,
): Promise<{ revision: number | null; revisionTracked: boolean }> {
  // Write-path verdict (schema.ts writePathErrors): validateProject
  // minus the one documented nest-track-id false positive that every
  // editor-made compound carries.
  const writeErrors = writePathErrors(next);
  if (writeErrors.length) {
    throw new Error(`edit refused — the resulting project would be invalid: ${writeErrors.join("; ")}`);
  }
  checkRevision(loaded.tracked ? loaded.revision : null, expectedRevision ?? null);
  const newRevision = loaded.tracked ? (loaded.revision ?? 1) + 1 : null;
  appendEditLog(next as never, { at: nowIso(), by: caller.label ?? "agent", ops: opNames, revision: newRevision });
  const body: Record<string, unknown> = {
    project: next, updated_at: nowIso(),
    ...(typeof next.name === "string" ? { name: next.name } : {}),
    ...(loaded.tracked ? { revision: newRevision } : {}),
  };
  const guard = loaded.tracked ? `&revision=eq.${loaded.revision}` : "";
  const saved = await restJson<ProjectRowFull[]>(
    `cutlab_projects?id=eq.${loaded.row.id}&user_id=eq.${caller.userId}${guard}`,
    { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) },
  );
  if (!saved.length) {
    throw new Error(loaded.tracked
      ? "concurrency conflict: the project changed while this edit was being applied (revision guard matched no rows) — reload with get_project and re-apply"
      : "the project could not be saved (it may have been deleted)");
  }
  return { revision: newRevision, revisionTracked: loaded.tracked };
}

/** Load → apply ops → media-law check → validate → guarded save. */
async function applyAndSave(
  caller: Caller, projectId: string, ops: EditOp[], expectedRevision?: number,
): Promise<Record<string, unknown>> {
  const loaded = await loadProjectFull(caller, projectId);
  const before = loaded.row.project;
  const after = (ops.length === 1 ? applyEditOp(before as never, ops[0]) : applyEditOps(before as never, ops)) as unknown as Record<string, unknown>;
  if (mediaSignature(before) !== mediaSignature(after) && !ops.every((o) => MEDIA_OPS.has(o.op))) {
    throw new Error(
      "edit refused: it would change the media registry, and timeline ops may never do that — " +
      "use register_media / remove_media / move_media_to_bin / create_bin for media changes",
    );
  }
  const saved = await saveEditedProject(caller, loaded, after, ops.map((o) => o.op), expectedRevision);
  return {
    project_id: projectId, applied: ops.map((o) => o.op),
    revision: saved.revision, revisionTracked: saved.revisionTracked,
    summary: projectSummary(after as never),
  };
}

async function queueJobRow(
  caller: Caller, type: string, payload: Record<string, unknown>, projectId?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await restJson<unknown[]>("cutlab_jobs", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      id, type, status: "queued", payload, user_id: caller.userId,
      ...(projectId ? { project_id: projectId } : {}),
    }),
  });
  return id;
}

const jobPollNote = (jobId: string) =>
  `Job queued. Poll it with get_job (job_id: ${jobId}); when it is done, get_output_links returns signed download URLs for its outputs.`;

/** Resolve a clip's media src from the project (friendly errors via ops). */
function clipMediaSrc(project: Record<string, unknown>, clipId: string): { src: string; mediaId: string } {
  const { clip } = findClipInProject(project as never, clipId);
  const media = findMediaInProject(project as never, String(clip.media));
  return { src: String(media.src), mediaId: String(media.id) };
}

type ToolDef = {
  name: string; description: string;
  inputSchema: Record<string, unknown>;
  run: (caller: Caller, args: Args) => Promise<unknown>;
};
const S = { type: "string" } as const;
const N = { type: "number" } as const;
const B = { type: "boolean" } as const;
const PID = { project_id: S };
const REV = { expected_revision: N };
const CLIP = { clip_id: S };
const TRACKQ = { track_id: S };

/** Factory for the many single-op editing tools. */
function editTool(
  name: string, description: string,
  properties: Record<string, unknown>, required: string[],
  toOps: (args: Args) => EditOp[],
): ToolDef {
  return {
    name, description,
    inputSchema: { type: "object", properties: { ...PID, ...REV, ...properties }, required: ["project_id", ...required] },
    run: async (caller, args) => applyAndSave(caller, needId(args, "project_id"), toOps(args), args.expected_revision as number | undefined),
  };
}
/** Factory for read-only project tools (no write, no revision bump). */
function readTool(
  name: string, description: string,
  properties: Record<string, unknown>, required: string[],
  fn: (project: Record<string, unknown>, args: Args) => unknown,
): ToolDef {
  return {
    name, description,
    inputSchema: { type: "object", properties: { ...PID, ...properties }, required: ["project_id", ...required] },
    run: async (caller, args) => {
      const loaded = await loadProjectFull(caller, needId(args, "project_id"));
      return fn(loaded.row.project, args);
    },
  };
}

const PHASE1_TOOLS: ToolDef[] = [
  // ---- A. Project ---------------------------------------------------------
  {
    name: "create_project",
    description: "Create a new empty CutLab project (720×1280 @30fps unless canvas args say otherwise). Accounts are limited to 2 projects (the owner account is exempt).",
    inputSchema: {
      type: "object",
      properties: { name: S, width: N, height: N, fps: N },
    },
    run: async (caller, args) => {
      const existing = await restJson<{ id: string }[]>(
        `cutlab_projects?user_id=eq.${caller.userId}&select=id&limit=50`,
      );
      if (existing.length >= projectLimitFor(caller)) {
        throw new Error(`this account already has ${PROJECT_LIMIT} projects — the product limit. Delete one (delete_project) before creating another`);
      }
      const project = buildEmptyProject({
        name: (args.name as string) ?? "Untitled project",
        w: args.width as number | undefined, h: args.height as number | undefined,
        fps: args.fps as number | undefined,
      }) as unknown as Record<string, unknown>;
      const verdict = validateProject(project);
      if (!verdict.ok) throw new Error(`new project would be invalid: ${verdict.errors.join("; ")}`);
      const id = crypto.randomUUID();
      const rows = await restJson<ProjectRowFull[]>("cutlab_projects", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id, name: project.name, project, user_id: caller.userId, updated_at: nowIso() }),
      });
      return { project_id: rows[0]?.id ?? id, revision: 1, summary: projectSummary(project as never) };
    },
  },
  {
    name: "update_project",
    description:
      "Replace a whole project document (validated against the strict schema before anything is written). " +
      "The media registry may NOT change here — a differing media signature is refused; use the media tools instead.",
    inputSchema: {
      type: "object",
      properties: { ...PID, ...REV, project: { type: "object" } },
      required: ["project_id", "project"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const loaded = await loadProjectFull(caller, projectId);
      const next = args.project as Record<string, unknown>;
      if (!next || typeof next !== "object" || Array.isArray(next)) throw new Error("argument 'project' must be the full project JSON object");
      if (mediaSignature(loaded.row.project) !== mediaSignature(next)) {
        throw new Error(
          "update refused: the media registry differs from the stored project (media may not be added, removed or renamed by update_project) — use register_media / remove_media / move_media_to_bin instead",
        );
      }
      // The stored edit log is authoritative; the caller's copy is ignored.
      const doc = { ...next, editLog: (loaded.row.project as { editLog?: unknown }).editLog };
      if (doc.editLog === undefined) delete doc.editLog;
      const saved = await saveEditedProject(caller, loaded, doc, ["update_project"], args.expected_revision as number | undefined);
      return { project_id: projectId, revision: saved.revision, revisionTracked: saved.revisionTracked, summary: projectSummary(doc as never) };
    },
  },
  {
    name: "apply_edit_operations",
    description:
      "Apply an ordered batch of edit ops in ONE write (atomic: any failing op refuses the whole batch). " +
      "Each op is an object {op: '<name>', ...args} using the same vocabulary as the individual tools " +
      "(set_canvas, add_clip, trim_clip, split_clip, add_keyframe, set_grade_layer, add_text, set_eq, …).",
    inputSchema: {
      type: "object",
      properties: { ...PID, ...REV, ops: { type: "array", items: { type: "object" } } },
      required: ["project_id", "ops"],
    },
    run: async (caller, args) => {
      const ops = args.ops as EditOp[];
      if (!Array.isArray(ops) || !ops.length) throw new Error("argument 'ops' must be a non-empty array of {op, ...} objects");
      return applyAndSave(caller, needId(args, "project_id"), ops, args.expected_revision as number | undefined);
    },
  },
  {
    name: "duplicate_project",
    description: "Copy a project into a new project row (same document, new id). The copy's media registry points at the same files, which stay in the source project's storage scope. Subject to the 2-project account limit (the owner account is exempt).",
    inputSchema: { type: "object", properties: { ...PID, name: S }, required: ["project_id"] },
    run: async (caller, args) => {
      const loaded = await loadProjectFull(caller, needId(args, "project_id"));
      const existing = await restJson<{ id: string }[]>(`cutlab_projects?user_id=eq.${caller.userId}&select=id&limit=50`);
      if (existing.length >= projectLimitFor(caller)) throw new Error(`this account already has ${PROJECT_LIMIT} projects — the product limit. Delete one before duplicating`);
      const copy = JSON.parse(JSON.stringify(loaded.row.project)) as Record<string, unknown>;
      copy.name = (args.name as string) ?? `${String(copy.name ?? "Project")} copy`;
      const id = crypto.randomUUID();
      await restJson<unknown[]>("cutlab_projects", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ id, name: copy.name, project: copy, user_id: caller.userId, updated_at: nowIso() }),
      });
      return { project_id: id, source_project_id: loaded.row.id, name: copy.name, note: "media files remain in the source project's storage scope; the registry was copied as-is" };
    },
  },
  {
    name: "delete_project",
    description: "Delete a project row permanently (its stored media files are not swept — only the project document and row). This cannot be undone.",
    inputSchema: { type: "object", properties: { ...PID }, required: ["project_id"] },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const rows = await restJson<{ id: string }[]>(
        `cutlab_projects?id=eq.${encodeURIComponent(projectId)}&user_id=eq.${caller.userId}`,
        { method: "DELETE", headers: { Prefer: "return=representation" } },
      );
      if (!rows.length) throw new Error("project not found (it does not exist, or it belongs to a different account)");
      return { project_id: projectId, deleted: true };
    },
  },
  editTool("rename_project", "Rename a project.", { name: S }, ["name"],
    (a) => [{ op: "rename_project", name: a.name }]),
  editTool("set_canvas", "Set the project canvas (any of w, h, fps, bg).",
    { w: N, h: N, fps: N, bg: S }, [],
    (a) => [{ op: "set_canvas", w: a.w, h: a.h, fps: a.fps, bg: a.bg }]),
  editTool("set_timeline_range", "Set or clear the timeline I/O range (rangeIn/rangeOut in seconds; null clears a point).",
    { rangeIn: N, rangeOut: N }, [],
    (a) => [{ op: "set_timeline_range", ...("rangeIn" in a ? { rangeIn: a.rangeIn } : {}), ...("rangeOut" in a ? { rangeOut: a.rangeOut } : {}) }]),
  editTool("add_marker", "Add a timeline marker at t seconds (optional color hex, optional dur for a range marker).",
    { t: N, label: S, color: S, dur: N }, ["t", "label"],
    (a) => [{ op: "add_marker", t: a.t, label: a.label, color: a.color, dur: a.dur }]),
  editTool("remove_marker", "Remove a marker by index, or by t (+ optional label).",
    { t: N, label: S, index: N }, [],
    (a) => [{ op: "remove_marker", t: a.t, label: a.label, index: a.index }]),
  readTool("list_markers", "List a project's timeline markers.", {}, [],
    (p) => ({ markers: (p as { markers?: unknown }).markers ?? [] })),
  readTool("get_project_summary", "Cheap planning read: canvas, duration, per-track clip counts, media counts — not the full document.", {}, [],
    (p) => projectSummary(p as never)),

  // ---- B. Media ------------------------------------------------------------
  readTool("list_media", "List a project's media registry and bins.", {}, [],
    (p) => ({ media: (p as { media?: unknown }).media ?? [], mediaBins: (p as { mediaBins?: unknown }).mediaBins ?? [] })),
  {
    name: "request_media_upload",
    description:
      "Get a signed upload URL for a NEW media file in the project's storage scope. Declare the file size up front (over 50 MB is refused — the per-file limit). " +
      "PUT the bytes to uploadUrl, then call register_media with the probe results (kind/duration/width/height).",
    inputSchema: {
      type: "object",
      properties: { ...PID, filename: S, size_bytes: N },
      required: ["project_id", "filename", "size_bytes"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      await loadProjectFull(caller, projectId); // existence + ownership
      const filename = String(args.filename ?? "").replace(/^.*[\\/]/, "");
      if (!filename) throw new Error("argument 'filename' must name the file (no folders)");
      const size = args.size_bytes as number;
      if (typeof size !== "number" || size < 0) throw new Error("argument 'size_bytes' (declared file size) is required");
      if (size > 50 * 1024 * 1024) throw new Error(`that file is ${(size / 1048576).toFixed(1)} MB — over the 50 MB per-file limit. Trim or compress it first`);
      const path = `users/${caller.userId}/projects/${projectId}/media/${filename}`;
      return {
        path, uploadUrl: await signUpload(path), expiresInSeconds: SIGN_SECONDS,
        next: `PUT the file bytes to uploadUrl, probe it locally (duration/width/height), then register_media with project_id, src: "${filename}", kind and the probe values.`,
      };
    },
  },
  editTool("register_media", "Register an already-uploaded file in the project's media registry (the only way timeline clips may reference new media). Probe args: src, kind, duration, width, height, bin.",
    {
      src: S, kind: S, media_id: S, bin: S, duration: N, width: N, height: N,
    }, ["src", "kind"],
    (a) => [{
      op: "register_media",
      media: { id: a.media_id, src: a.src, kind: a.kind, bin: a.bin, duration: a.duration, width: a.width, height: a.height },
    }]),
  editTool("remove_media", "Remove a media registry entry. Refused while any clip (incl. angles, mattes, voice stems) references it.",
    { media_id: S }, ["media_id"],
    (a) => [{ op: "remove_media", media_id: a.media_id }]),
  editTool("create_bin", "Create a named media bin (folder) in the project.",
    { name: S }, ["name"],
    (a) => [{ op: "create_bin", name: a.name }]),
  editTool("move_media_to_bin", "Move a media item into a bin (created if missing); bin: null returns it to the root.",
    { media_id: S, bin: S }, ["media_id"],
    (a) => [{ op: "move_media_to_bin", media_id: a.media_id, bin: "bin" in a ? a.bin : undefined }]),
  {
    name: "analyse_media",
    description: "Queue a media-analysis job (proxies / thumbnails / waveform peaks / beats) for the project's media — mirrors the app's job payload exactly. Optionally restrict to media_ids.",
    inputSchema: { type: "object", properties: { ...PID, media_ids: { type: "array", items: S } }, required: ["project_id"] },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const loaded = await loadProjectFull(caller, projectId);
      const project = loaded.row.project as { canvas?: { fps?: number }; media?: { id: string; src: string; kind: string }[] };
      const wanted = args.media_ids as string[] | undefined;
      const items = (project.media ?? [])
        .filter((m) => !wanted || wanted.includes(m.id))
        .map((m) => ({
          id: m.id, src: m.src, kind: m.kind,
          requests: m.kind === "image" ? ["thumbnail"] : ["proxy", "thumbnail", "peaks", "beats"],
        }));
      if (!items.length) throw new Error("no media to analyse (the project registry is empty, or media_ids matched nothing)");
      const payload = { version: 1, type: "media-analysis", createdAt: nowIso(), fps: project.canvas?.fps ?? 30, items };
      const jobId = await queueJobRow(caller, "media-analysis", payload, projectId);
      return { job_id: jobId, items: items.length, note: jobPollNote(jobId) };
    },
  },

  // ---- C. Timeline & clips ---------------------------------------------------
  editTool("add_track", "Add a track (kind video/audio/text) with optional header flags.",
    { kind: S, track_id: S, name: S, color: S, muted: B, solo: B, locked: B, hidden: B, volume: N, bus: S }, ["kind"],
    (a) => [{ op: "add_track", kind: a.kind, track_id: a.track_id, name: a.name, color: a.color, muted: a.muted, solo: a.solo, locked: a.locked, hidden: a.hidden, volume: a.volume, bus: a.bus }]),
  editTool("remove_track", "Remove a track. Refused while it holds clips unless force is true.",
    { ...TRACKQ, force: B }, ["track_id"],
    (a) => [{ op: "remove_track", track_id: a.track_id, force: a.force }]),
  editTool("set_track_flags", "Set track header fields: muted, solo, locked, hidden, name, color, height, volume, bus (null clears a field).",
    { ...TRACKQ, muted: B, solo: B, locked: B, hidden: B, name: S, color: S, height: N, volume: N, bus: S }, ["track_id"],
    (a) => [{
      op: "set_track_flags", track_id: a.track_id,
      ...Object.fromEntries(["muted", "solo", "locked", "hidden", "name", "color", "height", "volume", "bus"].filter((k) => k in a).map((k) => [k, a[k]])),
    }]),
  editTool("add_clip", "Add a media clip to a video/audio track: media_id + start + in/out builds the clip with the model's defaults; or pass a full clip object.",
    {
      ...TRACKQ, media_id: S, clip_id: S, start: N, in: N, out: N, speed: N,
      volume: N, muted: B, fadeIn: N, fadeOut: N, clip: { type: "object" },
    }, ["track_id"],
    (a) => [{
      op: "add_clip", track_id: a.track_id, media_id: a.media_id, clip_id: a.clip_id,
      start: a.start, in: a.in, out: a.out, speed: a.speed, volume: a.volume,
      muted: a.muted, fadeIn: a.fadeIn, fadeOut: a.fadeOut, clip: a.clip,
    }]),
  editTool("remove_clip", "Remove a clip from the timeline (leaves a gap).",
    { ...CLIP, track_id: S }, ["clip_id"],
    (a) => [{ op: "remove_clip", clip_id: a.clip_id, track_id: a.track_id }]),
  editTool("move_clip", "Move a clip: new start, and/or onto another track of the same kind.",
    { ...CLIP, track_id: S, to_track_id: S, start: N }, ["clip_id"],
    (a) => [{ op: "move_clip", clip_id: a.clip_id, track_id: a.track_id, to_track_id: a.to_track_id, start: a.start }]),
  editTool("trim_clip", "Trim a clip: in/out/start for media+compound clips; start/dur for text+adjustment clips.",
    { ...CLIP, track_id: S, in: N, out: N, start: N, dur: N }, ["clip_id"],
    (a) => [{ op: "trim_clip", clip_id: a.clip_id, track_id: a.track_id, in: a.in, out: a.out, start: a.start, dur: a.dur }]),
  editTool("split_clip", "Split a clip at a timeline time (frame-quantised, exactly the editor's split: keyframes rebased, right half gets a new id and no transition).",
    { ...CLIP, track_id: S, at: N, new_clip_id: S }, ["clip_id", "at"],
    (a) => [{ op: "split_clip", clip_id: a.clip_id, track_id: a.track_id, at: a.at, new_clip_id: a.new_clip_id }]),
  editTool("duplicate_clip", "Duplicate a clip on its track (new id; starts at the original's end unless start is given).",
    { ...CLIP, track_id: S, new_clip_id: S, start: N }, ["clip_id"],
    (a) => [{ op: "duplicate_clip", clip_id: a.clip_id, track_id: a.track_id, new_clip_id: a.new_clip_id, start: a.start }]),
  editTool("set_clip_timing", "Set timing fields on a media/compound clip: speed, speedKeys (speed-ramp), reversed, freezeAt, pitchPreserve, smoothSlowmo. A field set to null is removed.",
    {
      ...CLIP, track_id: S, speed: N, reversed: B, freezeAt: N, pitchPreserve: B, smoothSlowmo: B,
      speedKeys: { type: "array", items: { type: "object" } },
    }, ["clip_id"],
    (a) => [{
      op: "set_clip_timing", clip_id: a.clip_id, track_id: a.track_id,
      ...Object.fromEntries(["speed", "speedKeys", "reversed", "freezeAt", "pitchPreserve", "smoothSlowmo"].filter((k) => k in a).map((k) => [k, a[k]])),
    }]),
  editTool("link_clips", "Link clips into a selection group (shared groupId).",
    { clip_ids: { type: "array", items: S }, group_id: S }, ["clip_ids"],
    (a) => [{ op: "link_clips", clip_ids: a.clip_ids, group_id: a.group_id }]),
  editTool("unlink_clips", "Unlink clips: by clip_ids, or every clip carrying a group_id.",
    { clip_ids: { type: "array", items: S }, group_id: S }, [],
    (a) => [{ op: "unlink_clips", clip_ids: a.clip_ids, group_id: a.group_id }]),
  editTool("make_compound", "Wrap 2+ clips into a compound (nested) clip on a video track — the editor's compound semantics: nest clips keep their ids, times rebased to the selection start.",
    { clip_ids: { type: "array", items: S }, name: S, compound_id: S, host_track_id: S }, ["clip_ids"],
    (a) => [{ op: "make_compound", clip_ids: a.clip_ids, name: a.name, compound_id: a.compound_id, host_track_id: a.host_track_id }]),
  editTool("uncompound", "Unwrap a compound clip: its nest clips return to the timeline with their original ids, retimed by the compound window.",
    { ...CLIP, track_id: S }, ["clip_id"],
    (a) => [{ op: "uncompound", clip_id: a.clip_id, track_id: a.track_id }]),
  editTool("add_adjustment_clip", "Add an adjustment clip (effects/grade over everything beneath it) to a video track.",
    {
      ...TRACKQ, clip_id: S, start: N, dur: N,
      effects: { type: "array", items: { type: "object" } }, grade: { type: "object" }, mask: { type: "object" },
    }, ["track_id", "dur"],
    (a) => [{ op: "add_adjustment_clip", track_id: a.track_id, clip_id: a.clip_id, start: a.start, dur: a.dur, effects: a.effects, grade: a.grade, mask: a.mask }]),
  editTool("set_active_angle", "Switch a multicam clip's active angle (the in/out window shifts by the angles' sync-offset delta, exactly as the editor does).",
    { ...CLIP, track_id: S, angle_index: N }, ["clip_id", "angle_index"],
    (a) => [{ op: "set_active_angle", clip_id: a.clip_id, track_id: a.track_id, angle_index: a.angle_index }]),
  editTool("cut_to_angle", "Multicam cut: split the clip at a timeline time and give the right part the chosen angle (the model's performAngleCut — split + angle + window shift).",
    { ...CLIP, track_id: S, at: N, angle_index: N, new_clip_id: S }, ["clip_id", "at", "angle_index"],
    (a) => [{ op: "cut_to_angle", clip_id: a.clip_id, track_id: a.track_id, at: a.at, angle_index: a.angle_index, new_clip_id: a.new_clip_id }]),

  // ---- D. Transform & animation ---------------------------------------------
  editTool("set_transform", "Partial-merge a clip's transform {x, y, scale, rotation (degrees), opacity}.",
    { ...CLIP, track_id: S, transform: { type: "object" } }, ["clip_id", "transform"],
    (a) => [{ op: "set_transform", clip_id: a.clip_id, track_id: a.track_id, transform: a.transform }]),
  editTool("add_keyframe", "Add or merge a keyframe at clip-local t: either {prop: x|y|scale|rotation|opacity, value, ease?, ease_handles?, hold?} or a full keyframe object (mask/fx animation included).",
    {
      ...CLIP, track_id: S, t: N, prop: S, value: N, ease: S, hold: B,
      ease_handles: { type: "object" }, keyframe: { type: "object" },
    }, ["clip_id"],
    (a) => [{
      op: "add_keyframe", clip_id: a.clip_id, track_id: a.track_id, t: a.t, prop: a.prop,
      value: a.value, ease: a.ease, hold: a.hold, ease_handles: a.ease_handles, keyframe: a.keyframe,
    }]),
  editTool("remove_keyframe", "Remove a keyframe at clip-local t, or one prop from it.",
    { ...CLIP, track_id: S, t: N, prop: S }, ["clip_id", "t"],
    (a) => [{ op: "remove_keyframe", clip_id: a.clip_id, track_id: a.track_id, t: a.t, prop: a.prop }]),
  editTool("add_camera_move", "Write a whole synthetic camera move as keyframes in one op: kind push-in/pull-out (scale from->to, defaults 1->1.15 / 1.15->1) or glide-left/right/up/down (x/y from->to px, default 5% of canvas), over the clip-local window start..start+dur (defaults: 0..clip end) with an ease (default easeInOut). entry_blur 0..1 adds the reference-chain entry: the clip starts blurred (peak sigma = entry_blur x 12) and settles to sharp across the window, via a blur effect + fx keyframes (the effect's base value carries the peak — removing the keyframes restores it). Use for still/slow shots that need a living camera.",
    {
      ...CLIP, track_id: S, kind: S, start: N, dur: N, from: N, to: N, ease: S, entry_blur: N,
    }, ["clip_id", "kind"],
    (a) => [{
      op: "add_camera_move", clip_id: a.clip_id, track_id: a.track_id, kind: a.kind,
      start: a.start, dur: a.dur, from: a.from, to: a.to, ease: a.ease, entry_blur: a.entry_blur,
    }]),
  readTool("list_keyframes", "List a clip's keyframes (types.ts shape: [{t, x?, y?, scale?, rotation?, opacity?, ease?, easeHandles?, hold?, mask?, fx?}]).",
    { ...CLIP }, ["clip_id"],
    (p, a) => ({ keyframes: listKeyframes(p as never, String(a.clip_id)) })),
  editTool("set_crop", "Set a clip's crop {l, t, r, b, softness} (edge fractions), or null to clear.",
    { ...CLIP, track_id: S, crop: { type: "object" } }, ["clip_id"],
    (a) => [{ op: "set_crop", clip_id: a.clip_id, track_id: a.track_id, crop: "crop" in a ? a.crop : undefined }]),
  editTool("set_blend_mode", "Set a clip's composite blend mode (normal/screen/multiply/overlay/lighten/darken/hard-light).",
    { ...CLIP, track_id: S, blend: S }, ["clip_id", "blend"],
    (a) => [{ op: "set_blend_mode", clip_id: a.clip_id, track_id: a.track_id, blend: a.blend }]),
  editTool("set_flip", "Set flipH / flipV on a clip.",
    { ...CLIP, track_id: S, flipH: B, flipV: B }, ["clip_id"],
    (a) => [{ op: "set_flip", clip_id: a.clip_id, track_id: a.track_id, flipH: a.flipH, flipV: a.flipV }]),
  editTool("set_fit", "Set a media clip's stage fit: 'cover' or 'blur-fill'.",
    { ...CLIP, track_id: S, fit: S }, ["clip_id", "fit"],
    (a) => [{ op: "set_fit", clip_id: a.clip_id, track_id: a.track_id, fit: a.fit }]),
  editTool("set_mask", "Set a clip's mask {shape: rect|circle|linear|pen, x, y, w, h, feather, invert, angle?, points?} (canvas fractions), or null to clear.",
    { ...CLIP, track_id: S, mask: { type: "object" } }, ["clip_id"],
    (a) => [{ op: "set_mask", clip_id: a.clip_id, track_id: a.track_id, mask: "mask" in a ? a.mask : undefined }]),
  editTool("set_chroma_key", "Set a media clip's chroma key {color, intensity, shadow, spill}, or null to remove it.",
    { ...CLIP, track_id: S, chroma_key: { type: "object" } }, ["clip_id"],
    (a) => [{ op: "set_chroma_key", clip_id: a.clip_id, track_id: a.track_id, chroma_key: "chroma_key" in a ? a.chroma_key : undefined }]),
  editTool("set_matte", "Set a media clip's matte (matteId from the media registry), or null to clear it.",
    { ...CLIP, track_id: S, matte_id: S }, ["clip_id"],
    (a) => [{ op: "set_matte", clip_id: a.clip_id, track_id: a.track_id, matte_id: "matte_id" in a ? a.matte_id : undefined }]),

  // ---- E. Effects & transitions ----------------------------------------------
  editTool("add_effect", "Add an effect to a clip's stack (all 13 types: brightness, contrast, saturation, blur, glow, sharpen, vignette, tv-lines, haze, wide-angle, motion-blur, relight, turbulent-displace). Default value per the Inspector when value is omitted; relight takes lights: [{x, y, color, radius, intensity}] (max 2). turbulent-displace (render-only, Lane B) warps the layer with a smooth low-frequency turbulence field — the AE Turbulent Displace analogue for bubble/pop-out hooks; value = amount 0..1 (a ^1.35 curve maps it to a sane pixel range — peak bends, never shreds), keyframable via fx keyframes, params: {scale 0..1 (field feature size), seed (field variant), evolution 0..1 (churn rate), falloff 0..1 (vertical strength fade: full displacement at the layer's bottom / emergence line, fading to zero toward the top so a pop-out clone's body stays coherent; default 0.85, 0 = uniform field). AE RECIPE MODE: pass params.amount (px) to switch the op to literal After Effects Turbulent Displace values — amount/size in px at face value (no curve), complexity = fractal detail octaves, pin 1 = Pin All (displacement dies at the layer edges), evolution_rate in deg/sec (the time*500 expression = 500); value then acts as a plain master scale on the amount and falloff defaults OFF — pair it with a matteId roto layer for the bubble/clone sandwich. On a text clip, adds the named string effect (e.g. glow).",
    {
      ...CLIP, track_id: S, type: S, value: N, enabled: B,
      params: { type: "object" }, lights: { type: "array", items: { type: "object" } },
    }, ["clip_id", "type"],
    (a) => [{ op: "add_effect", clip_id: a.clip_id, track_id: a.track_id, type: a.type, value: a.value, params: a.params, lights: a.lights, enabled: a.enabled }]),
  editTool("update_effect", "Update an effect on a clip (by type or stack index): value, params (merged), lights, enabled.",
    {
      ...CLIP, track_id: S, type: S, index: N, value: N, enabled: B,
      params: { type: "object" }, lights: { type: "array", items: { type: "object" } },
    }, ["clip_id"],
    (a) => [{ op: "update_effect", clip_id: a.clip_id, track_id: a.track_id, type: a.type, index: a.index, value: a.value, params: a.params, lights: a.lights, enabled: a.enabled }]),
  editTool("remove_effect", "Remove an effect from a clip (by type or stack index).",
    { ...CLIP, track_id: S, type: S, index: N }, ["clip_id"],
    (a) => [{ op: "remove_effect", clip_id: a.clip_id, track_id: a.track_id, type: a.type, index: a.index }]),
  editTool("set_transition", "Set a clip's transition-in: transitionIn (12 types or null for none) plus transitionDir, transitionDur, and mask-wipe fields wipeCx/wipeCy/wipeShape. blur-cut (rendered for real by Lane B; the preview approximates the incoming side) is the blur-masked cut: the blur peaks AT the boundary on both sides — the previous clip's tail ramps up to transitionBlur (peak gblur sigma, default 9) over its last transitionDur seconds while this clip's head settles from the peak over its first transitionDur. transitionMode: soft (gaussian settle), whip (directional streak along transitionDir, default right), zoom (scale-settle 1.12->1 under the blur). Use it for flowing mid-chain joins; keep hard 'cut' for flash sections.",
    {
      ...CLIP, track_id: S, transitionIn: S, transitionDir: S, transitionDur: N,
      transitionBlur: N, transitionMode: S,
      wipeCx: N, wipeCy: N, wipeShape: S,
    }, ["clip_id"],
    (a) => [{
      op: "set_transition", clip_id: a.clip_id, track_id: a.track_id,
      ...Object.fromEntries(["transitionIn", "transitionDir", "transitionDur", "transitionBlur", "transitionMode", "wipeCx", "wipeCy", "wipeShape"].filter((k) => k in a).map((k) => [k, a[k]])),
    }]),

  // ---- F. Colour ---------------------------------------------------------------
  editTool("set_grade_layer", "Merge grade fields into one layer of a clip's grade stack (index, default 0; creates the layer from the default grade when the stack is empty). The grade object is the full ~60-field model: primaries, lift/gamma/gain/offset wheels, curves, hueCurves, hsl, lutId/lutStrength, key, enabled.",
    { ...CLIP, track_id: S, index: N, grade: { type: "object" } }, ["clip_id", "grade"],
    (a) => [{ op: "set_grade_layer", clip_id: a.clip_id, track_id: a.track_id, index: a.index, grade: a.grade }]),
  editTool("add_grade_layer", "Append a grade layer to a clip's stack (max 3 — refused beyond that). Optionally seed it with grade fields.",
    { ...CLIP, track_id: S, grade: { type: "object" } }, ["clip_id"],
    (a) => [{ op: "add_grade_layer", clip_id: a.clip_id, track_id: a.track_id, grade: a.grade }]),
  editTool("remove_grade_layer", "Remove one layer from a clip's grade stack (index; default the last).",
    { ...CLIP, track_id: S, index: N }, ["clip_id"],
    (a) => [{ op: "remove_grade_layer", clip_id: a.clip_id, track_id: a.track_id, index: a.index }]),
  editTool("set_qualifier_key", "Set a grade layer's qualifier key {hue, hueWidth, hueSoft, satMin, satMax, satSoft, lumaMin, lumaMax, lumaSoft} (index default 0), or null to clear it.",
    { ...CLIP, track_id: S, index: N, key: { type: "object" } }, ["clip_id"],
    (a) => [{ op: "set_qualifier_key", clip_id: a.clip_id, track_id: a.track_id, index: a.index, key: "key" in a ? a.key : undefined }]),
  editTool("set_lut", "Point a grade layer at a LUT: lut_id (the id from upload_lut / the app's LUT store, e.g. 'lut-<name>') + optional lut_strength (default 0.5 in the model). project: true targets the project look instead of a clip layer. lut_id: null clears it.",
    { ...CLIP, track_id: S, index: N, lut_id: S, lut_strength: N, project: B }, ["clip_id"],
    (a) => [{ op: "set_lut", clip_id: a.clip_id, track_id: a.track_id, index: a.index, lut_id: "lut_id" in a ? a.lut_id : undefined, lut_strength: a.lut_strength, project: a.project }]),
  readTool("list_luts", "List the LUT ids this project actually references (clip grade layers + project look, with use counts). The app's LUT files themselves live in the editor's local store — this reports the project's references.", {}, [],
    (p) => ({ luts: collectLuts(p as never) })),
  {
    name: "upload_lut",
    description:
      "Get a signed upload URL for a .cube LUT into the project's storage scope. PUT the .cube bytes there; the returned lut_id is what set_lut references. " +
      "Note: the editor app keeps its LUT library locally and bundles .cube files into render jobs itself — this relay copy makes the file available in project scope for agent-queued work.",
    inputSchema: { type: "object", properties: { ...PID, filename: S }, required: ["project_id", "filename"] },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      await loadProjectFull(caller, projectId);
      const filename = String(args.filename ?? "").replace(/^.*[\\/]/, "");
      if (!/\.cube$/i.test(filename)) throw new Error("LUT files are .cube files — pass the .cube file name");
      const lutId = `lut-${filename.replace(/\.cube$/i, "").toLowerCase().replace(/[^\w]+/g, "-")}`;
      const path = `users/${caller.userId}/projects/${projectId}/luts/${filename}`;
      return {
        path, lutId, uploadUrl: await signUpload(path), expiresInSeconds: SIGN_SECONDS,
        next: `PUT the .cube bytes to uploadUrl, then set_lut with lut_id: "${lutId}" on the clip layer (or project look) that should use it.`,
      };
    },
  },
  editTool("set_project_look", "Merge grade fields into the project-wide look (applied over the whole composite, after clip grades). look: null removes the look.",
    { look: { type: "object" } }, ["look"],
    (a) => [{ op: "set_project_look", look: "look" in a ? a.look : undefined }]),
  {
    name: "grab_still",
    description:
      "Queue a still job: one frame at time t as a JPG, so you can SEE the grade. The job row mirrors the worker's conventions (type 'still', payload {t, format: 'jpg'}); " +
      "the worker's still support lands in Phase 4 — until then the job waits in the queue. Poll with get_job; the finished output URL comes from get_output_links.",
    inputSchema: { type: "object", properties: { ...PID, t: N, format: S }, required: ["project_id", "t"] },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      await loadProjectFull(caller, projectId);
      const payload = { version: 1, type: "still", t: args.t, format: (args.format as string) ?? "jpg" };
      const jobId = await queueJobRow(caller, "still", payload, projectId);
      return { job_id: jobId, note: `Still queued for t=${String(args.t)}s. ${jobPollNote(jobId)}` };
    },
  },

  // ---- G. Text & captions -------------------------------------------------------
  editTool("add_text", "Add a text clip (defaults from the named built-in style preset — pop-bold/plain/caption — plus x 0.5, y 0.8, pop-in/fade-out; any style field on the call wins). Lands on the given text track, else the first text track.",
    {
      track_id: S, clip_id: S, start: N, dur: N, text: S, style: S, x: N, y: N,
      fontFamily: S, fontWeight: N, fontSize: N, color: S, strokeColor: S, strokeWidth: N, shadow: B,
      animIn: S, animOut: S, align: S, charSpacing: N, lineSpacing: N, highlightColor: S, noFill: B, curve: N,
    }, ["text"],
    (a) => [{
      op: "add_text", track_id: a.track_id, clip_id: a.clip_id, start: a.start, dur: a.dur, text: a.text, style: a.style,
      x: a.x, y: a.y, fontFamily: a.fontFamily, fontWeight: a.fontWeight, fontSize: a.fontSize, color: a.color,
      strokeColor: a.strokeColor, strokeWidth: a.strokeWidth, shadow: a.shadow, animIn: a.animIn, animOut: a.animOut,
      align: a.align, charSpacing: a.charSpacing, lineSpacing: a.lineSpacing, highlightColor: a.highlightColor,
      noFill: a.noFill, curve: a.curve,
    }]),
  editTool("update_text", "Update a text clip's text, dur, start, x/y or word timings.",
    { ...CLIP, track_id: S, text: S, dur: N, start: N, x: N, y: N, words: { type: "array", items: { type: "object" } } }, ["clip_id"],
    (a) => [{ op: "update_text", clip_id: a.clip_id, track_id: a.track_id, text: a.text, dur: a.dur, start: a.start, x: a.x, y: a.y, words: a.words }]),
  editTool("remove_text", "Remove a text clip from its track.",
    { ...CLIP, track_id: S }, ["clip_id"],
    (a) => [{ op: "remove_text", clip_id: a.clip_id, track_id: a.track_id }]),
  editTool("set_text_style", "Partial-set a text clip's style fields: fontFamily, fontWeight, fontSize, color, strokeColor, strokeWidth, shadow, shadowObj, glowObj, plate, curve, align, charSpacing, lineSpacing, highlightColor, noFill (pass them flat, or under fields). null clears a field.",
    {
      ...CLIP, track_id: S, style: S, fields: { type: "object" },
      fontFamily: S, fontWeight: N, fontSize: N, color: S, strokeColor: S, strokeWidth: N, shadow: B,
      align: S, charSpacing: N, lineSpacing: N, highlightColor: S, noFill: B, curve: N,
      shadowObj: { type: "object" }, glowObj: { type: "object" }, plate: { type: "object" },
    }, ["clip_id"],
    (a) => {
      const flat = Object.fromEntries(
        ["fontFamily", "fontWeight", "fontSize", "color", "strokeColor", "strokeWidth", "shadow", "shadowObj", "glowObj", "plate", "curve", "align", "charSpacing", "lineSpacing", "highlightColor", "noFill"]
          .filter((k) => k in a).map((k) => [k, a[k]]),
      );
      return [{ op: "set_text_style", clip_id: a.clip_id, track_id: a.track_id, style: a.style, fields: { ...flat, ...((a.fields as Record<string, unknown>) ?? {}) } }];
    }),
  editTool("apply_text_preset", "Apply a text preset to a clip: a built-in name (preset: pop-bold/plain/caption) or a fields object captured by save_text_preset.",
    { ...CLIP, track_id: S, preset: S, fields: { type: "object" } }, ["clip_id"],
    (a) => [{ op: "apply_text_preset", clip_id: a.clip_id, track_id: a.track_id, preset: a.preset, fields: a.fields }]),
  readTool("save_text_preset", "Capture a text clip's full style as a named preset payload. User presets in the editor app are browser-local (localStorage), so there is no project field for them — this returns the preset {name, fields} for you to pass back to apply_text_preset (fields) wherever you want it applied.",
    { ...CLIP, name: S }, ["clip_id", "name"],
    (p, a) => ({ name: a.name, fields: captureTextPreset(p as never, String(a.clip_id)), note: "portable preset payload — apply it with apply_text_preset's fields argument" })),
  editTool("set_text_animation", "Set a text clip's animation: animIn/animOut (none/pop/fade/slide/typewriter/word-reveal), animInDur/animOutDur, animLoop (none/wave/pulse/sway).",
    { ...CLIP, track_id: S, animIn: S, animOut: S, animInDur: N, animOutDur: N, animLoop: S }, ["clip_id"],
    (a) => [{
      op: "set_text_animation", clip_id: a.clip_id, track_id: a.track_id,
      ...Object.fromEntries(["animIn", "animOut", "animInDur", "animOutDur", "animLoop"].filter((k) => k in a).map((k) => [k, a[k]])),
    }]),
  {
    name: "captions_from_transcription",
    description:
      "Queue a transcribe job flagged to become captions: payload mirrors the app's transcribe job ({src, clipId}) plus captions: true and the target text track — " +
      "the flag is new with Phase 1; the word-timed attach step (segments → caption clips on that track) is the same attachResults/captions path the app uses when it consumes a finished transcription.",
    inputSchema: {
      type: "object",
      properties: { ...PID, clip_id: S, text_track_id: S },
      required: ["project_id", "clip_id"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const loaded = await loadProjectFull(caller, projectId);
      const project = loaded.row.project;
      const { src } = clipMediaSrc(project, needId(args, "clip_id"));
      let textTrackId = args.text_track_id as string | undefined;
      if (!textTrackId) {
        const tracks = (project as { tracks?: { id: string; kind: string }[] }).tracks ?? [];
        textTrackId = tracks.find((t) => t.kind === "text")?.id;
        if (!textTrackId) throw new Error("this project has no text track for the captions — add_track with kind 'text' first");
      }
      const payload = {
        version: 1, type: "transcribe", src, clipId: args.clip_id,
        captions: true, textTrackId,
      };
      const jobId = await queueJobRow(caller, "transcribe", payload, projectId);
      return { job_id: jobId, note: jobPollNote(jobId) };
    },
  },

  // ---- H. Audio ------------------------------------------------------------------
  editTool("set_clip_volume", "Set a clip's volume (>= 0; 1 = unity).",
    { ...CLIP, track_id: S, volume: N }, ["clip_id", "volume"],
    (a) => [{ op: "set_clip_volume", clip_id: a.clip_id, track_id: a.track_id, volume: a.volume }]),
  editTool("set_volume_keyframes", "Set a clip's volume keyframes [{t, v}] (clip-local seconds → level multiplier); null clears them.",
    { ...CLIP, track_id: S, volume_keys: { type: "array", items: { type: "object" } } }, ["clip_id"],
    (a) => [{ op: "set_volume_keyframes", clip_id: a.clip_id, track_id: a.track_id, volume_keys: "volume_keys" in a ? a.volume_keys : undefined }]),
  editTool("set_fades", "Set a clip's audio fades (fadeIn / fadeOut, seconds).",
    { ...CLIP, track_id: S, fadeIn: N, fadeOut: N }, ["clip_id"],
    (a) => [{
      op: "set_fades", clip_id: a.clip_id, track_id: a.track_id,
      ...Object.fromEntries(["fadeIn", "fadeOut"].filter((k) => k in a).map((k) => [k, a[k]])),
    }]),
  editTool("set_pan", "Set a clip's stereo pan (-1..1).",
    { ...CLIP, track_id: S, pan: N }, ["clip_id", "pan"],
    (a) => [{ op: "set_pan", clip_id: a.clip_id, track_id: a.track_id, pan: a.pan }]),
  editTool("set_eq", "Set a clip's EQ: either the full 6-band parametric set (bands: [{freq, gain, q} × 6]) or legacy low/mid/high gains in dB, which map onto bands 1/3/5 exactly as the editor's eq model does.",
    {
      ...CLIP, track_id: S, low: N, mid: N, high: N,
      bands: { type: "array", items: { type: "object" } },
    }, ["clip_id"],
    (a) => [{ op: "set_eq", clip_id: a.clip_id, track_id: a.track_id, bands: a.bands, low: a.low, mid: a.mid, high: a.high }]),
  editTool("set_denoise", "Toggle render-time noise reduction on a clip.",
    { ...CLIP, track_id: S, denoise: B }, ["clip_id", "denoise"],
    (a) => [{ op: "set_denoise", clip_id: a.clip_id, track_id: a.track_id, denoise: a.denoise }]),
  editTool("set_voice_fx", "Set an audio clip's voice effect: none / echo / hall (render-time).",
    { ...CLIP, track_id: S, voice_fx: S }, ["clip_id", "voice_fx"],
    (a) => [{ op: "set_voice_fx", clip_id: a.clip_id, track_id: a.track_id, voice_fx: a.voice_fx }]),
  {
    name: "separate_voice",
    description:
      "Queue a demucs voice-separation job for a clip's media (payload mirrors the app: {src, clipId}). " +
      "When the job finishes, its vocals stem is registered as media and set as the clip's audioOverride by the consuming side; " +
      "if the clip ALREADY has an override and you pass strength, that strength is applied to it immediately in this call.",
    inputSchema: {
      type: "object",
      properties: { ...PID, ...REV, clip_id: S, strength: N },
      required: ["project_id", "clip_id"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const clipId = needId(args, "clip_id");
      const loaded = await loadProjectFull(caller, projectId);
      const { src } = clipMediaSrc(loaded.row.project, clipId);
      const jobId = await queueJobRow(caller, "separate", { version: 1, type: "separate", src, clipId }, projectId);
      const out: Record<string, unknown> = { job_id: jobId, note: jobPollNote(jobId) };
      if (typeof args.strength === "number") {
        const { clip } = findClipInProject(loaded.row.project as never, clipId);
        if ((clip as { audioOverride?: unknown }).audioOverride) {
          const saved = await applyAndSave(caller, projectId,
            [{ op: "set_audio_override", clip_id: clipId, strength: args.strength }],
            args.expected_revision as number | undefined);
          out.strengthApplied = true;
          out.revision = saved.revision;
        } else {
          out.strengthNote = "strength not applied yet: the clip has no voice stem until this job's result is registered — set it afterwards with a follow-up call once the stem exists";
        }
      }
      return out;
    },
  },
  editTool("set_audio_bus", "Partial-merge the project audio bus: masterGain, normalise, compEnabled, compThreshold, compRatio, compMakeup, ducking {enabled, amount, attack, release}.",
    { audio_bus: { type: "object" } }, ["audio_bus"],
    (a) => [{ op: "set_audio_bus", audio_bus: a.audio_bus }]),

  // ---- I. Analysis & AI jobs -------------------------------------------------------
  {
    name: "transcribe",
    description: "Queue a transcription job for one clip's media (payload mirrors the app exactly: {version, type: 'transcribe', src, clipId}). Word-timed captions land in the job's output; captions_from_transcription is the variant flagged to build caption clips.",
    inputSchema: { type: "object", properties: { ...PID, clip_id: S }, required: ["project_id", "clip_id"] },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const loaded = await loadProjectFull(caller, projectId);
      const { src } = clipMediaSrc(loaded.row.project, needId(args, "clip_id"));
      const jobId = await queueJobRow(caller, "transcribe",
        { version: 1, type: "transcribe", src, clipId: args.clip_id }, projectId);
      return { job_id: jobId, note: jobPollNote(jobId) };
    },
  },
  {
    name: "detect_beats",
    description:
      "Queue beat detection for one media item: beats ride the media-analysis lane (the item requests 'beats', measured server-side by the librosa helper); " +
      "the finished analysis lands beat markers on the timeline when the app attaches results. media_id omitted = the project's first audio/video media.",
    inputSchema: { type: "object", properties: { ...PID, media_id: S }, required: ["project_id"] },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const loaded = await loadProjectFull(caller, projectId);
      const project = loaded.row.project as { canvas?: { fps?: number }; media?: { id: string; src: string; kind: string }[] };
      const media = (project.media ?? []).filter((m) => m.kind === "audio" || m.kind === "video");
      const item = args.media_id
        ? media.find((m) => m.id === args.media_id)
        : media[0];
      if (!item) throw new Error("no audio/video media to detect beats in (or media_id matched none)");
      const payload = {
        version: 1, type: "media-analysis", createdAt: nowIso(), fps: project.canvas?.fps ?? 30,
        items: [{ id: item.id, src: item.src, kind: item.kind, requests: ["beats"] }],
      };
      const jobId = await queueJobRow(caller, "media-analysis", payload, projectId);
      return { job_id: jobId, media_id: item.id, note: jobPollNote(jobId) };
    },
  },
  {
    name: "track_region",
    description:
      "Queue an object-tracking job: seed box in canvas fractions {x, y, w, h} at seed_clip_t (clip-local seconds; mapped to source time by the clip's in/speed, exactly as the app queues it). " +
      "The finished job's keyframes come back on the job row / output for applying to the clip.",
    inputSchema: {
      type: "object",
      properties: { ...PID, clip_id: S, seed_clip_t: N, box: { type: "object" } },
      required: ["project_id", "clip_id", "box"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const clipId = needId(args, "clip_id");
      const loaded = await loadProjectFull(caller, projectId);
      const project = loaded.row.project;
      const { src } = clipMediaSrc(project, clipId);
      const { clip } = findClipInProject(project as never, clipId);
      const box = args.box as { x?: number; y?: number; w?: number; h?: number };
      if (!box || ![box.x, box.y, box.w, box.h].every((v) => typeof v === "number")) {
        throw new Error("argument 'box' must be {x, y, w, h} in canvas fractions");
      }
      const seedClipT = typeof args.seed_clip_t === "number" ? args.seed_clip_t : 0;
      const speed = typeof clip.speed === "number" && clip.speed > 0 ? clip.speed : 1;
      const seedSourceT = Math.round(((clip.in as number ?? 0) + seedClipT * speed) * 1000) / 1000;
      const canvas = (project as { canvas?: { w?: number; h?: number } }).canvas ?? {};
      const payload = {
        version: 1, type: "track", src,
        seed: { t: seedSourceT, x: box.x, y: box.y, w: box.w, h: box.h },
        canvas: { w: canvas.w ?? 720, h: canvas.h ?? 1280 },
        clipId, seedClipT: Math.round(seedClipT * 1000) / 1000,
      };
      const jobId = await queueJobRow(caller, "track", payload, projectId);
      return { job_id: jobId, note: jobPollNote(jobId) };
    },
  },
  {
    name: "compute_reframe",
    description:
      "Queue the smart-reframe computation for a clip: this is the track lane with purpose 'reframe' (the model's design — the tracked path is smoothed on apply and stored as project.reframe, which queue_render's reframe option then consumes). Same seed-box args as track_region.",
    inputSchema: {
      type: "object",
      properties: { ...PID, clip_id: S, seed_clip_t: N, box: { type: "object" } },
      required: ["project_id", "clip_id", "box"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const clipId = needId(args, "clip_id");
      const loaded = await loadProjectFull(caller, projectId);
      const project = loaded.row.project;
      const { src } = clipMediaSrc(project, clipId);
      const { clip } = findClipInProject(project as never, clipId);
      const box = args.box as { x?: number; y?: number; w?: number; h?: number };
      if (!box || ![box.x, box.y, box.w, box.h].every((v) => typeof v === "number")) {
        throw new Error("argument 'box' must be {x, y, w, h} in canvas fractions");
      }
      const seedClipT = typeof args.seed_clip_t === "number" ? args.seed_clip_t : 0;
      const speed = typeof clip.speed === "number" && clip.speed > 0 ? clip.speed : 1;
      const seedSourceT = Math.round(((clip.in as number ?? 0) + seedClipT * speed) * 1000) / 1000;
      const canvas = (project as { canvas?: { w?: number; h?: number } }).canvas ?? {};
      const payload = {
        version: 1, type: "track", src,
        seed: { t: seedSourceT, x: box.x, y: box.y, w: box.w, h: box.h },
        canvas: { w: canvas.w ?? 720, h: canvas.h ?? 1280 },
        clipId, seedClipT: Math.round(seedClipT * 1000) / 1000,
        purpose: "reframe",
      };
      const jobId = await queueJobRow(caller, "track", payload, projectId);
      return { job_id: jobId, note: `Reframe tracking queued. ${jobPollNote(jobId)} Applying the finished result stores project.reframe.` };
    },
  },
  {
    name: "replicate_analyse",
    description:
      "Queue a replicate-an-edit analysis: reference + raw clips already uploaded to the relay (storage paths, e.g. from request_media_upload-style uploads into a job scope). " +
      "Payload mirrors the app exactly ({version, type: 'replicate_analyse', reference, raws}); the result is a cut spec + BPM on the job row.",
    inputSchema: {
      type: "object",
      properties: { reference: S, raws: { type: "array", items: S } },
      required: ["reference"],
    },
    run: async (caller, args) => {
      const reference = args.reference as string;
      if (!reference) throw new Error("argument 'reference' (storage path of the reference video) is required");
      const raws = (args.raws as string[] | undefined) ?? [];
      const jobId = await queueJobRow(caller, "replicate_analyse",
        { version: 1, type: "replicate_analyse", reference, raws });
      return { job_id: jobId, note: jobPollNote(jobId) };
    },
  },
  {
    name: "prompt_edit",
    description:
      "Queue a prompt-edit job: a natural-language instruction + the project JSON inline (the exact PromptEditPayload the app sends). " +
      "The worker's LLM lane returns a schema-validated revised project on the job row — poll with get_job; nothing is applied to the stored project by this tool.",
    inputSchema: {
      type: "object",
      properties: { ...PID, instruction: S },
      required: ["project_id", "instruction"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const instruction = args.instruction as string;
      if (!instruction) throw new Error("argument 'instruction' is required");
      const loaded = await loadProjectFull(caller, projectId);
      const payload = { version: 1, type: "prompt_edit", instruction, project: loaded.row.project };
      const jobId = await queueJobRow(caller, "prompt_edit", payload, projectId);
      return { job_id: jobId, note: jobPollNote(jobId) };
    },
  },

  // ---- J. Jobs & export ------------------------------------------------------------
  {
    name: "queue_render",
    description:
      "Queue a render job for a project. The payload mirrors the app's render bundle exactly (output options + audio bus + optional reframe/range/also-formats/polish); " +
      "the worker resolves the media from the project's own scope, so no bundle upload is needed. exec_lane: 'server' (default) or 'agent' (your own machine claims it via the render-lane tools).",
    inputSchema: {
      type: "object",
      properties: {
        ...PID, exec_lane: S, container: S, codec: S, size: S, fps: N,
        bitrate_mode: S, crf: N, bitrate_kbps: N, range_only: B, reframe: B,
        polish_denoise: N, polish_grain: N, output_name: S,
        also_formats: { type: "array", items: S },
      },
      required: ["project_id"],
    },
    run: async (caller, args) => {
      const projectId = needId(args, "project_id");
      const loaded = await loadProjectFull(caller, projectId);
      const project = loaded.row.project as {
        name?: string; canvas?: { fps?: number };
        rangeIn?: number; rangeOut?: number;
        audioBus?: { normalise?: boolean; masterGain?: number; compEnabled?: boolean };
        reframe?: { points?: unknown };
        tracks?: { clips?: unknown[] }[];
      };
      const clipCount = (project.tracks ?? []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
      if (clipCount === 0) throw new Error("there is nothing to render yet — the timeline has no clips");
      const container = (args.container as string) ?? "mp4";
      const execLaneArg = (args.exec_lane as string) ?? "server";
      if (!["server", "agent"].includes(execLaneArg)) throw new Error("exec_lane must be 'server' or 'agent'");
      const safe = String(project.name ?? "cutlab").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "cutlab";
      const typed = String(args.output_name ?? "").trim().replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").replace(/\.(mp4|mov)$/i, "");
      const filename = `${typed || `${safe}_render`}.${container === "mov" ? "mov" : "mp4"}`;
      const bitrateMode = (args.bitrate_mode as string) ?? "crf";
      const alsoFormats = (args.also_formats as string[] | undefined) ?? [];
      const polishDenoise = args.polish_denoise as number | undefined;
      const polishGrain = args.polish_grain as number | undefined;
      const payload: Record<string, unknown> = {
        version: 1, type: "render", lane: "B", createdAt: nowIso(),
        ...(execLaneArg === "agent" ? { execLane: "agent" } : {}),
        ...(args.reframe && project.reframe ? { reframe: { points: project.reframe.points } } : {}),
        output: {
          container, codec: (args.codec as string) ?? "h264", size: (args.size as string) ?? "canvas",
          filename,
          fps: typeof args.fps === "number" && args.fps > 0 ? args.fps : project.canvas?.fps ?? 30,
          ...(bitrateMode === "crf" ? { crf: (args.crf as number) ?? 18 } : { bitrateKbps: (args.bitrate_kbps as number) ?? 12000 }),
          color: "bt709", stripMetadata: true,
          ...(args.range_only && project.rangeIn != null && project.rangeOut != null
            ? { range: { in: project.rangeIn, out: project.rangeOut } } : {}),
          ...(alsoFormats.length ? { alsoFormats } : {}),
          ...((polishDenoise || polishGrain) ? { polish: { denoise: polishDenoise ?? 0, grain: polishGrain ?? 0 } } : {}),
          audio: {
            normalise: project.audioBus?.normalise ?? true,
            masterGain: project.audioBus?.masterGain ?? 1,
            compressor: project.audioBus?.compEnabled ?? false,
          },
        },
        command: "python3 server/render_job.py <this-bundle.zip> --out render.mp4",
      };
      const jobId = await queueJobRow(caller, "render", payload, projectId);
      return { job_id: jobId, exec_lane: execLaneArg, note: jobPollNote(jobId) };
    },
  },
  {
    name: "queue_job",
    description:
      "Queue ANY worker job type with a payload passthrough (render, media-analysis, transcribe, track, separate, prompt_edit, replicate_analyse, still). " +
      "The payload is checked against the per-type required keys the worker needs; anything missing refuses the insert.",
    inputSchema: {
      type: "object",
      properties: { type: S, payload: { type: "object" }, ...PID },
      required: ["type", "payload"],
    },
    run: async (caller, args) => {
      const type = args.type as string;
      const payload = args.payload as Record<string, unknown>;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("argument 'payload' must be an object");
      const required: Record<string, string[][]> = {
        render: [["output"]],
        "media-analysis": [["items"]],
        transcribe: [["src"], ["items"]],
        track: [["src", "seed"]],
        separate: [["src"], ["items"]],
        prompt_edit: [["instruction"], ["project"]],
        replicate_analyse: [["reference"]],
        still: [["t"]],
      };
      const alternatives = required[type];
      if (!alternatives) {
        throw new Error(`unknown job type '${String(type)}' — one of ${Object.keys(required).join(", ")}`);
      }
      const ok = alternatives.some((group) => group.every((k) => payload[k] !== undefined));
      if (!ok) {
        throw new Error(`payload for a '${type}' job is missing required keys (needs ${alternatives.map((g) => g.join(" + ")).join(" OR ")})`);
      }
      const jobId = await queueJobRow(caller, type,
        { version: 1, type, ...payload },
        args.project_id as string | undefined);
      return { job_id: jobId, note: jobPollNote(jobId) };
    },
  },
  {
    name: "get_job",
    description: "Read one of your job rows (status, payload, result, error).",
    inputSchema: { type: "object", properties: { job_id: S }, required: ["job_id"] },
    run: async (caller, args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      return {
        job_id: job.id, type: job.type, status: job.status, project_id: job.project_id,
        created_at: job.created_at, payload: job.payload, result: job.result,
      };
    },
  },
  {
    name: "list_jobs",
    description: "List your recent jobs (newest first), optionally filtered by status and/or type.",
    inputSchema: { type: "object", properties: { status: S, type: S, limit: N } },
    run: async (caller, args) => {
      const limit = Math.min(100, Math.max(1, (args.limit as number) ?? 50));
      let q = `cutlab_jobs?user_id=eq.${caller.userId}&select=id,type,status,project_id,payload,result,created_at&order=created_at.desc&limit=${limit}`;
      if (args.status) q += `&status=eq.${encodeURIComponent(String(args.status))}`;
      if (args.type) q += `&type=eq.${encodeURIComponent(String(args.type))}`;
      const rows = await restJson<JobRow[]>(q);
      return {
        jobs: rows.map((j) => ({
          job_id: j.id, type: j.type, status: j.status, project_id: j.project_id, created_at: j.created_at,
        })),
      };
    },
  },
  {
    name: "cancel_job",
    description: "Cancel a job that is still queued (a running job is the worker's to finish or fail — cancel only flips queued rows).",
    inputSchema: { type: "object", properties: { job_id: S }, required: ["job_id"] },
    run: async (caller, args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      const rows = await restJson<JobRow[]>(
        `cutlab_jobs?id=eq.${job.id}&status=eq.queued&user_id=eq.${caller.userId}`,
        { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "cancelled", updated_at: nowIso() }) },
      );
      if (!rows.length) throw new Error(`job is not queued (status: ${job.status}) — only queued jobs can be cancelled`);
      return { job_id: job.id, status: "cancelled" };
    },
  },
  {
    name: "get_output_links",
    description: "Signed download URLs for a finished job's outputs (result.outputs).",
    inputSchema: { type: "object", properties: { job_id: S }, required: ["job_id"] },
    run: async (caller, args) => {
      const job = await getOwnJob(caller, needId(args, "job_id"));
      if (job.status !== "done") throw new Error(`job is not done yet (status: ${job.status})`);
      const outputs = ((job.result as { outputs?: { kind?: string; path: string; bytes?: number; format?: string }[] } | null)?.outputs) ?? [];
      if (!outputs.length) throw new Error("this job finished without file outputs (its result carries data, not files — read it with get_job)");
      const links = [];
      for (const o of outputs) {
        links.push({ kind: o.kind ?? "output", path: o.path, bytes: o.bytes ?? null, format: o.format ?? null, url: await signDownload(o.path), expiresInSeconds: SIGN_SECONDS });
      }
      return { job_id: job.id, outputs: links };
    },
  },
];

for (const t of PHASE1_TOOLS) TOOLS.push(t as never);

function assertClaimedBy(caller: Caller, job: JobRow) {
  if (job.status !== "running") throw new Error(`job is not running (status: ${job.status}) — claim it first`);
  const claim = job.payload?.agentClaim as { tokenHash?: string } | undefined;
  if (!claim || claim.tokenHash !== caller.tokenHash) {
    throw new Error("this job was claimed by a different agent/token — the claimer must complete or fail it");
  }
}

// ---------------------------------------------------------------------------
// MCP streamable-HTTP surface (stateless: initialize / ping / tools/*)
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRpc(req: Request): Promise<Response> {
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "request body is not valid JSON");
  }
  const { id, method, params } = msg;
  if (typeof method !== "string") return rpcError(id ?? null, -32600, "invalid request: no method");
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "cutlab-mcp", version: "1.0.0" },
      instructions:
        "CutLab connector. Use list_waiting_render_jobs to find renders queued for you, claim_render_job to take one, " +
        "get_project + get_media_links for its inputs, render with the CutLab renderer package, upload via the claim's " +
        "uploadUrls, then complete_render_job (or fail_render_job with the reason).",
    });
  }
  if (method === "ping") return rpcResult(id, {});

  // Everything past initialize needs the connect token.
  const caller = await authenticate(req);

  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  if (method === "tools/call") {
    const name = params?.name as string | undefined;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `unknown tool '${name ?? ""}'`);
    try {
      const out = await tool.run(caller, (params?.arguments as Args) ?? {});
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    }
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "cutlab-mcp: POST a JSON-RPC request with your clt_ connect token as a Bearer token" } },
      { status: 405 },
    );
  }
  try {
    return await handleRpc(req);
  } catch (e) {
    if (e instanceof HttpError) return rpcError(null, -32001, e.message);
    return rpcError(null, -32603, `internal error: ${e instanceof Error ? e.message : String(e)}`);
  }
});
