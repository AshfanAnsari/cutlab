/** ZoneTabs (§5): the phone layout's per-page zone switcher.
 *  One zone is visible at a time under 900 px; targets ≥ 36 px. */
export default function ZoneTabs({ zones, active, onChange, label }: {
  zones: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[#3a3a3a] bg-[#1b1b1b] px-2 py-1.5" role="tablist" aria-label={label}>
      {zones.map((z) => (
        <button key={z.id} role="tab" aria-selected={active === z.id}
          className={'min-h-[36px] shrink-0 rounded px-3 text-[13px] ' + (active === z.id
            ? 'bg-[#2A2A2A] font-semibold text-[#ececec]'
            : 'text-[#a8a8a8]')}
          onClick={() => onChange(z.id)}>
          {z.label}
        </button>
      ))}
    </div>
  );
}
