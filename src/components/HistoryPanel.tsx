// History panel (S.2): the labelled step list. Clicking a step jumps the
// project straight to that state — snapshots are full states, so a jump is
// stack arithmetic, not a replay.
import { store, useStore } from '../state/store';

export default function HistoryPanel({ onClose }: { onClose: () => void }) {
  useStore((s) => s.project); // re-render on project change
  const { entries, current } = store.historyInfo();
  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="modal-panel w-[380px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
          <span className="text-[18px] font-semibold">History</span>
          <button className="btn icon" onClick={onClose}>×</button>
        </div>
        <div className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto px-3 py-3">
          <button
            className={'flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] ' + (current === 0 ? 'bg-[#333] text-white' : 'text-[#a8a8a8] hover:bg-[#2a2a2a]')}
            onClick={() => store.jumpHistory(0)}>
            <span className="font-mono text-[11px] text-[#6f6f6f]">0</span> Project opened / session start
          </button>
          {entries.map((e) => (
            <button key={e.state}
              className={'flex items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] ' +
                (current === e.state ? 'bg-[#333] text-white' : e.undone ? 'text-[#6f6f6f] hover:bg-[#2a2a2a]' : 'text-[#c9c9c9] hover:bg-[#2a2a2a]')}
              onClick={() => store.jumpHistory(e.state)}>
              <span className="font-mono text-[11px] text-[#6f6f6f]">{e.state}</span>
              <span className="flex-1">{e.label}</span>
              {current === e.state && <span className="text-[11px] text-[#C0C0C0]">● now</span>}
              {e.undone && <span className="text-[11px]">undone</span>}
            </button>
          ))}
          {entries.length === 0 && (
            <p className="px-2 text-[12px] text-[#a8a8a8]">No edits yet this session.</p>
          )}
          <p className="mt-1 px-2 text-[11px] leading-snug text-[#a8a8a8]">
            History covers project changes (up to 100 steps); view settings and
            selection aren't undoable (S.3, by design).
          </p>
          <div className="flex gap-2 px-2 pt-1">
            <button className="btn small" disabled={!store.canUndo()} onClick={() => store.undo()}>Undo</button>
            <button className="btn small" disabled={!store.canRedo()} onClick={() => store.redo()}>Redo</button>
          </div>
        </div>
      </div>
    </div>
  );
}
