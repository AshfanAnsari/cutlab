/**
 * control2-harness.entry.ts — Phase 2 live-control parity checks:
 *   · the pure edit-op engine (src/services/editOps.ts) over plain
 *     project JSON — split math (incl. speed), keyframes, the 3-layer
 *     grade stack cap, the media-registry law, a compound round-trip,
 *     batch atomicity, marker ops, text-style merges, timing ops,
 *     effects/transitions, the audio group, track ops, multicam angles;
 *   · the new live commands (src/services/control.ts executeCommand)
 *     against the REAL editor store, in the control-harness pattern:
 *     applyOps (incl. one-command = one-undo-step), grabStill,
 *     getProjectSummary and listMarkers returning sane shapes
 *     headlessly. Under Node there is no DOM, so grabStill degrades
 *     to its state payload — the harness asserts the state, not pixels.
 *
 * Run: npx vite build --ssr scripts/control2-harness.entry.ts \
 *        --outDir /tmp/control2-harness && node /tmp/control2-harness/*.js
 */
import { store } from '../src/state/store';
import { CONTROL_COMMANDS, executeCommand } from '../src/services/control';
import { applyEditOp, applyEditOps, EDIT_OPS } from '../src/services/editOps';
import {
  emptyProject, type AudioClip, type Project, type TextClip, type VideoClip,
} from '../src/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}
function throws(name: string, fn: () => unknown, needle?: string) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, needle === undefined || msg.includes(needle), msg);
  }
}
async function expectFail(name: string, kind: string, args: Record<string, unknown>) {
  try {
    const r = await executeCommand(kind, args);
    fail++;
    console.log(`  FAIL ${name} — expected failure, got ${JSON.stringify(r)}`);
  } catch { pass++; console.log(`  PASS ${name}`); }
}

function baseProject(): Project {
  const p = emptyProject();
  p.name = 'Control2 harness';
  p.media = [
    { id: 'm1', src: 'clip1.mp4', kind: 'video', duration: 12 },
    { id: 'a1', src: 'song.mp3', kind: 'audio', duration: 30 },
  ];
  const vTrack = p.tracks.find((t) => t.kind === 'video')!;
  vTrack.clips.push({
    id: 'v1', media: 'm1', start: 3, in: 2, out: 8, speed: 1, muted: false,
    volume: 1, transitionIn: null, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
  } as VideoClip);
  const aTrack = p.tracks.find((t) => t.kind === 'audio')!;
  aTrack.clips.push({
    id: 'au1', media: 'a1', start: 0, in: 0, out: 10, speed: 1, volume: 0.8,
    fadeIn: 0, fadeOut: 0, transitionIn: null,
  } as AudioClip);
  return p;
}
function clipOf(p: Project, id: string) {
  for (const t of p.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return { track: t, clip: c };
  }
  return null;
}
const vc = (p: Project, id: string) => clipOf(p, id)?.clip as VideoClip;

async function main() {
  console.log('— op vocabulary');
  check('vocabulary covers the Phase 1 editable subset (>= 50 ops)', EDIT_OPS.length >= 50, EDIT_OPS.length);
  for (const n of ['add_clip', 'trim_clip', 'split_clip', 'set_transform', 'add_keyframe',
    'set_grade_layer', 'add_effect', 'set_transition', 'add_text', 'set_text_style',
    'set_clip_volume', 'set_audio_bus', 'add_marker', 'set_canvas'] as const) {
    check(`op '${n}' exists`, (EDIT_OPS as readonly string[]).includes(n));
  }

  console.log('— split math (pure, incl. speed + input purity)');
  {
    const p = baseProject();
    const snapshot = JSON.stringify(p);
    const out = applyEditOp(p, { op: 'split_clip', clipId: 'v1', at: 5 });
    const left = vc(out, 'v1');
    const rights = out.tracks.flatMap((t) => t.clips).filter((c) => c.id !== 'v1' && 'media' in c && (c as VideoClip).media === 'm1');
    check('split: left out = in + offset (2 + 2 = 4)', left.out === 4, left);
    check('split: right starts at 5 with in = 4, out = 8',
      rights.length === 1 && rights[0].start === 5 && (rights[0] as VideoClip).in === 4 && (rights[0] as VideoClip).out === 8, rights);
    check('split: the input project was not mutated', JSON.stringify(p) === snapshot);
  }
  {
    const p = baseProject();
    const c = vc(p, 'v1');
    c.in = 0; c.out = 12; c.start = 0; c.speed = 2; // 6 s on the timeline
    const out = applyEditOp(p, { op: 'split_clip', clipId: 'v1', at: 2 });
    check('split at speed 2: source mid = in + offset * speed (0 + 2*2 = 4)', vc(out, 'v1').out === 4, vc(out, 'v1'));
  }
  throws('split outside the clip refuses', () => applyEditOp(baseProject(), { op: 'split_clip', clipId: 'v1', at: 99 }), 'not inside');

  console.log('— keyframes');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'add_keyframe', clipId: 'v1', t: 2, scale: 1.5, ease: 'easeInOut' });
    p = applyEditOp(p, { op: 'add_keyframe', clipId: 'v1', t: 0.5, x: 10 });
    const kfs = vc(p, 'v1').keyframes ?? [];
    check('keyframes land sorted with their values', kfs.length === 2 && kfs[0].t === 0.5 && kfs[0].x === 10 && kfs[1].scale === 1.5 && kfs[1].ease === 'easeInOut', kfs);
    p = applyEditOp(p, { op: 'remove_keyframe', clipId: 'v1', t: 0.5 });
    check('remove_keyframe by t', (vc(p, 'v1').keyframes ?? []).length === 1);
    throws('add_keyframe on an audio clip refuses',
      () => applyEditOp(p, { op: 'add_keyframe', clipId: 'au1', t: 0, x: 1 }), 'cannot carry keyframes');
  }

  console.log('— grade stack (cap 3, layer set, qualifier, LUT, look)');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'add_grade_layer', clipId: 'v1', grade: { exposure: 0.5 } });
    p = applyEditOp(p, { op: 'add_grade_layer', clipId: 'v1' });
    p = applyEditOp(p, { op: 'add_grade_layer', clipId: 'v1' });
    check('three grade layers stack', (vc(p, 'v1').grades ?? []).length === 3, vc(p, 'v1').grades);
    check('first layer carries the patch, legacy grade field is gone',
      vc(p, 'v1').grades![0].exposure === 0.5 && vc(p, 'v1').grade === undefined);
    throws('a 4th grade layer refuses (stack cap 3)',
      () => applyEditOp(p, { op: 'add_grade_layer', clipId: 'v1' }), 'maximum 3');
    p = applyEditOp(p, { op: 'set_grade_layer', clipId: 'v1', layer: 1, grade: { contrast: 0.4 } });
    check('set_grade_layer merges onto the addressed layer only',
      vc(p, 'v1').grades![1].contrast === 0.4 && vc(p, 'v1').grades![0].exposure === 0.5);
    p = applyEditOp(p, { op: 'set_qualifier_key', clipId: 'v1', layer: 0, key: { hue: 0.3, hueWidth: 0.2 } });
    check('qualifier key lands on the layer', vc(p, 'v1').grades![0].key?.hue === 0.3 && vc(p, 'v1').grades![0].key?.hueWidth === 0.2);
    p = applyEditOp(p, { op: 'set_lut', clipId: 'v1', lutId: 'lut_film', lutStrength: 0.7 });
    check('set_lut writes id + strength', vc(p, 'v1').grades![0].lutId === 'lut_film' && vc(p, 'v1').grades![0].lutStrength === 0.7);
    p = applyEditOp(p, { op: 'remove_grade_layer', clipId: 'v1', layer: 2 });
    check('remove_grade_layer shrinks the stack', (vc(p, 'v1').grades ?? []).length === 2);
    p = applyEditOp(p, { op: 'set_project_look', grade: { temperature: 0.3 } });
    check('project look is set independently', p.look?.temperature === 0.3, p.look);
  }

  console.log('— media-registry law');
  {
    const p = baseProject();
    throws('remove_media is refused by name', () => applyEditOp(p, { op: 'remove_media', mediaId: 'm1' }), 'media registry');
    throws('add_clip onto unregistered media refuses',
      () => applyEditOp(p, { op: 'add_clip', mediaId: 'ghost' }), 'media registry');
    throws('an op carrying a media array refuses',
      () => applyEditOp(p, { op: 'set_canvas', w: 100, media: [] }), 'media registry');
    const snapshot = JSON.stringify(p);
    throws('a batch smuggling a registry op refuses',
      () => applyEditOps(p, [{ op: 'trim_clip', clipId: 'v1', in: 3, out: 7 }, { op: 'register_media', id: 'x' }]),
      'media registry');
    check('…and the refused batch changed nothing', JSON.stringify(p) === snapshot);
    throws('separate_voice refuses as a job op, not a document edit',
      () => applyEditOp(p, { op: 'separate_voice', clipId: 'au1' }), 'job');
  }

  console.log('— batch atomicity + compound round-trip');
  {
    const p = baseProject();
    const snapshot = JSON.stringify(p);
    throws('a batch with a bad tail op throws',
      () => applyEditOps(p, [
        { op: 'trim_clip', clipId: 'v1', in: 3, out: 7 },
        { op: 'trim_clip', clipId: 'ghost', in: 0, out: 1 },
      ]), 'whole batch was refused');
    check('atomicity: the original is byte-identical after the failed batch', JSON.stringify(p) === snapshot);
    const ok = applyEditOps(p, [
      { op: 'trim_clip', clipId: 'v1', in: 3, out: 7 },
      { op: 'add_marker', t: 1, label: 'beat' },
    ]);
    check('a good batch applies every op', vc(ok, 'v1').in === 3 && ok.markers.length === 1);
  }
  {
    let p = baseProject();
    // second video clip so compound has two members
    p = applyEditOp(p, { op: 'add_clip', mediaId: 'm1', start: 20 });
    const added = p.tracks.flatMap((t) => t.clips).find((c) => c.start === 20)!;
    p = applyEditOp(p, { op: 'make_compound', clipIds: ['v1', added.id], name: 'Nest A' });
    const compounds = p.tracks.flatMap((t) => t.clips).filter((c) => 'nest' in c);
    check('make_compound: one compound, originals consumed, nest holds both',
      compounds.length === 1 && !clipOf(p, 'v1')
      && (compounds[0] as VideoClip & { nest: { tracks: { clips: unknown[] }[] } }).nest.tracks
        .reduce((n, t) => n + t.clips.length, 0) === 2, compounds.length);
    p = applyEditOp(p, { op: 'uncompound', clipId: compounds[0].id });
    check('uncompound: both clips are back on the timeline',
      !!clipOf(p, 'v1') && p.tracks.flatMap((t) => t.clips).filter((c) => 'media' in c).length === 3);
  }

  console.log('— markers, range, canvas');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'add_marker', t: 4, label: 'b' });
    p = applyEditOp(p, { op: 'add_marker', t: 1.5, label: 'a', color: '#ff0' });
    check('markers insert sorted', p.markers.map((m) => m.label).join(',') === 'a,b', p.markers);
    p = applyEditOp(p, { op: 'remove_marker', t: 4 });
    check('remove_marker by t', p.markers.length === 1 && p.markers[0].label === 'a');
    throws('remove_marker with nothing matching refuses', () => applyEditOp(p, { op: 'remove_marker', t: 99 }), 'no marker matches');
    p = applyEditOp(p, { op: 'set_timeline_range', rangeIn: 1, rangeOut: 6 });
    check('timeline range set', p.rangeIn === 1 && p.rangeOut === 6);
    p = applyEditOp(p, { op: 'set_canvas', w: 1080, h: 1920, fps: 60 });
    check('canvas set', p.canvas.w === 1080 && p.canvas.h === 1920 && p.canvas.fps === 60, p.canvas);
  }

  console.log('— text ops (style merge, preset, animation)');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'add_text', text: 'HELLO', start: 1, dur: 3, x: 0.25 });
    const tc = p.tracks.flatMap((t) => t.clips).find((c) => 'text' in c) as TextClip;
    check('add_text creates the clip on the text track', !!tc && tc.text === 'HELLO' && tc.dur === 3, tc);
    p = applyEditOp(p, { op: 'set_text_style', clipId: tc.id, fontSize: 72, color: '#ffcc00' });
    const styled = clipOf(p, tc.id)!.clip as TextClip;
    check('set_text_style merges: patched fields change, the rest survive',
      styled.fontSize === 72 && styled.color === '#ffcc00' && styled.x === 0.25 && styled.style === 'pop-bold', styled);
    p = applyEditOp(p, { op: 'apply_text_preset', clipId: tc.id, preset: 'caption' });
    const preset = clipOf(p, tc.id)!.clip as TextClip;
    check('apply_text_preset (built-in) copies the preset fields',
      preset.style === 'caption' && preset.fontSize === 44 && preset.fontWeight === 700, preset);
    throws('an unknown preset refuses by name',
      () => applyEditOp(p, { op: 'apply_text_preset', clipId: tc.id, preset: 'nope' }), 'no built-in text preset');
    p = applyEditOp(p, { op: 'set_text_animation', clipId: tc.id, animIn: 'typewriter', animLoop: 'wave', animInDur: 0.9 });
    const anim = clipOf(p, tc.id)!.clip as TextClip;
    check('text animation fields land', anim.animIn === 'typewriter' && anim.animLoop === 'wave' && anim.animInDur === 0.9, anim);
    p = applyEditOp(p, { op: 'update_text', clipId: tc.id, text: 'WORLD' });
    check('update_text rewrites the string', (clipOf(p, tc.id)!.clip as TextClip).text === 'WORLD');
    p = applyEditOp(p, { op: 'remove_text', clipId: tc.id });
    check('remove_text deletes the clip', clipOf(p, tc.id) === null);
  }

  console.log('— timing, effects, transitions, transform family');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'set_clip_timing', clipId: 'v1', speed: 2, speedKeys: [{ t: 0, speed: 2 }, { t: 3, speed: 0.5 }], reversed: true });
    const timed = vc(p, 'v1');
    check('timing: speed + sorted ramp keys + reverse land',
      timed.speed === 2 && (timed.speedKeys ?? []).length === 2 && timed.reversed === true, timed);
    p = applyEditOp(p, { op: 'add_effect', clipId: 'v1', type: 'blur', value: 0.3 });
    p = applyEditOp(p, { op: 'update_effect', clipId: 'v1', type: 'blur', value: 0.9 });
    check('effect add + update by type', (vc(p, 'v1').effects ?? [])[0]?.value === 0.9, vc(p, 'v1').effects);
    p = applyEditOp(p, { op: 'remove_effect', clipId: 'v1', type: 'blur' });
    check('effect removed', (vc(p, 'v1').effects ?? []).length === 0);
    throws('an unknown effect type refuses', () => applyEditOp(p, { op: 'add_effect', clipId: 'v1', type: 'sparkle' }), 'not one of');
    p = applyEditOp(p, { op: 'set_transition', clipId: 'v1', type: 'dissolve', duration: 0.5, direction: 'left' });
    const tr = vc(p, 'v1');
    check('transition set with duration + direction',
      tr.transitionIn === 'dissolve' && tr.transitionDur === 0.5 && tr.transitionDir === 'left', tr);
    p = applyEditOp(p, { op: 'set_transform', clipId: 'v1', transform: { x: 40, scale: 1.25 } });
    check('set_transform merges (x/scale change, rotation untouched)',
      vc(p, 'v1').transform.x === 40 && vc(p, 'v1').transform.scale === 1.25 && vc(p, 'v1').transform.rotation === 0);
    p = applyEditOp(p, { op: 'set_crop', clipId: 'v1', l: 0.1, r: 0.1 });
    p = applyEditOp(p, { op: 'set_blend_mode', clipId: 'v1', blend: 'screen' });
    p = applyEditOp(p, { op: 'set_flip', clipId: 'v1', flipH: true });
    p = applyEditOp(p, { op: 'set_mask', clipId: 'v1', shape: 'circle', feather: 0.05 });
    const dressed = vc(p, 'v1');
    check('crop / blend / flip / mask all land',
      dressed.crop?.l === 0.1 && dressed.blend === 'screen' && dressed.flipH === true && dressed.mask?.shape === 'circle', dressed);
    p = applyEditOp(p, { op: 'move_clip', clipId: 'v1', start: 7 });
    p = applyEditOp(p, { op: 'duplicate_clip', clipId: 'v1' });
    check('move + duplicate', vc(p, 'v1').start === 7
      && p.tracks.flatMap((t) => t.clips).filter((c) => 'media' in c && (c as VideoClip).media === 'm1').length === 2);
  }

  console.log('— audio group');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'set_clip_volume', clipId: 'au1', volume: 5 });
    check('volume clamps to 1 (live-channel parity)', (clipOf(p, 'au1')!.clip as AudioClip).volume === 1);
    p = applyEditOp(p, { op: 'set_fades', clipId: 'au1', fadeIn: 0.5, fadeOut: 1.25 });
    p = applyEditOp(p, { op: 'set_pan', clipId: 'au1', pan: -0.5 });
    p = applyEditOp(p, { op: 'set_denoise', clipId: 'au1', denoise: true });
    p = applyEditOp(p, { op: 'set_voice_fx', clipId: 'au1', voiceFx: 'echo' });
    const au = clipOf(p, 'au1')!.clip as AudioClip;
    check('fades / pan / denoise / voiceFx land',
      au.fadeIn === 0.5 && au.fadeOut === 1.25 && au.pan === -0.5 && au.denoise === true && au.voiceFx === 'echo', au);
    p = applyEditOp(p, { op: 'set_eq', clipId: 'au1', bands: [{ freq: 100, gain: 3, q: 1 }] });
    const eq = (clipOf(p, 'au1')!.clip as AudioClip).eqBands ?? [];
    check('set_eq normalises to 6 bands', eq.length === 6 && eq[0].gain === 3 && eq[1].gain === 0, eq);
    p = applyEditOp(p, { op: 'set_volume_keyframes', clipId: 'au1', volumeKeys: [{ t: 2, v: 0.5 }, { t: 0, v: 1 }] });
    check('volume keyframes land sorted',
      ((clipOf(p, 'au1')!.clip as AudioClip).volumeKeys ?? []).map((k) => k.t).join(',') === '0,2');
    p = applyEditOp(p, { op: 'set_audio_bus', masterGain: 0.8, ducking: { enabled: true, amount: 8 } });
    check('audio bus set with defaults + ducking merge',
      p.audioBus?.masterGain === 0.8 && p.audioBus?.compThreshold === -18 && p.audioBus?.ducking?.enabled === true && p.audioBus?.ducking?.release === 300, p.audioBus);
    throws('set_voice_fx on a video clip refuses', () => applyEditOp(p, { op: 'set_voice_fx', clipId: 'v1', voiceFx: 'echo' }), 'audio');
  }

  console.log('— track ops + multicam angles');
  {
    let p = baseProject();
    p = applyEditOp(p, { op: 'add_track', kind: 'audio', name: 'Music', bus: 'music' });
    const music = p.tracks.find((t) => t.name === 'Music');
    check('add_track creates a flagged track', !!music && music.kind === 'audio' && music.bus === 'music', music);
    p = applyEditOp(p, { op: 'set_track_flags', trackId: music!.id, muted: true, volume: 0.4 });
    const flagged = p.tracks.find((t) => t.name === 'Music');
    check('track flags merge', flagged?.muted === true && flagged?.volume === 0.4, flagged);
    p = applyEditOp(p, { op: 'remove_track', trackId: music!.id });
    check('remove_track deletes it', !p.tracks.some((t) => t.name === 'Music'));

    const mc = baseProject();
    const c = vc(mc, 'v1');
    c.angles = [{ media: 'm1', label: 'A' }, { media: 'a1', label: 'B', syncOffset: 0.5 }];
    c.activeAngle = 0;
    const switched = applyEditOp(mc, { op: 'set_active_angle', clipId: 'v1', angle: 1 });
    const sc = vc(switched, 'v1');
    check('set_active_angle re-points media and shifts the window by the offset delta',
      sc.media === 'a1' && sc.activeAngle === 1 && sc.in === 2.5 && sc.out === 8.5, sc);
    const cut = applyEditOp(mc, { op: 'cut_to_angle', clipId: 'v1', at: 5, angle: 1 });
    const right = cut.tracks.flatMap((t) => t.clips).find((x) => x.start === 5) as VideoClip;
    check('cut_to_angle: the right segment carries the new angle',
      !!right && right.activeAngle === 1 && right.media === 'a1', right);
  }
  throws('an unknown op refuses with the vocabulary in the message',
    () => applyEditOp(baseProject(), { op: 'explode_everything' }), 'Unknown edit op');

  console.log('— control commands (real store)');
  for (const k of ['applyOps', 'grabStill', 'getProjectSummary', 'listMarkers'] as const) {
    check(`CONTROL_COMMANDS includes '${k}'`, (CONTROL_COMMANDS as readonly string[]).includes(k));
  }
  check('command count grew 15 -> 19', CONTROL_COMMANDS.length === 19, CONTROL_COMMANDS.length);
  {
    store.replaceProject(baseProject(), { history: false });
    const beforeJson = JSON.stringify(store.get().project);
    const res = await executeCommand('applyOps', {
      ops: [
        { op: 'trim_clip', clipId: 'v1', in: 3, out: 7 },
        { op: 'add_marker', t: 2, label: 'hook' },
      ],
    });
    check('applyOps reports both ops applied', res.applied === 2, res);
    const after = store.get().project;
    check('applyOps mutated the live project', vc(after, 'v1').in === 3 && after.markers.length === 1, after.markers);
    check('applyOps is exactly ONE undo step', store.canUndo());
    store.undo();
    check('one undo reverts the whole batch', JSON.stringify(store.get().project) === beforeJson);
    await expectFail('applyOps with a bad op fails cleanly', 'applyOps', {
      ops: [{ op: 'trim_clip', clipId: 'ghost', in: 0, out: 1 }],
    });
    check('the failed applyOps left the live project untouched',
      JSON.stringify(store.get().project) === beforeJson);
    await expectFail('applyOps without ops fails cleanly', 'applyOps', {});

    const summary = await executeCommand('getProjectSummary', {});
    check('getProjectSummary shape: counts + per-track clips',
      summary.name === 'Control2 harness' && summary.mediaCount === 2 && summary.clipCount === 2
      && Array.isArray(summary.tracks) && (summary.tracks as unknown[]).length === 3, summary);
    const markers = await executeCommand('listMarkers', {});
    check('listMarkers shape', Array.isArray(markers.markers) && markers.count === 0, markers);
    const still = await executeCommand('grabStill', { t: 4 });
    check('grabStill headless: state payload is sane (playhead, canvas, duration)',
      still.projectName === 'Control2 harness' && typeof still.playhead === 'number'
      && (still.canvas as { w: number }).w === 720 && still.requestedTime === 4, still);
    check('grabStill headless: image degrades gracefully with a note',
      still.image === null && typeof still.note === 'string' && (still.note as string).length > 0, still);
    const stillNow = await executeCommand('grabStill', {});
    check('grabStill without t grabs at the current playhead',
      stillNow.requestedTime === null && typeof stillNow.playhead === 'number', stillNow);
  }

  console.log(`\ncontrol2-harness: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('Harness crashed:', e);
  process.exit(2);
});
