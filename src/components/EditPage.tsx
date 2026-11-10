/**
 * The Edit page layout (redesign §2): bin + viewer stack + inspector
 * on desktop, zone tabs on phone. Extracted from App.tsx verbatim for
 * the P8 lazy split (2026-11-06) — it is the editor's default page,
 * so it ships inside the editor-shell chunk; the other four pages
 * load on demand.
 */
import CollapsiblePanel from './CollapsiblePanel';
import MediaBin from './MediaBin';
import Inspector from './Inspector';
import Preview from './Preview';
import Timeline from './Timeline';
import ZoneTabs from './ZoneTabs';
import ViewerStack, { TIMELINE_KEY } from './ViewerStack';

export default function EditPage({
  phone,
  focusPin,
  dockOpen,
  onSplitExitFocus,
  zone,
  onZoneChange,
}: {
  phone: boolean;
  focusPin: boolean;
  dockOpen: boolean;
  onSplitExitFocus: () => void;
  zone: string;
  onZoneChange: (z: string) => void;
}) {
  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ZoneTabs label="Edit zones" active={zone} onChange={onZoneChange} zones={[
          { id: 'bin', label: 'Bin' }, { id: 'stage', label: 'Stage' },
          { id: 'inspector', label: 'Inspector' }, { id: 'timeline', label: 'Timeline' },
        ]} />
        {zone === 'bin' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto"><MediaBin mode="compact" /></div>
        )}
        {zone === 'stage' && (
          <div className="flex min-h-0 flex-1 flex-col"><Preview /></div>
        )}
        {zone === 'inspector' && (
          <div className="min-h-0 flex-1 overflow-y-auto"><Inspector /></div>
        )}
        {zone === 'timeline' && (
          <div className="flex min-h-0 flex-1 flex-col"><Timeline /></div>
        )}
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 flex-1">
      <CollapsiblePanel side="left" panelWidth={248} storageKey="cutlab.panel.media" label="Media">
        <MediaBin mode="compact" />
      </CollapsiblePanel>
      <ViewerStack splitKey={TIMELINE_KEY} migrate focusPin={focusPin} dockOpen={dockOpen}
        onSplitExitFocus={onSplitExitFocus} />
      <CollapsiblePanel side="right" panelWidth={264} storageKey="cutlab.panel.inspector" label="Inspector">
        <Inspector />
      </CollapsiblePanel>
    </div>
  );
}
