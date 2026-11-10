// Grade helpers (§N): the default grade, and the SVG filter chain the
// preview uses to approximate it. The chain mirrors the studied order —
// LUT (render-only) → primaries → curves → HSL (render-only in preview) —
// and is documented as an approximation; Lane B performs the grade for real.
import type { CurvePt, Grade } from '../types';

export const DEFAULT_GRADE: Grade = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  highlights: 0,
  shadows: 0,
  contrast: 0,
  pivot: 0.5,
  lift: { r: 0, g: 0, b: 0, master: 0 },
  gamma: { r: 0, g: 0, b: 0, master: 0 },
  gain: { r: 0, g: 0, b: 0, master: 0 },
  offset: { r: 0, g: 0, b: 0, master: 0 },
  lutStrength: 0.5,
};

/** Serial grade stack (D1.1): a clip carries up to MAX_GRADE_LAYERS grade
 *  layers applied in order (the project look still applies last, singly).
 *  `grades` wins when present; the legacy single `grade` reads as a
 *  one-element stack. Loads migrate legacy → stack (projectIO). */
export const MAX_GRADE_LAYERS = 3;

export type GradeHolder = { grade?: Grade; grades?: Grade[] } | undefined | null;

export function gradeLayersOf(holder: GradeHolder): Grade[] {
  if (!holder) return [];
  if (Array.isArray(holder.grades)) return holder.grades;
  return holder.grade ? [holder.grade] : [];
}

/** Layers that actually render: enabled and not the identity grade. */
export function activeGradeLayers(holder: GradeHolder): Grade[] {
  return gradeLayersOf(holder).filter((g) => g.enabled !== false && !gradeIsIdentity(g));
}

export function stackHasEffect(holder: GradeHolder): boolean {
  return activeGradeLayers(holder).length > 0;
}

/** True when any of the hue/lum-vs curves actually bends (any point off zero). */
export function hueCurvesActive(hc: Grade['hueCurves']): boolean {
  if (!hc) return false;
  const bent = (pts?: CurvePt[]) => !!pts && pts.some((p) => Math.abs(p.y) > 0.001);
  return bent(hc.hueHue) || bent(hc.hueSat) || bent(hc.lumSat);
}

export function gradeIsIdentity(g: Grade | undefined): boolean {
  if (!g) return true;
  // Missing fields read as their defaults (Lane B reads grades the same
  // way, via .get) so a partial grade object can't crash or misreport.
  const w = (x?: { r: number; g: number; b: number; master: number }) =>
    !x || (x.r === 0 && x.g === 0 && x.b === 0 && x.master === 0);
  return (
    (g.temperature ?? 0) === 0 && (g.tint ?? 0) === 0 && (g.exposure ?? 0) === 0 &&
    (g.highlights ?? 0) === 0 && (g.shadows ?? 0) === 0 && (g.contrast ?? 0) === 0 &&
    w(g.lift) && w(g.gamma) && w(g.gain) && w(g.offset) &&
    !g.curves && !g.lutId && (!g.hsl || Object.keys(g.hsl).length === 0) && !hueCurvesActive(g.hueCurves)
  );
}

function curveFn(pts: CurvePt[] | undefined): (x: number) => number {
  if (!pts || pts.length === 0) return (x) => x;
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  return (x: number) => {
    if (x <= sorted[0].x) return sorted[0].y;
    for (let i = 1; i < sorted.length; i++) {
      if (x <= sorted[i].x) {
        const a = sorted[i - 1], b = sorted[i];
        return b.x === a.x ? b.y : a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
      }
    }
    return sorted[sorted.length - 1].y;
  };
}

export interface FilterSpec {
  /** feColorMatrix values (WB diagonal). */
  matrix: string;
  /** Per-channel gamma transfer: amplitude / exponent / offset. */
  chan: Record<'r' | 'g' | 'b', { amp: number; exp: number; off: number }>;
  /** Per-channel table values (curves + highlight/shadow shaping), 12 entries. */
  table: Record<'r' | 'g' | 'b', string>;
  hasTable: boolean;
}

type Mat20 = number[]; // row-major 4×5 colour matrix

function mulMat(a: Mat20, b: Mat20): Mat20 {
  // result applies b first, then a
  const out = new Array(20).fill(0) as Mat20;
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 5 + k] * b[k * 5 + c];
      out[r * 5 + c] = s;
    }
    let s = a[r * 5 + 4];
    for (let k = 0; k < 4; k++) s += a[r * 5 + k] * b[k * 5 + 4];
    out[r * 5 + 4] = s;
  }
  return out;
}

function hueRotateMat(deg: number): Mat20 {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return [
    0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928, 0, 0,
    0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283, 0, 0,
    0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function saturateMat(s: number): Mat20 {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** Hue-vs preview approximation (N.12): an SVG matrix cannot vary by hue, so
 *  the curves are sampled at six hue-band centres and AVERAGED into one
 *  hue-rotation + one saturation matrix. Lane B applies the curves per-hue
 *  for real; the panel says so. Returns null when the curves are flat. */
function hueAverageMat(hc: Grade['hueCurves']): Mat20 | null {
  if (!hueCurvesActive(hc)) return null;
  // NB: curveFn(undefined) is the identity ramp — for hue curves an absent
  // curve must mean ZERO bend, not identity, so default to a flat zero fn.
  const shiftFn = hc!.hueHue ? curveFn(hc!.hueHue) : () => 0;
  const satFn = hc!.hueSat ? curveFn(hc!.hueSat) : () => 0;
  let deg = 0, sat = 0;
  const BANDS = 6;
  for (let i = 0; i < BANDS; i++) {
    const h = (i + 0.5) / BANDS;
    deg += shiftFn(h) * 180;
    sat += 1 + satFn(h);
  }
  // D2.4 lumSat folds in as one more averaged saturation factor
  // (sampled across the luma range) — the same approximation contract.
  let lumMul = 1;
  if (hc!.lumSat) {
    const lumFn = curveFn(hc!.lumSat);
    lumMul = ((1 + lumFn(0.2)) + (1 + lumFn(0.5)) + (1 + lumFn(0.8))) / 3;
  }
  return mulMat(saturateMat((sat / BANDS) * lumMul), hueRotateMat(deg / BANDS));
}

export function buildFilterSpec(g: Grade): FilterSpec {
  const expMul = Math.pow(2, g.exposure);
  // White balance: temperature warms R/cools B; tint shifts G against magenta.
  const wbR = (1 + g.temperature * 0.22) * expMul;
  const wbG = (1 - g.tint * 0.12) * expMul;
  const wbB = (1 - g.temperature * 0.22) * expMul;
  const wb: Mat20 = [wbR, 0, 0, 0, 0, 0, wbG, 0, 0, 0, 0, 0, wbB, 0, 0, 0, 0, 0, 1, 0];
  const hueMat = hueAverageMat(g.hueCurves);
  const composed = hueMat ? mulMat(wb, hueMat) : wb;
  const matrix = composed.map((v) => +v.toFixed(4)).join(' ');
  const chanFor = (c: 'r' | 'g' | 'b') => {
    const contrast = 1 + g.contrast;
    const amp = Math.max(0.01, (1 + (g.gain[c] + g.gain.master) * 0.5) * contrast);
    const exp = 1 / Math.max(0.2, 1 + (g.gamma[c] + g.gamma.master) * 0.6);
    const off = (g.lift[c] + g.lift.master) * 0.25 + (g.offset[c] + g.offset.master) * 0.3 + g.pivot * (1 - contrast) * 0.5;
    return { amp, exp, off };
  };
  const chan = { r: chanFor('r'), g: chanFor('g'), b: chanFor('b') };
  const masterFn = curveFn(g.curves?.master);
  const shape = (x: number) => {
    let y = masterFn(x);
    y += g.shadows * 0.18 * (1 - x) * (1 - x);
    y += g.highlights * 0.18 * x * x;
    return Math.min(1, Math.max(0, y));
  };
  const N = 12;
  const tableFor = (c: 'r' | 'g' | 'b') => {
    const fn = curveFn(g.curves?.[c]);
    const vals: string[] = [];
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      vals.push(shape(fn(x)).toFixed(3));
    }
    return vals.join(' ');
  };
  const hasTable = !!g.curves || g.highlights !== 0 || g.shadows !== 0;
  return { matrix, chan, table: { r: tableFor('r'), g: tableFor('g'), b: tableFor('b') }, hasTable };
}

/** The studied filmic S-curve (EM II §6.3) as master-curve points. */
export const FILMIC_S_CURVE: CurvePt[] = [
  { x: 0, y: 0.04 },
  { x: 0.25, y: 0.2 },
  { x: 0.5, y: 0.52 },
  { x: 0.75, y: 0.82 },
  { x: 1, y: 0.96 },
];
