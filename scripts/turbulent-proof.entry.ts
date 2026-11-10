/**
 * Turbulent-displace proof v2 — rebuilds the bubble-hook sandwich WITH
 * MOTION through the MCP pure-op engine: base car clip + a duplicate
 * layer that RISES out of the roofline while scaling up, carrying the
 * 'turbulent-displace' effect (v2 semantics: smooth low-frequency field,
 * ^1.35 amount curve, `falloff` vertical strength fade) with the amount
 * riding 0 -> peak -> 0. Both clips crop the bottom 13% of the source —
 * the generator sparkle watermark sits at ~(0.84, 0.91) of the frame
 * and the car ends at ~0.68, so the crop removes the watermark and
 * keeps the car whole.
 *
 * The envelope is defined by control points and sampled every 0.15 s
 * (smoothstep between points) into full keyframes {x, y, scale,
 * opacity, fx, mask} — dense samples because Lane B steps scale/fx per
 * sub-segment (only x/y are interpolated by the composite). The mask
 * ellipse is recomputed per sample from the duplicate's on-canvas car
 * footprint so it travels with the rising clone.
 *
 * Cross-checks the live-channel engine (editOps) accepts the effect +
 * falloff param + fx keyframes, validates the document with schema.ts
 * AND server/project_schema.py (parity), and writes project_v2.json
 * for render-lane-b/render.py.
 *
 * Run: npx vite build --ssr scripts/turbulent-proof.entry.ts --outDir /tmp/turb-proof
 *      node /tmp/turb-proof/turbulent-proof.entry.js [outDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateProject } from '../supabase/functions/cutlab-mcp/schema';
import {
  applyEditOps, appendEditLog, buildEmptyProject,
  type EditOp, type Project,
} from '../supabase/functions/cutlab-mcp/ops';
import { applyEditOps as applyLiveOps } from '../src/services/editOps';

const outDir = process.argv[2] ?? '/tmp/turbulent-proof';
mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ---- envelope: control points -> 0.15 s samples ---------------------------
// Canvas 720x1280. Source car: centre fraction (0.50, 0.48), vertical
// span 0.28..0.68, horizontal span 0.03..0.97. A frame point (fx, fy)
// lands at canvas (360 + x + (fx-.5)*720*s, 640 + y + (fy-.5)*1280*s).
const FX = 'turbulent-displace';
// [t, scale, yOffset, fxAmount, opacity]
const CTRL: [number, number, number, number, number][] = [
  [0.00, 0.30, -232, 0.00, 0],
  [0.20, 0.335, -250, 0.35, 1],
  [0.45, 0.42, -288, 0.85, 1],
  [0.80, 0.52, -327, 0.55, 1],
  [1.30, 0.50, -316, 0.90, 1],
  [1.70, 0.40, -288, 0.30, 0.55],
  [2.15, 0.33, -258, 0.00, 0],
];
const smooth = (a: number, b: number, f: number) => {
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
};
function sampleAt(t: number): [number, number, number, number] {
  for (let i = 1; i < CTRL.length; i++) {
    if (t <= CTRL[i][0]) {
      const [t0, s0, y0, f0, o0] = CTRL[i - 1];
      const [t1, s1, y1, f1, o1] = CTRL[i];
      const f = (t - t0) / (t1 - t0);
      return [smooth(s0, s1, f), smooth(y0, y1, f), smooth(f0, f1, f), smooth(o0, o1, f)];
    }
  }
  const [, s, y, fx, o] = CTRL[CTRL.length - 1];
  return [s, y, fx, o];
}
function maskFor(scale: number, yOff: number) {
  const carCy = 640 + yOff - 25.6 * scale; // car centre fy=0.48
  const w = 778 * scale;                   // car width 0.94*720*s + margin
  const h = 691 * scale;                   // car height 0.40*1280*s + margin
  return {
    x: (360 - w / 2) / 720,
    y: (carCy - h / 2) / 1280,
    w: w / 720,
    h: h / 1280,
  };
}
const SAMPLE_TS: number[] = [];
for (let t = 0.15; t < 2.15; t += 0.15) SAMPLE_TS.push(Math.round(t * 100) / 100);
SAMPLE_TS.push(2.15);

// ---- 1. Build the sandwich through the MCP op engine ----------------------
const [s0, y0] = sampleAt(0);
const ops: EditOp[] = [
  { op: 'register_media', media: { id: 'car', src: 'car.mp4', kind: 'video', duration: 5.97, width: 1080, height: 1920 } } as EditOp,
  { op: 'add_track', track_id: 'vdup', kind: 'video' } as EditOp,
  { op: 'add_clip', track_id: 'vbase', clip_id: 'base', media_id: 'car', start: 0, in: 0.5, out: 2.9, muted: true } as EditOp,
  { op: 'add_clip', track_id: 'vdup', clip_id: 'dup', media_id: 'car', start: 0, in: 0.5, out: 2.9, muted: true } as EditOp,
  // crop away the watermark strip (bottom 13%) on BOTH clips
  { op: 'set_crop', clip_id: 'base', crop: { l: 0, t: 0, r: 0, b: 0.13 } } as EditOp,
  { op: 'set_crop', clip_id: 'dup', crop: { l: 0, t: 0, r: 0, b: 0.13 } } as EditOp,
  // duplicate starts tucked at the roofline, small and invisible
  { op: 'set_transform', clip_id: 'dup', transform: { x: 0, y: y0, scale: s0, opacity: 0 } } as unknown as EditOp,
  { op: 'set_mask', clip_id: 'dup', mask: { shape: 'circle', ...maskFor(s0, y0), feather: 0.09, invert: false } } as EditOp,
  { op: 'add_effect', clip_id: 'dup', type: FX, value: 0, params: { scale: 0.35, seed: 3, evolution: 0.35, falloff: 0.85 } } as EditOp,
  ...SAMPLE_TS.map((t) => {
    const [s, y, fx, o] = sampleAt(t);
    return {
      op: 'add_keyframe', clip_id: 'dup',
      keyframe: { t, x: 0, y, scale: s, opacity: o, fx: { [FX]: fx }, mask: maskFor(s, y), ease: 'easeInOut' },
    } as unknown as EditOp;
  }),
];

let project = buildEmptyProject({
  name: 'Turbulent displace v2 — bubble hook proof (motion)',
  w: 720, h: 1280, fps: 30, ids: ['vbase', 'vaud', 'vtxt'],
});
project = applyEditOps(project, ops);
project = appendEditLog(project, {
  at: new Date().toISOString(), by: 'turbulent-proof harness v2',
  ops: ops.map((o) => String(o.op)), revision: null,
});

type ClipT = {
  id: string; crop?: Record<string, number>;
  effects?: { type: string; params?: Record<string, number> }[];
  keyframes?: { fx?: Record<string, number>; mask?: unknown; scale?: number }[];
};
const tracks = (project as never as { tracks: { id: string; clips: ClipT[] }[] }).tracks;
const dup = tracks.find((t) => t.id === 'vdup')!.clips[0];
const base = tracks.find((t) => t.id === 'vbase')!.clips[0];
check('MCP engine: effect landed on the duplicate layer', dup.effects?.some((e) => e.type === FX) ?? false);
check('MCP engine: params carried (scale/seed/evolution/falloff)',
  dup.effects?.[0]?.params?.scale === 0.35 && dup.effects?.[0]?.params?.seed === 3 &&
  dup.effects?.[0]?.params?.evolution === 0.35 && dup.effects?.[0]?.params?.falloff === 0.85);
check('MCP engine: watermark crop on both clips',
  base.crop?.b === 0.13 && dup.crop?.b === 0.13);
check(`MCP engine: ${SAMPLE_TS.length} sampled keyframes on the envelope`,
  (dup.keyframes ?? []).length === SAMPLE_TS.length,
  `got ${(dup.keyframes ?? []).length}`);
check('MCP engine: keyframes carry fx + mask + scale (motion sandwich)',
  (dup.keyframes ?? []).every((k) => k.fx && FX in k.fx && !!k.mask && typeof k.scale === 'number'));
check('MCP engine: editLog recorded the batch', Array.isArray(project.editLog) && project.editLog.length === 1);

// ---- 2. Validation parity (Deno schema.ts + Python validator) -------------
const verdict = validateProject(project);
check('schema.ts validates the project clean', verdict.ok, verdict.errors.join('; '));
writeFileSync(`${outDir}/project_v2.json`, JSON.stringify(project, null, 1));
const pyOut = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'server')
from project_schema import validate_project
p = json.load(open('${outDir}/project_v2.json'))
errs = validate_project(p)
print('PYOK' if not errs else 'PYERR ' + '; '.join(str(e) for e in errs))
`], { cwd: process.cwd(), encoding: 'utf8' });
check('project_schema.py validates the project clean', pyOut.trim() === 'PYOK', pyOut.trim());

// ---- 3. Live-channel engine (editOps / applyOps) parity --------------------
const liveBase = buildEmptyProject({ name: 'live parity', ids: ['vbase', 'vaud', 'vtxt'] });
const liveSeeded = applyEditOps(liveBase, [
  { op: 'register_media', media: { id: 'car', src: 'car.mp4', kind: 'video', duration: 5.97, width: 1080, height: 1920 } } as EditOp,
  { op: 'add_clip', track_id: 'vbase', clip_id: 'c1', media_id: 'car', start: 0, in: 0, out: 2, muted: true } as EditOp,
]);
const liveOut = applyLiveOps(liveSeeded as never, [
  { op: 'add_effect', args: { clipId: 'c1', type: FX, value: 0.8, params: { scale: 0.5, seed: 1, evolution: 0.35, falloff: 0.85 } } },
  { op: 'add_keyframe', args: { clipId: 'c1', t: 0.5, fx: { [FX]: 1 } } },
  { op: 'update_effect', args: { clipId: 'c1', type: FX, params: { falloff: 0 } } },
]) as never as { tracks: { clips: { effects?: { type: string; params?: Record<string, number> }[]; keyframes?: { fx?: Record<string, number> }[] }[] }[] };
const liveClip = liveOut.tracks[0].clips[0];
check('live engine (editOps): add_effect accepts turbulent-displace',
  liveClip.effects?.some((e) => e.type === FX) ?? false);
check('live engine (editOps): fx keyframe + update_effect falloff merge',
  (liveClip.keyframes ?? []).some((k) => k.fx?.[FX] === 1) && liveClip.effects?.[0]?.params?.falloff === 0);

console.log(`\n${pass} passed, ${fail} failed — project at ${outDir}/project_v2.json`);
process.exit(fail ? 1 : 0);
