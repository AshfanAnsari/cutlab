#!/usr/bin/env python3
"""
CutLab server job: motion tracking — runs under ~/reelmimic-venv (OpenCV).

Bundle contract (job.json):
  {version: 1, type: "track", src: "clip.mp4",
   seed: {t: seconds, x, y, w, h}   (canvas fractions of the seed box),
   canvas: {w, h}}
  bundle = job.json + media/<src>

Method: seed a tracker at seed.t (constructor probed at runtime:
CSRT -> KCF -> MIL, else manual template matching in a search window),
then track every frame to the end of the clip. The subject CENTRE is
mapped through the same cover-fit the renderer uses into canvas pixels
and expressed as transform offsets (x/y px from canvas centre). Output is
thinned to every 3rd frame and moving-average smoothed (window 5).
Frames where the tracker loses the subject HOLD the last position and are
counted in `lost` — reported honestly, never interpolated over silently.

Output (--out keyframes.json):
  {version: 1, src, method, tracked, lost,
   keyframes: [{t, x, y}]}   (t = clip-local seconds; x/y = canvas px)

Usage: ~/reelmimic-venv/bin/python track_job.py BUNDLE.zip --out keyframes.json
"""
import argparse, json, os, sys, tempfile, zipfile

import cv2
import numpy as np


def make_tracker():
    for name in ("TrackerCSRT", "TrackerKCF", "TrackerMIL"):
        ctor = getattr(cv2, name, None)
        if ctor is None:
            legacy = getattr(cv2, "legacy", None)
            ctor = getattr(legacy, name, None) if legacy else None
        if ctor is not None:
            try:
                return name, ctor.create()
            except Exception:  # noqa: BLE001 - try the next constructor
                continue
    return "template", None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    work = tempfile.mkdtemp(prefix="cutlab_track_")
    with zipfile.ZipFile(args.bundle) as z:
        z.extractall(work)
    with open(os.path.join(work, "job.json")) as f:
        job = json.load(f)
    src = job["src"]
    seed = job["seed"]
    cw = float(job.get("canvas", {}).get("w", 720))
    ch = float(job.get("canvas", {}).get("h", 1280))
    path = os.path.join(work, "media", src)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(f"cannot open {src}", file=sys.stderr)
        return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    sw = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
    sh = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
    cover = max(cw / sw, ch / sh)
    method, tracker = make_tracker()
    start_frame = max(0, int(float(seed["t"]) * fps))
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    ok, frame = cap.read()
    if not ok:
        print("seed frame unreadable", file=sys.stderr)
        return 1
    box = (float(seed["x"]) * sw, float(seed["y"]) * sh,
           max(4.0, float(seed["w"]) * sw), max(4.0, float(seed["h"]) * sh))
    template = None
    if tracker is not None:
        tracker.init(frame, tuple(int(v) for v in box))
    else:
        x, y, w, h = (int(v) for v in box)
        template = cv2.cvtColor(frame[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY)
    positions = []  # (frame_idx, cx, cy) in source px
    cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
    positions.append((start_frame, cx, cy))
    lost = 0
    idx = start_frame
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        good = False
        if tracker is not None:
            good, nb = tracker.update(frame)
            if good:
                cx, cy = nb[0] + nb[2] / 2, nb[1] + nb[3] / 2
        else:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            rad = int(max(box[2], box[3]) * 0.75)
            x0 = max(0, int(cx - box[2] / 2) - rad)
            y0 = max(0, int(cy - box[3] / 2) - rad)
            x1 = min(sw - template.shape[1], int(cx + box[2] / 2) + rad)
            y1 = min(sh - template.shape[0], int(cy + box[3] / 2) + rad)
            if x1 > x0 and y1 > y0:
                region = gray[y0:y1 + template.shape[0], x0:x1 + template.shape[1]]
                if region.shape[0] >= template.shape[0] and region.shape[1] >= template.shape[1]:
                    res = cv2.matchTemplate(region, template, cv2.TM_CCOEFF_NORMED)
                    _mn, mxv, _nl, loc = cv2.minMaxLoc(res)
                    if mxv > 0.5:
                        cx = x0 + loc[0] + template.shape[1] / 2
                        cy = y0 + loc[1] + template.shape[0] / 2
                        good = True
        if not good:
            lost += 1
        positions.append((idx, cx, cy))
    cap.release()
    # thin to every 3rd frame, smooth (moving average 5), map to canvas offsets
    thin = positions[::3]
    xs = np.array([(p[1] - sw / 2) * cover for p in thin])
    ys = np.array([(p[2] - sh / 2) * cover for p in thin])
    if len(xs) >= 5:
        ker = np.ones(5) / 5
        xs = np.convolve(np.pad(xs, 2, mode="edge"), ker, mode="valid")
        ys = np.convolve(np.pad(ys, 2, mode="edge"), ker, mode="valid")
    keyframes = [{"t": round(p[0] / fps - float(seed["t"]), 3),
                  "x": round(float(xs[i]), 1), "y": round(float(ys[i]), 1)}
                 for i, p in enumerate(thin)]
    out = {"version": 1, "src": src, "method": method,
           "tracked": len(positions), "lost": lost, "keyframes": keyframes}
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"tracked {len(positions)} frames ({method}), lost {lost}, "
          f"{len(keyframes)} keyframes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
