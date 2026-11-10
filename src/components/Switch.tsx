import { useEffect, useState, type ReactNode } from 'react';

/**
 * Switch — THE canonical boolean control for CutLab (TOGGLE PORT
 * 2026-11-06, user directive: "some toggles were really good — use
 * them"). Ported from the Study Home Glass Toggle
 * (neet-site/app/src/components/ui.tsx): a pill track, a pearl ball
 * that slides with an overshoot spring cubic-bezier(.6,-0.1,.2,1.25),
 * a sheen sweep across the track on toggle, and a check mark that
 * draws itself in (stroke-dashoffset) when ON.
 *
 * Re-skinned to CutLab P1: charcoal/silver only — OFF is the neutral
 * panel surface, ON is the source's dark #161617 track. Signal Red
 * #E31000 appears in exactly ONE detail: the drawn check. No lavender,
 * no glass. Every boolean control in the app uses this primitive —
 * never re-implement a toggle per page (house structure rule).
 *
 * Behaviour: native <button> (Space/Enter work), role="switch" +
 * aria-checked (+ aria-pressed for parity with the old toggle
 * buttons), the global Signal Red :focus-visible ring, a disabled
 * state at the app's 0.45 standard, and prefers-reduced-motion:
 * no spring, no sheen, no draw — the state change is instant.
 *
 * Sizes: lg is the source's small variant verbatim (58×27, ball 21);
 * md (46×25, ball 19) is the form-row size; sm (36×20, ball 14) is
 * for dense strips (viewer strip, toolbar chips).
 */

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
    catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); }
    catch { return; }
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

const SIZES = {
  sm: { w: 36, h: 20, ball: 14, check: 8 },
  md: { w: 46, h: 25, ball: 19, check: 10 },
  lg: { w: 58, h: 27, ball: 21, check: 11 },
} as const;

export type SwitchSize = keyof typeof SIZES;

export default function Switch({
  checked,
  onChange,
  size = 'md',
  label,
  disabled = false,
  title,
  ariaLabel,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  size?: SwitchSize;
  /** Optional text rendered beside the track; clicking it toggles too. */
  label?: ReactNode;
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const s = SIZES[size];
  const anim = reduced ? 'none' : undefined;
  const toggle = () => { if (!disabled) onChange(!checked); };

  const track = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-pressed={checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      title={title}
      disabled={disabled}
      onClick={toggle}
      className="relative flex-none overflow-hidden rounded-full"
      style={{
        width: s.w,
        height: s.h,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        border: `1px solid ${checked ? '#4d4d4d' : '#454545'}`,
        background: checked ? '#161617' : '#262626',
        boxShadow: checked
          ? 'inset 2px 2px 6px rgba(0,0,0,.5), inset -2px -2px 5px rgba(255,255,255,.08), 0 2px 6px rgba(0,0,0,.35)'
          : 'inset 2px 2px 5px rgba(0,0,0,.4), inset -2px -2px 4px rgba(255,255,255,.06), 0 2px 6px rgba(0,0,0,.25)',
        transition: anim ?? 'background .3s ease, border-color .3s ease',
        padding: 0,
      }}
    >
      {/* sheen sweep — travels across the track on every toggle */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'linear-gradient(115deg, transparent 30%, rgba(255,255,255,.35) 48%, transparent 62%)',
          transform: checked ? 'translateX(60%)' : 'translateX(-120%)',
          transition: anim ?? 'transform .7s ease',
        }}
      />
      {/* pearl ball — spring slide; the check draws itself in when ON,
          in Signal Red: the one red detail on this component */}
      <span
        aria-hidden
        className="absolute top-1/2 flex items-center justify-center rounded-full"
        style={{
          width: s.ball,
          height: s.ball,
          left: checked ? s.w - s.ball - 3 : 3,
          transform: 'translateY(-50%)',
          border: '1px solid rgba(255,255,255,.18)',
          background: 'radial-gradient(circle at 32% 30%, #FFFFFF, #D9D9DE)',
          boxShadow: '0 2px 6px rgba(0,0,0,.45), inset 0 -2px 4px rgba(17,18,20,.18)',
          transition: anim ?? 'left .5s cubic-bezier(.6,-0.1,.2,1.25)',
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width={s.check}
          height={s.check}
          fill="none"
          stroke="#E31000"
          strokeWidth="3.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: 26,
            strokeDashoffset: checked ? 0 : 26,
            transition: anim ?? 'stroke-dashoffset .3s ease .15s',
          }}
        >
          <path d="M5 12.5 L10 17.5 L19 7" />
        </svg>
      </span>
    </button>
  );

  if (label === undefined) return track;
  return (
    <span className="inline-flex items-center gap-2">
      {track}
      <span
        onClick={toggle}
        style={{ cursor: disabled ? 'default' : 'pointer', userSelect: 'none' }}
      >
        {label}
      </span>
    </span>
  );
}
