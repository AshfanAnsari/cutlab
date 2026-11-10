#!/usr/bin/env python3
"""
CutLab server job: media analysis pack.

Takes a media job bundle (.zip produced by the app: job.json + media/) or a
plain folder of media files, and produces a results pack the app can load:

  <out>.zip
    manifest.json            { items: { "<src>": {proxy, thumb, peaks, proxyHasAudio, beats?} } }
    proxies/<stem>.proxy.mp4 360px-wide H.264 proxy (project fps, AAC audio kept)
    thumbs/<stem>.thumb.jpg  320px-wide poster frame
    analysis/<stem>.peaks.json  240 real waveform peaks (0..1)
    analysis/<stem>.beats.json  only for items whose job.json requests include
                                "beats": {bpm, beats: [{t, tier}]} from librosa
                                (~/reelmimic-venv via server/beats_helper.py).
                                On failure the manifest carries beats: null +
                                beatsError — beat data is never fabricated.

Usage:
  python3 make_proxies.py JOB_BUNDLE.zip --out results.zip [--fps 30]
  python3 make_proxies.py MEDIA_DIR      --out results.zip [--fps 30]
"""
import argparse, json, os, struct, subprocess, sys, tempfile, zipfile

VIDEO_EXT = {".mp4", ".mov", ".webm", ".mkv", ".m4v"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".ogg", ".aac"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=False, **kw)
    if r.returncode != 0:
        raise RuntimeError(f"command failed: {' '.join(cmd[:4])}... :: {r.stderr.decode(errors='replace')[-400:]}")
    return r


def probe(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
         "-show_entries", "format=duration", "-of", "json", path],
        capture_output=True, text=True)
    try:
        data = json.loads(r.stdout)
    except Exception:
        return {"duration": 0.0, "has_audio": False}
    return {
        "duration": float(data.get("format", {}).get("duration", 0) or 0),
        "has_audio": any(s.get("codec_type") == "audio" for s in data.get("streams", [])),
    }


def peaks(path, n=240):
    """Real waveform peaks from decoded PCM (stdlib only)."""
    raw = run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "8000",
               "-f", "s16le", "-"]).stdout
    count = len(raw) // 2
    if count == 0:
        return [0.0] * n
    samples = struct.unpack(f"<{count}h", raw[: count * 2])
    block = max(1, count // n)
    out = []
    for i in range(n):
        seg = samples[i * block:(i + 1) * block]
        out.append(round(max((abs(s) for s in seg), default=0) / 32768.0, 3))
    return out


def make_proxy(src, dst, fps):
    run(["ffmpeg", "-y", "-v", "error", "-i", src,
         "-vf", f"scale=360:-2,fps={fps}", "-c:v", "libx264", "-preset", "veryfast",
         "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
         "-movflags", "+faststart", dst])


def make_thumb_video(src, dst, duration):
    at = min(0.5, max(0.0, duration / 2)) if duration else 0
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{at:.3f}", "-i", src,
         "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", dst])


def make_thumb_image(src, dst):
    from PIL import Image
    im = Image.open(src).convert("RGB")
    im.thumbnail((320, 320))
    im.save(dst, "JPEG", quality=82)


VENV_PY = os.path.expanduser("~/reelmimic-venv/bin/python")
BEATS_HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "beats_helper.py")


def decode_audio_8k(src, seconds=120):
    """Mono 8 kHz float samples of a file's audio (first `seconds`).
    Same decode route as the transcribe lane (ffmpeg -> raw samples);
    8 kHz is plenty for alignment and keeps the correlation cheap.
    Returns None when the file has no decodable audio."""
    import numpy as np
    r = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src, "-vn", "-ac", "1",
         "-ar", "8000", "-t", str(seconds), "-f", "f32le", "-"],
        capture_output=True)
    if r.returncode != 0 or len(r.stdout) < 8000:
        return None
    return np.frombuffer(r.stdout, dtype=np.float32).astype(np.float64)


def sync_offsets(media_dir, group):
    """D1.4: per-angle sync offsets via full-signal cross-correlation.

    For each angle, find the lag k maximising sum(anchor[n] * angle[n+k]);
    at that peak the angle's content sits k samples later in its file
    than the anchor's does in its own, so offset = k / 8000 is exactly
    the seconds to add to the anchor's source time to read the same
    moment from the angle. The search is limited to +/-30 s. An angle
    with no audio (or a silent correlation) is reported per-angle in
    `errors` — never given a fabricated offset."""
    import numpy as np
    anchor_src = group.get("anchor")
    angle_srcs = group.get("angles") or []
    if not anchor_src:
        raise RuntimeError("syncGroup has no anchor")
    anchor = decode_audio_8k(os.path.join(media_dir, anchor_src))
    if anchor is None:
        raise RuntimeError(f"anchor {anchor_src} has no decodable audio")
    anchor = anchor - anchor.mean()
    offsets = {anchor_src: 0.0}
    errors = {}
    max_lag = 30 * 8000
    for src in angle_srcs:
        if src == anchor_src:
            continue
        sig = decode_audio_8k(os.path.join(media_dir, src))
        if sig is None:
            errors[src] = "no decodable audio"
            continue
        sig = sig - sig.mean()
        n = 1 << int(np.ceil(np.log2(len(anchor) + len(sig))))
        fa = np.fft.rfft(anchor, n)
        fb = np.fft.rfft(sig, n)
        corr = np.fft.irfft(np.conj(fa) * fb, n)
        # corr[k] for k >= 0: angle delayed by k. Negative lags wrap to
        # the tail of the array. Search the +/- max_lag window only.
        pos = corr[:max_lag + 1]
        neg = corr[n - max_lag:]
        k_pos = int(np.argmax(pos))
        k_neg = int(np.argmax(neg)) - max_lag  # -max_lag..-1
        if pos[k_pos] >= neg[k_neg + max_lag]:
            lag = k_pos
            peak = pos[k_pos]
        else:
            lag = k_neg
            peak = neg[k_neg + max_lag]
        denom = float(np.sqrt((anchor ** 2).sum() * (sig ** 2).sum()))
        strength = peak / denom if denom > 0 else 0.0
        if strength < 0.02:
            errors[src] = f"correlation too weak ({strength:.3f}) — audio may not match the anchor"
            continue
        offsets[src] = round(lag / 8000.0, 4)
    return {"anchor": anchor_src, "offsets": offsets, "errors": errors}


def make_beats(src, dst):
    """Real beat grid via librosa in the reelmimic venv (the system python
    has no librosa). Raises with a clear reason when the lane is missing."""
    if not os.path.isfile(VENV_PY):
        raise RuntimeError("beat lane unavailable: ~/reelmimic-venv not found")
    wav = dst + ".wav"
    run(["ffmpeg", "-y", "-v", "error", "-i", src, "-vn", "-ar", "22050",
         "-ac", "1", wav])
    try:
        r = subprocess.run([VENV_PY, BEATS_HELPER, wav],
                           capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f"beats_helper failed: {r.stderr[-300:]}")
        data = json.loads(r.stdout.strip().splitlines()[-1])
    finally:
        if os.path.isfile(wav):
            os.unlink(wav)
    with open(dst, "w") as f:
        json.dump(data, f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", help="media job bundle .zip or a folder of media files")
    ap.add_argument("--out", required=True, help="results pack .zip to write")
    ap.add_argument("--fps", type=int, default=30, help="proxy frame rate (project fps)")
    args = ap.parse_args()

    work = tempfile.mkdtemp(prefix="cutlab_job_")
    media_dir = args.input
    requests = {}
    sync_group = None
    if args.input.endswith(".zip"):
        with zipfile.ZipFile(args.input) as z:
            z.extractall(work)
        media_dir = os.path.join(work, "media")
        if not os.path.isdir(media_dir):
            media_dir = work
        job_file = os.path.join(work, "job.json")
        if os.path.isfile(job_file):
            try:
                with open(job_file) as f:
                    job = json.load(f)
                for it in job.get("items", []):
                    requests[it.get("src", "")] = it.get("requests", [])
                # D1.4: a multicam sync group rides the same job.
                sync_group = job.get("syncGroup") or None
            except Exception as e:  # noqa: BLE001 - requests are optional
                print(f"job.json requests unreadable: {e}", file=sys.stderr)

    stage = os.path.join(work, "pack")
    for sub in ("proxies", "thumbs", "analysis"):
        os.makedirs(os.path.join(stage, sub), exist_ok=True)

    items = {}
    files = sorted(f for f in os.listdir(media_dir)
                   if os.path.isfile(os.path.join(media_dir, f)))
    if not files:
        print("no media files found in input", file=sys.stderr)
        return 1
    for name in files:
        src = os.path.join(media_dir, name)
        stem, ext = os.path.splitext(name)
        ext = ext.lower()
        entry = {"proxy": None, "thumb": None, "peaks": None, "proxyHasAudio": False}
        try:
            if ext in VIDEO_EXT:
                info = probe(src)
                proxy_rel = f"proxies/{stem}.proxy.mp4"
                make_proxy(src, os.path.join(stage, proxy_rel), args.fps)
                entry["proxy"] = proxy_rel
                entry["proxyHasAudio"] = info["has_audio"]
                thumb_rel = f"thumbs/{stem}.thumb.jpg"
                make_thumb_video(src, os.path.join(stage, thumb_rel), info["duration"])
                entry["thumb"] = thumb_rel
                peaks_rel = f"analysis/{stem}.peaks.json"
                with open(os.path.join(stage, peaks_rel), "w") as f:
                    json.dump(peaks(src), f)
                entry["peaks"] = peaks_rel
                if info["has_audio"] and "beats" in requests.get(name, []):
                    beats_rel = f"analysis/{stem}.beats.json"
                    try:
                        make_beats(src, os.path.join(stage, beats_rel))
                        entry["beats"] = beats_rel
                    except Exception as be:  # noqa: BLE001 - honest failure note
                        entry["beats"] = None
                        entry["beatsError"] = str(be)[:300]
                        print(f"beats FAILED {name}: {be}", file=sys.stderr)
            elif ext in AUDIO_EXT:
                peaks_rel = f"analysis/{stem}.peaks.json"
                with open(os.path.join(stage, peaks_rel), "w") as f:
                    json.dump(peaks(src), f)
                entry["peaks"] = peaks_rel
                if "beats" in requests.get(name, []):
                    beats_rel = f"analysis/{stem}.beats.json"
                    try:
                        make_beats(src, os.path.join(stage, beats_rel))
                        entry["beats"] = beats_rel
                    except Exception as be:  # noqa: BLE001 - honest failure note
                        entry["beats"] = None
                        entry["beatsError"] = str(be)[:300]
                        print(f"beats FAILED {name}: {be}", file=sys.stderr)
            elif ext in IMAGE_EXT:
                thumb_rel = f"thumbs/{stem}.thumb.jpg"
                make_thumb_image(src, os.path.join(stage, thumb_rel))
                entry["thumb"] = thumb_rel
            else:
                print(f"skip (unknown type): {name}")
                continue
        except Exception as e:
            print(f"FAILED {name}: {e}", file=sys.stderr)
            continue
        items[name] = entry
        print(f"ok {name}: proxy={entry['proxy']} thumb={entry['thumb']} peaks={entry['peaks']}")

    manifest = {"version": 1, "items": items}
    if sync_group:
        # D1.4 multicam sync: cross-correlate each angle's audio against
        # the anchor's. Offset sign: seconds to ADD to the anchor's
        # source time to read the same moment from the angle's file
        # (positive = the angle's events sit later in its file).
        try:
            offsets = sync_offsets(media_dir, sync_group)
            sync_rel = "analysis/sync.json"
            with open(os.path.join(stage, sync_rel), "w") as f:
                json.dump(offsets, f, indent=2)
            manifest["sync"] = sync_rel
        except Exception as e:  # noqa: BLE001 - honest failure, never faked
            manifest["sync"] = None
            manifest["syncError"] = str(e)[:300]
            print(f"sync FAILED: {e}", file=sys.stderr)

    with open(os.path.join(stage, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    out_abs = os.path.abspath(args.out)
    with zipfile.ZipFile(out_abs, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, fs in os.walk(stage):
            for fn in fs:
                full = os.path.join(root, fn)
                z.write(full, os.path.relpath(full, stage))
    print(f"wrote {out_abs} ({os.path.getsize(out_abs)} bytes, {len(items)} item(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
