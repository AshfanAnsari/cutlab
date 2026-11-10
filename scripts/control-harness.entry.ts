/**
 * control-harness.entry.ts — exercises the live-control command handlers
 * (src/services/control.ts → executeCommand) against the REAL editor store,
 * headlessly. Bundled with `vite build --ssr` and run under Node.
 *
 * Covered: the store-only commands end to end (ping, addClip, trimClip,
 * moveClip, splitClip, setVolume, addText, updateText, deleteClip,
 * getState) plus the failure paths (unknown kind, missing clip/asset,
 * invalid trim, wrong clip type). previewSnapshot is covered for
 * registration + its clean refusal without a DOM — the capture itself
 * needs the open editor and is proven by the live session. NOT covered
 * here, by design: openCloudProject / saveCloud / queueMediaJob /
 * queueRender — they ride the relay (network) and are proven by the
 * live session, not a harness.
 */
import { store } from '../src/state/store';
import { CONTROL_COMMANDS, executeCommand } from '../src/services/control';
import { emptyProject, type Project, type TextClip, type VideoClip } from '../src/types';

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  PASS ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
  }
}

async function expectFail(name: string, kind: string, args: Record<string, unknown>) {
  try {
    const r = await executeCommand(kind, args);
    failures++;
    console.log(`  FAIL ${name} — expected failure, got ${JSON.stringify(r)}`);
  } catch (e) {
    console.log(`  PASS ${name} (failed as expected: ${e instanceof Error ? e.message : String(e)})`);
  }
}

function proj(): Project {
  return store.get().project;
}
function findClip(id: string) {
  for (const t of proj().tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return { track: t, clip: c };
  }
  return null;
}

async function main() {
  const p = emptyProject();
  p.name = 'Harness project';
  p.media = [
    { id: 'm1', src: 'clip1.mp4', kind: 'video', duration: 12 },
    { id: 'a1', src: 'song.mp3', kind: 'audio', duration: 30 },
  ];
  store.replaceProject(p, { history: false });

  console.log('— ping');
  const ping = await executeCommand('ping', {});
  check('ping ok', ping.ok === true && ping.projectName === 'Harness project', ping);

  console.log('— addClip (video asset)');
  const add = await executeCommand('addClip', { assetId: 'm1' });
  const clipId = add.clipId as string;
  const added = findClip(clipId);
  check('clip on a video track', !!added && added.track.kind === 'video');
  check('clip spans the full asset at 0', !!added && (added.clip as VideoClip).in === 0
    && (added.clip as VideoClip).out === 12 && added.clip.start === 0, added?.clip);

  console.log('— trimClip / moveClip');
  await executeCommand('trimClip', { clipId, in: 2, out: 8 });
  let c = findClip(clipId)!.clip as VideoClip;
  check('trim applied', c.in === 2 && c.out === 8, c);
  await executeCommand('moveClip', { clipId, start: 3 });
  c = findClip(clipId)!.clip as VideoClip;
  check('move applied', c.start === 3, c);

  console.log('— splitClip at 5 (clip spans 3..9 after trim+move)');
  const split = await executeCommand('splitClip', { clipId, at: 5 });
  const rightId = split.newClipId as string;
  const left = findClip(clipId)!.clip as VideoClip;
  const right = findClip(rightId)?.clip as VideoClip | undefined;
  check('left out = 4', left.out === 4, left);
  check('right in = 4, starts at 5', !!right && right.in === 4 && right.start === 5 && right.out === 8, right);

  console.log('— setVolume (+ clamping)');
  const vol = await executeCommand('setVolume', { clipId, volume: 0.4 });
  check('volume 0.4', vol.volume === 0.4 && (findClip(clipId)!.clip as VideoClip).volume === 0.4);
  const vol2 = await executeCommand('setVolume', { clipId, volume: 5 });
  check('volume clamped to 1', vol2.volume === 1, vol2);

  console.log('— addText / updateText');
  const t = await executeCommand('addText', { text: 'HELLO', start: 1, dur: 2 });
  const textClip = findClip(t.clipId as string)?.clip as TextClip | undefined;
  check('text clip created', !!textClip && textClip.text === 'HELLO' && textClip.dur === 2, textClip);
  await executeCommand('updateText', { clipId: t.clipId, text: 'WORLD' });
  check('text updated', (findClip(t.clipId as string)!.clip as TextClip).text === 'WORLD');

  console.log('— addClip (audio asset lands on the audio track)');
  const addA = await executeCommand('addClip', { assetId: 'a1' });
  const audioClip = findClip(addA.clipId as string);
  check('audio clip on audio track', !!audioClip && audioClip.track.kind === 'audio', addA);

  console.log('— getState');
  const st = await executeCommand('getState', {});
  const stProject = st.project as Project;
  check('state carries the project', stProject?.name === 'Harness project'
    && stProject.tracks.reduce((n, tr) => n + tr.clips.length, 0) === 4, stProject?.name);
  check('state carries the media list', Array.isArray(st.media));

  console.log('— deleteClip');
  await executeCommand('deleteClip', { clipId: rightId });
  check('right half deleted', findClip(rightId) === null);

  console.log('— previewSnapshot (registered; DOM-less here, must refuse cleanly)');
  check('previewSnapshot is a known command', CONTROL_COMMANDS.includes('previewSnapshot'));
  await expectFail('previewSnapshot without a DOM', 'previewSnapshot', {});

  console.log('— failure paths (must fail cleanly, never hang)');
  await expectFail('unknown kind', 'nope', {});
  await expectFail('missing clip', 'trimClip', { clipId: 'ghost', in: 0, out: 1 });
  await expectFail('in >= out rejected', 'trimClip', { clipId, in: 4, out: 4 });
  await expectFail('missing asset', 'addClip', { assetId: 'ghost' });
  await expectFail('updateText on a video clip', 'updateText', { clipId, text: 'x' });
  await expectFail('split outside the clip', 'splitClip', { clipId, at: 99 });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('Harness crashed:', e);
  process.exit(2);
});
