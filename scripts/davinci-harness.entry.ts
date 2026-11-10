/**
 * davinci-harness.entry.ts — DaVinci-gaps programme acceptance checks
 * against the REAL client modules, headlessly. Bundled with
 * `vite build --ssr` and run under Node, like control-harness.
 * Sections are added per plan item (D1.1 first).
 */
import { normalizeProject } from '../src/services/projectIO';
import { gradeLayersOf, stackHasEffect } from '../src/services/grade';
import { qualifierMaskValue, rgbToHsv } from '../src/services/qualifier';
import { markersFromBeats } from '../src/services/attachResults';
import { mergeTrackKeyframes, segmentsToCues, smoothReframePath, trackPointsToMaskKeyframes } from '../src/services/analysisJobs';
import { hueCurvesActive } from '../src/services/grade';
import { bandsOf } from '../src/services/eq';
import { getPreviewQuality, pickRuntimeUrl, setPreviewQuality } from '../src/services/mediaStore';
import { applyAngleSync, performAngleCut, setActiveAngle, shiftedWindow } from '../src/state/actions';
import { store } from '../src/state/store';
import type { Project, VideoClip } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- D1.1
console.log('D1.1 serial grade stack — load migration + helpers');
const G1 = { exposure: 0.5 };
const G2 = { contrast: 0.8 };
function legacyProject(clipExtra: Record<string, unknown>): unknown {
  return {
    version: 1, name: 'legacy', canvas: { w: 320, h: 240, fps: 30 },
    media: [{ id: 'm1', src: 'mid.mp4', kind: 'video' }],
    tracks: [
      { id: 't1', kind: 'video', clips: [{ id: 'c1', media: 'm1', start: 0, in: 0, out: 2, speed: 1, muted: true, volume: 0, ...clipExtra }] },
      { id: 't2', kind: 'audio', clips: [] },
      { id: 't3', kind: 'text', clips: [] },
    ],
    markers: [],
  };
}
{
  const p = normalizeProject(legacyProject({ grade: G1 })) as Project;
  const c = p.tracks[0].clips[0] as VideoClip;
  check('legacy grade migrates to one-element stack', eq(c.grades, [G1]), c.grades);
  check('legacy grade field dropped after migration', c.grade === undefined);
}
{
  const p = normalizeProject(legacyProject({ grade: G1, grades: [G1, G2] })) as Project;
  const c = p.tracks[0].clips[0] as VideoClip;
  check('grades array wins over legacy grade', eq(c.grades, [G1, G2]), c.grades);
}
{
  const raw = legacyProject({ grades: [G2] });
  const p = normalizeProject(raw) as Project;
  const c = p.tracks[0].clips[0] as VideoClip;
  check('stack project loads unchanged', eq(c.grades, [G2]), c.grades);
}
{
  const raw = {
    version: 1, name: 'legacy2', canvas: { w: 320, h: 240, fps: 30 }, media: [],
    tracks: [{ id: 't1', kind: 'video', clips: [
      { id: 'a1', adj: true, start: 0, dur: 2, grade: G1 },
      { id: 'n1', start: 0, in: 0, out: 2, volume: 1, transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
        nest: { name: 'N', tracks: [{ id: 'nt', kind: 'video', clips: [
          { id: 'nc', media: 'm1', start: 0, in: 0, out: 1, speed: 1, muted: true, volume: 0, grade: G2 },
        ] }] } },
    ] }],
    markers: [],
  };
  const p = normalizeProject(raw) as Project;
  const adj = p.tracks[0].clips[0] as unknown as { grades?: unknown; grade?: unknown };
  check('adjustment legacy grade migrates', eq(adj.grades, [G1]) && adj.grade === undefined, adj);
  const nestClip = (p.tracks[0].clips[1] as unknown as { nest: { tracks: { clips: { grades?: unknown }[] }[] } });
  check('nested clip legacy grade migrates', eq(nestClip.nest.tracks[0].clips[0].grades, [G2]), nestClip.nest.tracks[0].clips[0]);
}
check('gradeLayersOf legacy', eq(gradeLayersOf({ grade: G1 as never }), [G1]));
check('gradeLayersOf stack', eq(gradeLayersOf({ grades: [G1, G2] as never }), [G1, G2]));
check('gradeLayersOf empty', eq(gradeLayersOf({}), []));
check('stackHasEffect identity layer = false', stackHasEffect({ grades: [{ ...G1, exposure: 0 } as never] }) === false);
check('stackHasEffect real layer = true', stackHasEffect({ grades: [G1 as never] }) === true);
check('stackHasEffect disabled layer = false', stackHasEffect({ grades: [{ ...G1, enabled: false } as never] }) === false);

// ---------------------------------------------------------------- D1.2
console.log('D1.2 qualifier-lite — shared selection formula');
{
  const KEY = { hue: 0, hueWidth: 0.2, hueSoft: 0.05, satMin: 0.3, satMax: 1, satSoft: 0.05, lumaMin: 0, lumaMax: 1, lumaSoft: 0.05 };
  check('pure red fully selected', qualifierMaskValue(255, 0, 0, KEY) === 1, qualifierMaskValue(255, 0, 0, KEY));
  check('pure blue fully rejected', qualifierMaskValue(0, 0, 255, KEY) === 0, qualifierMaskValue(0, 0, 255, KEY));
  check('grey rejected by sat floor', qualifierMaskValue(128, 128, 128, KEY) === 0, qualifierMaskValue(128, 128, 128, KEY));
  // hue wrap: a key centred at 0.98 must still select hue 0.01 (reds wrap)
  const wrap = { ...KEY, hue: 0.98, hueWidth: 0.1 };
  const [hNear] = rgbToHsv(255, 26, 0); // hue ≈ 0.017
  check('hue wraps around 0/1', qualifierMaskValue(255, 26, 0, wrap) > 0.99, { hNear, v: qualifierMaskValue(255, 26, 0, wrap) });
  // feather midpoint: hue ≈ 0.15 sits mid-ramp for half=0.1, soft=0.1
  const mid = { ...KEY, hueWidth: 0.2, hueSoft: 0.1, satMin: 0, lumaMin: 0 };
  const [hMid] = rgbToHsv(255, 230, 0); // hue ≈ 0.150
  const vMid = qualifierMaskValue(255, 230, 0, mid);
  check('feather gives a partial value inside the ramp', vMid > 0.2 && vMid < 0.8, { hMid, vMid });
  // saturation trap edge: s exactly at satMin is fully in (plateau convention)
  const edge = { ...KEY, satMin: 0.5, satSoft: 0.1 };
  check('sat edge pixel fully selected (plateau)', qualifierMaskValue(255, 128, 128, edge) > 0.49, qualifierMaskValue(255, 128, 128, edge));
}

// ---------------------------------------------------------------- D1.3
console.log('D1.3 client wiring pack — mapping helpers');
{
  // beats: source beats land on the clip's timeline span, tiered
  const data = { bpm: 107.67, beats: [{ t: 1.231, tier: 1 }, { t: 1.741, tier: 2 }, { t: 9.9, tier: 2 }] };
  const ms = markersFromBeats([{ start: 10, in: 1, out: 3, speed: 1 }], data);
  check('beats mapped into the clip span only', ms.length === 2, ms);
  check('beat 1 tier/label', ms[0].label === 'Beat 1' && Math.abs(ms[0].t - 10.231) < 1e-6, ms[0]);
  check('beat 2 tier/label', ms[1].label === 'Beat 2' && Math.abs(ms[1].t - 10.741) < 1e-6, ms[1]);
  const fast = markersFromBeats([{ start: 0, in: 0, out: 4, speed: 2 }], data);
  check('speed divides the offset', Math.abs(fast[0].t - 1.231 / 2) < 1e-3, fast[0]);
}
{
  // transcribe segments -> cues: clipped to the clip's source window
  const cues = segmentsToCues({ start: 5, in: 2, out: 6, speed: 1 }, [
    { start: 0.5, end: 1.5, text: 'before' },
    { start: 1.8, end: 3.0, text: 'straddles in' },
    { start: 4.0, end: 5.0, text: 'inside' },
    { start: 5.5, end: 7.0, text: 'straddles out' },
    { start: 8.0, end: 9.0, text: 'after' },
  ]);
  check('cues clipped to the clip span', cues.length === 3, cues);
  check('straddle-in starts at clip start', cues[0].text === 'straddles in' && cues[0].start === 5 && Math.abs(cues[0].end - 6) < 1e-9, cues[0]);
  check('inside cue offset', cues[1].start === 7 && cues[1].end === 8, cues[1]);
  check('straddle-out ends at clip end', cues[2].end === 9, cues[2]);
}
{
  // track merge: tracked keys replace the span, outside keys survive
  const existing = [
    { t: 0, x: 0, y: 0 }, { t: 1.0, x: 5, y: 5 }, { t: 2.0, x: 9, y: 9 }, { t: 5.0, x: 1, y: 1 },
  ];
  const merged = mergeTrackKeyframes(existing, 0.8, [
    { t: 0, x: 10, y: 0 }, { t: 0.5, x: 20, y: 0 }, { t: 1.2, x: 30, y: 0 },
  ], 6);
  check('tracked span replaced', merged.some((k) => k.t === 0.8 && k.x === 10) && !merged.some((k) => k.t === 1.0), merged);
  check('outside keys survive', merged.some((k) => k.t === 0) && merged.some((k) => k.t === 5.0), merged);
  check('merged sorted', merged.every((k, i) => i === 0 || merged[i - 1].t <= k.t), merged);
  const trimmed = mergeTrackKeyframes([], 0, [{ t: 0, x: 0, y: 0 }, { t: 99, x: 1, y: 1 }], 6);
  check('keys past the clip end are trimmed', trimmed.length === 1, trimmed);
}

// ---------------------------------------------------------------- D1.4
console.log('D1.4 multicam sync + angle cutting');
{
  check('shiftedWindow plain', eq(shiftedWindow(1, 5, 0.83), { in: 1.83, out: 5.83 }));
  const w = shiftedWindow(0.5, 4.5, -0.83);
  check('shiftedWindow clamp: in=0, out fixed in new terms (moments preserved)',
    w.in === 0 && Math.abs(w.out - 3.67) < 1e-9, w);
  const back = shiftedWindow(w.in, w.out, 0.83);
  check('clamped switch-back lands on the same moments', Math.abs(back.in - 0.83) < 1e-9 && Math.abs(back.out - 4.5) < 1e-9, back);
}
function multicamProject(): Project {
  return normalizeProject({
    version: 1, name: 'mc', canvas: { w: 320, h: 240, fps: 30 },
    media: [{ id: 'a1', src: 'angle1.mp4', kind: 'video' }, { id: 'a2', src: 'angle2.mp4', kind: 'video' }],
    tracks: [{ id: 't1', kind: 'video', clips: [{
      id: 'mc1', media: 'a1', start: 0, in: 1, out: 5, speed: 1, muted: false, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      angles: [{ media: 'a1', label: 'angle1.mp4' }, { media: 'a2', label: 'angle2.mp4' }],
      activeAngle: 0,
    }] }, { id: 't2', kind: 'audio', clips: [] }, { id: 't3', kind: 'text', clips: [] }],
    markers: [],
  }) as Project;
}
{
  const p = multicamProject();
  const applied = (() => {
    store.replaceProject(p, { history: false });
    const n = applyAngleSync('t1', 'mc1', { a1: 0, a2: 0.83 });
    const c = store.get().project.tracks[0].clips[0] as VideoClip;
    check('applyAngleSync lands both offsets', n === 2 && c.angles?.[1].syncOffset === 0.83, c.angles);
    check('active angle 1 window unmoved (offset 0)', c.in === 1 && c.out === 5, { in: c.in, out: c.out });
    setActiveAngle('t1', 'mc1', 1);
    const c2 = store.get().project.tracks[0].clips[0] as VideoClip;
    check('switch to angle 2 shifts window +0.83', Math.abs(c2.in - 1.83) < 1e-9 && Math.abs(c2.out - 5.83) < 1e-9 && c2.media === 'a2', { in: c2.in, out: c2.out, media: c2.media });
    setActiveAngle('t1', 'mc1', 0);
    const c3 = store.get().project.tracks[0].clips[0] as VideoClip;
    check('switch back restores the window exactly', c3.in === 1 && c3.out === 5 && c3.media === 'a1', { in: c3.in, out: c3.out });
    return n;
  })();
  void applied;
}
{
  const p = multicamProject();
  (p.tracks[0].clips[0] as VideoClip).angles![1].syncOffset = 0.83;
  const rightId = performAngleCut(p, 't1', 'mc1', 2.5, 1);
  const clips = p.tracks[0].clips as VideoClip[];
  check('angle cut makes two segments', clips.length === 2 && rightId === clips[1].id, clips.map((c) => c.id));
  check('left keeps angle 1 + window', clips[0].media === 'a1' && clips[0].in === 1 && clips[0].out === 3.5, { in: clips[0].in, out: clips[0].out });
  check('right takes angle 2, window shifted by the offset',
    clips[1].media === 'a2' && Math.abs(clips[1].in - (3.5 + 0.83)) < 1e-9 && Math.abs(clips[1].out - (5 + 0.83)) < 1e-9 && clips[1].start === 2.5,
    { in: clips[1].in, out: clips[1].out, start: clips[1].start });
  check('cut outside the clip refused', performAngleCut(p, 't1', 'mc1', 99, 1) === null);
}

// ---------------------------------------------------------------- D1.5
console.log('D1.5 voice isolation model');
{
  const p = normalizeProject({
    version: 1, name: 'iso', canvas: { w: 320, h: 240, fps: 30 },
    media: [{ id: 'a1', src: 'x.mp4', kind: 'video' }, { id: 'st1', src: 'x.vocals.wav', kind: 'audio' }],
    tracks: [{ id: 't1', kind: 'video', clips: [{
      id: 'c1', media: 'a1', start: 0, in: 0, out: 4, speed: 1, muted: false, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      audioOverride: { stemMedia: 'st1', strength: 0.7, enabled: true },
    }] }, { id: 't2', kind: 'audio', clips: [{
      id: 'c2', media: 'st1', start: 0, in: 0, out: 4, speed: 1, volume: 1,
      audioOverride: { stemMedia: 'st1', strength: 2.5, enabled: false },
    }] }, { id: 't3', kind: 'text', clips: [] }],
    markers: [],
  }) as Project;
  const v = p.tracks[0].clips[0] as VideoClip;
  check('audioOverride survives load (video)', v.audioOverride?.stemMedia === 'st1' && v.audioOverride?.strength === 0.7 && v.audioOverride?.enabled === true, v.audioOverride);
  const a = p.tracks[1].clips[0] as unknown as { audioOverride?: { strength: number; enabled: boolean } };
  check('audioOverride clamps strength + keeps toggle (audio)', a.audioOverride?.strength === 1 && a.audioOverride?.enabled === false, a.audioOverride);
}

// ---------------------------------------------------------------- D2.1
console.log('D2.1 tracked grade windows');
{
  const kfs = trackPointsToMaskKeyframes(
    [{ t: 1, x: 72, y: -128 }, { t: 30, x: 0, y: 0 }],
    { x: 0.3, y: 0.25, w: 0.4, h: 0.5 },
    { w: 720, h: 1280 },
    12, 10, 8);
  check('mask keyframes: one in-span point converted', kfs.length === 1, kfs);
  check('mask keyframe geometry follows the offset',
    kfs[0]?.t === 3 && kfs[0]?.mask?.x === 0.4 && kfs[0]?.mask?.y === 0.15 && kfs[0]?.mask?.w === 0.4,
    kfs[0]);
  const p = normalizeProject({
    version: 1, name: 'adjwin', canvas: { w: 320, h: 240, fps: 30 }, media: [],
    tracks: [{ id: 't1', kind: 'video', clips: [{
      id: 'adj1', adj: true, start: 0, dur: 5,
      mask: { shape: 'rect', x: 0.3, y: 0.25, w: 0.4, h: 0.5, feather: 0.02, invert: false },
      keyframes: [{ t: 1, mask: { x: 0.4, y: 0.15, w: 0.4, h: 0.5 } }],
    }] }, { id: 't2', kind: 'audio', clips: [] }, { id: 't3', kind: 'text', clips: [] }],
    markers: [],
  }) as Project;
  const adj = p.tracks[0].clips[0] as unknown as { mask?: { x: number }; keyframes?: { mask?: { x: number } }[] };
  check('adjustment mask + keyframes survive load', adj.mask?.x === 0.3 && adj.keyframes?.[0]?.mask?.x === 0.4, adj);
}

// ---------------------------------------------------------------- D2.2
console.log('D2.2 smart reframe path');
{
  const path = smoothReframePath(
    [{ t: 0, x: -500 }, { t: 0.1, x: 500 }, { t: 2, x: 500 }],
    5, { w: 1280, h: 720, fps: 30 });
  check('path has all points, timeline times', path.length === 3 && path[0].t === 5 && path[2].t === 7, path);
  const half = 404 / 1280 / 2;
  check('centres clamped inside the frame', path.every((p) => p.cx >= half - 1e-9 && p.cx <= 1 - half + 1e-9), path);
  // per-frame jump bound: between consecutive points, |dcx|*W <= 40*fps*dt (+1 frame slack)
  let maxJumpOk = true;
  for (let i = 1; i < path.length; i++) {
    const dt = path[i].t - path[i - 1].t;
    const jumpPx = Math.abs(path[i].cx - path[i - 1].cx) * 1280;
    if (jumpPx > 40 * 30 * dt + 40 + 1e-6) maxJumpOk = false;
  }
  check('no jump exceeds 40 px/frame after smoothing', maxJumpOk, path);
  check('path ends at the subject (right side)', path[2].cx > 0.7, path[2]);
}

// ---------------------------------------------------------------- D2.4/D2.5
{
  const back = normalizeProject({
    version: 1, name: 'd24', canvas: { w: 320, h: 240, fps: 30 },
    media: [{ id: 'm1', src: 'mid.mp4', kind: 'video' }],
    audioBus: { masterGain: 1, normalise: true, compEnabled: false, compThreshold: -18, compRatio: 3, compMakeup: 4, ducking: { enabled: true, amount: 12, attack: 20, release: 300 } },
    tracks: [{ id: 't1', kind: 'video', bus: 'dialogue', clips: [{
      id: 'c1', media: 'm1', start: 0, in: 0, out: 2, speed: 1, muted: true, volume: 0,
      transform: { x: 0, y: 0, scale: 1, rotation: 90, opacity: 1 },
      grades: [{ hueCurves: { lumSat: [{ x: 0, y: -1 }, { x: 0.4, y: -1 }, { x: 1, y: 0 }] } }],
      eqBands: [{ freq: 250, gain: 12, q: 1 }, { freq: 6000, gain: -3, q: 2 }],
    }] }, { id: 't2', kind: 'audio', clips: [] }, { id: 't3', kind: 'text', clips: [] }],
    markers: [],
  }) as Project;
  const bv = back.tracks[0].clips[0] as VideoClip;
  check('D2.4: lumSat curve survives the load round-trip',
    bv.grades?.[0].hueCurves?.lumSat?.length === 3 && hueCurvesActive(bv.grades[0].hueCurves));
  check('D2.5: eqBands survive (freq/gain/q intact)',
    bv.eqBands?.length === 2 && bv.eqBands[0].freq === 250 && bv.eqBands[0].gain === 12);
  check('D2.5: track bus + ducking settings survive',
    back.tracks[0].bus === 'dialogue' && back.audioBus?.ducking?.amount === 12);
  check('D2.5: legacy 3-band maps onto bands 1/3/5',
    bandsOf({ eqLow: 6, eqMid: 0, eqHigh: -3 })[0].freq === 200 &&
    bandsOf({ eqLow: 6, eqMid: 0, eqHigh: -3 })[0].gain === 6 &&
    bandsOf({ eqLow: 6, eqMid: 0, eqHigh: -3 })[4].gain === -3);
  check('D2.6: rotation is degrees end-to-end (90 survives the load untouched)',
    bv.transform.rotation === 90);
}

// ---------------------------------------------------------------- D2.6
{
  const rt = { url: 'blob:orig', proxyUrl: 'blob:proxy' };
  setPreviewQuality('proxy');
  check('D2.6: quality proxy picks the proxy URL', pickRuntimeUrl(rt) === 'blob:proxy' && getPreviewQuality() === 'proxy');
  setPreviewQuality('original');
  check('D2.6: quality original picks the original URL', pickRuntimeUrl(rt) === 'blob:orig');
  setPreviewQuality('half');
  check('D2.6: quality half still uses the proxy file (raster halves in the layer)', pickRuntimeUrl(rt) === 'blob:proxy');
  setPreviewQuality('proxy');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
