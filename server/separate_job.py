#!/usr/bin/env python3
"""
CutLab server job: vocal separation.

Bundle contract (job.json):
  {version: 1, type: "separate", items: [{src: "song.mp3"}, ...]}
  bundle = job.json + media/<src>

Output (--out-dir DIR):
  vocals/<stem>.wav, no_vocals/<stem>.wav per item + manifest.json
  {version: 1, items: {src: {vocals: "vocals/<stem>.wav",
                             noVocals: "no_vocals/<stem>.wav"}}}

HONEST-LANE RULE: separation runs only when demucs is genuinely importable
on this server (checked in-process; torch + demucs are ~2 GB and are NOT
installed today). When unavailable this script exits 3 with the reason
below, and the worker surfaces that text verbatim as the job's error —
no fake stems are ever produced. Unblock: pip install demucs (then this
same script runs htdemucs two-stem separation for real).

Usage: python3 separate_job.py BUNDLE.zip --out-dir DIR
"""
import argparse, importlib.util, json, os, shutil, subprocess, sys, tempfile, zipfile

UNAVAILABLE = ("vocal separation unavailable on this server: demucs is not "
               "installed (no local free lane). Install with: "
               "pip install demucs (about 2 GB incl. torch), then re-queue.")


def demucs_available():
    if importlib.util.find_spec("demucs") is None:
        return False
    if importlib.util.find_spec("torch") is None:
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    if not demucs_available():
        print(UNAVAILABLE, file=sys.stderr)
        return 3
    work = tempfile.mkdtemp(prefix="cutlab_separate_")
    with zipfile.ZipFile(args.bundle) as z:
        z.extractall(work)
    with open(os.path.join(work, "job.json")) as f:
        job = json.load(f)
    items = job.get("items") or ([{"src": job["src"]}] if job.get("src") else [])
    if not items:
        print("separate bundle has no items", file=sys.stderr)
        return 1
    os.makedirs(os.path.join(args.out_dir, "vocals"), exist_ok=True)
    os.makedirs(os.path.join(args.out_dir, "no_vocals"), exist_ok=True)
    manifest = {"version": 1, "items": {}}
    for it in items:
        src = it["src"]
        path = os.path.join(work, "media", src)
        stem = os.path.splitext(os.path.basename(src))[0]
        raw = os.path.join(work, f"demucs_{stem}")
        subprocess.run([sys.executable, "-m", "demucs", "--two-stems", "vocals",
                        "-n", "htdemucs", "-o", raw, path],
                       check=True, capture_output=True, text=True)
        base = os.path.join(raw, "htdemucs", stem)
        voc = os.path.join(base, "vocals.wav")
        nov = os.path.join(base, "no_vocals.wav")
        if not (os.path.isfile(voc) and os.path.isfile(nov)):
            print(f"demucs produced no stems for {src}", file=sys.stderr)
            return 1
        shutil.move(voc, os.path.join(args.out_dir, "vocals", f"{stem}.wav"))
        shutil.move(nov, os.path.join(args.out_dir, "no_vocals", f"{stem}.wav"))
        manifest["items"][src] = {"vocals": f"vocals/{stem}.wav",
                                  "noVocals": f"no_vocals/{stem}.wav"}
    with open(os.path.join(args.out_dir, "manifest.json"), "w") as f:
        json.dump(manifest, f)
    print(f"separated {len(manifest['items'])} item(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
