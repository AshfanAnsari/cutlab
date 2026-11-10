import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Collapsible side panel: wraps a fixed-width panel (MediaBin, Inspector).
// The open state persists per panel in localStorage and is restored on
// reload; open panels keep their drag-resize splitter (5px).
//
// DAVINCI PASS 2026-11-06 (user verdict 18:55 IST: "dont give too much
// space, just small button at the top will do, like in da vinci?"): the
// old full-height 22px collapse BAR is gone. A collapsed panel now
// reserves ZERO width — the centre surface reclaims everything — and
// the toggle is ONE small (26px) chevron button floating in the top
// corner of the CENTRE surface on this panel's side: closed, it sits
// 6px from the page edge; open, it rides the collapse animation at
// (panel width + splitter + 6px), so it never covers panel content
// and never moves off the centre's corner. It is absolutely
// positioned against the page root (callers render `relative` roots),
// so it consumes no layout space in either state. It hangs 36px
// below the page top — under the pages' own ~28px header strips
// (viewer strip / bin toolbar), whose first and last controls it
// would otherwise cover (QA finding, same day: the strip's clip
// name and Fullscreen button sat under the button at top-1.5).
//
// Layout contract: renders flex children into the caller's flex row —
// the clipping box (animated width, fixed-width content inside so the
// panel clips instead of squishing) and the resize handle — plus the
// absolutely-positioned toggle button.

interface Props {
  side: 'left' | 'right';
  /** px width of the wrapped panel when open (matches its own w-[…px]). */
  panelWidth: number;
  /** localStorage key holding 'open' | 'closed' for this panel. */
  storageKey: string;
  /** Panel name for aria labels and the collapsed rail caption, e.g. 'Media'. */
  label: string;
  children: ReactNode;
}

function readOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== 'closed';
  } catch {
    return true; // storage unavailable (private mode): default open
  }
}

const WIDTH_MIN = 200;
const WIDTH_MAX = 420;

function readWidth(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key + '.w'));
    return Number.isFinite(v) && v >= WIDTH_MIN && v <= WIDTH_MAX ? Math.floor(v) : fallback;
  } catch {
    return fallback;
  }
}

export default function CollapsiblePanel({ side, panelWidth, storageKey, label, children }: Props) {
  const [open, setOpen] = useState<boolean>(() => readOpen(storageKey));
  // §3.4 (UI redesign W5): drag-resize — width persists per panel
  // (the storageKey is already per page where pages have rails);
  // double-click resets to the panel's default width.
  const [width, setWidth] = useState<number>(() => readWidth(storageKey, panelWidth));
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey + '.w', String(width));
    } catch {
      /* storage unavailable */
    }
  }, [storageKey, width]);

  const clampW = (w: number) => Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, w)));

  const onHandlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = width;
    const move = (ev: PointerEvent) =>
      setWidth(clampW(startW + (side === 'left' ? ev.clientX - startX : startX - ev.clientX)));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onHandleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      setWidth((w) => clampW(w + (side === 'left' ? dir : -dir) * 8));
    }
  };

  const handle = open ? (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} panel`}
      title="Drag to resize — double-click resets"
      tabIndex={0}
      onPointerDown={onHandlePointerDown}
      onDoubleClick={() => setWidth(panelWidth)}
      onKeyDown={onHandleKeyDown}
      className="w-[5px] shrink-0 cursor-col-resize touch-none bg-transparent hover:bg-[#3a3a3a] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#e31000]"
    />
  ) : null;

  useEffect(() => {
    if (focusDriven.current) {
      focusDriven.current = false;
      return; // focus mode borrows the layout; it never persists it
    }
    try {
      localStorage.setItem(storageKey, open ? 'open' : 'closed');
    } catch {
      /* storage unavailable: state lives for this session only */
    }
  }, [storageKey, open]);

  // External toggle requests (View menu → services/settings.togglePanel).
  useEffect(() => {
    const handler = (e: Event) => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key;
      if (key === storageKey) setOpen((v) => !v);
    };
    window.addEventListener('cutlab:toggle-panel', handler);
    return () => window.removeEventListener('cutlab:toggle-panel', handler);
  }, [storageKey]);

  // Viewer focus mode (D2.7): collapse for the duration, then restore
  // the EXACT pre-focus state. Focus-driven changes never write the
  // persisted key — the user's saved layout is not focus's to change.
  const preFocusOpen = useRef<boolean | null>(null);
  const focusDriven = useRef(false);
  useEffect(() => {
    const handler = (e: Event) => {
      const f = (e as CustomEvent<{ focus?: boolean }>).detail?.focus;
      if (f) {
        if (preFocusOpen.current === null) preFocusOpen.current = open;
        focusDriven.current = true;
        setOpen(false);
      } else if (preFocusOpen.current !== null) {
        const restore = preFocusOpen.current;
        preFocusOpen.current = null;
        focusDriven.current = true;
        setOpen(restore);
      }
    };
    window.addEventListener('cutlab:focus-mode', handler);
    return () => window.removeEventListener('cutlab:focus-mode', handler);
  }, [open ]);

  // The chevron points the way the panel travels on click: a left panel
  // collapses toward the left edge, a right panel toward the right edge.
  const chevron = side === 'left' ? (open ? '‹' : '›') : open ? '›' : '‹';
  const action = open ? 'Collapse' : 'Expand';

  // The DaVinci toggle: one small button in the top corner of the
  // CENTRE surface. Its inset from the page edge is the panel's own
  // footprint when open (width + 5px splitter + 6px), 6px when
  // closed; it transitions with the same 200ms as the width clip
  // (frozen mid-drag, like the clip box, and still under reduced
  // motion via the global media rule on transitions).
  const inset = open ? width + 5 + 6 : 6;
  const toggle = (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      aria-label={`${action} ${label} panel`}
      title={`${action} ${label} panel`}
      data-testid={`panel-toggle-${label.toLowerCase()}`}
      className={
        'absolute top-9 z-30 grid h-[26px] w-[26px] cursor-pointer place-items-center rounded-md border border-[#3a3a3a] bg-[#2a2a2a]/90 text-[15px] leading-none text-[#a8a8a8] shadow-md backdrop-blur-sm hover:bg-[#333333] hover:text-[#ececec] focus-visible:outline-2 focus-visible:outline-[#e31000] ' +
        (resizing ? '' : 'transition-[left,right] duration-200 ease-in-out motion-reduce:transition-none')
      }
      style={side === 'left' ? { left: inset } : { right: inset }}
    >
      <span aria-hidden>{chevron}</span>
    </button>
  );

  const panel = (
    <div
      className={'shrink-0 overflow-hidden ' + (resizing ? '' : 'transition-[width] duration-200 ease-in-out motion-reduce:transition-none')}
      style={{ width: open ? width : 0 }}
    >
      {/* Fixed inner width: during the animation the panel is clipped, not
          reflowed. visibility:hidden while closed also removes the hidden
          panel's controls from the tab order. */}
      <div className={'flex h-full ' + (open ? '' : 'invisible')} style={{ width }}>
        {children}
      </div>
    </div>
  );

  // Flow children: the clipping box + (open only) the resize splitter.
  // The toggle floats above the centre surface — no reserved width in
  // either state (the DaVinci pass above).
  return side === 'left' ? (
    <>
      {panel}
      {handle}
      {toggle}
    </>
  ) : (
    <>
      {toggle}
      {handle}
      {panel}
    </>
  );
}
