#!/usr/bin/env python3
"""
CutLab server job: replicate_analyse (parked-features plan, Feature 2 §9).

Bundle contract:
  job.json {version: 1, type: "replicate_analyse",
            reference: "<file name>", raws: ["<file name>", ...]}
  media/<reference> + media/<raws>

The reference is ANALYSED, never copied into an output project: this job
measures it and writes a spec the app maps the user's own raw footage
onto. Measurements only — cut points from ffmpeg scene detection, the
beat grid from beats_helper.py (librosa, reelmimic venv), caption phrases
from transcribe_job.py (faster-whisper). Style notes are mechanical
observations (shot length, caption presence, beat offset) and are worded
as such; there is no creative judgement in this file.

Caps (plan open point 3, adopted): reference <= 60 s, raws <= 10 — the
raws are only counted here (mapping is the app's job), the reference cap
is enforced.

Output (--out spec.json):
  {duration, width, height,
   segments: [{start, end, cutType, captionText, captionStart,
               captionEnd, styleNote}],
   bpm, beats: [seconds], captions: [{start, end, text}]}

Usage: python3 replicate_job.py BUNDLE.zip --out spec.json
"""
import argparse, json, os, re, subprocess, sys, tempfile, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
VENV_PY = os.path.expanduser("~/reelmimic-venv/bin/python")
BEATS_HELPER = os.path.join(HERE, "beats_helper.py")
TRANSCRIBE_JOB = os.path.join(HERE, "transcribe_job.py")
MAX_REFERENCE_S = 60.0
MAX_RAWS = 10


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ffprobe(path):
    p = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height",
             "-show_entries", "format=duration",
             "-of", "json", path])
    if p.returncode != 0:
        raise RuntimeError(f"ffprobe failed on the reference: {p.stderr[-300:]}")
    data = json.loads(p.stdout)
    stream = (data.get("streams") or [{}])[0]
    return {
        "duration": float(data["format"]["duration"]),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
    }


def scene_times(path, threshold):
    """Times where ffmpeg's scene score crosses the threshold."""
    p = run(["ffmpeg", "-hide_banner", "-i", path,
             "-vf", f"select='gt(scene,{threshold})',showinfo",
             "-f", "null", "-"])
    times = []
    for m in re.finditer(r"pts_time:([0-9.]+)", p.stderr or ""):
        t = float(m.group(1))
        if t > 0.05 and (not times or t - times[-1] > 0.08):
            times.append(round(t, 3))
    return times


def rgb_jump_times(path):
    """Chroma-aware cut signal the luma-based scene score cannot see
    (a red -> green hard cut has near-identical luma and scores ~0).
    Sample the video at 10 fps downscaled to 16x16 RGB; a large mean-RGB
    jump between consecutive samples is a boundary. Returns
    [(time, distance)] with distance on the 0..441 RGB scale: >= 90 is a
    hard cut, 40..90 a gradual transition."""
    size = 16 * 16 * 3
    p = subprocess.Popen(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
         "-vf", "fps=10,scale=16:16:flags=area,format=rgb24",
         "-f", "rawvideo", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    means = []
    while True:
        frame = p.stdout.read(size)
        if len(frame) < size:
            break
        n = 16 * 16
        means.append((sum(frame[0::3]) / n, sum(frame[1::3]) / n,
                      sum(frame[2::3]) / n))
    p.wait()
    out = []
    for i in range(1, len(means)):
        d = sum((means[i][c] - means[i - 1][c]) ** 2 for c in range(3)) ** 0.5
        if d >= 40:
            out.append((round(i / 10.0, 3), d))
    return out


def beat_grid(path, td):
    """Beat times + BPM via beats_helper (librosa). No audio or a helper
    failure is a normal outcome (bpm None), never a job failure."""
    wav = os.path.join(td, "ref_audio.wav")
    p = run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", path,
             "-vn", "-ac", "1", "-ar", "22050", wav])
    if p.returncode != 0 or not os.path.isfile(wav) or os.path.getsize(wav) < 1000:
        return None, []
    p = run([VENV_PY, BEATS_HELPER, wav], timeout=300)
    if p.returncode != 0:
        return None, []
    try:
        data = json.loads([ln for ln in p.stdout.splitlines() if ln.strip()][-1])
    except Exception:  # noqa: BLE001
        return None, []
    beats = [round(float(b["t"]), 3) for b in data.get("beats", [])]
    bpm = data.get("bpm") or None
    return (float(bpm) if bpm else None), beats


def caption_phrases(bundle_src_dir, ref_name, td):
    """Transcribe the reference by REUSING transcribe_job.py on a bundle
    built for it — one transcription implementation in the codebase."""
    sub = os.path.join(td, "transcribe_bundle.zip")
    job = {"version": 1, "type": "transcribe", "items": [{"src": ref_name}]}
    with zipfile.ZipFile(sub, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("job.json", json.dumps(job))
        z.write(os.path.join(bundle_src_dir, ref_name), f"media/{ref_name}")
    out = os.path.join(td, "captions.json")
    p = run([sys.executable, TRANSCRIBE_JOB, sub, "--out", out], timeout=900)
    if p.returncode != 0 or not os.path.isfile(out):
        return []
    with open(out) as f:
        caps = json.load(f)
    item = (caps.get("items") or {}).get(ref_name) or {}
    return [{"start": round(float(s["start"]), 3),
             "end": round(float(s["end"]), 3),
             "text": s["text"]}
            for s in item.get("segments", []) if s.get("text")]


def length_class(dur):
    if dur < 1.0:
        return "quick cut"
    if dur < 3.0:
        return "short shot"
    if dur < 6.0:
        return "medium shot"
    return "long take"


def style_note(index, start, end, caption, beats):
    parts = [f"{length_class(end - start)} ({end - start:.1f}s)"]
    if caption:
        parts.append("caption overlay present")
    if beats:
        nearest = min(beats, key=lambda b: abs(b - start))
        off = start - nearest
        if abs(off) < 0.05:
            parts.append("starts on a beat")
        else:
            parts.append(f"starts {abs(off):.2f}s {'after' if off > 0 else 'before'} the nearest beat")
    return f"Segment {index + 1}: " + "; ".join(parts) + "."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as td:
        media_dir = os.path.join(td, "media")
        os.makedirs(media_dir)
        with zipfile.ZipFile(args.bundle) as z:
            job = json.loads(z.read("job.json"))
            z.extractall(td)
        ref_name = job.get("reference")
        raws = job.get("raws") or []
        if not ref_name:
            print("replicate job has no reference", file=sys.stderr)
            return 2
        if len(raws) > MAX_RAWS:
            print(f"too many raw clips ({len(raws)} > {MAX_RAWS})", file=sys.stderr)
            return 2
        ref = os.path.join(media_dir, ref_name)
        if not os.path.isfile(ref):
            print(f"reference file missing from bundle: {ref_name}", file=sys.stderr)
            return 2

        info = ffprobe(ref)
        duration = info["duration"]
        if duration > MAX_REFERENCE_S + 0.5:
            print(f"reference is {duration:.1f}s — the cap is {MAX_REFERENCE_S:.0f}s",
                  file=sys.stderr)
            return 2

        strong = scene_times(ref, 0.4)
        soft = scene_times(ref, 0.3)
        # A boundary visible at 0.3 but not 0.4 is a gradual transition —
        # the mechanical best guess for "dissolve" (labelled as analysis,
        # the user edits the spec before building anyway).
        dissolve_at = set(soft) - set(strong)
        boundary_set = set(strong) | set(soft)
        # Merge the chroma signal: an RGB jump near a known boundary
        # confirms it (keep the precise ffmpeg time); a jump nowhere near
        # one is a boundary the luma score missed. Moderate jumps count
        # as gradual transitions.
        for t, dist in rgb_jump_times(ref):
            if any(abs(t - b) <= 0.15 for b in boundary_set):
                continue
            boundary_set.add(t)
            if dist < 90:
                dissolve_at.add(t)
        boundaries = sorted(boundary_set)

        bpm, beats = beat_grid(ref, td)
        captions = caption_phrases(media_dir, ref_name, td)

        points = [0.0] + boundaries + [round(duration, 3)]
        segments = []
        for i in range(len(points) - 1):
            start, end = points[i], points[i + 1]
            if end - start < 0.05:
                continue
            cap = next((c for c in captions
                        if start - 0.01 <= (c["start"] + c["end"]) / 2 < end), None)
            segments.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "cutType": "cut" if i == 0 else ("dissolve" if start in dissolve_at else "cut"),
                "captionText": cap["text"] if cap else None,
                "captionStart": cap["start"] if cap else None,
                "captionEnd": cap["end"] if cap else None,
                "styleNote": style_note(len(segments), start, end, cap, beats),
            })

        spec = {
            "duration": round(duration, 3),
            "width": info["width"],
            "height": info["height"],
            "segments": segments,
            "bpm": bpm,
            "beats": beats,
            "captions": captions,
        }
        with open(args.out, "w") as f:
            json.dump(spec, f)
        print(f"replicate_analyse ok: {len(segments)} segments, "
              f"bpm={bpm}, captions={len(captions)}")
        return 0


if __name__ == "__main__":
    sys.exit(main())
