// Human-readable before/after diff for the Prompt tab (parked-features
// plan, Feature 1 §4). One row per changed clip: a clip name, the field
// that changed, and old -> new values. Computed client-side from the two
// projects — the worker's LLM summary is the headline, never the detail,
// so the rows always match what Accept will actually apply. Nested and
// adjustment clips are not flattened here; they show as a single row.

import { clipDuration } from '../types';
import type {
  Clip, Project, TextClip, Track, VideoClip,
} from '../types';

/** Display name for a clip, mirroring the Timeline's own labels. */
function clipName(c: Clip, p: Project): string {
  if ('nest' in c) return c.nest.name || 'Compound clip';
  if ('adj' in c) return 'Adjustment clip';
  if ('text' in c) return c.text || '(empty caption)';
  if ('media' in c) return p.media.find((m) => m.id === c.media)?.src ?? 'missing media';
  return 'Clip';
}

export interface DiffRow {
  clipName: string;
  change: string;
}

interface FlatClip {
  clip: Clip;
  track: Track;
  trackIndex: number;
  path: string;
}

function flatten(p: Project): Map<string, FlatClip> {
  const out = new Map<string, FlatClip>();
  p.tracks.forEach((t, ti) => {
    for (const c of t.clips) out.set(c.id, { clip: c, track: t, trackIndex: ti, path: clipName(c, p) });
  });
  return out;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fieldDiffs(a: Clip, b: Clip): string[] {
  const out: string[] = [];
  const va = a as VideoClip;
  const vb = b as VideoClip;
  const ta = a as TextClip;
  const tb = b as TextClip;

  if (a.start !== b.start) out.push(`start ${fmt(a.start)}s → ${fmt(b.start)}s`);
  const da = clipDuration(a);
  const db = clipDuration(b);
  if (Math.abs(da - db) > 0.001) out.push(`duration ${fmt(da)}s → ${fmt(db)}s`);
  if ('in' in va && 'in' in vb && va.in !== vb.in) out.push(`in-point ${fmt(va.in!)}s → ${fmt(vb.in!)}s`);
  if ('speed' in va && 'speed' in vb && va.speed !== vb.speed) out.push(`speed ${fmt(va.speed!)}×→ ${fmt(vb.speed!)}×`);
  if ('volume' in va && 'volume' in vb && va.volume !== vb.volume) out.push(`volume ${fmt(va.volume!)} → ${fmt(vb.volume!)}`);
  if ('reversed' in va && 'reversed' in vb && va.reversed !== vb.reversed) {
    out.push(vb.reversed ? 'reversed' : 'no longer reversed');
  }
  if ((a.transitionIn ?? null) !== (b.transitionIn ?? null)) {
    out.push(`transition ${a.transitionIn ?? 'cut'} → ${b.transitionIn ?? 'cut'}`);
  }
  if ('text' in ta && 'text' in tb && ta.text !== tb.text) {
    out.push(`caption "${ta.text}" → "${tb.text}"`);
  }
  if ('transform' in va && 'transform' in vb) {
    const fa = [va.transform.x, va.transform.y, va.transform.scale, va.transform.rotation, va.transform.opacity];
    const fb = [vb.transform.x, vb.transform.y, vb.transform.scale, vb.transform.rotation, vb.transform.opacity];
    if (fa.some((v, i) => v !== fb[i])) out.push('position / scale changed');
  }
  if (JSON.stringify(a) !== JSON.stringify(b) && out.length === 0) {
    out.push('details changed');
  }
  return out;
}

/** Rows for every clip that differs between before and after, plus
 *  track-level and marker rows. Empty array = the two projects are
 *  effectively identical. */
export function summarizeProjectDiff(before: Project, after: Project): DiffRow[] {
  const rows: DiffRow[] = [];
  const bf = flatten(before);
  const af = flatten(after);

  for (const [id, fb] of bf) {
    const fa = af.get(id);
    if (!fa) {
      rows.push({ clipName: fb.path, change: 'removed' });
      continue;
    }
    if (fb.trackIndex !== fa.trackIndex) {
      rows.push({ clipName: fb.path, change: `moved to track ${fa.trackIndex + 1}` });
    }
    for (const d of fieldDiffs(fb.clip, fa.clip)) {
      rows.push({ clipName: fb.path, change: d });
    }
  }
  for (const [id, fa] of af) {
    if (!bf.has(id)) rows.push({ clipName: fa.path, change: 'added' });
  }
  const mk = (p: Project) => (p.markers ?? []).map((m) => `${m.t}:${m.label}`).join('|');
  if (mk(before) !== mk(after)) rows.push({ clipName: 'Markers', change: 'markers changed' });
  if (before.canvas.w !== after.canvas.w || before.canvas.h !== after.canvas.h) {
    rows.push({ clipName: 'Canvas', change: `${before.canvas.w}×${before.canvas.h} → ${after.canvas.w}×${after.canvas.h}` });
  }
  return rows;
}
