// Replicate an edit (parked-features plan, Feature 2 §1–§8). A separate
// full view, reached from the top bar, so a half-built draft never
// pollutes the open project: the reference + raw footage live here until
// Build swaps in a normal project. The reference is ANALYSED, never
// copied — its audio, watermark and caption text do not carry into the
// built project (stated in the UI, enforced in services/replicate.ts).

import { useRef, useState } from 'react';
import { store } from '../state/store';
import { jobService, clearRelayProjectSlot } from '../services/jobsSupabase';
import type { ReplicateSpec } from '../services/promptJobs';
import {
  buildProjectFromSpec, importRawClip, slotShortfall, suggestMapping,
  type RawClip, type SlotMap,
} from '../services/replicate';

const MAX_REFERENCE_S = 60;
const MAX_RAWS = 10;

interface RefState { file: File; url: string; duration: number | null }

type Phase = 'collect' | 'analysing' | 'review' | 'error';

interface Stage { key: string; label: string; state: 'pending' | 'active' | 'done'; result?: string }

const STAGE_DEFS: { key: string; label: string }[] = [
  { key: 'upload', label: 'Upload' },
  { key: 'cuts', label: 'Cut detection' },
  { key: 'beats', label: 'Beat grid' },
  { key: 'captions', label: 'Caption timing' },
  { key: 'style', label: 'Style notes' },
];

function freshStages(): Stage[] {
  return STAGE_DEFS.map((s) => ({ ...s, state: 'pending' as const }));
}

function fmtDur(d: number | null | undefined): string {
  return d == null || !Number.isFinite(d) ? '—' : `${d.toFixed(1)}s`;
}

export default function ReplicateView({ onClose }: { onClose: () => void }) {
  const [ref, setRef] = useState<RefState | null>(null);
  const [raws, setRaws] = useState<RawClip[]>([]);
  const [rawUrls, setRawUrls] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('collect');
  const [stages, setStages] = useState<Stage[]>(freshStages());
  const [spec, setSpec] = useState<ReplicateSpec | null>(null);
  const [mapping, setMapping] = useState<SlotMap[]>([]);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [dragTarget, setDragTarget] = useState<'ref' | 'raw' | null>(null);
  const [intakeError, setIntakeError] = useState('');
  const refInput = useRef<HTMLInputElement>(null);
  const rawInput = useRef<HTMLInputElement>(null);

  const refTooLong = ref?.duration != null && ref.duration > MAX_REFERENCE_S + 0.5;
  const canAnalyse = !!ref && raws.length > 0 && !refTooLong && phase !== 'analysing';
  const firstUnmapped = mapping.findIndex((s) => !s.mediaId);

  async function addReference(file: File) {
    setIntakeError('');
    if (!file.type.startsWith('video/')) {
      setIntakeError('The reference must be a video file.');
      return;
    }
    if (ref) URL.revokeObjectURL(ref.url);
    setRef({ file, url: URL.createObjectURL(file), duration: null });
  }

  async function addRaws(files: File[]) {
    setIntakeError('');
    for (const f of files) {
      if (raws.length >= MAX_RAWS) {
        setIntakeError(`Up to ${MAX_RAWS} raw clips for now — extra files were skipped.`);
        break;
      }
      try {
        const rc = await importRawClip(f);
        setRaws((list) => [...list, rc]);
        setRawUrls((m) => ({ ...m, [rc.meta.id]: URL.createObjectURL(f) }));
      } catch (e) {
        setIntakeError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  function removeRaw(id: string) {
    setRaws((list) => list.filter((r) => r.meta.id !== id));
    setMapping((list) => list.map((s) => (s.mediaId === id ? { ...s, mediaId: null } : s)));
  }

  async function analyse() {
    if (!ref || !jobService.createReplicateJob) {
      setErrorMsg('Replicate needs the live relay — this build is on the file-bundle transport.');
      setPhase('error');
      return;
    }
    setPhase('analysing');
    setStages(freshStages().map((s) => (s.key === 'upload' ? { ...s, state: 'active' } : s)));
    try {
      const { spec: got } = await jobService.createReplicateJob(
        ref.file,
        raws.map((r) => r.file),
        () => {
          setStages((list) => list.map((s) => {
            if (s.key === 'upload') return { ...s, state: 'done', result: 'Files on the server' };
            if (s.key === 'cuts') return { ...s, state: 'active' };
            return s;
          }));
        },
      );
      setStages([
        { key: 'upload', label: 'Upload', state: 'done', result: 'Files on the server' },
        { key: 'cuts', label: 'Cut detection', state: 'done', result: `${Math.max(0, got.segments.length - 1)} cuts found · ${got.segments.length} segments` },
        { key: 'beats', label: 'Beat grid', state: 'done', result: got.bpm ? `${got.bpm.toFixed(1)} BPM · ${got.beats.length} beats` : 'No beat grid found' },
        { key: 'captions', label: 'Caption timing', state: 'done', result: got.captions.length ? `${got.captions.length} caption phrases timed` : 'No speech captions found' },
        { key: 'style', label: 'Style notes', state: 'done', result: 'Mechanical notes added per segment' },
      ]);
      setSpec(got);
      setMapping(suggestMapping(got, raws.map((r) => r.meta)));
      setPhase('review');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  function patchSegment(i: number, patch: Partial<ReplicateSpec['segments'][number]>) {
    setSpec((s) => (s ? { ...s, segments: s.segments.map((seg, j) => (j === i ? { ...seg, ...patch } : seg)) } : s));
    setActiveRow(i);
  }

  function patchSlot(i: number, patch: Partial<SlotMap>) {
    setMapping((list) => list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
    setActiveRow(i);
  }

  function build() {
    if (!spec) return;
    try {
      const project = buildProjectFromSpec(spec, mapping, raws.map((r) => r.meta));
      store.replaceProject(project, { history: true, label: 'Replicate draft' });
      void clearRelayProjectSlot();
      onClose();
      store.toastMsg('info', 'Draft project ready — tweak and render');
    } catch (e) {
      store.toastMsg('error', e instanceof Error ? e.message : String(e));
    }
  }

  const dropProps = (target: 'ref' | 'raw') => ({
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragTarget(target); },
    onDragLeave: () => setDragTarget((t) => (t === target ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragTarget(null);
      const files = [...e.dataTransfer.files];
      if (target === 'ref') { if (files[0]) void addReference(files[0]); }
      else void addRaws(files);
    },
  });

  return (
    <div className="cl-fade-in fixed inset-0 z-40 overflow-y-auto bg-[#161616]">
      <div className="mx-auto flex max-w-[980px] flex-col gap-4 px-5 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-[18px] font-semibold">Replicate an edit</div>
            <p className="pt-1 max-w-[640px] text-[12px] leading-relaxed text-[#a8a8a8]">
              Drop a reference video and your own raw footage. The server measures the
              reference — cuts, beat grid, caption timing — and you map your clips onto
              its structure. A strong draft, not a perfect clone: the reference is
              analysed, never copied, and its audio and captions do not carry into
              your project.
            </p>
          </div>
          <button className="btn" onClick={onClose}>Back to editor</button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Reference drop box (plan §2) */}
          <div
            {...dropProps('ref')}
            className={`rounded-lg border bg-[#212121] p-3 transition-colors duration-200 ${
              dragTarget === 'ref' ? 'border-accent' : 'border-[#3a3a3a]'
            }`}
          >
            <div className="panel-title">Reference video</div>
            {ref ? (
              <div className="pt-2">
                <video
                  src={ref.url}
                  className="max-h-[220px] w-full rounded bg-black object-contain"
                  preload="metadata"
                  muted
                  onLoadedMetadata={(e) => {
                    const d = (e.target as HTMLVideoElement).duration;
                    setRef((r) => (r ? { ...r, duration: Number.isFinite(d) ? d : null } : r));
                  }}
                />
                <div className="flex items-center justify-between pt-2">
                  <span className="min-w-0 truncate text-[12px] text-[#c9c9c9]">{ref.file.name}</span>
                  <span className="shrink-0 pl-2 font-mono text-[11px] text-[#a8a8a8]">{fmtDur(ref.duration)}</span>
                </div>
                {refTooLong && (
                  <p className="pt-1 text-[12px] text-[#e8b4ae]">
                    This reference is {fmtDur(ref.duration)} — the cap for now is {MAX_REFERENCE_S}s.
                  </p>
                )}
                <button className="btn small mt-2" onClick={() => refInput.current?.click()}>Replace</button>
              </div>
            ) : (
              <button
                className="mt-2 flex h-[120px] w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-[#454545] text-[#a8a8a8]"
                onClick={() => refInput.current?.click()}
              >
                <span className="text-[13px]">{dragTarget === 'ref' ? 'Drop to add' : 'Drop a video here, or browse'}</span>
                <span className="text-[11px] text-[#6f6f6f]">One video, up to {MAX_REFERENCE_S} seconds</span>
              </button>
            )}
            <input ref={refInput} type="file" accept="video/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void addReference(f); e.target.value = ''; }} />
          </div>

          {/* Raw footage drop box (plan §3) */}
          <div
            {...dropProps('raw')}
            className={`rounded-lg border bg-[#212121] p-3 transition-colors duration-200 ${
              dragTarget === 'raw' ? 'border-accent' : 'border-[#3a3a3a]'
            }`}
          >
            <div className="panel-title">Your raw footage</div>
            {raws.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {raws.map((r) => (
                  <div key={r.meta.id} className="relative w-[104px]">
                    {r.meta.kind === 'image' ? (
                      <img src={rawUrls[r.meta.id]} alt="" className="h-[64px] w-full rounded bg-black object-cover" />
                    ) : (
                      <video src={rawUrls[r.meta.id]} className="h-[64px] w-full rounded bg-black object-cover" preload="metadata" muted />
                    )}
                    <div className="truncate pt-0.5 text-[11px] text-[#c9c9c9]" title={r.file.name}>{r.file.name}</div>
                    <div className="font-mono text-[11px] text-[#6f6f6f]">
                      {r.meta.kind === 'image' ? 'photo' : fmtDur(r.meta.duration)}
                    </div>
                    <button
                      className="btn small absolute right-1 top-1"
                      aria-label={`Remove ${r.file.name}`}
                      onClick={() => removeRaw(r.meta.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              className="mt-2 flex h-[120px] w-full flex-col items-center justify-center gap-0.5 rounded border border-dashed border-[#454545] text-[#a8a8a8]"
              onClick={() => rawInput.current?.click()}
            >
              <span className="text-[13px]">{dragTarget === 'raw' ? 'Drop to add' : 'Drop clips or photos, or browse'}</span>
              <span className="text-[11px] text-[#6f6f6f]">Up to {MAX_RAWS} files</span>
            </button>
            <input ref={rawInput} type="file" accept="video/*,image/*" multiple className="hidden"
              onChange={(e) => { void addRaws([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </div>
        </div>

        {intakeError && <p className="text-[12px] text-[#e8b4ae]">{intakeError}</p>}

        <div className="flex items-center gap-3">
          <button className="btn primary" disabled={!canAnalyse} onClick={() => void analyse()}>
            Analyse
          </button>
          {!ref && <span className="text-[12px] text-[#6f6f6f]">Add a reference video and at least one raw clip to begin.</span>}
          {ref && !raws.length && <span className="text-[12px] text-[#6f6f6f]">Add at least one raw clip to begin.</span>}
        </div>

        {(phase === 'analysing' || phase === 'review' || phase === 'error') && (
          <div className="rounded-lg border border-[#3a3a3a] bg-[#212121] p-3">
            <div className="panel-title">Analysis</div>
            <div className="pt-1">
              {stages.map((s) => (
                <div key={s.key} className="flex min-h-[26px] items-baseline gap-2 border-b border-[#2c2c2c] py-1">
                  <span className={`w-4 shrink-0 text-center ${s.state === 'done' ? 'text-accent' : 'text-[#6f6f6f]'}`}>
                    {s.state === 'done' ? '✓' : s.state === 'active' ? '•' : '·'}
                  </span>
                  <span className={`text-[12px] ${s.state === 'active' ? 'cl-soft-pulse text-[#e8e8e8]' : 'text-[#c9c9c9]'}`}>
                    {s.label}
                  </span>
                  {s.result && <span className="cl-fade-in text-[12px] text-[#a8a8a8]">{s.result}</span>}
                </div>
              ))}
            </div>
            {phase === 'error' && (
              <p className="pt-2 text-[12px] leading-relaxed text-[#e8b4ae]">
                Analysis failed — {errorMsg} Nothing was built; your open project is untouched.
              </p>
            )}
          </div>
        )}

        {phase === 'review' && spec && (
          <div className="rounded-lg border border-[#3a3a3a] bg-[#212121] p-3">
            <div className="panel-title">Edit spec — review, adjust, map your clips</div>
            <p className="pt-1 text-[11px] leading-relaxed text-[#6f6f6f]">
              Caption text is shown for reference only — it is not carried into the
              built project. Your clips keep their own sound.
            </p>
            <div className="pt-2">
              {spec.segments.map((seg, i) => {
                const slot = mapping[i];
                const short = slot ? slotShortfall(slot, raws.map((r) => r.meta)) : false;
                return (
                  <div
                    key={i}
                    className={`cl-fade-in border-b border-[#2c2c2c] py-2 pl-2 ${
                      activeRow === i ? 'border-l-2 border-l-accent bg-[#262626]' : 'border-l-2 border-l-transparent'
                    }`}
                    style={{ animationDelay: `${i * 40}ms` }}
                    onFocus={() => setActiveRow(i)}
                    onClick={() => setActiveRow(i)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-medium">Segment {i + 1}</span>
                      <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                        start
                        <input type="number" className="field" style={{ width: 64 }} step={0.1} min={0}
                          value={seg.start}
                          onChange={(e) => patchSegment(i, { start: Number(e.target.value) })} />
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                        end
                        <input type="number" className="field" style={{ width: 64 }} step={0.1} min={0}
                          value={seg.end}
                          onChange={(e) => patchSegment(i, { end: Number(e.target.value) })} />
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                        cut
                        <select className="field" style={{ width: 92 }} value={seg.cutType}
                          onChange={(e) => patchSegment(i, { cutType: e.target.value as typeof seg.cutType })}>
                          <option value="cut">cut</option>
                          <option value="dissolve">dissolve</option>
                          <option value="other">other</option>
                        </select>
                      </label>
                      <span className="font-mono text-[11px] text-[#6f6f6f]">{(seg.end - seg.start).toFixed(2)}s</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1.5">
                      <input type="text" className="field" style={{ width: 300 }} placeholder="Caption text (reference only)"
                        value={seg.captionText ?? ''}
                        onChange={(e) => patchSegment(i, { captionText: e.target.value || null })} />
                      <input type="text" className="field" style={{ flex: 1, minWidth: 200 }} placeholder="Style note"
                        value={seg.styleNote}
                        onChange={(e) => patchSegment(i, { styleNote: e.target.value })} />
                    </div>
                    {/* Slot mapping (plan §7) */}
                    <div className="flex flex-wrap items-center gap-2 pt-1.5">
                      <span className="text-[11px] text-[#a8a8a8]">Your clip:</span>
                      <select
                        className="field"
                        style={{ width: 220 }}
                        value={slot?.mediaId ?? ''}
                        onChange={(e) => {
                          const id = e.target.value || null;
                          const m = raws.find((r) => r.meta.id === id);
                          const len = seg.end - seg.start;
                          patchSlot(i, {
                            mediaId: id,
                            in: 0,
                            out: m && m.meta.kind === 'image' ? len : Math.min(len, m?.meta.duration ?? len),
                          });
                        }}
                      >
                        <option value="">— not mapped —</option>
                        {raws.map((r) => (
                          <option key={r.meta.id} value={r.meta.id}>
                            {r.file.name} ({r.meta.kind === 'image' ? 'photo' : fmtDur(r.meta.duration)})
                          </option>
                        ))}
                      </select>
                      <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                        in
                        <input type="number" className="field" style={{ width: 60 }} step={0.1} min={0}
                          value={slot?.in ?? 0}
                          onChange={(e) => patchSlot(i, { in: Number(e.target.value) })} />
                      </label>
                      <label className="flex items-center gap-1 text-[11px] text-[#a8a8a8]">
                        out
                        <input type="number" className="field" style={{ width: 60 }} step={0.1} min={0}
                          value={slot?.out ?? 0}
                          onChange={(e) => patchSlot(i, { out: Number(e.target.value) })} />
                      </label>
                      {slot && !slot.mediaId && (
                        <span className="text-[12px] font-medium text-accent">Not mapped — pick a clip</span>
                      )}
                      {slot && slot.mediaId && short && (
                        <span className="text-[12px] text-[#c9a227]">Clip is shorter than the segment — its end will be clamped.</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center gap-3 pt-3">
              <button className="btn primary" disabled={firstUnmapped >= 0} onClick={build}>
                Build project
              </button>
              {firstUnmapped >= 0 && (
                <span className="text-[12px] text-accent">
                  Segment {firstUnmapped + 1} is not mapped yet — map it to build.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
