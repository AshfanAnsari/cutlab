// User preferences — ONE home (COMPONENT-AUDIT A.8). A single localStorage
// object read by the components that need defaults, instead of scattered
// hard-coded values. Panel states keep their own keys (CollapsiblePanel);
// this module owns editor-behaviour defaults only.
import type { TransitionType } from '../types';

export interface CutlabSettings {
  /** Timeline snapping starts ON for new sessions when true. */
  snapDefault: boolean;
  /** Canvas a brand-new project starts with. */
  defaultCanvas: '9:16' | '16:9' | '1:1';
  /** Transition pre-applied to clips added from the media bin ('cut' = none). */
  defaultTransition: TransitionType;
  defaultTransitionDur: number;
  /** Last house text preset used — new text clips inherit it (H.15). */
  lastTextStyle?: string;
}

export const CANVAS_PRESETS: Record<CutlabSettings['defaultCanvas'], { w: number; h: number }> = {
  '9:16': { w: 720, h: 1280 },
  '16:9': { w: 1280, h: 720 },
  '1:1': { w: 960, h: 960 },
};

const KEY = 'cutlab.settings';

export const DEFAULT_SETTINGS: CutlabSettings = {
  snapDefault: true,
  defaultCanvas: '9:16',
  defaultTransition: 'cut',
  defaultTransitionDur: 0.25,
};

export function loadSettings(): CutlabSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<CutlabSettings>;
    return {
      snapDefault: typeof parsed.snapDefault === 'boolean' ? parsed.snapDefault : DEFAULT_SETTINGS.snapDefault,
      defaultCanvas: parsed.defaultCanvas && parsed.defaultCanvas in CANVAS_PRESETS ? parsed.defaultCanvas : DEFAULT_SETTINGS.defaultCanvas,
      defaultTransition: typeof parsed.defaultTransition === 'string' ? (parsed.defaultTransition as TransitionType) : DEFAULT_SETTINGS.defaultTransition,
      defaultTransitionDur: typeof parsed.defaultTransitionDur === 'number' && parsed.defaultTransitionDur > 0 ? parsed.defaultTransitionDur : DEFAULT_SETTINGS.defaultTransitionDur,
      lastTextStyle: typeof parsed.lastTextStyle === 'string' ? parsed.lastTextStyle : undefined,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: CutlabSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings live for this session only */
  }
}

/** The transition fields a newly added clip starts with, per settings. */
export function defaultTransitionFields(): { transitionIn: TransitionType | null; transitionDur: number } {
  const s = loadSettings();
  return {
    transitionIn: s.defaultTransition === 'cut' ? null : s.defaultTransition,
    transitionDur: s.defaultTransitionDur,
  };
}

/** Ask a CollapsiblePanel (by its storageKey) to toggle open/closed. */
export function togglePanel(storageKey: string): void {
  window.dispatchEvent(new CustomEvent('cutlab:toggle-panel', { detail: { key: storageKey } }));
}
export const PANEL_KEYS = { media: 'cutlab.panel.media', inspector: 'cutlab.panel.inspector' } as const;
