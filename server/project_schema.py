#!/usr/bin/env python3
"""
CutLab project-schema validation — the Python half of the prompt-edit
contract (src/services/promptSchema.ts is the TypeScript half; one rule
set, two homes, pinned to the same verdicts by the fixture tests).

The worker validates every LLM-returned project BEFORE the app ever sees
it: unknown fields rejected, every clip's media reference must exist in
the project's media registry, ids unique, and — for prompt edits — the
media registry itself must come back identical (an edit may not invent,
drop, or rename media).
"""
import math

PROJECT_KEYS = {
    "version", "name", "canvas", "media", "mediaBins", "rangeIn", "rangeOut",
    "look", "audioBus", "tracks", "markers", "promptHistory", "reframe",
    "editLog",
}
CANVAS_KEYS = {"w", "h", "fps", "bg"}
MEDIA_KEYS = {"id", "src", "kind", "bin", "duration", "width", "height"}
MEDIA_KINDS = {"video", "audio", "image", "matte", "depth"}
TRACK_KEYS = {
    "id", "kind", "muted", "solo", "locked", "hidden", "name", "color",
    "height", "volume", "clips", "bus",
}
TRACK_KINDS = {"video", "audio", "text"}
MARKER_KEYS = {"t", "label", "color", "dur"}
BASE_CLIP_KEYS = {
    "id", "start", "transitionIn", "groupId", "transitionDir",
    "transitionDur", "transitionBlur", "transitionMode", "wipeCx", "wipeCy", "wipeShape",
}
VIDEO_CLIP_KEYS = BASE_CLIP_KEYS | {
    "media", "in", "out", "speed", "speedKeys", "reversed", "freezeAt",
    "pitchPreserve", "smoothSlowmo", "muted", "volume", "transform",
    "keyframes", "effects", "mask", "matteId", "chromaKey", "grade", "grades", "crop",
    "blend", "flipH", "flipV", "fadeIn", "fadeOut", "volumeKeys", "pan",
    "eqLow", "eqMid", "eqHigh", "denoise", "fit", "angles", "activeAngle",
    "audioOverride", "eqBands",
}
AUDIO_CLIP_KEYS = BASE_CLIP_KEYS | {
    "media", "in", "out", "speed", "speedKeys", "reversed", "freezeAt",
    "pitchPreserve", "volume", "fadeIn", "fadeOut", "volumeKeys", "pan",
    "eqLow", "eqMid", "eqHigh", "denoise", "voiceFx", "audioOverride", "eqBands",
}
TEXT_CLIP_KEYS = BASE_CLIP_KEYS | {
    "text", "dur", "style", "fontFamily", "fontWeight", "fontSize", "color",
    "strokeColor", "strokeWidth", "shadow", "x", "y", "animIn", "animOut",
    "animInDur", "animOutDur", "animLoop", "effects", "shadowObj", "glowObj",
    "plate", "curve", "align", "charSpacing", "lineSpacing",
    "highlightColor", "noFill", "words",
}
COMPOUND_CLIP_KEYS = BASE_CLIP_KEYS | {
    "nest", "in", "out", "volume", "transform", "keyframes", "effects",
    "mask", "grade", "grades", "crop", "blend", "flipH", "flipV",
}
ADJUSTMENT_CLIP_KEYS = BASE_CLIP_KEYS | {"adj", "dur", "effects", "grade", "grades", "mask", "keyframes"}
TRANSITIONS = {
    "cut", "dissolve", "flash", "glare", "slide", "shake", "blur-pulse",
    "zoom", "flip", "invert-flash", "mask-wipe", "blur-cut",
}
MAX_ERRORS = 25


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class _Errors:
    def __init__(self):
        self.list = []

    def add(self, msg):
        if len(self.list) < MAX_ERRORS:
            self.list.append(msg)


def _check_keys(obj, allowed, where, errs):
    for k in obj:
        if k not in allowed:
            errs.add(f'{where}: unknown field "{k}"')


def _check_transform(t, where, errs):
    if not isinstance(t, dict):
        errs.add(f"{where}: transform must be an object")
        return
    for f in ("x", "y", "scale", "rotation", "opacity"):
        if not _is_num(t.get(f)):
            errs.add(f"{where}: transform.{f} must be a number")


def _check_media_clip(raw, cid, media_ids, where, errs):
    if not isinstance(raw.get("media"), str) or raw.get("media") not in media_ids:
        errs.add(f"{where}: clip {cid} references media {raw.get('media')!r} "
                 "which is not in the project media registry")
    if not _is_num(raw.get("in")) or raw["in"] < 0:
        errs.add(f"{where}: clip {cid} needs in >= 0")
    if not _is_num(raw.get("out")) or (_is_num(raw.get("in")) and raw["out"] <= raw["in"]):
        errs.add(f"{where}: clip {cid} needs out > in")
    if not _is_num(raw.get("speed")) or raw["speed"] <= 0:
        errs.add(f"{where}: clip {cid} needs speed > 0")
    if not _is_num(raw.get("volume")) or raw["volume"] < 0:
        errs.add(f"{where}: clip {cid} needs volume >= 0")


def _check_clip(raw, track_kind, media_ids, where, errs, depth):
    if not isinstance(raw, dict):
        errs.add(f"{where}: clip must be an object")
        return
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        errs.add(f"{where}: clip.id must be a non-empty string")
    if not _is_num(raw.get("start")) or raw["start"] < 0:
        errs.add(f"{where}: clip.start must be a number >= 0")
    ti = raw.get("transitionIn")
    if ti is not None and ti not in TRANSITIONS:
        errs.add(f"{where}: clip.transitionIn {ti!r} is not a known transition")
    cid = raw.get("id") if isinstance(raw.get("id"), str) else "?"

    if track_kind == "text":
        _check_keys(raw, TEXT_CLIP_KEYS, f"{where} (text clip {cid})", errs)
        if not isinstance(raw.get("text"), str):
            errs.add(f"{where}: text clip {cid} needs a text string")
        if not _is_num(raw.get("dur")) or raw["dur"] <= 0:
            errs.add(f"{where}: text clip {cid} needs dur > 0")
        if not isinstance(raw.get("style"), str):
            errs.add(f"{where}: text clip {cid} needs a style string")
        return
    if track_kind == "audio":
        _check_keys(raw, AUDIO_CLIP_KEYS, f"{where} (audio clip {cid})", errs)
        _check_media_clip(raw, cid, media_ids, where, errs)
        if not _is_num(raw.get("fadeIn")) or not _is_num(raw.get("fadeOut")):
            errs.add(f"{where}: audio clip {cid} needs fadeIn/fadeOut numbers")
        return
    if raw.get("adj") is True:
        _check_keys(raw, ADJUSTMENT_CLIP_KEYS, f"{where} (adjustment clip {cid})", errs)
        if not _is_num(raw.get("dur")) or raw["dur"] <= 0:
            errs.add(f"{where}: adjustment clip {cid} needs dur > 0")
        return
    if isinstance(raw.get("nest"), dict):
        _check_keys(raw, COMPOUND_CLIP_KEYS, f"{where} (compound clip {cid})", errs)
        if not _is_num(raw.get("in")) or not _is_num(raw.get("out")) or raw["out"] <= raw["in"]:
            errs.add(f"{where}: compound clip {cid} needs out > in")
        _check_transform(raw.get("transform"), f"{where} compound clip {cid}", errs)
        if depth >= 4:
            errs.add(f"{where}: compound clip {cid} nests deeper than 4")
            return
        nest_tracks = raw["nest"].get("tracks")
        if not isinstance(nest_tracks, list):
            errs.add(f"{where}: compound clip {cid} nest.tracks must be an array")
            return
        for i, t in enumerate(nest_tracks):
            _check_track(t, media_ids, f"{where} > nest track {i}", errs, depth + 1)
        return
    _check_keys(raw, VIDEO_CLIP_KEYS, f"{where} (video clip {cid})", errs)
    _check_media_clip(raw, cid, media_ids, where, errs)
    if not isinstance(raw.get("muted"), bool):
        errs.add(f"{where}: video clip {cid} needs a muted boolean")
    _check_transform(raw.get("transform"), f"{where} video clip {cid}", errs)


def _check_track(raw, media_ids, where, errs, depth=0):
    if not isinstance(raw, dict):
        errs.add(f"{where}: track must be an object")
        return
    _check_keys(raw, TRACK_KEYS, where, errs)
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        errs.add(f"{where}: track.id must be a non-empty string")
    if raw.get("kind") not in TRACK_KINDS:
        errs.add(f"{where}: track.kind {raw.get('kind')!r} is not video/audio/text")
        return
    if not isinstance(raw.get("clips"), list):
        errs.add(f"{where}: track.clips must be an array")
        return
    for i, c in enumerate(raw["clips"]):
        _check_clip(c, raw["kind"], media_ids, f"{where} clip {i}", errs, depth)


def validate_project(raw):
    """Return a list of schema errors (empty = valid)."""
    errs = _Errors()
    if not isinstance(raw, dict):
        return ["the project is not a JSON object"]
    _check_keys(raw, PROJECT_KEYS, "project", errs)
    if raw.get("version") != 1:
        errs.add("project.version must be 1")
    if not isinstance(raw.get("name"), str):
        errs.add("project.name must be a string")
    canvas = raw.get("canvas")
    if not isinstance(canvas, dict):
        errs.add("project.canvas must be an object")
    else:
        _check_keys(canvas, CANVAS_KEYS, "canvas", errs)
        for f in ("w", "h", "fps"):
            if not _is_num(canvas.get(f)) or canvas[f] <= 0:
                errs.add(f"canvas.{f} must be a positive number")
    media = raw.get("media")
    if not isinstance(media, list):
        errs.add("project.media must be an array")
        return errs.list
    media_ids = set()
    for i, m in enumerate(media):
        where = f"media {i}"
        if not isinstance(m, dict):
            errs.add(f"{where}: must be an object")
            continue
        _check_keys(m, MEDIA_KEYS, where, errs)
        if not isinstance(m.get("id"), str) or not m["id"]:
            errs.add(f"{where}: id must be a non-empty string")
        elif m["id"] in media_ids:
            errs.add(f'{where}: duplicate media id "{m["id"]}"')
        else:
            media_ids.add(m["id"])
        if not isinstance(m.get("src"), str) or not m["src"]:
            errs.add(f"{where}: src must be a non-empty string")
        if m.get("kind") not in MEDIA_KINDS:
            errs.add(f"{where}: kind {m.get('kind')!r} is not a media kind")
    tracks = raw.get("tracks")
    if not isinstance(tracks, list) or not tracks:
        errs.add("project.tracks must be a non-empty array")
    else:
        for i, t in enumerate(tracks):
            _check_track(t, media_ids, f"track {i}", errs)
        track_ids, clip_ids = set(), set()

        def walk(ts):
            for t in ts:
                if not isinstance(t, dict):
                    continue
                if isinstance(t.get("id"), str):
                    if t["id"] in track_ids:
                        errs.add(f'duplicate track id "{t["id"]}"')
                    track_ids.add(t["id"])
                for c in t.get("clips") or []:
                    if not isinstance(c, dict):
                        continue
                    if isinstance(c.get("id"), str):
                        if c["id"] in clip_ids:
                            errs.add(f'duplicate clip id "{c["id"]}"')
                        clip_ids.add(c["id"])
                    nest = c.get("nest")
                    if isinstance(nest, dict) and isinstance(nest.get("tracks"), list):
                        walk(nest["tracks"])

        walk(tracks)
    markers = raw.get("markers")
    if markers is not None:
        if not isinstance(markers, list):
            errs.add("project.markers must be an array")
        else:
            for i, mk in enumerate(markers):
                if not isinstance(mk, dict):
                    errs.add(f"marker {i}: must be an object")
                    continue
                _check_keys(mk, MARKER_KEYS, f"marker {i}", errs)
                if not _is_num(mk.get("t")):
                    errs.add(f"marker {i}: t must be a number")
                if not isinstance(mk.get("label"), str):
                    errs.add(f"marker {i}: label must be a string")
    return errs.list


def media_registry_error(before, after):
    """Prompt-edit law: the media registry is identity, not raw material."""
    def sig(p):
        return "|".join(sorted(
            f"{m.get('id')}:{m.get('src')}:{m.get('kind')}"
            for m in p.get("media", []) if isinstance(m, dict)))
    if sig(before) == sig(after):
        return None
    return ("the edit changed the media registry (media may not be added, "
            "removed, or renamed by a prompt edit)")
