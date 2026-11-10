// Uploaded fonts (H.16): the .ttf/.otf file is stored in IndexedDB, registered
// with the FontFace API for preview, and listed in the family picker.
// D1.3(d): render jobs now bundle the used font files (jobsSupabase →
// uploadBundledAssets), so Lane B renders with the uploaded font; `ext`
// is kept so the bundled copy carries the right extension (the renderer
// walks the media dir by extension, then reads the family from the file).
import { idb } from './db';
import { store } from '../state/store';

export interface StoredFont {
  name: string;
  blob: Blob;
  /** 'ttf' | 'otf' — absent on records stored before D1.3 (read as ttf). */
  ext?: string;
}

const listeners = new Set<() => void>();
let families: string[] = [];

export function uploadedFontFamilies(): string[] {
  return families;
}
export function subscribeFonts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function notify() {
  for (const fn of listeners) fn();
}

async function register(font: StoredFont) {
  try {
    const url = URL.createObjectURL(font.blob);
    const face = new FontFace(font.name, `url(${url})`);
    await face.load();
    document.fonts.add(face);
  } catch {
    /* an unreadable font file simply never becomes selectable */
  }
}

/** Load every stored font into the document (called once at app start). */
export async function initFonts(): Promise<void> {
  try {
    const keys = await idb.keys('fonts');
    const names: string[] = [];
    for (const k of keys) {
      const f = await idb.get<StoredFont>('fonts', k);
      if (f) {
        names.push(f.name);
        await register(f);
      }
    }
    families = names.sort();
    notify();
  } catch {
    /* storage unavailable: no uploaded fonts this session */
  }
}

export async function uploadFont(file: File): Promise<void> {
  if (!/\.(ttf|otf)$/i.test(file.name)) {
    store.toastMsg('error', 'Upload the .ttf or .otf file itself — not the ZIP it came in.');
    return;
  }
  const name = file.name.replace(/\.(ttf|otf)$/i, '').replace(/[-_]+/g, ' ').trim() || file.name;
  const rec: StoredFont = { name, blob: file, ext: /\.otf$/i.test(file.name) ? 'otf' : 'ttf' };
  await idb.set('fonts', name, rec);
  await register(rec);
  if (!families.includes(name)) families = [...families, name].sort();
  notify();
  store.toastMsg('info', `Font "${name}" added — preview uses it now, and server renders bundle it with the job.`);
}

export async function removeFont(name: string): Promise<void> {
  await idb.del('fonts', name);
  families = families.filter((f) => f !== name);
  notify();
}
