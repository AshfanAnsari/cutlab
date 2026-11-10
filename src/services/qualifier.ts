// Qualifier-lite (D1.2): the selection maths for Grade.key, plus the
// matte-view / stage-picker UI singletons. The selection formula is a
// pure function of the pixel's HSV — Lane B implements the SAME formula
// in numpy (render.py qualifier_mask_lut) and bakes it into a 33^3 LUT,
// so preview and render agree by construction. The preview's matte is
// still labelled approximate: it is drawn from a low-res sample of the
// playing element, not the full-res render.
//
// Formula (both homes, keep in sync): the plateau spans [lo, hi] in
// full and the feather falls OUTSIDE it (Resolve's convention), so a
// pixel sitting exactly on an edge is fully selected:
//   ramp(x, a, b)  = smoothstep clamp of (x-a)/(b-a); b<=a -> step at a.
//   trap(x, lo, hi, soft) = ramp(x, lo-soft, lo) * (1 - ramp(x, hi, hi+soft))
//   hueSel: d = wrapped |h - centre| in 0..0.5; half = hueWidth/2;
//           sel = 1 - ramp(d, half, half+soft)
//   mask = hueSel * trap(s, satMin, satMax, satSoft) * trap(v, lumaMin, lumaMax, lumaSoft)
import type { GradeKey } from '../types';

export const DEFAULT_GRADE_KEY: GradeKey = {
  hue: 0, hueWidth: 0.15, hueSoft: 0.08,
  satMin: 0.2, satMax: 1, satSoft: 0.1,
  lumaMin: 0, lumaMax: 1, lumaSoft: 0.1,
};

/** r,g,b in 0..255 → h,s,v each 0..1 (HSV, the qualifier's space). */
export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn), d = mx - mn;
  let h = 0;
  if (d > 1e-12) {
    if (mx === rn) h = (((gn - bn) / d) % 6 + 6) % 6;
    else if (mx === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  const s = mx > 1e-12 ? d / mx : 0;
  return [h, s, mx];
}

function ramp(x: number, a: number, b: number): number {
  if (b <= a) return x >= a ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function trap(x: number, lo: number, hi: number, soft: number): number {
  return ramp(x, lo - soft, lo) * (1 - ramp(x, hi, hi + soft));
}

/** Selection strength 0..1 for one pixel (r,g,b in 0..255). */
export function qualifierMaskValue(r: number, g: number, b: number, key: GradeKey): number {
  const [h, s, v] = rgbToHsv(r, g, b);
  let d = Math.abs(h - key.hue);
  d = Math.min(d, 1 - d);
  const half = key.hueWidth / 2;
  const hueSel = 1 - ramp(d, half, half + key.hueSoft);
  return hueSel * trap(s, key.satMin, key.satMax, key.satSoft) * trap(v, key.lumaMin, key.lumaMax, key.lumaSoft);
}

// ------------------------------------------------- matte view singleton
// Which clip's keyed selection the stage should show as a matte, and the
// key to draw. Set from the Colour panel's Key section; read by Preview.
export interface MatteViewState { clipId: string; key: GradeKey }
let matteState: MatteViewState | null = null;
const matteSubs = new Set<() => void>();
export const matteView = {
  get(): MatteViewState | null { return matteState; },
  set(next: MatteViewState | null) {
    matteState = next;
    for (const fn of matteSubs) fn();
  },
  subscribe(fn: () => void): () => void {
    matteSubs.add(fn);
    return () => { matteSubs.delete(fn); };
  },
};

// ------------------------------------------------- stage hue picker
// One-shot eyedropper: the Key section arms it with a callback; the
// stage's next click samples the pixel and fires the callback.
let pickerCb: ((hue: number) => void) | null = null;
const pickerSubs = new Set<() => void>();
function pickerNotify() { for (const fn of pickerSubs) fn(); }
export const stagePicker = {
  arm(cb: (hue: number) => void) { pickerCb = cb; pickerNotify(); },
  disarm() { if (pickerCb) { pickerCb = null; pickerNotify(); } },
  isArmed(): boolean { return pickerCb !== null; },
  fire(hue: number) {
    const cb = pickerCb;
    pickerCb = null;
    pickerNotify();
    if (cb) cb(hue);
  },
  subscribe(fn: () => void): () => void {
    pickerSubs.add(fn);
    return () => { pickerSubs.delete(fn); };
  },
};
