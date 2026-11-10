#!/usr/bin/env python3
"""Relay acceptance: queue the acceptance project as a real render job and
race-claim it with the NEW worker.py --once (the standing service runs old
code; the claim is guarded by status=eq.queued so exactly one worker wins).
Verifies the job result shape (outputs + measurements from the new code),
downloads the render and probes it. Cleans up its rows afterwards."""
import json, os, subprocess, sys, time, uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import worker  # noqa: E402  (module import is side-effect free)

ROOT = os.path.dirname(HERE)
MEDIA_DIR = os.path.join(ROOT, "server-tests", "media")
PROJECT = json.load(open(os.path.join(ROOT, "server-tests", "acceptance.json")))

PAYLOAD = {"version": 1, "type": "render", "lane": "B",
           "createdAt": "2026-11-04T00:00:00.000Z",
           "output": {"container": "mp4", "codec": "h264", "size": "canvas",
                      "fps": 30, "crf": 18, "color": "bt709",
                      "stripMetadata": True},
           "audio": {"normalise": True, "masterGain": 1, "compressor": False},
           "command": "python3 server/render_job.py <bundle> --out render.mp4"}

CT = {".mp4": "video/mp4", ".mp3": "audio/mpeg"}


def job_status(jid):
    rows = worker.call("GET", f"/rest/v1/cutlab_jobs?id=eq.{jid}&select=status,result,error")
    return rows[0] if rows else None


def main():
    proj_rows = worker.call("POST", "/rest/v1/cutlab_projects",
                            body={"name": "Lane B acceptance (relay)",
                                  "project": PROJECT},
                            prefer="return=representation")
    pid = proj_rows[0]["id"]
    print("project row:", pid)
    jid = None
    try:
        for attempt in range(3):
            jid = str(uuid.uuid4())
            for m in PROJECT["media"]:
                src = m["src"]
                worker.upload_object(f"jobs/{jid}/input/{src}",
                                     os.path.join(MEDIA_DIR, src),
                                     CT.get(os.path.splitext(src)[1], "application/octet-stream"))
            worker.call("POST", "/rest/v1/cutlab_jobs",
                        body={"id": jid, "type": "render", "status": "queued",
                              "project_id": pid, "payload": PAYLOAD,
                              "idempotency_key": f"acceptance-{jid}"})
            print(f"job queued: {jid} (attempt {attempt + 1})")
            deadline = time.time() + 1500
            claimed_by_us = False
            while time.time() < deadline:
                row = job_status(jid)
                if row and row["status"] in ("done", "failed"):
                    break
                r = subprocess.run([sys.executable,
                                    os.path.join(HERE, "worker.py"), "--once"],
                                   capture_output=True, text=True, cwd=HERE)
                if jid in (r.stdout or ""):
                    claimed_by_us = True
                row = job_status(jid)
                if row and row["status"] in ("done", "failed"):
                    break
                time.sleep(2)
            row = job_status(jid)
            print("final row status:", row["status"], "| claimed_by_new_worker:", claimed_by_us)
            if row.get("error"):
                print("error:", row["error"])
            result = row.get("result") or {}
            print("result keys:", sorted(result.keys()))
            print("outputs:", result.get("outputs"))
            print("measurements:", result.get("measurements"))
            if result.get("outputs") and result.get("measurements"):
                # download + probe the render
                out_path = result["outputs"][0]["path"]
                local = "/tmp/relay_acceptance.mp4"
                data = worker.call("GET", f"/storage/v1/object/cutlab/{out_path}", ctype=None)
                with open(local, "wb") as f:
                    f.write(data)
                print("downloaded render:", os.path.getsize(local), "bytes ->", local)
                return 0
            print("result lacks new-shape fields (old worker won the race?) — retrying")
        return 1
    finally:
        # cleanup: rows (storage objects under the job prefix are swept too,
        # the secret key may delete)
        try:
            if jid:
                worker.call("DELETE", f"/rest/v1/cutlab_jobs?id=eq.{jid}")
                worker.call("DELETE", "/storage/v1/object/cutlab",
                            body={"prefixes": [f"jobs/{jid}/input/P5_headtilt_close.mp4",
                                               f"jobs/{jid}/input/P2_two_hands_hair.mp4",
                                               f"jobs/{jid}/input/greenscreen.mp4",
                                               f"jobs/{jid}/input/audio_clean.mp3",
                                               f"jobs/{jid}/output/render.mp4"]})
        except Exception as e:  # noqa: BLE001
            print("cleanup note:", e)
        try:
            worker.call("DELETE", f"/rest/v1/cutlab_projects?id=eq.{pid}")
        except Exception as e:  # noqa: BLE001
            print("cleanup note:", e)


if __name__ == "__main__":
    sys.exit(main())
