/**
 * guides.ts — stage guide lines (D2.6). View-level, not project data
 * (like Resolve's viewer guides): vertical/horizontal lines stored as
 * canvas fractions, persisted per user. Click a ruler to add a guide
 * at that position; drag a guide on the stage to move it; drag it off
 * the stage (or double-click it) to remove it.
 */
export interface GuideSet { v: number[]; h: number[] }

const KEY = 'cutlab.guides';

export function loadGuides(): GuideSet {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { v: [], h: [] };
    const p = JSON.parse(raw) as Partial<GuideSet>;
    const ok = (a: unknown): number[] =>
      Array.isArray(a) ? a.filter((x): x is number => typeof x === 'number' && x > 0 && x < 1) : [];
    return { v: ok(p.v), h: ok(p.h) };
  } catch {
    return { v: [], h: [] };
  }
}

export function saveGuides(g: GuideSet): void {
  try { localStorage.setItem(KEY, JSON.stringify(g)); } catch { /* ignore */ }
}
