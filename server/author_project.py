#!/usr/bin/env python3
"""
CutLab Jarvis authoring helper — put a complete project ON the relay,
media included, so the user opens it in the app (Open cloud) and finds
everything there: proxies, thumbnails and waveforms attached, ready to
preview and edit. This is the "Jarvis drives the site" door:

  1. upsert the project JSON into cutlab_projects (client UUID if new)
  2. upload the originals to projects/<project_id>/media/<src>
  3. queue ONE media-analysis job with project_id set — the standing
     worker makes the results pack AND publishes proxy/thumb/peaks into
     projects/<project_id>/... with cutlab_media rows (see worker.py)
  4. wait for the job, then print the project id + name

Usage:
  python3 author_project.py PROJECT.json MEDIA_DIR [--name "Display name"]
                            [--project-id UUID] [--timeout SECONDS]
                            [--user-id UID]

Phase 1: pass --user-id (the owner's auth uid) to author the project
INTO the owner's account — the project row and job are stamped with
it and the originals land under users/<uid>/projects/<pid>/media/,
where the owner's app can read them under the owner-only policies.
Without it, the historical behaviour stands (unowned rows + legacy
projects/<pid>/ paths), and the Phase-1 claim SQL in
supabase/phase1-migration.sql adopts the rows to the owner afterwards.

Auth: the Supabase secret key reaches requests through Muse's credential
proxy (dynamic_credentials surrogate), exactly as in worker.py. The key
itself never appears here. Run with the egress proxy env set, like the
worker unit: HTTP_PROXY/HTTPS_PROXY=http://hatch-egress-proxy:3128.
"""
import argparse, json, os, sys, time, urllib.request, urllib.error, uuid
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

BASE = "https://hjdyvaetxhvxzgsdlibt.supabase.co"
HOST = "hjdyvaetxhvxzgsdlibt.supabase.co"
BUCKET = "cutlab"

CTYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
          ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
          ".webp": "image/webp", ".json": "application/json"}


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


def media_prefix(project_id, user_id):
    return (f"users/{user_id}/projects/{project_id}" if user_id
            else f"projects/{project_id}")


def upload_original(project_id, src, local_path, user_id=None):
    with open(local_path, "rb") as f:
        data = f.read()
    ctype = CTYPES.get(os.path.splitext(src)[1].lower(), "application/octet-stream")
    call("POST", f"/storage/v1/object/{BUCKET}/{media_prefix(project_id, user_id)}/media/{src}",
         raw=data, ctype=ctype, extra_headers={"x-upsert": "true"})


def main():
    ap = argparse.ArgumentParser(description="Author a CutLab project onto the relay, media included.")
    ap.add_argument("project_json", help="project JSON file (PLAN §3 shape)")
    ap.add_argument("media_dir", help="directory holding one file per media entry, named by src")
    ap.add_argument("--name", help="display name (overrides the JSON's name)")
    ap.add_argument("--project-id", help="reuse this cutlab_projects id instead of minting a new one")
    ap.add_argument("--timeout", type=int, default=1200, help="job wait timeout, seconds (default 1200)")
    ap.add_argument("--user-id", default=os.environ.get("CUTLAB_OWNER_UID"),
                    help="owner auth uid to author into (Phase 1); default: "
                         "env CUTLAB_OWNER_UID, else unowned/legacy paths")
    args = ap.parse_args()

    with open(args.project_json) as f:
        project = json.load(f)
    if args.name:
        project["name"] = args.name
    name = project.get("name") or "Untitled project"
    media = project.get("media", [])
    if not media:
        print("project has no media entries — nothing to author", file=sys.stderr)
        return 1

    missing = [m["src"] for m in media
               if not os.path.isfile(os.path.join(args.media_dir, m["src"]))]
    if missing:
        print(f"media files missing from {args.media_dir}: {', '.join(missing)}",
              file=sys.stderr)
        return 1

    project_id = args.project_id or str(uuid.uuid4())
    t0 = time.time()

    call("POST", "/rest/v1/cutlab_projects?on_conflict=id",
         body={"id": project_id, "name": name, "project": project,
               "updated_at": now_iso(),
               **({"user_id": args.user_id} if args.user_id else {})},
         prefer="resolution=merge-duplicates")
    print(f"project row upserted: {project_id} ({name})", flush=True)

    for m in media:
        upload_original(project_id, m["src"], os.path.join(args.media_dir, m["src"]),
                        user_id=args.user_id)
        print(f"  original uploaded: {media_prefix(project_id, args.user_id)}/media/{m['src']}", flush=True)

    job_id = str(uuid.uuid4())
    payload = {
        "version": 1, "type": "media-analysis", "createdAt": now_iso(),
        "fps": (project.get("canvas") or {}).get("fps") or 30,
        "items": [{"id": m["id"], "src": m["src"], "kind": m["kind"],
                   "requests": ["thumbnail"] if m["kind"] == "image"
                   else ["proxy", "thumbnail", "peaks"]}
                  for m in media],
    }
    call("POST", "/rest/v1/cutlab_jobs",
         body={"id": job_id, "type": "media-analysis", "status": "queued",
               "project_id": project_id, "payload": payload,
               **({"user_id": args.user_id} if args.user_id else {})},
         prefer="return=representation")
    print(f"media-analysis job queued: {job_id}", flush=True)

    deadline = t0 + args.timeout
    last = None
    while True:
        rows = call("GET", f"/rest/v1/cutlab_jobs?id=eq.{job_id}&select=status,result,error")
        row = rows[0] if rows else None
        if not row:
            print("job row vanished from the queue", file=sys.stderr)
            return 1
        if row["status"] != last:
            last = row["status"]
            print(f"  job -> {last} ({time.time() - t0:.1f}s)", flush=True)
        if last == "done":
            if (row.get("result") or {}).get("projectSyncError"):
                print(f"WARNING: project publish reported: {row['result']['projectSyncError']}",
                      file=sys.stderr)
            break
        if last == "failed":
            print(f"job failed: {row.get('error')}", file=sys.stderr)
            return 1
        if time.time() > deadline:
            print(f"timed out after {args.timeout}s waiting for the job", file=sys.stderr)
            return 1
        time.sleep(5)

    rows = call("GET", f"/rest/v1/cutlab_media?project_id=eq.{project_id}"
                       "&select=asset_id,src,proxy_path,thumb_path,peaks_path")
    print(f"cutlab_media rows for this project: {len(rows or [])} "
          f"(project media entries: {len(media)})", flush=True)
    print(f"PROJECT_ID {project_id}")
    print(f"PROJECT_NAME {name}")
    print(f"JOB_ID {job_id}")
    print(f"ELAPSED {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
