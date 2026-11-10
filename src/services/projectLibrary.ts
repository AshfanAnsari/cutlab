// Local project library (R.5/R.9): named project copies in IndexedDB, each
// keeping its previous version one-deep. The autosave slot stays the live
// working copy; the library is where projects persist by name on this
// browser. Relay saves remain the cloud counterpart.
import { idb } from './db';
import type { Project } from '../types';
import { normalizeProject } from './projectIO';

export interface LibraryEntry {
  id: string;
  name: string;
  savedAt: string;
  project: Project;
  prev?: Project; // one-deep version history (R.9)
  prevAt?: string;
}

export async function listLibrary(): Promise<LibraryEntry[]> {
  try {
    const keys = await idb.keys('library');
    const out: LibraryEntry[] = [];
    for (const k of keys) {
      const e = await idb.get<LibraryEntry>('library', k);
      if (e) out.push(e);
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  } catch {
    return [];
  }
}

export async function saveToLibrary(project: Project): Promise<LibraryEntry> {
  const id = `lib-${project.name.toLowerCase().replace(/[^\w]+/g, '-').slice(0, 40) || 'project'}`;
  const existing = await idb.get<LibraryEntry>('library', id).catch(() => undefined);
  const entry: LibraryEntry = {
    id,
    name: project.name,
    savedAt: new Date().toISOString(),
    project: JSON.parse(JSON.stringify(project)) as Project,
    prev: existing?.project,
    prevAt: existing?.savedAt,
  };
  await idb.set('library', id, entry);
  return entry;
}

export async function removeFromLibrary(id: string): Promise<void> {
  await idb.del('library', id);
}

export function entryProject(e: LibraryEntry, which: 'current' | 'prev'): Project | null {
  const raw = which === 'current' ? e.project : e.prev;
  return raw ? normalizeProject(JSON.parse(JSON.stringify(raw))) : null;
}
