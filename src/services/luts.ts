// LUT storage (N.8): .cube files in IndexedDB, like fonts (H.16's mechanism).
// The render applies lut3d at the head of the grade chain; the preview shows
// the un-LUTed picture (stated in the panel) until a sampled approximation
// is worth building.
import { idb } from './db';
import { store } from '../state/store';

export interface StoredLut {
  id: string;
  name: string;
  size: number;
  text: string; // the .cube source, shipped to Lane B with render jobs
}

const listeners = new Set<() => void>();
let luts: StoredLut[] = [];

export function listLuts(): StoredLut[] {
  return luts;
}
export function subscribeLuts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

export function parseCubeSize(text: string): number | null {
  const m = /LUT_3D_SIZE\s+(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

export async function initLuts(): Promise<void> {
  try {
    const keys = await idb.keys('luts');
    const out: StoredLut[] = [];
    for (const k of keys) {
      const l = await idb.get<StoredLut>('luts', k);
      if (l) out.push(l);
    }
    luts = out.sort((a, b) => a.name.localeCompare(b.name));
    notify();
  } catch {
    /* storage unavailable */
  }
}

export async function uploadLut(file: File): Promise<void> {
  if (!/\.cube$/i.test(file.name)) {
    store.toastMsg('error', 'LUT files are .cube — export or download the .cube itself.');
    return;
  }
  const text = await file.text();
  const size = parseCubeSize(text);
  if (!size) {
    store.toastMsg('error', 'That .cube has no LUT_3D_SIZE header — not a 3D LUT we can use.');
    return;
  }
  const name = file.name.replace(/\.cube$/i, '');
  const rec: StoredLut = { id: `lut-${name.toLowerCase().replace(/[^\w]+/g, '-')}`, name, size, text };
  await idb.set('luts', rec.id, rec);
  luts = [...luts.filter((l) => l.id !== rec.id), rec].sort((a, b) => a.name.localeCompare(b.name));
  notify();
  store.toastMsg('info', `LUT "${name}" (${size}³) added. It applies at render; the preview stays un-LUTed.`);
}

export async function removeLut(id: string): Promise<void> {
  await idb.del('luts', id);
  luts = luts.filter((l) => l.id !== id);
  notify();
}
