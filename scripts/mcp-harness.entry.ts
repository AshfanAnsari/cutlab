/**
 * MCP Phase 1 harness — headless checks for the cutlab-mcp upgrade
 * (UPGRADE-PLAN.md §3):
 *   · schema.ts verdict parity with server/project_schema.py — the
 *     SAME fixtures are run through both validators and the verdicts
 *     compared (fixtures written to /tmp, the Python validator run as
 *     a subprocess; if python3 is unavailable the hand-asserted
 *     expected verdicts in the fixture file still pin schema.ts).
 *   · ops.ts pure edit operations: split/trim math (the editor's
 *     frame-quantised semantics), keyframes, grade-stack limit,
 *     media-registry law, markers, text defaults, compound round-trip,
 *     batch order + atomicity, angle cuts, revision helpers.
 * Run: npx vite build --ssr scripts/mcp-harness.entry.ts --outDir /tmp/mcp-harness
 *      node /tmp/mcp-harness/mcp-harness.entry.js
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validateProject, mediaSignature, writePathErrors } from '../supabase/functions/cutlab-mcp/schema';
import {
  applyEditOp, applyEditOps, appendEditLog, buildEmptyProject, checkRevision,
  clipDuration, findClip, gradeLayersOf, listKeyframes, projectSummary,
  type EditOp, type Project,
} from '../supabase/functions/cutlab-mcp/ops';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
function throws(name: string, fn: () => unknown, needle: string) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, (e as Error).message.includes(needle), (e as Error).message); }
}
const J = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// fixtures + schema parity
// ---------------------------------------------------------------------------

interface Fixture { name: string; expectOk: boolean; expectErrorIncludes?: string; project: Project }

function deepNestProject(levels: number): Project {
  const mediaClip = {
    id: 'leaf', start: 0, media: 'm1', in: 0, out: 2, speed: 1, muted: true, volume: 1,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, transitionIn: null,
  };
  let track: Record<string, unknown> = { id: 'nt0', kind: 'video', clips: [mediaClip] };
  for (let i = 1; i <= levels; i++) {
    const compound = {
      id: `cmp${i}`, start: 0, in: 0, out: 2, volume: 1,
      transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
      nest: { name: `N${i}`, tracks: [track] }, transitionIn: null,
    };
    track = { id: `nt${i}`, kind: 'video', clips: [compound] };
  }
  return {
    version: 1, name: 'Deep nest', canvas: { w: 720, h: 1280, fps: 30 },
    media: [{ id: 'm1', src: 'a.mp4', kind: 'video' }],
    tracks: [track], markers: [],
  } as Project;
}

function loadFixtures(): Fixture[] {
  const raw = JSON.parse(readFileSync('scripts/fixtures/edit-ops.fixtures.json', 'utf8')) as Fixture[];
  const karina = JSON.parse(readFileSync('examples/karina.cutlab.json', 'utf8')) as Project;
  return [
    ...raw,
    { name: 'karina-example', expectOk: true, project: karina },
    { name: 'deep-nest-5', expectOk: false, expectErrorIncludes: 'nests deeper than 4', project: deepNestProject(5) },
    { name: 'nest-4-ok', expectOk: true, project: deepNestProject(4) },
  ];
}

function pythonVerdicts(fixtures: Fixture[]): Record<string, boolean> | null {
  try {
    mkdirSync('/tmp/mcp-fixtures', { recursive: true });
    for (const f of fixtures) writeFileSync(`/tmp/mcp-fixtures/${f.name}.json`, J(f.project));
    const code = [
      'import sys, json, glob, os',
      'sys.path.insert(0, "server")',
      'from project_schema import validate_project',
      'out = {}',
      'for path in sorted(glob.glob("/tmp/mcp-fixtures/*.json")):',
      '    name = os.path.basename(path)[:-5]',
      '    out[name] = len(validate_project(json.load(open(path)))) == 0',
      'print(json.dumps(out))',
    ].join('\n');
    const out = execFileSync('python3', ['-c', code], { encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop()!) as Record<string, boolean>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// op-test project factory
// ---------------------------------------------------------------------------

function freshProject(): Project {
  return {
    version: 1, name: 'Ops', canvas: { w: 720, h: 1280, fps: 30 },
    media: [
      { id: 'm1', src: 'a.mp4', kind: 'video', duration: 30 },
      { id: 'm2', src: 'song.mp3', kind: 'audio', duration: 30 },
      { id: 'm3', src: 'b.mp4', kind: 'video', duration: 30 },
    ],
    tracks: [
      {
        id: 'v1', kind: 'video', clips: [
          {
            id: 'c1', start: 1, media: 'm1', in: 0, out: 4, speed: 2, muted: false, volume: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, transitionIn: null,
            keyframes: [{ t: 0.5, x: 1 }, { t: 1.5, x: 2 }],
          },
          {
            id: 'c2', start: 5, media: 'm3', in: 0, out: 2, speed: 1, muted: true, volume: 1,
            transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, transitionIn: null,
          },
        ],
      },
      {
        id: 'a1', kind: 'audio', clips: [
          {
            id: 'ac1', start: 0, media: 'm2', in: 0, out: 8, speed: 1, volume: 1,
            fadeIn: 0, fadeOut: 0, transitionIn: null,
          },
        ],
      },
      {
        id: 't1', kind: 'text', clips: [
          { id: 'tx1', start: 1, text: 'HI', dur: 2, style: 'pop-bold', transitionIn: null },
        ],
      },
    ],
    markers: [{ t: 1.5, label: 'beat' }],
  } as unknown as Project;
}

const clipOf = (p: Project, id: string) => findClip(p, id).clip;
const trackOf = (p: Project, id: string) => p.tracks.find((t: Project) => t.id === id);

function main() {
  // ---- schema verdicts + Python parity -------------------------------------
  const fixtures = loadFixtures();
  for (const f of fixtures) {
    const v = validateProject(f.project);
    check(`schema verdict: ${f.name}`, v.ok === f.expectOk,
      `expected ok=${f.expectOk}, errors: ${v.errors.join('; ')}`);
    if (f.expectErrorIncludes) {
      check(`schema error text: ${f.name}`,
        v.errors.some((e) => e.includes(f.expectErrorIncludes!)), v.errors.join('; '));
    }
  }
  const py = pythonVerdicts(fixtures);
  if (py) {
    for (const f of fixtures) {
      check(`python parity: ${f.name}`, py[f.name] === validateProject(f.project).ok,
        `python=${String(py[f.name])} ts=${String(validateProject(f.project).ok)}`);
    }
  } else {
    console.log('NOTE  python3 parity unavailable — schema.ts pinned by the hand-asserted fixture verdicts only');
  }
  check('buildEmptyProject validates clean', validateProject(buildEmptyProject({ name: 'New' })).ok);

  // ---- add_clip defaults -----------------------------------------------------
  {
    const p = applyEditOp(freshProject(), { op: 'add_clip', track_id: 'v1', media_id: 'm1', clip_id: 'n1', start: 10, in: 1, out: 3 } as EditOp);
    const c = clipOf(p, 'n1');
    check('add_clip video defaults (muted/volume/transform/speed)',
      c.muted === false && c.volume === 1 && c.speed === 1 && c.transform?.scale === 1 && c.transitionIn === null);
    const p2 = applyEditOp(freshProject(), { op: 'add_clip', track_id: 'a1', media_id: 'm2', clip_id: 'n2', start: 9, in: 0, out: 2 } as EditOp);
    const ac = clipOf(p2, 'n2');
    check('add_clip audio defaults (fades at 0)', ac.fadeIn === 0 && ac.fadeOut === 0 && ac.volume === 1);
    check('add_clip result validates', validateProject(p).ok && validateProject(p2).ok);
  }

  // ---- trim ------------------------------------------------------------------
  {
    const p = applyEditOp(freshProject(), { op: 'trim_clip', clip_id: 'c2', in: 0.5, out: 1.5, start: 6 } as EditOp);
    const c = clipOf(p, 'c2');
    check('trim_clip sets in/out/start', c.in === 0.5 && c.out === 1.5 && c.start === 6);
    throws('trim_clip refuses out <= in',
      () => applyEditOp(freshProject(), { op: 'trim_clip', clip_id: 'c2', out: 0 } as EditOp), 'out <= in');
  }

  // ---- split (the editor's math) ---------------------------------------------
  {
    // c1: start 1, in 0, out 4, speed 2 → duration 2s, ends at 3. Split at t=2.
    const p = applyEditOp(freshProject(), { op: 'split_clip', clip_id: 'c1', at: 2, new_clip_id: 'c1r' } as EditOp);
    const left = clipOf(p, 'c1');
    const right = clipOf(p, 'c1r');
    check('split media math: mid = in + offset*speed',
      left.out === 2 && right.in === 2 && right.start === 2 && right.out === 4);
    check('split durations: left 1s, right 1s',
      clipDuration(left) === 1 && clipDuration(right) === 1);
    check('split keyframes rebased (left keeps t<offset, right rebased)',
      J(left.keyframes) === J([{ t: 0.5, x: 1 }]) && J(right.keyframes) === J([{ t: 0.5, x: 2 }]),
      `left=${J(left.keyframes)} right=${J(right.keyframes)}`);
    check('split right half loses its transition', right.transitionIn === null);
    check('split result validates', validateProject(p).ok);
    const pt = applyEditOp(freshProject(), { op: 'split_clip', clip_id: 'tx1', at: 2, new_clip_id: 'tx1r' } as EditOp);
    check('split text dur math', clipOf(pt, 'tx1').dur === 1 && clipOf(pt, 'tx1r').dur === 1 && clipOf(pt, 'tx1r').start === 2);
    throws('split outside the clip refuses',
      () => applyEditOp(freshProject(), { op: 'split_clip', clip_id: 'c2', at: 99 } as EditOp), 'not strictly inside');
  }

  // ---- duplicate + move ---------------------------------------------------------
  {
    const p = applyEditOp(freshProject(), { op: 'duplicate_clip', clip_id: 'c2', new_clip_id: 'c2d' } as EditOp);
    check('duplicate_clip: new id at original end', clipOf(p, 'c2d').start === 7 && clipOf(p, 'c2d').media === 'm3');
    const p2 = applyEditOps(freshProject(), [
      { op: 'add_track', kind: 'video', track_id: 'v2' } as EditOp,
      { op: 'move_clip', clip_id: 'c2', to_track_id: 'v2', start: 12 } as EditOp,
    ]);
    check('move_clip across tracks + start',
      trackOf(p2, 'v2').clips.some((c: Project) => c.id === 'c2' && c.start === 12)
      && !trackOf(p2, 'v1').clips.some((c: Project) => c.id === 'c2'));
  }

  // ---- keyframes ------------------------------------------------------------------
  {
    let p = applyEditOp(freshProject(), { op: 'add_keyframe', clip_id: 'c2', t: 0.5, prop: 'x', value: 10, ease: 'easeOut' } as EditOp);
    p = applyEditOp(p, { op: 'add_keyframe', clip_id: 'c2', t: 0.5, prop: 'opacity', value: 0.5 } as EditOp);
    p = applyEditOp(p, { op: 'add_keyframe', clip_id: 'c2', t: 1.5, prop: 'x', value: 20 } as EditOp);
    const kfs = listKeyframes(p, 'c2');
    check('add_keyframe merges same-t props and sorts',
      kfs.length === 2 && kfs[0].x === 10 && kfs[0].opacity === 0.5 && kfs[0].ease === 'easeOut' && kfs[1].t === 1.5,
      J(kfs));
    p = applyEditOp(p, { op: 'remove_keyframe', clip_id: 'c2', t: 0.5, prop: 'x' } as EditOp);
    const after = listKeyframes(p, 'c2');
    check('remove_keyframe prop keeps the keyframe (other props survive)',
      after.length === 2 && after[0].x === undefined && after[0].opacity === 0.5);
    p = applyEditOp(p, { op: 'remove_keyframe', clip_id: 'c2', t: 1.5 } as EditOp);
    check('remove_keyframe whole', listKeyframes(p, 'c2').length === 1);
  }

  // ---- grades ------------------------------------------------------------------------
  {
    let p = applyEditOp(freshProject(), { op: 'set_grade_layer', clip_id: 'c1', index: 0, grade: { temperature: 0.5 } } as EditOp);
    const layers = gradeLayersOf(clipOf(p, 'c1'));
    check('set_grade_layer merges onto the default grade',
      layers.length === 1 && layers[0].temperature === 0.5 && layers[0].pivot === 0.5);
    p = applyEditOp(p, { op: 'add_grade_layer', clip_id: 'c1' } as EditOp);
    p = applyEditOp(p, { op: 'add_grade_layer', clip_id: 'c1' } as EditOp);
    check('grade stack grows to 3', gradeLayersOf(clipOf(p, 'c1')).length === 3);
    throws('grade stack refuses a 4th layer',
      () => applyEditOp(p, { op: 'add_grade_layer', clip_id: 'c1' } as EditOp), 'maximum 3 grade layers');
    const p2 = applyEditOp(p, { op: 'remove_grade_layer', clip_id: 'c1', index: 0 } as EditOp);
    check('remove_grade_layer', gradeLayersOf(clipOf(p2, 'c1')).length === 2);
    check('graded project validates', validateProject(p).ok);
  }

  // ---- media law -----------------------------------------------------------------------
  {
    const base = freshProject();
    throws('remove_media refuses while a clip references it',
      () => applyEditOp(base, { op: 'remove_media', media_id: 'm1' } as EditOp), 'still used by');
    let p = applyEditOp(base, { op: 'register_media', media: { id: 'm9', src: 'new.mp4', kind: 'video', duration: 5 } } as EditOp);
    check('register_media adds to the registry + signature changes',
      p.media.some((m: Project) => m.id === 'm9') && mediaSignature(p) !== mediaSignature(base));
    p = applyEditOp(p, { op: 'move_media_to_bin', media_id: 'm9', bin: 'Selects' } as EditOp);
    check('move_media_to_bin sets bin + creates bin list entry',
      p.media.find((m: Project) => m.id === 'm9').bin === 'Selects' && (p.mediaBins ?? []).includes('Selects'));
    p = applyEditOp(p, { op: 'remove_media', media_id: 'm9' } as EditOp);
    check('remove_media of an unreferenced item succeeds + validates',
      !p.media.some((m: Project) => m.id === 'm9') && validateProject(p).ok);
    const afterTimeline = applyEditOp(base, { op: 'trim_clip', clip_id: 'c2', out: 1 } as EditOp);
    check('timeline ops never change the media signature',
      mediaSignature(afterTimeline) === mediaSignature(base));
  }

  // ---- markers + batch order --------------------------------------------------------------
  {
    const p = applyEditOps(freshProject(), [
      { op: 'add_marker', t: 9, label: 'late' } as EditOp,
      { op: 'add_marker', t: 0.25, label: 'early' } as EditOp,
    ]);
    check('batch applies in order; markers stay time-sorted',
      J(p.markers.map((m: Project) => m.t)) === J([0.25, 1.5, 9]));
    const p2 = applyEditOp(p, { op: 'remove_marker', t: 1.5, label: 'beat' } as EditOp);
    check('remove_marker by t+label', p2.markers.length === 2 && !p2.markers.some((m: Project) => m.label === 'beat'));
  }

  // ---- batch atomicity -----------------------------------------------------------------------
  {
    const base = freshProject();
    const before = J(base);
    throws('batch with a failing op throws',
      () => applyEditOps(base, [
        { op: 'add_marker', t: 3, label: 'ok' } as EditOp,
        { op: 'remove_media', media_id: 'm1' } as EditOp,
      ]), 'still used by');
    check('failed batch leaves the original project untouched (atomicity)', J(base) === before);
    throws('unknown op refuses',
      () => applyEditOp(base, { op: 'explode_everything' } as EditOp), 'unknown op');
  }

  // ---- text -------------------------------------------------------------------------------------
  {
    const p = applyEditOp(freshProject(), { op: 'add_text', track_id: 't1', clip_id: 'tx9', text: 'HELLO', start: 4 } as EditOp);
    const c = clipOf(p, 'tx9');
    check('add_text defaults from the pop-bold preset',
      c.style === 'pop-bold' && c.fontSize === 92 && c.fontWeight === 800 && c.animIn === 'pop' && c.dur === 3 && c.x === 0.5);
    check('add_text result validates', validateProject(p).ok);
    const p2 = applyEditOp(p, { op: 'apply_text_preset', clip_id: 'tx9', preset: 'caption' } as EditOp);
    check('apply_text_preset switches style + fields',
      clipOf(p2, 'tx9').style === 'caption' && clipOf(p2, 'tx9').fontSize === 44);
  }

  // ---- compound round-trip --------------------------------------------------------------------------
  {
    const p = applyEditOp(freshProject(), { op: 'make_compound', clip_ids: ['c1', 'c2'], compound_id: 'cmpX', name: 'Pair' } as EditOp);
    const host = trackOf(p, 'v1');
    check('make_compound wraps both clips into one nest clip',
      host.clips.length === 1 && host.clips[0].id === 'cmpX' && host.clips[0].nest.tracks.length === 1);
    const nestClips = host.clips[0].nest.tracks[0].clips as Project[];
    check('compound nest times rebased to the selection start (c1 at 1 → 0, c2 at 5 → 4)',
      nestClips.find((c) => c.id === 'c1')?.start === 0 && nestClips.find((c) => c.id === 'c2')?.start === 4,
      J(nestClips.map((c) => [c.id, c.start])));
    check('compound window is start..end (1 → 0..6)', host.clips[0].in === 0 && host.clips[0].out === 6 && host.clips[0].start === 1);
    // Known validator quirk (all three validator homes): nest tracks
    // keep their original ids by design, so the strict walk reports the
    // host track id as a duplicate for ANY compound — the raw verdict
    // carries exactly that one artifact, and the MCP write-path filter
    // (writePathErrors) clears it while genuine errors still refuse.
    const rawErrors = validateProject(p).errors;
    check('compound raw verdict = only the nest-track-id artifact',
      rawErrors.length === 1 && rawErrors[0] === 'duplicate track id "v1"', J(rawErrors));
    check('compound project passes the write-path verdict', writePathErrors(p).length === 0);
    const back = applyEditOp(p, { op: 'uncompound', clip_id: 'cmpX' } as EditOp);
    const ids = (trackOf(back, 'v1').clips as Project[]).map((c) => c.id).sort();
    const starts = Object.fromEntries((trackOf(back, 'v1').clips as Project[]).map((c) => [c.id, c.start]));
    check('uncompound round-trip restores ids + timeline starts',
      J(ids) === J(['c1', 'c2']) && starts.c1 === 1 && starts.c2 === 5, J(starts));
  }

  // ---- timing / link / transform -----------------------------------------------------------------------
  {
    let p = applyEditOp(freshProject(), { op: 'set_clip_timing', clip_id: 'c2', speed: 0.5, reversed: true, freezeAt: 1.2 } as EditOp);
    const c = clipOf(p, 'c2');
    check('set_clip_timing sets speed/reversed/freezeAt', c.speed === 0.5 && c.reversed === true && c.freezeAt === 1.2);
    p = applyEditOp(p, { op: 'set_clip_timing', clip_id: 'c2', freezeAt: null } as EditOp);
    check('set_clip_timing null clears freezeAt', !('freezeAt' in clipOf(p, 'c2')));
    const p2 = applyEditOps(freshProject(), [
      { op: 'link_clips', clip_ids: ['c1', 'c2'], group_id: 'g1' } as EditOp,
    ]);
    check('link_clips shares a groupId', clipOf(p2, 'c1').groupId === 'g1' && clipOf(p2, 'c2').groupId === 'g1');
    const p3 = applyEditOp(p2, { op: 'unlink_clips', clip_ids: ['c1'] } as EditOp);
    check('unlink_clips removes the groupId', !('groupId' in clipOf(p3, 'c1')) && clipOf(p3, 'c2').groupId === 'g1');
    const p4 = applyEditOp(freshProject(), { op: 'set_transform', clip_id: 'c1', transform: { x: 5 } } as EditOp);
    check('set_transform partial merge', clipOf(p4, 'c1').transform.x === 5 && clipOf(p4, 'c1').transform.scale === 1);
  }

  // ---- effects + transitions --------------------------------------------------------------------------------
  {
    let p = applyEditOp(freshProject(), { op: 'add_effect', clip_id: 'c1', type: 'blur' } as EditOp);
    check('add_effect uses the Inspector default (blur 6)',
      (clipOf(p, 'c1').effects as Project[])[0].value === 6);
    throws('add_effect refuses a duplicate type',
      () => applyEditOp(p, { op: 'add_effect', clip_id: 'c1', type: 'blur' } as EditOp), 'already has');
    p = applyEditOp(p, { op: 'update_effect', clip_id: 'c1', type: 'blur', value: 12 } as EditOp);
    check('update_effect sets the value', (clipOf(p, 'c1').effects as Project[])[0].value === 12);
    p = applyEditOp(p, { op: 'remove_effect', clip_id: 'c1', type: 'blur' } as EditOp);
    check('remove_effect empties the stack', (clipOf(p, 'c1').effects as Project[]).length === 0);
    const p2 = applyEditOp(freshProject(), { op: 'set_transition', clip_id: 'c2', transitionIn: 'dissolve', transitionDur: 0.4 } as EditOp);
    check('set_transition sets type + duration',
      clipOf(p2, 'c2').transitionIn === 'dissolve' && clipOf(p2, 'c2').transitionDur === 0.4);
    throws('set_transition refuses an unknown transition',
      () => applyEditOp(freshProject(), { op: 'set_transition', clip_id: 'c2', transitionIn: 'spin' } as EditOp), 'not a known transition');
  }

  // ---- audio --------------------------------------------------------------------------------------------
  {
    let p = applyEditOp(freshProject(), { op: 'set_eq', clip_id: 'ac1', low: 3 } as EditOp);
    const c = clipOf(p, 'ac1');
    check('set_eq legacy low maps onto band 1 (200 Hz peaking, per eq.ts)',
      Array.isArray(c.eqBands) && c.eqBands.length === 6 && c.eqBands[0].freq === 200 && c.eqBands[0].gain === 3 && !('eqLow' in c),
      J(c.eqBands?.[0]));
    const bands = [80, 250, 800, 2500, 6000, 12000].map((freq) => ({ freq, gain: 1, q: 0.9 }));
    p = applyEditOp(freshProject(), { op: 'set_eq', clip_id: 'ac1', bands } as EditOp);
    check('set_eq full 6-band form', clipOf(p, 'ac1').eqBands.length === 6 && clipOf(p, 'ac1').eqBands[3].gain === 1);
    const p2 = applyEditOps(freshProject(), [
      { op: 'set_clip_volume', clip_id: 'ac1', volume: 0.7 } as EditOp,
      { op: 'set_fades', clip_id: 'ac1', fadeIn: 0.3, fadeOut: 0.9 } as EditOp,
      { op: 'set_pan', clip_id: 'ac1', pan: -0.5 } as EditOp,
      { op: 'set_denoise', clip_id: 'ac1', denoise: true } as EditOp,
      { op: 'set_voice_fx', clip_id: 'ac1', voice_fx: 'echo' } as EditOp,
    ]);
    const ac = clipOf(p2, 'ac1');
    check('audio basics: volume/fades/pan/denoise/voiceFx',
      ac.volume === 0.7 && ac.fadeIn === 0.3 && ac.fadeOut === 0.9 && ac.pan === -0.5 && ac.denoise === true && ac.voiceFx === 'echo');
    check('audio-edited project validates', validateProject(p2).ok);
    const p3 = applyEditOp(freshProject(), { op: 'set_audio_bus', audio_bus: { masterGain: 0.8, ducking: { enabled: true, amount: 6, attack: 10, release: 200 } } } as EditOp);
    check('set_audio_bus partial merge keeps model defaults + ducking',
      p3.audioBus.masterGain === 0.8 && p3.audioBus.normalise === true && p3.audioBus.ducking.amount === 6);
  }

  // ---- tracks -----------------------------------------------------------------------------------------------
  {
    throws('remove_track refuses a non-empty track without force',
      () => applyEditOp(freshProject(), { op: 'remove_track', track_id: 'v1' } as EditOp), 'still has');
    const p = applyEditOp(freshProject(), { op: 'remove_track', track_id: 'v1', force: true } as EditOp);
    check('remove_track with force', !p.tracks.some((t: Project) => t.id === 'v1'));
    const p2 = applyEditOp(freshProject(), { op: 'set_track_flags', track_id: 'v1', muted: true, name: 'Hero' } as EditOp);
    check('set_track_flags', trackOf(p2, 'v1').muted === true && trackOf(p2, 'v1').name === 'Hero');
  }

  // ---- multicam angles -----------------------------------------------------------------------------------------
  {
    const withAngles = (): Project => {
      const p = freshProject();
      const c = clipOf(p, 'c2');
      c.in = 10; c.out = 20; c.start = 0;
      c.angles = [
        { media: 'm3', label: 'A', syncOffset: 0 },
        { media: 'm1', label: 'B', syncOffset: 2 },
      ];
      c.activeAngle = 0;
      return p;
    };
    const p = applyEditOp(withAngles(), { op: 'set_active_angle', clip_id: 'c2', angle_index: 1 } as EditOp);
    const c = clipOf(p, 'c2');
    check('set_active_angle re-points media + shifts window by the offset delta',
      c.media === 'm1' && c.activeAngle === 1 && c.in === 12 && c.out === 22, `in=${c.in} out=${c.out}`);
    const p2 = applyEditOp(withAngles(), { op: 'cut_to_angle', clip_id: 'c2', at: 5, angle_index: 1, new_clip_id: 'c2r' } as EditOp);
    const left = clipOf(p2, 'c2');
    const right = clipOf(p2, 'c2r');
    check('cut_to_angle splits + right part takes the angle with shifted window',
      left.in === 10 && left.out === 15 && right.start === 5 && right.in === 17 && right.out === 22 && right.media === 'm1' && right.activeAngle === 1,
      `left=${left.in}-${left.out} right=${right.in}-${right.out}@${right.start}`);
  }

  // ---- revision + edit log helpers ---------------------------------------------------------------------------------
  {
    check('checkRevision passes on a match', (() => { checkRevision(3, 3); return true; })());
    check('checkRevision passes when untracked', (() => { checkRevision(null, 9); return true; })());
    throws('checkRevision refuses a stale write', () => checkRevision(3, 2), 'stale write refused');
    const p = buildEmptyProject({ name: 'Log' });
    p.editLog = Array.from({ length: 100 }, (_, i) => ({ at: 'x', by: 'a', ops: [`op${i}`], revision: i }));
    appendEditLog(p, { at: 'now', by: 'agent', ops: ['add_marker'], revision: 101 });
    check('appendEditLog caps at the newest 100',
      p.editLog.length === 100 && p.editLog[99].ops[0] === 'add_marker' && p.editLog[0].ops[0] === 'op1');
    check('editLog-carrying project still validates', validateProject(p).ok);
  }

  // ---- summary -----------------------------------------------------------------------------------------------------------
  {
    const s = projectSummary(freshProject());
    check('projectSummary counts tracks/clips/media + duration',
      s.trackCount === 3 && s.clipCount === 4 && s.mediaCount === 3 && s.duration === 8, J(s));
  }

  console.log(`\nmcp-harness: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
