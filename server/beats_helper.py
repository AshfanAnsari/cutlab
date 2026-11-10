#!/usr/bin/env python3
"""
CutLab beat-detection helper — runs under ~/reelmimic-venv (librosa lives
there; the system python does not have it). Invoked by make_proxies.py for
media-analysis items requesting "beats".

Usage: beats_helper.py AUDIO.wav
Prints one JSON line: {"bpm": float, "beats": [{"t": seconds, "tier": 1|2}]}

Two-tier discipline (from the house editing studies): tier 1 = strong beats
(onset strength at the beat >= median of beat strengths), tier 2 = the rest.
Only real librosa measurements are reported; on failure the script exits
non-zero and make_proxies records a beatsError instead of fake data.
"""
import json, sys

import librosa
import numpy as np


def main():
    if len(sys.argv) != 2:
        print("usage: beats_helper.py AUDIO.wav", file=sys.stderr)
        return 2
    y, sr = librosa.load(sys.argv[1], sr=22050, mono=True)
    if y.size == 0:
        print(json.dumps({"bpm": 0, "beats": []}))
        return 0
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, units="frames")
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    beats = []
    if len(beat_frames):
        strengths = onset_env[np.minimum(beat_frames, len(onset_env) - 1)]
        med = float(np.median(strengths)) if len(strengths) else 0.0
        times = librosa.frames_to_time(beat_frames, sr=sr)
        for t, s in zip(times, strengths):
            beats.append({"t": round(float(t), 3),
                          "tier": 1 if float(s) >= med else 2})
    bpm = float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo)
    print(json.dumps({"bpm": round(bpm, 2), "beats": beats}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
