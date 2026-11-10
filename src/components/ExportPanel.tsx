import { useCallback, useEffect, useState } from 'react';
import { store, useStore } from '../state/store';
import { mediaStore } from '../services/mediaStore';
import { jobService, renderOutputName } from '../services/jobsSupabase';
import { missingMedia, saveProjectJson } from '../services/projectIO';
import { projectDuration } from '../types';
import { DEFAULT_RENDER_OPTIONS, type JobInfo, type RenderOptions } from '../services/jobs';
import { applyTrackJob, queueReframeTrackJob } from '../services/analysisJobs';
import { trackSeed } from '../services/trackSeed';
import { playback } from '../engine/playback';
import Switch from './Switch';
import SegmentedToggle from './SegmentedToggle';
import CheckboxRow from './CheckboxRow';
import { setPage } from '../services/pages';
import { fmtDateTime, fmtElapsed } from '../utils/time';
import type { VideoClip } from '../types';
import { cuesFromProjectWords, cuesToSrt, cuesToVtt, downloadText, toSrt, toVtt } from '../services/captions';
import { toEdl, toFcp7Xml } from '../services/edlExport';

const RATIOS: Record<string, string> = { '9:16': '9:16', '16:9': '16:9', '1:1': '1:1' };

/** Phase 3 loudness presets — the names are the renderer's
 *  LOUDNESS_PRESETS keys (render-lane-b/render.py); the value rides
 *  the render payload's output object as `loudness`. */
const LOUDNESS_OPTIONS: { value: string; label: string }[] = [
  { value: 'social', label: 'Social — -14 LUFS' },
  { value: 'youtube', label: 'YouTube — -14 LUFS' },
  { value: 'spotify', label: 'Spotify — -14 LUFS' },
  { value: 'apple', label: 'Apple Music — -16 LUFS' },
  { value: 'podcast', label: 'Podcast — -16 LUFS' },
  { value: 'broadcast_eu', label: 'Broadcast EU (EBU R128) — -23 LUFS' },
  { value: 'broadcast_us', label: 'Broadcast US (ATSC) — -24 LUFS' },
];

/** RenderOptions plus the Phase 3 delivery extras. jobsSupabase's
 *  RenderOptions type is not extended here; these ride along in the
 *  same options object toward the payload's free-form output object. */
type DeliveryRenderOptions = RenderOptions & { loudness?: string; gif?: boolean };

/** FIX B1 #13: a failed fetch is NOT an empty queue. The old helper
 *  swallowed every error into [], so a signed-out user or a dead relay
 *  read as "No jobs on the relay yet". Callers now get the error and
 *  render an unreachable state with Retry; auto-poll keeps running. */
async function fetchJobs(): Promise<{ jobs: JobInfo[]; error: string | null }> {
  if (!jobService.listJobs) return { jobs: [], error: null };
  try {
    return { jobs: await jobService.listJobs(), error: null };
  } catch (e) {
    return { jobs: [], error: e instanceof Error ? e.message : 'The relay did not answer.' };
  }
}

/**
 * RenderQueue (§3.22): the standing queue — recent jobs on both
 * lanes with live status (polled while anything is active),
 * cancel for queued jobs, re-download for finished ones. The
 * dialog keeps only a one-line summary of this list.
 */
export function RenderQueue() {
  const [jobs, setJobs] = useState<JobInfo[] | null>(null);
  /** FIX B1 #13: last fetch failure — the queue shows an unreachable
   *  state instead of pretending to be empty. */
  const [jobsError, setJobsError] = useState<string | null>(null);
  /** D1.3c: track jobs whose keyframes this session has applied. */
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  /** FIX B1 #14: failed rows dismissed from this session's view. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  /** Ticking clock for running rows' elapsed labels. */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const refreshJobs = useCallback(async () => {
    const r = await fetchJobs();
    if (r.error) {
      setJobsError(r.error);
      setJobs((prev) => prev ?? []);
    } else {
      setJobsError(null);
      setJobs(r.jobs);
    }
  }, []);
  useEffect(() => { void refreshJobs(); }, [refreshJobs]);
  const active = !!jobs?.some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void refreshJobs(), 6000);
    return () => clearInterval(t);
  }, [active, refreshJobs]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  const visibleJobs = (jobs ?? []).filter((j) => !dismissed.has(j.id));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center">
        <span className="panel-title">Render queue</span>
        <div className="flex-1" />
        <button className="btn small" onClick={() => void refreshJobs()}>Refresh</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {jobs === null ? (
          <p className="text-[11px] text-[#a8a8a8]">Loading…</p>
        ) : jobsError && visibleJobs.length === 0 ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-[11px] leading-snug text-[#a8a8a8]">
              Can’t reach the render queue right now — {jobsError} Your jobs are
              safe on the server; this only means the list can’t be read at the moment.
            </p>
            <button className="btn small" onClick={() => void refreshJobs()}>Retry</button>
          </div>
        ) : visibleJobs.length === 0 ? (
          <p className="text-[11px] text-[#a8a8a8]">No jobs on the relay yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {jobsError && (
              <p className="text-[11px] leading-snug text-[#e8c468]">Couldn’t refresh the queue — showing the last list we loaded.</p>
            )}
            {visibleJobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-2 rounded border border-[#333] bg-[#262626] px-2 py-1 text-[11px]">
                <span className="font-mono uppercase text-[#a8a8a8]">{j.type}</span>
                {j.execLane === 'agent' && (
                  <span className="rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-1.5 py-px text-[11px] text-[#a8a8a8]">my Muse</span>
                )}
                <span className={j.status === 'done' ? 'text-[#8fd48f]' : j.status === 'failed' || j.status === 'cancelled' ? 'text-[#ff9d8f]' : 'text-[#e8c468]'}>
                  {j.execLane === 'agent' && j.status === 'queued'
                    ? 'waiting for your Muse'
                    : j.execLane === 'agent' && j.status === 'running'
                      ? `your Muse is rendering${j.agentClaim?.by ? ` (${j.agentClaim.by})` : ''}`
                      : j.status}
                </span>
                {j.status === 'running' && (
                  <span className="font-mono text-[11px] text-[#a8a8a8]">running for {fmtElapsed(j.claimedAt ?? j.createdAt, nowMs)}</span>
                )}
                <span className="font-mono text-[11px] text-[#6f6f6f]">{fmtDateTime(j.createdAt)}</span>
                <div className="flex-1" />
                {j.status === 'queued' && jobService.cancelJob && (
                  <button className="btn small" onClick={async () => {
                    // FIX B1 #1: a failed cancel must never be silent.
                    try {
                      await jobService.cancelJob!(j.id);
                      store.toastMsg('info', 'Job cancelled.');
                    } catch (e) {
                      store.toastMsg('error', `Could not cancel that job — ${e instanceof Error ? e.message : 'the relay did not answer.'}`);
                    } finally {
                      void refreshJobs();
                    }
                  }}>Cancel</button>
                )}
                {j.status === 'done' && j.outputPath && jobService.downloadJobOutput && (
                  <button className="btn small" onClick={async () => {
                    try {
                      await jobService.downloadJobOutput!(j, store.get().project.name);
                    } catch (e) {
                      store.toastMsg('error', e instanceof Error ? e.message : String(e));
                    }
                  }}>Download{j.outputBytes ? ` (${(j.outputBytes / 1_000_000).toFixed(1)} MB)` : ''}</button>
                )}
                {j.type === 'track' && j.status === 'done' && (
                  <button className="btn small" disabled={applied.has(j.id)} onClick={async () => {
                    try {
                      await applyTrackJob(j);
                      setApplied((prev) => new Set(prev).add(j.id));
                    } catch (e) {
                      store.toastMsg('error', e instanceof Error ? e.message : String(e));
                    }
                  }}>{applied.has(j.id) ? 'Keyframes applied' : 'Apply keyframes'}</button>
                )}
                {j.status === 'failed' && (
                  <>
                    <span className="w-full leading-snug text-[#ff9d8f]">{j.error || 'The job failed without recording a reason.'}</span>
                    {jobService.requeueJob && j.payload && (
                      <button className="btn small" onClick={async () => {
                        try {
                          await jobService.requeueJob!(j);
                          store.toastMsg('info', 'Job queued again with the same settings.');
                          void refreshJobs();
                        } catch (e) {
                          store.toastMsg('error', `Could not queue that job again — ${e instanceof Error ? e.message : 'the relay did not answer.'}`);
                        }
                      }}>Retry</button>
                    )}
                    <button className="btn small" onClick={() => setDismissed((prev) => new Set(prev).add(j.id))}>Dismiss</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="pt-2 text-[11px] leading-snug text-[#a8a8a8]">
        The server renders the exact same project the preview shows. Newer project
        features (grades, ramps, mattes) join the render as the renderer learns
        them — the job carries every setting either way.
      </p>
    </div>
  );
}

/**
 * ExportForm (§3.20): the export controls, shared by the Export
 * dialog (unchanged behaviour) and the Deliver page's left column.
 */
export function ExportForm({ onQueued, onTarget }: { onQueued?: () => void; onTarget?: (t: 'server' | 'agent') => void }) {
  const project = useStore((s) => s.project);
  const [missing, setMissing] = useState<string[]>([]);
  const [rendering, setRendering] = useState(false);
  const [opts, setOpts] = useState<RenderOptions>({ ...DEFAULT_RENDER_OPTIONS });
  /** FIX B1 #9c: output file name; blank = derived from the project name. */
  const [outputName, setOutputName] = useState('');
  /** FIX B1 #15: CRF / bitrate are edited as text so a typed value can be
   *  validated before it ever reaches the job payload. Only valid values
   *  are written into `opts`; leaving the field clamps it back into range. */
  const [crfText, setCrfText] = useState(String(DEFAULT_RENDER_OPTIONS.crf));
  const [bitrateText, setBitrateText] = useState(String(DEFAULT_RENDER_OPTIONS.bitrateKbps));
  /** Phase 3 delivery: loudness preset (default = the historic -14 LUFS
   *  social target) and the GIF companion toggle. */
  const [loudness, setLoudness] = useState('social');
  const [alsoGif, setAlsoGif] = useState(false);

  useEffect(() => {
    missingMedia(project).then((m) => setMissing(m.map((x) => x.src))).catch(() => setMissing([]));
  }, [project]);

  const set = (patch: Partial<RenderOptions>) => {
    if (patch.target) onTarget?.(patch.target);
    setOpts((o) => ({ ...o, ...patch }));
  };
  const clipCount = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  const crfNum = Number(crfText);
  const crfValid = crfText.trim() !== '' && Number.isFinite(crfNum) && crfNum >= 10 && crfNum <= 32;
  const bitrateNum = Number(bitrateText);
  const bitrateValid = bitrateText.trim() !== '' && Number.isFinite(bitrateNum) && bitrateNum >= 500 && bitrateNum <= 80000;
  const numbersValid = opts.bitrateMode === 'crf' ? crfValid : bitrateValid;
  const hasRange = project.rangeIn != null && project.rangeOut != null && project.rangeOut > project.rangeIn;
  const canvasRatio = (() => {
    const { w, h } = project.canvas;
    if (w === h) return '1:1';
    return w > h ? '16:9' : '9:16';
  })();
  /** Phase 3 delivery files: caption sidecars come from the first text
   *  track with clips (or from word-timed clips), interchange from the
   *  whole timeline. All are plain downloads — no job is queued. */
  const captionTrack = project.tracks.find((t) => t.kind === 'text' && t.clips.length > 0);
  const wordCues = cuesFromProjectWords(project);
  const fileBase = (project.name.replace(/[^a-zA-Z0-9 ]+/g, '').trim() || 'cutlab').replace(/\s+/g, '_');

  return (
    <div className="flex flex-col gap-3 text-[13px] leading-relaxed">
      {opts.target === 'agent' ? (
        <p className="text-[#c0c0c0]">
          Your own Muse renders this project on its machine with the official CutLab
          renderer — the CutLab server never touches it. Queue the job here, then ask your
          Muse to render it; the finished file appears in the queue for download.
        </p>
      ) : (
        <p className="text-[#c0c0c0]">
          Rendering runs on the CutLab server, not on this PC. The finished file
          downloads here automatically when it is done — keep this tab open.
        </p>
      )}
      <div>
        <div className="field-label mb-1">Render with</div>
        <SegmentedToggle
          stretch
          ariaLabel="Render with"
          value={opts.target === 'agent' ? 'agent' : 'server'}
          onChange={(v) => set({ target: v as RenderOptions['target'] })}
          options={[
            { value: 'server', label: 'CutLab server' },
            { value: 'agent', label: 'My Muse', sub: 'its machine renders' },
          ]}
        />
      </div>
      <div className="rounded-md border border-[#3a3a3a] bg-[#262626] px-3 py-2 font-mono text-[11px] text-[#a8a8a8]">
        {project.canvas.w}×{project.canvas.h} · {project.canvas.fps}fps · {projectDuration(project).toFixed(2)}s ·
        {' '}{project.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · bt709 · metadata stripped
      </div>
      {missing.length > 0 && (
        <p className="rounded-md border border-[#a3271b] bg-[#3a1610] px-3 py-2 text-[#ffb3a7]">
          These media files are not in the bin — import them before sending the job,
          or the render cannot include them: {missing.join(', ')}
        </p>
      )}

      <label className="flex flex-col gap-0.5">
        <span className="field-label">Output file name</span>
        <input type="text" className="field" value={outputName}
          placeholder={renderOutputName(project.name, opts)}
          onChange={(e) => setOutputName(e.target.value)} />
        <span className="text-[11px] text-[#a8a8a8]">The finished file downloads with this name. Leave it blank to use the project name.</span>
      </label>

      <div>
        <span className="field-label block pb-1">Container</span>
        <SegmentedToggle
          stretch
          ariaLabel="Container"
          value={opts.container}
          onChange={(v) => set({ container: v as RenderOptions['container'] })}
          options={[
            { value: 'mp4', label: 'MP4' },
            { value: 'mov', label: 'MOV' },
          ]}
        />
      </div>
      <div>
        <span className="field-label block pb-1">Codec</span>
        <SegmentedToggle
          stretch
          ariaLabel="Codec"
          value={opts.codec}
          onChange={(v) => set({ codec: v as RenderOptions['codec'] })}
          options={[
            { value: 'h264', label: 'H.264', sub: 'everywhere' },
            { value: 'h265', label: 'H.265', sub: 'smaller files' },
          ]}
        />
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="flex flex-col gap-0.5">
          <span className="field-label">Output size</span>
          <select className="field" value={opts.size} onChange={(e) => set({ size: e.target.value as RenderOptions['size'] })}>
            <option value="canvas">Canvas ({project.canvas.w}×{project.canvas.h})</option>
            <option value="p720">720p draft</option>
            <option value="p1080">1080p</option>
            <option value="uhd">UHD 2160p (YouTube's better compression tier)</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="field-label">Frame rate</span>
          <select className="field" value={opts.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
            <option value={0}>Canvas ({project.canvas.fps} fps)</option>
            <option value={30}>30 fps</option>
            <option value={50}>50 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </label>
      </div>
      <div>
        <span className="field-label block pb-1">Bitrate mode</span>
        <SegmentedToggle
          stretch
          ariaLabel="Bitrate mode"
          value={opts.bitrateMode}
          onChange={(v) => set({ bitrateMode: v as RenderOptions['bitrateMode'] })}
          options={[
            { value: 'crf', label: 'Quality', sub: 'CRF' },
            { value: 'bitrate', label: 'Target', sub: 'bitrate' },
          ]}
        />
      </div>
      <div>
        {opts.bitrateMode === 'crf' ? (
          <label className="flex flex-col gap-0.5">
            <span className="field-label">CRF (18 is a good default)</span>
            <input type="number" className="field" min={10} max={32} value={crfText}
              aria-invalid={!crfValid}
              onChange={(e) => {
                setCrfText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 10 && n <= 32) set({ crf: n });
              }}
              onBlur={() => {
                const n = Number(crfText);
                const clamped = Number.isFinite(n) && crfText.trim() !== '' ? Math.min(32, Math.max(10, Math.round(n))) : opts.crf;
                setCrfText(String(clamped));
                set({ crf: clamped });
              }} />
            {!crfValid && <span className="text-[11px] text-[#e8c468]">Use a whole number from 10 to 32 — lower is sharper and makes larger files.</span>}
          </label>
        ) : (
          <label className="flex flex-col gap-0.5">
            <span className="field-label">Bitrate (kbps)</span>
            <input type="number" className="field" min={500} max={80000} step={500} value={bitrateText}
              aria-invalid={!bitrateValid}
              onChange={(e) => {
                setBitrateText(e.target.value);
                const n = Number(e.target.value);
                if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= 500 && n <= 80000) set({ bitrateKbps: n });
              }}
              onBlur={() => {
                const n = Number(bitrateText);
                const clamped = Number.isFinite(n) && bitrateText.trim() !== '' ? Math.min(80000, Math.max(500, Math.round(n))) : opts.bitrateKbps;
                setBitrateText(String(clamped));
                set({ bitrateKbps: clamped });
              }} />
            {!bitrateValid && <span className="text-[11px] text-[#e8c468]">Use a bitrate from 500 to 80,000 kbps.</span>}
          </label>
        )}
      </div>

      <span className="flex items-center gap-2 text-[12px] text-[#c9c9c9]">
        <Switch checked={opts.rangeOnly} disabled={!hasRange}
          label={<>Export only the I/O range{hasRange
            ? ` (${project.rangeIn!.toFixed(2)}s → ${project.rangeOut!.toFixed(2)}s)`
            : ' — set one with I / O on the timeline first'}</>}
          onChange={(v) => set({ rangeOnly: v })} />
      </span>

      {project.canvas.w > project.canvas.h && (
        <div className="flex flex-col gap-1">
          {project.reframe ? (
            <>
              <span className="flex items-center gap-2 text-[12px] text-[#c9c9c9]">
                <Switch checked={!!opts.reframe}
                  label={<>Reframe to 9:16 (follow subject) — {project.reframe.points.length} path points</>}
                  onChange={(v) => set({ reframe: v })} />
              </span>
              <p className="text-[11px] leading-snug text-[#a8a8a8]">
                The vertical cut follows the tracked subject. Titles placed for the wide
                frame may fall outside the crop — best for footage-led exports.
              </p>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => {
                const track = project.tracks.find((t) => t.kind === 'video');
                const clip = track?.clips.find((c) => (c as VideoClip).media) as VideoClip | undefined;
                if (!clip) { store.toastMsg('error', 'Add a video clip first — reframe tracks its subject.'); return; }
                playback.seek(clip.start);
                trackSeed.arm({
                  clipId: clip.id, seedClipT: 0,
                  onSeed: (box) => {
                    void queueReframeTrackJob(clip, box, 0).catch((e) => {
                      store.toastMsg('error', e instanceof Error ? e.message : String(e));
                    });
                  },
                });
              }}>
                Track subject for 9:16 reframe…
              </button>
              <p className="text-[11px] leading-snug text-[#a8a8a8]">
                Draw a box around the subject on the stage; the finished track becomes
                the moving crop path for a vertical export (applied from the render queue).
              </p>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="field-label">Temporal denoise — {(opts.polishDenoise ?? 0) === 0 ? 'off' : `${Math.round((opts.polishDenoise ?? 0) * 100)}%`}</span>
          <input type="range" min={0} max={1} step={0.05} value={opts.polishDenoise ?? 0}
            onChange={(e) => set({ polishDenoise: Number(e.target.value) })} />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="field-label">Film grain — {(opts.polishGrain ?? 0) === 0 ? 'off' : `${Math.round((opts.polishGrain ?? 0) * 100)}%`}</span>
          <input type="range" min={0} max={1} step={0.05} value={opts.polishGrain ?? 0}
            onChange={(e) => set({ polishGrain: Number(e.target.value) })} />
        </label>
        <p className="col-span-2 -mt-0.5 text-[11px] text-[#a8a8a8]">Render polish: denoise cleans noisy footage before encoding; grain adds animated film grain at the output size. Both apply at render only.</p>
      </div>

      <div>
        <div className="field-label mb-1">Also render in (extra formats)</div>
        <div className="rounded-[10px] border border-[#3a3a3a] px-3">
          {Object.keys(RATIOS).filter((r) => r !== canvasRatio).map((r) => (
            <CheckboxRow
              key={r}
              label={r}
              description={r === '9:16' ? 'Vertical centre-crop' : r === '16:9' ? 'Widescreen centre-crop' : 'Square centre-crop'}
              checked={opts.alsoFormats.includes(r)}
              onChange={(v) => set({
                alsoFormats: v
                  ? [...opts.alsoFormats, r]
                  : opts.alsoFormats.filter((x) => x !== r),
              })}
            />
          ))}
        </div>
        <p className="mt-0.5 text-[11px] text-[#a8a8a8]">Extra formats centre-crop from the master canvas in this pass; for a subject-following vertical cut use "Reframe to 9:16" above.</p>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        <label className="flex flex-col gap-0.5">
          <span className="field-label">Loudness target</span>
          <select className="field" value={loudness} onChange={(e) => setLoudness(e.target.value)}>
            {LOUDNESS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <span className="flex items-end gap-2 pb-1 text-[12px] text-[#c9c9c9]">
          <Switch checked={alsoGif}
            label="Also export GIF"
            onChange={(v) => setAlsoGif(v)} />
        </span>
        <p className="col-span-2 -mt-0.5 text-[11px] text-[#a8a8a8]">The render is normalised to the chosen loudness target. The GIF is a muted companion (up to 15 fps, up to 720 px wide) rendered in the same pass.</p>
      </div>

      <button
        className="btn primary justify-center py-2"
        disabled={rendering || clipCount === 0 || !numbersValid}
        onClick={async () => {
          setRendering(true);
          try {
            const recs = await mediaStore.all();
            const deliveryOpts: DeliveryRenderOptions = {
              ...opts,
              outputName: outputName.trim() || undefined,
              loudness,
              ...(alsoGif ? { gif: true } : {}),
            };
            await jobService.createRenderJobBundle(project, recs, deliveryOpts);
            onQueued?.();
          } finally {
            setRendering(false);
          }
        }}
      >
        {rendering
          ? (opts.target === 'agent' ? 'Queueing…' : 'Rendering on server…')
          : (opts.target === 'agent' ? 'Queue for my Muse' : 'Render on server')}
      </button>
      {clipCount === 0 && (
        <p className="-mt-1.5 text-[12px] leading-snug text-[#a8a8a8]">Add a clip to the timeline first — there is nothing to render yet.</p>
      )}
      {!numbersValid && clipCount > 0 && (
        <p className="-mt-1.5 text-[12px] leading-snug text-[#a8a8a8]">Fix the highlighted quality value above before rendering.</p>
      )}
      {opts.target === 'agent' && (
        <p className="rounded-md border border-[#3a3a3a] bg-[#262626] px-3 py-2 text-[12px] text-[#c9c9c9]">
          After queueing, tell your Muse: <span className="font-mono text-[#e8e8e8]">“Render my waiting CutLab job.”</span>{' '}
          It uses your connect token (TopBar → Connections) to pick the job up. Nothing renders
          until you ask it to.
        </p>
      )}

      <div className="border-t border-[#3a3a3a] pt-2">
        <div className="panel-title mb-1">Project file only</div>
        <div className="flex gap-2">
          <button className="btn small" onClick={() => saveProjectJson(project)}>Download project JSON</button>
        </div>
        <p className="mt-1 text-[11px] text-[#a8a8a8]">
          A bare JSON loads in any CutLab and binds to media with matching file names.
          Use “Save bundle” in the top bar to include the media files.
        </p>
      </div>

      <div className="border-t border-[#3a3a3a] pt-2">
        <div className="panel-title mb-1">Captions &amp; interchange</div>
        <div className="flex flex-wrap gap-2">
          <button className="btn small" disabled={!captionTrack}
            onClick={() => { if (captionTrack) downloadText(toSrt(project, captionTrack.id), `${fileBase}.srt`); }}>
            Captions .srt
          </button>
          <button className="btn small" disabled={!captionTrack}
            onClick={() => { if (captionTrack) downloadText(toVtt(project, captionTrack.id), `${fileBase}.vtt`); }}>
            Captions .vtt
          </button>
          <button className="btn small" disabled={wordCues.length === 0}
            onClick={() => downloadText(cuesToSrt(wordCues), `${fileBase}_words.srt`)}>
            Word-timed .srt
          </button>
          <button className="btn small" disabled={wordCues.length === 0}
            onClick={() => downloadText(cuesToVtt(wordCues), `${fileBase}_words.vtt`)}>
            Word-timed .vtt
          </button>
          <button className="btn small" onClick={() => downloadText(toEdl(project), `${fileBase}.edl`)}>
            Timeline .edl
          </button>
          <button className="btn small" onClick={() => downloadText(toFcp7Xml(project), `${fileBase}.xml`)}>
            Timeline FCP7 .xml
          </button>
        </div>
        <p className="mt-1 text-[11px] text-[#a8a8a8]">
          Caption sidecars come from the first text track (word-timed ones are rebuilt
          from transcription word timings). The EDL (CMX 3600) and FCP7 XML carry the
          timeline's cuts for other editors; compound and adjustment clips are noted
          in the file where they were skipped.
        </p>
      </div>
    </div>
  );
}

export default function ExportPanel({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState('Loading queue…');
  const [titleTarget, setTitleTarget] = useState<'server' | 'agent'>('server');
  const loadSummary = useCallback(async () => {
    const { jobs: js, error } = await fetchJobs();
    // FIX B1 #13: a failed fetch must not summarise as an empty queue.
    if (error) { setSummary('Couldn’t read the queue — the relay didn’t answer.'); return; }
    if (js.length === 0) { setSummary('Queue is empty.'); return; }
    const c = (st: string) => js.filter((j) => j.status === st).length;
    const parts: string[] = [];
    if (c('queued')) parts.push(`${c('queued')} queued`);
    if (c('running')) parts.push(`${c('running')} running`);
    if (c('done')) parts.push(`${c('done')} done`);
    setSummary(`Queue — ${parts.join(' · ') || `${js.length} jobs`}`);
  }, []);
  useEffect(() => { void loadSummary(); }, [loadSummary]);
  // FIX B1 #9b: Escape closes, like every other dialog in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="modal-panel w-[560px] max-w-[94vw]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
          <span className="text-[18px] font-semibold">Export — {titleTarget === 'agent' ? 'render with my Muse' : 'server render'}</span>
          <button className="btn icon" onClick={onClose}>×</button>
        </div>
        <div className="max-h-[74vh] overflow-y-auto px-4 py-3">
          <ExportForm onQueued={() => void loadSummary()} onTarget={setTitleTarget} />
        </div>
        <div className="flex items-center gap-2 border-t border-[#3a3a3a] px-4 py-2.5">
          <span className="text-[11px] text-[#a8a8a8]">{summary}</span>
          <div className="flex-1" />
          <button className="btn small" onClick={() => { setPage('deliver'); onClose(); }}>Open Deliver page</button>
        </div>
      </div>
    </div>
  );
}
