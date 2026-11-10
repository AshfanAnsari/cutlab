// Editing actions shared by the timeline UI and keyboard shortcuts.
// Every mutation goes through store.commit so undo/redo and autosave see it.
import type { AdjustmentClip, AudioClip, Clip, CompoundClip, Keyframe, Project, TextClip, Track, VideoClip } from '../types';
import { DEFAULT_TRANSFORM, clipDuration, clipEnd, newId } from '../types';
import { qFrame } from '../utils/time';
import { store } from './store';
import { playback } from '../engine/playback';
import { projectStore } from '../services/projectStore';
import { angleFlash } from '../services/angleFlash';

export function findClip(p: Project, trackId: string, clipId: string) {
  const track = p.tracks.find((t) => t.id === trackId);
  const clip = track?.clips.find((c) => c.id === clipId);
  return { track, clip };
}

/** Split one clip at an absolute timeline time (frame-quantized). The ONE
 *  canonical split: the playhead shortcut below and the live-control
 *  executor both call it. Returns the new right-hand clip's id, or null
 *  when the point is not strictly inside the clip. */
export function splitClipAt(trackId: string, clipId: string, atTime: number): string | null {
  const p = store.get().project;
  const t = qFrame(atTime, p.canvas.fps);
  const { track, clip } = findClip(p, trackId, clipId);
  if (!track || !clip) return null;
  if (!(t > clip.start + 0.001 && t < clip.start + clipDuration(clip) - 0.001)) return null;
  let rightId: string | null = null;
  store.commit((draft) => {
    const tr = draft.tracks.find((x) => x.id === trackId)!;
    const idx = tr.clips.findIndex((c) => c.id === clipId);
    if (idx < 0) return;
    const c = tr.clips[idx];
    const right: Clip = JSON.parse(JSON.stringify(c)) as Clip;
    right.id = newId('clip');
    rightId = right.id;
    const offset = t - c.start;
    if ('dur' in c && 'dur' in right) {
      (right as TextClip).dur = clipDuration(c) - offset;
      (c as TextClip).dur = offset;
    } else if ('nest' in c && 'nest' in right) {
      // Compound: the window is 1:1, so the split point is in + offset.
      const mid = (c as CompoundClip).in + offset;
      (right as CompoundClip).in = mid;
      (c as CompoundClip).out = mid;
      const kc = c as CompoundClip;
      if (kc.keyframes) {
        const rk = right as CompoundClip;
        rk.keyframes = kc.keyframes.filter((k) => k.t >= offset).map((k) => ({ ...k, t: k.t - offset }));
        kc.keyframes = kc.keyframes.filter((k) => k.t < offset);
      }
    } else if ('in' in c && 'in' in right) {
      const mid = (c as VideoClip).in + offset * (c as VideoClip).speed;
      (right as VideoClip).in = mid;
      (c as VideoClip).out = mid;
      // keyframes after the split point move to the right clip, rebased
      const vc = c as VideoClip;
      if (vc.keyframes) {
        const rk = (right as VideoClip);
        rk.keyframes = vc.keyframes.filter((k) => k.t >= offset).map((k) => ({ ...k, t: k.t - offset }));
        vc.keyframes = vc.keyframes.filter((k) => k.t < offset);
      }
    }
    right.start = t;
    if ('transitionIn' in right) right.transitionIn = null;
    tr.clips.splice(idx + 1, 0, right);
  });
  return rightId;
}

/** Split the clip under the playhead (or the selected clip) at the playhead. */
function selectedTrackLocked(): boolean {
  const s = store.get();
  if (!s.selected) return false;
  const tr = s.project.tracks.find((t) => t.id === s.selected!.trackId);
  if (tr?.locked) {
    store.toastMsg('info', 'That track is locked — unlock it from its header to edit.');
    return true;
  }
  return false;
}

export function splitAtPlayhead() {
  if (selectedTrackLocked()) return;
  const p = store.get().project;
  const fps = p.canvas.fps;
  const t = qFrame(playback.time, fps);
  const sel = store.get().selected;
  let target: { trackId: string; clip: Clip } | null = null;
  for (const track of p.tracks) {
    for (const clip of track.clips) {
      if (t > clip.start + 0.001 && t < clip.start + clipDuration(clip) - 0.001) {
        if (!target || (sel && sel.clipId === clip.id)) target = { trackId: track.id, clip };
      }
    }
  }
  if (!target) {
    store.toastMsg('info', 'Nothing to split — park the playhead inside a clip.');
    return;
  }
  splitClipAt(target.trackId, target.clip.id, t);
  store.toastMsg('info', 'Clip split at playhead.');
}

/** Delete the selected clip and pull later clips on its track left (ripple). */
export function rippleDeleteSelected() {
  if (selectedTrackLocked()) return;
  const sel = store.get().selected;
  if (!sel) {
    store.toastMsg('info', 'Select a clip first.');
    return;
  }
  store.commitL('Ripple delete', (draft) => {
    const tr = draft.tracks.find((x) => x.id === sel.trackId);
    if (!tr) return;
    const idx = tr.clips.findIndex((c) => c.id === sel.clipId);
    if (idx < 0) return;
    const dur = clipDuration(tr.clips[idx]);
    tr.clips.splice(idx, 1);
    for (let i = idx; i < tr.clips.length; i++) tr.clips[i].start -= dur;
  });
  store.set({ selected: null });
}

/** Plain delete: remove the clip, leave the gap. */
export function deleteSelected() {
  if (selectedTrackLocked()) return;
  const sel = store.get().selected;
  if (!sel) return;
  store.commitL('Delete clip', (draft) => {
    const tr = draft.tracks.find((x) => x.id === sel.trackId);
    if (!tr) return;
    tr.clips = tr.clips.filter((c) => c.id !== sel.clipId);
  });
  store.set({ selected: null });
}

export function addMarkerAtPlayhead(label = '') {
  const t = qFrame(playback.time, store.get().project.canvas.fps);
  store.commitL('Add marker', (draft) => {
    draft.markers.push({ t, label });
    draft.markers.sort((a, b) => a.t - b.t);
  });
}

/** Generate beat markers from a BPM grid, replacing existing 'beat' markers. */
export function generateBeatMarkers(bpm: number, offset: number) {
  if (!(bpm > 0)) {
    store.toastMsg('error', 'Enter a BPM above zero.');
    return;
  }
  const p = store.get().project;
  const dur = Math.max(1, p.tracks.reduce((m, t) => Math.max(m, ...t.clips.map((c) => c.start + clipDuration(c))), 0));
  const step = 60 / bpm;
  store.commitL('Generate beat markers', (draft) => {
    draft.markers = draft.markers.filter((m) => m.label !== 'beat');
    for (let t = offset; t <= dur + 1e-9; t += step) {
      draft.markers.push({ t: Math.round(t * 1000) / 1000, label: 'beat' });
    }
    draft.markers.sort((a, b) => a.t - b.t);
  });
  store.toastMsg('info', `Beat markers laid at ${bpm} BPM.`);
}

export function updateClip(trackId: string, clipId: string, patch: (c: Clip) => void) {
  store.commit((draft) => {
    const tr = draft.tracks.find((x) => x.id === trackId);
    const c = tr?.clips.find((x) => x.id === clipId);
    if (c) patch(c);
  });
}

export type { AudioClip, VideoClip, TextClip };

/** I/O range (D.14): set/clear the project range at the playhead. */
export function setRangeInAtPlayhead() {
  const p = store.get().project;
  const t = qFrame(playback.time, p.canvas.fps);
  // FIX B2 #20: In at the exact Out frame would silently erase the
  // range — say so instead, and leave both points untouched.
  if (p.rangeOut != null && p.rangeOut === t) {
    store.toastMsg('info', 'In and Out are on the same frame — move the playhead so the range has length.');
    return;
  }
  store.commitL('Set range in', (d) => {
    d.rangeIn = t;
    if (d.rangeOut != null && d.rangeOut <= t) d.rangeOut = undefined;
  });
}
export function setRangeOutAtPlayhead() {
  const p = store.get().project;
  const t = qFrame(playback.time, p.canvas.fps);
  if (p.rangeIn != null && p.rangeIn === t) {
    store.toastMsg('info', 'In and Out are on the same frame — move the playhead so the range has length.');
    return;
  }
  store.commitL('Set range out', (d) => {
    d.rangeOut = t;
    if (d.rangeIn != null && d.rangeIn >= t) d.rangeIn = undefined;
  });
}
export function clearRange() {
  store.commit((d) => {
    d.rangeIn = undefined;
    d.rangeOut = undefined;
  });
}

/** Split EVERY clip straddling the playhead, one history step (F.5). */
export function splitAllAtPlayhead() {
  const p = store.get().project;
  const t = playback.time;
  const targets: { trackId: string; clipId: string }[] = [];
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (t > c.start + 1e-9 && t < c.start + clipDuration(c) - 1e-9) targets.push({ trackId: tr.id, clipId: c.id });
    }
  }
  if (targets.length === 0) return;
  store.commit(() => undefined, { history: true, label: 'Split all tracks' });
  for (const tg of targets) splitClipAt(tg.trackId, tg.clipId, t);
}

/** Q: ripple-trim the selected clip's start to the playhead (F.8). */
export function rippleTrimStartToPlayhead() {
  if (selectedTrackLocked()) return;
  const s = store.get();
  if (!s.selected) return;
  const { track, clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!track || !clip) return;
  const t = qFrame(playback.time, s.project.canvas.fps);
  if (t <= clip.start || t >= clip.start + clipDuration(clip)) return;
  const delta = t - clip.start;
  store.commitL('Ripple trim start', (d) => {
    const tr = d.tracks.find((x) => x.id === track.id)!;
    const c = tr.clips.find((x) => x.id === clip.id)!;
    if ('dur' in c) {
      (c as TextClip).dur -= delta;
    } else {
      const vc = c as VideoClip;
      vc.in += delta * (vc.speed || 1);
    }
    c.start = t;
    for (const o of tr.clips) if (o.id !== c.id && o.start >= t) o.start = Math.max(t, o.start - delta);
    tr.clips.sort((a, b) => a.start - b.start);
  });
}

/** W: ripple-trim the selected clip's end to the playhead (F.8). */
export function rippleTrimEndToPlayhead() {
  if (selectedTrackLocked()) return;
  const s = store.get();
  if (!s.selected) return;
  const { track, clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!track || !clip) return;
  const t = qFrame(playback.time, s.project.canvas.fps);
  const end = clip.start + clipDuration(clip);
  if (t <= clip.start || t >= end) return;
  const delta = end - t;
  store.commitL('Ripple trim end', (d) => {
    const tr = d.tracks.find((x) => x.id === track.id)!;
    const c = tr.clips.find((x) => x.id === clip.id)!;
    if ('dur' in c) {
      (c as TextClip).dur -= delta;
    } else {
      const vc = c as VideoClip;
      vc.out -= delta * (vc.speed || 1);
    }
    for (const o of tr.clips) if (o.id !== c.id && o.start >= end - 1e-9) o.start -= delta;
    tr.clips.sort((a, b) => a.start - b.start);
  });
}

/** Deep-clone the selected clip right after itself (F.11). */
export function duplicateSelected() {
  if (selectedTrackLocked()) return;
  const s = store.get();
  if (!s.selected) return;
  const { track, clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!track || !clip) return;
  const clone = JSON.parse(JSON.stringify(clip)) as Clip;
  clone.id = newId('clip');
  clone.start = clip.start + clipDuration(clip);
  store.commitL('Duplicate clip', (d) => {
    const tr = d.tracks.find((x) => x.id === track.id)!;
    tr.clips.push(clone);
    tr.clips.sort((a, b) => a.start - b.start);
  });
  store.set({ selected: { trackId: track.id, clipId: clone.id } });
}

/** Ctrl+C: copy the selected clip into the internal clipboard (F.12). */
export function copySelected() {
  const s = store.get();
  if (!s.selected) return;
  const { clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!clip) return;
  store.set({ clipboard: JSON.parse(JSON.stringify(clip)) as Clip });
  store.toastMsg('info', 'Clip copied.');
}

/** Ctrl+V: paste the clipboard clip at the playhead on a kind-matched track (F.12). */
export function pasteClipboard() {
  const s = store.get();
  const cb = s.clipboard;
  if (!cb) return;
  const kind: Track['kind'] = 'adj' in cb || 'nest' in cb
    ? 'video'
    : 'dur' in cb
      ? 'text'
      : s.project.media.find((m) => m.id === (cb as VideoClip).media)?.kind === 'audio'
        ? 'audio'
        : 'video';
  const track = s.project.tracks.find((t) => t.kind === kind) ?? s.project.tracks[0];
  if (!track) return;
  if (track.locked) {
    store.toastMsg('info', 'The target track is locked.');
    return;
  }
  const clone = JSON.parse(JSON.stringify(cb)) as Clip;
  clone.id = newId('clip');
  clone.start = qFrame(playback.time, s.project.canvas.fps);
  store.commitL('Paste clip', (d) => {
    const tr = d.tracks.find((x) => x.id === track.id)!;
    tr.clips.push(clone);
    tr.clips.sort((a, b) => a.start - b.start);
  });
  store.set({ selected: { trackId: track.id, clipId: clone.id } });
}

export interface PasteAttrGroups {
  grade: boolean;
  transform: boolean;
  keyframes: boolean;
  effects: boolean;
  mask: boolean;
  transition: boolean;
  volume: boolean;
  textStyle: boolean;
}

/** Apply chosen attribute groups from the clipboard clip to the selected clip(s) (F.12). */
export function pasteAttributes(groups: PasteAttrGroups) {
  const s = store.get();
  const cb = s.clipboard as VideoClip | TextClip | null;
  if (!cb) return;
  const targets = s.selectedMany.length > 0 ? s.selectedMany : s.selected ? [s.selected] : [];
  if (targets.length === 0) return;
  store.commitL('Paste attributes', (d) => {
    for (const tg of targets) {
      const tr = d.tracks.find((x) => x.id === tg.trackId);
      const c = tr?.clips.find((x) => x.id === tg.clipId);
      if (!c) continue;
      if (groups.transition) {
        c.transitionIn = cb.transitionIn;
        c.transitionDur = cb.transitionDur;
      }
      if (groups.grade && ('grade' in c || 'grades' in c) && ('grade' in cb || 'grades' in cb)) {
        // D1.1: paste the whole stack (resolving the source's legacy
        // single grade into a one-element stack); the target's legacy
        // field is cleared so `grades` is the only carrier.
        const src = cb as VideoClip;
        const layers = src.grades ?? (src.grade ? [src.grade] : undefined);
        const vc = c as VideoClip;
        vc.grades = layers ? JSON.parse(JSON.stringify(layers)) : undefined;
        delete vc.grade;
      }
      if ('transform' in c && 'transform' in cb) {
        const vc = c as VideoClip, src = cb as VideoClip;
        if (groups.transform) vc.transform = JSON.parse(JSON.stringify(src.transform));
        if (groups.keyframes) vc.keyframes = src.keyframes ? JSON.parse(JSON.stringify(src.keyframes)) : undefined;
        if (groups.effects) vc.effects = src.effects ? JSON.parse(JSON.stringify(src.effects)) : undefined;
        if (groups.mask) vc.mask = src.mask ? JSON.parse(JSON.stringify(src.mask)) : null;
        if (groups.volume) { vc.volume = src.volume; vc.muted = src.muted; }
      }
      if ('fadeIn' in c && 'fadeIn' in cb && groups.volume) {
        const ac = c as AudioClip;
        const src = cb as unknown as AudioClip;
        ac.volume = src.volume;
        ac.fadeIn = src.fadeIn;
        ac.fadeOut = src.fadeOut;
      }
      if ('text' in c && 'text' in cb && groups.textStyle) {
        const tc = c as TextClip, src = cb as TextClip;
        tc.style = src.style;
        tc.fontFamily = src.fontFamily;
        tc.fontWeight = src.fontWeight;
        tc.fontSize = src.fontSize;
        tc.color = src.color;
        tc.strokeColor = src.strokeColor;
        tc.strokeWidth = src.strokeWidth;
        tc.shadow = src.shadow;
        tc.animIn = src.animIn;
        tc.animOut = src.animOut;
        tc.effects = src.effects ? [...src.effects] : [];
      }
    }
  });
  store.toastMsg('info', `Attributes pasted to ${targets.length} clip(s).`);
}

/** Delete every clip in the multi-select set, optionally rippling per track (F.14). */
export function deleteMany(ripple: boolean) {
  const s = store.get();
  const set = s.selectedMany.length > 0 ? s.selectedMany : s.selected ? [s.selected] : [];
  if (set.length === 0) return;
  store.commitL('Delete clips', (d) => {
    const byTrack = new Map<string, { clipId: string; start: number; dur: number }[]>();
    for (const tg of set) {
      const tr = d.tracks.find((x) => x.id === tg.trackId);
      const c = tr?.clips.find((x) => x.id === tg.clipId);
      if (!tr || !c || tr.locked) continue;
      const arr = byTrack.get(tr.id) ?? [];
      arr.push({ clipId: c.id, start: c.start, dur: clipDuration(c) });
      byTrack.set(tr.id, arr);
    }
    for (const [trackId, items] of byTrack) {
      const tr = d.tracks.find((x) => x.id === trackId)!;
      const ids = new Set(items.map((i) => i.clipId));
      tr.clips = tr.clips.filter((c) => !ids.has(c.id));
      if (ripple) {
        const sorted = [...items].sort((a, b) => a.start - b.start);
        for (const it of sorted) {
          for (const o of tr.clips) {
            if (o.start >= it.start + it.dur - 1e-9) o.start -= it.dur;
            else if (o.start > it.start) o.start = it.start;
          }
        }
        tr.clips.sort((a, b) => a.start - b.start);
      }
    }
  });
  store.set({ selected: null, selectedMany: [] });
}

/** Rejoin a through-edit (F.15): merge the selected clip with its right neighbour
 *  when they are contiguous pieces of the same source at the same settings. */
export function rejoinSelected(): boolean {
  const s = store.get();
  if (!s.selected) return false;
  const { track, clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!track || !clip) return false;
  if ('dur' in clip) return false;
  if ('nest' in clip) return false; // compounds rejoin by uncompounding, not through-edit
  const vc = clip as VideoClip;
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  const next = sorted[sorted.findIndex((c) => c.id === vc.id) + 1] as VideoClip | undefined;
  if (!next || 'dur' in next) return false;
  const contiguous = Math.abs(vc.start + clipDuration(vc) - next.start) < 1e-6 && Math.abs(vc.out - next.in) < 1e-6;
  const sameSettings = next.media === vc.media && next.speed === vc.speed
    && JSON.stringify(next.transform) === JSON.stringify(vc.transform)
    && JSON.stringify(next.effects ?? []) === JSON.stringify(vc.effects ?? []);
  if (!contiguous || !sameSettings) return false;
  store.commitL('Rejoin through edit', (d) => {
    const tr = d.tracks.find((x) => x.id === track.id)!;
    const left = tr.clips.find((c) => c.id === vc.id) as VideoClip;
    const right = tr.clips.find((c) => c.id === next.id) as VideoClip;
    const leftDur = clipDuration(left);
    if (right.keyframes?.length) {
      left.keyframes = [...(left.keyframes ?? []), ...right.keyframes.map((k) => ({ ...k, t: k.t + leftDur }))];
    }
    left.out = right.out;
    tr.clips = tr.clips.filter((c) => c.id !== right.id);
  });
  return true;
}

/** Extract a video clip's sound as an audio clip on the first audio track. */
export function extractAudioSelected() {
  const s = store.get();
  if (!s.selected) return;
  const { clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!clip) return;
  if ('dur' in clip || !('media' in clip)) return;
  const vc = clip as VideoClip;
  const track = s.project.tracks.find((t) => t.kind === 'audio');
  if (!track) {
    store.toastMsg('error', 'No audio track to extract onto — add one first.');
    return;
  }
  const gid = newId('grp');
  const ac: AudioClip = {
    id: newId('clip'), media: vc.media, start: vc.start, in: vc.in, out: vc.out,
    speed: vc.speed || 1, volume: vc.volume, fadeIn: 0, fadeOut: 0, transitionIn: null, transitionDur: 0.25,
    groupId: gid,
  };
  store.commitL('Extract audio', (d) => {
    // link the pair and mute the source's own sound (K.7)
    for (const tr of d.tracks) {
      const src = tr.clips.find((c) => c.id === vc.id) as VideoClip | undefined;
      if (src) {
        src.groupId = gid;
        src.muted = true;
      }
    }
    const tr = d.tracks.find((x) => x.id === track.id)!;
    tr.clips.push(ac);
    tr.clips.sort((a, b) => a.start - b.start);
  });
  store.toastMsg('info', 'Audio extracted, linked to its clip, source muted. Unlink from the right-click menu.');
}

/** Clear the selected clip's link group so the pair moves independently (K.8). */
export function unlinkSelected() {
  const s = store.get();
  if (!s.selected) return;
  const { clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!clip?.groupId) return;
  const gid = clip.groupId;
  store.commitL('Unlink audio', (d) => {
    for (const tr of d.tracks) {
      for (const c of tr.clips) if (c.groupId === gid) c.groupId = undefined;
    }
  });
}

/** Copy the selected clip's keyframes, rebased to t=0 (M.6). */
export function copyKeyframes() {
  const s = store.get();
  if (!s.selected) return;
  const { clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  const kfs = (clip as VideoClip | undefined)?.keyframes;
  if (!kfs || kfs.length === 0) {
    store.toastMsg('info', 'No keyframes on the selected clip to copy.');
    return;
  }
  const t0 = Math.min(...kfs.map((k) => k.t));
  const rebased = JSON.parse(JSON.stringify(kfs)) as Keyframe[];
  for (const k of rebased) k.t = Math.round((k.t - t0) * 1000) / 1000;
  store.set({ clipboardKfs: rebased });
  store.toastMsg('info', `Copied ${rebased.length} keyframe(s).`);
}

/** Paste copied keyframes onto the selected clip at its start (M.6). */
export function pasteKeyframes() {
  const s = store.get();
  const kfs = s.clipboardKfs;
  if (!kfs || !s.selected) return;
  store.commitL('Paste keyframes', (d) => {
    const tr = d.tracks.find((x) => x.id === s.selected!.trackId);
    const c = tr?.clips.find((x) => x.id === s.selected!.clipId) as VideoClip | undefined;
    if (!c) return;
    const incoming = JSON.parse(JSON.stringify(kfs)) as Keyframe[];
    const merged = [...(c.keyframes ?? []).filter((k) => !incoming.some((n) => Math.abs(n.t - k.t) < 1e-6)), ...incoming];
    merged.sort((a, b) => a.t - b.t);
    c.keyframes = merged;
  });
  store.toastMsg('info', 'Keyframes pasted.');
}

/** [ / ] — jump the playhead between the selected clip's keyframes (M.9). */
export function seekKeyframe(dir: 1 | -1) {
  const s = store.get();
  if (!s.selected) return;
  const { clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!clip) return;
  const kfs = ((clip as VideoClip).keyframes ?? []).map((k) => clip.start + k.t).sort((a, b) => a - b);
  if (kfs.length === 0) return;
  const t = playback.time;
  const target = dir > 0
    ? kfs.find((x) => x > t + 1e-4)
    : [...kfs].reverse().find((x) => x < t - 1e-4);
  if (target !== undefined) playback.seek(target);
}

/** O.11 contact shadow: generate the studied recipe as an ordinary clip on
 *  the track below — silhouette (brightness crushed, desaturated), opacity
 *  ≈ 0.8, offset down, blur only on the shadow layer (EM I §8 / EM V.1). */
export function addContactShadow(trackId: string, clipId: string): void {
  store.commitL('Contact shadow', (d) => {
    const ti = d.tracks.findIndex((t) => t.id === trackId);
    const src = d.tracks[ti]?.clips.find((c) => c.id === clipId) as VideoClip | undefined;
    if (!src) return;
    let below = d.tracks[ti + 1];
    if (!below || below.kind !== 'video') {
      below = { id: newId('trk'), kind: 'video', name: 'Shadow', clips: [] };
      d.tracks.splice(ti + 1, 0, below);
    }
    const shadow: VideoClip = JSON.parse(JSON.stringify(src));
    shadow.id = newId('clip');
    shadow.transform = {
      ...src.transform,
      y: src.transform.y + d.canvas.h * 0.035,
      opacity: 0.8,
    };
    shadow.effects = [
      { type: 'brightness', value: -1 },
      { type: 'saturation', value: -1 },
      { type: 'contrast', value: 1 },
      { type: 'blur', value: 6 },
    ];
    shadow.keyframes = undefined;
    below.clips.push(shadow);
    below.clips.sort((a, b) => a.start - b.start);
  });
  store.toastMsg('info', 'Contact shadow added on the track below — an ordinary clip, edit it freely.');
}

/** O.12: order the first text track directly below the subject's track, so
 *  a matted subject composites over the text (text-behind-subject). */
export function sendTextBehindSubject(trackId: string): void {
  store.commitL('Text behind subject', (d) => {
    const ti = d.tracks.findIndex((t) => t.id === trackId);
    const textIdx = d.tracks.findIndex((t) => t.kind === 'text' && t.clips.length > 0);
    if (ti < 0 || textIdx < 0) {
      store.toastMsg('error', 'No text track with clips to place behind the subject.');
      return;
    }
    const [textTrack] = d.tracks.splice(textIdx, 1);
    const insertAt = d.tracks.findIndex((t) => t.id === trackId) + 1;
    d.tracks.splice(insertAt, 0, textTrack);
  });
  store.toastMsg('info', 'Text track moved below the subject — with a matte on the subject, the text sits behind them.');
}

/** T.8: seek to the nearest edit point (clip boundary or marker) in a
 *  direction, across all tracks. */
export function seekEditPoint(dir: 1 | -1): void {
  const s = store.get();
  const t = playback.time;
  const set = new Set<number>();
  for (const tr of s.project.tracks) {
    for (const c of tr.clips) {
      set.add(c.start);
      set.add(c.start + clipDuration(c));
    }
  }
  for (const mk of s.project.markers) set.add(mk.t);
  if (s.project.rangeIn != null) set.add(s.project.rangeIn);
  if (s.project.rangeOut != null) set.add(s.project.rangeOut);
  const pts = [...set]
    .filter((p) => (dir > 0 ? p > t + 1e-4 : p < t - 1e-4))
    .sort((a, b) => a - b);
  if (pts.length === 0) return;
  playback.seek(dir > 0 ? pts[0] : pts[pts.length - 1]);
}

/** T.9: nudge the selected clip's volume (audio or video-clip audio). */
export function nudgeSelectedVolume(delta: number): void {
  const s = store.get();
  if (!s.selected) return;
  store.commit((d) => {
    const tr = d.tracks.find((x) => x.id === s.selected!.trackId);
    const c = tr?.clips.find((x) => x.id === s.selected!.clipId) as (VideoClip | AudioClip) | undefined;
    if (c && 'volume' in c) c.volume = Math.min(1, Math.max(0, c.volume + delta));
  }, { history: false });
}


// ---- Compound clips (F.16) ----

/** Compound the current selection (anchor + multi-select set) into ONE
 *  compound clip on the anchor's video track. The involved tracks are
 *  deep-copied into the nest with clip times rebased to the selection start;
 *  the originals keep their unselected clips. Text/audio clips may join the
 *  nest, but the compound itself must live on a video track. */
export function makeCompoundFromSelection() {
  const s = store.get();
  const targets = s.selectedMany.length > 0 ? s.selectedMany : s.selected ? [s.selected] : [];
  if (targets.length === 0) {
    store.toastMsg('info', 'Select the clips to compound first (Shift+click for several).');
    return;
  }
  const found = targets
    .map((tg) => ({ ...findClip(s.project, tg.trackId, tg.clipId), trackId: tg.trackId }))
    .filter((x) => x.track && x.clip) as { track: Track; clip: Clip; trackId: string }[];
  if (found.length === 0) return;
  // FIX B2 #19: a compound of one clip is a no-op wrapper — refuse
  // with the reason instead of silently nesting a single clip.
  if (found.length < 2) {
    store.toastMsg('info', 'Compound needs at least two clips — Shift+click to add another clip to the selection.');
    return;
  }
  if (found.some((x) => x.track.locked)) {
    store.toastMsg('info', 'One of the involved tracks is locked — unlock it to compound.');
    return;
  }
  const videoFound = found.filter((x) => x.track.kind === 'video');
  if (videoFound.length === 0) {
    store.toastMsg('info', 'A compound clip lives on a video track — include at least one video-track clip.');
    return;
  }
  const anchor = videoFound.find((x) => x.clip.id === s.selected?.clipId) ?? videoFound[0];
  const fps = s.project.canvas.fps;
  const start = qFrame(Math.min(...found.map((x) => x.clip.start)), fps);
  const end = Math.max(...found.map((x) => clipEnd(x.clip)));
  const nestTracks: Track[] = [];
  for (const tr of s.project.tracks) {
    const sel = found.filter((x) => x.track.id === tr.id).map((x) => x.clip);
    if (sel.length === 0) continue;
    const nt = JSON.parse(JSON.stringify({ ...tr, clips: sel })) as Track;
    for (const c of nt.clips) c.start = Math.max(0, qFrame(c.start - start, fps));
    nt.clips.sort((a, b) => a.start - b.start);
    nestTracks.push(nt);
  }
  const nCompounds = s.project.tracks.reduce(
    (n, tr) => n + tr.clips.filter((c) => 'nest' in c).length, 0,
  );
  const compound: CompoundClip = {
    id: newId('clip'),
    start,
    in: 0,
    out: Math.max(1 / fps, end - start),
    nest: { name: `Compound ${nCompounds + 1}`, tracks: nestTracks },
    transform: { ...DEFAULT_TRANSFORM },
    volume: 1,
    transitionIn: null,
    transitionDur: 0.25,
  };
  const idSet = new Set(found.map((x) => x.clip.id));
  store.commitL('Compound clips', (d) => {
    for (const tr of d.tracks) tr.clips = tr.clips.filter((c) => !idSet.has(c.id));
    const host = d.tracks.find((t) => t.id === anchor.track.id)!;
    host.clips.push(compound);
    host.clips.sort((a, b) => a.start - b.start);
  });
  store.set({ selected: { trackId: anchor.track.id, clipId: compound.id }, selectedMany: [] });
  store.toastMsg('info', `Compounded ${found.length} clip(s) into “${compound.nest.name}” — double-click it to edit inside.`);
}

/** Merge the selected compound's nest back onto the timeline: nest clips
 *  return to tracks with their original ids (fresh ids on collision),
 *  retimed by the window mapping start + (nestTime − in). */
export function uncompoundSelected() {
  const s = store.get();
  if (!s.selected) {
    store.toastMsg('info', 'Select a compound clip first.');
    return;
  }
  const { track, clip } = findClip(s.project, s.selected.trackId, s.selected.clipId);
  if (!track || !clip || !('nest' in clip)) {
    store.toastMsg('info', 'That clip is not a compound — nothing to uncompound.');
    return;
  }
  const cc = clip as CompoundClip;
  store.commitL('Uncompound', (d) => {
    const host = d.tracks.find((t) => t.id === track.id)!;
    host.clips = host.clips.filter((c) => c.id !== cc.id);
    const existingIds = new Set<string>();
    for (const tr of d.tracks) for (const c of tr.clips) existingIds.add(c.id);
    for (const nt of cc.nest.tracks) {
      let target = d.tracks.find((t) => t.id === nt.id);
      if (!target) {
        target = JSON.parse(JSON.stringify({ ...nt, clips: [] })) as Track;
        d.tracks.push(target);
      }
      for (const nc0 of nt.clips) {
        const nc = JSON.parse(JSON.stringify(nc0)) as Clip;
        if (existingIds.has(nc.id)) nc.id = newId('clip');
        existingIds.add(nc.id);
        nc.start = Math.max(0, cc.start + (nc.start - cc.in));
        target.clips.push(nc);
      }
      target.clips.sort((a, b) => a.start - b.start);
    }
  });
  store.set({ selected: null, selectedMany: [] });
  store.toastMsg('info', `“${cc.nest.name}” uncompounded back onto the timeline.`);
}

/** Open a compound's nest as the working project (isolated session): the
 *  store's history stacks are parked, the parent JSON is kept in the
 *  session, and autosave is suspended by App while the session is open —
 *  the nest can never leak into the parent's autosave or relay slot. */
export function openNest(trackId: string, clipId: string) {
  const s = store.get();
  if (s.nestSession) return;
  const { clip } = findClip(s.project, trackId, clipId);
  if (!clip || !('nest' in clip)) return;
  const cc = clip as CompoundClip;
  void projectStore.saveAutosave(s.project).catch(() => undefined); // parent safe first
  const synthetic = JSON.parse(JSON.stringify(s.project)) as Project;
  synthetic.tracks = JSON.parse(JSON.stringify(cc.nest.tracks)) as Track[];
  store.beginIsolated(synthetic);
  store.set({ nestSession: { parentJson: JSON.stringify(s.project), name: cc.nest.name, trackId, clipId } });
  playback.seek(0);
}

/** Close the nest session: fold the edited nest tracks back into the parent
 *  compound as ONE labelled undo step in the parent's own history. */
export function closeNest() {
  const s = store.get();
  const sess = s.nestSession;
  if (!sess) return;
  const parent = JSON.parse(sess.parentJson) as Project;
  const { clip } = findClip(parent, sess.trackId, sess.clipId);
  if (clip && 'nest' in clip) {
    (clip as CompoundClip).nest.tracks = JSON.parse(JSON.stringify(s.project.tracks)) as Track[];
  }
  store.endIsolated(parent, sess.parentJson, `Edit compound “${sess.name}”`);
  store.set({ nestSession: null });
  void projectStore.saveAutosave(parent).catch(() => undefined);
  playback.seek(0);
}

// ---- Adjustment clips (I.12) ----

/** Add a 2 s adjustment clip at the playhead on the first video track. Its
 *  effects + grade apply to everything beneath it (see Preview's fold). */
export function addAdjustmentClip() {
  const s = store.get();
  const track = s.project.tracks.find((t) => t.kind === 'video');
  if (!track) {
    store.toastMsg('error', 'No video track to hold an adjustment clip.');
    return;
  }
  if (track.locked) {
    store.toastMsg('info', 'The first video track is locked — unlock it to add an adjustment clip.');
    return;
  }
  const clip: AdjustmentClip = {
    id: newId('clip'),
    adj: true,
    start: qFrame(playback.time, s.project.canvas.fps),
    dur: 2,
    effects: [],
    transitionIn: null,
    transitionDur: 0.25,
  };
  store.commitL('Add adjustment clip', (d) => {
    const tr = d.tracks.find((t) => t.id === track.id)!;
    tr.clips.push(clip);
    tr.clips.sort((a, b) => a.start - b.start);
  });
  store.set({ selected: { trackId: track.id, clipId: clip.id } });
}

// ---- Multicam (F.17) ----

/** Build a multicam clip from 2+ selected video clips: the anchor clip
 *  keeps its timing and gains an angle list; the other clips are consumed
 *  as angles. `media` always mirrors the active angle (see types.ts). */
export function makeMulticamFromSelection() {
  const s = store.get();
  const targets = s.selectedMany.length > 0 ? s.selectedMany : s.selected ? [s.selected] : [];
  const vids = targets
    .map((tg) => findClip(s.project, tg.trackId, tg.clipId))
    .filter((x) => x.track?.kind === 'video' && x.clip && 'media' in x.clip) as { track: Track; clip: VideoClip }[];
  if (vids.length < 2) {
    store.toastMsg('info', 'Select two or more video clips (Shift+click) to build a multicam clip.');
    return;
  }
  const base = vids.find((v) => v.clip.id === s.selected?.clipId) ?? vids[0];
  const labelFor = (media: string) => s.project.media.find((m) => m.id === media)?.src ?? media;
  const angles = vids.map((v) => ({ media: v.clip.media, label: labelFor(v.clip.media) }));
  const removeIds = new Set(vids.filter((v) => v.clip.id !== base.clip.id).map((v) => v.clip.id));
  store.commitL('Make multicam', (d) => {
    for (const tr of d.tracks) tr.clips = tr.clips.filter((c) => !removeIds.has(c.id));
    const host = d.tracks.find((t) => t.id === base.track.id)!;
    const bc = host.clips.find((c) => c.id === base.clip.id) as VideoClip;
    bc.angles = angles;
    bc.activeAngle = Math.max(0, angles.findIndex((a) => a.media === base.clip.media));
  });
  store.set({ selected: { trackId: base.track.id, clipId: base.clip.id }, selectedMany: [] });
  store.toastMsg('info', 'Multicam clip created — switch angles in the Inspector, sync them there, and cut between them with keys 1–9.');
}

/** The window shift when a clip's effective sync offset changes by
 *  `delta` (D1.4): in/out move together so the same moments stay on
 *  screen. An in that would go negative clamps to 0 with the OUT point
 *  kept fixed in the new angle's terms — the angle has no frames for
 *  that head span, so the clip honestly shortens rather than sliding
 *  its alignment (and switching back lands on the same moments).
 *  Pure — harness-tested. */
export function shiftedWindow(winIn: number, winOut: number, delta: number): { in: number; out: number } {
  if (!delta) return { in: winIn, out: winOut };
  const ni = winIn + delta;
  if (ni < 0) return { in: 0, out: Math.max(0.05, winOut + delta) };
  return { in: ni, out: winOut + delta };
}

/** Switch a multicam clip's active angle (re-points `media`; D1.4: the
 *  in/out window shifts by the sync-offset delta so the same moment
 *  stays on screen). */
export function setActiveAngle(trackId: string, clipId: string, idx: number) {
  store.commitL('Switch angle', (d) => {
    const tr = d.tracks.find((t) => t.id === trackId);
    const c = tr?.clips.find((x) => x.id === clipId) as VideoClip | undefined;
    if (!c?.angles || !c.angles[idx]) return;
    const prev = c.angles[c.activeAngle ?? 0];
    const delta = (c.angles[idx].syncOffset ?? 0) - (prev?.syncOffset ?? 0);
    const w = shiftedWindow(c.in, c.out, delta);
    c.in = w.in;
    c.out = w.out;
    c.activeAngle = idx;
    c.media = c.angles[idx].media;
  });
}

/**
 * The number-key angle cut, performed inside a draft (D1.4): split the
 * multicam clip at t (the generic split's video branch, verbatim
 * semantics) and give the RIGHT segment the chosen angle — its window
 * shifts by the offset delta so it shows the same moment from the new
 * camera. Returns the new segment's id, or null when the cut is not
 * possible there. Pure over the draft — harness-tested.
 */
export function performAngleCut(
  draft: Project, trackId: string, clipId: string, t: number, angleIdx: number,
): string | null {
  const tr = draft.tracks.find((x) => x.id === trackId);
  const idx = tr?.clips.findIndex((c) => c.id === clipId) ?? -1;
  if (!tr || idx < 0) return null;
  const c = tr.clips[idx] as VideoClip;
  if (!c.angles || !c.angles[angleIdx]) return null;
  if (!(t > c.start + 0.001 && t < c.start + clipDuration(c) - 0.001)) return null;
  const right = JSON.parse(JSON.stringify(c)) as VideoClip;
  right.id = newId('clip');
  const offset = t - c.start;
  const mid = c.in + offset * c.speed;
  right.in = mid;
  c.out = mid;
  if (c.keyframes) {
    right.keyframes = c.keyframes.filter((k) => k.t >= offset).map((k) => ({ ...k, t: k.t - offset }));
    c.keyframes = c.keyframes.filter((k) => k.t < offset);
  }
  right.start = t;
  right.transitionIn = null;
  const delta = (c.angles[angleIdx].syncOffset ?? 0) - (c.angles[c.activeAngle ?? 0].syncOffset ?? 0);
  const w = shiftedWindow(right.in, right.out, delta);
  right.in = w.in;
  right.out = w.out;
  right.activeAngle = angleIdx;
  right.media = c.angles[angleIdx].media;
  tr.clips.splice(idx + 1, 0, right);
  return right.id;
}

/**
 * Number keys 1–9 (D1.4): cut the multicam clip under the playhead to
 * angle N at the playhead. Prefers the selected clip; falls back to any
 * multicam clip under the playhead. One commit (one undo step); the new
 * segment is selected and its edge flashes once. Returns false when no
 * multicam clip is in play, so the key keeps its default behaviour.
 */
export function cutToAngleAtPlayhead(angleIdx: number): boolean {
  const s = store.get();
  const t = qFrame(playback.time, s.project.canvas.fps);
  let target: { trackId: string; clip: VideoClip } | null = null;
  const candidates: { trackId: string; clip: VideoClip }[] = [];
  for (const tr of s.project.tracks) {
    if (tr.kind !== 'video') continue;
    for (const c of tr.clips) {
      const vc = c as VideoClip;
      if (vc.angles && vc.angles.length > angleIdx &&
          t > vc.start + 0.001 && t < vc.start + clipDuration(vc) - 0.001) {
        candidates.push({ trackId: tr.id, clip: vc });
      }
    }
  }
  if (!candidates.length) return false;
  target = candidates.find((x) => x.clip.id === s.selected?.clipId) ?? candidates[candidates.length - 1];
  let rightId: string | null = null;
  store.commitL(`Cut to angle ${angleIdx + 1}`, (d) => {
    rightId = performAngleCut(d, target!.trackId, target!.clip.id, t, angleIdx);
  });
  if (!rightId) return false;
  store.set({ selected: { trackId: target.trackId, clipId: rightId } });
  angleFlash.fire(rightId);
  return true;
}

/**
 * D1.4: land measured sync offsets (by media id) on a multicam clip's
 * angles. If the ACTIVE angle's offset changed, the clip window shifts
 * by the change so the picture doesn't jump. Returns how many angles
 * received an offset.
 */
export function applyAngleSync(trackId: string, clipId: string, offsets: Record<string, number>): number {
  let applied = 0;
  store.commitL('Sync angles', (d) => {
    const tr = d.tracks.find((t) => t.id === trackId);
    const c = tr?.clips.find((x) => x.id === clipId) as VideoClip | undefined;
    if (!c?.angles) return;
    const activeIdx = c.activeAngle ?? 0;
    const oldActive = c.angles[activeIdx]?.syncOffset ?? 0;
    for (const a of c.angles) {
      if (offsets[a.media] !== undefined) {
        a.syncOffset = offsets[a.media];
        applied++;
      }
    }
    const newActive = c.angles[activeIdx]?.syncOffset ?? 0;
    const w = shiftedWindow(c.in, c.out, newActive - oldActive);
    c.in = w.in;
    c.out = w.out;
  });
  return applied;
}
