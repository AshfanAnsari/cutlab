// Frame maths + easing. All timeline times are seconds; frame accuracy means
// every committed edit is quantised to the project frame grid.

export function qFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function toFrames(t: number, fps: number): number {
  return Math.round(t * fps);
}

export function fmtTime(t: number, fps: number): string {
  const neg = t < 0;
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = Math.floor(a % 60);
  const f = Math.floor((a - Math.floor(a)) * fps + 1e-6);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${neg ? '-' : ''}${p(m)}:${p(s)}:${p(f)}`;
}

export function fmtSecs(t: number): string {
  return t.toFixed(2) + 's';
}

/** The ONE shared formatter for wall-clock timestamps in lists (render
 *  queue, library, history): the viewer's own locale and timezone,
 *  hour + minute, never seconds. FIX B1 #17 — do not scatter
 *  toLocaleString() variants; call this. */
const wallClockFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
});
export function fmtDateTime(ts: string | number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : wallClockFmt.format(d);
}

/** Short elapsed label for a running job ("12s", "3m 05s"). */
export function fmtElapsed(fromTs: string | number | Date, nowMs: number = Date.now()): string {
  const from = fromTs instanceof Date ? fromTs.getTime() : new Date(fromTs).getTime();
  if (Number.isNaN(from)) return '';
  const s = Math.max(0, Math.floor((nowMs - from) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function easeOutCubic(x: number): number {
  return 1 - Math.pow(1 - x, 3);
}
export function easeInCubic(x: number): number {
  return x * x * x;
}
export function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
export function easeOutBack(x: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
export interface BezierHandles { x1: number; y1: number; x2: number; y2: number }
export const DEFAULT_BEZIER: BezierHandles = { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };

/** Cubic-bezier easing evaluation (Newton + bisection fallback), P0=(0,0), P3=(1,1). */
export function cubicBezierY(x: number, h: BezierHandles): number {
  const cx = (t: number) => 3 * (1 - t) ** 2 * t * h.x1 + 3 * (1 - t) * t * t * h.x2 + t ** 3;
  const cy = (t: number) => 3 * (1 - t) ** 2 * t * h.y1 + 3 * (1 - t) * t * t * h.y2 + t ** 3;
  let t = x;
  for (let i = 0; i < 6; i++) {
    const err = cx(t) - x;
    if (Math.abs(err) < 1e-4) break;
    const d = 3 * (1 - t) ** 2 * h.x1 + 6 * (1 - t) * t * (h.x2 - h.x1) + 3 * t * t * (1 - h.x2);
    if (Math.abs(d) < 1e-5) break;
    t = Math.min(1, Math.max(0, t - err / d));
  }
  return cy(t);
}

export function easeInBack(x: number): number {
  const c = 1.70158;
  return (c + 1) * x ** 3 - c * x ** 2;
}
export function easeOutBackStrong(x: number): number {
  const c = 2.2;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

export function applyEase(kind: string | undefined, x: number, handles?: BezierHandles): number {
  switch (kind) {
    case 'easeIn': return easeInCubic(x);
    case 'easeOut': return easeOutCubic(x);
    case 'cubicOut': return easeOutCubic(x);
    case 'easeInOut': return easeInOutCubic(x);
    case 'reboundOut': return easeOutBackStrong(x);
    case 'backIn': return easeInBack(x);
    case 'bezier': return cubicBezierY(x, handles ?? DEFAULT_BEZIER);
    default: return x;
  }
}
