# Lane B — server renderer

`render.py` renders a CutLab project JSON to a finished video with the system
ffmpeg (8.1.2). It is the server half of CutLab: the browser app never renders.
The renderer mirrors the client's own solvers (compose.ts / types.ts /
grade.ts) — where the preview and this renderer disagree, the preview is the
reference unless noted.

```
python3 render.py PROJECT.cutlab.json --media MEDIA_DIR --out OUT.mp4 [--job JOB.json]
```

Or from an app-produced render job bundle:

```
python3 ../server/render_job.py PROJECT_render_job.zip --out render.mp4
```

## Architecture

Per clip, the timeline is split into sub-segments at keyframe bounds, speed
steps (≤0.25 s) and transition steps (≤0.08 s; ≤0.03 s inside blur-cut
windows). Keyframed transform spans are additionally stepped at ≤0.1 s
(J.12): transform values are baked per sub-segment (only position animates
in the composite), so without the fine steps a push-in written from two
keyframes would jump in scale instead of gliding — the steps keep the
per-step scale delta below visibility. The `add_camera_move` op writes
such moves (push/pull/glide + optional entry-blur settle) as ordinary
keyframes. Each sub-segment is rendered
to a VP9-alpha webm (source window from the inverted speed map → crop/fit →
chroma → flips → transform → effects → grade → opacity), with mask/matte/
soft-crop multiplied into alpha by a separate post-step (alphamerge).
Segments are composited in track order over the canvas.bg plate (blend-mode
and adjustment clips take windowed passes), text + flash/glare are PNG
sequences overlaid at master, the project `look` grade applies at master,
audio is one premix pass, and the final encode honours the job payload.

**Three hard-won ffmpeg laws (do not relearn these):**
1. VP9/WebM alpha is invisible to ffmpeg's native vp9 decoder — every .webm
   input goes through `-c:v libvpx-vp9` (helper `vin()`), or transparency
   silently becomes opaque black downstream. PNG frame extraction also lies
   about alpha unless decoded the same way.
2. The lavfi `color=black@0.0` source negotiates OPAQUE alpha — segment
   canvases and transparent bases force `colorchannelmixer=aa=0`.
3. A demuxed stream's LAST frame has no successor to bound its display
   window, so `overlay` drops it (WebM packets carry no duration). Every
   setpts-shifted input gets `tpad=stop_mode=clone:stop_duration=0.12`;
   `enable` windows still gate display. Related: windowed overlays need
   `eof_action=pass` or their last frame repeats to the end of the timeline.

## Parity map (client field → Lane B)

- **Audio:** recursive premix (nests included); video-clip sound mixed;
  track flags (hidden/muted excluded, solo logic); per-clip volume
  expression = clamp(clip × fade × volumeKeys) × track gain × bus master;
  EQ (lowshelf 200 / peak 1000 / highshelf 4000, value×12 dB), pan
  (stereotools balance), denoise (afftdn nr = 4 + value×20), voice-FX
  (aecho presets), bus compressor (acompressor, dB→linear threshold),
  loudnorm two-pass to −14 LUFS / TP −1 with measured premix values.
- **Grade** (order = client: LUT → hueCurves → curves/primaries → HSL):
  input .cube LUT at lutStrength (missing file → stage skipped + warning,
  never faked); hueCurves as a generated 33³ HSV LUT (exact per-hue — the
  preview only averages six bands); primaries+curves composed by sampling
  the preview's exact per-channel function at 33 points into ONE `curves`
  filter; HSL per band via chromakey band mask (similarity 0.22) +
  colorchannelmixer (YIQ hue ∘ saturation; lightness offset via lutrgb —
  colorchannelmixer takes exactly 16 coefficients, no constant term).
  Band masks MUST be rgba (maskedmerge blends per plane; a gray mask
  leaves chroma at a permanent 50% blend). Relight = PIL radial plates,
  screen-blended. Project `look` at master; canvas.bg = base plate.
- **Effects:** brightness/contrast/saturation (eq), blur (gblur σ =
  value×10, cap 50), sharpen (unsharp), vignette (angle = value map),
  wide-angle (lenscorrection coefficients from value), motion-blur
  (tblend average ×k, k capped), glow (split → blur → screen), haze
  (radial-masked blurred copy), tv-lines (generated pattern overlay),
  relight (plates), turbulent-displace (smooth low-frequency noise plate
  feeding ffmpeg `displace`; params scale/seed/evolution shape the field,
  value = amount mapped through a ^1.35 curve to a ~52 px peak offset at
  720 wide, windows drift so the field churns inside a segment; param
  falloff (default 0.85, 0 = off) maskedmerges each map toward flat 128
  through a vertical gradient — full strength at the layer's bottom, zero
  at the top — so bubble/pop-out clones stay coherent above their base). Per-effect values follow the client's keyframe solver.
- **Transitions** (preview semantics — they modulate the INCOMING clip over
  its first transitionDur; total duration never changes): dissolve
  (opacity 0.15→1), flash/glare (stage-overlay PNG sequences: white bell
  sin(πp)·0.9; diagonal band sweeping −30%→130% at 105°), slide (position,
  direction-aware), shake (position steps at 0.08 s — the preview's
  90/113 rad/s sine sampled; the one stepped approximation), zoom (scale
  1.18→1 easeOutCubic), flip (horizontal squeeze cos((1−p)·88°) —
  approximates perspective rotateY), invert-flash (negate), mask-wipe
  (disc mask on the CSS circle() basis √(W²+H²)/√2), blur-cut (J.12 — the
  blur-masked cut: the ONE two-sided transition. The incoming clip's head
  settles from the peak blur over its first transitionDur AND the previous
  clip's tail ramps up to the same peak over its last transitionDur when
  the two clips sit flush; the cut hides between the two maximally blurred
  boundary frames. transitionBlur = peak gblur sigma (default 9);
  transitionMode soft = gaussian settle, whip = avgblur directional
  streak along transitionDir over a 0.55× gaussian, zoom = 0.8× gaussian
  + scale settle 1.12→1. Envelopes are sampled per sub-segment at 0.03 s
  steps; the outgoing side is evaluated at segment END so the last frame
  before the join carries the full peak).
- **Speed:** SpeedMap = the client's speedAtSource/speedDuration verbatim
  (240-step midpoint integral). **speedKeys `t` is source time FROM THE
  CLIP IN-POINT.** Reverse = mirrored window + `reverse`; freeze = still
  (duration unchanged); smoothSlowmo → minterpolate.
- **Compositing:** matteId (matte retimed with the clip's own map and
  multiplied into the layer in LAYER space — after the fit, before the
  transform scale and effects — so transforms move it and effects warp
  the matted alpha with the picture; 'depth'
  rides the same path), chromakey + despill (mix/expand), masks
  rect/circle/linear/pen with feather (GaussianBlur feather×W/2), animated
  via the mirrored keyframe solvers (Bezier Newton, holds, ease library),
  blend modes (windowed rgb24 blend + alphamerge), adjustment clips
  (windowed re-grade of everything beneath; over an empty stage Lane B
  grades the bg plate where the preview renders nothing), compound nests
  (recursive, depth cap 4, transparent base, the compound's own wrap
  applied to the flattened result), blur-fill fit (gblur σ25, −0.03
  brightness background + contained foreground).
- **Text (PIL, never drawtext):** presets + per-clip overrides, designed
  shadow object, glow (fill-colour blur at intensity), plate (+ 'bubble'
  tail polygon mirroring the CSS geometry), charSpacing/lineSpacing/align,
  `**word**` colour markup, karaoke states from clip.words, arc text
  (per-glyph, compose.arcLayout mirrored; no markup/karaoke/glow under
  arc — same as the preview), evalText animations + loop modifiers.
  **Fonts:** .ttf/.otf found in the media dir (or `fonts/` subdir) are
  registered by PIL family name; a missing family warns on stderr and
  falls back by weight. Weight variants within one family share the first
  registered file (documented limit).
- **Transform rotation is DEGREES** (the Preview's reading; the Inspector
  slider treats it as radians — a known client hazard, flagged in
  BUILD-LOG; Lane B follows what the user sees).
- **Export:** job payload container (mp4/mov), codec (h264/h265 + hvc1),
  size (canvas / short-side 720 / 1080 / 2160), fps, crf XOR bitrateKbps,
  ranged export (project transform incl. speed-key re-basing), alsoFormats
  (centre-crop from the master), `-map_metadata -1`, faststart. Sidecar
  `<out>.outputs.json` carries {outputs, measurements (LUFS/TP), timings}.

## Timing character (measured 2026-11-04)

Compositing is ~94% of wall time at both 720×1280 and 1080×1920; the final
encode is 5–6% and its share does not grow with pixels. Effective CPU
≈1.3 of the VM's 4 cores (serial stage chain). Full breakdown in
BUILD-LOG.md → "Render timing breakdown".
