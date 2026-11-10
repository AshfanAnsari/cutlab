/**
 * ViewerStack: Preview + the App split handle + Timeline (the D2.7
 * arrangement), parameterised by its persisted split key so Edit and
 * Deliver keep independent splits (§2.7/§3.5). Focus pinning (the
 * timeline at its minimum) is Edit-only — the caller passes
 * focusPin=false everywhere else.
 *
 * Moved out of App.tsx verbatim for the P8 lazy split (2026-11-06);
 * EditPage and the editor shell's Deliver viewer both import it from
 * here so the shared viewer lands in exactly one chunk.
 */
import { useEffect, useRef, useState } from 'react';
import Preview from './Preview';
import Timeline from './Timeline';
import { clamp } from '../utils/time';

// Timeline height: the preview viewer's height is whatever the timeline
// does not take, so the split between them is user-adjustable (drag handle
// in App, persisted).
//
// TIMELINE SECTION 2026-11-06: the D2.7 viewer-first default (190 px,
// 21% of a 900 px page) left the timeline — the core editing surface —
// the smallest region on the Edit page. Resolve's Edit page and
// Premiere's Editing workspace both give the timeline the dominant
// lower share (~lower half / dominant lower panel, user-resizable), so
// the Edit default is now 392 px: 43.6% of a 1400×900 page, 36.3% of
// 1920×1080 — inside the 35–45% target band at both. The stage
// letterboxes smaller in its column, exactly as Resolve's does.
// TIMELINE_MIN is a hard floor sized from the timeline's own anatomy
// (toolbar 35 + ruler 24 + V/A/T lanes 44+44+40 + borders/headroom)
// so no future chrome can crush the section below three full lanes
// again; the v3 flag migrates a saved small height ONCE, after which
// the user's own drags rule again. Deliver keeps its own compact
// default (its layout is form/queue-led) — set AT the floor, since
// effTimelineH enforces TIMELINE_MIN on every stack anyway.
export const TIMELINE_DEFAULT = 392;
export const TIMELINE_DEFAULT_DELIVER = 204;
export const TIMELINE_MIN = 204;
/** Preview must always keep room for a usable stage + transport + handle. */
const PREVIEW_MIN = 220;
export const TIMELINE_KEY = 'cutlab.timelineH';
const TIMELINE_MIGRATED_KEY = 'cutlab.timelineH.v2';
const TIMELINE_MIGRATED_KEY_V3 = 'cutlab.timelineH.v3';

function readTimelineH(key: string = TIMELINE_KEY, migrate = true, defaultH: number = TIMELINE_DEFAULT): number {
  try {
    if (migrate && !localStorage.getItem(TIMELINE_MIGRATED_KEY)) {
      localStorage.setItem(TIMELINE_MIGRATED_KEY, '1');
      localStorage.setItem(TIMELINE_MIGRATED_KEY_V3, '1');
      localStorage.setItem(TIMELINE_KEY, String(TIMELINE_DEFAULT));
      return TIMELINE_DEFAULT;
    }
    if (migrate && !localStorage.getItem(TIMELINE_MIGRATED_KEY_V3)) {
      localStorage.setItem(TIMELINE_MIGRATED_KEY_V3, '1');
      localStorage.setItem(TIMELINE_KEY, String(TIMELINE_DEFAULT));
      return TIMELINE_DEFAULT;
    }
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v >= TIMELINE_MIN ? Math.floor(v) : defaultH;
  } catch {
    return defaultH;
  }
}

export default function ViewerStack({ splitKey, migrate = false, defaultH = TIMELINE_DEFAULT, focusPin, dockOpen, onSplitExitFocus }: {
  splitKey: string;
  migrate?: boolean;
  defaultH?: number;
  focusPin: boolean;
  dockOpen: boolean;
  onSplitExitFocus: () => void;
}) {
  const [timelineH, setTimelineH] = useState<number>(() => readTimelineH(splitKey, migrate, defaultH));
  const [splitDragging, setSplitDragging] = useState(false);
  const colRef = useRef<HTMLDivElement>(null);

  // D2.7: focus mode pins the timeline to its minimum (the user's own
  // height is untouched and returns on restore); the scopes dock
  // takes its height from the timeline first, to the same minimum.
  const DOCK_H = 92;
  const effTimelineH = focusPin
    ? TIMELINE_MIN
    : Math.max(TIMELINE_MIN, timelineH - (dockOpen ? DOCK_H : 0));

  useEffect(() => {
    try {
      localStorage.setItem(splitKey, String(timelineH));
    } catch {
      /* storage unavailable: height lives for this session only */
    }
  }, [timelineH, splitKey]);

  const clampTimelineH = (h: number, maxOverride?: number) => {
    const col = colRef.current;
    const max = maxOverride ?? (col ? Math.max(TIMELINE_MIN, col.clientHeight - PREVIEW_MIN) : 640);
    return Math.round(clamp(h, TIMELINE_MIN, max));
  };

  const onSplitPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (focusPin) onSplitExitFocus(); // dragging the split exits focus
    setSplitDragging(true);
    const startY = e.clientY;
    const startH = timelineH;
    // Perf (TIMELINE SECTION probe, 2026-11-06): the naive handler
    // re-rendered the whole ViewerStack (Preview stage + Timeline)
    // on EVERY pointermove and read col.clientHeight each time — a
    // layout read after the previous move's height write, i.e.
    // forced sync layout per move (87 long tasks in one scripted
    // drag). The column height cannot change mid-drag, so the max
    // is captured ONCE here, and moves are rAF-coalesced to at most
    // one application per frame; pointerup flushes the exact final
    // position before the listeners come off.
    const col = colRef.current;
    const startMax = col ? Math.max(TIMELINE_MIN, col.clientHeight - PREVIEW_MIN) : 640;
    let pendingY: number | null = null;
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (pendingY == null) return;
      const y = pendingY;
      pendingY = null;
      setTimelineH(clampTimelineH(startH + (startY - y), startMax));
    };
    const move = (ev: PointerEvent) => {
      pendingY = ev.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      apply();
      setSplitDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onSplitKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setTimelineH((h) => clampTimelineH(h + 16));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setTimelineH((h) => clampTimelineH(h - 16));
    }
  };

  return (
    <div ref={colRef} className="flex min-w-0 flex-1 flex-col">
      <Preview />
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline"
        title="Drag to resize the timeline — double-click resets"
        data-testid="timeline-split"
        tabIndex={0}
        onPointerDown={onSplitPointerDown}
        onDoubleClick={() => setTimelineH(defaultH)}
        onKeyDown={onSplitKeyDown}
        className="flex h-[7px] shrink-0 cursor-row-resize touch-none items-center justify-center bg-[#161616] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#e31000]"
      >
        <span aria-hidden className="h-[3px] w-10 rounded-full bg-[#4a4a4a]" />
      </div>
      <div
        className={'shrink-0 ' + (splitDragging ? '' : 'transition-[height] duration-200 ease-in-out motion-reduce:transition-none')}
        style={{ height: effTimelineH, maxHeight: `calc(100% - ${PREVIEW_MIN}px)` }}
      >
        <Timeline />
      </div>
    </div>
  );
}
