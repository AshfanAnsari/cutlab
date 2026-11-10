/**
 * Phase 3X harness (UPGRADE-PLAN Phase 3: delivery & interchange) —
 * headless checks for:
 *   · cuesFromWords grouping rules (gap / line capacity / min / max dur)
 *   · SRT + VTT serialisers (exact-format spot checks + parse round-trip)
 *   · EDL (CMX 3600) event math on a 3-clip fixture + dissolve + skips
 *   · FCP7 XML well-formedness + key fields on the same fixture
 *   · the renderer's LOUDNESS_PRESETS values (parsed from render.py —
 *     the Python dict is the single source of truth)
 * Run: vite build --ssr scripts/phase3x-harness.entry.ts, then node.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cuesFromProjectWords, cuesFromWords, cuesToSrt, cuesToVtt,
  parseSubtitles, toSrt, toVtt, type WordTiming,
} from '../src/services/captions';
import { secondsToTimecode, toEdl, toFcp7Xml } from '../src/services/edlExport';
import type { Project } from '../src/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

const W = (w: string, t0: number, t1: number): WordTiming => ({ w, t0, t1 });

// ---- cuesFromWords ---------------------------------------------------------
{
  // A >= 0.7s pause breaks the cue.
  const cues = cuesFromWords([W('a', 0, 0.3), W('b', 0.4, 0.7), W('c', 2.0, 2.3)]);
  check('words: a long pause splits cues', cues.length === 2 && cues[1].start === 2.0,
    JSON.stringify(cues));

  // Ten 9-char words, tight timing: capacity is 42*2=84 chars, so the
  // first cue holds 8 words (79 chars), wrapped 4 + 4 over two lines.
  const many: WordTiming[] = [];
  for (let i = 0; i < 10; i++) many.push(W('abcdefghi', i * 0.3, i * 0.3 + 0.25));
  const wrapped = cuesFromWords(many);
  const lines = wrapped[0].text.split('\n');
  check('words: line capacity splits into a second cue',
    wrapped.length === 2 && wrapped[0].text.replace(/\n/g, ' ').split(' ').length === 8,
    JSON.stringify(wrapped.map((c) => c.text)));
  check('words: wrapped lines respect 42 chars / 2 lines',
    lines.length === 2 && lines.every((l) => l.length <= 42), JSON.stringify(lines));

  // A lone 0.2s word stretches to the 0.8s minimum.
  const tiny = cuesFromWords([W('hi', 1, 1.2)]);
  check('words: min duration stretches a short cue',
    tiny.length === 1 && Math.abs(tiny[0].end - 1.8) < 1e-9, JSON.stringify(tiny));

  // …but never past the next cue's start (a tighter maxGap forces the
  // split that makes the cap reachable).
  const capped = cuesFromWords([W('hi', 0, 0.1), W('yo', 0.5, 0.9)], { maxGap: 0.3 });
  check('words: min-duration stretch stops at the next cue',
    capped.length === 2 && capped[0].end <= 0.5 + 1e-9, JSON.stringify(capped));

  // A continuous stream longer than 6s splits on duration alone.
  const stream: WordTiming[] = [];
  for (let i = 0; i <= 16; i++) stream.push(W('x', i * 0.5, i * 0.5 + 0.4));
  const long = cuesFromWords(stream);
  check('words: max duration splits a continuous stream',
    long.length >= 2 && long.every((c) => c.end - c.start <= 6 + 1e-9),
    JSON.stringify(long.map((c) => [c.start, c.end])));

  check('words: empty input gives no cues', cuesFromWords([]).length === 0);
  check('words: junk timings are dropped',
    cuesFromWords([W('ok', 0, 0.5), W('bad', Number.NaN, 1)]).length === 1);
}

// ---- serialisers -------------------------------------------------------------
const twoCues = [
  { start: 0, end: 1.5, text: 'Hello world' },
  { start: 2, end: 3, text: 'Second line' },
];
check('srt: exact format',
  cuesToSrt(twoCues) === '1\n00:00:00,000 --> 00:00:01,500\nHello world\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line\n',
  JSON.stringify(cuesToSrt(twoCues)));
check('vtt: exact format with header and dot millis',
  cuesToVtt(twoCues) === 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello world\n\n00:00:02.000 --> 00:00:03.000\nSecond line\n',
  JSON.stringify(cuesToVtt(twoCues)));
{
  const back = parseSubtitles(cuesToSrt(twoCues));
  check('srt: parse round-trip preserves cues',
    back.length === 2 && back[0].start === 0 && back[0].end === 1.5
      && back[1].text === 'Second line', JSON.stringify(back));
}

// ---- fixture project ---------------------------------------------------------
const T = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
const fixture = {
  version: 1,
  name: 'Fixture & Co',
  canvas: { w: 320, h: 240, fps: 30 },
  media: [
    { id: 'm1', src: 'clip_one.mp4', kind: 'video', duration: 20, width: 320, height: 240 },
    { id: 'm2', src: 'second.mp4', kind: 'video', duration: 10, width: 320, height: 240 },
    { id: 'm3', src: 'third.mp4', kind: 'video', duration: 8, width: 320, height: 240 },
    { id: 'a1', src: 'song.mp3', kind: 'audio', duration: 30 },
  ],
  tracks: [
    {
      id: 'trk_v', kind: 'video', clips: [
        { id: 'c1', media: 'm1', start: 0, in: 10, out: 12, speed: 1, muted: false, volume: 1, transform: T },
        { id: 'c2', media: 'm2', start: 2, in: 0, out: 3, speed: 1, muted: false, volume: 1, transform: T, transitionIn: 'dissolve', transitionDur: 0.5 },
        { id: 'c3', media: 'm3', start: 5, in: 2, out: 3.5, speed: 1, muted: false, volume: 1, transform: T },
        { id: 'cN', start: 7, in: 0, out: 2, transform: T, nest: { name: 'Nest', tracks: [] } },
        { id: 'cA', adj: true, start: 9, dur: 1 },
      ],
    },
    {
      id: 'trk_a', kind: 'audio', clips: [
        { id: 'a9', media: 'a1', start: 0, in: 4, out: 6, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
      ],
    },
    {
      id: 'trk_t', kind: 'text', clips: [
        {
          id: 't1', text: 'Hello **world**', start: 1, dur: 2, style: 'caption', effects: [],
          words: [W('Hello', 0, 0.4), W('world', 0.5, 0.9)],
        },
      ],
    },
  ],
  markers: [],
} as unknown as Project;

// ---- captions from the project ----------------------------------------------
check('toSrt: track serialises and strips ** markup',
  toSrt(fixture, 'trk_t') === '1\n00:00:01,000 --> 00:00:03,000\nHello world\n',
  JSON.stringify(toSrt(fixture, 'trk_t')));
check('toVtt: track serialises with WEBVTT header',
  toVtt(fixture, 'trk_t') === 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n',
  JSON.stringify(toVtt(fixture, 'trk_t')));
{
  const wc = cuesFromProjectWords(fixture);
  check('project words: clip-local timings land on the timeline',
    wc.length === 1 && wc[0].start === 1 && wc[0].text === 'Hello world',
    JSON.stringify(wc));
}

// ---- EDL ----------------------------------------------------------------------
check('timecode: 3661.5s at 30fps', secondsToTimecode(3661.5, 30) === '01:01:01:15',
  secondsToTimecode(3661.5, 30));
{
  const edl = toEdl(fixture);
  const events = edl.split('\n').filter((l) => /^\d{3} /.test(l));
  check('edl: header carries title + FCM',
    edl.startsWith('TITLE: Fixture & Co\nFCM: NON-DROP FRAME'), edl.split('\n')[0]);
  check('edl: 3 video events + 1 audio event, skips are not events',
    events.length === 4, `${events.length} events`);
  check('edl: event 1 source/record math',
    events[0].includes('00:00:10:00 00:00:12:00 00:00:00:00 00:00:02:00'), events[0]);
  check('edl: event 2 is a 15-frame dissolve at the right record point',
    / D {4}015 /.test(events[1]) && events[1].includes('00:00:00:00 00:00:03:00 00:00:02:00 00:00:05:00'),
    events[1]);
  check('edl: event 3 record span follows the timeline',
    events[2].includes('00:00:02:00 00:00:03:15 00:00:05:00 00:00:06:15'), events[2]);
  check('edl: compound + adjustment skips are commented, not silent',
    edl.includes('SKIPPED COMPOUND CLIP cN') && edl.includes('SKIPPED ADJUSTMENT CLIP cA'), edl);
  check('edl: full source names ride as comments',
    edl.includes('* FROM CLIP NAME: clip_one.mp4'), edl);
}

// ---- FCP7 XML -------------------------------------------------------------------
/** Minimal well-formedness: balanced tags after stripping the prolog,
 *  doctype and comments (self-closing tags balance themselves). */
function xmlBalanced(xml: string): boolean {
  const body = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const [, close, tag, , selfClose] = m;
    if (selfClose) continue;
    if (close) {
      if (stack.pop() !== tag) return false;
    } else stack.push(tag);
  }
  return stack.length === 0;
}
{
  const xml = toFcp7Xml(fixture);
  check('fcp7: document is well-formed (balanced tags)', xmlBalanced(xml));
  check('fcp7: xmeml v5 + sequence header fields',
    xml.includes('<xmeml version="5">') && xml.includes('<name>Fixture &amp; Co</name>')
      && xml.includes('<timebase>30</timebase>') && xml.includes('<width>320</width>')
      && xml.includes('<height>240</height>'), xml.slice(0, 400));
  check('fcp7: sequence duration is the project duration in frames',
    xml.includes('<duration>300</duration>'), xml.match(/<duration>\d+<\/duration>/)?.[0]);
  check('fcp7: clipitem frame math for clip 2 (start/end/in/out)',
    xml.includes('<start>60</start>') && xml.includes('<end>150</end>')
      && xml.includes('<in>0</in>') && xml.includes('<out>90</out>'), xml);
  check('fcp7: file defs come from the media registry',
    xml.includes('<pathurl>file://localhost/media/clip_one.mp4</pathurl>')
      && xml.includes('<name>song.mp3</name>'), xml);
  check('fcp7: compound + adjustment skips are XML comments',
    xml.includes('<!-- SKIPPED compound clip cN') && xml.includes('<!-- SKIPPED adjustment clip cA'), xml);
}

// ---- loudness presets (single source of truth: render.py) -----------------------
{
  let src = '';
  for (const cand of [join(process.cwd(), 'render-lane-b/render.py'), '/home/hatch/cutlab-build/render-lane-b/render.py']) {
    try { src = readFileSync(cand, 'utf8'); break; } catch { /* next */ }
  }
  check('loudness: render.py found for the preset check', src.length > 0);
  const block = /LOUDNESS_PRESETS\s*=\s*\{([\s\S]*?)\}/.exec(src)?.[1] ?? '';
  const got = new Map<string, number>();
  for (const m of block.matchAll(/"(\w+)":\s*(-?\d+(?:\.\d+)?)/g)) got.set(m[1], Number(m[2]));
  const want: Record<string, number> = {
    social: -14, youtube: -14, spotify: -14, apple: -16,
    podcast: -16, broadcast_eu: -23, broadcast_us: -24,
  };
  check('loudness: preset map values match the platform targets',
    Object.entries(want).every(([k, v]) => got.get(k) === v),
    JSON.stringify([...got.entries()]));
}

console.log(`\nphase3x-harness: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
