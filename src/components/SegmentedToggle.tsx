import { useLayoutEffect, useRef, useState } from 'react';

/**
 * SEGMENTED TOGGLE — canonical multi-choice primitive (UI ADOPTION
 * 2026-11-06, values studied from the Antigravity remake's
 * SegmentedToggle; code ours). A pill track with ONE sliding Signal
 * Red segment; each option is a label plus an optional tiny mono
 * sub-label chip (the remake's "tag"). For 2–4 option sets where
 * every choice deserves to be visible — canvas presets, export
 * container/codec — never for long lists (those stay <select>).
 *
 * The thumb is measured from the active button and slid with the
 * house spring curve (the Study-Home switch's
 * cubic-bezier(.6,-0.1,.2,1.25)); under prefers-reduced-motion the
 * segment jumps with no travel (.seg-thumb in index.css).
 * Radio semantics: role=radiogroup + role=radio buttons, arrow keys
 * move the choice like a native radio group.
 */

export interface SegmentedOption {
  value: string;
  label: string;
  /** Tiny mono chip beside the label, e.g. a dimension or a gloss. */
  sub?: string;
}

interface Props {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Stretch segments to fill the track width equally. */
  stretch?: boolean;
  size?: 'md' | 'sm';
  className?: string;
}

export default function SegmentedToggle({
  options, value, onChange, ariaLabel, stretch, size = 'md', className = '',
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);

  const activeIdx = Math.max(0, options.findIndex((o) => o.value === value));

  const measure = () => {
    const btn = btnRefs.current[activeIdx];
    const track = trackRef.current;
    if (!btn || !track) return;
    const tb = track.getBoundingClientRect();
    const bb = btn.getBoundingClientRect();
    setThumb({ x: bb.left - tb.left, w: bb.width });
  };

  useLayoutEffect(measure, [activeIdx, options, stretch, size]);
  useLayoutEffect(() => {
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, options]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const next = (activeIdx + dir + options.length) % options.length;
    onChange(options[next].value);
    btnRefs.current[next]?.focus();
  };

  const pad = size === 'sm' ? 'px-3 py-1 text-[12px]' : 'px-4 py-1.5 text-[13px]';

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={`relative inline-flex items-center rounded-full border border-[#3a3a3a] bg-[#212121]/90 p-[5px] shadow-[0_10px_30px_rgba(0,0,0,0.35)] backdrop-blur-md ${stretch ? 'flex w-full' : ''} ${className}`}
    >
      {thumb && (
        <span
          aria-hidden
          className="seg-thumb absolute bottom-[5px] top-[5px] rounded-full bg-[#e31000] shadow-[0_4px_14px_rgba(227,16,0,0.35)]"
          style={{ transform: `translateX(${thumb.x - 5}px)`, width: thumb.w, left: 5 }}
        />
      )}
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => { btnRefs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(opt.value)}
            className={`relative z-10 flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-colors ${pad} ${stretch ? 'flex-1' : ''} ${active ? 'text-white' : 'text-[#a8a8a8] hover:text-white'}`}
          >
            <span>{opt.label}</span>
            {opt.sub && (
              <span
                className={`rounded-full px-1.5 py-px font-mono text-[9.5px] leading-[1.5] ${active ? 'bg-black/30 text-white' : 'bg-[#2a2a2a] text-[#8f8f8f]'}`}
              >
                {opt.sub}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
