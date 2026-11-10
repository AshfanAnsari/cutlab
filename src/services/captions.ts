// Captions package (§L): SRT/VTT parsing + serialising, caption-style
// inheritance. Captions are ordinary text clips end to end — no locked
// caption object — so everything else in the editor works on them.
import type { Project, TextClip } from '../types';
import { newId } from '../types';
import { store } from '../state/store';
import { playback } from '../engine/playback';
import { qFrame } from '../utils/time';

export interface Cue {
  start: number;
  end: number;
  text: string;
}

function parseStamp(stamp: string): number | null {
  const m = /(\d+):(\d{2}):(\d{2})[.,](\d{3})/.exec(stamp.trim());
  if (!m) {
    const m2 = /(\d{2}):(\d{2})[.,](\d{3})/.exec(stamp.trim());
    if (!m2) return null;
    return Number(m2[1]) * 60 + Number(m2[2]) + Number(m2[3]) / 1000;
  }
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Parse SRT or VTT content into cues (tags stripped, multi-line joined). */
export function parseSubtitles(content: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = content.replace(/\r\n/g, '\n').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx < 0) continue;
    const [a, b] = lines[timeIdx].split('-->');
    const start = parseStamp(a);
    const end = parseStamp(b);
    if (start === null || end === null || end <= start) continue;
    const text = lines
      .slice(timeIdx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

function fmtStamp(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

/** Serialise plain cues as an SRT document. */
export function cuesToSrt(cues: Cue[]): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return sorted
    .map((c, i) => `${i + 1}\n${fmtStamp(c.start)} --> ${fmtStamp(c.end)}\n${c.text}\n`)
    .join('\n');
}

function fmtStampVtt(t: number): string {
  return fmtStamp(t).replace(',', '.');
}

/** Serialise plain cues as a WebVTT document. */
export function cuesToVtt(cues: Cue[]): string {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const body = sorted
    .map((c) => `${fmtStampVtt(c.start)} --> ${fmtStampVtt(c.end)}\n${c.text}\n`)
    .join('\n');
  return body ? `WEBVTT\n\n${body}` : 'WEBVTT\n';
}

/** Serialise one text track's clips as an SRT document (L.4). */
export function toSrt(project: Project, trackId: string): string {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return '';
  const clips = [...track.clips].sort((a, b) => a.start - b.start) as TextClip[];
  return cuesToSrt(clips.map((c) => ({
    start: c.start, end: c.start + c.dur, text: c.text.replace(/\*\*/g, ''),
  })));
}

/** Serialise one text track's clips as a WebVTT document (Phase 3). */
export function toVtt(project: Project, trackId: string): string {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return '';
  const clips = [...track.clips].sort((a, b) => a.start - b.start) as TextClip[];
  return cuesToVtt(clips.map((c) => ({
    start: c.start, end: c.start + c.dur, text: c.text.replace(/\*\*/g, ''),
  })));
}

// ---------------------------------------------------------------------------
// Phase 3: caption cues straight from transcription word timings.
// The transcribe lane's word shape is {w, t0, t1} (server/transcribe_job.py,
// TextClip.words) — clip-local seconds there, absolute once offset by the
// caller. Grouping follows creator defaults: a cue breaks on a real pause,
// when it would overflow two short lines, or when it runs too long; very
// short cues are stretched to a readable minimum without eating the next
// cue's start.

/** One transcription word timing (the transcribe lane's shape). */
export interface WordTiming {
  w: string;
  t0: number;
  t1: number;
}

export interface CueFromWordsOptions {
  /** Max characters per wrapped line (default 42). */
  maxCharsPerLine?: number;
  /** Max wrapped lines per cue (default 2). */
  maxLines?: number;
  /** Minimum on-screen duration in seconds (default 0.8). */
  minDur?: number;
  /** Maximum on-screen duration in seconds (default 6). */
  maxDur?: number;
  /** Pause in seconds that always breaks a cue (default 0.7 — the same
   *  gap the transcribe lane phrase-splits on). */
  maxGap?: number;
}

/** Greedy word wrap into lines of at most `maxChars` (a single over-long
 *  word keeps its own line rather than being split). */
function wrapWords(words: string[], maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Build caption cues from transcription word timings. Pure. */
export function cuesFromWords(words: WordTiming[], opts: CueFromWordsOptions = {}): Cue[] {
  const maxChars = Math.max(8, opts.maxCharsPerLine ?? 42);
  const maxLines = Math.max(1, opts.maxLines ?? 2);
  const minDur = Math.max(0, opts.minDur ?? 0.8);
  const maxDur = Math.max(minDur, opts.maxDur ?? 6);
  const maxGap = opts.maxGap ?? 0.7;
  const capacity = maxChars * maxLines;
  const clean = words
    .filter((w) => w && typeof w.w === 'string' && w.w.trim() !== ''
      && Number.isFinite(w.t0) && Number.isFinite(w.t1) && w.t1 >= w.t0)
    .map((w) => ({ w: w.w.trim(), t0: w.t0, t1: w.t1 }))
    .sort((a, b) => a.t0 - b.t0);
  const groups: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  let curLen = 0; // joined character length of `cur`, spaces included
  for (const w of clean) {
    if (cur.length) {
      const gap = w.t0 - cur[cur.length - 1].t1;
      const wouldOverflow = curLen + 1 + w.w.length > capacity;
      const wouldRunLong = w.t1 - cur[0].t0 > maxDur;
      if (gap >= maxGap || wouldOverflow || wouldRunLong) {
        groups.push(cur);
        cur = [];
        curLen = 0;
      }
    }
    curLen = cur.length ? curLen + 1 + w.w.length : w.w.length;
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  const cues: Cue[] = groups.map((g) => ({
    start: g[0].t0,
    end: g[g.length - 1].t1,
    text: wrapWords(g.map((w) => w.w), maxChars).join('\n'),
  }));
  // Stretch sub-minimum cues, never past the next cue's start.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.end - c.start < minDur) {
      const next = cues[i + 1];
      c.end = next ? Math.max(c.start, Math.min(c.start + minDur, next.start)) : c.start + minDur;
    }
  }
  return cues;
}

/** Cues from every word-timed text clip in the project (clip-local word
 *  timings offset onto the timeline), in timeline order. Pure. */
export function cuesFromProjectWords(project: Project, opts: CueFromWordsOptions = {}): Cue[] {
  const out: Cue[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'text') continue;
    for (const clip of track.clips as TextClip[]) {
      if (!clip.words || clip.words.length === 0) continue;
      const shifted = clip.words.map((w) => ({ w: w.w, t0: w.t0 + clip.start, t1: w.t1 + clip.start }));
      out.push(...cuesFromWords(shifted, opts));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const STYLE_KEYS: (keyof TextClip)[] = [
  'style', 'fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth',
  'shadow', 'shadowObj', 'glowObj', 'plate', 'align', 'charSpacing', 'lineSpacing',
  'highlightColor', 'noFill', 'animIn', 'animOut', 'animInDur', 'animOutDur', 'animLoop', 'x', 'y',
];

function copyStyle(from: TextClip, to: TextClip) {
  for (const k of STYLE_KEYS) {
    const v = from[k];
    if (v !== undefined) (to as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(v));
  }
  if ((from.effects ?? []).includes('glow')) to.effects = ['glow'];
}

/** L.1 caption mode: a new caption at the playhead inheriting the previous
 *  caption's design + position, pre-trimmed to the gap before the next one. */
export function addCaptionAtPlayhead() {
  const p = store.get().project;
  const fps = p.canvas.fps;
  const start = qFrame(playback.time, fps);
  let track = p.tracks.find((t) => t.kind === 'text');
  const prev = track
    ? ([...track.clips].filter((c) => c.start <= start).sort((a, b) => b.start - a.start)[0] as TextClip | undefined)
    : undefined;
  const nextStart = track
    ? Math.min(...track.clips.filter((c) => c.start > start).map((c) => c.start), Infinity)
    : Infinity;
  const clip: TextClip = {
    id: newId('clip'), text: 'Caption', start, dur: 2, style: 'caption',
    x: 0.5, y: 0.86, animIn: 'word-reveal', animOut: 'fade', effects: [],
  };
  if (prev) copyStyle(prev, clip);
  clip.dur = Math.max(0.3, Math.min(clip.dur, (isFinite(nextStart) ? nextStart : start + clip.dur) - start));
  const trackId = track?.id ?? newId('trk');
  store.commit((d) => {
    if (!d.tracks.some((t) => t.id === trackId)) {
      d.tracks.push({ id: trackId, kind: 'text', clips: [] });
    }
    const tr = d.tracks.find((t) => t.id === trackId)!;
    tr.clips.push(clip);
    tr.clips.sort((a, b) => a.start - b.start);
  });
  store.set({ selected: { trackId, clipId: clip.id } });
}

/**
 * D1.3(b): land transcribed segments as caption clips — the §L way.
 * Cues arrive already mapped onto the timeline by the caller. Design is
 * inherited from the project's LAST caption (latest start, caption
 * style), and the clips join that caption's track; with no caption
 * anywhere, a fresh text track is created with the default caption
 * design. One commit = one undo step. Returns the clip count.
 */
export function addTranscribedCaptions(cues: Cue[]): number {
  if (!cues.length) return 0;
  const p = store.get().project;
  let donor: TextClip | undefined;
  let donorTrackId: string | undefined;
  for (const t of p.tracks) {
    if (t.kind !== 'text') continue;
    for (const c of t.clips as TextClip[]) {
      if (c.style === 'caption' && (!donor || c.start > donor.start)) {
        donor = c;
        donorTrackId = t.id;
      }
    }
  }
  const base: TextClip = {
    id: '', text: '', start: 0, dur: 2, style: 'caption',
    x: 0.5, y: 0.86, animIn: 'word-reveal', animOut: 'fade', effects: [],
  };
  if (donor) copyStyle(donor, base);
  const trackId = donorTrackId ?? newId('trk');
  store.commit((d) => {
    if (!d.tracks.some((t) => t.id === trackId)) {
      d.tracks.push({ id: trackId, kind: 'text', clips: [] });
    }
    const tr = d.tracks.find((t) => t.id === trackId)!;
    for (const cue of cues) {
      tr.clips.push({
        ...JSON.parse(JSON.stringify(base)) as TextClip,
        id: newId('clip'),
        text: cue.text,
        start: cue.start,
        dur: Math.max(0.3, cue.end - cue.start),
      });
    }
    tr.clips.sort((a, b) => a.start - b.start);
  });
  store.toastMsg('info', `${cues.length} captions added`);
  return cues.length;
}

/** L.3: import a subtitle/transcript file as caption clips on a text track. */
export async function importCaptionFile(file: File): Promise<void> {
  const content = await file.text();
  let cues = parseSubtitles(content);
  if (cues.length === 0 && /\.txt$/i.test(file.name)) {
    // Plain transcript fallback: phrase-split at punctuation, even timing.
    const phrases = content
      .split(/(?<=[.!?।…])\s+/)
      .map((x) => x.trim())
      .filter(Boolean);
    cues = phrases.map((text, i) => ({ start: i * 2.2, end: (i + 1) * 2.2 - 0.08, text }));
  }
  if (cues.length === 0) {
    store.toastMsg('error', 'No caption cues found in that file (SRT/VTT timing lines expected).');
    return;
  }
  const base: TextClip = {
    id: '', text: '', start: 0, dur: 2, style: 'caption',
    x: 0.5, y: 0.86, animIn: 'word-reveal', animOut: 'fade', effects: [],
  };
  const trackId = newId('trk');
  store.commit((d) => {
    const tr = { id: trackId, kind: 'text' as const, clips: [] as TextClip[] };
    for (const cue of cues) {
      tr.clips.push({
        ...JSON.parse(JSON.stringify(base)),
        id: newId('clip'),
        text: cue.text,
        start: cue.start,
        dur: Math.max(0.3, cue.end - cue.start),
      });
    }
    d.tracks.push(tr);
  });
  store.toastMsg('info', `Imported ${cues.length} caption clip(s) onto a new text track.`);
}

export function downloadText(text: string, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
