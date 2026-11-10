#!/usr/bin/env python3
"""
CutLab server worker — drains the cutlab_jobs queue in the shared Supabase
project and executes each job with the Lane B machinery on this server.

  media-analysis -> server/make_proxies.py  (proxies / thumbs / peaks pack)
  render         -> server/render_job.py    (Lane B render.py -> MP4)
  transcribe     -> server/transcribe_job.py (faster-whisper -> captions.json)
  track          -> server/track_job.py      (OpenCV in ~/reelmimic-venv)
  separate       -> server/separate_job.py   (demucs if present; otherwise
                     the job fails with a clear "unavailable" reason)
  prompt_edit    -> server/prompt_edit_job.py (LLM lane -> revised.json;
                     needs the jobs-v3 migration: type CHECK + cutlab_tokens)
  replicate_analyse -> server/replicate_job.py (cuts + beats + captions
                     -> spec.json; needs the jobs-v3 migration type CHECK)
  still          -> server/render_job.py    (Lane B still mode: one frame
                     at payload.t as still.jpg|png; Phase 3 contract —
                     job.json output.still = {t, format})

Phase 4 (reliability moat): a successful render also returns a
`verification` object (ffprobe facts + frame grabs at 10/50/90%
uploaded as verify-1..3.jpg) on its result; render-family failures
finish with a structured stage error (result.error = {stage, message,
detail}, error column = "stage=<stage>: <message>") and get ONE
automatic retry with inputs already warm, tracked by the persisted
payload.retryCount (input-missing requeues are separate and unchanged).

Cancellation: setting a queued/running row's status to 'cancelled' (allowed
by supabase/jobs-v2-migration.sql) stops the worker picking it up, and a
running job's subprocess is terminated at the next heartbeat check; the
worker never overwrites a cancelled row (finish() is status-guarded).

Transport contract (see ../DEPLOYMENT.md and supabase/migration.sql):
  in : job row in cutlab_jobs (payload = the job.json), originals in the
       private `cutlab` bucket at jobs/<job_id>/input/<src>
  out: results in the bucket at jobs/<job_id>/output/<file>, and the job row
       updated with status + result (the results-pack manifest for
       media-analysis, an outputs list for renders) or error.

Phase 1 (lockdown + accounts, supabase/phase1-migration.sql): job rows
carry user_id. A user-owned job's objects live in that user's scope —
users/<uid>/jobs/<job_id>/input|output — and project publishing lands
under users/<uid>/projects/<pid>/; jobs with no user_id (pre-Phase-1 /
coordinator-authored) keep the legacy prefixes above, which this
worker still reads and writes for them. The worker runs on the secret
key and bypasses RLS either way; scoping here is about keeping each
user's bytes inside the prefix their policies can reach. Storage caps
mirror src/services/relayAccess.ts + the migration: 50 MB per object,
200 MB per user — the DB trigger enforces the quota at job insert,
and claim time re-checks it (check_user_storage) so a job whose inputs
already crossed the line fails with the reason instead of rendering.

Phase 2 (BYOM, PLAN-PHASE2-BYOM.md): render jobs may carry
payload.execLane = 'agent' — those belong to the owner's own Muse,
which claims/renders/completes them through the cutlab-mcp Edge
Function. claim_oldest() skips them unconditionally; a job without
execLane (or 'server') is this worker's, exactly as before.

Project-scoped publishing (Jarvis control): when a media-analysis job row
carries a project_id, the pack's proxy/thumb/peaks are ALSO copied to
projects/<project_id>/<same pack-relative path> and a cutlab_media row is
upserted per asset, so the app can hydrate the whole project (media
included) from the relay alone. For such jobs the originals may live at
projects/<project_id>/media/<src> (the Jarvis authoring convention,
server/author_project.py); the job-slot input stays the primary source.

Usage:
  python3 worker.py            poll forever (10 s interval, one job at a time)
  python3 worker.py --once     claim and run at most one job, then exit

Auth: the Supabase secret key reaches requests through Muse's credential
proxy (dynamic_credentials surrogate). The key itself never appears here.
"""
import io, json, os, shutil, subprocess, sys, tempfile, threading, time, urllib.request, urllib.error, zipfile
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

BASE = "https://hjdyvaetxhvxzgsdlibt.supabase.co"
HOST = "hjdyvaetxhvxzgsdlibt.supabase.co"
HERE = os.path.dirname(os.path.abspath(__file__))
MAKE_PROXIES = os.path.join(HERE, "make_proxies.py")
RENDER_JOB = os.path.join(HERE, "render_job.py")
TRANSCRIBE_JOB = os.path.join(HERE, "transcribe_job.py")
TRACK_JOB = os.path.join(HERE, "track_job.py")
SEPARATE_JOB = os.path.join(HERE, "separate_job.py")
PROMPT_EDIT_JOB = os.path.join(HERE, "prompt_edit_job.py")
REPLICATE_JOB = os.path.join(HERE, "replicate_job.py")
VENV_PY = os.path.expanduser("~/reelmimic-venv/bin/python")
POLL_SECONDS = 10


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def call(method, path, body=None, raw=None, ctype="application/json", prefer=None,
         extra_headers=None):
    data = raw
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
    if data is not None and ctype:
        headers["Content-Type"] = ctype
    if prefer:
        headers["Prefer"] = prefer
    if extra_headers:
        headers.update(extra_headers)
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(r, "custom.supabase", allowed_hosts=[HOST])
    try:
        with urllib.request.build_opener(NoRedirect()).open(r, timeout=300) as resp:
            payload = resp.read()
            if "application/json" in (resp.headers.get("Content-Type") or ""):
                return json.loads(payload) if payload else None
            return payload
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read()[:400]!r}")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def exec_lane(job):
    """Phase 2 (BYOM): a job's execution lane rides in its payload as
    `execLane` — 'server' (default; this worker) or 'agent' (the owner's
    own Muse renders it via the cutlab-mcp connector; this worker must
    NEVER claim it). The payload's older `lane: 'B'` key names the Lane B
    renderer and is unrelated."""
    return (job.get("payload") or {}).get("execLane") or "server"


def claim_oldest():
    # Scan a window of the oldest queued rows and claim the first one
    # this worker may run — agent-lane rows are skipped in place (they
    # stay queued for the owner's agent) instead of blocking the queue.
    rows = call("GET", "/rest/v1/cutlab_jobs?status=eq.queued"
                       "&order=created_at.asc&limit=10&select=*")
    if not rows:
        return None
    for job in rows:
        if exec_lane(job) == "agent":
            continue
        claimed = call("PATCH",
                       f"/rest/v1/cutlab_jobs?id=eq.{job['id']}&status=eq.queued",
                       body={"status": "running", "claimed_at": now_iso(),
                             "heartbeat_at": now_iso(), "updated_at": now_iso()},
                       prefer="return=representation")
        if claimed:
            return claimed[0]
    return None


def finish(job_id, status, result=None, error=None):
    """Write the terminal state — guarded by status=eq.running so a row the
    user cancelled mid-run is never overwritten."""
    body = {"status": status, "updated_at": now_iso()}
    if result is not None:
        body["result"] = result
    if error is not None:
        body["error"] = error[:2000]
    call("PATCH", f"/rest/v1/cutlab_jobs?id=eq.{job_id}&status=eq.running", body=body)


def finish_failed_structured(job_id, stage_error):
    """Phase 4 terminal write for render-family failures: the structured
    error rides in result (jsonb) AND the error column keeps a readable
    stage-prefixed line for humans scanning the table."""
    finish(job_id, "failed", result={"error": stage_error.to_dict()},
           error=stage_error.readable())


class JobCancelled(Exception):
    pass


def _job_status(job_id):
    rows = call("GET", f"/rest/v1/cutlab_jobs?id=eq.{job_id}&select=status")
    return rows[0]["status"] if rows else None


class JobTimedOut(Exception):
    """D2.6: a job subprocess exceeded its hard time budget and was
    killed — a hung lane must fail its job, never wedge the queue
    (the 2026-11-04 prompt_edit hang)."""
    pass


class StageError(Exception):
    """Phase 4: a failure at a named pipeline stage. Render-family jobs
    (render, still) raise/carry these so the finished row can say WHERE
    it broke: finish() writes result={"error": {stage, message, detail}}
    (the jobs table's result is jsonb) while the text error column gets
    the readable "stage=<stage>: <message>" line. str() includes the
    detail so downstream checks (e.g. input-missing detection) still see
    the underlying storage wording."""

    def __init__(self, stage, message, detail=None):
        super().__init__(message)
        self.stage = stage
        self.message = message
        self.detail = detail

    def to_dict(self):
        return {"stage": self.stage, "message": self.message,
                "detail": self.detail}

    def readable(self):
        text = f"stage={self.stage}: {self.message}"
        if self.detail:
            text += f" — {str(self.detail)[:500]}"
        return text

    __str__ = readable


# Per-type hard budgets (seconds). Renders of long projects get the
# most; LLM-lane jobs are quick or dead.
JOB_TIMEOUTS = {
    "render": 3600,
    "still": 900,
    "separate": 2400,
    "transcribe": 1800,
    "track": 1200,
    "media-analysis": 1200,
    "prompt_edit": 600,
    "replicate_analyse": 600,
}
DEFAULT_JOB_TIMEOUT = 1800

_timed_out = threading.Event()


def _watch(job_id, proc, deadline=None):
    """Heartbeat + cancellation watcher for a running job subprocess.
    D2.6: also enforces the hard deadline — on expiry it kills the
    process and flags _timed_out so run_subprocess can fail the job
    with the reason."""
    while proc.poll() is None:
        time.sleep(5)
        if deadline is not None and time.time() > deadline:
            _timed_out.set()
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
            return
        try:
            if _job_status(job_id) == "cancelled":
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:  # noqa: BLE001
                    proc.kill()
                return
            call("PATCH", f"/rest/v1/cutlab_jobs?id=eq.{job_id}&status=eq.running",
                 body={"heartbeat_at": now_iso()})
        except Exception:  # noqa: BLE001 - the watcher must never kill the job
            pass


def run_subprocess(job_id, cmd, timeout_s=None):
    """Run a job subprocess with heartbeat/cancellation supervision
    and a hard timeout (D2.6). Returns (stdout, stderr); raises
    JobCancelled, JobTimedOut or RuntimeError."""
    budget = timeout_s or DEFAULT_JOB_TIMEOUT
    _timed_out.clear()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True)
    watcher = threading.Thread(target=_watch,
                               args=(job_id, proc, time.time() + budget),
                               daemon=True)
    watcher.start()
    out, err = proc.communicate()
    if _timed_out.is_set():
        raise JobTimedOut(f"job exceeded its {budget}s time budget and was stopped")
    try:
        if _job_status(job_id) == "cancelled":
            raise JobCancelled()
    except JobCancelled:
        raise
    except Exception:  # noqa: BLE001 - status check is best-effort post-run
        pass
    if proc.returncode != 0:
        raise RuntimeError(f"command failed ({proc.returncode}): "
                           f"{os.path.basename(cmd[1] if len(cmd) > 1 else cmd[0])} "
                           f"... {(err or '')[-600:]}")
    return out, err


def job_input_prefix(job):
    """Where this job's uploads live: the owner's scope for user jobs,
    the legacy slot for unowned (pre-Phase-1) jobs."""
    uid = job.get("user_id")
    return f"users/{uid}/jobs/{job['id']}/input" if uid else f"jobs/{job['id']}/input"


def job_output_prefix(job):
    uid = job.get("user_id")
    return f"users/{uid}/jobs/{job['id']}/output" if uid else f"jobs/{job['id']}/output"


def project_scope_prefix(owner_uid, project_id):
    return (f"users/{owner_uid}/projects/{project_id}" if owner_uid
            else f"projects/{project_id}")


def _project_owner_id(project_id):
    """The user_id stamped on a project row (None for unclaimed legacy
    rows / pre-migration relays). Best-effort: any failure reads as
    'no owner' and callers fall back to the legacy prefix."""
    try:
        rows = call("GET", f"/rest/v1/cutlab_projects?id=eq.{project_id}"
                           "&select=user_id")
        return rows[0].get("user_id") if rows else None
    except Exception:  # noqa: BLE001
        return None


def _download_object(path, dest):
    data = call("GET", f"/storage/v1/object/cutlab/{path}", ctype=None)
    with open(dest, "wb") as f:
        f.write(data)


def download_input(job, src, dest):
    """Download one of the job's uploaded inputs. User jobs read their
    scoped slot first; the legacy slot is the fallback so an in-flight
    pre-Phase-1 upload never strands."""
    scoped = f"{job_input_prefix(job)}/{src}"
    legacy = f"jobs/{job['id']}/input/{src}"
    if scoped == legacy:
        _download_object(scoped, dest)
        return
    try:
        _download_object(scoped, dest)
    except Exception:
        _download_object(legacy, dest)


def download_job_input(job, src, dest):
    """Download one job input. Primary source is the job's own upload
    slot; a Jarvis-authored project keeps its originals under the
    project prefix instead, so fall back to there (the owner's scoped
    project prefix first, then the legacy one) when the job carries a
    project_id and the job-slot copy is not there."""
    try:
        download_input(job, src, dest)
        return
    except Exception:
        if not job.get("project_id"):
            raise
    pid = job["project_id"]
    owner = job.get("user_id") or _project_owner_id(pid)
    candidates = []
    if owner:
        candidates.append(f"users/{owner}/projects/{pid}/media/{src}")
    candidates.append(f"projects/{pid}/media/{src}")
    last = None
    for path in candidates:
        try:
            _download_object(path, dest)
            return
        except Exception as e:  # noqa: BLE001 - try the next home
            last = e
    raise last


def upload_object(path, local_path, ctype, upsert=False):
    with open(local_path, "rb") as f:
        data = f.read()
    extra = {"x-upsert": "true"} if upsert else None
    call("POST", f"/storage/v1/object/cutlab/{path}", raw=data, ctype=ctype,
         extra_headers=extra)


def upload_output(job, relpath, local_path, ctype):
    upload_object(f"{job_output_prefix(job)}/{relpath}", local_path, ctype)


def list_object_names(prefix):
    rows = call("POST", "/storage/v1/object/list/cutlab",
                body={"prefix": prefix, "limit": 500})
    return {r["name"] for r in (rows or []) if r.get("id")}


# Phase 1 storage caps — mirror src/services/relayAccess.ts and
# supabase/phase1-migration.sql (bucket file_size_limit + insert trigger).
MAX_OBJECT_BYTES = 50 * 1024 * 1024
USER_QUOTA_BYTES = 200 * 1024 * 1024


def user_storage_usage(uid):
    """(total bytes, biggest object) under users/<uid>/, walking the
    storage list API (folder entries carry no id). Bounded: the walk
    stops counting after 5000 objects — past that the user is over any
    sane quota anyway and the totals stay directionally true."""
    total = biggest = seen = 0
    stack = [f"users/{uid}"]
    while stack:
        prefix = stack.pop()
        rows = call("POST", "/storage/v1/object/list/cutlab",
                    body={"prefix": prefix, "limit": 1000}) or []
        for r in rows:
            if r.get("id"):
                size = int(((r.get("metadata") or {}).get("size")) or 0)
                total += size
                biggest = max(biggest, size)
                seen += 1
                if seen >= 5000:
                    return total, biggest
            elif r.get("name"):
                stack.append(f"{prefix}/{r['name']}")
    return total, biggest


def check_user_storage(job):
    """Claim-time quota re-check for user-owned jobs: fail the job with
    the reason when the owner's stored bytes already cross a cap (the
    insert-time DB trigger is the hard gate; this catches growth the
    trigger cannot see, e.g. outputs that landed after insert). A
    listing failure never wedges the queue — the check is skipped."""
    uid = job.get("user_id")
    if not uid:
        return
    try:
        total, biggest = user_storage_usage(uid)
    except Exception as e:  # noqa: BLE001 - best-effort by design
        print(f"[{now_iso()}] quota check skipped for {job['id']}: {e}",
              flush=True)
        return
    if biggest > MAX_OBJECT_BYTES:
        raise RuntimeError(
            f"storage limit: one of your files is over the "
            f"{MAX_OBJECT_BYTES // (1024 * 1024)} MB per-file limit — "
            f"remove it and try again")
    if total > USER_QUOTA_BYTES:
        raise RuntimeError(
            f"storage quota exceeded: your CutLab files use "
            f"{total // (1024 * 1024)} MB of the "
            f"{USER_QUOTA_BYTES // (1024 * 1024)} MB allowance — "
            f"delete old renders/projects and try again")


CTYPES = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".json": "application/json",
          ".mp3": "audio/mpeg", ".png": "image/png", ".zip": "application/zip",
          ".wav": "audio/wav", ".webm": "video/webm", ".mov": "video/quicktime"}


def publish_to_project(job, items, manifest, packdir):
    """Copy a finished results pack into the project's own relay scope and
    upsert one cutlab_media row per asset, so any browser opening the
    project can hydrate its media (proxy/thumb/peaks) from the relay alone.
    Only runs for jobs whose row carries a project_id. Phase 1: the
    publish scope is the project owner's users/<uid>/projects/<pid>/
    when an owner is known (the job's user_id, else the project row's),
    and the legacy projects/<pid>/ while a project is unclaimed."""
    pid = job["project_id"]
    owner = job.get("user_id") or _project_owner_id(pid)
    root = project_scope_prefix(owner, pid)
    entries = (manifest or {}).get("items", {})
    # Originals may sit in the scoped scope or (pre-Phase-1 authoring)
    # the legacy one — check both before deciding input_path.
    original_homes = {}
    for home in {root, f"projects/{pid}"}:
        try:
            names = list_object_names(f"{home}/media/")
        except Exception:  # noqa: BLE001 - original detection is best-effort
            names = set()
        for n in names:
            original_homes.setdefault(n, home)
    for it in items:
        entry = entries.get(it["src"]) or {}
        row = {"project_id": pid, "asset_id": it["id"], "src": it["src"],
               "kind": it["kind"], "proxy_path": None, "thumb_path": None,
               "peaks_path": None, "input_path": None,
               "user_id": owner}
        copied = False
        for key, field in (("proxy", "proxy_path"), ("thumb", "thumb_path"),
                           ("peaks", "peaks_path")):
            rel = entry.get(key)
            if not rel:
                continue
            dest = f"{root}/{rel}"
            upload_object(dest, os.path.join(packdir, rel),
                          CTYPES.get(os.path.splitext(rel)[1],
                                     "application/octet-stream"),
                          upsert=True)
            row[field] = dest
            copied = True
        if it["src"] in original_homes:
            row["input_path"] = f"{original_homes[it['src']]}/media/{it['src']}"
        if copied or row["input_path"]:
            call("POST", "/rest/v1/cutlab_media?on_conflict=project_id,asset_id",
                 body=row, prefer="resolution=merge-duplicates")


def run_media_analysis(job):
    payload = job["payload"] or {}
    items = payload.get("items", [])
    fps = int(payload.get("fps") or 30)
    with tempfile.TemporaryDirectory() as td:
        media_dir = os.path.join(td, "media")
        os.makedirs(media_dir)
        for it in items:
            download_job_input(job, it["src"], os.path.join(media_dir, it["src"]))
        bundle = os.path.join(td, "bundle.zip")
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("job.json", json.dumps(payload))
            for it in items:
                z.write(os.path.join(media_dir, it["src"]), f"media/{it['src']}")
        results = os.path.join(td, "results.zip")
        run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, MAKE_PROXIES, bundle,
                                   "--out", results, "--fps", str(fps)])
        outdir = os.path.join(td, "pack")
        with zipfile.ZipFile(results) as z:
            z.extractall(outdir)
        manifest = None
        for root, _dirs, files in os.walk(outdir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, outdir)
                upload_output(job, rel, full,
                              CTYPES.get(os.path.splitext(name)[1], "application/octet-stream"))
                if rel == "manifest.json":
                    with open(full) as f:
                        manifest = json.load(f)
        result = {"manifest": manifest, "outputPrefix": f"{job_output_prefix(job)}/"}
        if job.get("project_id"):
            # The job's own results are already safe in the bucket; a failed
            # project publish must not fail the job — record it on the row.
            try:
                publish_to_project(job, items, manifest, outdir)
            except Exception as e:  # noqa: BLE001
                print(f"[{now_iso()}] project publish failed for {job['id']}: {e}",
                      flush=True)
                result["projectSyncError"] = str(e)[:500]
        return result


def _fetch_project(job):
    """The project JSON for a job row's project_id (None when the lookup
    finds nothing). Shared by run_render and run_still."""
    project = None
    if job.get("project_id"):
        rows = call("GET", f"/rest/v1/cutlab_projects?id=eq.{job['project_id']}&select=project")
        if rows:
            project = rows[0]["project"]
    return project


# ---------------------------------------------------------------------------
# Phase 4 — render verification (pure, offline-testable: no relay access;
# the caller supplies the uploader seam).
# ---------------------------------------------------------------------------

def _fps_from_rate(rate):
    """ffprobe frame-rate strings ("30/1", "30000/1001", "0/0") -> float|None."""
    try:
        num, _, den = str(rate).partition("/")
        value = float(num) / float(den) if den else float(num)
        return round(value, 3) if value > 0 else None
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def probe_media(path):
    """ffprobe facts for one media file:
    {duration, video_codec, width, height, fps, size_bytes,
     audio_codec, audio_channels} (video/audio fields None when the
    file has no such stream). Raises on a missing file or a failed
    probe — callers that must not fail (build_verification) catch it."""
    if not os.path.isfile(path):
        raise RuntimeError(f"probe target not found: {path}")
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is not available on this worker")
    r = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries",
         "stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,channels",
         "-show_entries", "format=duration,size", "-of", "json", path],
        capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed ({r.returncode}): {(r.stderr or '')[-300:]}")
    data = json.loads(r.stdout or "{}")
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = data.get("format") or {}
    try:
        duration = float(fmt.get("duration"))
    except (TypeError, ValueError):
        duration = None
    try:
        size_bytes = int(fmt.get("size"))
    except (TypeError, ValueError):
        size_bytes = os.path.getsize(path)
    return {
        "duration": duration,
        "video_codec": video.get("codec_name") if video else None,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "fps": _fps_from_rate((video.get("avg_frame_rate") or video.get("r_frame_rate"))
                              if video else None),
        "size_bytes": size_bytes,
        "audio_codec": audio.get("codec_name") if audio else None,
        "audio_channels": audio.get("channels") if audio else None,
    }


def grab_frames(path, outdir, duration):
    """Sample frames at 10%/50%/90% of `duration` as ~480px-wide JPEGs
    (verify-1.jpg .. verify-3.jpg) inside outdir. Returns the local
    paths that were actually written — a failed grab is skipped, never
    raised, so verification degrades instead of breaking the job."""
    frames = []
    if not duration or duration <= 0:
        return frames
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return frames
    os.makedirs(outdir, exist_ok=True)
    for i, frac in enumerate((0.1, 0.5, 0.9), start=1):
        dest = os.path.join(outdir, f"verify-{i}.jpg")
        r = subprocess.run(
            [ffmpeg, "-v", "error", "-ss", f"{duration * frac:.3f}",
             "-i", path, "-frames:v", "1", "-vf", "scale=480:-2",
             "-q:v", "3", "-y", dest],
            capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and os.path.isfile(dest) and os.path.getsize(dest) > 0:
            frames.append(dest)
    return frames


def build_verification(local_path, uploader):
    """The result.verification object for a finished render: probe_media
    facts + "grabs" (storage paths of the sampled frames). `uploader` is
    a callable(local_path, relpath) -> storage path, invoked while each
    grab file still exists. ANY failure degrades to {"error": "..."} —
    verification must never fail the job it describes."""
    try:
        facts = probe_media(local_path)
    except Exception as e:  # noqa: BLE001 - degrade, never fail the job
        return {"error": str(e)[:500]}
    verification = dict(facts)
    grabs = []
    if facts.get("duration"):
        try:
            with tempfile.TemporaryDirectory() as td:
                for frame in grab_frames(local_path, td, facts["duration"]):
                    rel = os.path.basename(frame)
                    try:
                        stored = uploader(frame, rel) if uploader else rel
                    except Exception:  # noqa: BLE001 - keep the other grabs
                        continue
                    grabs.append(stored or rel)
        except Exception:  # noqa: BLE001 - facts alone are still useful
            grabs = []
    verification["grabs"] = grabs
    return verification


def run_render(job):
    payload = job["payload"] or {}
    try:
        project = _fetch_project(job)
    except Exception as e:  # noqa: BLE001 - stage the failure, don't bare-raise
        raise StageError("bundle", f"project lookup failed: {e}",
                         detail=repr(e)) from e
    if project is None:
        raise StageError("bundle", "render job has no project JSON "
                                   "(project_id lookup failed)")
    with tempfile.TemporaryDirectory() as td:
        # --- stage: bundle (download inputs + zip the job bundle) ---
        try:
            media_dir = os.path.join(td, "media")
            os.makedirs(media_dir)
            for m in project.get("media", []):
                download_input(job, m["src"], os.path.join(media_dir, m["src"]))
            # D1.3(d): fonts + LUTs the app bundled with the job ride into the
            # same media dir — Lane B's FontRegistry walks it and resolve_lut
            # looks for <lutId>.cube at its root.
            bundled = payload.get("bundledAssets") or []
            for name in bundled:
                download_input(job, name, os.path.join(media_dir, name))
            bundle = os.path.join(td, "bundle.zip")
            with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
                z.writestr("project.json", json.dumps(project))
                z.writestr("job.json", json.dumps(payload))
                for m in project.get("media", []):
                    z.write(os.path.join(media_dir, m["src"]), f"media/{m['src']}")
                for name in bundled:
                    z.write(os.path.join(media_dir, name), f"media/{name}")
        except JobCancelled:
            raise
        except Exception as e:  # noqa: BLE001
            raise StageError("bundle", str(e), detail=repr(e)) from e
        # --- stage: render (Lane B via render_job.py) ---
        out_mp4 = os.path.join(td, "render.mp4")
        try:
            stdout, _ = run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, RENDER_JOB, bundle,
                                                   "--out", out_mp4])
        except (JobCancelled, JobTimedOut):
            raise
        except Exception as e:  # noqa: BLE001
            raise StageError("render", str(e), detail=repr(e)) from e
        # render_job's last stdout line is the renderer's outputs JSON:
        # upload EVERY produced file (main render + also-format renders).
        rendered = None
        for ln in reversed([ln for ln in (stdout or "").splitlines() if ln.strip()]):
            try:
                rendered = json.loads(ln)
                break
            except Exception:  # noqa: BLE001
                continue
        # --- stage: upload (every produced file to the output prefix) ---
        outputs = []
        main_local = out_mp4
        try:
            if rendered and rendered.get("outputs"):
                for o in rendered["outputs"]:
                    local = o.get("path") or os.path.join(td, o["file"])
                    name = o["file"]
                    upload_output(job, name, local,
                                  CTYPES.get(os.path.splitext(name)[1],
                                             "application/octet-stream"))
                    entry = {"kind": o.get("kind", "render"),
                             "path": f"{job_output_prefix(job)}/{name}",
                             "bytes": os.path.getsize(local)}
                    if o.get("format"):
                        entry["format"] = o["format"]
                    outputs.append(entry)
                    if entry["kind"] == "render" and len(outputs) == 1:
                        main_local = local
                if outputs and main_local == out_mp4:
                    first = rendered["outputs"][0]
                    main_local = first.get("path") or os.path.join(td, first["file"])
            else:  # historic fallback: the single render.mp4
                upload_output(job, "render.mp4", out_mp4, "video/mp4")
                outputs = [{"kind": "render",
                            "path": f"{job_output_prefix(job)}/render.mp4",
                            "bytes": os.path.getsize(out_mp4)}]
        except Exception as e:  # noqa: BLE001
            raise StageError("upload", str(e), detail=repr(e)) from e
        result = {"outputs": outputs}
        if rendered:
            if rendered.get("measurements"):
                result["measurements"] = rendered["measurements"]
            if rendered.get("timings"):
                result["timings"] = rendered["timings"]
        # --- stage: verify (Phase 4 — NEVER fails the job) ---
        def _verify_uploader(local_frame, rel):
            upload_output(job, rel, local_frame, "image/jpeg")
            return f"{job_output_prefix(job)}/{rel}"

        try:
            result["verification"] = build_verification(main_local,
                                                         _verify_uploader)
        except Exception as e:  # noqa: BLE001 - build_verification already
            result["verification"] = {"error": str(e)[:500]}  # degrades; belt+braces
        return result


def run_still(job):
    """Phase 4 'still' job: render ONE frame of the project at payload.t
    (seconds) as still.jpg|still.png. Builds the same bundle as a render
    (project + media) and invokes the renderer through render_job.py
    with the Phase 3 still contract — job.json carries
    output.still = {t, format} — then uploads the produced still to the
    job output prefix. Result: {outputs: [{kind: 'still', path, bytes}]}."""
    payload = job["payload"] or {}
    if payload.get("t") is None:
        raise StageError("bundle", "still job needs payload.t (seconds into "
                                   "the timeline)")
    try:
        t = float(payload["t"])
    except (TypeError, ValueError):
        raise StageError("bundle", f"still job payload.t is not a number: "
                                   f"{payload.get('t')!r}")
    fmt = str(payload.get("format") or "jpg").lower().lstrip(".")
    if fmt == "jpeg":
        fmt = "jpg"
    if fmt not in ("jpg", "png"):
        raise StageError("bundle", f"still format must be 'jpg' or 'png', "
                                   f"got {payload.get('format')!r}")
    try:
        project = _fetch_project(job)
    except Exception as e:  # noqa: BLE001
        raise StageError("bundle", f"project lookup failed: {e}",
                         detail=repr(e)) from e
    if project is None:
        raise StageError("bundle", "still job has no project JSON "
                                   "(project_id lookup failed)")
    # The renderer-facing payload: today's payload + the still contract.
    still_payload = dict(payload)
    output_opts = dict(payload.get("output") or {})
    output_opts["still"] = {"t": t, "format": fmt}
    still_payload["output"] = output_opts
    with tempfile.TemporaryDirectory() as td:
        # --- stage: bundle ---
        try:
            bundle = build_bundle(job, still_payload, td,
                                  [m["src"] for m in project.get("media", [])],
                                  project=project)
        except JobCancelled:
            raise
        except Exception as e:  # noqa: BLE001
            raise StageError("bundle", str(e), detail=repr(e)) from e
        # --- stage: render (renderer still mode via render_job.py) ---
        out_still = os.path.join(td, f"still.{fmt}")
        try:
            stdout, _ = run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, RENDER_JOB, bundle,
                                                   "--out", out_still])
        except (JobCancelled, JobTimedOut):
            raise
        except Exception as e:  # noqa: BLE001
            raise StageError("render", str(e), detail=repr(e)) from e
        rendered = None
        for ln in reversed([ln for ln in (stdout or "").splitlines() if ln.strip()]):
            try:
                rendered = json.loads(ln)
                break
            except Exception:  # noqa: BLE001
                continue
        local_still = out_still
        if rendered and rendered.get("outputs"):
            first = rendered["outputs"][0]
            local_still = first.get("path") or os.path.join(td, first["file"])
        if not os.path.isfile(local_still):
            raise StageError("render", "renderer produced no still file "
                                       f"(expected {os.path.basename(local_still)})")
        # --- stage: upload (canonical name still.<fmt>) ---
        name = f"still.{fmt}"
        try:
            upload_output(job, name, local_still,
                          CTYPES.get(f".{fmt}", "application/octet-stream"))
        except Exception as e:  # noqa: BLE001
            raise StageError("upload", str(e), detail=repr(e)) from e
        return {"outputs": [{"kind": "still",
                             "path": f"{job_output_prefix(job)}/{name}",
                             "bytes": os.path.getsize(local_still)}]}


def build_bundle(job, payload, td, srcs, project=None):
    """Download the job's inputs and zip a job bundle (job.json + media/,
    plus project.json when given) — the shape every job script consumes."""
    media_dir = os.path.join(td, "media")
    os.makedirs(media_dir)
    for src in srcs:
        download_job_input(job, src, os.path.join(media_dir, src))
    bundle = os.path.join(td, "bundle.zip")
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("job.json", json.dumps(payload))
        if project is not None:
            z.writestr("project.json", json.dumps(project))
        for src in srcs:
            z.write(os.path.join(media_dir, src), f"media/{src}")
    return bundle


def run_transcribe(job):
    payload = job["payload"] or {}
    srcs = [it["src"] for it in payload.get("items", [])]
    if payload.get("src"):
        srcs.append(payload["src"])
    if not srcs:
        raise RuntimeError("transcribe job has no items")
    with tempfile.TemporaryDirectory() as td:
        bundle = build_bundle(job, payload, td, srcs)
        out_json = os.path.join(td, "captions.json")
        run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, TRANSCRIBE_JOB, bundle,
                                   "--out", out_json])
        upload_output(job, "captions.json", out_json, "application/json")
        with open(out_json) as f:
            caps = json.load(f)
        items = {}
        for src, data in (caps.get("items") or {}).items():
            items[src] = {"segments": len(data.get("segments", [])),
                          "language": data.get("language")}
        return {"captions": f"{job_output_prefix(job)}/captions.json",
                "items": items}


def run_track(job):
    payload = job["payload"] or {}
    src = payload.get("src")
    if not src or not payload.get("seed"):
        raise RuntimeError("track job needs src + seed {t,x,y,w,h}")
    with tempfile.TemporaryDirectory() as td:
        bundle = build_bundle(job, payload, td, [src])
        out_json = os.path.join(td, "keyframes.json")
        run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[VENV_PY, TRACK_JOB, bundle, "--out", out_json])
        upload_output(job, "keyframes.json", out_json, "application/json")
        with open(out_json) as f:
            data = json.load(f)
        result = {"keyframesPath": f"{job_output_prefix(job)}/keyframes.json",
                  "count": len(data.get("keyframes", [])),
                  "tracked": data.get("tracked"), "lost": data.get("lost"),
                  "method": data.get("method")}
        if len(data.get("keyframes", [])) <= 120:
            result["keyframes"] = data["keyframes"]
        return result


def run_separate(job):
    payload = job["payload"] or {}
    srcs = [it["src"] for it in payload.get("items", [])]
    if payload.get("src"):
        srcs.append(payload["src"])
    if not srcs:
        raise RuntimeError("separate job has no items")
    with tempfile.TemporaryDirectory() as td:
        bundle = build_bundle(job, payload, td, srcs)
        outdir = os.path.join(td, "stems")
        # separate_job.py exits 3 with a clear reason when no local lane
        # exists; run_subprocess surfaces that text into the job row.
        run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, SEPARATE_JOB, bundle,
                                   "--out-dir", outdir])
        manifest = {}
        mpath = os.path.join(outdir, "manifest.json")
        if os.path.isfile(mpath):
            with open(mpath) as f:
                manifest = json.load(f)
        for root, _dirs, files in os.walk(outdir):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, outdir)
                upload_output(job, rel, full,
                              CTYPES.get(os.path.splitext(name)[1],
                                         "application/octet-stream"))
        items = {}
        for src, entry in (manifest.get("items") or {}).items():
            items[src] = {
                "vocals": f"{job_output_prefix(job)}/{entry['vocals']}",
                "noVocals": f"{job_output_prefix(job)}/{entry['noVocals']}"}
        return {"items": items}


def check_byo_token(payload, job):
    """BYO-Claude gate (Feature 1 §7): a job that PRESENTS a token hash
    must match a registered, unrevoked row in cutlab_tokens. Jobs without
    a hash are the owner's own app and proceed. A presented-but-unknown,
    revoked, or unverifiable (pre-migration) hash refuses the job cleanly —
    never silently proceeds. Phase 1 adds scoping: when both the token
    row and the job carry an account (user_id), they must be the SAME
    account — a token only ever drives its own owner's jobs (the same
    rule as services/byoClaude.ts tokenScopeAllows)."""
    token_hash = (payload or {}).get("tokenHash")
    if not token_hash:
        return
    try:
        rows = call("GET", "/rest/v1/cutlab_tokens?token_hash=eq."
                           f"{token_hash}&select=revoked_at,user_id&limit=1")
    except Exception as e:  # noqa: BLE001 - unverifiable = refused
        raise RuntimeError(f"connect token could not be verified ({e}); "
                           "the job was refused, nothing ran")
    if not rows:
        raise RuntimeError("connect token not recognised by the relay; "
                           "the job was refused, nothing ran")
    if rows[0].get("revoked_at"):
        raise RuntimeError("connect token has been revoked; "
                           "the job was refused, nothing ran")
    token_uid = rows[0].get("user_id")
    job_uid = (job or {}).get("user_id")
    if token_uid and job_uid and token_uid != job_uid:
        raise RuntimeError("connect token belongs to a different account "
                           "than this job; the job was refused, nothing ran")


def run_prompt_edit(job):
    payload = job["payload"] or {}
    check_byo_token(payload, job)
    if not payload.get("instruction") or not payload.get("project"):
        raise RuntimeError("prompt_edit job needs instruction + project")
    with tempfile.TemporaryDirectory() as td:
        bundle = os.path.join(td, "bundle.zip")
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("job.json", json.dumps(payload))
        out_json = os.path.join(td, "revised.json")
        run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, PROMPT_EDIT_JOB, bundle,
                                   "--out", out_json])
        upload_output(job, "revised.json", out_json, "application/json")
        with open(out_json) as f:
            data = json.load(f)
        return {"summary": data.get("summary", ""),
                "revised": f"{job_output_prefix(job)}/revised.json",
                "lane": data.get("lane")}


def run_replicate_analyse(job):
    payload = job["payload"] or {}
    ref_path = payload.get("reference") or ""
    raw_paths = payload.get("raws") or []
    if not ref_path:
        raise RuntimeError("replicate_analyse job needs a reference path")
    # Payload paths are storage paths; the bundle carries basenames.
    ref_name = ref_path.rsplit("/", 1)[-1]
    raw_names = [p.rsplit("/", 1)[-1] for p in raw_paths]
    srcs = [ref_name] + raw_names
    bundle_payload = {"version": 1, "type": "replicate_analyse",
                      "reference": ref_name, "raws": raw_names}
    with tempfile.TemporaryDirectory() as td:
        bundle = build_bundle(job, bundle_payload, td, srcs)
        out_json = os.path.join(td, "spec.json")
        run_subprocess(job["id"], timeout_s=JOB_TIMEOUTS.get(job.get("type"), DEFAULT_JOB_TIMEOUT), cmd=[sys.executable, REPLICATE_JOB, bundle,
                                   "--out", out_json])
        upload_output(job, "spec.json", out_json, "application/json")
        with open(out_json) as f:
            spec = json.load(f)
        return {"spec": f"{job_output_prefix(job)}/spec.json",
                "cuts": len(spec.get("segments", [])),
                "bpm": spec.get("bpm")}


ATTEMPTS = {}
MAX_INPUT_ATTEMPTS = 3
MAX_RENDER_RETRIES = 1
# Job types whose failures are structured (StageError) and eligible for
# the one automatic retry — the render family. Everything else keeps
# the historic plain-string failure behaviour.
RENDER_FAMILY = ("render", "still")


def _is_input_error(error):
    """A missing-input failure (the app uploads inputs around the moment
    the job is queued, so this usually means 'upload still in flight')."""
    text = str(error)
    return "NoSuchKey" in text or "Object not found" in text


def next_failure_action(job, error, attempts=None):
    """Phase 4 pure retry decision: 'requeue-input' | 'requeue-retry' | 'fail'.

    `attempts` is {"input": <input requeues already used>,
                   "retry": <render retries already used>}; either key may
    be omitted — "retry" then falls back to the job's persisted
    payload.retryCount (the counter that survives worker restarts), and
    "input" to 0. A bare int is accepted as the input count.

    Rules: input-missing failures requeue up to MAX_INPUT_ATTEMPTS times
    for ANY job type and never consume the render retry; render-family
    jobs get ONE automatic retry for any other failure; everything else
    fails immediately (today's behaviour)."""
    if attempts is None:
        attempts = {}
    if isinstance(attempts, int):
        attempts = {"input": attempts}
    payload = (job or {}).get("payload") or {}
    try:
        input_used = int(attempts.get("input") or 0)
    except (TypeError, ValueError):
        input_used = 0
    retry_raw = attempts.get("retry", payload.get("retryCount", 0))
    try:
        retry_used = int(retry_raw or 0)
    except (TypeError, ValueError):
        retry_used = 0
    if _is_input_error(error):
        return "requeue-input" if input_used < MAX_INPUT_ATTEMPTS else "fail"
    if (job or {}).get("type") in RENDER_FAMILY and retry_used < MAX_RENDER_RETRIES:
        return "requeue-retry"
    return "fail"


def requeue(job_id, payload=None):
    """Back to 'queued' for another claim. With `payload`, the row's
    payload is rewritten in the same PATCH — how the render retry
    persists payload.retryCount across worker restarts."""
    body = {"status": "queued", "claimed_at": None, "updated_at": now_iso()}
    if payload is not None:
        body["payload"] = payload
    call("PATCH", f"/rest/v1/cutlab_jobs?id=eq.{job_id}&status=eq.running",
         body=body)


def run_one():
    job = claim_oldest()
    if not job:
        return False
    print(f"[{now_iso()}] claimed {job['id']} ({job['type']})", flush=True)
    try:
        check_user_storage(job)
        if job["type"] == "media-analysis":
            result = run_media_analysis(job)
        elif job["type"] == "render":
            result = run_render(job)
        elif job["type"] == "transcribe":
            result = run_transcribe(job)
        elif job["type"] == "track":
            result = run_track(job)
        elif job["type"] == "separate":
            result = run_separate(job)
        elif job["type"] == "prompt_edit":
            result = run_prompt_edit(job)
        elif job["type"] == "replicate_analyse":
            result = run_replicate_analyse(job)
        elif job["type"] == "still":
            result = run_still(job)
        else:
            raise RuntimeError(f"unknown job type {job['type']!r}")
        ATTEMPTS.pop(job["id"], None)
        finish(job["id"], "done", result=result)
        print(f"[{now_iso()}] done {job['id']}", flush=True)
    except JobCancelled:
        # The row already says 'cancelled' (that's why we stopped); the
        # guarded finish() would refuse anyway — just log and move on.
        ATTEMPTS.pop(job["id"], None)
        print(f"[{now_iso()}] cancelled {job['id']} (aborted mid-run)", flush=True)
    except Exception as e:  # noqa: BLE001 - report any failure into the job row
        # Inputs are uploaded by the app around the same moment the job is
        # queued, so a missing input object usually means the upload is still
        # in flight. Requeue a few times before calling it a failure.
        # Phase 4: render-family jobs additionally get ONE automatic retry
        # for non-input failures (inputs are already warm by then), tracked
        # by the persisted payload.retryCount so a worker restart cannot
        # hand out extra retries. next_failure_action() decides; the
        # input-missing budget is in-memory (ATTEMPTS) exactly as before.
        action = next_failure_action(
            job, e, {"input": ATTEMPTS.get(job["id"], 0),
                     "retry": (job.get("payload") or {}).get("retryCount", 0)})
        if action == "requeue-input":
            ATTEMPTS[job["id"]] = ATTEMPTS.get(job["id"], 0) + 1
            requeue(job["id"])
            print(f"[{now_iso()}] input not ready for {job['id']}, "
                  f"requeued (attempt {ATTEMPTS[job['id']]})", flush=True)
            return True
        if action == "requeue-retry":
            ATTEMPTS.pop(job["id"], None)
            new_payload = dict(job.get("payload") or {})
            try:
                new_payload["retryCount"] = int(new_payload.get("retryCount") or 0) + 1
            except (TypeError, ValueError):
                new_payload["retryCount"] = 1
            requeue(job["id"], payload=new_payload)
            print(f"[{now_iso()}] {job['id']} failed ({e}); requeued for its "
                  f"one automatic retry (retryCount="
                  f"{new_payload['retryCount']})", flush=True)
            return True
        ATTEMPTS.pop(job["id"], None)
        if job.get("type") in RENDER_FAMILY:
            stage_error = e if isinstance(e, StageError) else StageError(
                job.get("type") or "render", str(e), detail=repr(e))
            finish_failed_structured(job["id"], stage_error)
        else:
            finish(job["id"], "failed", error=str(e))
        print(f"[{now_iso()}] FAILED {job['id']}: {e}", flush=True)
    return True


_seen_project_updates = {}
_versions_table_ok = None  # None = unprobed, False = migration not run yet
_versions_probe_at = 0.0
# Phase 1 fix (found at the DaVinci deploy, 2026-11-04): the probe used
# to latch False FOREVER when the worker booted before jobs-v4 ran, so
# version snapshots silently never started until a restart. While the
# table is missing, re-probe on this slow cadence instead.
VERSIONS_REPROBE_SECONDS = 300


def snapshot_project_versions():
    """D2.6: cloud-save version history. Saves are client-side, so the
    worker watches cutlab_projects.updated_at and snapshots the JSON
    whenever it changes (table: supabase/jobs-v4-migration.sql). Until
    that migration runs the probe 404s and this stays a no-op (with a
    slow re-probe — see VERSIONS_REPROBE_SECONDS). Best effort
    throughout — versioning must never disturb the job loop. Phase 1:
    snapshots carry the project owner's user_id, like the row itself."""
    global _versions_table_ok, _versions_probe_at
    if _versions_table_ok is False:
        if time.time() - _versions_probe_at < VERSIONS_REPROBE_SECONDS:
            return
        _versions_table_ok = None  # fall through and probe again
    try:
        if _versions_table_ok is None:
            _versions_probe_at = time.time()
            call("GET", "/rest/v1/cutlab_project_versions?select=id&limit=1")
            _versions_table_ok = True
        try:
            rows = call("GET", "/rest/v1/cutlab_projects?select=id,updated_at,project,user_id")
        except Exception:  # noqa: BLE001 - pre-Phase-1 relay has no user_id yet
            rows = call("GET", "/rest/v1/cutlab_projects?select=id,updated_at,project")
        for row in rows or []:
            pid, upd = row.get("id"), row.get("updated_at")
            if not pid or not upd or _seen_project_updates.get(pid) == upd:
                continue
            _seen_project_updates[pid] = upd
            call("POST", "/rest/v1/cutlab_project_versions"
                         "?on_conflict=project_id,source_updated_at",
                 body={"project_id": pid, "project": row.get("project"),
                       "source_updated_at": upd,
                       "user_id": row.get("user_id")},
                 prefer="resolution=ignore-duplicates,return=minimal")
            # Retention: keep the newest 50 per project.
            old = call("GET", "/rest/v1/cutlab_project_versions"
                              f"?project_id=eq.{pid}&select=id"
                              "&order=created_at.desc&offset=50&limit=200")
            for v in old or []:
                call("DELETE", f"/rest/v1/cutlab_project_versions?id=eq.{v['id']}",
                     prefer="return=minimal")
    except Exception as e:  # noqa: BLE001 - best effort by design
        if _versions_table_ok is None and "404" in str(e):
            _versions_table_ok = False
            print(f"[{now_iso()}] project versions: table not deployed yet "
                  f"(run supabase/jobs-v4-migration.sql) — skipping", flush=True)


def main():
    if "--once" in sys.argv:
        run_one()
        return
    print(f"CutLab worker polling every {POLL_SECONDS}s (one job at a time)", flush=True)
    while True:
        try:
            worked = run_one()
        except Exception as e:  # noqa: BLE001 - keep the loop alive
            print(f"[{now_iso()}] poll error: {e}", flush=True)
            worked = False
        if not worked:
            snapshot_project_versions()
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
