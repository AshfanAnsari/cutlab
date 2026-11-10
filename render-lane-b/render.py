#!/usr/bin/env python3
"""
CutLab — Lane B renderer (v2: full project-model parity).
Takes a CutLab project JSON + a media folder and renders a finished file with
system ffmpeg. Text is rendered as PIL PNG frames (never ffmpeg drawtext).

Usage:
  python3 render.py PROJECT.json --media DIR --out OUT.mp4 [--job JOB.json]

--job carries the app's render-job payload; its `output` object selects
container / codec / size / fps / crf-or-bitrate / I-O range / also-formats and
the audio bus settings (normalise / master gain / compressor). Without --job
the historic defaults apply (MP4, H.264, crf 18, canvas size + fps).

Implements the full client model (src/types.ts): per-track clip trims
(frame-accurate), constant + ramped speed (integrated like the client),
reverse, freeze frames, pitch preserve on/off, transforms + keyframes with
the client's easing library (incl. holds and Bezier), clip effects (the full
shelf), the grade chain (LUT -> primaries/curves composed numerically from
the preview's own maths -> per-band HSL), relight plates, crop / blend modes
/ flips, masks (rect/circle/linear/pen, keyframed geometry, feather),
chroma key + spill, matte-driven alpha, transitions preserving total
duration, PIL text with the full style model (designed shadow, glow, plate,
spacing, per-word colour, karaoke timings, word-reveal, loop animations),
audio from audio tracks AND video clips with track flags (mute/solo/hide),
the three-level volume model (clip x track x bus), volume-line envelopes,
pan / 3-band EQ / denoise / voice FX, bus compressor and -14 LUFS loudnorm.
Documented approximations live in render-lane-b/README.md.
"""
import argparse, json, math, os, random, subprocess, sys, tempfile

# ---------------------------------------------------------------- ffmpeg io
def run(cmd, capture=False):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.stderr.write("FFMPEG FAIL: " + " ".join(cmd[:6]) + " ...\n")
        sys.stderr.write((r.stderr or "")[-3000:] + "\n")
        sys.exit(1)
    return r

def vin(path):
    """Input args for a media file. VP9/WebM alpha is stored as a side
    channel that ffmpeg's NATIVE vp9 decoder silently drops — the libvpx
    decoder reconstructs it. Every .webm the pipeline produces or consumes
    (segments, composites, nest renders) must be read through libvpx, or
    masks/mattes/transparency vanish downstream."""
    if str(path).lower().endswith(".webm"):
        return ["-c:v", "libvpx-vp9", "-i", path]
    return ["-i", path]

def ffprobe_dur(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                        "-of", "csv=p=0", path], capture_output=True, text=True)
    try:
        return float(r.stdout.strip())
    except Exception:
        return 0.0

_media_probe_cache = {}
def probe_media(path):
    """-> dict(has_audio, sample_rate, channels). Cached per path."""
    if path in _media_probe_cache:
        return _media_probe_cache[path]
    r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=sample_rate,channels",
                        "-of", "json", path], capture_output=True, text=True)
    info = {"has_audio": False, "sample_rate": 48000, "channels": 2}
    try:
        streams = json.loads(r.stdout).get("streams", [])
        if streams:
            info["has_audio"] = True
            info["sample_rate"] = int(streams[0].get("sample_rate") or 48000)
            info["channels"] = int(streams[0].get("channels") or 2)
    except Exception:
        pass
    _media_probe_cache[path] = info
    return info

def has_audio(path):
    return probe_media(path)["has_audio"]

# ---------------------------------------------------------------- fonts
# The renderer resolves a clip's font stack against (a) fonts bundled with
# the job (any .ttf/.otf in the media dir, incl. a fonts/ subdir) by family
# name, then (b) server system fonts by family name, then (c) the historic
# weight-based system fallback. A named-but-absent family therefore falls
# back loudly (stderr) instead of silently drifting — see README.
FONT_EXTS = (".ttf", ".otf")

def _font_family(path):
    try:
        from PIL import ImageFont
        f = ImageFont.truetype(path, 16)
        return f.getname()[0]
    except Exception:
        return None

class FontRegistry:
    def __init__(self, media_dir):
        self.by_family = {}
        self.bundled = {}
        roots = []
        if media_dir:
            for root, _dirs, files in os.walk(media_dir):
                for fn in files:
                    if fn.lower().endswith(FONT_EXTS):
                        roots.append(os.path.join(root, fn))
        import glob
        roots += glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)
        roots += glob.glob("/usr/share/fonts/**/*.otf", recursive=True)
        for p in roots:
            fam = _font_family(p)
            if not fam:
                continue
            key = fam.strip().lower()
            bundled = media_dir and os.path.abspath(p).startswith(os.path.abspath(media_dir))
            if key not in self.by_family or bundled:
                self.by_family[key] = p
            if bundled:
                self.bundled[key] = p
        self._warned = set()

    def resolve(self, stack, bold):
        for part in (stack or "").split(","):
            name = part.strip().strip('"').strip("'").strip()
            if not name:
                continue
            p = self.by_family.get(name.lower())
            if p:
                return p
        if stack and stack not in self._warned:
            self._warned.add(stack)
            sys.stderr.write(f"Lane B: font stack {stack!r} not found on server — "
                             "using weight fallback (bundle the .ttf with the job to fix)\n")
        return pick_font(bold)

FONT_CANDIDATES_BOLD = [
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]
FONT_CANDIDATES_REG = [
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]

def pick_font(bold):
    for p in (FONT_CANDIDATES_BOLD if bold else FONT_CANDIDATES_REG):
        if os.path.exists(p):
            return p
    import glob
    g = glob.glob("/usr/share/fonts/**/*.ttf", recursive=True)
    if not g:
        raise RuntimeError("no TTF font found for text rendering")
    bold_first = [x for x in g if "Bold" in os.path.basename(x)]
    return (bold_first[0] if bold and bold_first else g[0])

def resolve_lut(media_dir, lut_id):
    """A clip/project grade names a LUT by id; the .cube file reaches the
    server bundled with the job media (media root or luts/ subdir). Missing
    file -> None (the LUT stage is skipped and logged, never faked)."""
    if not lut_id or not media_dir:
        return None
    for cand in (os.path.join(media_dir, f"{lut_id}.cube"),
                 os.path.join(media_dir, "luts", f"{lut_id}.cube"),
                 os.path.join(media_dir, str(lut_id))):
        if os.path.isfile(cand):
            return cand
    sys.stderr.write(f"Lane B: LUT {lut_id!r} not bundled with the job — LUT stage skipped\n")
    return None

# ------------------------------------------------------- easing (client parity)
# Mirrors src/utils/time.ts applyEase + src/engine/compose.ts interpPts /
# kfValue EXACTLY (same constants, same segment ownership: a segment takes
# the ease of its END point; a hold on the START point flattens it).
def _ease_out_cubic(x):
    return 1 - (1 - x) ** 3

def _ease_in_cubic(x):
    return x ** 3

def _ease_in_out_cubic(x):
    return 4 * x ** 3 if x < 0.5 else 1 - ((-2 * x + 2) ** 3) / 2

def _ease_out_back(x):
    c1, c3 = 1.70158, 2.70158
    return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2

def _ease_out_back_strong(x):
    c = 2.2
    return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2

def _ease_in_back(x):
    c = 1.70158
    return (c + 1) * x ** 3 - c * x ** 2

DEFAULT_BEZIER = (0.33, 0.0, 0.67, 1.0)

def _cubic_bezier_y(x, h):
    x1, y1, x2, y2 = h
    def cx(t):
        return 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
    def cy(t):
        return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3
    t = x
    for _ in range(6):
        err = cx(t) - x
        if abs(err) < 1e-4:
            break
        d = 3 * (1 - t) ** 2 * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2)
        if abs(d) < 1e-5:
            break
        t = min(1.0, max(0.0, t - err / d))
    return cy(t)

def apply_ease(kind, x, handles=None):
    if kind == "easeIn":
        return _ease_in_cubic(x)
    if kind in ("easeOut", "cubicOut"):
        return _ease_out_cubic(x)
    if kind == "easeInOut":
        return _ease_in_out_cubic(x)
    if kind == "reboundOut":
        return _ease_out_back_strong(x)
    if kind == "backIn":
        return _ease_in_back(x)
    if kind == "bezier":
        h = handles or {}
        tup = (float(h.get("x1", DEFAULT_BEZIER[0])), float(h.get("y1", DEFAULT_BEZIER[1])),
               float(h.get("x2", DEFAULT_BEZIER[2])), float(h.get("y2", DEFAULT_BEZIER[3])))
        return _cubic_bezier_y(x, tup)
    return x

def interp_pts(pts, t):
    """pts: [{t, v, ease, hold, handles}] sorted by t. Mirrors compose.interpPts."""
    if not pts:
        return 0.0
    if t <= pts[0]["t"]:
        return pts[0]["v"]
    for i in range(1, len(pts)):
        if t <= pts[i]["t"]:
            p0, p1 = pts[i - 1], pts[i]
            if p1["t"] == p0["t"]:
                return p1["v"]
            if p0.get("hold"):
                return p0["v"]
            x = (t - p0["t"]) / (p1["t"] - p0["t"])
            return p0["v"] + (p1["v"] - p0["v"]) * apply_ease(p1.get("ease"), x, p1.get("handles"))
    return pts[-1]["v"]

def _kf_points(kfs, base, prop, clip_dur=None):
    pts = [{"t": 0.0, "v": float(base)}]
    for k in kfs or []:
        v = k.get(prop)
        if isinstance(v, (int, float)):
            pts.append({"t": float(k["t"]), "v": float(v), "ease": k.get("ease"),
                        "hold": k.get("hold"), "handles": k.get("easeHandles")})
    pts.sort(key=lambda p: p["t"])
    if clip_dur is not None and pts[-1]["t"] < clip_dur:
        pts.append({"t": float(clip_dur), "v": pts[-1]["v"]})
    return pts

def kf_value(kfs, base_tr, prop, t, clip_dur):
    """Transform property at clip-local time t (mirrors compose.kfValue)."""
    base = base_tr[prop]
    if not kfs:
        return float(base)
    return interp_pts(_kf_points(kfs, base, prop, clip_dur), t)

def mask_at(clip, t):
    """Mask geometry {x,y,w,h} at local time t (mirrors compose.maskAt)."""
    base = clip.get("mask")
    if not base:
        return None
    kfs = clip.get("keyframes") or []
    if not any(k.get("mask") for k in kfs):
        return {p: float(base.get(p, 0)) for p in ("x", "y", "w", "h")}
    out = {}
    for prop in ("x", "y", "w", "h"):
        pts = [{"t": 0.0, "v": float(base.get(prop, 0))}]
        for k in kfs:
            m = k.get("mask")
            if m and isinstance(m.get(prop), (int, float)):
                pts.append({"t": float(k["t"]), "v": float(m[prop]), "ease": k.get("ease"),
                            "hold": k.get("hold"), "handles": k.get("easeHandles")})
        pts.sort(key=lambda p: p["t"])
        out[prop] = interp_pts(pts, t)
    return out

def effect_value_at(clip, etype, t):
    """One effect's value at local time t (mirrors compose.effectValueAt)."""
    stat = None
    for e in clip.get("effects") or []:
        if e.get("type") == etype:
            stat = e
            break
    if stat is None:
        return None
    base = float(stat.get("value", 0))
    kfs = clip.get("keyframes") or []
    if not any((k.get("fx") or {}).get(etype) is not None for k in kfs):
        return base
    pts = [{"t": 0.0, "v": base}]
    for k in kfs:
        fx = k.get("fx") or {}
        if isinstance(fx.get(etype), (int, float)):
            pts.append({"t": float(k["t"]), "v": float(fx[etype]), "ease": k.get("ease"),
                        "hold": k.get("hold"), "handles": k.get("easeHandles")})
    pts.sort(key=lambda p: p["t"])
    return interp_pts(pts, t)

# ------------------------------------------------------------- speed (client parity)
# Mirrors src/types.ts speedAtSource / speedDuration and compose.buildSpeedMap.
def speed_at_source(keys, s):
    if not keys:
        return 1.0
    ks = sorted(keys, key=lambda k: float(k["t"]))
    if s <= float(ks[0]["t"]):
        return float(ks[0]["speed"])
    for i in range(1, len(ks)):
        if s <= float(ks[i]["t"]):
            a, b = ks[i - 1], ks[i]
            if float(b["t"]) == float(a["t"]):
                return float(b["speed"])
            f = (s - float(a["t"])) / (float(b["t"]) - float(a["t"]))
            return float(a["speed"]) + (float(b["speed"]) - float(a["speed"])) * f
    return float(ks[-1]["speed"])

def speed_duration(span, keys):
    n = 240
    total = 0.0
    for i in range(n):
        s0 = (i / n) * span
        s1 = ((i + 1) / n) * span
        v = max(0.05, speed_at_source(keys, (s0 + s1) / 2))
        total += (s1 - s0) / v
    return total

class SpeedMap:
    """Timeline<->source map for one media clip (source offsets are relative
    to the clip's in-point, exactly like compose.buildSpeedMap)."""
    STEPS = 480

    def __init__(self, clip):
        self.span = float(clip["out"]) - float(clip["in"])
        self.keys = clip.get("speedKeys") or []
        self.const = float(clip.get("speed", 1)) or 1.0
        self.freeze = clip.get("freezeAt")
        if self.freeze is not None:
            self.duration = self.span / self.const
            self._cum = None
            return
        if not self.keys:
            self.duration = self.span / self.const
            self._cum = None
            return
        self.duration = speed_duration(self.span, self.keys)
        # cumulative timeline time at STEPS+1 source positions
        cum = [0.0]
        for i in range(self.STEPS):
            s0 = (i / self.STEPS) * self.span
            s1 = ((i + 1) / self.STEPS) * self.span
            v = max(0.05, speed_at_source(self.keys, (s0 + s1) / 2))
            cum.append(cum[-1] + (s1 - s0) / v)
        self._cum = cum

    def source_at(self, tau):
        """Source offset (from in-point) shown at timeline-local time tau."""
        if self.freeze is not None:
            return float(self.freeze) - float(0)  # absolute handled by caller
        if self._cum is None:
            return tau * self.const
        if tau <= 0:
            return 0.0
        if tau >= self.duration:
            return self.span
        # binary search the cumulative table
        lo, hi = 0, self.STEPS
        while lo < hi:
            mid = (lo + hi) // 2
            if self._cum[mid + 1] < tau:
                lo = mid + 1
            else:
                hi = mid
        i = lo
        t0, t1 = self._cum[i], self._cum[i + 1]
        s0 = (i / self.STEPS) * self.span
        s1 = ((i + 1) / self.STEPS) * self.span
        if t1 == t0:
            return s1
        return s0 + (s1 - s0) * (tau - t0) / (t1 - t0)

    def speed_at(self, tau):
        if self.freeze is not None:
            return 0.0
        if self._cum is None:
            return self.const
        s = self.source_at(tau)
        return max(0.05, speed_at_source(self.keys, s))

def clip_dur(c):
    """Timeline duration of a clip — mirrors src/types.ts clipDuration."""
    if "dur" in c and c.get("media") is None and "in" not in c:
        return float(c["dur"])
    span = float(c["out"]) - float(c["in"])
    keys = c.get("speedKeys") or []
    if keys:
        return speed_duration(span, keys)
    return span / (float(c.get("speed", 1)) or 1.0)

def norm_transform(c):
    t = c.get("transform") or {}
    return {"x": float(t.get("x", 0)), "y": float(t.get("y", 0)),
            "scale": float(t.get("scale", 1)), "rotation": float(t.get("rotation", 0)),
            "opacity": float(t.get("opacity", 1))}

# ------------------------------------------------------------- colour helpers
def hex_rgb(hx):
    s = (hx or "#000000").lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    return tuple(int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))

def hex_rgba(hx, alpha=1.0):
    r, g, b = hex_rgb(hx)
    return (int(r * 255), int(g * 255), int(b * 255), int(max(0.0, min(1.0, alpha)) * 255))

def ffmpeg_color(hx):
    return "0x" + (hx or "#000000").lstrip("#").upper()

# ------------------------------------------------------------- grade chain
# The preview's buildFilterSpec (src/services/grade.ts) composes, per channel:
#   diagonal WB/exposure gain -> gamma transfer (amp/exp/off from the wheels
#   and contrast/pivot) -> channel curve -> master curve + shadow/highlight
#   shaping. Lane B samples that EXACT composed function at 33 points and
#   hands it to ffmpeg's curves filter, so render and preview agree by
#   construction. Chain order stays LUT -> primaries -> curves -> HSL.
def _curve_fn(pts):
    if not pts:
        return lambda x: x
    sp = sorted(({"x": float(p["x"]), "y": float(p["y"])} for p in pts), key=lambda p: p["x"])
    def f(x):
        if x <= sp[0]["x"]:
            return sp[0]["y"]
        for i in range(1, len(sp)):
            if x <= sp[i]["x"]:
                a, b = sp[i - 1], sp[i]
                if b["x"] == a["x"]:
                    return b["y"]
                return a["y"] + (b["y"] - a["y"]) * ((x - a["x"]) / (b["x"] - a["x"]))
        return sp[-1]["y"]
    return f

def grade_curves_points(grade):
    """-> (points dict {r,g,b: 'x/y ...'} or None when the composed transfer
    is the identity (within 1/256) and no table is needed."""
    g = grade or {}
    exp_mul = 2.0 ** float(g.get("exposure", 0))
    temp = float(g.get("temperature", 0)); tint = float(g.get("tint", 0))
    wb = {"r": (1 + temp * 0.22) * exp_mul,
          "g": (1 - tint * 0.12) * exp_mul,
          "b": (1 - temp * 0.22) * exp_mul}
    contrast = 1 + float(g.get("contrast", 0))
    pivot = float(g.get("pivot", 0.5))
    curves = g.get("curves") or {}
    master_fn = _curve_fn(curves.get("master"))
    shadows = float(g.get("shadows", 0)); highlights = float(g.get("highlights", 0))

    def wheel(name):
        w = g.get(name) or {}
        return {c: float(w.get(c, 0)) for c in "rgb"} | {"master": float(w.get("master", 0))}
    gain, gammaw, lift, offset = wheel("gain"), wheel("gamma"), wheel("lift"), wheel("offset")

    def composed(c, x):
        v = min(1.0, max(0.0, x * wb[c]))
        amp = max(0.01, (1 + (gain[c] + gain["master"]) * 0.5) * contrast)
        expo = 1 / max(0.2, 1 + (gammaw[c] + gammaw["master"]) * 0.6)
        off = (lift[c] + lift["master"]) * 0.25 + (offset[c] + offset["master"]) * 0.3 \
            + pivot * (1 - contrast) * 0.5
        v = amp * (v ** expo) + off
        v = _curve_fn(curves.get(c))(v)
        shaped = master_fn(v) + shadows * 0.18 * (1 - v) ** 2 + highlights * 0.18 * v * v
        return min(1.0, max(0.0, shaped))

    n = 32
    out = {}
    identity = True
    for c in "rgb":
        pts = []
        for i in range(n + 1):
            x = i / n
            y = composed(c, x)
            if abs(y - x) > 1.0 / 256.0:
                identity = False
            pts.append(f"{x:.4f}/{y:.4f}")
        out[c] = " ".join(pts)
    if identity and not curves and shadows == 0 and highlights == 0:
        return None
    return out

HSL_CENTRES = {"red": 0, "orange": 30, "yellow": 60, "green": 120,
               "aqua": 180, "blue": 240, "purple": 275, "magenta": 315}
HSL_KEY_RGB = {"red": "#FF0000", "orange": "#FF8000", "yellow": "#FFFF00",
               "green": "#00FF00", "aqua": "#00FFFF", "blue": "#0000FF",
               "purple": "#8000FF", "magenta": "#FF00FF"}

def grade_is_identity(grade):
    if not grade:
        return True
    if grade.get("lutId"):
        return False
    if grade.get("hsl") and any(any(abs(float(v)) > 1e-9 for v in adj.values())
                                for adj in grade["hsl"].values() if isinstance(adj, dict)):
        return False
    if hue_curves_active(grade):
        return False
    return grade_curves_points(grade) is None

# ------------------------------------------------- hue-vs curves (Wave-2, N.12)
# The preview approximates hue-vs curves with a six-band AVERAGED matrix.
# Lane B applies them per-hue for real: the two curves are baked into a
# temporary 33^3 .cube LUT in HSV space (hue shift = hueHue(h) x 180 deg,
# saturation factor = 1 + hueSat(h), h = source hue 0..1) and applied with
# lut3d. Absent curve = flat zero bend (NOT an identity ramp).
_hue_lut_cache = {}

def hue_curves_active(grade):
    hc = (grade or {}).get("hueCurves") or {}
    for key in ("hueHue", "hueSat", "lumSat"):
        pts = hc.get(key)
        if pts and any(abs(float(p.get("y", 0))) > 0.001 for p in pts):
            return True
    return False

def hue_curves_lut(grade, tmp):
    """-> path of a generated .cube applying the grade's hue-vs curves."""
    hc = grade.get("hueCurves") or {}
    key = json.dumps(hc, sort_keys=True)
    if key in _hue_lut_cache:
        return _hue_lut_cache[key]
    import numpy as np
    shift_fn = _curve_fn(hc.get("hueHue")) if hc.get("hueHue") else (lambda x: 0.0)
    sat_fn = _curve_fn(hc.get("hueSat")) if hc.get("hueSat") else (lambda x: 0.0)
    N = 33
    axis = np.linspace(0, 1, N)
    # .cube lattice order: red varies fastest
    rr, gg, bb = np.meshgrid(axis, axis, axis, indexing="ij")
    r = rr.transpose(2, 1, 0).ravel()  # iterate b outer, g mid, r inner
    g = gg.transpose(2, 1, 0).ravel()
    b = bb.transpose(2, 1, 0).ravel()
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    d = mx - mn
    # hue 0..1
    h = np.zeros_like(mx)
    nz = d > 1e-12
    idx = nz & (mx == r)
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = nz & (mx == g)
    h[idx] = (b - r)[idx] / d[idx] + 2
    idx = nz & (mx == b)
    h[idx] = (r - g)[idx] / d[idx] + 4
    h = h / 6.0
    s = np.where(mx > 1e-12, d / np.maximum(mx, 1e-12), 0.0)
    shift = np.array([shift_fn(float(x)) for x in h])
    sfac = np.array([1.0 + sat_fn(float(x)) for x in h])
    # D2.4 lum-vs-sat: one more saturation factor, driven by the
    # pixel's Rec.601 luma — composed multiplicatively into the same
    # LUT, so the chain keeps a single lut3d stage.
    if hc.get("lumSat"):
        lum_fn = _curve_fn(hc.get("lumSat"))
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        sfac = sfac * np.array([1.0 + lum_fn(float(x)) for x in luma])
    h2 = (h + shift * 0.5) % 1.0  # shift y -1..1 -> +-180deg -> +-0.5 of the wheel
    s2 = np.clip(s * sfac, 0, 1)
    v = mx
    # hsv -> rgb
    i6 = np.floor(h2 * 6).astype(int) % 6
    f = h2 * 6 - np.floor(h2 * 6)
    p_ = v * (1 - s2)
    q_ = v * (1 - s2 * f)
    t_ = v * (1 - s2 * (1 - f))
    ro = np.choose(i6, [v, q_, p_, p_, t_, v])
    go = np.choose(i6, [t_, v, v, q_, p_, p_])
    bo = np.choose(i6, [p_, p_, t_, v, v, q_])
    path = os.path.join(tmp, f"huecurves_{abs(hash(key)) % 99999}.cube")
    with open(path, "w") as fh:
        fh.write(f"LUT_3D_SIZE {N}\n")
        for i in range(len(ro)):
            fh.write(f"{ro[i]:.5f} {go[i]:.5f} {bo[i]:.5f}\n")
    _hue_lut_cache[key] = path
    return path

# ---------------------------------------------------------------- text (PIL)
# Style resolution mirrors src/types.ts TEXT_PRESETS / resolveTextStyle /
# resolveShadow and src/engine/compose.ts evalText — same fields, same
# defaults, same animation maths. Rendering is word-based so per-word colour
# (**markup**), karaoke word timings and word-reveal all share one layout.
TEXT_PRESETS = {
    "pop-bold": {"fontFamily": 'Impact, "Arial Black", sans-serif', "fontWeight": 800,
                 "fontSize": 92, "color": "#FFFFFF", "strokeColor": "#111111",
                 "strokeWidth": 6, "shadow": True},
    "plain": {"fontFamily": '"Segoe UI", system-ui, sans-serif', "fontWeight": 600,
              "fontSize": 54, "color": "#FFFFFF", "strokeColor": "#000000",
              "strokeWidth": 0, "shadow": False},
    "caption": {"fontFamily": '"Segoe UI", system-ui, sans-serif', "fontWeight": 700,
                "fontSize": 44, "color": "#FFFFFF", "strokeColor": "#000000",
                "strokeWidth": 3, "shadow": True},
}
DEFAULT_SHADOW = {"color": "#000000", "opacity": 0.55, "blur": 10, "distance": 4, "angle": 90}

def resolve_text_style(clip):
    p = TEXT_PRESETS.get(clip.get("style", "pop-bold"), TEXT_PRESETS["pop-bold"])
    return {
        "fontFamily": clip.get("fontFamily", p["fontFamily"]),
        "fontWeight": clip.get("fontWeight", p["fontWeight"]),
        "fontSize": clip.get("fontSize", p["fontSize"]),
        "color": clip.get("color", p["color"]),
        "strokeColor": clip.get("strokeColor", p["strokeColor"]),
        "strokeWidth": clip.get("strokeWidth", p["strokeWidth"]),
        "shadow": clip.get("shadow", p["shadow"]),
    }

def resolve_shadow(clip):
    if clip.get("shadowObj"):
        return clip["shadowObj"]
    if clip.get("shadow", TEXT_PRESETS.get(clip.get("style", "pop-bold"),
                                           TEXT_PRESETS["pop-bold"])["shadow"]):
        return dict(DEFAULT_SHADOW)
    return None

def eval_text(clip, tl):
    """Mirror of compose.evalText: -> dict(shown, scale, alpha, yOffPx, loopScale, loopXOffPx)
    (offsets in 720-reference px)."""
    dur = float(clip["dur"])
    anim_in = clip.get("animIn") or "none"
    anim_out = clip.get("animOut") or "none"
    in_dur = float(clip.get("animInDur", 0.28))
    out_dur = float(clip.get("animOutDur", 0.25))
    pin = 1.0
    if anim_in != "none":
        pin = min(1.0, max(0.0, tl / max(0.01, in_dur)))
    pout = 1.0
    if anim_out != "none":
        pout = min(1.0, max(0.0, (dur - tl) / max(0.01, out_dur)))
    alpha, scale, yoff = 1.0, 1.0, 0.0
    shown = clip.get("text", "")
    if anim_in == "pop":
        scale = max(0.05, _ease_out_back(pin)); alpha = min(1.0, pin * 1.6)
    elif anim_in == "fade":
        alpha = _ease_out_cubic(pin)
    elif anim_in == "slide":
        yoff = (1 - _ease_out_cubic(pin)) * 46; alpha = min(1.0, pin * 1.8)
    elif anim_in == "typewriter":
        shown = shown[:max(0, int(len(shown) * pin + 0.0001))]
    elif anim_in == "word-reveal":
        span = float(clip.get("animInDur", dur))
        words = shown.split()
        n = max(0, min(len(words), math.ceil(len(words) * min(1.0, max(0.0, tl / max(0.01, span))))))
        shown = " ".join(words[:n])
    if anim_out == "fade":
        alpha *= _ease_out_cubic(pout)
    elif anim_out == "pop":
        scale *= max(0.05, _ease_out_back(pout)) if pout < 1 else 1.0
        alpha *= min(1.0, pout * 1.6)
    elif anim_out == "slide":
        yoff += (1 - _ease_out_cubic(pout)) * 46
    loop_scale, loop_x = 1.0, 0.0
    loop = clip.get("animLoop") or "none"
    if loop == "pulse":
        loop_scale = 1 + 0.07 * math.sin(tl * (2 * math.pi / 1.1))
    elif loop == "wave":
        yoff += math.sin(tl * 3.2) * 7
    elif loop == "sway":
        loop_x = math.sin(tl * 2.1) * 9
    return {"shown": shown, "scale": scale, "alpha": alpha, "yOffPx": yoff,
            "loopScale": loop_scale, "loopXOffPx": loop_x}

def _tokenize(line, hl_on):
    """Split one line into [(word, highlighted)] honouring **markup**.
    Returns (words, hl_on_after)."""
    words = []
    cur = ""
    def flush():
        nonlocal cur
        if cur:
            words.append((cur, hl_on))
            cur = ""
    i = 0
    buf = ""
    # walk chars, toggling on **, splitting on spaces
    tokens = []
    state = hl_on
    j = 0
    while j < len(line):
        if line[j:j + 2] == "**":
            if buf:
                tokens.append((buf, state)); buf = ""
            state = not state
            j += 2
            continue
        buf += line[j]
        j += 1
    if buf:
        tokens.append((buf, state))
    for text, st in tokens:
        for k, part in enumerate(text.split(" ")):
            if k > 0:
                flush()
            cur += part
            if k < len(text.split(" ")) - 1:
                flush()
    flush()
    return words, state

def render_text_clip(clip, W, H, fps, outdir, fonts):
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
    st = resolve_text_style(clip)
    dur = float(clip["dur"])
    n = max(1, math.ceil(dur * fps))
    ss = W / 720.0  # 720-reference scale (all style px are at this reference)
    bold = int(st["fontWeight"]) >= 700
    font_path = fonts.resolve(st["fontFamily"], bold)
    ax = float(clip.get("x", 0.5)) * W
    ay = float(clip.get("y", 0.8)) * H
    shadow = resolve_shadow(clip)
    glow_on = "glow" in (clip.get("effects") or [])
    glow_obj = clip.get("glowObj") or {}
    glow_intensity = float(glow_obj.get("intensity", 0.85))
    glow_range = float(glow_obj.get("range", 8))
    plate = clip.get("plate")
    align = clip.get("align", "center")
    char_sp = float(clip.get("charSpacing", 0)) * ss
    line_sp = clip.get("lineSpacing")
    hl_color = clip.get("highlightColor")
    no_fill = bool(clip.get("noFill"))
    karaoke = clip.get("words") or []
    full_text = clip.get("text", "")
    os.makedirs(outdir, exist_ok=True)
    measure = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
    for i in range(n):
        tl = i / fps
        ev = eval_text(clip, tl)
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        shown = ev["shown"]
        if shown and ev["alpha"] > 0.003:
            fs = max(6, int(float(st["fontSize"]) * ss * ev["scale"] * ev["loopScale"]))
            font = ImageFont.truetype(font_path, fs)
            ascent, descent = font.getmetrics()
            lh = fs * float(line_sp) if line_sp else float(ascent + descent)
            sw = int(round(float(st["strokeWidth"]) * ss * ev["scale"] * ev["loopScale"]))
            arc_mode = (bool(clip.get("curve"))
                        and abs(float(clip.get("curve") or 0)) >= 40
                        and "\n" not in shown)
            # ---- layout: lines -> words with colours/alphas
            lines = []
            hl_state = False
            word_index = 0
            karaoke_ok = bool(karaoke) and shown == full_text
            for raw_line in shown.split("\n"):
                toks, hl_state = _tokenize(raw_line, hl_state)
                line_words = []
                for wtext, whl in toks:
                    colr = st["color"]
                    walpha = 1.0
                    if whl and hl_color:
                        colr = hl_color
                    if karaoke_ok and word_index < len(karaoke):
                        kw = karaoke[word_index]
                        if tl < float(kw["t0"]):
                            walpha = 0.45
                        elif tl < float(kw["t1"]):
                            if hl_color:
                                colr = hl_color
                    ww = measure.textlength(wtext, font=font) + char_sp * len(wtext)
                    line_words.append({"text": wtext, "color": colr, "alpha": walpha, "w": ww})
                    word_index += 1
                space_w = measure.textlength(" ", font=font) + char_sp
                lw = sum(w["w"] for w in line_words) + space_w * max(0, len(line_words) - 1)
                lines.append({"words": line_words, "w": lw, "space": space_w})
            block_w = max((ln["w"] for ln in lines), default=0)
            block_h = lh * (len(lines) - 1) + (ascent + descent)
            if arc_mode:
                block_w = sum(measure.textlength(ch, font=font) + char_sp
                              for ch in shown.replace("**", ""))
                block_h = float(ascent + descent)
            xoff = ev["loopXOffPx"] * ss
            y_top = ay - block_h / 2 + ev["yOffPx"] * ss
            def line_x(ln):
                if align == "left":
                    return ax - block_w / 2 + xoff
                if align == "right":
                    return ax + block_w / 2 - ln["w"] + xoff
                return ax - ln["w"] / 2 + xoff
            layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            # ---- plate (behind everything)
            if plate:
                pl = ImageDraw.Draw(layer, "RGBA")
                pad_x = float(plate.get("padX", 0)) * ss; pad_y = float(plate.get("padY", 0)) * ss
                px0 = ax - block_w / 2 - pad_x + float(plate.get("offX", 0)) * ss + xoff
                py0 = y_top - pad_y + float(plate.get("offY", 0)) * ss
                px1 = ax + block_w / 2 + pad_x + float(plate.get("offX", 0)) * ss + xoff
                py1 = y_top + block_h + pad_y + float(plate.get("offY", 0)) * ss
                pl.rounded_rectangle([px0, py0, px1, py1],
                                     radius=float(plate.get("radius", 0)) * ss,
                                     fill=hex_rgba(plate.get("color", "#000000"),
                                                   float(plate.get("opacity", 1))))
                if plate.get("shape") == "bubble":
                    # H.12 speech-bubble tail: CSS-triangle geometry from
                    # the preview (base half-width 0.55 x tailSize).
                    tsize = float(plate.get("tailSize", 14)) * ss
                    tat = float(plate.get("tailAt", 0.5))
                    tcol = hex_rgba(plate.get("color", "#000000"),
                                    float(plate.get("opacity", 1)))
                    hb = tsize * 0.55
                    edge = plate.get("tail", "bottom")
                    if edge == "top":
                        cxp = px0 + tat * (px1 - px0)
                        pl.polygon([(cxp - hb, py0 + 1), (cxp + hb, py0 + 1),
                                    (cxp, py0 - tsize)], fill=tcol)
                    elif edge == "left":
                        cyp = py0 + tat * (py1 - py0)
                        pl.polygon([(px0 + 1, cyp - hb), (px0 + 1, cyp + hb),
                                    (px0 - tsize, cyp)], fill=tcol)
                    elif edge == "right":
                        cyp = py0 + tat * (py1 - py0)
                        pl.polygon([(px1 - 1, cyp - hb), (px1 - 1, cyp + hb),
                                    (px1 + tsize, cyp)], fill=tcol)
                    else:
                        cxp = px0 + tat * (px1 - px0)
                        pl.polygon([(cxp - hb, py1 - 1), (cxp + hb, py1 - 1),
                                    (cxp, py1 + tsize)], fill=tcol)
            def draw_arc(mode, single_color=None):
                """H.11 arc text: per-glyph placement mirroring
                compose.arcLayout (same radius clamp, same angle maths);
                glyphs are rotated tiles. Markup/karaoke/glow do not
                combine with arc in the preview, so the string is plain."""
                lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                plain = shown.replace("**", "")
                advs = [measure.textlength(ch, font=font) + char_sp for ch in plain]
                r_layout = max(40.0, abs(float(clip.get("curve") or 0)) * ss)
                r = r_layout * ev["scale"] * ev["loopScale"]
                dir_ = 1 if float(clip.get("curve") or 0) >= 0 else -1
                cx_anchor = ax + ev["loopXOffPx"] * ss
                cy_anchor = ay + ev["yOffPx"] * ss
                s_acc = -sum(advs) / 2
                for i, ch in enumerate(plain):
                    adv = advs[i]
                    th = (s_acc + adv / 2) / r
                    gx = cx_anchor + math.sin(th) * r
                    gy = cy_anchor + dir_ * r * (1 - math.cos(th))
                    pad = sw + 6
                    tile = Image.new("RGBA", (max(2, int(adv) + 2 * pad + 2), fs + 2 * pad),
                                     (0, 0, 0, 0))
                    td = ImageDraw.Draw(tile, "RGBA")
                    if mode == "shadow":
                        fill = hex_rgba(single_color, 1.0)
                        td.text((pad, pad), ch, font=font, fill=fill,
                                stroke_width=sw, stroke_fill=fill)
                    elif mode == "stroke":
                        td.text((pad, pad), ch, font=font,
                                fill=hex_rgba(st["strokeColor"], 1.0),
                                stroke_width=sw, stroke_fill=hex_rgba(st["strokeColor"], 1.0))
                    elif mode == "glow":
                        td.text((pad, pad), ch, font=font,
                                fill=hex_rgba(st["color"], 1.0),
                                stroke_width=sw, stroke_fill=hex_rgba(st["color"], 1.0))
                    elif not no_fill:
                        td.text((pad, pad), ch, font=font, fill=hex_rgba(st["color"], 1.0))
                    tile = tile.rotate(-math.degrees(dir_ * th),
                                       resample=Image.BICUBIC, expand=True)
                    lay.alpha_composite(tile, (int(gx - tile.width / 2),
                                               int(gy - tile.height / 2)))
                    s_acc += adv
                return lay

            def draw_block(mode, single_color=None):
                if arc_mode:
                    return draw_arc(mode, single_color)
                lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                d = ImageDraw.Draw(lay, "RGBA")
                for li, ln in enumerate(lines):
                    x = line_x(ln)
                    ybase = y_top + li * lh
                    for wd in ln["words"]:
                        if mode == "shadow":
                            fill = hex_rgba(single_color, 1.0)
                            d.text((x, ybase), wd["text"], font=font, fill=fill,
                                   stroke_width=sw, stroke_fill=fill)
                        elif mode == "stroke":
                            d.text((x, ybase), wd["text"], font=font,
                                   fill=hex_rgba(st["strokeColor"], 1.0),
                                   stroke_width=sw, stroke_fill=hex_rgba(st["strokeColor"], 1.0))
                        elif mode == "glow":
                            d.text((x, ybase), wd["text"], font=font,
                                   fill=hex_rgba(wd["color"], 1.0),
                                   stroke_width=sw, stroke_fill=hex_rgba(wd["color"], 1.0))
                        else:  # fill
                            if not no_fill:
                                r, g, b = hex_rgb(wd["color"])
                                d.text((x, ybase), wd["text"], font=font,
                                       fill=(int(r * 255), int(g * 255), int(b * 255),
                                             int(255 * wd["alpha"])))
                        x += wd["w"] + ln["space"]
                return lay
            # ---- glow (colour always derives from the fill — H.7 rule;
            # the preview skips glow under arc text)
            if glow_on and not arc_mode:
                gl = draw_block("glow")
                gl = gl.filter(ImageFilter.GaussianBlur(max(1.0, glow_range * ss * 0.5)))
                a = gl.split()[3].point(lambda v: int(v * min(1.0, glow_intensity)))
                gl.putalpha(a)
                layer = Image.alpha_composite(layer, gl)
                if glow_intensity > 1.0:
                    layer = Image.alpha_composite(layer, gl)
            # ---- designed shadow
            if shadow:
                dist = float(shadow.get("distance", 4)) * ss
                ang = math.radians(float(shadow.get("angle", 90)))
                dx, dy = dist * math.cos(ang), dist * math.sin(ang)
                sh = draw_block("shadow", shadow.get("color", "#000000"))
                blur = float(shadow.get("blur", 0)) * ss
                if blur > 0.3:
                    sh = sh.filter(ImageFilter.GaussianBlur(blur * 0.5))
                a = sh.split()[3].point(lambda v: int(v * float(shadow.get("opacity", 0.55))))
                sh.putalpha(a)
                shifted = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                shifted.alpha_composite(sh, (int(round(dx)), int(round(dy))))
                layer = Image.alpha_composite(layer, shifted)
            # ---- stroke pass (whole-line underlay) then per-word fill
            if sw > 0:
                layer = Image.alpha_composite(layer, draw_block("stroke"))
            layer = Image.alpha_composite(layer, draw_block("fill"))
            if ev["alpha"] < 1.0:
                a = layer.split()[3].point(lambda v: int(v * ev["alpha"]))
                layer.putalpha(a)
            img = Image.alpha_composite(img, layer)
        img.save(os.path.join(outdir, "f_%04d.png" % i))
    return n

# ------------------------------------------------------- plates & mask PNGs
def _save(img, path):
    img.save(path)
    return path

def build_mask_video(clip, dur, W, H, fps, tmp, tag):
    """D2.1: an adjustment clip's window as a greyscale video — one
    make_mask_png per frame at the clip's mask_at geometry (feather
    included), so a keyframed (tracked) window moves in the render
    exactly as the preview's outline does. Returns the webm path."""
    n = max(1, int(round(dur * fps)))
    seq_dir = os.path.join(tmp, f"adjmask_{tag}")
    os.makedirs(seq_dir, exist_ok=True)
    for f in range(n):
        geom = mask_at(clip, f / fps)
        make_mask_png(clip["mask"], geom, W, H, os.path.join(seq_dir, f"f{f:05d}.png"))
    out = os.path.join(tmp, f"adjmask_{tag}.webm")
    run(["ffmpeg", "-y", "-v", "error", "-framerate", str(fps),
         "-i", os.path.join(seq_dir, "f%05d.png"),
         "-c:v", "libvpx-vp9", "-pix_fmt", "gray", "-b:v", "0", "-crf", "12", out])
    return out


def make_mask_png(mask, geom, W, H, path):
    from PIL import Image, ImageDraw, ImageFilter, ImageOps
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    shape = mask.get("shape", "rect")
    x, y, w, h = geom["x"] * W, geom["y"] * H, geom["w"] * W, geom["h"] * H
    if shape == "circle":
        d.ellipse([x, y, x + w, y + h], fill=255)
    elif shape == "linear":
        big = Image.new("L", (W * 2, H * 2), 0)
        bd = ImageDraw.Draw(big)
        cy = y + H / 2
        bd.rectangle([0, cy - h / 2, W * 2, cy + h / 2], fill=255)
        ang = float(mask.get("angle", 0))
        if ang:
            big = big.rotate(ang, resample=Image.BILINEAR, center=(W, H))
        img = big.crop((W // 2, H // 2, W // 2 + W, H // 2 + H))
    elif shape == "pen":
        pts = [(float(p["x"]) * W, float(p["y"]) * H) for p in mask.get("points", [])]
        if len(pts) >= 3:
            d.polygon(pts, fill=255)
    else:  # rect
        d.rectangle([x, y, x + w, y + h], fill=255)
    if mask.get("invert"):
        img = ImageOps.invert(img)
    feather = float(mask.get("feather", 0))
    if feather > 0:
        img = img.filter(ImageFilter.GaussianBlur(feather * W / 2))
    return _save(img, path)

def radial_plate_png(W, H, cx, cy, radius_px, rgb, peak_alpha, path, invert=False):
    """Soft radial plate. invert=False: alpha peaks at centre (relight);
    invert=True: alpha peaks at the rim (haze blur mask)."""
    import numpy as np
    from PIL import Image
    yy, xx = np.mgrid[0:H, 0:W]
    dist = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / max(1.0, radius_px)
    t = np.clip(dist, 0, 1)
    fall = (1 - t) ** 2 if not invert else t ** 2
    a = (fall * peak_alpha * 255).astype("uint8")
    img = np.zeros((H, W, 4), dtype="uint8")
    img[..., 0], img[..., 1], img[..., 2] = int(rgb[0] * 255), int(rgb[1] * 255), int(rgb[2] * 255)
    img[..., 3] = a
    return _save(Image.fromarray(img, "RGBA"), path)

def tv_lines_png(W, H, strength, path):
    from PIL import Image
    tile = Image.new("RGBA", (1, 4), (0, 0, 0, 0))
    a = int(110 * max(0.0, min(1.0, strength)))
    for yy in (2, 3):
        tile.putpixel((0, yy), (0, 0, 0, a))
    img = tile.resize((W, H), Image.NEAREST)
    return _save(img, path)

def turbulence_plate_png(W, H, scale, seed, path):
    """Smooth low-frequency displacement field for turbulent-displace:
    a (W+2M)x(H+2M) greyscale plate around mid-grey 128 (128 = no offset
    for ffmpeg's displace). TWO bicubic octaves only — a base grid of
    2..5 cells across plus its 2x grid at 0.30 weight — then a gaussian
    blur and a percentile normalisation pinning the deviation to ±56
    counts, so gradients stay continuous: no fine fractal grain, no
    clipped plateaus, hence no marbled oil-slick / contour banding when
    the amount lut scales the field (the v1 plate's failure). `scale`
    0..1 moves the base cell count (0 = huge soft blobs, 1 = smaller
    swirls, still smooth); `seed` makes the field reproducible per
    clip. Returns (path, M) — the caller crops drifting W x H windows
    out of the margin M."""
    from PIL import Image, ImageFilter
    import numpy as np
    M = max(48, min(260, int(round(min(W, H) * 0.28))))
    PW, PH = W + 2 * M, H + 2 * M
    rng = random.Random(7919 + (int(seed * 131) % 100000))
    s = max(0.0, min(1.0, scale))
    base = max(2, int(round(2 + s * 3)))
    acc = None
    for mult, weight in ((1, 1.0), (2, 0.30)):
        cw = base * mult
        chh = max(2, int(round(cw * PH / PW)))
        raw = bytes(rng.randrange(256) for _ in range(cw * chh))
        layer = Image.frombytes("L", (cw, chh), raw).resize((PW, PH), Image.BICUBIC)
        a = np.asarray(layer).astype("float32") - 128.0
        acc = a * weight if acc is None else acc + a * weight
    img = Image.fromarray(np.clip(acc + 128.0, 0, 255).astype("uint8"), "L")
    img = img.filter(ImageFilter.GaussianBlur(max(2.0, PW / (base * 3.0))))
    a = np.asarray(img).astype("float32") - 128.0
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    span = max(8.0, (hi - lo) / 2.0)
    a = np.clip(a * (56.0 / span), -56.0, 56.0)
    return _save(Image.fromarray((a + 128.0).astype("uint8"), "L"), path), M

def falloff_gradient_png(W, H, falloff, path):
    """Vertical strength gradient for turbulent-displace's `falloff`
    param: white (full displacement) at the layer's BOTTOM — the
    emergence line of a bubble/pop-out layer — ramping to black (no
    displacement) across the top `falloff` fraction of the layer, with
    a ^1.3 ease so the coherent zone up top is generous. falloff = 1
    fades over the full height. Generated at canvas W x H; the caller
    scale2refs it to the layer exactly like the displacement maps, and
    maskedmerges each map between flat 128 (no offset) and itself."""
    import numpy as np
    from PIL import Image
    f = max(0.05, min(1.0, falloff))
    y = np.linspace(0.0, 1.0, H, dtype="float32")[:, None]
    m = np.clip((y - (1.0 - f)) / f, 0.0, 1.0) ** 1.3
    img = Image.fromarray((np.repeat(m, W, axis=1) * 255).astype("uint8"), "L")
    return _save(img, path)

def turbulence_fbm_png(W, H, size_px, complexity, seed, path):
    """AE-mode displacement plate for turbulent-displace (params.amount
    present): a true fBm field in After Effects terms — base feature
    size = `size_px` layer pixels, detail = `complexity` (one extra
    octave per unit, fractional part = partial octave weight, octave
    amplitudes falling by 0.55). Bicubic upscaling of each octave grid
    is the smooth interpolation AE's 'Turbulent Smoother' mode reads
    as. Same calibration contract as turbulence_plate_png: deviations
    percentile-normalised to ±56 around 128, plate oversized by a
    margin M on every side; returns (path, M)."""
    from PIL import Image, ImageFilter
    import numpy as np
    M = max(32, min(400, int(round(size_px))))
    PW, PH = W + 2 * M, H + 2 * M
    rng = random.Random(104729 + (int(seed * 131) % 100000))
    bcw = max(2, int(round(PW / size_px)))
    bch = max(2, int(round(PH / size_px)))
    acc = None
    k = 0
    rem = float(complexity)
    while rem > 0.001 and k < 5:
        wgt = min(1.0, rem) * (0.55 ** k)
        cw, chh = bcw * (2 ** k), bch * (2 ** k)
        raw = bytes(rng.randrange(256) for _ in range(cw * chh))
        layer = Image.frombytes("L", (cw, chh), raw).resize((PW, PH), Image.BICUBIC)
        a = np.asarray(layer).astype("float32") - 128.0
        acc = a * wgt if acc is None else acc + a * wgt
        rem -= 1.0
        k += 1
    img = Image.fromarray(np.clip(acc + 128.0, 0, 255).astype("uint8"), "L")
    img = img.filter(ImageFilter.GaussianBlur(max(1.5, size_px / 6.0)))
    a = np.asarray(img).astype("float32") - 128.0
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    span = max(8.0, (hi - lo) / 2.0)
    a = np.clip(a * (56.0 / span), -56.0, 56.0)
    # AE's fractal field sits mostly MID-RANGE (a rendered fractal-noise
    # plate is soft mid-tones with rare extremes); a percentile stretch
    # to full range makes typical offsets as large as the extremes and
    # the displaced layer shreds into islands instead of warping as one
    # mass (measured against the tutorial's solo-warp frames at Amount
    # 171: connected, wavy silhouette; typical offset ~0.25x Size,
    # extremes ~1x Size). Scale the distribution down to AE-like
    # statistics; the clip keeps true extremes bounded at +-56.
    a = np.clip(a * 0.45, -56.0, 56.0)
    return _save(Image.fromarray((a + 128.0).astype("uint8"), "L"), path), M

def pin_envelope_png(W, H, ramp_px, path):
    """AE 'Pin All' envelope for turbulent-displace: white (map at full
    strength) in the interior, ramping to black (map forced to flat
    128 = zero displacement) within `ramp_px` of every layer edge —
    AE pins all four edges of the layer so the displacement dies at
    the borders. The caller maskedmerges each displacement map
    between flat 128 and itself through this envelope."""
    import numpy as np
    from PIL import Image
    ramp = max(8.0, float(ramp_px))
    xs = np.minimum(np.arange(W), np.arange(W)[::-1]).astype("float32") / ramp
    ys = np.minimum(np.arange(H), np.arange(H)[::-1]).astype("float32") / ramp
    ex = np.clip(xs, 0.0, 1.0)[None, :]
    ey = np.clip(ys, 0.0, 1.0)[:, None]
    m = np.minimum(ex, ey)
    m = m * m * (3.0 - 2.0 * m)
    img = Image.fromarray((m * 255).astype("uint8"), "L")
    return _save(img, path)

def soft_crop_png(crop, W, H, path):
    """Feathered rectangle used to soften crop edges (alpha multiplier)."""
    from PIL import Image, ImageDraw, ImageFilter
    img = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(img)
    x0 = float(crop.get("l", 0)) * W; y0 = float(crop.get("t", 0)) * H
    x1 = W - float(crop.get("r", 0)) * W; y1 = H - float(crop.get("b", 0)) * H
    d.rectangle([x0, y0, x1, y1], fill=255)
    soft = float(crop.get("softness", 0))
    if soft > 0:
        img = img.filter(ImageFilter.GaussianBlur(soft * W / 2))
    return _save(img, path)

def make_wipe_png(cx, cy, radius, W, H, path, shape="circle"):
    """Mask-wipe reveal shape (J.11): white shape of `radius` px centred
    at (cx, cy) canvas fractions, drawn supersampled for a smooth edge.
    D2.3 shapes: 'circle' (the original disc), 'petal' (a five-petal
    flower — radius modulated by cos(5θ)), 'blob' (the disc plus three
    satellite discs, an organic union)."""
    from PIL import Image, ImageDraw
    S = 2
    img = Image.new("L", (W * S, H * S), 0)
    d = ImageDraw.Draw(img)
    cxp, cyp = cx * W * S, cy * H * S
    if shape == "petal":
        import numpy as np
        yy, xx = np.mgrid[0:H * S, 0:W * S].astype("float64")
        rr = np.hypot(xx - cxp, yy - cyp)
        th = np.arctan2(yy - cyp, xx - cxp)
        edge = radius * S * (0.74 + 0.26 * np.cos(5 * th))
        m = np.clip((edge - rr) / (2.0 * S) + 0.5, 0, 1)
        img = Image.fromarray((m * 255).astype("uint8"), "L")
    elif shape == "blob":
        for ox, oy, s in ((0.0, 0.0, 1.0), (0.55, -0.30, 0.62), (-0.48, 0.38, 0.55), (0.10, 0.58, 0.48)):
            r = radius * S * s
            bx, by = cxp + ox * radius * S, cyp + oy * radius * S
            d.ellipse([bx - r, by - r, bx + r, by + r], fill=255)
    else:
        d.ellipse([cxp - radius * S, cyp - radius * S, cxp + radius * S, cyp + radius * S], fill=255)
    img = img.resize((W, H), Image.LANCZOS)
    return _save(img, path)

# ------------------------------------------------------------- grade -> ffmpeg
def _hue_sat_matrix(h_deg, s_pct, l_pct):
    """colorchannelmixer matrix composing hue-rotation (YIQ method) then
    saturation, plus a constant lightness offset. Lane B's documented
    definition of the preview's per-band HSL controls (the preview itself
    leaves HSL render-only)."""
    import numpy as _np
    a = math.radians(h_deg); c, s = math.cos(a), math.sin(a)
    Hm = _np.array([
        [0.299 + 0.701 * c + 0.168 * s, 0.587 - 0.587 * c + 0.330 * s, 0.114 - 0.114 * c - 0.500 * s],
        [0.299 - 0.299 * c - 0.328 * s, 0.587 + 0.413 * c + 0.035 * s, 0.114 - 0.114 * c + 0.292 * s],
        [0.299 - 0.299 * c + 0.500 * s, 0.587 - 0.587 * c - 0.330 * s, 0.114 + 0.886 * c - 0.168 * s]])
    t = 1 + s_pct / 100.0
    w = _np.array([0.299, 0.587, 0.114])
    Sm = t * _np.eye(3) + (1 - t) * _np.tile(w, (3, 1))
    M = Sm @ Hm
    off = l_pct * 0.003
    return M, off

def qualifier_mask_lut(key, tmp):
    """D1.2: bake the qualifier selection into a 33^3 .cube (output =
    (m, m, m)). The formula mirrors services/qualifier.ts EXACTLY:
      ramp = smoothstep clamp; trap = two-sided feathered band;
      hue uses the wrapped distance to the centre.
    The mask is a pure function of the source pixel, so it must be
    sampled from the layer's UNGRADED input (grade_fc splits for it)."""
    import numpy as np
    cache_key = json.dumps(key, sort_keys=True)
    path = os.path.join(tmp or tempfile.gettempdir(), "qmask_" + str(abs(hash(cache_key))) + ".cube")
    if os.path.exists(path):
        return path
    n = 33
    axis = np.linspace(0, 1, n)
    # .cube lattice order: RED varies fastest (same order hue_curves_lut
    # writes — b outer, g mid, r inner via the (2,1,0) transpose).
    rr, gg, bb = np.meshgrid(axis, axis, axis, indexing="ij")
    r = rr.transpose(2, 1, 0).ravel().astype(np.float64)
    g = gg.transpose(2, 1, 0).ravel().astype(np.float64)
    b = bb.transpose(2, 1, 0).ravel().astype(np.float64)
    mx = np.maximum(np.maximum(r, g), b); mn = np.minimum(np.minimum(r, g), b); d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-12
    isr = nz & (mx == r); isg = nz & (mx == g); isb = nz & (mx == b)
    h[isr] = ((g - b)[isr] / d[isr]) % 6
    h[isg] = (b - r)[isg] / d[isg] + 2.0
    h[isb] = (r - g)[isb] / d[isb] + 4.0
    h = h / 6.0
    s = np.where(mx > 1e-12, d / np.maximum(mx, 1e-12), 0.0)
    v = mx

    def ramp(x, a, b):
        if b <= a:
            return (x >= a).astype(np.float64)
        t = np.clip((x - a) / (b - a), 0, 1)
        return t * t * (3 - 2 * t)

    def trap(x, lo, hi, soft):
        # Plateau spans [lo, hi] in full; the feather falls OUTSIDE it
        # (mirrors services/qualifier.ts exactly).
        return ramp(x, lo - soft, lo) * (1 - ramp(x, hi, hi + soft))

    dh = np.abs(h - float(key.get("hue", 0.0)))
    dh = np.minimum(dh, 1 - dh)
    half = float(key.get("hueWidth", 0.15)) / 2.0
    hsoft = float(key.get("hueSoft", 0.08))
    hue_sel = 1 - ramp(dh, half, half + hsoft)
    m = (hue_sel
         * trap(s, float(key.get("satMin", 0.0)), float(key.get("satMax", 1.0)), float(key.get("satSoft", 0.1)))
         * trap(v, float(key.get("lumaMin", 0.0)), float(key.get("lumaMax", 1.0)), float(key.get("lumaSoft", 0.1))))
    m = np.clip(m, 0, 1)
    with open(path, "w") as f:
        f.write("LUT_3D_SIZE 33\n")
        for val in m:  # rows already in .cube order (red fastest)
            f.write(f"{val:.5f} {val:.5f} {val:.5f}\n")
    return path


def grade_fc(cur, grade, lut_path, tag, tmp=None):
    """Build the grade stage filters. Returns (parts, out_label).
    Chain order is the client's: LUT -> primaries/curves -> HSL, with the
    hue-vs curves stage at the primaries position (where the preview folds
    its six-band average into the white-balance matrix).
    D1.2: a layer carrying `key` (qualifier-lite) is graded on a split
    branch and blended back over its own ungraded input by the exact
    HSV selection mask, so the grade lands only inside the selection."""
    key = (grade or {}).get("key")
    if not key:
        return _grade_chain_fc(cur, grade, lut_path, tag, tmp)
    # The merge MUST run in RGB(A): in YUV the mask's chroma planes are
    # neutral grey, so maskedmerge would weight the colour planes ~50/50
    # everywhere (the HSL stage converts to rgba first for this reason).
    parts = [f"[{cur}]split=3[qk{tag}base][qk{tag}work][qk{tag}src]",
             f"[qk{tag}base]format=rgba[qk{tag}basec]"]
    chain_parts, graded = _grade_chain_fc(f"qk{tag}work", grade, lut_path, tag, tmp)
    parts += chain_parts
    parts.append(f"[{graded}]format=rgba[qk{tag}gradedc]")
    mpath = qualifier_mask_lut(key, tmp).replace("\\", "/").replace(":", "\\:")
    parts.append(f"[qk{tag}src]lut3d=file='{mpath}':interp=trilinear,format=gray,format=rgba[qk{tag}mask]")
    out = f"q{tag}out"
    # The explicit format=rgba hop after the merge is LOAD-BEARING:
    # maskedmerge negotiates a GBR-ordered format in this ffmpeg build,
    # and a direct conversion to yuva420p reads the planes as RGB
    # (measured: graded red (126,253,0) came out (235,173,44)). The hop
    # forces the correct plane read and keeps the alpha plane.
    parts.append(f"[qk{tag}basec][qk{tag}gradedc][qk{tag}mask]maskedmerge,format=rgba[{out}]")
    return parts, out


def _grade_chain_fc(cur, grade, lut_path, tag, tmp=None):
    """The un-keyed grade chain (the pre-D1.2 grade_fc body)."""
    parts = []
    if lut_path:
        strength = float((grade or {}).get("lutStrength", 0.5))
        parts.append(f"[{cur}]split[lut_{tag}_a][lut_{tag}_b]")
        parts.append(f"[lut_{tag}_b]lut3d=file='{lut_path}':interp=trilinear[lut_{tag}_c]")
        parts.append(f"[lut_{tag}_a][lut_{tag}_c]blend=all_mode=normal:all_opacity={strength:.3f}[lut_{tag}_o]")
        cur = f"lut_{tag}_o"
    if grade and hue_curves_active(grade):
        lut_dir = tmp or os.path.join(tempfile.gettempdir(), "cutlab_hue_luts")
        os.makedirs(lut_dir, exist_ok=True)
        hc_path = hue_curves_lut(grade, lut_dir)
        parts.append(f"[{cur}]lut3d=file='{hc_path}':interp=trilinear[hc_{tag}]")
        cur = f"hc_{tag}"
    pts = grade_curves_points(grade)
    if pts:
        parts.append(f"[{cur}]curves=r='{pts['r']}':g='{pts['g']}':b='{pts['b']}'[cv_{tag}]")
        cur = f"cv_{tag}"
    hsl = (grade or {}).get("hsl") or {}
    for chan, adj in hsl.items():
        if chan not in HSL_CENTRES or not isinstance(adj, dict):
            continue
        hv, sv, lv = float(adj.get("h", 0)), float(adj.get("s", 0)), float(adj.get("l", 0))
        if abs(hv) < 1e-9 and abs(sv) < 1e-9 and abs(lv) < 1e-9:
            continue
        M, off = _hue_sat_matrix(hv, sv, lv)
        # colorchannelmixer takes EXACTLY 16 coefficients (4x4, no constant
        # term); the lightness offset rides a lutrgb step inside the branch
        # instead (val is 0..255 there, the matrix offset is 0..1).
        ccm = "colorchannelmixer=" + ":".join(
            [f"{M[0,0]:.4f}", f"{M[0,1]:.4f}", f"{M[0,2]:.4f}", "0",
             f"{M[1,0]:.4f}", f"{M[1,1]:.4f}", f"{M[1,2]:.4f}", "0",
             f"{M[2,0]:.4f}", f"{M[2,1]:.4f}", f"{M[2,2]:.4f}", "0",
             "0", "0", "0", "1"])
        parts.append(f"[{cur}]split[hsl_{tag}_{chan}_base][hsl_{tag}_{chan}_work]")
        parts.append(f"[hsl_{tag}_{chan}_work]split[hsl_{tag}_{chan}_w1][hsl_{tag}_{chan}_w2]")
        adj_label = f"hsl_{tag}_{chan}_adj"
        if abs(off) > 1e-6:
            o255 = f"{off * 255.0:+.2f}"
            parts.append(f"[hsl_{tag}_{chan}_w1]{ccm}[hsl_{tag}_{chan}_adj0]")
            parts.append(f"[hsl_{tag}_{chan}_adj0]lutrgb=r='val{o255}':g='val{o255}':b='val{o255}'[{adj_label}]")
        else:
            parts.append(f"[hsl_{tag}_{chan}_w1]{ccm}[{adj_label}]")
        # The mask MUST be rgba with the value in every channel: maskedmerge
        # blends PER PLANE, so a gray (luma-only) mask leaves the chroma
        # planes at neutral 128 = a permanent 50% chroma blend everywhere
        # (measured: whole frame washed grey). rgba replicates the value.
        parts.append(f"[hsl_{tag}_{chan}_w2]format=yuv420p,"
                     f"chromakey=color={ffmpeg_color(HSL_KEY_RGB[chan])}:similarity=0.22:blend=0.10,"
                     f"format=yuva420p,extractplanes=a,negate,format=gray,format=rgba[hsl_{tag}_{chan}_mask]")
        # The trailing format=rgba is load-bearing (found in D1.2):
        # maskedmerge negotiates a GBR-ordered format in this ffmpeg
        # build, and a later direct conversion to yuva420p reads the
        # planes as RGB — pre-fix, an untouched red measured (159,33,33)
        # and a desaturated blue stayed blue (10,9,135). The hop forces
        # the correct plane read, exactly as at the qualifier merge.
        parts.append(f"[hsl_{tag}_{chan}_base][hsl_{tag}_{chan}_adj][hsl_{tag}_{chan}_mask]"
                     f"maskedmerge,format=rgba[hsl_{tag}_{chan}_o]")
        cur = f"hsl_{tag}_{chan}_o"
    return parts, cur

# ------------------------------------------- serial grade stack (D1.1)
# A clip carries `grades` (a list, applied in order) or the legacy single
# `grade` (a one-element stack). Each layer runs the FULL grade_fc chain
# (LUT -> hue-curves -> curves -> HSL) before the next begins, exactly
# like Resolve's serial nodes and the preview's chained SVG specs.
# Disabled layers (enabled: false) are skipped. The project look stays a
# single grade applied after the stack (grade_fc at the master stage).
def clip_grades(clip):
    gs = (clip or {}).get("grades")
    if isinstance(gs, list) and gs:
        return [g for g in gs if isinstance(g, dict)]
    if (clip or {}).get("grade"):
        return [clip["grade"]]
    return []

def grades_fc(cur, clip, media_dir, tag, tmp=None):
    parts = []
    for i, g in enumerate(clip_grades(clip)):
        if g.get("enabled") is False:
            continue
        lut_path = resolve_lut(media_dir, g.get("lutId"))
        p, cur = grade_fc(cur, g, lut_path, f"{tag}g{i}", tmp)
        parts += p
    return parts, cur

# ------------------------------------------------------------- effects -> ffmpeg
def effects_fc(cur, clip, fx_values, W, H, fps, seg_dur, tmp, extras, tag):
    """Ordered effect pipeline (mirrors the client's effect list order).
    fx_values: {type: value-at-segment-start}. extras collects ffmpeg input
    arg-lists for plate/pattern streams; returns (parts, out_label)."""
    parts = []
    plain = []

    def flush_plain():
        nonlocal cur
        if plain:
            parts.append(f"[{cur}]{','.join(plain)}[fx_{tag}_{len(parts)}]")
            cur = f"fx_{tag}_{len(parts) - 1}"
            plain.clear()

    def add_input(args):
        extras.append(args)
        return len(extras) + 1  # inputs 0=media, 1=canvas, extras start at 2

    for e in clip.get("effects") or []:
        et = e.get("type")
        if e.get("enabled") is False or et not in fx_values:
            continue
        v = float(fx_values[et])
        params = e.get("params") or {}
        if et == "brightness":
            if abs(v) > 1e-6:
                plain.append(f"eq=brightness={v:.4f}")
        elif et == "contrast":
            if abs(v) > 1e-6:
                plain.append(f"eq=contrast={1 + v:.4f}")
        elif et == "saturation":
            if abs(v) > 1e-6:
                plain.append(f"eq=saturation={1 + v:.4f}")
        elif et == "blur":
            if v > 0:
                plain.append(f"gblur=sigma={min(50.0, v * 10):.2f}")
        elif et == "sharpen":
            if v > 0:
                plain.append(f"unsharp=5:5:{v:.3f}:5:5:0.000")
        elif et == "vignette":
            if v > 0:
                ang = math.pi / 2 - max(0.0, min(1.0, v)) * (math.pi / 2 - 0.15)
                plain.append(f"vignette=angle={ang:.4f}")
        elif et == "wide-angle":
            if abs(v) > 1e-6:
                plain.append(f"lenscorrection=cx=0.5:cy=0.5:k1={-0.30 * v:.4f}:k2={-0.08 * v:.4f}")
        elif et == "motion-blur":
            k = max(1, min(3, round(v))) if v > 0 else 0
            for _ in range(k):
                plain.append("tblend=all_mode=average")
        elif et == "glow":
            if v > 0:
                flush_plain()
                parts.append(f"[{cur}]split[gw_{tag}_a][gw_{tag}_b]")
                parts.append(f"[gw_{tag}_b]gblur=sigma={6 + 10 * v:.2f}[gw_{tag}_bb]")
                op = max(0.0, min(1.0, 0.30 + 0.35 * v))
                parts.append(f"[gw_{tag}_a][gw_{tag}_bb]blend=all_mode=screen:all_opacity={op:.3f}[gw_{tag}_o]")
                cur = f"gw_{tag}_o"
        elif et == "haze":
            amount = float(params.get("amount", v))
            if amount > 0:
                flush_plain()
                cx = float(params.get("cx", 0.5)) * W
                cy = float(params.get("cy", 0.42)) * H
                radius = max(W, H) * 0.75
                mp = radial_plate_png(W, H, cx, cy, radius, (1, 1, 1), 1.0,
                                      os.path.join(tmp, f"haze_{tag}.png"), invert=True)
                idx = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", mp])
                parts.append(f"[{cur}]split[hz_{tag}_s][hz_{tag}_b]")
                parts.append(f"[hz_{tag}_b]gblur=sigma={amount * 20:.2f}[hz_{tag}_bb]")
                parts.append(f"[{idx}:v]format=gray[hz_{tag}_m]")
                parts.append(f"[hz_{tag}_bb][hz_{tag}_m]alphamerge[hz_{tag}_ba]")
                parts.append(f"[hz_{tag}_s][hz_{tag}_ba]overlay=0:0:format=auto[hz_{tag}_o]")
                cur = f"hz_{tag}_o"
        elif et == "tv-lines":
            if v > 0:
                flush_plain()
                pp = tv_lines_png(W, H, v, os.path.join(tmp, f"tv_{tag}.png"))
                idx = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", pp])
                parts.append(f"[{cur}][{idx}:v]overlay=0:0:format=auto[tv_{tag}_o]")
                cur = f"tv_{tag}_o"
        elif et == "relight":
            lights = e.get("lights") or []
            for li, L in enumerate(lights):
                flush_plain()
                rgb = hex_rgb(L.get("color", "#FFFFFF"))
                pp = radial_plate_png(W, H, float(L.get("x", 0.5)) * W, float(L.get("y", 0.5)) * H,
                                      float(L.get("radius", 0.4)) * W, rgb, 1.0,
                                      os.path.join(tmp, f"relight_{tag}_{li}.png"))
                idx = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", pp])
                inten = max(0.0, min(1.0, float(L.get("intensity", 0.6))))
                parts.append(f"[{cur}][{idx}:v]blend=all_mode=screen:all_opacity={inten:.3f}[rl_{tag}_{li}_o]")
                cur = f"rl_{tag}_{li}_o"
        elif et == "turbulent-displace":
            # AE Turbulent Displace analogue (the bubble/pop-out hook):
            # a SMOOTH low-frequency noise plate (turbulence_plate_png,
            # deviations normalised to ±56) feeds ffmpeg `displace`.
            # Two decorrelated windows of the plate (y map also negated)
            # drift on bounded sine paths, so the field churns inside the
            # segment. The AMOUNT (effect value, fx-keyframable, sampled
            # per sub-segment like every effect) maps through a ^1.35
            # curve to a peak offset of ~52 px at value 1 on a 720-wide
            # canvas — a liquid bulge, not the v1 shred (v1's linear
            # x2.2 lut let offsets run past ±175 px and destroyed the
            # layer). FALLOFF (params.falloff, default 0.85, 0 = off):
            # each map is maskedmerged between flat 128 (no offset) and
            # itself through a vertical gradient — full strength at the
            # layer's bottom (the emergence line), fading to zero toward
            # the top, so a bubble clone's body stays coherent while its
            # base ripples. Maps are sized with scale2ref (a
            # transform-scaled layer is not canvas-sized) and the layer's
            # alpha is displaced with the same field and merged back —
            # `displace` itself drops alpha, which would opaque-out
            # chroma/matte layers.
            if v > 0:
                flush_plain()
                ae = params.get("amount") is not None
                if ae:
                    # AE RECIPE MODE — params carry After Effects
                    # Turbulent Displace values at face value (the Mr
                    # Drabi bubble tutorial; TUTORIAL-RECIPE.md in the
                    # reel-DcOWzJVK3tl study): amount (px), size (px),
                    # complexity (fBm detail), pin "all", evolution_rate
                    # (deg/sec — the tutorial's time*500 expression).
                    # The fx value v is a plain master scale (1.0 = the
                    # tutorial's amount verbatim): NO ^1.35 curve and
                    # NO default falloff in this mode — the recipe's
                    # coherence comes from the roto matte + Pin All,
                    # not from fading the field.
                    amt = float(params["amount"]) * v
                    size_px = max(8.0, float(params.get("size", 100.0)))
                    comp_p = max(0.2, float(params.get("complexity", 1.0)))
                    seed_p = float(params.get("seed", 0))
                    plate, M = turbulence_fbm_png(W, H, size_px, comp_p, seed_p,
                                                  os.path.join(tmp, f"turb_{tag}.png"))
                    mult = amt / 56.0
                    rate = max(0.0, float(params.get("evolution_rate", 0.0))) / 360.0
                    drift = min(M * 0.7, size_px)
                    fall_p = (max(0.0, min(1.0, float(params["falloff"])))
                              if params.get("falloff") is not None else 0.0)
                else:
                    scale_p = float(params.get("scale", 0.5))
                    seed_p = float(params.get("seed", 0))
                    evo_p = max(0.0, min(1.0, float(params.get("evolution", 0.35))))
                    fall_p = max(0.0, min(1.0, float(params.get("falloff", 0.85))))
                    plate, M = turbulence_plate_png(W, H, scale_p, seed_p,
                                                    os.path.join(tmp, f"turb_{tag}.png"))
                    peak_px = (v ** 1.35) * 52.0 * max(0.45, min(1.3, min(W, H) / 720.0))
                    mult = peak_px / 56.0
                    drift = M * 0.7 * (0.3 + 0.7 * evo_p)
                    rate = evo_p * 1.2
                idx = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", plate])
                span = 2 * M
                ph1 = (seed_p * 1.7) % 6.2832
                ph2 = (seed_p * 2.3 + 1.3) % 6.2832
                room = max(1, int(span - 2 * drift) + 1)
                bx = drift + (int(seed_p * 37) % room)
                by = drift + (int(seed_p * 57) % room)
                bx2 = drift + (int(seed_p * 37 + M * 0.9) % room)
                by2 = drift + (int(seed_p * 57 + M * 1.3) % room)
                lut = f"lut=y='clip((val-128)*{mult:.3f}+128,0,255)'"
                parts.append(f"[{idx}:v]format=gray,crop={W}:{H}:x='{bx:.1f}+{drift:.2f}*sin(2*PI*t*{rate:.3f}+{ph1:.3f})':y='{by:.1f}+{drift:.2f}*cos(2*PI*t*{rate * 0.83:.3f}+{ph2:.3f})',{lut},setsar=1[dp_{tag}_rx]")
                parts.append(f"[{idx}:v]format=gray,crop={W}:{H}:x='{bx2:.1f}+{drift:.2f}*sin(2*PI*t*{rate * 1.13:.3f}+{ph2:.3f})':y='{by2:.1f}+{drift:.2f}*cos(2*PI*t*{rate * 0.71:.3f}+{ph1:.3f})',negate,{lut},setsar=1[dp_{tag}_ry]")
                parts.append(f"[dp_{tag}_rx][{cur}]scale2ref[dp_{tag}_x][dp_{tag}_c0]")
                parts.append(f"[dp_{tag}_ry][dp_{tag}_c0]scale2ref[dp_{tag}_y][dp_{tag}_c1]")
                xmap, ymap = f"dp_{tag}_x", f"dp_{tag}_y"
                ref_lbl = f"dp_{tag}_c1"
                if fall_p > 0:
                    grad = falloff_gradient_png(W, H, fall_p,
                                                os.path.join(tmp, f"fall_{tag}.png"))
                    gidx = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", grad])
                    parts.append(f"[{gidx}:v]format=gray,setsar=1[dp_{tag}_gsrc]")
                    parts.append(f"[dp_{tag}_gsrc][{ref_lbl}]scale2ref[dp_{tag}_g0][dp_{tag}_c2]")
                    ref_lbl = f"dp_{tag}_c2"
                    parts.append(f"[dp_{tag}_g0]format=rgb24,split=3[dp_{tag}_g1][dp_{tag}_g2][dp_{tag}_gc]")
                    parts.append(f"[dp_{tag}_gc]lutrgb=r='128':g='128':b='128',split[dp_{tag}_128a][dp_{tag}_128b]")
                    parts.append(f"[dp_{tag}_x]format=rgb24[dp_{tag}_xr]")
                    parts.append(f"[dp_{tag}_y]format=rgb24[dp_{tag}_yr]")
                    parts.append(f"[dp_{tag}_128a][dp_{tag}_xr][dp_{tag}_g1]maskedmerge,format=gray[dp_{tag}_xf]")
                    parts.append(f"[dp_{tag}_128b][dp_{tag}_yr][dp_{tag}_g2]maskedmerge,format=gray[dp_{tag}_yf]")
                    xmap, ymap = f"dp_{tag}_xf", f"dp_{tag}_yf"
                if ae and str(params.get("pin", "")).lower() in ("all", "1", "1.0", "true"):
                    # AE Pinning = Pin All: displacement forced to zero
                    # at all four layer edges (envelope ramp = one
                    # feature size), maskedmerged exactly like falloff.
                    env = pin_envelope_png(W, H, size_px,
                                           os.path.join(tmp, f"pin_{tag}.png"))
                    eidx = add_input(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", env])
                    parts.append(f"[{eidx}:v]format=gray,setsar=1[dp_{tag}_esrc]")
                    parts.append(f"[dp_{tag}_esrc][{ref_lbl}]scale2ref[dp_{tag}_e0][dp_{tag}_c3]")
                    ref_lbl = f"dp_{tag}_c3"
                    parts.append(f"[dp_{tag}_e0]format=rgb24,split=3[dp_{tag}_e1][dp_{tag}_e2][dp_{tag}_ec]")
                    parts.append(f"[dp_{tag}_ec]lutrgb=r='128':g='128':b='128',split[dp_{tag}_p128a][dp_{tag}_p128b]")
                    parts.append(f"[{xmap}]format=rgb24[dp_{tag}_pxr]")
                    parts.append(f"[{ymap}]format=rgb24[dp_{tag}_pyr]")
                    parts.append(f"[dp_{tag}_p128a][dp_{tag}_pxr][dp_{tag}_e1]maskedmerge,format=gray[dp_{tag}_xfp]")
                    parts.append(f"[dp_{tag}_p128b][dp_{tag}_pyr][dp_{tag}_e2]maskedmerge,format=gray[dp_{tag}_yfp]")
                    xmap, ymap = f"dp_{tag}_xfp", f"dp_{tag}_yfp"
                parts.append(f"[{ref_lbl}]format=rgba,split[dp_{tag}_rgb][dp_{tag}_a0]")
                parts.append(f"[dp_{tag}_a0]extractplanes=a[dp_{tag}_a]")
                parts.append(f"[{xmap}]split[dp_{tag}_x1][dp_{tag}_x2]")
                parts.append(f"[{ymap}]split[dp_{tag}_y1][dp_{tag}_y2]")
                parts.append(f"[dp_{tag}_rgb][dp_{tag}_x1][dp_{tag}_y1]displace=edge=smear[dp_{tag}_col]")
                parts.append(f"[dp_{tag}_a][dp_{tag}_x2][dp_{tag}_y2]displace=edge=smear[dp_{tag}_aw]")
                parts.append(f"[dp_{tag}_col][dp_{tag}_aw]alphamerge[dp_{tag}_o]")
                cur = f"dp_{tag}_o"
    flush_plain()
    return parts, cur

# ------------------------------------------------------------- one video segment
def build_video_segment(media_path, kind, si, src_dur, speed, seg_dur, tr, clip,
                        fx_values, W, H, fps, out, tmp, ctx, opts):
    """Render one sub-segment as a full-canvas VP9-alpha webm: the clip's
    frame for timeline window length seg_dur, transformed (position is the
    segment-START position; the composite animates position between
    sub-segments). opts: reversed, minterpolate, sx_mul, extra_filters,
    lut_path, matte=(path, kind, m_si, m_src_dur, m_speed, m_reversed)|None,
    mask_png|None, crop_soft_png|None."""
    extras = []
    chain = []
    if kind == "image":
        chain.append("setpts=PTS-STARTPTS")
    else:
        chain.append(f"trim=start={si:.4f}:duration={max(0.01, src_dur):.4f}")
        chain.append("setpts=PTS-STARTPTS")
        if opts.get("reversed"):
            chain.append("reverse")
        if opts.get("minterpolate"):
            chain.append(f"minterpolate=fps={fps * 2}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir")
        if abs(speed - 1.0) > 1e-6:
            chain.append(f"setpts=PTS/{speed:.5f}")
    crop = clip.get("crop") or {}
    if any(float(crop.get(k, 0)) > 0 for k in ("l", "t", "r", "b")):
        wf = max(0.05, 1 - float(crop.get("l", 0)) - float(crop.get("r", 0)))
        hf = max(0.05, 1 - float(crop.get("t", 0)) - float(crop.get("b", 0)))
        chain.append(f"crop=iw*{wf:.4f}:ih*{hf:.4f}:iw*{float(crop.get('l', 0)):.4f}:ih*{float(crop.get('t', 0)):.4f}")
    # ---- fit: 'cover' (default) fills the canvas; 'blur-fill' (C.11)
    # letterboxes the whole frame over a blurred, stretched copy of itself.
    # Everything after the fit (chroma, flips, transform, effects, grade)
    # applies to the composited fill, exactly like the preview's layer.
    post = []
    chroma = clip.get("chromaKey")
    if chroma:
        inten = float(chroma.get("intensity", 0.5))
        shadow = float(chroma.get("shadow", 0.3))
        post.append(f"chromakey=color={ffmpeg_color(chroma.get('color', '#00FF00'))}:"
                    f"similarity={0.05 + inten * 0.35:.4f}:blend={0.08 + shadow * 0.20:.4f}")
        spill = float(chroma.get("spill", 0))
        kr, kg, kb = hex_rgb(chroma.get("color", "#00FF00"))
        if spill > 0 and (kg > 0.6 or kb > 0.6):
            post.append(f"despill=type={'green' if kg >= kb else 'blue'}:mix={spill:.3f}:expand={spill * 0.5:.3f}")
    if clip.get("flipH"):
        post.append("hflip")
    if clip.get("flipV"):
        post.append("vflip")
    s = float(tr["scale"])
    sx = s * float(opts.get("sx_mul", 1.0))
    if abs(sx - 1.0) > 1e-6 or abs(s - 1.0) > 1e-6:
        post.append(f"scale=iw*{sx:.5f}:ih*{s:.5f}")
    post.append("format=rgba")
    rot = float(tr["rotation"])
    if abs(rot) > 1e-6:
        post.append(f"rotate={math.radians(rot):.6f}:c=none")
    cover = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H}"
    if clip.get("fit") == "blur-fill":
        parts = [f"[0:v]{','.join(chain)}[bfraw]",
                 "[bfraw]split[bf_a][bf_b]",
                 f"[bf_a]{cover},gblur=sigma=25,eq=brightness=-0.03[bfbg]",
                 f"[bf_b]scale={W}:{H}:force_original_aspect_ratio=decrease,"
                 f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black@0.0[bffg]",
                 "[bfbg][bffg]overlay=0:0:format=auto[bffin]"]
        fitted = "bffin"
    else:
        parts = [f"[0:v]{','.join(chain + [cover])}[fgb]"]
        fitted = "fgb"
    # ---- matte: the clip's alpha source (matteId media), multiplied
    # into the fitted layer in LAYER space — before the transform scale
    # and before effects — so the transform moves it and the effects
    # (turbulent displace included) warp the matted alpha together
    # with the picture, exactly as AE runs effects above a roto'd
    # layer. (Until 2026-11-10 the matte multiplied the finished
    # canvas-space segment in the post-step: it could not follow a
    # transform, and it clipped a displaced layer's alpha back to its
    # undisplaced silhouette.) Masks/soft-crop stay canvas-space in
    # the post-step — they are defined in canvas fractions by design.
    matte = opts.get("matte")
    if matte:
        tg = opts["tag"]
        mpath, mkind, msi, mdur, mspeed, mrev = matte
        midx = 2 + len(extras)
        if mkind == "image":
            extras.append(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", mpath])
            mchain = "setpts=PTS-STARTPTS"
        else:
            extras.append(vin(mpath))
            mchain = (f"trim=start={msi:.4f}:duration={max(0.01, mdur):.4f},setpts=PTS-STARTPTS"
                      + (",reverse" if mrev else "")
                      + (f",setpts=PTS/{mspeed:.5f}" if abs(mspeed - 1.0) > 1e-6 else ""))
        parts.append(f"[{fitted}]format=rgba,fps={fps},split[mfg_{tg}][mfa_{tg}]")
        parts.append(f"[mfa_{tg}]extractplanes=a[malpha_{tg}]")
        parts.append(f"[{midx}:v]{mchain},scale={W}:{H}:force_original_aspect_ratio=increase,"
                     f"crop={W}:{H},format=gray,fps={fps}[mmatte_{tg}]")
        parts.append(f"[malpha_{tg}][mmatte_{tg}]blend=all_mode=multiply[malpha2_{tg}]")
        parts.append(f"[mfg_{tg}][malpha2_{tg}]alphamerge,format=yuva420p[mfin_{tg}]")
        fitted = f"mfin_{tg}"
    parts.append(f"[{fitted}]{','.join(post)}[fgraw]")
    cur = "fgraw"
    fx_parts, cur = effects_fc(cur, clip, fx_values, W, H, fps, seg_dur, tmp, extras, opts["tag"])
    parts += fx_parts
    for ef in opts.get("extra_filters") or []:
        parts.append(f"[{cur}]{ef}[ef_{opts['tag']}_{len(parts)}]")
        cur = f"ef_{opts['tag']}_{len(parts) - 1}"
    g_parts, cur = grades_fc(cur, clip, (ctx or {}).get("media_dir"), opts["tag"], tmp)
    parts += g_parts
    op = float(tr["opacity"])
    if op < 0.999:
        parts.append(f"[{cur}]colorchannelmixer=aa={op:.4f}[op_{opts['tag']}]")
        cur = f"op_{opts['tag']}"
    parts.append(f"[{cur}]fps={fps},setsar=1,format=yuva420p[fg]")
    # position: content centre sits at canvas centre + (x, y) offsets
    w0, h0 = W * sx, H * s
    if abs(rot) > 1e-6:
        cr, sr = abs(math.cos(math.radians(rot))), abs(math.sin(math.radians(rot)))
        rw, rh = w0 * cr + h0 * sr, w0 * sr + h0 * cr
    else:
        rw, rh = w0, h0
    px = (W - rw) / 2 + float(tr["x"])
    py = (H - rh) / 2 + float(tr["y"])
    # NOTE: the lavfi `color` source negotiates an OPAQUE alpha even for
    # black@0.0, which would make every segment an opaque black plate
    # wherever the clip itself is transparent (chroma keys, fades). Force
    # the canvas alpha to 0 explicitly before the overlay.
    parts.append(f"[1:v]format=rgba,colorchannelmixer=aa=0[canvas_{opts['tag']}]")
    # eof_action=pass (D1.4): when the source runs out before the window
    # ends (a short multicam angle, any over-long trim), the tail must
    # stay EMPTY — the default eof_action=repeat froze the last frame
    # over the canvas, stretching one frame across the missing span.
    parts.append(f"[canvas_{opts['tag']}][fg]overlay=x={px:.2f}:y={py:.2f}:format=auto:eof_action=pass[outv]")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    if kind == "image":
        cmd += ["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", media_path]
    else:
        cmd += vin(media_path)
    cmd += ["-f", "lavfi", "-i", f"color=c=black@0.0:s={W}x{H}:r={fps}:d={seg_dur:.3f}"]
    for ex in extras:
        cmd += ex
    cmd += ["-filter_complex", ";".join(parts), "-map", "[outv]",
            "-t", f"{seg_dur:.3f}", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
            "-b:v", "0", "-crf", "20", out]
    run(cmd)
    # ---- post-step: mask / soft-crop multiply into alpha (both are
    # canvas-space by design; the matte moved into the main chain —
    # see the fit section — where it belongs to the layer)
    if opts.get("mask_png") or opts.get("crop_soft_png"):
        pparts = ["[0:v]format=rgba,split[pfg][pfa]", "[pfa]extractplanes=a[palpha]"]
        cur_a = "palpha"
        inputs = [vin(out)]
        nidx = 1
        if opts.get("mask_png"):
            inputs.append(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", opts["mask_png"]])
            pparts.append(f"[{nidx}:v]format=gray,fps={fps}[pmask]")
            pparts.append(f"[{cur_a}][pmask]blend=all_mode=multiply[palpha2]")
            cur_a = "palpha2"; nidx += 1
        if opts.get("crop_soft_png"):
            inputs.append(["-loop", "1", "-framerate", str(fps), "-t", f"{seg_dur:.3f}", "-i", opts["crop_soft_png"]])
            pparts.append(f"[{nidx}:v]format=gray,fps={fps}[pcrop]")
            pparts.append(f"[{cur_a}][pcrop]blend=all_mode=multiply[palpha3]")
            cur_a = "palpha3"; nidx += 1
        pparts.append(f"[pfg][{cur_a}]alphamerge,format=yuva420p[pout]")
        out2 = out + ".post.webm"
        cmd = ["ffmpeg", "-y", "-v", "error"]
        for inp in inputs:
            cmd += inp
        cmd += ["-filter_complex", ";".join(pparts), "-map", "[pout]",
                "-t", f"{seg_dur:.3f}", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                "-b:v", "0", "-crf", "20", out2]
        run(cmd)
        os.replace(out2, out)
    return out

# ------------------------------------------------------- transition overlays
def render_overlay_seq(kind, dur, W, H, fps, outdir):
    """Stage overlays for flash / glare (Preview.transitionFx): full-frame
    PNG sequences composited over the whole stage during the window."""
    from PIL import Image
    import numpy as np
    n = max(1, math.ceil(dur * fps))
    os.makedirs(outdir, exist_ok=True)
    for i in range(n):
        p = (i / fps) / dur if dur > 0 else 1.0
        img = np.zeros((H, W, 4), dtype="uint8")
        img[..., 0] = img[..., 1] = img[..., 2] = 255
        if kind == "flash":
            img[..., 3] = int(255 * 0.9 * math.sin(math.pi * min(1.0, p)))
        else:  # glare: diagonal band sweeping -30% -> 130% of width
            cx = (-0.30 + 1.60 * p) * W
            yy, xx = np.mgrid[0:H, 0:W]
            xs = xx + (H / 2 - yy) * 0.268  # 105deg slant
            prof = np.clip(1 - np.abs(xs - cx) / (0.18 * W), 0, 1)
            img[..., 3] = (prof * 0.85 * 255).astype("uint8")
        Image.fromarray(img, "RGBA").save(os.path.join(outdir, "f_%04d.png" % i))
    return n

# ------------------------------------------------------- compound nests
def build_alpha_master(comp, jobs, ctx, tmp, total, out):
    """Composite + text/overlay jobs -> transparent VP9 master (nest output:
    the parent's own grade/effects/transform still apply on top)."""
    fps = ctx["fps"]
    inputs = [vin(comp)]
    parts = ["[0:v]format=yuva420p[ab]"]
    cur = "ab"
    for i, job in enumerate(jobs):
        inputs.append(["-framerate", str(fps), "-i", os.path.join(job["dir"], "f_%04d.png")])
        parts.append(f"[{i + 1}:v]format=rgba,setpts=PTS+{job['start']:.3f}/TB,tpad=stop_mode=clone:stop_duration=0.12[ao{i}]")
        parts.append(f"[{cur}][ao{i}]overlay=0:0:format=auto:eof_action=pass[ac{i}]")
        cur = f"ac{i}"
    parts.append(f"[{cur}]format=yuva420p[outv]")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for inp in inputs:
        cmd += inp
    cmd += ["-filter_complex", ";".join(parts), "-map", "[outv]", "-t", f"{total:.3f}",
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-lossless", "1", out]
    run(cmd)
    return out

def render_nest(clip, P, ctx, tmp):
    """Flatten a CompoundClip's nest to one transparent video file: the
    nested tracks are windowed with the same range maths as ranged export
    (the nest window is 1:1, in..out), composited recursively (preview caps
    depth at 4; deeper nests are skipped with a warning, never faked)."""
    import copy
    depth = ctx.get("depth", 0)
    if depth >= 4:
        sys.stderr.write("Lane B: compound nest deeper than 4 — clip skipped (preview cap)\n")
        return None
    win = float(clip["out"]) - float(clip["in"])
    if win <= 0.005:
        return None
    subP = {"version": 1, "name": (clip.get("nest") or {}).get("name", "nest"),
            "canvas": {"w": ctx["W"], "h": ctx["H"], "fps": ctx["fps"]},
            "media": [], "tracks": copy.deepcopy((clip.get("nest") or {}).get("tracks", []))}
    apply_range(subP, float(clip["in"]), float(clip["out"]))
    sub_ctx = dict(ctx)
    sub_ctx["depth"] = depth + 1
    segs, overs = collect_visual_segments(subP, sub_ctx, tmp)
    comp = composite_segments(segs, ctx["W"], ctx["H"], ctx["fps"], win, None, tmp,
                              ctx["media_dir"])
    jobs = []
    counter = 0
    for ov in overs:
        d = os.path.join(tmp, f"nest{depth}_ovl_{counter}"); counter += 1
        render_overlay_seq(ov["kind"], ov["dur"], ctx["W"], ctx["H"], ctx["fps"], d)
        jobs.append({"dir": d, "start": ov["start"]})
    for track in subP.get("tracks", []):
        if track.get("kind") != "text" or track.get("hidden"):
            continue
        for tc in track.get("clips", []):
            d = os.path.join(tmp, f"nest{depth}_text_{counter}"); counter += 1
            render_text_clip(tc, ctx["W"], ctx["H"], ctx["fps"], d, ctx["fonts"])
            jobs.append({"dir": d, "start": float(tc["start"])})
    out = os.path.join(tmp, f"nest_{depth}_{clip.get('id', 'x')}.webm")
    return build_alpha_master(comp, jobs, ctx, tmp, win, out)

def blurcut_filters(mode, direction, peak, env):
    """J.12 blur-cut envelope: (filters, scale_mul) for one side of a
    blur-masked join at envelope env (1 = peak blur at the boundary frame,
    0 = settled sharp). 'soft' = gaussian only; 'whip' = directional
    streak (avgblur along the transition direction) over a lighter
    gaussian; 'zoom' = gaussian + scale settle (1.12 at the boundary)."""
    if env <= 0.01 or peak <= 0:
        return [], 1.0
    if mode == "whip":
        streak = max(1, int(round(peak * 1.8 * env)))
        cross = max(1, int(round(peak * 0.25 * env)))
        if direction in ("left", "right"):
            f = [f"avgblur=sizeX={streak}:sizeY={cross}"]
        else:
            f = [f"avgblur=sizeX={cross}:sizeY={streak}"]
        sg = peak * 0.55 * env
        if sg > 0.05:
            f.append(f"gblur=sigma={sg:.2f}")
        return f, 1.0
    if mode == "zoom":
        sg = peak * 0.8 * env
        return ([f"gblur=sigma={sg:.2f}"] if sg > 0.05 else []), 1.0 + 0.12 * env
    sg = peak * env
    return ([f"gblur=sigma={sg:.2f}"] if sg > 0.05 else []), 1.0

# ------------------------------------------------------- segment collection
def collect_visual_segments(P, ctx, tmp):
    """Walk visible video tracks bottom-to-top in project order and render
    every clip as VP9-alpha sub-segments (split at keyframe bounds, speed
    steps, and transition-window steps). Returns (segments, overlay_jobs).
    Segment record carries canvas positions at both ends; the composite
    animates position linearly between them (the client's own model)."""
    W, H, fps = ctx["W"], ctx["H"], ctx["fps"]
    segments, overlays = [], []
    n = 0
    for track in P.get("tracks", []):
        if track.get("kind") != "video" or track.get("hidden"):
            continue
        sorted_clips = sorted(track.get("clips", []), key=lambda c: float(c["start"]))
        for clip_i, clip in enumerate(sorted_clips):
            if clip.get("adj"):
                # Adjustment clip: a composite-stream event, applied by the
                # compositor to everything beneath it (see composite pass).
                segments.append({"adj": clip, "start": float(clip["start"]),
                                 "dur": clip_dur(clip)})
                continue
            if isinstance(clip.get("nest"), dict):
                # Compound clip: flatten the nest to one video file, then
                # run it through the ordinary clip path so the compound's
                # own transform/grade/effects/mask/blend apply to the group.
                rendered = render_nest(clip, P, ctx, tmp)
                if not rendered:
                    continue
                syn = f"nest_{clip.get('id', 'x')}"
                ctx["media"][syn] = (rendered, "video")
                win = float(clip["out"]) - float(clip["in"])
                clip = {k: v for k, v in clip.items() if k != "nest"}
                clip.update({"media": syn, "in": 0.0, "out": win, "speed": 1})
                for k in ("speedKeys", "reversed", "freezeAt", "smoothSlowmo"):
                    clip.pop(k, None)
            ment = ctx["media"].get(clip.get("media"))
            if not ment:
                continue
            mpath, mkind = ment
            if mkind == "audio":
                continue
            start = float(clip["start"])
            dur = clip_dur(clip)
            if dur <= 0.005:
                continue
            # freeze: pull the frozen frame once, then treat as a still
            eff_path, eff_kind = mpath, mkind
            frozen = clip.get("freezeAt") is not None and mkind == "video"
            if frozen:
                still = os.path.join(tmp, f"freeze_{clip['media']}_{int(float(clip['freezeAt']) * 100)}.png")
                if not os.path.exists(still):
                    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{float(clip['freezeAt']):.3f}",
                         "-i", mpath, "-frames:v", "1", still])
                eff_path, eff_kind = still, "image"
            smap = None if eff_kind == "image" else SpeedMap(clip)
            span = float(clip["out"]) - float(clip["in"])
            # ---- blur-cut exit side (J.12): if the NEXT clip on this track
            # enters with a blur-cut and sits flush against this clip's end,
            # this clip's tail blurs up to the same peak at the boundary.
            exit_spec = None
            if clip_i + 1 < len(sorted_clips):
                nxt = sorted_clips[clip_i + 1]
                if nxt.get("transitionIn") == "blur-cut":
                    gap = float(nxt["start"]) - (start + dur)
                    if abs(gap) < 0.02:
                        exit_spec = {
                            "dur": max(0.03, float(nxt.get("transitionDur", 0.25))),
                            "peak": float(nxt.get("transitionBlur", 9)),
                            "mode": nxt.get("transitionMode") or "soft",
                            "dir": nxt.get("transitionDir") or "right",
                        }
            # ---- sub-segment bounds
            bounds = {0.0, dur}
            for k in clip.get("keyframes") or []:
                if 0 < float(k["t"]) < dur:
                    bounds.add(float(k["t"]))
            if clip.get("keyframes"):
                # J.12: transform values are baked per sub-segment (only
                # position animates in the composite), so a keyframed span
                # needs fine steps or a push-in visibly steps in scale.
                kf_ts = sorted(float(k["t"]) for k in clip["keyframes"]
                               if 0 < float(k["t"]) < dur)
                if len(kf_ts) >= 2:
                    lo, hi = kf_ts[0], kf_ts[-1]
                    steps = max(1, math.ceil((hi - lo) / 0.1))
                    for i in range(1, steps):
                        bounds.add(lo + (hi - lo) * i / steps)
            if smap is not None and clip.get("speedKeys"):
                steps = max(1, math.ceil(dur / 0.25))
                for i in range(1, steps):
                    bounds.add(dur * i / steps)
            trans = clip.get("transitionIn")
            tdur = max(0.03, float(clip.get("transitionDur", 0.25)))
            in_trans = bool(trans) and trans != "cut" and tdur > 0
            if in_trans:
                tw = min(tdur, dur)
                step = 0.03 if trans == "blur-cut" else 0.08
                steps = max(1, math.ceil(tw / step))
                for i in range(1, steps):
                    bounds.add(tw * i / steps)
                if trans in ("flash", "glare"):
                    overlays.append({"kind": trans, "start": start, "dur": tdur})
            exit_dur = 0.0
            if exit_spec:
                exit_dur = min(exit_spec["dur"], dur)
                if in_trans:
                    exit_dur = min(exit_dur, max(0.0, dur - min(tdur, dur)))
                if exit_dur > 0.01:
                    x0 = dur - exit_dur
                    bounds.add(x0)
                    steps = max(1, math.ceil(exit_dur / 0.03))
                    for i in range(1, steps):
                        bounds.add(x0 + exit_dur * i / steps)
                else:
                    exit_dur = 0.0
            bounds = sorted(bounds)
            # ---- matte / LUT / soft-crop assets (per clip)
            matte = None
            if clip.get("matteId") and ctx["media"].get(clip["matteId"]):
                matte = ctx["media"][clip["matteId"]]
            lut_path = None
            if clip.get("grade"):
                lut_path = resolve_lut(ctx["media_dir"], clip["grade"].get("lutId"))
            crop_soft = None
            crop = clip.get("crop") or {}
            if float(crop.get("softness", 0)) > 0:
                crop_soft = soft_crop_png(crop, W, H, os.path.join(tmp, f"softcrop_{n}.png"))
            base_tr = norm_transform(clip)
            kfs = clip.get("keyframes") or []
            for bi in range(len(bounds) - 1):
                a, b = bounds[bi], bounds[bi + 1]
                if b - a < 0.004:
                    continue
                tr_a = {p: kf_value(kfs, base_tr, p, a, dur) for p in ("x", "y", "scale", "rotation", "opacity")}
                tr_b = {p: kf_value(kfs, base_tr, p, b, dur) for p in ("x", "y", "scale", "rotation", "opacity")}
                X_a, Y_a, X_b, Y_b = tr_a["x"], tr_a["y"], tr_b["x"], tr_b["y"]
                op_a = tr_a["opacity"]
                sx_mul, extra_filters = 1.0, []
                scale_mul = 1.0
                if in_trans and a < tdur:
                    p_a = a / tdur
                    if trans == "dissolve":
                        op_a *= 0.15 + 0.85 * p_a
                    elif trans == "slide":
                        off_a, off_b = (1 - p_a) * 1.0, (1 - min(1.0, b / tdur)) * 1.0
                        d = clip.get("transitionDir") or "down"
                        if d == "down":
                            Y_a -= off_a * H; Y_b -= off_b * H
                        elif d == "up":
                            Y_a += off_a * H; Y_b += off_b * H
                        elif d == "left":
                            X_a += off_a * W; X_b += off_b * W
                        else:
                            X_a -= off_a * W; X_b -= off_b * W
                    elif trans == "shake":
                        amp_a = (1 - p_a) * 5; amp_b = (1 - min(1.0, b / tdur)) * 5
                        X_a += math.sin(a * 90) * amp_a; Y_a += math.cos(a * 113) * amp_a * 0.7
                        X_b += math.sin(b * 90) * amp_b; Y_b += math.cos(b * 113) * amp_b * 0.7
                    elif trans == "zoom":
                        e_a = 1 - (1 - p_a) ** 3
                        scale_mul = 1.18 - 0.18 * e_a
                    elif trans == "flip":
                        sx_mul = max(0.05, math.cos(math.radians((1 - p_a) * 88)))
                    elif trans == "blur-pulse":
                        sg = math.sin(math.pi * p_a) * 4.5
                        if sg > 0.05:
                            extra_filters.append(f"gblur=sigma={sg:.2f}")
                    elif trans == "blur-cut":
                        # J.12 incoming side: envelope 1 at the boundary
                        # frame (a = 0), settling to 0 at the window end.
                        env = 1.0 - min(1.0, a / tw) if tw > 0 else 0.0
                        fs, sm = blurcut_filters(clip.get("transitionMode") or "soft",
                                                 clip.get("transitionDir") or "right",
                                                 float(clip.get("transitionBlur", 9)), env)
                        extra_filters += fs
                        scale_mul *= sm
                    elif trans == "invert-flash":
                        extra_filters.append("negate")
                if exit_spec and exit_dur > 0.01 and b > dur - exit_dur:
                    # J.12 outgoing side: envelope by segment END so the
                    # last frame before the boundary carries the full peak.
                    env_e = (b - (dur - exit_dur)) / exit_dur
                    fs, sm = blurcut_filters(exit_spec["mode"], exit_spec["dir"],
                                             exit_spec["peak"], env_e)
                    extra_filters += fs
                    scale_mul *= sm
                tr_seg = dict(tr_a)
                tr_seg["x"], tr_seg["y"] = X_a, Y_a
                tr_seg["opacity"] = op_a
                tr_seg["scale"] = tr_a["scale"] * scale_mul
                fx_values = {}
                for e in clip.get("effects") or []:
                    if e.get("enabled") is False:
                        continue
                    val = effect_value_at(clip, e.get("type"), a)
                    if val is not None:
                        fx_values[e["type"]] = val
                # ---- source window for this sub-segment
                if eff_kind == "image":
                    si, src_dur, speed, rev = 0.0, b - a, 1.0, False
                elif clip.get("reversed"):
                    S_a, S_b = smap.source_at(a), smap.source_at(b)
                    si = float(clip["in"]) + (span - S_b)
                    src_dur = max(0.01, S_b - S_a)
                    speed = src_dur / (b - a)
                    rev = True
                else:
                    S_a, S_b = smap.source_at(a), smap.source_at(b)
                    si = float(clip["in"]) + S_a
                    src_dur = max(0.01, S_b - S_a)
                    speed = src_dur / (b - a)
                    rev = False
                matte_arg = None
                if matte:
                    mpath2, mkind2 = matte
                    if mkind2 == "image":
                        matte_arg = (mpath2, "image", 0.0, b - a, 1.0, False)
                    elif clip.get("reversed"):
                        matte_arg = (mpath2, mkind2, span - S_b, src_dur, speed, True)
                    else:
                        matte_arg = (mpath2, mkind2, S_a, src_dur, speed, False)
                mask_png = None
                if clip.get("mask"):
                    geom = mask_at(clip, a)
                    mask_png = make_mask_png(clip["mask"], geom, W, H,
                                             os.path.join(tmp, f"mask_{n}.png"))
                if in_trans and trans == "mask-wipe" and a < tdur:
                    # J.11: circular reveal growing from the wipe origin;
                    # radius follows the CSS circle() percentage basis.
                    from PIL import Image, ImageChops
                    p_a = a / tdur
                    radius = p_a * 1.5 * (math.hypot(W, H) / math.sqrt(2))
                    cx = clip.get("wipeCx")
                    cy = clip.get("wipeCy")
                    wipe_png = make_wipe_png(0.5 if cx is None else float(cx),
                                             0.5 if cy is None else float(cy),
                                             radius, W, H,
                                             os.path.join(tmp, f"wipe_{n}.png"),
                                             str(clip.get("wipeShape") or "circle"))
                    if mask_png:
                        merged = ImageChops.multiply(Image.open(mask_png).convert("L"),
                                                     Image.open(wipe_png).convert("L"))
                        mask_png = _save(merged, os.path.join(tmp, f"maskwipe_{n}.png"))
                    else:
                        mask_png = wipe_png
                smooth = bool(clip.get("smoothSlowmo")) and eff_kind != "image" and speed < 0.99
                seg_file = os.path.join(tmp, f"seg_{n}.webm")
                build_video_segment(eff_path, eff_kind, si, src_dur, speed, b - a,
                                    tr_seg, clip, fx_values, W, H, fps, seg_file, tmp, ctx,
                                    {"reversed": rev, "minterpolate": smooth,
                                     "sx_mul": sx_mul, "extra_filters": extra_filters,
                                     "lut_path": lut_path, "matte": matte_arg,
                                     "mask_png": mask_png, "crop_soft_png": crop_soft,
                                     "tag": f"s{n}"})
                blend = clip.get("blend") or "normal"
                segments.append({"file": seg_file, "start": start + a, "dur": b - a,
                                 "x0": X_a, "y0": Y_a, "x1": X_b, "y1": Y_b,
                                 "blend": blend if blend != "normal" else None})
                n += 1
    return segments, overlays

# ------------------------------------------------------------- compositing
def _encode_canvas_stream(inputs, fc, out, total):
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for inp in inputs:
        cmd += inp
    cmd += ["-filter_complex", fc, "-map", "[outv]", "-t", f"{total:.3f}",
            "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-lossless", "1", out]
    run(cmd)
    return out

def composite_segments(segments, W, H, fps, total, bg_hex, tmp, media_dir=None):
    base = os.path.join(tmp, "base.webm")
    base_col = f"{ffmpeg_color(bg_hex)}@1.0" if bg_hex else "black@0.0"
    base_cmd = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi",
                "-i", f"color=c={base_col}:s={W}x{H}:r={fps}:d={total:.3f}"]
    if not bg_hex:
        # transparent base (nests): the color source negotiates opaque
        # alpha even for @0.0 — force it (same fix as the segment canvas)
        base_cmd += ["-vf", "format=rgba,colorchannelmixer=aa=0"]
    base_cmd += ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-lossless", "1", base]
    run(base_cmd)
    current = base
    batch = []
    counter = [0]

    def flush(cur):
        if not batch:
            return cur
        counter[0] += 1
        out = os.path.join(tmp, f"comp_{counter[0]}.webm")
        inputs = [vin(cur)] + [vin(s["file"]) for s in batch]
        parts = ["[0:v]format=rgba[cb]"]
        cur_lbl = "cb"
        for i, s in enumerate(batch):
            parts.append(f"[{i + 1}:v]format=yuva420p,setpts=PTS+{s['start']:.3f}/TB,tpad=stop_mode=clone:stop_duration=0.12[cs{i}]")
            dx = (s["x1"] - s["x0"]) / max(0.01, s["dur"])
            dy = (s["y1"] - s["y0"]) / max(0.01, s["dur"])
            xe = f"{dx:.3f}*(t-{s['start']:.3f})"
            ye = f"{dy:.3f}*(t-{s['start']:.3f})"
            parts.append(f"[{cur_lbl}][cs{i}]overlay=x='{xe}':y='{ye}'"
                         f":enable='between(t,{s['start']:.3f},{s['start'] + s['dur']:.3f})':format=auto:eof_action=pass[co{i}]")
            cur_lbl = f"co{i}"
        parts.append(f"[{cur_lbl}]format=yuva420p[outv]")
        batch.clear()
        return _encode_canvas_stream(inputs, ";".join(parts), out, total)

    def blend_pass(cur, s):
        counter[0] += 1
        out = os.path.join(tmp, f"comp_{counter[0]}.webm")
        mode = {"screen": "screen", "multiply": "multiply", "overlay": "overlay",
                "lighten": "lighten", "darken": "darken", "hard-light": "hardlight"}[s["blend"]]
        st, en = s["start"], s["start"] + s["dur"]
        parts = [
            "[0:v]format=rgba,split[bbase][bwin0]",
            f"[bwin0]trim=start={st:.3f}:end={en:.3f},setpts=PTS-STARTPTS[bwin]",
            "[1:v]format=rgba,setpts=PTS-STARTPTS[bsg]",
            "[bsg]split[bs1][bs2]",
            "[bwin]format=rgb24[brgb]",
            "[bs1]format=rgb24[srgb]",
            f"[brgb][srgb]blend=all_mode={mode}[bbl]",
            "[bs2]extractplanes=a[bsa]",
            "[bbl]format=rgba[blrgba]",
            "[blrgba][bsa]alphamerge[bwinout]",
            f"[bwinout]setpts=PTS+{st:.3f}/TB[bwinback]",
            "[bbase][bwinback]overlay=0:0:format=auto:eof_action=pass[bout]",
            "[bout]format=yuva420p[outv]",
        ]
        return _encode_canvas_stream([vin(cur), vin(s["file"])], ";".join(parts), out, total)

    def adjustment_pass(cur, s):
        """Adjustment clip (I.12): apply its effects + grade to the window
        of the composite built so far (everything beneath it)."""
        counter[0] += 1
        out = os.path.join(tmp, f"comp_{counter[0]}.webm")
        clip = s["adj"]
        st, en = s["start"], s["start"] + s["dur"]
        extras = []
        fx_values = {}
        for e in clip.get("effects") or []:
            if e.get("enabled") is not False:
                fx_values[e["type"]] = float(e.get("value", 0))
        tag = f"adj{counter[0]}"
        parts = ["[0:v]format=rgba,split[abase][awin0]",
                 f"[awin0]trim=start={st:.3f}:end={en:.3f},setpts=PTS-STARTPTS[awin]"]
        cur_lbl = "awin"
        fx_parts, cur_lbl = effects_fc(cur_lbl, clip, fx_values, W, H, fps, s["dur"],
                                       tmp, extras, tag)
        parts += fx_parts
        g_parts, cur_lbl = grades_fc(cur_lbl, clip, media_dir, tag, tmp)
        parts += g_parts
        # D2.1: a windowed adjustment multiplies the graded window's
        # alpha by the (possibly tracked) mask video before overlaying.
        mask_vid = None
        if clip.get("mask"):
            mask_vid = build_mask_video(clip, s["dur"], W, H, fps, tmp, tag)
        if mask_vid:
            ni = 2 + len(extras)
            parts.append(f"[{cur_lbl}]format=rgba[abackpre]")
            parts.append(f"[{ni}:v]format=gray,fps={fps}[amaskv]")
            parts.append(f"[abackpre][amaskv]alphamerge,setpts=PTS+{st:.3f}/TB[aback]")
        else:
            parts.append(f"[{cur_lbl}]format=rgba,setpts=PTS+{st:.3f}/TB[aback]")
        parts.append("[abase][aback]overlay=0:0:format=auto:eof_action=pass[aout]")
        parts.append("[aout]format=yuva420p[outv]")
        # input 1 is an unreferenced dummy so effects_fc plate inputs keep
        # the indices its add_input assigns (extras start at input 2)
        inputs = [vin(cur), ["-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1"]] + extras
        if mask_vid:
            inputs.append(vin(mask_vid))
        return _encode_canvas_stream(inputs, ";".join(parts), out, total)

    for s in segments:
        if s.get("adj"):
            current = flush(current)
            current = adjustment_pass(current, s)
        elif s["blend"]:
            current = flush(current)
            current = blend_pass(current, s)
        else:
            batch.append(s)
    current = flush(current)
    return current

def apply_reframe_crop(master, points, W, H, tmp):
    """D2.2 smart reframe: crop the finished master to 9:16 with the
    window centre following the smoothed subject path (piecewise-
    linear in t, generated as an ffmpeg expression of clipped ramps —
    the same path the client smoothed to <= 40 px/frame). Returns
    (path, w2)."""
    w2 = max(2, int(round(H * 9 / 16 / 2)) * 2)
    xs = []
    for p in points:
        cx = min(1.0, max(0.0, float(p["cx"])))
        xs.append((float(p["t"]), min(float(W - w2), max(0.0, cx * W - w2 / 2))))
    xs.sort(key=lambda q: q[0])
    if not xs:
        xs = [(0.0, (W - w2) / 2)]
    expr = f"{xs[0][1]:.2f}"
    for i in range(len(xs) - 1):
        t0, x0 = xs[i]
        t1, x1 = xs[i + 1]
        dt = max(0.001, t1 - t0)
        slope = (x1 - x0) / dt
        if abs(slope) > 1e-9:
            expr += f"+{slope:.4f}*clip(t-{t0:.3f},0,{dt:.3f})"
    out = os.path.join(tmp, "reframed.webm")
    run(["ffmpeg", "-y", "-v", "error", *vin(master),
         "-vf", f"crop=w={w2}:h={H}:x='{expr}':y=0,format=yuva420p",
         "-c:v", "libvpx-vp9", "-lossless", "1", out])
    return out, w2


# ------------------------------------------------------------- master pass
def build_master(comp, P, text_jobs, overlays, ctx, tmp, total):
    """Overlay text + transition stage overlays onto the composite, apply
    the project look, and encode the crf-10 master intermediate."""
    W, H, fps = ctx["W"], ctx["H"], ctx["fps"]
    inputs = [vin(comp)]
    parts = ["[0:v]format=rgba[mb]"]
    cur = "mb"
    jobs = list(overlays) + list(text_jobs)
    for i, job in enumerate(jobs):
        inputs.append(["-framerate", str(fps), "-i", os.path.join(job["dir"], "f_%04d.png")])
        parts.append(f"[{i + 1}:v]format=rgba,setpts=PTS+{job['start']:.3f}/TB,tpad=stop_mode=clone:stop_duration=0.12[mo{i}]")
        parts.append(f"[{cur}][mo{i}]overlay=0:0:format=auto:eof_action=pass[mc{i}]")
        cur = f"mc{i}"
    look = P.get("look")
    if look and not grade_is_identity(look):
        lut_path = resolve_lut(ctx["media_dir"], look.get("lutId"))
        g_parts, cur = grade_fc(cur, look, lut_path, "look", tmp)
        parts += g_parts
    parts.append(f"[{cur}]format=yuv420p[outv]")
    out = os.path.join(tmp, "master.mp4")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for inp in inputs:
        cmd += inp
    cmd += ["-filter_complex", ";".join(parts), "-map", "[outv]", "-t", f"{total:.3f}",
            "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p",
            "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", out]
    run(cmd)
    return out

# ------------------------------------------------------------- timing
import time as _time
import resource as _resource
TIMINGS = {}
_T0 = _time.perf_counter()

class _StageCtx:
    def __init__(self, name):
        self.name = name
    def __enter__(self):
        self.t = _time.perf_counter()
    def __exit__(self, *a):
        TIMINGS[self.name] = TIMINGS.get(self.name, 0.0) + (_time.perf_counter() - self.t)

def stage(name):
    return _StageCtx(name)

def cpu_seconds():
    s = _resource.getrusage(_resource.RUSAGE_SELF)
    c = _resource.getrusage(_resource.RUSAGE_CHILDREN)
    return s.ru_utime + s.ru_stime + c.ru_utime + c.ru_stime

# ------------------------------------------------------------- audio
def atempo_chain(speed):
    parts = []
    s = float(speed)
    while s > 2.0:
        parts.append("atempo=2.0"); s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5"); s /= 0.5
    if abs(s - 1.0) > 1e-6 or not parts:
        parts.append(f"atempo={s:.5f}")
    return parts

def audio_windows(clip):
    """[(src_start_abs, src_dur, speed, reversed)] in timeline order, or
    None for a freeze clip (silence). Mirrors the video speed stepping."""
    if clip.get("freezeAt") is not None:
        return None
    dur = clip_dur(clip)
    smap = SpeedMap(clip)
    span = float(clip["out"]) - float(clip["in"])
    if clip.get("speedKeys"):
        steps = max(1, math.ceil(dur / 0.25))
        bounds = [dur * i / steps for i in range(steps + 1)]
    else:
        bounds = [0.0, dur]
    wins = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        S_a, S_b = smap.source_at(a), smap.source_at(b)
        sp = (S_b - S_a) / (b - a)
        if clip.get("reversed"):
            wins.append((float(clip["in"]) + (span - S_b), S_b - S_a, sp, True))
        else:
            wins.append((float(clip["in"]) + S_a, S_b - S_a, sp, False))
    return wins

def volume_env_expr(clip, dur, gain):
    """ffmpeg volume expression reproducing compose.volumeAt semantics:
    clamp(clip volume x track volume x fade envelope x key envelope, 0, 1),
    t = clip-local seconds. See README for the three-level model note."""
    FI = float(clip.get("fadeIn") or 0)
    FO = float(clip.get("fadeOut") or 0)
    fin = f"if(lt(t,{FI:.4f}),t/{FI:.4f},1)" if FI > 0 else "1"
    fout = f"if(gt(t,{dur - FO:.4f}),max(0,({dur:.4f}-t)/{FO:.4f}),1)" if FO > 0 else "1"
    keys = sorted(clip.get("volumeKeys") or [], key=lambda k: float(k["t"]))
    if keys:
        pts = [(float(k["t"]), float(k["v"])) for k in keys]
        expr = f"{pts[-1][1]:.4f}"
        for i in range(len(pts) - 2, -1, -1):
            t0, v0 = pts[i]; t1, v1 = pts[i + 1]
            if t1 - t0 < 1e-6:
                continue
            expr = (f"if(lt(t,{t1:.4f}),{v0:.4f}+({v1:.4f}-{v0:.4f})*(t-{t0:.4f})"
                    f"/{t1 - t0:.4f},{expr})")
        if pts[0][0] > 0:
            expr = f"if(lt(t,{pts[0][0]:.4f}),{pts[0][1]:.4f},{expr})"
        kexpr = expr
    else:
        kexpr = "1"
    return f"min(1,max(0,{gain:.4f}*{fin}*{fout}*{kexpr}))"

def _audio_sources(tracks, ctx, offset, gain_mul, out, bus_override=None):
    """Recursively collect audible (clip, media_path, track_gain, bus)
    sources, honouring track flags per level. Compound clips recurse:
    their nest is windowed with the ranged-export maths, shifted to the
    compound's start, and gained by the compound's volume (the preview's
    follower model). D2.5: each source carries its track's Fairlight
    bus (a compound's inner sources ride the OUTER track's bus)."""
    import copy
    tracks_a = [t for t in tracks if t.get("kind") in ("audio", "video")]
    any_solo = any(t.get("solo") and not t.get("hidden") for t in tracks_a)
    for track in tracks_a:
        if track.get("hidden") or track.get("muted"):
            continue
        if any_solo and not track.get("solo"):
            continue
        tvol = track.get("volume")
        tvol = 1.0 if tvol is None else float(tvol)
        eff_bus = bus_override if bus_override is not None else track.get("bus")
        for clip in sorted(track.get("clips", []), key=lambda c: float(c["start"])):
            if clip.get("adj"):
                continue
            if isinstance(clip.get("nest"), dict):
                sub = {"tracks": copy.deepcopy(clip["nest"].get("tracks", []))}
                apply_range(sub, float(clip["in"]), float(clip["out"]))
                _audio_sources(sub["tracks"], ctx, offset + float(clip["start"]),
                               gain_mul * tvol * float(clip.get("volume") or 1), out,
                               bus_override=eff_bus)
                continue
            ment = ctx["media"].get(clip.get("media"))
            if not ment:
                continue
            mpath, mkind = ment
            if track.get("kind") == "video":
                if mkind != "video" or clip.get("muted") or not has_audio(mpath):
                    continue
            elif mkind != "audio":
                continue
            c2 = dict(clip)
            c2["start"] = float(clip["start"]) + offset
            out.append((c2, mpath, tvol * gain_mul, eff_bus))
    return out

def build_premix(P, ctx, total, tmp, bus):
    """One ffmpeg pass building the full mix WAV: per-source retime +
    volume envelope + pan/EQ/denoise/voice-FX, three-level gains, bus
    master gain + compressor. Loudnorm happens at the final encode.
    Returns the premix path or None when the project has no sound."""
    inputs, parts, labels = [], [], []
    idx = 0
    for clip, mpath, tvol, clip_bus in _audio_sources(P.get("tracks", []), ctx, 0.0, 1.0, []):
        if True:
            dur = clip_dur(clip)
            start = float(clip["start"])
            i = idx; idx += 1
            windows = audio_windows(clip)
            if windows is None:  # freeze -> silence for the clip's duration
                ni = len(inputs)
                inputs.append(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"])
                parts.append(f"[{ni}:a]atrim=0:{dur:.3f},asetpts=PTS-STARTPTS[acat{i}]")
            else:
                # D1.5: voice isolation blends the demucs stem against
                # the original by strength — the same window chain runs
                # on both sources, weighted, then mixed. The input index
                # (ni) is tracked separately from the clip label index
                # (i) because one clip may now own two inputs.
                srcs = [(mpath, 1.0)]
                ov = clip.get("audioOverride") or {}
                if ov.get("enabled") and ov.get("stemMedia"):
                    ment = ctx["media"].get(ov["stemMedia"])
                    if ment:
                        s = min(1.0, max(0.0, float(ov.get("strength", 1))))
                        srcs = [(p, w) for p, w in ((mpath, 1.0 - s), (ment[0], s)) if w > 0.001] or [(mpath, 1.0)]
                cat_labels = []
                for j, (spath, wgt) in enumerate(srcs):
                    ni = len(inputs)
                    inputs.append(["-i", spath])
                    if len(windows) > 1:
                        parts.append(f"[{ni}:a]asplit={len(windows)}" +
                                     "".join(f"[asp{i}_{j}_{w}]" for w in range(len(windows))))
                    wlabels = []
                    for wi, (ss, sd, sp, rev) in enumerate(windows):
                        src_lbl = f"asp{i}_{j}_{wi}" if len(windows) > 1 else f"{ni}:a"
                        c = (f"[{src_lbl}]atrim=start={ss:.4f}:duration={max(0.01, sd):.4f},"
                             "asetpts=PTS-STARTPTS,aresample=48000,"
                             "aformat=sample_fmts=fltp:channel_layouts=stereo")
                        if rev:
                            c += ",areverse"
                        if clip.get("pitchPreserve") is False:
                            c += f",asetrate=48000*{sp:.5f},aresample=48000"
                        elif abs(sp - 1.0) > 1e-6:
                            c += "," + ",".join(atempo_chain(sp))
                        c += f"[aw{i}_{j}_{wi}]"
                        parts.append(c)
                        wlabels.append(f"[aw{i}_{j}_{wi}]")
                    if len(windows) > 1:
                        parts.append("".join(wlabels) + f"concat=n={len(windows)}:v=0:a=1[acat{i}_{j}]")
                    else:
                        parts.append(f"[aw{i}_{j}_0]anull[acat{i}_{j}]")
                    cat_labels.append((j, wgt))
                if len(cat_labels) > 1:
                    for j, wgt in cat_labels:
                        parts.append(f"[acat{i}_{j}]volume={wgt:.4f}[acatw{i}_{j}]")
                    wl = "".join(f"[acatw{i}_{j}]" for j, _ in cat_labels)
                    parts.append(wl + f"amix=inputs={len(cat_labels)}:normalize=0[acat{i}]")
                else:
                    parts.append(f"[acat{i}_{cat_labels[0][0]}]anull[acat{i}]")
            gain = float(clip.get("volume", 1)) * tvol
            expr = volume_env_expr(clip, dur, gain)
            post = [f"volume='{expr}':eval=frame"]
            pan = float(clip.get("pan") or 0)
            if abs(pan) > 1e-6:
                post.append(f"stereotools=balance={pan:.3f}")
            bands = clip.get("eqBands")
            if bands:
                # D2.5 parametric EQ: RBJ peaking, the same maths as
                # the preview's WebAudio biquads (dB 1:1).
                for b in bands:
                    g = float(b.get("gain", 0))
                    if abs(g) > 0.01:
                        post.append(f"equalizer=f={float(b.get('freq', 1000)):.0f}"
                                    f":t=q:w={float(b.get('q', 0.9)):.2f}:g={g:.2f}")
            else:
                # Legacy 3-band: the fields are dB (types.ts K.10, the
                # preview applies them 1:1) — the old x12 scaling
                # contradicted both; fixed with the D2.5 pass.
                for filt, val in (("lowshelf=f=200", clip.get("eqLow")),
                                  ("equalizer=f=1000:t=q:w=1", clip.get("eqMid")),
                                  ("highshelf=f=4000", clip.get("eqHigh"))):
                    if val:
                        post.append(f"{filt}:g={float(val):.2f}")
            if clip.get("denoise"):
                post.append(f"afftdn=nr={4 + float(clip['denoise']) * 20:.1f}")
            fx = clip.get("voiceFx")
            if fx == "echo":
                post.append("aecho=0.8:0.88:60:0.4")
            elif fx == "hall":
                post.append("aecho=0.8:0.9:80|160:0.35|0.25")
            ms = int(round(start * 1000))
            post.append(f"adelay={ms}|{ms}")
            post.append("apad")
            post.append(f"atrim=0:{total:.3f}")
            parts.append(f"[acat{i}]" + ",".join(post) + f"[asrc{i}]")
            labels.append((f"[asrc{i}]", clip_bus))
    if not labels:
        return None
    # D2.5 ducking: dialogue-bus sources key a sidechain compressor on
    # everything else. Only when both groups exist — otherwise the mix
    # graph is exactly the pre-D2.5 single amix.
    duck = bus.get("ducking") or {}
    dlg = [l for l, b in labels if b == "dialogue"]
    oth = [l for l, b in labels if b != "dialogue"]
    if duck.get("enabled") and dlg and oth:
        parts.append("".join(dlg) + f"amix=inputs={len(dlg)}:normalize=0[dlg_mix]")
        parts.append("".join(oth) + f"amix=inputs={len(oth)}:normalize=0[oth_mix]")
        amt = float(duck.get("amount", 10))
        ratio = max(1.5, min(24.0, 2.0 + amt * 0.9))
        parts.append(f"[oth_mix][dlg_mix]sidechaincompress=threshold=0.02"
                     f":ratio={ratio:.2f}"
                     f":attack={float(duck.get('attack', 20)):.0f}"
                     f":release={float(duck.get('release', 300)):.0f}"
                     f":makeup=1[ducked]")
        mix = "[dlg_mix][ducked]amix=inputs=2:normalize=0"
    else:
        mix = "".join(l for l, _ in labels) + f"amix=inputs={len(labels)}:normalize=0"
    mg = float(bus.get("masterGain", 1))
    if abs(mg - 1.0) > 1e-6:
        mix += f",volume={mg:.4f}"
    if bus.get("compressor"):
        thr = 10 ** (float(bus.get("compThreshold", -18)) / 20)
        mk = 10 ** (float(bus.get("compMakeup", 0)) / 20)
        mix += (f",acompressor=threshold={thr:.5f}:ratio={float(bus.get('compRatio', 3)):.2f}"
                f":makeup={mk:.3f}:attack=10:release=200")
    parts.append(mix + "[prem]")
    out = os.path.join(tmp, "premix.wav")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for inp in inputs:
        cmd += inp
    cmd += ["-filter_complex", ";".join(parts), "-map", "[prem]",
            "-t", f"{total:.3f}", "-c:a", "pcm_s16le", "-ar", "48000", out]
    run(cmd)
    return out

# Phase 3: loudness targets. Preset name -> integrated LUFS for the
# loudnorm pass (TP stays -1, LRA stays 11). The default ('social',
# -14) reproduces the historic hardcoded behaviour exactly.
LOUDNESS_PRESETS = {
    "social": -14, "youtube": -14, "spotify": -14, "apple": -16,
    "podcast": -16, "broadcast_eu": -23, "broadcast_us": -24,
}

def _fmt_lufs(v):
    f = float(v)
    return str(int(f)) if f == int(f) else f"{f:g}"

def loudness_target(opts):
    """Resolve the job output `loudness` option (a LOUDNESS_PRESETS name
    or a numeric LUFS value) to a float target. Absent or unrecognised
    -> -14.0, the historic default."""
    raw = (opts or {}).get("loudness")
    if raw is None:
        return -14.0
    if isinstance(raw, str):
        key = raw.strip().lower()
        if key in LOUDNESS_PRESETS:
            return float(LOUDNESS_PRESETS[key])
        try:
            return float(key)
        except ValueError:
            return -14.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return -14.0

def loudnorm_measure(path, target=-14.0):
    r = subprocess.run(["ffmpeg", "-i", path, "-af",
                        f"loudnorm=I={_fmt_lufs(target)}:TP=-1:LRA=11:print_format=json",
                        "-f", "null", "-"], capture_output=True, text=True)
    import re
    m = re.search(r"\{\s*\"input_i\".*?\}", r.stderr or "", re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None

# ------------------------------------------------------------- ranged export
def apply_range(P, r0, r1):
    """Trim the project in memory to [r0, r1] (job output.range)."""
    for track in P.get("tracks", []):
        kept = []
        for clip in track.get("clips", []):
            dur = clip_dur(clip)
            start = float(clip["start"])
            end = start + dur
            if end <= r0 or start >= r1:
                continue
            c = dict(clip)
            if start < r0:
                shift = r0 - start
                if "dur" in c and "in" not in c:
                    c["dur"] = dur - shift
                else:
                    if c.get("freezeAt") is not None:
                        adv = shift * (float(c.get("speed", 1)) or 1.0)
                    else:
                        adv = SpeedMap(c).source_at(shift)
                    c["in"] = float(c["in"]) + adv
                    keys = c.get("speedKeys")
                    if keys:
                        sp_at = speed_at_source(keys, adv)
                        nk = [{"t": 0.0, "speed": sp_at}]
                        for k in keys:
                            if float(k["t"]) > adv:
                                nk.append({"t": float(k["t"]) - adv, "speed": k["speed"]})
                        c["speedKeys"] = nk
                c["start"] = 0.0
            else:
                c["start"] = start - r0
            ndur = clip_dur(c)
            allowed = r1 - float(c["start"])
            if ndur > allowed:
                if "dur" in c and "in" not in c:
                    c["dur"] = allowed
                elif c.get("freezeAt") is not None:
                    c["out"] = float(c["in"]) + allowed * (float(c.get("speed", 1)) or 1.0)
                else:
                    c["out"] = float(c["in"]) + SpeedMap(c).source_at(allowed)
            kept.append(c)
        track["clips"] = kept
    return P

# ------------------------------------------------------------- final encodes
def _even(n):
    n = int(round(n))
    return max(2, n - (n % 2))

def encode_outputs(master, premix, loud, P, opts, audio_opts, out_path, ctx, total):
    W, H, fps = ctx["W"], ctx["H"], ctx["fps"]
    container = (opts.get("container") or "mp4").lower()
    stem, _ext = os.path.splitext(out_path)
    main_out = stem + "." + container
    codec = (opts.get("codec") or "h264").lower()
    vcodec = "libx265" if codec == "h265" else "libx264"
    size = opts.get("size") or "canvas"
    if size == "canvas":
        tw, th = W, H
    else:
        short = {"p720": 720, "p1080": 1080, "uhd": 2160}.get(size, min(W, H))
        if W <= H:
            tw, th = _even(short), _even(short * H / W)
        else:
            tw, th = _even(short * W / H), _even(short)
    fps_out = int(opts.get("fps") or fps)
    normalise = bool(audio_opts.get("normalise", True)) if audio_opts is not None else True
    # Phase 3: loudness target for the encode pass ('social'/-14 = historic).
    tgt = _fmt_lufs(loudness_target(opts))
    outputs = []

    polish = opts.get("polish") or {}

    def encode(dest, tw2, th2, crop_ratio=None):
        vf = []
        # D2.3 render polish: temporal denoise at native res before any
        # scale; film grain last, at the output res.
        dn = float(polish.get("denoise") or 0)
        if dn > 0:
            # strength 1 = the strong profile measured in the D2.3 pass
            # (frame-diff noise floor -32% on the noise fixture).
            vf.append(f"hqdn3d={1 + 17 * dn:.2f}:{1 + 13 * dn:.2f}:{2 + 26 * dn:.2f}:{2 + 18 * dn:.2f}")
        if crop_ratio:
            rw, rh = crop_ratio
            r = rw / rh
            if r > W / H:
                cw, chh = W, _even(W / r)
            else:
                cw, chh = _even(H * r), H
            vf.append(f"crop={cw}:{chh}")
            tw2, th2 = cw, chh
        if (tw2, th2) != (W, H):
            vf.append(f"scale={tw2}:{th2}")
        if fps_out != fps:
            vf.append(f"fps={fps_out}")
        gr = float(polish.get("grain") or 0)
        if gr > 0:
            vf.append(f"noise=alls={int(round(3 + 37 * gr))}:allf=t")
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", master]
        if premix:
            cmd += ["-i", premix]
        if vf:
            cmd += ["-vf", ",".join(vf)]
        cmd += ["-c:v", vcodec]
        if opts.get("bitrateKbps") and opts.get("crf") is None:
            cmd += ["-b:v", f"{int(opts['bitrateKbps'])}k"]
        else:
            cmd += ["-crf", str(int(opts.get("crf", 18)))]
        if vcodec == "libx265":
            cmd += ["-tag:v", "hvc1"]
        cmd += ["-pix_fmt", "yuv420p", "-color_primaries", "bt709",
                "-color_trc", "bt709", "-colorspace", "bt709"]
        if premix:
            af = None
            if normalise:
                if loud:
                    af = (f"loudnorm=I={tgt}:TP=-1:LRA=11:"
                          f"measured_I={loud['input_i']}:measured_TP={loud['input_tp']}:"
                          f"measured_LRA={loud['input_lra']}:measured_thresh={loud['input_thresh']}:"
                          f"offset={loud['target_offset']}:linear=true,aresample=48000")
                else:
                    af = f"loudnorm=I={tgt}:TP=-1:LRA=11,aresample=48000"
            cmd += ["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "160k"]
            if af:
                cmd += ["-af", af]
        cmd += ["-map_metadata", "-1"]
        if container in ("mp4", "mov"):
            cmd += ["-movflags", "+faststart"]
        cmd += ["-t", f"{total:.3f}", dest]
        run(cmd)
        return dest

    encode(main_out, tw, th)
    outputs.append({"kind": "render", "file": os.path.basename(main_out)})
    for ratio in opts.get("alsoFormats") or []:
        try:
            rw, rh = (int(x) for x in str(ratio).split(":"))
        except Exception:
            continue
        dest = f"{stem}_{rw}x{rh}.{container}"
        encode(dest, W, H, crop_ratio=(rw, rh))
        outputs.append({"kind": "also-format", "format": ratio, "file": os.path.basename(dest)})
    # Phase 3: GIF companion (output option format 'gif' or gif: true) —
    # two-pass palettegen/paletteuse off the master intermediate, capped
    # at 15 fps and 720 px wide. Only runs when the job asks for it.
    if opts.get("format") == "gif" or opts.get("gif"):
        gif_dest = stem + ".gif"
        gf = max(1, min(15, int(fps)))
        gw = max(2, min(720, int(W)))
        _pfd, pal = tempfile.mkstemp(prefix="cutlab_palette_", suffix=".png")
        os.close(_pfd)
        run(["ffmpeg", "-y", "-v", "error", "-i", master,
             "-vf", f"fps={gf},scale={gw}:-1:flags=lanczos,palettegen=stats_mode=diff",
             "-t", f"{total:.3f}", pal])
        run(["ffmpeg", "-y", "-v", "error", "-i", master, "-i", pal,
             "-lavfi", (f"[0:v]fps={gf},scale={gw}:-1:flags=lanczos[x];"
                        "[x][1:v]paletteuse=dither=bayer:bayer_scale=5"),
             "-t", f"{total:.3f}", gif_dest])
        try:
            os.unlink(pal)
        except OSError:
            pass
        outputs.append({"kind": "gif", "file": os.path.basename(gif_dest)})
    return outputs, main_out

# ------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project")
    ap.add_argument("--media", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--job")
    # Phase 3: still mode from the CLI (the job-payload form is
    # output.still = {t, format}); renders one composited frame and exits.
    ap.add_argument("--still", type=float, default=None)
    ap.add_argument("--still-format", choices=["jpg", "png"], default="jpg")
    args = ap.parse_args()
    with open(args.project) as f:
        P = json.load(f)
    job = None
    if args.job and os.path.exists(args.job):
        with open(args.job) as f:
            job = json.load(f)
    opts = (job or {}).get("output") or {}
    audio_opts = (job or {}).get("audio")
    # Phase 3: still request — job output.still (or a top-level job
    # `still`), else the --still CLI flags; absent = a normal render.
    still_cfg = opts.get("still") or (job or {}).get("still")
    if still_cfg is None and args.still is not None:
        still_cfg = {"t": args.still, "format": args.still_format}
    rng = opts.get("range")
    if rng:
        P = apply_range(P, float(rng["in"]), float(rng["out"]))
    W = int(P["canvas"]["w"]); H = int(P["canvas"]["h"]); fps = int(P["canvas"]["fps"])
    total = 0.0
    for track in P.get("tracks", []):
        for c in track.get("clips", []):
            total = max(total, float(c["start"]) + clip_dur(c))
    if total <= 0:
        sys.stderr.write("Lane B: empty project (no clips)\n")
        sys.exit(2)
    media = {}
    for m in P.get("media", []):
        media[m["id"]] = (os.path.join(args.media, m["src"]), m.get("kind", "video"))
    ctx = {"W": W, "H": H, "fps": fps, "media_dir": args.media,
           "fonts": FontRegistry(args.media), "media": media}
    tmp = tempfile.mkdtemp(prefix="cutlab_render_")
    with stage("segments"):
        segments, overlays = collect_visual_segments(P, ctx, tmp)
    with stage("composite"):
        comp = composite_segments(segments, W, H, fps, total,
                                  (P.get("canvas") or {}).get("bg") or "#000000", tmp,
                                  ctx["media_dir"])
    text_jobs = []
    with stage("text"):
        counter = 0
        for ov in overlays:
            d = os.path.join(tmp, f"ovl_{counter}"); counter += 1
            render_overlay_seq(ov["kind"], ov["dur"], W, H, fps, d)
            text_jobs.append({"dir": d, "start": ov["start"]})
        for track in P.get("tracks", []):
            if track.get("kind") != "text" or track.get("hidden"):
                continue
            for clip in track.get("clips", []):
                d = os.path.join(tmp, f"text_{counter}"); counter += 1
                render_text_clip(clip, W, H, fps, d, ctx["fonts"])
                text_jobs.append({"dir": d, "start": float(clip["start"])})
    with stage("master"):
        master = build_master(comp, P, text_jobs, [], ctx, tmp, total)
    reframe = (job or {}).get("reframe") or {}
    if reframe.get("points"):
        with stage("master"):
            master, w2 = apply_reframe_crop(master, reframe["points"], W, H, tmp)
            ctx["W"] = w2  # encode treats the vertical cut as the canvas
            sys.stderr.write(f"Lane B: reframe 9:16 -> {w2}x{H}, "
                             f"{len(reframe['points'])} path points\n")
    if still_cfg is not None:
        # Phase 3: still mode — the master IS the finished composite
        # (segments + text + look), so one frame out of it is the
        # composited frame. No audio pass, no encode; exit with the
        # still as the only output.
        if isinstance(still_cfg, dict):
            st = float(still_cfg.get("t") or 0)
            sfmt = str(still_cfg.get("format") or "jpg").lower()
        else:
            st, sfmt = float(still_cfg), "jpg"
        if sfmt not in ("jpg", "png"):
            sfmt = "jpg"
        st = min(max(st, 0.0), max(total - 1.0 / fps, 0.0))
        still_dest = os.path.join(os.path.dirname(os.path.abspath(args.out)),
                                  f"still.{sfmt}")
        with stage("still"):
            scmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{st:.3f}",
                    "-i", master, "-frames:v", "1"]
            if sfmt == "jpg":
                scmd += ["-q:v", "3"]
            scmd += [still_dest]
            run(scmd)
        wall = _time.perf_counter() - _T0
        result = {"outputs": [{"kind": "still", "file": os.path.basename(still_dest)}],
                  "measurements": {},
                  "timings": {"wall_s": round(wall, 2),
                              "stages_s": {k: round(v, 2) for k, v in sorted(TIMINGS.items())}}}
        with open(still_dest + ".outputs.json", "w") as f:
            json.dump(result, f, indent=1)
        print(json.dumps(result))
        return
    bus = dict(P.get("audioBus") or {})
    if audio_opts:
        bus["masterGain"] = audio_opts.get("masterGain", bus.get("masterGain", 1))
        _comp = audio_opts.get("compressor", bus.get("compEnabled", False))
        bus["compressor"] = bool(_comp.get("enabled", False)) if isinstance(_comp, dict) else bool(_comp)
    else:
        bus["compressor"] = bool(bus.get("compEnabled", False))
    premix, loud = None, None
    with stage("audio"):
        premix = build_premix(P, ctx, total, tmp, bus)
        normalise = True if audio_opts is None else bool(audio_opts.get("normalise", True))
        if premix and normalise and (P.get("audioBus") or {}).get("normalise", True) is not False:
            loud = loudnorm_measure(premix, loudness_target(opts))
    with stage("encode"):
        outputs, main_out = encode_outputs(master, premix, loud, P, opts,
                                           audio_opts, args.out, ctx, total)
    measurements = {}
    if loud:
        measurements["premix_lufs"] = float(loud["input_i"])
        measurements["premix_true_peak"] = float(loud["input_tp"])
    if premix:
        out_loud = loudnorm_measure(main_out)
        if out_loud:
            measurements["output_lufs"] = float(out_loud["input_i"])
            measurements["output_true_peak"] = float(out_loud["input_tp"])
    wall = _time.perf_counter() - _T0
    compositing = sum(TIMINGS.get(k, 0.0) for k in ("segments", "composite", "text", "master"))
    encode_s = TIMINGS.get("encode", 0.0)
    cpu = cpu_seconds()
    timings = {
        "wall_s": round(wall, 2),
        "compositing_s": round(compositing, 2),
        "encode_s": round(encode_s, 2),
        "compositing_pct": round(100 * compositing / wall, 1) if wall else 0,
        "encode_pct": round(100 * encode_s / wall, 1) if wall else 0,
        "stages_s": {k: round(v, 2) for k, v in sorted(TIMINGS.items())},
        "cpu_cores_available": os.cpu_count(),
        "cpu_seconds_total": round(cpu, 2),
        "effective_cores_used": round(cpu / wall, 2) if wall else 0,
    }
    result = {"outputs": outputs, "measurements": measurements, "timings": timings}
    with open(main_out + ".outputs.json", "w") as f:
        json.dump(result, f, indent=1)
    sys.stderr.write(
        f"Lane B timing: wall {wall:.1f}s | compositing {compositing:.1f}s "
        f"({timings['compositing_pct']}%) | encode {encode_s:.1f}s ({timings['encode_pct']}%) | "
        f"effective cores {timings['effective_cores_used']} of {timings['cpu_cores_available']}\n")
    print(json.dumps(result))

if __name__ == "__main__":
    main()
