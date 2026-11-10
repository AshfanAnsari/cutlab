#!/usr/bin/env python3
"""
CutLab legacy storage sweep — leftovers-sweep item 5 (2026-11-05).

Lists every object in the private `cutlab` bucket and classifies the
pre-Phase-1 legacy paths (jobs/<job_id>/… and projects/<project_id>/…)
against the live relay tables. An object counts as PROVABLY ORPHANED
only when both hold:

  1. its owning job/project id no longer exists in cutlab_jobs /
     cutlab_projects, and
  2. no row in cutlab_jobs / cutlab_projects / cutlab_media references
     the object's full path anywhere in its JSON.

Anything under users/<uid>/… is the current scheme and is never
touched. Anything ambiguous is kept and reported.

  python3 sweep_legacy_storage.py            # dry run (default)
  python3 sweep_legacy_storage.py --delete   # delete provable orphans

Auth rides Muse's credential proxy exactly like worker.py/control.py;
the secret key itself never appears here. Run with the egress proxy env
set: HTTP_PROXY/HTTPS_PROXY=http://hatch-egress-proxy:3128.
"""
import argparse, json, sys, urllib.request, urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

BASE = "https://hjdyvaetxhvxzgsdlibt.supabase.co"
HOST = "hjdyvaetxhvxzgsdlibt.supabase.co"
BUCKET = "cutlab"
TABLES = ["cutlab_jobs", "cutlab_projects", "cutlab_media"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        raise RuntimeError("redirect refused")


def call(method, path, body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    add_surrogate_to_request(r, "custom.supabase", allowed_hosts=[HOST])
    try:
        with urllib.request.build_opener(NoRedirect()).open(r, timeout=120) as resp:
            payload = resp.read()
            return json.loads(payload) if payload else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path} -> {e.code}: {e.read()[:300]!r}") from None


def list_all_objects():
    """Recursively list the bucket. Returns [{path, size}]."""
    out = []

    def walk(prefix):
        rows = call("POST", f"/storage/v1/object/list/{BUCKET}",
                    {"prefix": prefix, "limit": 1000, "offset": 0,
                     "sortBy": {"column": "name", "order": "asc"}}) or []
        for row in rows:
            path = f"{prefix}/{row['name']}" if prefix else row["name"]
            if row.get("id") is None:
                walk(path)
            else:
                out.append({"path": path,
                            "size": (row.get("metadata") or {}).get("size") or 0})

    walk("")
    return out


def fetch_table(table):
    return call("GET", f"/rest/v1/{table}?select=*&limit=1000") or []


def classify(objects, tables):
    job_ids = {str(r["id"]) for r in tables["cutlab_jobs"]}
    project_ids = {str(r["id"]) for r in tables["cutlab_projects"]}
    haystacks = {t: json.dumps(tables[t]) for t in TABLES}

    def referenced(path):
        return [t for t in TABLES if path in haystacks[t]]

    result = {"current": [], "kept_exists": [], "orphans": [], "ambiguous": [], "other": []}
    for obj in objects:
        parts = obj["path"].split("/")
        root = parts[0]
        if root == "users":
            result["current"].append(obj)
            continue
        if root in ("jobs", "projects") and len(parts) >= 2:
            owner = parts[1]
            exists = owner in (job_ids if root == "jobs" else project_ids)
            refs = referenced(obj["path"])
            entry = {**obj, "owner": owner, "refs": refs}
            if exists:
                result["kept_exists"].append(entry)
            elif refs:
                result["ambiguous"].append({**entry, "why":
                    f"owner {owner} gone but path still referenced by {refs}"})
            else:
                result["orphans"].append(entry)
            continue
        result["other"].append(obj)
    return result


def fmt_bytes(n):
    return f"{n:,} B"


def main():
    ap = argparse.ArgumentParser(description="CutLab legacy storage sweep.")
    ap.add_argument("--delete", action="store_true",
                    help="Actually delete provably orphaned objects (default: dry run).")
    ap.add_argument("--out", default=None, help="Write the classification JSON here.")
    args = ap.parse_args()

    objects = list_all_objects()
    tables = {t: fetch_table(t) for t in TABLES}
    res = classify(objects, tables)

    total_bytes = sum(o["size"] for o in objects)
    print(f"bucket '{BUCKET}': {len(objects)} objects, {fmt_bytes(total_bytes)} total")
    print(f"  current scheme (users/…): {len(res['current'])} objects — never touched")
    print(f"  legacy, owner exists:     {len(res['kept_exists'])} objects — kept")
    print(f"  legacy, ambiguous:        {len(res['ambiguous'])} objects — kept")
    print(f"  legacy, other paths:      {len(res['other'])} objects — kept")
    orphan_bytes = sum(o["size"] for o in res["orphans"])
    print(f"  PROVABLY ORPHANED:        {len(res['orphans'])} objects, {fmt_bytes(orphan_bytes)}")
    for o in res["orphans"]:
        print(f"    ORPHAN  {o['path']}  ({fmt_bytes(o['size'])})")
    for o in res["ambiguous"]:
        print(f"    KEPT    {o['path']}  — {o['why']}")
    for o in res["other"]:
        print(f"    OTHER   {o['path']}  ({fmt_bytes(o['size'])})")

    if args.out:
        with open(args.out, "w") as f:
            json.dump(res, f, indent=2)
        print(f"classification written to {args.out}")

    if args.delete:
        if not res["orphans"]:
            print("nothing to delete.")
            return 0
        paths = [o["path"] for o in res["orphans"]]
        for i in range(0, len(paths), 100):
            call("DELETE", f"/storage/v1/object/{BUCKET}", {"prefixes": paths[i:i + 100]})
        print(f"deleted {len(paths)} objects, freed {fmt_bytes(orphan_bytes)}")
        after = {o["path"] for o in list_all_objects()}
        left = [p for p in paths if p in after]
        if left:
            print(f"WARNING: {len(left)} orphan paths still present after delete: {left}")
            return 1
        print("post-delete listing confirms all orphan paths are gone.")
    else:
        print("dry run — nothing deleted. Re-run with --delete to sweep.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
