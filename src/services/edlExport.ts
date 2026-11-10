// Timeline interchange export (Phase 3): CMX 3600 EDL + FCP7 XML
// (xmeml v5) of the CutLab timeline. Pure functions over the project
// JSON — no store, no DOM — so the harness exercises them headlessly.
//
// Honesty rule: compound and adjustment clips have no flat equivalent
// in either format. They are SKIPPED, and every skip leaves a comment
// in the document naming the clip — never a silent omission.
import type { AudioClip, Project, VideoClip } from '../types';
import { clipDuration, projectDuration } from '../types';

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mediaSrcOf(project: Project, mediaId: string): string {
  return project.media.find((m) => m.id === mediaId)?.src ?? mediaId;
}

function isCompound(c: unknown): boolean {
  return !!c && typeof c === 'object' && 'nest' in (c as Record<string, unknown>);
}

function isAdjustment(c: unknown): boolean {
  return !!c && typeof c === 'object' && (c as Record<string, unknown>).adj === true;
}

// ---------------------------------------------------------------------------
// CMX 3600 EDL

/** Seconds -> HH:MM:SS:FF at the project frame rate (non-drop). */
export function secondsToTimecode(t: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps));
  let frames = Math.max(0, Math.round(t * rate));
  const ff = frames % rate;
  frames = Math.floor(frames / rate);
  const ss = frames % 60;
  const mm = Math.floor(frames / 60) % 60;
  const hh = Math.floor(frames / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** CMX source reel name: 8 chars, upper-case alphanumerics. */
function reelName(src: string): string {
  const stem = src.replace(/\.[^.]*$/, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return (stem || 'CLIP').slice(0, 8).padEnd(8, ' ');
}

/**
 * CMX 3600 EDL: one event per video/audio-track clip in timeline order
 * (tracks in project order, clips sorted by start). Source name comes
 * from the media registry; record in/out are the timeline span, source
 * in/out the clip's trim. A dissolve transitionIn becomes a D event
 * with its duration in frames; any other non-cut transition stays a
 * cut and is named in a comment.
 */
export function toEdl(project: Project): string {
  const fps = project.canvas.fps;
  const lines: string[] = [
    `TITLE: ${project.name}`,
    'FCM: NON-DROP FRAME',
    '',
  ];
  let event = 0;
  for (const track of project.tracks) {
    if (track.kind !== 'video' && track.kind !== 'audio') continue;
    const chan = track.kind === 'video' ? 'V' : 'A';
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      if (isCompound(clip)) {
        lines.push(`* SKIPPED COMPOUND CLIP ${clip.id} AT ${secondsToTimecode(clip.start, fps)} — NESTED TIMELINE NOT FLATTENED`);
        continue;
      }
      if (isAdjustment(clip)) {
        lines.push(`* SKIPPED ADJUSTMENT CLIP ${clip.id} AT ${secondsToTimecode(clip.start, fps)} — EFFECTS/GRADE ONLY, NO SOURCE`);
        continue;
      }
      const vc = clip as VideoClip | AudioClip;
      const src = mediaSrcOf(project, vc.media);
      const dur = clipDuration(clip);
      const recIn = secondsToTimecode(clip.start, fps);
      const recOut = secondsToTimecode(clip.start + dur, fps);
      const srcIn = secondsToTimecode(vc.in, fps);
      const srcOut = secondsToTimecode(vc.out, fps);
      event += 1;
      const num = String(event).padStart(3, '0');
      const trans = vc.transitionIn;
      const isDissolve = trans === 'dissolve';
      const transFrames = Math.max(1, Math.round((vc.transitionDur ?? 0.5) * fps));
      const edit = isDissolve ? `D    ${String(transFrames).padStart(3, '0')}` : 'C       ';
      lines.push(`${num}  ${reelName(src)} ${chan}     ${edit} ${srcIn} ${srcOut} ${recIn} ${recOut}`);
      lines.push(`* FROM CLIP NAME: ${src}`);
      if (trans && trans !== 'cut' && !isDissolve) {
        lines.push(`* TRANSITION IN WAS ${trans.toUpperCase()} — EXPORTED AS CUT`);
      }
      if (vc.speed && vc.speed !== 1) {
        lines.push(`* CLIP SPEED ${vc.speed}x — SOURCE SPAN IS THE FULL TRIM`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// FCP7 XML (xmeml version 5)

function rateXml(fps: number): string {
  return `<rate><timebase>${Math.round(fps)}</timebase><ntsc>FALSE</ntsc></rate>`;
}

function frames(t: number, fps: number): number {
  return Math.max(0, Math.round(t * fps));
}

function pathUrl(src: string): string {
  return 'file://localhost/media/' + src.replace(/%/g, '%25').replace(/ /g, '%20').replace(/#/g, '%23');
}

/**
 * FCP7 XML: one sequence at the canvas rate/size; video and audio
 * tracks with clipitems carrying in/out (source) and start/end
 * (record) in frames. File definitions come from the media registry —
 * the first clipitem for an asset carries the full <file>, later ones
 * reference it by id, as FCP7 expects.
 */
export function toFcp7Xml(project: Project): string {
  const fps = project.canvas.fps;
  const { w, h } = project.canvas;
  const fileIdByMedia = new Map<string, string>();
  let fileSeq = 0;
  let clipSeq = 0;

  const fileXml = (mediaId: string, indent: string): string => {
    const existing = fileIdByMedia.get(mediaId);
    if (existing) return `${indent}<file id="${existing}"/>`;
    fileSeq += 1;
    const id = `file-${fileSeq}`;
    fileIdByMedia.set(mediaId, id);
    const item = project.media.find((m) => m.id === mediaId);
    const src = item?.src ?? mediaId;
    const dur = item?.duration != null ? frames(item.duration, fps) : 0;
    const mediaInner = item?.kind === 'audio'
      ? '<audio><channelcount>2</channelcount></audio>'
      : `<video><samplecharacteristics><width>${item?.width ?? w}</width><height>${item?.height ?? h}</height></samplecharacteristics></video>`;
    return [
      `${indent}<file id="${id}">`,
      `${indent} <name>${escXml(src)}</name>`,
      `${indent} <pathurl>${escXml(pathUrl(src))}</pathurl>`,
      `${indent} ${rateXml(fps)}`,
      `${indent} <duration>${dur}</duration>`,
      `${indent} <media>${mediaInner}</media>`,
      `${indent}</file>`,
    ].join('\n');
  };

  const trackXml = (track: Project['tracks'][number]): string => {
    const items: string[] = [];
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      if (isCompound(clip)) {
        items.push(`     <!-- SKIPPED compound clip ${escXml(clip.id)}: nested timeline not flattened -->`);
        continue;
      }
      if (isAdjustment(clip)) {
        items.push(`     <!-- SKIPPED adjustment clip ${escXml(clip.id)}: effects/grade only, no source -->`);
        continue;
      }
      const vc = clip as VideoClip | AudioClip;
      clipSeq += 1;
      const start = frames(clip.start, fps);
      const end = frames(clip.start + clipDuration(clip), fps);
      items.push([
        `     <clipitem id="clipitem-${clipSeq}">`,
        `      <name>${escXml(mediaSrcOf(project, vc.media))}</name>`,
        `      <duration>${end - start}</duration>`,
        `      ${rateXml(fps)}`,
        `      <start>${start}</start>`,
        `      <end>${end}</end>`,
        `      <in>${frames(vc.in, fps)}</in>`,
        `      <out>${frames(vc.out, fps)}</out>`,
        fileXml(vc.media, '      '),
        `     </clipitem>`,
      ].join('\n'));
    }
    return ['    <track>', ...items, '    </track>'].join('\n');
  };

  const videoTracks = project.tracks.filter((t) => t.kind === 'video');
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio');
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="5">',
    ' <sequence id="sequence-1">',
    `  <name>${escXml(project.name)}</name>`,
    `  <duration>${frames(projectDuration(project), fps)}</duration>`,
    `  ${rateXml(fps)}`,
    '  <media>',
    '   <video>',
    '    <format>',
    '     <samplecharacteristics>',
    `      ${rateXml(fps)}`,
    `      <width>${w}</width>`,
    `      <height>${h}</height>`,
    '      <pixelaspectratio>square</pixelaspectratio>',
    '      <fielddominance>none</fielddominance>',
    '     </samplecharacteristics>',
    '    </format>',
    ...videoTracks.map(trackXml),
    '   </video>',
    '   <audio>',
    ...audioTracks.map(trackXml),
    '   </audio>',
    '  </media>',
    ' </sequence>',
    '</xmeml>',
    '',
  ];
  return lines.join('\n');
}
