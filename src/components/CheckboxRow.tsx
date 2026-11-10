/**
 * CHECKBOX ROW — canonical checklist primitive (UI ADOPTION
 * 2026-11-06, pattern studied from the Antigravity remake's
 * SettingsModal rows; code ours). Label + one-line description on
 * the left, a RED square box with a white check on the right,
 * hairline dividers between rows (.checkbox-row in index.css drops
 * the last row's rule inside a list container).
 *
 * Use where a CHECKBOX is the honest control — multi-select lists
 * (extra export formats, paste-attribute groups). Single on/off
 * settings stay on the Study-Home glass <Switch>: a switch says
 * "this takes effect", a checkbox says "this is included".
 */

interface RowProps {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export default function CheckboxRow({ label, description, checked, onChange, disabled }: RowProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="checkbox-row group flex w-full items-center justify-between gap-3 py-2.5 text-left disabled:cursor-default disabled:opacity-45"
    >
      <span className="min-w-0">
        <span className="block text-[13px] font-medium leading-tight text-[#ececec]">{label}</span>
        {description && (
          <span className="block pt-0.5 text-[11.5px] leading-snug text-[#a8a8a8]">{description}</span>
        )}
      </span>
      <span
        aria-hidden
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
          checked
            ? 'border-[#a50d00] bg-[#e31000]'
            : 'border-[#555] bg-[#2a2a2a] group-hover:border-[#707070]'
        }`}
      >
        {checked && (
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="#fff"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6.4 4.8 9 10 3.2" />
          </svg>
        )}
      </span>
    </button>
  );
}
