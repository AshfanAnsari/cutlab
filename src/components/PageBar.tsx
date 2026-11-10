import { useSyncExternalStore } from 'react';
import { getPage, setPage, subscribePage, PAGES, type PageId } from '../services/pages';
import { store, useStore } from '../state/store';

/**
 * PageBar (UI redesign §2.1/§3.2): the 34 px page bar at the very
 * bottom of the app frame — Media · Edit · Colour · Audio · Deliver.
 * Five original line glyphs; the active entry is a raised panel2
 * chip (deliberately NOT red — §4.3 rations the accent and a
 * permanent navigation indicator is not on the list). Switching is
 * instant. During a nest session every page except Edit dims to the
 * standard disabled opacity and a press answers with the nest toast
 * (§2.7).
 */
const GLYPHS: Record<PageId, React.ReactNode> = {
  // film frame with sprockets
  media: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M8 5v14M16 5v14M3 9.5h5M3 14.5h5M16 9.5h5M16 14.5h5" />
    </>
  ),
  // timeline blocks on a baseline
  edit: (
    <>
      <path d="M3 17h18" />
      <rect x="3" y="6" width="7" height="5" rx="1" />
      <rect x="12" y="6" width="9" height="5" rx="1" />
      <path d="M6 13.5v3M17 13.5v3" />
    </>
  ),
  // colour wheel: disc + half
  colour: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" />
      <circle cx="12" cy="12" r="1.4" />
    </>
  ),
  // waveform bars
  audio: (
    <>
      <path d="M4 9v6M8 6v12M12 3.5v17M16 6v12M20 9v6" />
    </>
  ),
  // tray + up arrow (out for delivery)
  deliver: (
    <>
      <path d="M3 14v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
      <path d="M12 3v11M7.5 7.5 12 3l4.5 4.5" />
    </>
  ),
};

export default function PageBar() {
  const page = useSyncExternalStore(subscribePage, getPage);
  const nest = !!useStore((s) => s.nestSession);
  const go = (p: PageId) => {
    if (nest && p !== 'edit') {
      store.toastMsg('info', 'Finish the nest edit first — use “Done” above the timeline.');
      return;
    }
    setPage(p);
  };
  return (
    <nav aria-label="Editor pages"
      className="flex h-[34px] shrink-0 items-stretch justify-center gap-1 border-t border-[#3a3a3a] bg-[#161616] px-2">
      {PAGES.map((p) => {
        const active = page === p.id;
        const disabled = nest && p.id !== 'edit';
        return (
          <button key={p.id} onClick={() => go(p.id)} aria-current={active ? 'page' : undefined}
            aria-disabled={disabled || undefined}
            className="flex items-center gap-1.5 rounded-md px-3 text-[12px]"
            style={{
              color: active ? '#ececec' : '#a8a8a8',
              background: active ? '#2a2a2a' : 'transparent',
              opacity: disabled ? 0.45 : 1,
              margin: '4px 0',
            }}
            onMouseEnter={(e) => { if (!active) e.currentTarget.style.color = '#ececec'; }}
            onMouseLeave={(e) => { if (!active) e.currentTarget.style.color = '#a8a8a8'; }}
            title={`Switch to the ${p.label} page`}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {GLYPHS[p.id]}
            </svg>
            {p.label}
          </button>
        );
      })}
    </nav>
  );
}
