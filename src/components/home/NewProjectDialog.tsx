import { useEffect, useState } from 'react';
import { loadSettings } from '../../services/settings';

/**
 * NEW PROJECT DIALOG — HOME PORT 2026-11-06. The remake's
 * NewProjectModal (components/modals/NewProjectModal.tsx) copied
 * field-for-field: name input, the 2×2 canvas preset cards with his
 * names + dimensions (16:9 1920×1080, 9:16 1080×1920, 1:1 1080×1080,
 * 21:9 2560×1080), the 24/30/60 fps pill row, Cancel / Create
 * Sequence. Two house differences, both deliberate:
 *  - the surface is the app's glass modal token (.modal-overlay /
 *    .modal-panel — the grammar the earlier adoption took FROM his
 *    modals), not his flat panel, so it matches every other dialog
 *    in this app;
 *  - the preset that starts selected is the user's saved default
 *    canvas (Settings), falling back to his 16:9 default.
 * Creation is real: name + canvas dims + fps land on the project
 * (services/projectLifecycle.createProjectCustom via App).
 */

export interface NewProjectSpec {
  name: string;
  w: number;
  h: number;
  fps: number;
}

const PRESETS: { id: string; name: string; dim: string; w: number; h: number }[] = [
  { id: '16:9', name: 'YouTube / Widescreen', dim: '1920 × 1080', w: 1920, h: 1080 },
  { id: '9:16', name: 'TikTok / Reel / Shorts', dim: '1080 × 1920', w: 1080, h: 1920 },
  { id: '1:1', name: 'Square Feed', dim: '1080 × 1080', w: 1080, h: 1080 },
  { id: '21:9', name: 'Cinematic Anamorphic', dim: '2560 × 1080', w: 2560, h: 1080 },
];

export default function NewProjectDialog({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (spec: NewProjectSpec) => void;
}) {
  const [name, setName] = useState('Untitled Sequence');
  const [aspect, setAspect] = useState<string>(() => {
    const d = loadSettings().defaultCanvas;
    return PRESETS.some((p) => p.id === d) ? d : '16:9';
  });
  const [fps, setFps] = useState(30);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const preset = PRESETS.find((p) => p.id === aspect) ?? PRESETS[0];
    onCreate({ name: name.trim() || 'Untitled project', w: preset.w, h: preset.h, fps });
  };

  return (
    <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="modal-panel w-full max-w-[520px] p-6 focus:outline-none"
        role="dialog" aria-modal="true" aria-label="New Project"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-[17px] font-semibold text-[#ececec]">New Project</div>
        <p className="pt-1 text-[13px] text-[#a8a8a8]">
          Configure your canvas size, framerate, and initial timeline settings.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div>
            <label htmlFor="np-name" className="block text-[12px] font-medium text-[#a8a8a8]">
              Project Name
            </label>
            <input
              id="np-name"
              data-testid="np-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-[#3a3a3a] bg-[#2a2a2a] px-3 py-2 text-[14px] text-[#ececec] placeholder:text-[#8f8f8f] focus:border-[#555] focus:outline-none focus:ring-1 focus:ring-[#e31000]"
              placeholder="e.g. Summer Lookbook Cut"
              autoFocus
            />
          </div>

          <div>
            <span className="mb-2 block text-[12px] font-medium text-[#a8a8a8]">Canvas Aspect Ratio</span>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`np-preset-${p.id}`}
                  onClick={() => setAspect(p.id)}
                  className={`flex flex-col items-start rounded-lg border p-2.5 text-left transition-all ${
                    aspect === p.id
                      ? 'border-[#e31000] bg-[#e31000]/[0.12] text-white'
                      : 'border-[#3a3a3a] bg-[#2a2a2a]/50 text-[#a8a8a8] hover:border-[#555] hover:text-[#ececec]'
                  }`}
                >
                  <span className="text-[12.5px] font-medium text-[#ececec]">{p.name}</span>
                  <span className="font-mono text-[11px] text-[#8f8f8f]">{p.dim}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-[#a8a8a8]">Framerate</span>
            <div className="flex gap-2">
              {[24, 30, 60].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  data-testid={`np-fps-${rate}`}
                  onClick={() => setFps(rate)}
                  className={`rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors ${
                    fps === rate
                      ? 'border-[#e31000] bg-[#e31000]/[0.12] font-medium text-white'
                      : 'border-[#3a3a3a] bg-[#2a2a2a] text-[#a8a8a8] hover:text-[#ececec]'
                  }`}
                >
                  {rate} fps
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-[#3a3a3a] pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-[#3a3a3a] px-4 py-2 text-[13px] text-[#a8a8a8] transition-colors hover:bg-[#2a2a2a] hover:text-[#ececec]"
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="np-create"
              className="rounded-full bg-[#e31000] px-5 py-2 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-[#ff2414]"
            >
              Create Sequence
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
