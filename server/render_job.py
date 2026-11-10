#!/usr/bin/env python3
"""
CutLab server job: render.

Takes a render job bundle (.zip produced by the app: project.json + media/ +
job.json) and renders it with Lane B (render-lane-b/render.py). The bundle's
job.json is passed through (--job) so the renderer honours the export
payload: container/codec/size/fps/crf-or-bitrate, ranged export, also-render
formats and the audio bus settings.

Usage:
  python3 render_job.py RENDER_JOB.zip --out render.mp4

On success the LAST stdout line is the renderer's outputs JSON
({outputs: [{kind, file}...], measurements, timings}); every produced file
sits next to --out. The worker parses that line to upload all outputs.
"""
import argparse, json, os, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
RENDER = os.path.join(HERE, "..", "render-lane-b", "render.py")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    work = tempfile.mkdtemp(prefix="cutlab_render_")
    with zipfile.ZipFile(args.bundle) as z:
        z.extractall(work)
    project = os.path.join(work, "project.json")
    media = os.path.join(work, "media")
    if not os.path.isfile(project):
        print("bundle has no project.json", file=sys.stderr)
        return 1
    job = os.path.join(work, "job.json")
    out = os.path.abspath(args.out)
    cmd = [sys.executable, RENDER, project, "--media", media, "--out", out]
    if os.path.isfile(job):
        cmd += ["--job", job]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.stderr:
        sys.stderr.write(r.stderr)
    if r.returncode != 0:
        return r.returncode
    # forward the renderer's outputs JSON (its last stdout line)
    lines = [ln for ln in (r.stdout or "").strip().splitlines() if ln.strip()]
    payload = None
    for ln in reversed(lines):
        try:
            payload = json.loads(ln)
            break
        except Exception:
            continue
    if payload is None:
        # renderer printed no JSON — fall back to the single historic output
        payload = {"outputs": [{"kind": "render", "file": os.path.basename(out)}]}
    payload["outputs"] = [
        {**o, "path": os.path.join(os.path.dirname(out), o["file"])}
        for o in payload.get("outputs", [])]
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
