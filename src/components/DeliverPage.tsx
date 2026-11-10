import type { ReactNode } from 'react';
import { useState } from 'react';
import { ExportForm, RenderQueue } from './ExportPanel';
import ZoneTabs from './ZoneTabs';
import { useNarrow } from '../services/useNarrow';
import { CoverForm } from './CoverMaker';

/**
 * Deliver page (§2.6): the export/cover forms as a standing left
 * column (two tabs, one red CTA visible per tab), the viewer +
 * timeline centre, and the render queue as the right column.
 * The Export dialog keeps its summary + a door to this page.
 */
export default function DeliverPage({ viewer }: { viewer: ReactNode }) {
  const [tab, setTab] = useState<'export' | 'cover'>('export');
  const phone = useNarrow();
  const [zone, setZone] = useState('form');
  const formCol = (
    <>
      <div className="flex shrink-0 gap-4 border-b border-[#3a3a3a] px-3 pt-2" role="tablist" aria-label="Deliver tools">
        {(['export', 'cover'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t}
            className={'border-b-2 px-0.5 pb-1.5 text-[13px] ' + (tab === t
              ? 'border-[#C0C0C0] font-semibold text-[#ececec]'
              : 'border-transparent text-[#a8a8a8] hover:text-[#ececec]')}
            onClick={() => setTab(t)}>
            {t === 'export' ? 'Export' : 'Cover'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {tab === 'export' ? <ExportForm /> : <CoverForm />}
      </div>
    </>
  );

  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ZoneTabs label="Deliver zones" active={zone} onChange={setZone} zones={[
          { id: 'form', label: 'Form' }, { id: 'viewer', label: 'Viewer' }, { id: 'queue', label: 'Queue' },
        ]} />
        {zone === 'form' && <div className="flex min-h-0 flex-1 flex-col bg-[#212121]">{formCol}</div>}
        {zone === 'viewer' && viewer}
        {zone === 'queue' && (
          <div className="flex min-h-0 flex-1 flex-col bg-[#212121] px-3 py-3"><RenderQueue /></div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[360px] shrink-0 flex-col border-r border-[#3a3a3a] bg-[#212121]">
        {formCol}
      </div>
      {viewer}
      <div className="flex w-[300px] shrink-0 flex-col border-l border-[#3a3a3a] bg-[#212121] px-3 py-3">
        <RenderQueue />
      </div>
    </div>
  );
}
