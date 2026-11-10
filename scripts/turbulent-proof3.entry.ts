/**
 * Turbulent-displace proof v3 — the Mr Drabi tutorial recipe, built
 * literally (see ~/workspace/design-studies/reel-DcOWzJVK3tl/
 * TUTORIAL-RECIPE.md). No interpretation:
 *
 *   layer stack (bottom -> top): background plate / "super crazy car
 *   distortion" (roto-matted copy + Turbulent Displace) / "roto
 *   brushed car" (clean matted copy on top — it occludes the clone
 *   until the clone rises past the car's silhouette).
 *
 *   effect params are AE values at face value: amount 171, size 106,
 *   complexity 1.6, pin 1 (Pin All), evolution_rate 150 deg/s (his
 *   Evolution keyframes run 0 -> 360 deg across the layer's span,
 *   eased; 360 / 2.4 s proof span = 150 — a constant-rate stand-in).
 *   fx value = 1.0 (master scale, un-keyframed: on his first clone the
 *   Amount reads a constant 171 at two playheads).
 *
 *   clone animation = his Position/Scale structure: start tucked
 *   behind the car at 66%, a 10-frame (0.4 s) emergence ramp, grow to
 *   84.4% at the float, mirrored straight-down exit with a fast
 *   collapse, opacity -> 0 at the end. His comp-space positions are
 *   re-based onto this shot via his offsets from his own car's centre
 *   (his car centre estimated (540,1150) in his 1080x1920 comp; this
 *   shot's car centre measured from the matte bbox: (555,1140) in
 *   cropped-canvas space, car fraction centre (0.514, 0.594)).
 *
 * Canvas 1080x1920 so AE pixel values map 1:1. All three clips crop
 * the bottom 13% of the source (generator watermark), as in v2; the
 * matte media carries the same crop geometry baked in.
 *
 * Run: npx vite build --ssr scripts/turbulent-proof3.entry.ts --outDir /tmp/turb-proof3
 *      node /tmp/turb-proof3/turbulent-proof3.entry.js [outDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateProject } from '../supabase/functions/cutlab-mcp/schema';
import {
  applyEditOps, appendEditLog, buildEmptyProject,
  type EditOp, type Project,
} from '../supabase/functions/cutlab-mcp/ops';
import { applyEditOps as applyLiveOps } from '../src/services/editOps';

const outDir = process.argv[2] ?? '/tmp/turbulent-proof3';
mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

const FX = 'turbulent-displace';
// Clone control points: [t, centreX, centreY, scale, opacity] in
// 1080x1920 cropped-canvas space. Transform solve: the car centre sits
// at layer fraction (0.514, 0.594), so a clone car centre (cx, cy) at
// scale s needs x = cx - 540 - 15.1*s, y = cy - 960 - 180.5*s.
const CTRL: [number, number, number, number, number][] = [
  [0.00, 451, 975, 0.660, 1],
  [0.40, 520, 940, 0.760, 1],
  [1.20, 589, 918, 0.844, 1],
  [1.80, 595, 908, 0.844, 1],
  [2.10, 560, 960, 0.550, 1],
  [2.32, 500, 1000, 0.300, 0.35],
  [2.40, 470, 990, 0.240, 0],
];
const smooth = (a: number, b: number, f: number) => {
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
};
function sampleAt(t: number): [number, number, number, number] {
  for (let i = 1; i < CTRL.length; i++) {
    if (t <= CTRL[i][0]) {
      const [t0, x0, y0, s0, o0] = CTRL[i - 1];
      const [t1, x1, y1, s1, o1] = CTRL[i];
      const f = (t - t0) / (t1 - t0);
      return [smooth(x0, x1, f), smooth(y0, y1, f), smooth(s0, s1, f), smooth(o0, o1, f)];
    }
  }
  const [, x, y, s, o] = CTRL[CTRL.length - 1];
  return [x, y, s, o];
}
const toTransform = (cx: number, cy: number, s: number) => ({
  x: cx - 540 - 15.1 * s,
  y: cy - 960 - 180.5 * s,
});
const SAMPLE_TS: number[] = [];
for (let t = 0.08; t < 2.4; t += 0.08) SAMPLE_TS.push(Math.round(t * 100) / 100);
SAMPLE_TS.push(2.4);

// ---- 1. Build the sandwich through the MCP op engine ----------------------
const [cx0, cy0, sInit, oInit] = sampleAt(0);
const tr0 = toTransform(cx0, cy0, sInit);
const AE_PARAMS = { amount: 171, size: 106, complexity: 1.6, pin: 1, evolution_rate: 150, seed: 3 };
const ops: EditOp[] = [
  { op: 'register_media', media: { id: 'car', src: 'car.mp4', kind: 'video', duration: 5.97, width: 1080, height: 1920 } } as EditOp,
  { op: 'register_media', media: { id: 'carMatte', src: 'car_matte.mp4', kind: 'matte', duration: 5.97, width: 540, height: 960 } } as EditOp,
  { op: 'add_track', track_id: 'vdup', kind: 'video' } as EditOp,
  { op: 'add_track', track_id: 'vroto', kind: 'video' } as EditOp,
  { op: 'add_clip', track_id: 'vbase', clip_id: 'base', media_id: 'car', start: 0, in: 0.5, out: 2.9, muted: true } as EditOp,
  { op: 'add_clip', track_id: 'vdup', clip_id: 'dup', media_id: 'car', start: 0, in: 0.5, out: 2.9, muted: true } as EditOp,
  { op: 'add_clip', track_id: 'vroto', clip_id: 'roto', media_id: 'car', start: 0, in: 0.5, out: 2.9, muted: true } as EditOp,
  { op: 'set_crop', clip_id: 'base', crop: { l: 0, t: 0, r: 0, b: 0.13 } } as EditOp,
  { op: 'set_crop', clip_id: 'dup', crop: { l: 0, t: 0, r: 0, b: 0.13 } } as EditOp,
  { op: 'set_crop', clip_id: 'roto', crop: { l: 0, t: 0, r: 0, b: 0.13 } } as EditOp,
  // the roto matte rides BOTH car layers (his distortion layer is a
  // duplicate of the roto'd layer); the background stays clean footage
  { op: 'set_matte', clip_id: 'dup', matte_id: 'carMatte' } as EditOp,
  { op: 'set_matte', clip_id: 'roto', matte_id: 'carMatte' } as EditOp,
  { op: 'set_transform', clip_id: 'dup', transform: { x: tr0.x, y: tr0.y, scale: sInit, opacity: oInit } } as unknown as EditOp,
  { op: 'add_effect', clip_id: 'dup', type: FX, value: 1, params: AE_PARAMS } as EditOp,
  ...SAMPLE_TS.map((t) => {
    const [cx, cy, s, o] = sampleAt(t);
    const tr = toTransform(cx, cy, s);
    return {
      op: 'add_keyframe', clip_id: 'dup',
      keyframe: { t, x: tr.x, y: tr.y, scale: s, opacity: o, ease: 'easeInOut' },
    } as unknown as EditOp;
  }),
];

let project = buildEmptyProject({
  name: 'Turbulent displace v3 — Drabi tutorial recipe proof',
  w: 1080, h: 1920, fps: 30, ids: ['vbase', 'vaud', 'vtxt'],
});
project = applyEditOps(project, ops);
project = appendEditLog(project, {
  at: new Date().toISOString(), by: 'turbulent-proof harness v3',
  ops: ops.map((o) => String(o.op)), revision: null,
});

type ClipT = {
  id: string; crop?: Record<string, number>; matteId?: string;
  effects?: { type: string; value?: number; params?: Record<string, number> }[];
  keyframes?: { scale?: number; opacity?: number }[];
};
const tracks = (project as never as { tracks: { id: string; clips: ClipT[] }[] }).tracks;
const byTrack = (id: string) => tracks.find((t) => t.id === id)!.clips[0];
const base = byTrack('vbase'), dup = byTrack('vdup'), roto = byTrack('vroto');
check('MCP engine: three-layer sandwich built (background / distortion / roto)',
  !!base && !!dup && !!roto);
check('MCP engine: matte on distortion + roto layers only',
  dup.matteId === 'carMatte' && roto.matteId === 'carMatte' && base.matteId === undefined);
check('MCP engine: AE params carried verbatim (amount/size/complexity/pin/evolution_rate)',
  dup.effects?.[0]?.params?.amount === 171 && dup.effects?.[0]?.params?.size === 106 &&
  dup.effects?.[0]?.params?.complexity === 1.6 && dup.effects?.[0]?.params?.pin === 1 &&
  dup.effects?.[0]?.params?.evolution_rate === 150);
check('MCP engine: fx value is the plain master scale 1.0',
  dup.effects?.[0]?.value === 1);
check('MCP engine: watermark crop on all three clips',
  base.crop?.b === 0.13 && dup.crop?.b === 0.13 && roto.crop?.b === 0.13);
check(`MCP engine: ${SAMPLE_TS.length} sampled keyframes carry the pop`,
  (dup.keyframes ?? []).length === SAMPLE_TS.length,
  `got ${(dup.keyframes ?? []).length}`);
check('MCP engine: keyframes span 66% -> 84.4% -> collapse 24% / opacity 0',
  Math.abs((dup.keyframes ?? []).reduce((m, k) => Math.max(m, k.scale ?? 0), 0) - 0.844) < 0.01 &&
  (dup.keyframes ?? [])[(dup.keyframes ?? []).length - 1]?.opacity === 0);
check('MCP engine: clean roto layer carries NO effect (his top layer is clean)',
  (roto.effects ?? []).length === 0);

// ---- 2. Validation parity (Deno schema.ts + Python validator) -------------
const verdict = validateProject(project);
check('schema.ts validates the project clean', verdict.ok, verdict.errors.join('; '));
writeFileSync(`${outDir}/project_v3.json`, JSON.stringify(project, null, 1));
const pyOut = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'server')
from project_schema import validate_project
p = json.load(open('${outDir}/project_v3.json'))
errs = validate_project(p)
print('PYOK' if not errs else 'PYERR ' + '; '.join(str(e) for e in errs))
`], { cwd: process.cwd(), encoding: 'utf8' });
check('project_schema.py validates the project clean', pyOut.trim() === 'PYOK', pyOut.trim());

// ---- 3. Live-channel engine (editOps / applyOps) parity -------------------
const liveBase = buildEmptyProject({ name: 'live parity v3', ids: ['vbase', 'vaud', 'vtxt'] });
const liveSeeded = applyEditOps(liveBase, [
  { op: 'register_media', media: { id: 'car', src: 'car.mp4', kind: 'video', duration: 5.97, width: 1080, height: 1920 } } as EditOp,
  { op: 'register_media', media: { id: 'carMatte', src: 'car_matte.mp4', kind: 'matte', duration: 5.97, width: 540, height: 960 } } as EditOp,
  { op: 'add_clip', track_id: 'vbase', clip_id: 'c1', media_id: 'car', start: 0, in: 0, out: 2, muted: true } as EditOp,
]);
const liveOut = applyLiveOps(liveSeeded as never, [
  { op: 'set_matte', args: { clipId: 'c1', matteId: 'carMatte' } },
  { op: 'add_effect', args: { clipId: 'c1', type: FX, value: 1, params: AE_PARAMS } },
]) as never as { tracks: { clips: { matteId?: string; effects?: { type: string; params?: Record<string, number> }[] }[] }[] };
const liveClip = liveOut.tracks[0].clips[0];
check('live engine (editOps): set_matte lands', liveClip.matteId === 'carMatte');
check('live engine (editOps): AE params accepted verbatim',
  liveClip.effects?.[0]?.params?.amount === 171 && liveClip.effects?.[0]?.params?.pin === 1);

console.log(`\n${pass} passed, ${fail} failed — project at ${outDir}/project_v3.json`);
process.exit(fail ? 1 : 0);