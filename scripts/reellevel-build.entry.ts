/**
 * Reel-level rebuild (Phase 3) — the white GT film re-cut THROUGH the
 * J.12 grammar, built entirely with MCP ops:
 *  - blur-cut masked joins across the mid chain (hard cuts only in the
 *    flash open / close, mirroring the reference reel DXJ9RajCA7Z)
 *  - the headlight ignition split at the steepest luma step (source
 *    4.5625 s) with a blur-cut hiding the OFF->ON step
 *  - the user-directed BIGGER palindrome inside the headlight shot:
 *    entry on beat k7 (4.4353 s, grid 110.11 BPM / offset 0.621 s),
 *    rewind leg = 0.5832 s of source (35 frames @60) >= 30 frames,
 *    motion-blur effect riding every leg (0.55 / 1.0 / 1.0 by |speed|)
 *  - synthetic camera moves on the measured still / slow shots
 *  - one duration-exact speed swell (shot 10) as seasoning
 * Media = a motion-interpolated 60 fps master of white_gt_film_v10.mp4
 * (source is 48 fps; the deliverable standard is 60 fps with zero
 * duplicated frames). Audio = the film's own track, untouched.
 *
 * Run: npx vite build --ssr scripts/reellevel-build.entry.ts --outDir /tmp/reellevel-build
 *      node /tmp/reellevel-build/reellevel-build.entry.js [outDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateProject } from '../supabase/functions/cutlab-mcp/schema';
import {
  applyEditOps, appendEditLog, buildEmptyProject,
  type EditOp,
} from '../supabase/functions/cutlab-mcp/ops';

const outDir = process.argv[2] ?? '/tmp/reellevel-build';
mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

// ---- clip plan: [id, in, out, start, extra ops...] -------------------------
// Source seconds on the 60 fps master == v10 timeline seconds.
type Plan = {
  id: string; tin: number; tout: number; start: number;
  speed?: number; reversed?: boolean;
  trans?: { mode: string; dur: number; blur: number; dir?: string };
  move?: Record<string, unknown>;
  fx?: number; // motion-blur value
};
const BC = (mode: string, dur = 0.1, blur = 9, dir?: string) => ({ mode, dur, blur, dir });
const PLAN: Plan[] = [
  { id: 'c1', tin: 0, tout: 1.0833, start: 0, move: { kind: 'push-in', from: 1.05, to: 1.12, entry_blur: 0.9 } },
  { id: 'c2', tin: 1.0833, tout: 1.9167, start: 1.0833 },
  { id: 'c3', tin: 1.9167, tout: 2.75, start: 1.9167 },
  { id: 'c4', tin: 2.75, tout: 3.8333, start: 2.75, trans: BC('soft'), move: { kind: 'push-in', from: 1, to: 1.1 } },
  { id: 'c5a', tin: 3.8333, tout: 4.4353, start: 3.8333, trans: BC('whip', 0.13, 11, 'right') },
  { id: 'c5b1', tin: 4.4353, tout: 4.5625, start: 4.4353, speed: 1.5, fx: 0.55 },
  { id: 'c5b2', tin: 4.5625, tout: 4.8542, start: 4.5201, speed: 1.5, trans: BC('soft', 0.07, 10), fx: 0.55 },
  { id: 'c5c', tin: 4.271, tout: 4.8542, start: 4.7145, speed: 2.33, reversed: true, fx: 1 },
  { id: 'c5d', tin: 4.271, tout: 4.8542, start: 4.9648, speed: 2.62, fx: 1 },
  { id: 'c6', tin: 5.1875, tout: 6.0208, start: 5.1875, trans: BC('soft'), move: { kind: 'glide-left', from: 0, to: -32 } },
  { id: 'c7', tin: 6.0208, tout: 6.8542, start: 6.0208, trans: BC('zoom') },
  { id: 'c8', tin: 6.8542, tout: 7.6875, start: 6.8542, trans: BC('soft'), move: { kind: 'push-in', from: 1, to: 1.1 } },
  { id: 'c9', tin: 7.6875, tout: 8.5208, start: 7.6875, trans: BC('whip', 0.12, 10, 'right') },
  { id: 'c10a', tin: 8.5208, tout: 9.0208, start: 8.5208, speed: 0.85, trans: BC('soft') },
  { id: 'c10b', tin: 9.0208, tout: 9.6042, start: 9.109, speed: 1.178 },
  { id: 'c11', tin: 9.6042, tout: 10.4375, start: 9.6042, trans: BC('zoom') },
  { id: 'c12', tin: 10.4375, tout: 11.2708, start: 10.4375, trans: BC('soft'), move: { kind: 'glide-right', from: 0, to: 32 } },
  { id: 'c13', tin: 11.2708, tout: 12.1042, start: 11.2708, trans: BC('soft') },
  { id: 'c14', tin: 12.1042, tout: 12.4792, start: 12.1042, trans: BC('whip', 0.12, 10, 'right'), move: { kind: 'push-in', from: 1, to: 1.06 } },
  { id: 'c15', tin: 12.4792, tout: 13.0333, start: 12.4792, move: { kind: 'pull-out', from: 1.07, to: 1 } },
];

const ops: EditOp[] = [
  { op: 'register_media', media: { id: 'film', src: 'white_gt_film_v10_60.mp4', kind: 'video', duration: 13.0333, width: 1280, height: 720 } } as EditOp,
  { op: 'register_media', media: { id: 'track', src: 'porsche_reel_audio.wav', kind: 'audio', duration: 13.0625 } } as EditOp,
  { op: 'add_clip', track_id: 'vaud', clip_id: 'audio', media_id: 'track', start: 0, in: 0, out: 13.0333 } as EditOp,
];
for (const c of PLAN) {
  ops.push({ op: 'add_clip', track_id: 'vbase', clip_id: c.id, media_id: 'film', start: c.start, in: c.tin, out: c.tout, muted: true } as EditOp);
  if (c.speed !== undefined || c.reversed) {
    const t: Record<string, unknown> = { op: 'set_clip_timing', clip_id: c.id };
    if (c.speed !== undefined) t.speed = c.speed;
    if (c.reversed) t.reversed = true;
    ops.push(t as unknown as EditOp);
  }
  if (c.trans) {
    ops.push({
      op: 'set_transition', clip_id: c.id, transitionIn: 'blur-cut',
      transitionMode: c.trans.mode, transitionDur: c.trans.dur, transitionBlur: c.trans.blur,
      ...(c.trans.dir ? { transitionDir: c.trans.dir } : {}),
    } as unknown as EditOp);
  }
  if (c.move) ops.push({ op: 'add_camera_move', clip_id: c.id, ...c.move } as unknown as EditOp);
  if (c.fx !== undefined) ops.push({ op: 'add_effect', clip_id: c.id, type: 'motion-blur', value: c.fx } as unknown as EditOp);
}

let project = buildEmptyProject({
  name: 'White GT — reel-level rebuild (J.12 grammar)',
  w: 1280, h: 720, fps: 60, ids: ['vbase', 'vaud', 'vtxt'],
});
project = applyEditOps(project, ops);
project = appendEditLog(project, {
  at: new Date().toISOString(), by: 'reellevel-build harness',
  ops: ops.map((o) => String(o.op)), revision: null,
});

type ClipT = {
  id: string; start: number; transitionIn?: string; reversed?: boolean; speed?: number;
  effects?: { type: string; value: number }[]; keyframes?: unknown[];
};
const tracks = (project as never as { tracks: { id: string; clips: ClipT[] }[] }).tracks;
const clips = tracks.find((t) => t.id === 'vbase')!.clips;
const byId = new Map(clips.map((c) => [c.id, c]));
check('20 clips on the film track', clips.length === 20, `got ${clips.length}`);
check('12 blur-cut joins (11 mid-chain + ignition)',
  clips.filter((c) => c.transitionIn === 'blur-cut').length === 12,
  `got ${clips.filter((c) => c.transitionIn === 'blur-cut').length}`);
check('palindrome rewind leg reversed @2.33x',
  byId.get('c5c')!.reversed === true && byId.get('c5c')!.speed === 2.33);
check('motion-blur rides all three palindrome legs',
  ['c5b1', 'c5b2', 'c5c', 'c5d'].every((id) =>
    (byId.get(id)!.effects ?? []).some((e) => e.type === 'motion-blur' && e.value > 0)));
check('camera moves written on 7 clips',
  ['c1', 'c4', 'c6', 'c8', 'c12', 'c14', 'c15'].every((id) => (byId.get(id)!.keyframes ?? []).length >= 2));
check('audio clip present at full length',
  tracks.find((t) => t.id === 'vaud')!.clips.length === 1);

const verdict = validateProject(project);
check('schema.ts validates clean', verdict.ok, verdict.errors.join('; '));
writeFileSync(`${outDir}/project_reellevel.json`, JSON.stringify(project, null, 1));
const pyOut = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'server')
from project_schema import validate_project
p = json.load(open('${outDir}/project_reellevel.json'))
errs = validate_project(p)
print('PYOK' if not errs else 'PYERR ' + '; '.join(str(e) for e in errs))
`], { cwd: process.cwd(), encoding: 'utf8' });
check('project_schema.py validates clean', pyOut.trim() === 'PYOK', pyOut.trim());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
