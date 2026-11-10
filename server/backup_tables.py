#!/usr/bin/env python3
"""
CutLab table backups (Phase 3 C5 — support + ops).

Exports the six cutlab_ tables to dated JSON under backups/:

    backups/2026-11-05/
      cutlab_projects.json  cutlab_media.json  cutlab_jobs.json
      cutlab_commands.json  cutlab_tokens.json
      cutlab_project_versions.json
      manifest.json         (per-table row counts + sha256 of each file)
      restore.sql           (the drill artifact — see below)

A normal run does all three steps: export, integrity check, restore
SQL generation. Flags: --check-only (verify the newest backup against
the live relay without writing a new one), --dir PATH (target a
specific backup directory).

Integrity check (on the files just written, or the newest backup):
  · every file parses as JSON and is a list of row objects
  · each table's file row count equals the LIVE row count (fetched
    fresh, select=id only) — a backup that drifted from the relay
    while writing is reported, not trusted
  · no duplicate id inside a table
  · FK consistency inside the backup: cutlab_media.project_id,
    cutlab_jobs.project_id and cutlab_project_versions.project_id are
    either NULL or present in the backed-up cutlab_projects ids

Restore drill artifact: restore.sql carries one
INSERT ... ON CONFLICT (id) DO NOTHING per table with every backed-up
row, replayable in the dashboard SQL editor (that is how a restore
would actually run on this stack; the full drill — replay into a
scratch project and compare — is an ops follow-up, documented here
rather than claimed). auth.users themselves are NOT in these tables:
restoring accounts means the GoTrue admin export, out of scope here;
user_id values ride along as data.

Reads use the connector credential surrogate (service key), the same
pattern as server/worker.py. Backups live at base, never in the repo's
public surfaces — token HASHES are inside cutlab_tokens.json.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request  # noqa: E402

BASE = "https://hjdyvaetxhvxzgsdlibt.supabase.co"
HOST = "hjdyvaetxhvxzgsdlibt.supabase.co"
HERE = os.path.dirname(os.path.abspath(__file__))
BACKUPS_ROOT = os.path.join(os.path.dirname(HERE), "backups")
TABLES = [
    "cutlab_projects", "cutlab_media", "cutlab_jobs",
    "cutlab_commands", "cutlab_tokens", "cutlab_project_versions",
]
PAGE = 1000


def service(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    add_surrogate_to_request(req, "custom.supabase", allowed_hosts=[HOST])
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=120) as resp:
        text = resp.read().decode("utf-8", "replace")
        return resp.status, (json.loads(text) if text else None)


def fetch_all(table, columns="*"):
    rows = []
    offset = 0
    while True:
        status, page = service(
            "GET", f"/rest/v1/{table}?select={columns}"
                   f"&order=id.asc&limit={PAGE}&offset={offset}")
        if status != 200 or not isinstance(page, list):
            raise SystemExit(f"read of {table} failed: HTTP {status}: {page}")
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def live_count(table):
    return len(fetch_all(table, columns="id"))


# --- export -----------------------------------------------------------------------

def export_backup(day_dir):
    os.makedirs(day_dir, exist_ok=True)
    manifest = {"generated_at": datetime.now(timezone.utc).isoformat(), "tables": {}}
    data = {}
    for table in TABLES:
        rows = fetch_all(table)
        data[table] = rows
        payload = json.dumps(rows, indent=1, ensure_ascii=False).encode()
        with open(os.path.join(day_dir, f"{table}.json"), "wb") as f:
            f.write(payload)
        manifest["tables"][table] = {
            "rows": len(rows),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
        }
        print(f"export  {table}: {len(rows)} rows, {len(payload)} B")
    with open(os.path.join(day_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    return data, manifest


# --- integrity check ------------------------------------------------------------------

def integrity_check(day_dir, data=None):
    problems = []
    loaded = {}
    for table in TABLES:
        path = os.path.join(day_dir, f"{table}.json")
        try:
            with open(path) as f:
                rows = json.load(f)
        except Exception as e:
            problems.append(f"{table}: file unreadable ({e})")
            continue
        if not isinstance(rows, list):
            problems.append(f"{table}: not a JSON list")
            continue
        loaded[table] = rows
        ids = [r.get("id") for r in rows]
        if len(ids) != len(set(ids)):
            problems.append(f"{table}: duplicate ids inside the backup")
        live = live_count(table)
        if live != len(rows):
            problems.append(f"{table}: backup has {len(rows)} rows, live has {live}")
    project_ids = {r.get("id") for r in loaded.get("cutlab_projects", [])}
    for table in ("cutlab_media", "cutlab_jobs", "cutlab_project_versions"):
        for r in loaded.get(table, []):
            pid = r.get("project_id")
            if pid is not None and pid not in project_ids:
                problems.append(f"{table}: row {r.get('id')} references missing project {pid}")
                break
    if problems:
        print("integrity: PROBLEMS")
        for p in problems:
            print(f"  - {p}")
    else:
        print(f"integrity: OK ({len(loaded)} tables, counts match live, FK references resolve)")
    return problems


# --- restore SQL -------------------------------------------------------------------------

def sql_literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (dict, list)):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def write_restore_sql(day_dir, data):
    lines = [
        "-- CutLab restore drill artifact — generated by server/backup_tables.py",
        f"-- from the backup in this folder ({os.path.basename(day_dir)}).",
        "-- Replay in the Supabase dashboard SQL editor against a project whose",
        "-- cutlab_ schema exists (migration.sql + jobs-v2/v3/v4 + phase1).",
        "-- ON CONFLICT (id) DO NOTHING makes the replay idempotent.",
        "-- NOTE: auth.users are not restored by this file (GoTrue owns them);",
        "-- rows whose user_id names a missing account keep the id as data.",
        "begin;",
    ]
    # parents before children for the project FKs
    order = ["cutlab_projects", "cutlab_tokens", "cutlab_media",
             "cutlab_jobs", "cutlab_commands", "cutlab_project_versions"]
    for table in order:
        rows = data.get(table, [])
        if not rows:
            lines.append(f"-- {table}: no rows")
            continue
        cols = sorted({k for r in rows for k in r.keys()})
        lines.append(f"-- {table}: {len(rows)} rows")
        for r in rows:
            vals = ", ".join(sql_literal(r.get(c)) for c in cols)
            lines.append(
                f"insert into public.{table} ({', '.join(cols)}) values ({vals})"
                " on conflict (id) do nothing;")
    lines.append("commit;")
    path = os.path.join(day_dir, "restore.sql")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"restore.sql: {sum(len(data.get(t, [])) for t in TABLES)} rows across {len(TABLES)} tables")
    return path


def newest_backup_dir():
    if not os.path.isdir(BACKUPS_ROOT):
        return None
    days = sorted(d for d in os.listdir(BACKUPS_ROOT)
                  if os.path.isdir(os.path.join(BACKUPS_ROOT, d)))
    return os.path.join(BACKUPS_ROOT, days[-1]) if days else None


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--check-only", action="store_true",
                    help="verify the newest backup against the live relay; write nothing")
    ap.add_argument("--dir", default=None, help="backup directory (default: today's)")
    args = ap.parse_args()

    if args.check_only:
        day_dir = args.dir or newest_backup_dir()
        if not day_dir:
            print("no backup exists yet — run without --check-only first")
            return 1
        print(f"checking {day_dir}")
        return 1 if integrity_check(day_dir) else 0

    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    day_dir = args.dir or os.path.join(BACKUPS_ROOT, day)
    data, _manifest = export_backup(day_dir)
    problems = integrity_check(day_dir, data)
    write_restore_sql(day_dir, data)
    print(f"backup written to {day_dir}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
