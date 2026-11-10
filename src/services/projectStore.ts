// ProjectStore interface — the persistence seam for project documents.
// Milestone 1 implementation: IndexedDB autosave (local). A future backend
// implements this same interface over HTTP; nothing else in the app changes.
import type { Project } from '../types';
import { idb } from './db';

export interface AutosaveRecord {
  project: Project;
  savedAt: number;
}

export interface ProjectStore {
  loadAutosave(): Promise<AutosaveRecord | null>;
  saveAutosave(p: Project): Promise<void>;
  clearAutosave(): Promise<void>;
}

const KEY = 'autosave';

export const localProjectStore: ProjectStore = {
  async loadAutosave() {
    try {
      const rec = await idb.get<AutosaveRecord>('kv', KEY);
      return rec ?? null;
    } catch {
      return null;
    }
  },
  async saveAutosave(p: Project) {
    await idb.set('kv', KEY, { project: p, savedAt: Date.now() } satisfies AutosaveRecord);
  },
  async clearAutosave() {
    await idb.del('kv', KEY);
  },
};

export const projectStore: ProjectStore = localProjectStore;
