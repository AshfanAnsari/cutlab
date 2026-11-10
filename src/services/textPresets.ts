// User text presets (H.15): "design ONE caption; every later caption inherits
// it." A preset captures the full resolved style of a text clip; applying one
// copies those fields onto the target clip(s) — no hidden indirection, so the
// project JSON always carries the real values and Lane B needs no registry.
import type { TextClip } from '../types';

export interface UserTextPreset {
  name: string;
  fields: Partial<TextClip>;
}

const KEY = 'cutlab.textPresets';

const CAPTURED: (keyof TextClip)[] = [
  'style', 'fontFamily', 'fontWeight', 'fontSize', 'color', 'strokeColor', 'strokeWidth',
  'shadow', 'shadowObj', 'glowObj', 'plate', 'align', 'charSpacing', 'lineSpacing',
  'highlightColor', 'noFill', 'animIn', 'animOut', 'animInDur', 'animOutDur', 'animLoop',
];

export function loadUserPresets(): UserTextPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as UserTextPreset[];
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.name === 'string') : [];
  } catch {
    return [];
  }
}

export function saveUserPreset(name: string, from: TextClip): UserTextPreset[] {
  const fields: Partial<TextClip> = {};
  for (const k of CAPTURED) {
    const v = from[k];
    if (v !== undefined) (fields as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(v));
  }
  // The glow on/off flag travels inside effects today; keep it with the preset.
  if ((from.effects ?? []).includes('glow')) fields.effects = ['glow'];
  const all = [...loadUserPresets().filter((p) => p.name !== name), { name, fields }];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
  return all;
}

export function deleteUserPreset(name: string): UserTextPreset[] {
  const all = loadUserPresets().filter((p) => p.name !== name);
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable */
  }
  return all;
}

/** Copy a preset's fields onto a clip (inside a store commit draft). */
export function applyPresetFields(clip: TextClip, preset: UserTextPreset): void {
  const f = JSON.parse(JSON.stringify(preset.fields)) as Partial<TextClip>;
  Object.assign(clip, f);
}
