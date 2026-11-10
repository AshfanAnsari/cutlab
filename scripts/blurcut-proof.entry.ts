/**
 * Blur-cut + camera-move proof (J.12) — builds a two-clip project through
 * the MCP pure-op engine: clip A carries a synthetic camera move (push-in
 * with an entry-blur settle, written by the add_camera_move op), clip B
 * enters through a blur-cut (whip) — the blur-masked join whose blur peaks
 * AT the boundary on both sides in Lane B. A control project (same clips,
 * no ops) is written alongside for the hard-cut comparison.
 *
 * Cross-checks: schema.ts + server/project_schema.py validation parity,
 * and the live-channel engine (editOps) accepting the same ops.
 * Rendering + measurement happen outside (render.py + a metrics pass);
 * see ~/workspace/cutlab-filmcraft-parity/blur-cut-proof/PROOF.md.
 *
 * Run: npx vite build --ssr scripts/blurcut-proof.entry.ts --outDir /tmp/blurcut-proof
 *      node /tmp/blurcut-proof/blurcut-proof.entry.js [outDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { validateProject } from '../supabase/functions/cutlab-mcp/schema';
import {
  applyEditOps, appendEditLog, buildEmptyProject,
  type EditOp, type Project,
} from '../supabase/functions/cutlab-mcp/ops';
import { applyEditOps as applyLiveOps } from '../src/services/editOps';

const outDir = process.argv[2] ?? '/tmp/blurcut-proof';
mkdirSync(outDir, { recursive: true });

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

const seed: EditOp[] = [
  { op: 'register_media', media: { id: 'mA', src: 'P2_two_hands_hair.mp4', kind: 'video', duration: 2.68, width: 720, height: 1280 } } as EditOp,
  { op: 'register_media', media: { id: 'mB', src: 'P5_headtilt_close.mp4', kind: 'video', duration: 2.4, width: 720, height: 1280 } } as EditOp,
  { op: 'add_clip', track_id: 'vbase', clip_id: 'clipA', media_id: 'mA', start: 0, in: 0, out: 2.4, muted: true } as EditOp,
  { op: 'add_clip', track_id: 'vbase', clip_id: 'clipB', media_id: 'mB', start: 2.4, in: 0, out: 2.4, muted: true } as EditOp,
];

const grammar: EditOp[] = [
  { op: 'add_camera_move', clip_id: 'clipA', kind: 'push-in', from: 1, to: 1.12, ease: 'easeInOut', entry_blur: 0.8 } as unknown as EditOp,
  { op: 'set_transition', clip_id: 'clipB', transitionIn: 'blur-cut', transitionMode: 'whip', transitionDir: 'right', transitionDur: 0.15, transitionBlur: 10 } as unknown as EditOp,
];

let project = buildEmptyProject({
  name: 'Blur-cut + camera move proof (J.12)',
  w: 720, h: 1280, fps: 30, ids: ['vbase', 'vaud', 'vtxt'],
});
project = applyEditOps(project, [...seed, ...grammar]);
project = appendEditLog(project, {
  at: new Date().toISOString(), by: 'blurcut-proof harness',
  ops: [...seed, ...grammar].map((o) => String(o.op)), revision: null,
});

let control = buildEmptyProject({
  name: 'Blur-cut control (hard cut, no move)',
  w: 720, h: 1280, fps: 30, ids: ['vbase', 'vaud', 'vtxt'],
});
control = applyEditOps(control, seed);

type ClipT = {
  id: string; transitionIn?: string; transitionMode?: string; transitionBlur?: number;
  transitionDur?: number; effects?: { type: string; value: number }[];
  keyframes?: { t: number; scale?: number; fx?: Record<string, number> }[];
};
const tracks = (project as never as { tracks: { id: string; clips: ClipT[] }[] }).tracks;
const vtrack = tracks.find((t) => t.id === 'vbase')!;
const clipA = vtrack.clips.find((c) => c.id === 'clipA')!;
const clipB = vtrack.clips.find((c) => c.id === 'clipB')!;

check('MCP engine: blur-cut landed on clip B', clipB.transitionIn === 'blur-cut');
check('MCP engine: blur-cut params (whip / sigma 10 / dur 0.15)',
  clipB.transitionMode === 'whip' && clipB.transitionBlur === 10 && clipB.transitionDur === 0.15);
check('MCP engine: camera move wrote scale keyframes 1 -> 1.12',
  (clipA.keyframes ?? []).some((k) => k.scale === 1) && (clipA.keyframes ?? []).some((k) => k.scale === 1.12));
check('MCP engine: entry blur effect + fx ride peak -> 0',
  (clipA.effects ?? []).some((e) => e.type === 'blur' && Math.abs(e.value - 0.96) < 1e-6) &&
  (clipA.keyframes ?? []).some((k) => (k.fx?.blur ?? -1) === 0));

const verdict = validateProject(project);
check('schema.ts validates the project clean', verdict.ok, verdict.errors.join('; '));
writeFileSync(`${outDir}/project_blurcut.json`, JSON.stringify(project, null, 1));
writeFileSync(`${outDir}/project_control.json`, JSON.stringify(control, null, 1));
const pyOut = execFileSync('python3', ['-c', `
import json, sys
sys.path.insert(0, 'server')
from project_schema import validate_project
p = json.load(open('${outDir}/project_blurcut.json'))
errs = validate_project(p)
print('PYOK' if not errs else 'PYERR ' + '; '.join(str(e) for e in errs))
`], { cwd: process.cwd(), encoding: 'utf8' });
check('project_schema.py validates the project clean', pyOut.trim() === 'PYOK', pyOut.trim());

// ---- live-channel engine (editOps) parity --------------------------------
const liveSeeded = applyEditOps(buildEmptyProject({ name: 'live parity', ids: ['vbase', 'vaud', 'vtxt'] }), seed);
const liveOut = applyLiveOps(liveSeeded as never, [
  { op: 'add_camera_move', args: { clipId: 'clipA', kind: 'push-in', from: 1, to: 1.12, entryBlur: 0.8 } },
  { op: 'set_transition', args: { clipId: 'clipB', transitionIn: 'blur-cut', transitionBlur: 10, transitionMode: 'whip', transitionDir: 'right', transitionDur: 0.15 } },
]) as never as { tracks: { clips: ClipT[] }[] };
const liveA = liveOut.tracks[0].clips.find((c) => c.id === 'clipA')!;
const liveB = liveOut.tracks[0].clips.find((c) => c.id === 'clipB')!;
check('live engine (editOps): add_camera_move accepted + keyframes written',
  (liveA.keyframes ?? []).some((k) => k.scale === 1.12) &&
  (liveA.effects ?? []).some((e) => e.type === 'blur'));
check('live engine (editOps): set_transition accepts blur-cut + params',
  liveB.transitionIn === 'blur-cut' && liveB.transitionMode === 'whip' && liveB.transitionBlur === 10);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
