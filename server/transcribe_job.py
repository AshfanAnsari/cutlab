#!/usr/bin/env python3
"""
CutLab server job: transcribe.

Bundle contract (job.json):
  {version: 1, type: "transcribe", language?: "hi"|"en"|... (optional;
   omit to auto-detect), items: [{src: "file.mp4"}, ...]}
  bundle = job.json + media/<src>

Runs faster-whisper ('small', CPU int8 — the model is in the local HF
cache) with word timestamps, then phrase-splits segments on word gaps
>= 0.7 s or >= 14 words — the same caption phrases the app author's from
transcription (TextClip.words shape {w, t0, t1}).

Output (--out captions.json):
  {version: 1, items: {src: {language, segments: [{start, end, text,
   words: [{w, t0, t1}]}]}}}

Usage: python3 transcribe_job.py BUNDLE.zip --out captions.json
"""
import argparse, json, os, subprocess, sys, tempfile, wave, zipfile

import numpy as np

MAX_GAP = 0.7
MAX_WORDS = 14


def load_wav_array(path):
    """Decode a 16 kHz mono wav with the stdlib — faster-whisper's own
    file-path decoding hits a PyAV kwarg TypeError on this VM, so the
    model is fed a numpy array instead (the proven local route)."""
    with wave.open(path, "rb") as w:
        frames = w.readframes(w.getnframes())
        sr = w.getframerate()
    arr = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    return arr, sr


def phrases_from_words(words):
    segs = []
    cur = []
    for w in words:
        if cur:
            gap = w["t0"] - cur[-1]["t1"]
            if gap >= MAX_GAP or len(cur) >= MAX_WORDS:
                segs.append(segment(cur))
                cur = []
        cur.append(w)
    if cur:
        segs.append(segment(cur))
    return segs


def segment(ws):
    return {"start": round(ws[0]["t0"], 3), "end": round(ws[-1]["t1"], 3),
            "text": " ".join(w["w"] for w in ws),
            "words": [{"w": w["w"], "t0": round(w["t0"], 3),
                       "t1": round(w["t1"], 3)} for w in ws]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bundle")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    work = tempfile.mkdtemp(prefix="cutlab_transcribe_")
    with zipfile.ZipFile(args.bundle) as z:
        z.extractall(work)
    with open(os.path.join(work, "job.json")) as f:
        job = json.load(f)
    items = job.get("items") or ([{"src": job["src"]}] if job.get("src") else [])
    if not items:
        print("transcribe bundle has no items", file=sys.stderr)
        return 1
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")
    out_items = {}
    for it in items:
        src = it["src"]
        path = os.path.join(work, "media", src)
        # normalise every input to a 16 kHz mono wav, then decode it
        # ourselves (see load_wav_array) — whisper gets samples, not a path
        audio_path = os.path.join(work, f"audio_{os.path.basename(src)}.wav")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", path,
                        "-vn", "-ar", "16000", "-ac", "1", audio_path],
                       check=True)
        samples, _sr = load_wav_array(audio_path)
        segments, info = model.transcribe(
            samples, language=job.get("language") or None,
            word_timestamps=True, vad_filter=True)
        words = []
        for seg in segments:
            for w in (seg.words or []):
                words.append({"w": w.word.strip(), "t0": float(w.start),
                              "t1": float(w.end)})
        out_items[src] = {"language": info.language,
                          "segments": phrases_from_words(words)}
    with open(args.out, "w") as f:
        json.dump({"version": 1, "items": out_items}, f, ensure_ascii=False)
    print(f"transcribed {len(out_items)} item(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
