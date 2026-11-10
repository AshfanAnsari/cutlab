#!/usr/bin/env python3
"""
CutLab pipeline health check (Phase 3 C5 — support + ops).

One JSON object on stdout:

  {
    "at": "<iso>",
    "ok": true/false,            # every lane healthy
    "worker":  {"service": "active", "pid": ..., "queueDepth": n,
                "oldestQueuedAgeS": ..., "runningHeartbeats": ...},
    "gateway": {"url": "http://127.0.0.1:3001", "reachable": true,
                "httpStatus": 200},
    "mcp":     {"endpoint": ".../functions/v1/cutlab-mcp",
                "serverInfo": "cutlab-mcp", "ok": true},
    "storage": {"objects": n, "bytes": n, "bucketQuotaBytes": 1073741824,
                "headroomBytes": n}
  }

Checks: the systemd worker is active AND its queue is not silently
backing up (depth + oldest age are reported, not judged); the
FreeLLMAPI gateway answers on localhost; the cutlab-mcp Edge Function
answers an MCP initialize with its own name; the bucket is listable
with the service key and its total size is measured against the
shared 1 GB free-tier bucket cap.

Exit code: 0 when every lane reports ok, 1 otherwise — cron/systemd
can alert on the code; the JSON carries the detail.

Relay calls use the connector credential surrogate (the same pattern
as server/worker.py and server-tests/byom_mcp_client.py).
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request  # noqa: E402

BASE = "https://hjdyvaetxhvxzgsdlibt.supabase.co"
HOST = "hjdyvaetxhvxzgsdlibt.supabase.co"
BUCKET = "cutlab"
BUCKET_QUOTA_BYTES = 1024 * 1024 * 1024  # shared free tier: 1 GB
GATEWAY_URL = os.environ.get("FREELLMAPI_URL", "http://127.0.0.1:3001")
MCP_URL = f"{BASE}/functions/v1/cutlab-mcp"
NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def parse_iso(ts):
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except Exception:
        return None


def service(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method)
    add_surrogate_to_request(req, "custom.supabase", allowed_hosts=[HOST])
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=60) as resp:
            text = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(text) if text else None
        except json.JSONDecodeError:
            return e.code, text


# --- worker --------------------------------------------------------------------

def check_worker():
    out = {"ok": False}
    try:
        state = subprocess.run(
            ["systemctl", "is-active", "cutlab-worker.service"],
            capture_output=True, text=True, timeout=15).stdout.strip()
        out["service"] = state
        show = subprocess.run(
            ["systemctl", "show", "cutlab-worker.service",
             "-p", "MainPID", "-p", "ActiveEnterTimestamp"],
            capture_output=True, text=True, timeout=15).stdout
        for line in show.splitlines():
            if line.startswith("MainPID="):
                out["pid"] = int(line.split("=", 1)[1] or 0)
            if line.startswith("ActiveEnterTimestamp="):
                out["activeSince"] = line.split("=", 1)[1]
    except Exception as e:
        out["serviceError"] = str(e)
    try:
        status, rows = service(
            "GET", "/rest/v1/cutlab_jobs?status=eq.queued&select=id,created_at"
                   "&order=created_at.asc&limit=1000")
        if status == 200 and isinstance(rows, list):
            out["queueDepth"] = len(rows)
            if rows:
                oldest = parse_iso(rows[0]["created_at"])
                if oldest:
                    out["oldestQueuedAgeS"] = round(
                        (datetime.now(timezone.utc) - oldest).total_seconds())
        status, running = service(
            "GET", "/rest/v1/cutlab_jobs?status=eq.running"
                   "&select=id,heartbeat_at&order=heartbeat_at.desc&limit=5")
        if status == 200 and isinstance(running, list):
            out["running"] = len(running)
            beats = [parse_iso(r["heartbeat_at"]) for r in running if r.get("heartbeat_at")]
            beats = [b for b in beats if b]
            if beats:
                out["freshestHeartbeatAgeS"] = round(
                    (datetime.now(timezone.utc) - max(beats)).total_seconds())
    except Exception as e:
        out["queueError"] = str(e)
    out["ok"] = out.get("service") == "active"
    return out


# --- gateway --------------------------------------------------------------------

def check_gateway():
    out = {"url": GATEWAY_URL, "reachable": False}
    try:
        req = urllib.request.Request(GATEWAY_URL + "/v1/models", method="GET")
        try:
            with NO_PROXY_OPENER.open(req, timeout=5) as resp:
                out["httpStatus"] = resp.status
        except urllib.error.HTTPError as e:
            # Any HTTP answer (even 401 without a key) proves the process.
            out["httpStatus"] = e.code
        out["reachable"] = True
    except Exception as e:
        out["error"] = str(e)
    out["ok"] = out["reachable"]
    return out


# --- mcp function -----------------------------------------------------------------

def check_mcp():
    out = {"endpoint": MCP_URL, "ok": False}
    try:
        req = urllib.request.Request(
            MCP_URL, method="POST",
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": {}}).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
        name = (data.get("result") or {}).get("serverInfo", {}).get("name")
        out["serverInfo"] = name
        out["ok"] = name == "cutlab-mcp"
    except Exception as e:
        out["error"] = str(e)
    return out


# --- storage ------------------------------------------------------------------------

def check_storage():
    out = {"ok": False, "objects": 0, "bytes": 0}
    total_objects = 0
    total_bytes = 0
    queue = [""]
    try:
        while queue:
            prefix = queue.pop()
            status, entries = service(
                "POST", f"/storage/v1/object/list/{BUCKET}",
                body={"prefix": prefix, "limit": 1000, "offset": 0})
            if status != 200 or not isinstance(entries, list):
                out["error"] = f"list failed at '{prefix}': HTTP {status}"
                return out
            for e in entries:
                if e.get("id") is None:
                    queue.append(f"{prefix}/{e['name']}" if prefix else e["name"])
                else:
                    total_objects += 1
                    total_bytes += (e.get("metadata") or {}).get("size") or 0
            if total_objects > 100000:  # sanity cap; the free bucket cannot grow past this by much
                out["note"] = "walk capped at 100k objects"
                break
        out["objects"] = total_objects
        out["bytes"] = total_bytes
        out["bucketQuotaBytes"] = BUCKET_QUOTA_BYTES
        out["headroomBytes"] = BUCKET_QUOTA_BYTES - total_bytes
        out["ok"] = True
    except Exception as e:
        out["error"] = str(e)
    return out


def main():
    report = {
        "at": now_iso(),
        "worker": check_worker(),
        "gateway": check_gateway(),
        "mcp": check_mcp(),
        "storage": check_storage(),
    }
    report["ok"] = all(report[k].get("ok") for k in ("worker", "gateway", "mcp", "storage"))
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
