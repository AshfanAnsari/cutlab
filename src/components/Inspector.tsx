import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import type { AdjustmentClip, AudioClip, Clip, ClipEffect, CompoundClip, EffectType, Keyframe, TextClip, TransitionType, VideoClip } from '../types';
import { clipDuration, DEFAULT_SHADOW, DEFAULT_TRANSFORM, FONT_STACKS, projectDuration, resolveShadow, speedAtSource, TEXT_PRESETS } from '../types';
import { addContactShadow, copyKeyframes, findClip, openNest, pasteKeyframes, seekKeyframe, sendTextBehindSubject, setActiveAngle, uncompoundSelected } from '../state/actions';
import GraphEditor from './GraphEditor';
import ColorPanel, { ColourEntry } from './ColorPanel';
import { SHORTCUT_ACTIONS, clearKeymapOverride, comboForEvent, displayCombo, keymapOverride, resetKeymap, setKeymapOverride } from '../services/shortcuts';
import { DEFAULT_GRADE, gradeLayersOf } from '../services/grade';
import type { Grade } from '../types';
import { buildSpeedMap, effectValueAt, evalTransform, maskAt } from '../engine/compose';
import { playback } from '../engine/playback';
import { removeFont, subscribeFonts, uploadedFontFamilies, uploadFont } from '../services/fonts';
import { applyPresetFields, deleteUserPreset, loadUserPresets, saveUserPreset, type UserTextPreset } from '../services/textPresets';
import { loadSettings, saveSettings } from '../services/settings';
import { setPage } from '../services/pages';
import { consumeProjectSettingsOpenRequest, consumeShortcutsOpenRequest, subscribeProjectSettingsOpen, subscribeShortcutsOpen } from '../services/inspectorNav';
import { consumeInspectorTabOpen, consumePromptTabOpen, subscribePromptDraft } from '../services/promptDraft';
import PromptPanel from './PromptPanel';
import Switch from './Switch';
import { downloadText, toSrt } from '../services/captions';
import { isolateClipVoice, queueMaskTrackJob, queueTrackJob, syncMulticamClip, transcribeClipToCaptions, type MediaClip } from '../services/analysisJobs';
import { bandsOf, defaultEqBands } from '../services/eq';
import type { EqBand } from '../types';
import { getSepStatus, subscribeSepStatus } from '../services/sepJobs';
import { trackSeed } from '../services/trackSeed';
import { clamp, qFrame } from '../utils/time';

function patchClip(trackId: string, clipId: string, fn: (c: Clip) => void, history = true) {
  store.commit((draft) => {
    const tr = draft.tracks.find((t) => t.id === trackId);
    const c = tr?.clips.find((x) => x.id === clipId);
    if (c) fn(c);
  }, { history });
}
function snapshot() {
  store.commit(() => undefined, { history: true });
}

export function Num({ label, value, step = 1, min, max, onCommit, format }: {
  label: string; value: number; step?: number; min?: number; max?: number;
  onCommit: (v: number) => void; format?: (v: number) => string;
}) {
  const [txt, setTxt] = useState('');
  const [focus, setFocus] = useState(false);
  const shown = focus ? txt : (format ? format(value) : String(Math.round(value * 1000) / 1000));
  return (
    <label className="flex items-center justify-between gap-2 py-0.5">
      <span className="text-[12px] text-[#a8a8a8]">{label}</span>
      <input
        type="number" className="field" style={{ width: 86 }} step={step} min={min} max={max}
        value={shown}
        onFocus={() => { setFocus(true); setTxt(String(Math.round(value * 1000) / 1000)); }}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => {
          setFocus(false);
          const v = Number(txt);
          if (isFinite(v)) onCommit(clamp(v, min ?? -Infinity, max ?? Infinity));
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

export function Slider({ label, value, min, max, step = 0.01, onLive, format }: {
  label: string; value: number; min: number; max: number; step?: number;
  onLive: (v: number) => void; format?: (v: number) => string;
}) {
  // G.3: the readout is a typeable field — exact values (rotation = exactly
  // 50°) without slider hunting. Display units follow the slider's format
  // when it renders a plain number; unit-suffixed formats stay read-only text
  // beside the field is overkill — the field edits the RAW value.
  const [txt, setTxt] = useState('');
  const [focus, setFocus] = useState(false);
  const raw = String(Math.round(value * 1000) / 1000);
  return (
    <label className="flex items-center gap-2 py-0.5">
      <span className="w-[86px] shrink-0 text-[12px] text-[#a8a8a8]">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} className="min-w-0 flex-1"
        aria-label={label}
        onPointerDown={snapshot}
        onChange={(e) => onLive(Number(e.target.value))} />
      <input
        type="number"
        className="field font-mono"
        style={{ width: 56, padding: '1px 4px', fontSize: 11 }}
        step={step}
        value={focus ? txt : raw}
        aria-label={`${label} value`}
        title={format ? `Exact value (display: ${format(value)})` : 'Exact value'}
        onFocus={() => { snapshot(); setFocus(true); setTxt(raw); }}
        onChange={(e) => setTxt(e.target.value)}
        onBlur={() => {
          setFocus(false);
          const v = Number(txt);
          if (isFinite(v) && txt !== '') onLive(clamp(v, min, max));
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      />
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#333] px-3 py-2.5">
      <div className="panel-title mb-1.5">{title}</div>
      {children}
    </div>
  );
}

const TRANSITIONS: TransitionType[] = ['cut', 'dissolve', 'flash', 'glare', 'slide', 'shake', 'blur-pulse', 'zoom', 'flip', 'invert-flash', 'mask-wipe', 'blur-cut'];
const EFFECTS: { type: EffectType; label: string; min: number; max: number; def: number }[] = [
  { type: 'brightness', label: 'Brightness', min: -1, max: 1, def: 0.15 },
  { type: 'contrast', label: 'Contrast', min: -1, max: 1, def: 0.15 },
  { type: 'saturation', label: 'Saturation', min: -1, max: 1, def: 0.2 },
  { type: 'blur', label: 'Blur (px)', min: 0, max: 20, def: 6 },
  { type: 'glow', label: 'Glow', min: 0, max: 1, def: 0.6 },
  { type: 'sharpen', label: 'Sharpen', min: 0, max: 2, def: 0.8 },
  { type: 'vignette', label: 'Vignette', min: 0, max: 1, def: 0.45 },
  { type: 'tv-lines', label: 'TV Lines', min: 0, max: 1, def: 0.5 },
  { type: 'haze', label: 'Haze (centre-focus blur)', min: 0, max: 20, def: 8 },
  { type: 'wide-angle', label: 'Wide angle', min: 0, max: 1, def: 0.5 },
  { type: 'motion-blur', label: 'Motion blur', min: 0, max: 1, def: 0.5 },
  { type: 'relight', label: 'Relight', min: 0, max: 1, def: 0.6 },
  { type: 'turbulent-displace', label: 'Turbulent displace', min: 0, max: 1, def: 0.6 },
];

function InspectorBody() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const [, setTick] = useState(0);
  useEffect(() => playback.onFrame(() => setTick((n) => (n + 1) % 100000)), []);

  const found = selected
    ? findClip(project, selected.trackId, selected.clipId)
    : { track: undefined, clip: undefined };
  const clip = found.clip;
  const track = found.track;

  return (
    <>
      {!clip || !track || !selected ? (
        <ProjectSection />
      ) : (
        <>
          <div className="border-b border-[#333] px-3 py-2.5">
            <div className="text-[13px] font-semibold capitalize">
              {'nest' in clip ? 'Compound' : 'adj' in clip ? 'Adjustment' : track.kind} clip
            </div>
            <div className="font-mono text-[11px] text-[#a8a8a8]">
              start {clip.start.toFixed(3)}s · length {clipDuration(clip).toFixed(3)}s
            </div>
          </div>
          <Section title="Timing">
            <Num label="Start (s)" value={clip.start} step={1 / project.canvas.fps}
              onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { c.start = Math.max(0, qFrame(v, project.canvas.fps)); })} />
            {'in' in clip && (
              <>
                <Num label="In (s)" value={(clip as VideoClip).in} step={1 / project.canvas.fps}
                  onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { (c as VideoClip).in = Math.max(0, v); })} />
                <Num label="Out (s)" value={(clip as VideoClip).out} step={1 / project.canvas.fps}
                  onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { (c as VideoClip).out = Math.max((c as VideoClip).in + 0.01, v); })} />
                {'media' in clip && (
                  <>
                    <Num label="Speed" value={(clip as VideoClip).speed} step={0.05} min={0.1} max={8}
                      onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { (c as VideoClip).speed = v; })} />
                    <SpeedExtras clip={clip as VideoClip} trackId={selected.trackId} />
                  </>
                )}
                {'nest' in clip && (
                  <p className="text-[11px] leading-snug text-[#a8a8a8]">A compound window always plays 1:1 — In/Out choose which part of the nest shows.</p>
                )}
              </>
            )}
            {'dur' in clip && (
              <Num label="Duration (s)" value={(clip as TextClip).dur} step={1 / project.canvas.fps} min={0.05}
                onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { (c as TextClip).dur = v; })} />
            )}
          </Section>

          <Section title="Transition in">
            <div className="flex items-center gap-2">
              <select className="field flex-1" value={clip.transitionIn ?? 'cut'}
                onChange={(e) => patchClip(selected.trackId, clip.id, (c) => {
                  c.transitionIn = e.target.value === 'cut' ? null : (e.target.value as TransitionType);
                })}>
                {TRANSITIONS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {clip.transitionIn && (
              <Num label="Duration (s)" value={clip.transitionDur ?? 0.25} step={0.05} min={0.05} max={1.5}
                onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { c.transitionDur = v; })} />
            )}
            {clip.transitionIn === 'slide' && (
              <div className="flex items-center gap-1 pt-1">
                <span className="pr-1 text-[12px] text-[#a8a8a8]">Direction</span>
                {(['down', 'up', 'left', 'right'] as const).map((d) => (
                  <button key={d} className="btn small" aria-pressed={(clip.transitionDir ?? 'down') === d}
                    style={(clip.transitionDir ?? 'down') === d ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
                    onClick={() => patchClip(selected.trackId, clip.id, (c) => { c.transitionDir = d; })}>
                    {d === 'down' ? '↓' : d === 'up' ? '↑' : d === 'left' ? '←' : '→'}
                  </button>
                ))}
              </div>
            )}
            {clip.transitionIn === 'invert-flash' && (
              <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
                Whole-frame invert on the beat — the reference measure is exactly 3 frames; set the duration to 3 ÷ fps (0.10 s at 30 fps).
              </p>
            )}
            {clip.transitionIn === 'mask-wipe' && (
              <>
                <div className="flex items-center gap-1 pt-1">
                  <span className="pr-1 text-[12px] text-[#a8a8a8]">Shape</span>
                  {(['circle', 'petal', 'blob'] as const).map((s) => (
                    <button key={s} className="btn small" aria-pressed={(clip.wipeShape ?? 'circle') === s}
                      style={(clip.wipeShape ?? 'circle') === s ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
                      onClick={() => patchClip(selected.trackId, clip.id, (c) => { c.wipeShape = s; })}>
                      {s}
                    </button>
                  ))}
                </div>
                <Slider label="Wipe origin X" value={clip.wipeCx ?? 0.5} min={0} max={1}
                  onLive={(v) => patchClip(selected.trackId, clip.id, (c) => { c.wipeCx = v; }, false)} />
                <Slider label="Wipe origin Y" value={clip.wipeCy ?? 0.5} min={0} max={1}
                  onLive={(v) => patchClip(selected.trackId, clip.id, (c) => { c.wipeCy = v; }, false)} />
                <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
                  The reveal grows as a {(clip.wipeShape ?? 'circle')} from this point; the preview
                  approximates with a circle, Lane B performs the true shape.
                </p>
              </>
            )}
            {clip.transitionIn === 'blur-cut' && (
              <>
                <div className="flex items-center gap-1 pt-1">
                  <span className="pr-1 text-[12px] text-[#a8a8a8]">Mode</span>
                  {(['soft', 'whip', 'zoom'] as const).map((m) => (
                    <button key={m} className="btn small" aria-pressed={(clip.transitionMode ?? 'soft') === m}
                      style={(clip.transitionMode ?? 'soft') === m ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
                      onClick={() => patchClip(selected.trackId, clip.id, (c) => { c.transitionMode = m; })}>
                      {m}
                    </button>
                  ))}
                </div>
                {(clip.transitionMode ?? 'soft') === 'whip' && (
                  <div className="flex items-center gap-1 pt-1">
                    <span className="pr-1 text-[12px] text-[#a8a8a8]">Direction</span>
                    {(['right', 'left', 'down', 'up'] as const).map((d) => (
                      <button key={d} className="btn small" aria-pressed={(clip.transitionDir ?? 'right') === d}
                        style={(clip.transitionDir ?? 'right') === d ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
                        onClick={() => patchClip(selected.trackId, clip.id, (c) => { c.transitionDir = d; })}>
                        {d === 'down' ? '↓' : d === 'up' ? '↑' : d === 'left' ? '←' : '→'}
                      </button>
                    ))}
                  </div>
                )}
                <Num label="Peak blur (sigma)" value={clip.transitionBlur ?? 9} step={0.5} min={1} max={30}
                  onCommit={(v) => patchClip(selected.trackId, clip.id, (c) => { c.transitionBlur = v; })} />
                <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
                  The blur-masked cut: blur peaks at the join on BOTH sides — the previous
                  clip's tail ramps up over its last Duration seconds, this clip's head
                  settles over its first Duration. Lane B performs both sides; the
                  preview approximates this clip's settle.
                </p>
              </>
            )}
            <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
              Preview approximates transitions; the server render (Lane B) performs them for real.
            </p>
          </Section>

          {track.kind === 'video' && 'nest' in clip && (
            <CompoundSection clip={clip as CompoundClip} trackId={selected.trackId} />
          )}
          {track.kind === 'video' && 'angles' in clip && (clip as VideoClip).angles && (
            <MulticamSection clip={clip as VideoClip} trackId={selected.trackId} />
          )}
          {track.kind === 'video' && ('adj' in clip
            ? <AdjustmentSections clip={clip as AdjustmentClip} trackId={selected.trackId} />
            : <VideoSections clip={clip as VideoClip} trackId={selected.trackId} />)}
          {track.kind === 'audio' && <AudioSections clip={clip as AudioClip} trackId={selected.trackId} />}
          {track.kind === 'text' && <TextSections clip={clip as TextClip} trackId={selected.trackId} />}
        </>
      )}
    </>
  );
}

/** The right rail: [Inspector | Prompt] tabs (parked-features plan,
 *  Feature 1 §3). The active tab persists across sessions; when a prompt
 *  job finishes, the Prompt tab asks to become active (the plan-draft open
 *  point's pragmatic answer: flip the stored tab, never steal focus
 *  mid-keystroke beyond the tab itself). */
export default function Inspector() {
  const [tab, setTab] = useState<'inspector' | 'prompt'>(() => {
    // FIX D: a pending Home hand-off (prompt draft / resize) beats
    // the persisted tab — the user just asked for that surface.
    if (consumeInspectorTabOpen()) return 'inspector';
    if (consumePromptTabOpen()) return 'prompt';
    try { return localStorage.getItem('cutlab.inspector.tab') === 'prompt' ? 'prompt' : 'inspector'; }
    catch { return 'inspector'; }
  });
  useEffect(() => {
    const onFlip = () => setTab('prompt');
    window.addEventListener('cutlab:prompt-ready', onFlip);
    return () => window.removeEventListener('cutlab:prompt-ready', onFlip);
  }, []);
  // FIX D: Home's prompt bar / quick tiles ask for a specific rail
  // tab (Prompt with a prefilled draft, or Inspector for Resize).
  // Requests are sticky one-shots: a not-yet-mounted rail hears them
  // through its initial tab, a mounted rail through this subscription.
  useEffect(() => subscribePromptDraft(() => {
    if (consumeInspectorTabOpen()) choose('inspector');
    else if (consumePromptTabOpen()) choose('prompt');
  }), []);
  // FIX C: Help → Keyboard shortcuts asks for the Inspector tab (the
  // shortcuts disclosure lives in the project view); the disclosure
  // itself consumes the same request to open.
  useEffect(() => subscribeShortcutsOpen(() => choose('inspector')), []);
  const choose = (t: 'inspector' | 'prompt') => {
    setTab(t);
    try { localStorage.setItem('cutlab.inspector.tab', t); } catch { /* session only */ }
  };
  return (
    <aside className="flex w-full min-w-0 flex-1 flex-col border-l border-[#3a3a3a] bg-[#212121]">
      <div className="flex shrink-0 border-b border-[#333]" role="tablist" aria-label="Inspector panels">
        {(['inspector', 'prompt'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`flex-1 px-3 py-2 text-[12px] font-medium capitalize transition-colors duration-200 ${
              tab === t ? 'bg-[#2a2a2a] text-[#e8e8e8] shadow-[inset_0_-2px_0_#C0C0C0]' : 'text-[#a8a8a8] hover:text-[#c9c9c9]'
            }`}
            onClick={() => choose(t)}
          >
            {t === 'inspector' ? 'Inspector' : 'Prompt'}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {tab === 'inspector' ? <InspectorBody /> : <PromptPanel />}
      </div>
    </aside>
  );
}

/** Effects list editor (I.x) — ONE component shared by video, compound
 *  and adjustment clips: all three carry the same ClipEffect[] model. */
function EffectsSection({ effects, patch }: {
  effects: ClipEffect[] | undefined;
  patch: (fn: (c: { effects?: ClipEffect[] }) => void, history?: boolean) => void;
}) {
  return (
    <>
      <Section title="Effects">
        <div className="mb-1.5 flex flex-wrap gap-1">
          {EFFECTS.map((e) => (
            <button key={e.type} className="btn small"
              onClick={() => patch((c) => {
                const list = c.effects ?? [];
                if (!list.some((x) => x.type === e.type)) list.push({ type: e.type, value: e.def });
                c.effects = list;
              })}>
              + {e.label.split(' ')[0]}
            </button>
          ))}
        </div>
        {(effects ?? []).length > 1 && (
          <button className="btn small mb-1.5" onClick={() => patch((c) => {
            const anyOff = (c.effects ?? []).some((x) => x.enabled === false);
            c.effects = (c.effects ?? []).map((x) => ({ ...x, enabled: anyOff ? true : false }));
          })}>
            {(effects ?? []).some((x) => x.enabled === false) ? 'Enable all effects' : 'Bypass all effects'}
          </button>
        )}
        {(effects ?? []).map((ef, i) => {
          const spec = EFFECTS.find((x) => x.type === ef.type)!;
          const off = ef.enabled === false;
          return (
            <div key={i} style={off ? { opacity: 0.45 } : undefined}>
              <div className="flex items-center gap-1">
                <Switch size="sm" checked={!off} ariaLabel={spec.label}
                  title={off ? 'Enable effect' : 'Bypass effect'}
                  onChange={(v) => patch((c) => { c.effects![i].enabled = v; })} />
                <div className="min-w-0 flex-1">
                  <Slider label={spec.label} value={ef.value} min={spec.min} max={spec.max} step={0.01}
                    onLive={(v) => patch((c) => { c.effects![i].value = v; }, false)} />
                </div>
                <button className="btn icon" style={{ padding: '0 4px' }} title="Remove effect"
                  onClick={() => patch((c) => { c.effects = (c.effects ?? []).filter((_, j) => j !== i); })}>×</button>
              </div>
              {ef.type === 'relight' && (
                <div className="mt-1 pl-6">
                  {(ef.lights ?? []).map((lt, li) => (
                    <div key={li} className="mb-1 rounded border border-[#3a3d42] p-1">
                      <div className="flex items-center gap-1">
                        <span className="text-[11px] text-[#a8a8a8]">Light {li + 1}</span>
                        <input type="color" value={lt.color} className="h-5 w-7 cursor-pointer rounded border border-[#333] bg-transparent"
                          onChange={(ev) => patch((c) => { c.effects![i].lights![li].color = ev.target.value; })} />
                        <button className="btn small danger" title="Remove light"
                          onClick={() => patch((c) => { c.effects![i].lights = (c.effects![i].lights ?? []).filter((_, j) => j !== li); })}>✕</button>
                      </div>
                      <Slider label="x" value={lt.x} min={0} max={1} onLive={(v) => patch((c) => { c.effects![i].lights![li].x = v; }, false)} />
                      <Slider label="y" value={lt.y} min={0} max={1} onLive={(v) => patch((c) => { c.effects![i].lights![li].y = v; }, false)} />
                      <Slider label="radius" value={lt.radius} min={0.1} max={1} onLive={(v) => patch((c) => { c.effects![i].lights![li].radius = v; }, false)} />
                      <Slider label="intensity" value={lt.intensity} min={0} max={1} onLive={(v) => patch((c) => { c.effects![i].lights![li].intensity = v; }, false)} />
                    </div>
                  ))}
                  {(ef.lights ?? []).length < 2 && (
                    <button className="btn small" onClick={() => patch((c) => {
                      c.effects![i].lights = [...(c.effects![i].lights ?? []), { x: 0.3, y: 0.3, color: '#ffd9a0', radius: 0.5, intensity: 0.7 }];
                    })}>+ Add light (max 2)</button>
                  )}
                </div>
              )}
              {ef.type === 'haze' && (
                <div className="grid grid-cols-2 gap-x-2 pl-6">
                  <Num label="Centre X" value={ef.params?.cx ?? 0.5} step={0.05} min={0} max={1}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), cx: v }; })} />
                  <Num label="Centre Y" value={ef.params?.cy ?? 0.5} step={0.05} min={0} max={1}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), cy: v }; })} />
                </div>
              )}
              {ef.type === 'turbulent-displace' && (
                <div className="grid grid-cols-3 gap-x-2 pl-6">
                  <Num label="Scale" value={ef.params?.scale ?? 0.5} step={0.05} min={0} max={1}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), scale: v }; })} />
                  <Num label="Seed" value={ef.params?.seed ?? 0} step={1} min={0} max={99}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), seed: v }; })} />
                  <Num label="Evolution" value={ef.params?.evolution ?? 0.35} step={0.05} min={0} max={1}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), evolution: v }; })} />
                  <Num label="Falloff" value={ef.params?.falloff ?? 0.85} step={0.05} min={0} max={1}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), falloff: v }; })} />
                  <Num label="AE Amount px" value={ef.params?.amount ?? 0} step={5} min={0} max={1000}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), amount: v }; })} />
                  <Num label="AE Size px" value={ef.params?.size ?? 100} step={2} min={8} max={1000}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), size: v }; })} />
                  <Num label="AE Complexity" value={ef.params?.complexity ?? 1} step={0.1} min={0.2} max={5}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), complexity: v }; })} />
                  <Num label="AE Evo °/s" value={ef.params?.evolution_rate ?? 0} step={10} min={0} max={2000}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), evolution_rate: v }; })} />
                  <Num label="AE Pin All" value={ef.params?.pin ?? 0} step={1} min={0} max={1}
                    onCommit={(v) => patch((c) => { c.effects![i].params = { ...(c.effects![i].params ?? {}), pin: v }; })} />
                </div>
              )}
              {(ef.type === 'wide-angle' || ef.type === 'motion-blur' || ef.type === 'turbulent-displace') && (
                <p className="pl-6 text-[11px] text-[#a8a8a8]">Render-only effect — the preview does not approximate it{ef.type === 'motion-blur' ? '; strength maps to at most the 4× reference ceiling in Lane B' : ef.type === 'turbulent-displace' ? '; a turbulence field warps the layer in Lane B — legacy mode fades strength toward the layer top (Falloff); setting AE Amount switches to literal After Effects values (amount/size px, complexity, Pin All, evolution °/s) for tutorial-recipe bubble clones — pair with a matte (roto) layer underneath a clean copy' : ''}.</p>
              )}
              {ef.type === 'tv-lines' && (
                <p className="pl-6 text-[11px] text-[#a8a8a8]">Half-strength discipline: the texture reads cheap above ~0.5.</p>
              )}
            </div>
          );
        })}
        {(effects ?? []).length === 0 && <p className="text-[11px] text-[#a8a8a8]">No effects on this clip.</p>}
      </Section>
    </>
  );
}

function VideoSections({ clip, trackId }: { clip: VideoClip; trackId: string }) {
  const project = useStore((s) => s.project);
  const t = clip.transform;
  const local = playback.time - clip.start;
  const fps = store.get().project.canvas.fps;
  const setT = (fn: (c: VideoClip) => void, history = true) => patchClip(trackId, clip.id, (c) => fn(c as VideoClip), history);

  const autoKey = useStore((s) => s.autoKey);
  const captureMaskKey = () => {
    if (local < 0 || local > clipDuration(clip) || !clip.mask) return;
    const m = maskAt(clip, local) ?? clip.mask;
    const kt = qFrame(local, fps);
    setT((c) => {
      const kfs = [...(c.keyframes ?? [])];
      const existing = kfs.find((k) => Math.abs(k.t - kt) <= 1 / fps);
      if (existing) existing.mask = { x: m.x, y: m.y, w: m.w, h: m.h };
      else {
        kfs.push({ t: kt, mask: { x: m.x, y: m.y, w: m.w, h: m.h }, ease: 'easeInOut' });
        kfs.sort((a, b) => a.t - b.t);
      }
      c.keyframes = kfs;
    });
  };
  const captureFxKey = () => {
    if (local < 0 || local > clipDuration(clip)) return;
    const kt = qFrame(local, fps);
    const fx: Record<string, number> = {};
    for (const e of clip.effects ?? []) fx[e.type] = effectValueAt(clip, e.type, local) ?? e.value;
    setT((c) => {
      const kfs = [...(c.keyframes ?? [])];
      const existing = kfs.find((k) => Math.abs(k.t - kt) <= 1 / fps);
      if (existing) existing.fx = { ...(existing.fx ?? {}), ...fx };
      else {
        kfs.push({ t: kt, fx, ease: 'easeInOut' });
        kfs.sort((a, b) => a.t - b.t);
      }
      c.keyframes = kfs;
    });
  };

  const addKeyframe = () => {
    if (local < 0 || local > clipDuration(clip)) {
      store.toastMsg('info', 'Park the playhead inside the clip to add a keyframe there.');
      return;
    }
    const cur = evalTransform(clip, local);
    const kt = qFrame(local, fps);
    setT((c) => {
      const kfs = (c.keyframes ?? []).filter((k) => Math.abs(k.t - kt) > 1 / fps);
      kfs.push({ t: kt, x: cur.x, y: cur.y, scale: cur.scale, rotation: cur.rotation, opacity: cur.opacity, ease: 'easeInOut' });
      kfs.sort((a, b) => a.t - b.t);
      c.keyframes = kfs;
    });
  };

  return (
    <>
      <Section title="Transform">
        <Slider label="Position X" value={t.x} min={-720} max={720} step={1}
          onLive={(v) => setT((c) => { c.transform.x = v; }, false)} format={(v) => `${Math.round(v)}px`} />
        <Slider label="Position Y" value={t.y} min={-1280} max={1280} step={1}
          onLive={(v) => setT((c) => { c.transform.y = v; }, false)} format={(v) => `${Math.round(v)}px`} />
        <Slider label="Scale" value={t.scale} min={0.1} max={4} step={0.01}
          onLive={(v) => setT((c) => { c.transform.scale = v; }, false)} format={(v) => v.toFixed(2)} />
        <Slider label="Rotation" value={t.rotation} min={-180} max={180} step={0.5}
          onLive={(v) => setT((c) => { c.transform.rotation = v; }, false)} format={(v) => `${v.toFixed(0)}°`} />
        <Slider label="Opacity" value={t.opacity} min={0} max={1} step={0.01}
          onLive={(v) => setT((c) => { c.transform.opacity = v; }, false)} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          <button className="btn small" onClick={() => setT((c) => { c.transform = { ...DEFAULT_TRANSFORM }; })}>
            Reset transform
          </button>
          <span className="text-[12px] text-[#a8a8a8]">
            <Switch size="sm" checked={!!clip.flipH} label="Flip H" onChange={(v) => setT((c) => { c.flipH = v; })} />
          </span>
          <span className="text-[12px] text-[#a8a8a8]">
            <Switch size="sm" checked={!!clip.flipV} label="Flip V" onChange={(v) => setT((c) => { c.flipV = v; })} />
          </span>
        </div>
        <label className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[12px] text-[#a8a8a8]">Blend mode</span>
          <select className="field" value={clip.blend ?? 'normal'}
            onChange={(e) => setT((c) => { c.blend = e.target.value as VideoClip['blend']; })}>
            {['normal', 'screen', 'multiply', 'overlay', 'lighten', 'darken', 'hard-light'].map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        {'media' in clip && (
          <label className="flex items-center justify-between gap-2 pt-1">
            <span className="text-[12px] text-[#a8a8a8]">Fit (C.11)</span>
            <select className="field" value={clip.fit ?? 'cover'}
              onChange={(e) => setT((c) => { c.fit = e.target.value as VideoClip['fit']; })}>
              <option value="cover">cover — fill the frame</option>
              <option value="blur-fill">blur-fill — whole frame over a blurred copy</option>
            </select>
          </label>
        )}
      </Section>

      <Section title="Crop">
        {!clip.crop ? (
          <button className="btn small" onClick={() => setT((c) => { c.crop = { l: 0, t: 0, r: 0, b: 0, softness: 0 }; })}>
            Enable crop
          </button>
        ) : (
          <>
            <div className="flex justify-end pb-1">
              <button className="btn small" onClick={() => setT((c) => { c.crop = null; })}>Disable</button>
            </div>
            <Slider label="Left" value={clip.crop.l} min={0} max={0.9} onLive={(v) => setT((c) => { c.crop!.l = v; }, false)} />
            <Slider label="Top" value={clip.crop.t} min={0} max={0.9} onLive={(v) => setT((c) => { c.crop!.t = v; }, false)} />
            <Slider label="Right" value={clip.crop.r} min={0} max={0.9} onLive={(v) => setT((c) => { c.crop!.r = v; }, false)} />
            <Slider label="Bottom" value={clip.crop.b} min={0} max={0.9} onLive={(v) => setT((c) => { c.crop!.b = v; }, false)} />
            <Slider label="Softness" value={clip.crop.softness} min={0} max={0.2} step={0.005} onLive={(v) => setT((c) => { c.crop!.softness = v; }, false)} />
            <p className="text-[11px] leading-snug text-[#a8a8a8]">Preview crops the frame edges; the server render crops the source before scaling (softness feathers there).</p>
          </>
        )}
      </Section>

      <Section title="Keyframes">
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          <button className="btn small" onClick={addKeyframe}>Add keyframe at playhead</button>
          <button className="btn small" onClick={() => seekKeyframe(-1)} title="Previous keyframe ([)">[ ←</button>
          <button className="btn small" onClick={() => seekKeyframe(1)} title="Next keyframe (])">→ ]</button>
          <span className="text-[11px] text-[#a8a8a8]" title="Dragging in the preview writes keyframes (M.11)">
            <Switch size="sm" checked={autoKey} label="Auto-key" onChange={(v) => store.set({ autoKey: v })} />
          </span>
        </div>
        <div className="mb-1.5 flex flex-wrap gap-1">
          <button className="btn small" onClick={copyKeyframes}>Copy keyframes</button>
          <button className="btn small" onClick={pasteKeyframes}>Paste keyframes</button>
          {clip.mask && (
            <button className="btn small" onClick={captureMaskKey} title="Capture the current mask geometry as a keyframe (M.8)">+ Mask key</button>
          )}
          {(clip.effects ?? []).length > 0 && (
            <button className="btn small" onClick={captureFxKey} title="Capture the current effect values as a keyframe (M.8)">+ Effect key</button>
          )}
        </div>
        {(clip.keyframes ?? []).length === 0 && (
          <p className="text-[11px] text-[#a8a8a8]">None yet. A keyframe captures the transform at the playhead; values interpolate between keyframes.</p>
        )}
        {(clip.keyframes ?? []).map((k, i) => (
          <div key={i} className="mb-1.5 rounded border border-[#3a3a3a] bg-[#262626] p-1.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[11px] text-[#ffd75e]">◆ {k.t.toFixed(2)}s</span>
              <span className="flex items-center gap-1">
                <select className="field" style={{ padding: '1px 4px', fontSize: 11 }} value={k.ease ?? 'linear'}
                  onChange={(e) => setT((c) => { c.keyframes![i].ease = e.target.value as Keyframe['ease']; })}>
                  <option value="linear">linear</option>
                  <option value="easeIn">ease in</option>
                  <option value="easeOut">ease out</option>
                  <option value="cubicOut">Cubic Out</option>
                  <option value="easeInOut">ease in-out</option>
                  <option value="reboundOut">Rebound Out</option>
                  <option value="backIn">Back In</option>
                  <option value="bezier">Bezier (graph)</option>
                </select>
                <span className="text-[11px] text-[#a8a8a8]" title="Hold this value flat until the next keyframe">
                  <Switch size="sm" checked={!!k.hold} label="hold" onChange={(v) => setT((c) => { c.keyframes![i].hold = v; })} />
                </span>
                <button className="btn icon" style={{ padding: '0 4px' }} title="Delete keyframe"
                  onClick={() => setT((c) => { c.keyframes = (c.keyframes ?? []).filter((_, j) => j !== i); })}>×</button>
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-2">
              <Num label="x" value={k.x ?? t.x} step={1} onCommit={(v) => setT((c) => { c.keyframes![i].x = v; })} />
              <Num label="y" value={k.y ?? t.y} step={1} onCommit={(v) => setT((c) => { c.keyframes![i].y = v; })} />
              <Num label="scale" value={k.scale ?? t.scale} step={0.05} onCommit={(v) => setT((c) => { c.keyframes![i].scale = v; })} />
              <Num label="opacity" value={k.opacity ?? t.opacity} step={0.05} min={0} max={1} onCommit={(v) => setT((c) => { c.keyframes![i].opacity = v; })} />
            </div>
          </div>
        ))}
        {(clip.keyframes ?? []).length > 0 && <GraphEditor clip={clip} trackId={trackId} />}
      </Section>

      <Section title="Colour">
        <ColourEntry
          layers={gradeLayersOf(clip as VideoClip)}
          onLayers={(next, history = true) => patchClip(trackId, clip.id, (c) => {
            const vc = c as VideoClip;
            vc.grades = next;
            delete vc.grade;
          }, history)} />
      </Section>

      <EffectsSection effects={clip.effects} patch={(fn, history = true) => setT((c) => fn(c), history)} />

      {'media' in clip && (<>
      <Section title="Mask">
        {!clip.mask ? (
          <button className="btn small" onClick={() => setT((c) => {
            c.mask = { shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 0.02, invert: false };
          })}>Enable mask</button>
        ) : (
          <>
            <div className="flex items-center gap-2 pb-1">
              <select className="field flex-1" value={clip.mask.shape}
                onChange={(e) => setT((c) => {
                  c.mask!.shape = e.target.value as 'rect' | 'circle' | 'linear' | 'pen';
                  if (c.mask!.shape === 'pen' && !(c.mask!.points?.length)) {
                    c.mask!.points = [
                      { x: c.mask!.x, y: c.mask!.y },
                      { x: c.mask!.x + c.mask!.w, y: c.mask!.y },
                      { x: c.mask!.x + c.mask!.w, y: c.mask!.y + c.mask!.h },
                      { x: c.mask!.x, y: c.mask!.y + c.mask!.h },
                    ];
                  }
                })}>
                <option value="rect">rectangle</option>
                <option value="circle">ellipse</option>
                <option value="linear">linear band</option>
                <option value="pen">pen polygon</option>
              </select>
              <button className="btn small" onClick={() => setT((c) => { c.mask = null; })}>Disable</button>
            </div>
            <Slider label="X" value={clip.mask.x} min={0} max={1} onLive={(v) => setT((c) => { c.mask!.x = v; }, false)} />
            <Slider label="Y" value={clip.mask.y} min={0} max={1} onLive={(v) => setT((c) => { c.mask!.y = v; }, false)} />
            <Slider label="Width" value={clip.mask.w} min={0.02} max={1} onLive={(v) => setT((c) => { c.mask!.w = v; }, false)} />
            <Slider label="Height" value={clip.mask.h} min={0.02} max={1} onLive={(v) => setT((c) => { c.mask!.h = v; }, false)} />
            <Slider label="Feather" value={clip.mask.feather} min={0} max={0.2} step={0.005} onLive={(v) => setT((c) => { c.mask!.feather = v; }, false)} />
            <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
              <Switch checked={clip.mask.invert} label="Invert mask"
                onChange={(v) => setT((c) => { c.mask!.invert = v; })} />
            </span>
            {clip.mask.shape === 'linear' && (
              <Slider label="Angle" value={clip.mask.angle ?? 0} min={-90} max={90} step={1}
                onLive={(v) => setT((c) => { c.mask!.angle = v; }, false)} format={(v) => `${Math.round(v)}°`} />
            )}
            {clip.mask.shape === 'pen' && (
              <div className="flex items-center gap-1.5 py-0.5">
                <span className="text-[11px] text-[#a8a8a8]">{(clip.mask.points ?? []).length} pen points — drag them on the stage</span>
                <button className="btn small" onClick={() => setT((c) => {
                  c.mask!.points = [...(c.mask!.points ?? []), { x: 0.5, y: 0.5 }];
                })}>+ point</button>
                <button className="btn small" onClick={() => setT((c) => {
                  c.mask!.points = (c.mask!.points ?? []).slice(0, -1);
                })}>− point</button>
              </div>
            )}
            <p className="text-[11px] leading-snug text-[#a8a8a8]">Drag the outline on the stage to shape the mask (O.4); feather renders as a soft-edge approximation in preview and exactly in Lane B.</p>
            <div className="mt-1 border-t border-[#2c2c2c] pt-1.5">
              <div className="field-label">Matte media (O.9)</div>
              <select className="field w-full" value={clip.matteId ?? ''}
                onChange={(e) => setT((c) => { c.matteId = e.target.value || undefined; })}>
                <option value="">No matte — clip's own alpha</option>
                {project.media.filter((m) => m.kind === 'matte' || m.kind === 'depth').map((m) => (
                  <option key={m.id} value={m.id}>{m.src} ({m.kind})</option>
                ))}
              </select>
              <div className="mt-1 flex flex-wrap gap-1">
                <button className="btn small" disabled={!clip.matteId && !clip.chromaKey}
                  title="Duplicate this subject as its own silhouette shadow below"
                  onClick={() => addContactShadow(trackId, clip.id)}>Add contact shadow</button>
                <button className="btn small" disabled={!clip.matteId}
                  title="Move the text track below this subject's track"
                  onClick={() => sendTextBehindSubject(trackId)}>Text behind subject</button>
              </div>
            </div>
            <div className="mt-1 border-t border-[#2c2c2c] pt-1.5">
              <div className="flex items-center gap-2">
                <span className="field-label">Chroma key (O.8)</span>
                <div className="flex-1" />
                {!clip.chromaKey ? (
                  <button className="btn small" onClick={() => setT((c) => {
                    c.chromaKey = { color: '#00b140', intensity: 0.5, shadow: 0.3, spill: 0.4 };
                  })}>Enable</button>
                ) : (
                  <button className="btn small" onClick={() => setT((c) => { c.chromaKey = undefined; })}>Disable</button>
                )}
              </div>
              {clip.chromaKey && (
                <>
                  <div className="flex items-center gap-2 py-0.5">
                    <span className="w-[86px] shrink-0 text-[12px] text-[#c9c9c9]">Key colour</span>
                    <input type="color" value={clip.chromaKey.color} className="h-6 w-10 cursor-pointer rounded border border-[#333] bg-transparent"
                      onChange={(e) => setT((c) => { c.chromaKey!.color = e.target.value; })} />
                    <span className="font-mono text-[11px] text-[#a8a8a8]">{clip.chromaKey.color}</span>
                  </div>
                  <Slider label="Intensity" value={clip.chromaKey.intensity} min={0} max={1}
                    onLive={(v) => setT((c) => { c.chromaKey!.intensity = v; }, false)} />
                  <Slider label="Shadow" value={clip.chromaKey.shadow} min={0} max={1}
                    onLive={(v) => setT((c) => { c.chromaKey!.shadow = v; }, false)} />
                  <Slider label="Spill fix" value={clip.chromaKey.spill} min={0} max={1}
                    onLive={(v) => setT((c) => { c.chromaKey!.spill = v; }, false)} />
                  <p className="text-[11px] leading-snug text-[#a8a8a8]">Keys in the server render (chromakey + spill pass); ~0.5 intensity is the studied working value. Spill residue: desaturate green in Colour → HSL.</p>
                </>
              )}
            </div>
          </>
        )}
      </Section>
      </>)}

      {'media' in clip && (<>
      <Section title="Clip audio">
        <Slider label="Volume" value={clip.volume} min={0} max={1}
          onLive={(v) => setT((c) => { c.volume = v; }, false)} />
        <Num label="Fade in (s)" value={clip.fadeIn ?? 0} step={0.05} min={0}
          onCommit={(v) => setT((c) => { c.fadeIn = v; })} />
        <Num label="Fade out (s)" value={clip.fadeOut ?? 0} step={0.05} min={0}
          onCommit={(v) => setT((c) => { c.fadeOut = v; })} />
        <Slider label="Pan" value={clip.pan ?? 0} min={-1} max={1} step={0.01}
          onLive={(v) => setT((c) => { c.pan = v; }, false)} format={(v) => (v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} />
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={!!clip.denoise} label="Reduce noise (applies at render)"
            onChange={(v) => setT((c) => { c.denoise = v; })} />
        </span>
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={clip.muted} label="Muted"
            onChange={(v) => setT((c) => { c.muted = v; })} />
        </span>
        <p className="text-[11px] leading-snug text-[#a8a8a8]">Ride levels on the clip's volume line in the timeline (Alt+click adds a point).</p>
      </Section>
      <EqBandsSection clip={clip as MediaClip} setEq={(fn, history) => setT((c) => fn(c as unknown as MediaClip), history)} />
      <AnalysisSection clip={clip as MediaClip} isVideo />
      <VoiceIsolationSection clip={clip as MediaClip} trackId={trackId} />
      </>)}
    </>
  );
}

/**
 * AnalysisSection (D1.3): the server analysis lanes, wired to the clip.
 * Transcribe → captions (audio + video clips); Track subject (video
 * clips) arms the stage seed-box picker, then the finished job's Apply
 * button lives on its render-queue row.
 */
function AnalysisSection({ clip, isVideo }: { clip: MediaClip; isVideo: boolean }) {
  const [busy, setBusy] = useState(false);
  const armed = useSyncExternalStore(trackSeed.subscribe, trackSeed.get);
  const transcribe = async () => {
    setBusy(true);
    try {
      await transcribeClipToCaptions(clip);
    } catch (e) {
      store.toastMsg('error', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const armTrack = () => {
    const seedClipT = clamp(playback.time - clip.start, 0, Math.max(0, clipDuration(clip) - 0.05));
    trackSeed.arm({
      clipId: clip.id,
      seedClipT,
      onSeed: (box) => {
        void queueTrackJob(clip as VideoClip, box, seedClipT).catch((e) => {
          store.toastMsg('error', e instanceof Error ? e.message : String(e));
        });
      },
    });
  };
  return (
    <Section title="Speech & tracking (server)">
      <div className="flex flex-col gap-1.5">
        <button className="btn" disabled={busy} onClick={() => void transcribe()}>
          {busy ? 'Transcribing on server…' : 'Transcribe → Captions'}
        </button>
        {isVideo && (
          <button className="btn" aria-pressed={armed?.clipId === clip.id}
            style={armed?.clipId === clip.id ? { borderColor: '#E8C268', color: '#E8C268' } : undefined}
            onClick={armTrack}>
            {armed?.clipId === clip.id ? 'Drag a box on the stage…' : 'Track subject…'}
          </button>
        )}
        <p className="text-[11px] leading-snug text-[#a8a8a8]">
          Transcription lands as caption clips in this clip's span, styled like your last
          caption. Tracking follows the boxed subject from the playhead frame; apply its
          keyframes from the render queue when the job finishes.
        </p>
      </div>
    </Section>
  );
}

function AudioSections({ clip, trackId }: { clip: AudioClip; trackId: string }) {
  const setA = (fn: (c: AudioClip) => void, history = true) => patchClip(trackId, clip.id, (c) => fn(c as AudioClip), history);
  return (
    <>
    <Section title="Audio">
      <Slider label="Volume" value={clip.volume} min={0} max={1}
        onLive={(v) => setA((c) => { c.volume = v; }, false)} />
      <Slider label="Pan" value={clip.pan ?? 0} min={-1} max={1} step={0.01}
        onLive={(v) => setA((c) => { c.pan = v; }, false)} format={(v) => (v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} />
      <Num label="Fade in (s)" value={clip.fadeIn} step={0.05} min={0}
        onCommit={(v) => setA((c) => { c.fadeIn = v; })} />
      <Num label="Fade out (s)" value={clip.fadeOut} step={0.05} min={0}
        onCommit={(v) => setA((c) => { c.fadeOut = v; })} />
      <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
        <Switch checked={!!clip.denoise} label="Reduce noise (applies at render)"
          onChange={(v) => setA((c) => { c.denoise = v; })} />
      </span>
      <label className="flex items-center justify-between gap-2 py-0.5">
        <span className="text-[12px] text-[#a8a8a8]">Voice effect (render)</span>
        <select className="field" value={clip.voiceFx ?? 'none'}
          onChange={(e) => setA((c) => { c.voiceFx = e.target.value as AudioClip['voiceFx']; })}>
          <option value="none">none</option>
          <option value="echo">echo</option>
          <option value="hall">big hall</option>
        </select>
      </label>
    </Section>
    <EqBandsSection clip={clip} setEq={(fn, history) => setA((c) => fn(c), history)} />
    <AnalysisSection clip={clip} isVideo={false} />
    <VoiceIsolationSection clip={clip} trackId={trackId} />
    </>
  );
}

/**
 * EqBandsSection (D2.5): the 6-band parametric EQ editor. Bands are
 * peaking filters (freq / gain dB / Q) — the preview's WebAudio
 * biquads and Lane B's equalizer chain run the same maths. A clip
 * still carrying only the legacy 3-band fields is migrated on first
 * edit (bandsOf maps them in; the legacy fields are cleared so one
 * representation remains).
 */
export function EqBandsSection({ clip, setEq }: {
  clip: MediaClip;
  setEq: (fn: (c: MediaClip) => void, history?: boolean) => void;
}) {
  const bands = bandsOf(clip);
  const usingLegacy = !clip.eqBands && !!(clip.eqLow || clip.eqMid || clip.eqHigh);
  const write = (i: number, patch: Partial<EqBand>, history = true) =>
    setEq((c) => {
      const next = bandsOf(c).map((b, j) => (j === i ? { ...b, ...patch } : b));
      c.eqBands = next;
      delete c.eqLow; delete c.eqMid; delete c.eqHigh;
    }, history);
  return (
    <Section title="EQ (6-band parametric)">
      {bands.map((b, i) => (
        <div key={i} className="border-b border-[#2c2c2c] py-1 last:border-b-0">
          <div className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-[11px] text-[#a8a8a8]">{i + 1}</span>
            <input type="number" className="field w-[72px]" min={30} max={16000} step={10}
              value={b.freq} aria-label={`Band ${i + 1} frequency (Hz)`}
              onChange={(e) => write(i, { freq: Number(e.target.value) || b.freq })} />
            <span className="text-[11px] text-[#a8a8a8]">Hz</span>
            <span className="flex-1" />
            <span className="text-[11px] text-[#a8a8a8]">Q</span>
            <input type="number" className="field w-[52px]" min={0.2} max={10} step={0.1}
              value={b.q} aria-label={`Band ${i + 1} Q`}
              onChange={(e) => write(i, { q: Number(e.target.value) || b.q })} />
          </div>
          <div className="flex items-center gap-1.5 pl-[22px] pt-0.5">
            <span className="shrink-0 text-[11px] text-[#a8a8a8]">Gain</span>
            <input type="range" className="min-w-0 flex-1" min={-18} max={18} step={0.5}
              value={b.gain} aria-label={`Band ${i + 1} gain (dB)`}
              onChange={(e) => write(i, { gain: Number(e.target.value) }, false)} />
            <span className="w-9 shrink-0 text-right font-mono text-[11px] text-[#c9c9c9]">{b.gain > 0 ? '+' : ''}{b.gain.toFixed(1)}</span>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <button className="btn small" onClick={() => setEq((c) => {
          c.eqBands = defaultEqBands();
          delete c.eqLow; delete c.eqMid; delete c.eqHigh;
        })}>Flat</button>
        {usingLegacy && <span className="text-[11px] text-[#a8a8a8]">Showing your 3-band EQ as bands — editing converts it.</span>}
      </div>
      <p className="pt-0.5 text-[11px] leading-snug text-[#a8a8a8]">Distance trick: cut the highs and a voice steps backwards.</p>
    </Section>
  );
}

/**
 * VoiceIsolationSection (D1.5): the demucs lane as a clip effect.
 * Queues a separate job; the finished stem registers as the clip's
 * audioOverride (Original / Isolated toggle + blend strength). The
 * original audio is never modified — removing the override restores
 * the exact original path.
 */
function VoiceIsolationSection({ clip, trackId }: { clip: MediaClip; trackId: string }) {
  const sep = useSyncExternalStore(subscribeSepStatus, () => getSepStatus(clip.id));
  const ov = clip.audioOverride;
  const setOv = (fn: (c: MediaClip) => void, history = true) =>
    patchClip(trackId, clip.id, (c) => fn(c as MediaClip), history);
  const run = () => {
    void isolateClipVoice(clip, trackId).catch((e) => {
      store.toastMsg('error', e instanceof Error ? e.message : String(e));
    });
  };
  return (
    <Section title="Voice isolation">
      {!ov ? (
        <div className="flex flex-col gap-1.5">
          <button className="btn" disabled={sep === 'queued' || sep === 'working'} onClick={run}>
            {sep === 'queued' ? 'Isolation queued…' : sep === 'working' ? 'Separating voice on server…' : 'Isolate voice (server)'}
          </button>
          {sep === 'failed' && <p className="text-[11px] leading-snug text-[#E31000]">The last separation failed — try again.</p>}
          <p className="text-[11px] leading-snug text-[#a8a8a8]">
            The server splits this clip's sound into voice and everything else (about a
            minute). The voice stem becomes this clip's sound; the original file is
            never changed.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1">
            <button className="btn" aria-pressed={!ov.enabled} style={!ov.enabled ? { borderColor: '#E8C268', color: '#E8C268' } : undefined}
              onClick={() => setOv((c) => { if (c.audioOverride) c.audioOverride.enabled = false; })}>
              Original
            </button>
            <button className="btn" aria-pressed={ov.enabled} style={ov.enabled ? { borderColor: '#E8C268', color: '#E8C268' } : undefined}
              onClick={() => setOv((c) => { if (c.audioOverride) c.audioOverride.enabled = true; })}>
              Isolated
            </button>
            <button className="btn" onClick={() => setOv((c) => { c.audioOverride = undefined; })}>Remove</button>
          </div>
          <Slider label="Isolation" value={ov.strength} min={0} max={1} step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onLive={(v) => setOv((c) => { if (c.audioOverride) c.audioOverride.strength = v; }, false)} />
          <p className="text-[11px] leading-snug text-[#a8a8a8]">
            The preview plays the local voice stem. Exports blend the full-quality stem
            against the original by this strength — 100% is voice only.
          </p>
        </div>
      )}
    </Section>
  );
}

function TextSections({ clip, trackId }: { clip: TextClip; trackId: string }) {
  const setX = (fn: (c: TextClip) => void, history = true) => patchClip(trackId, clip.id, (c) => fn(c as TextClip), history);
  const glow = (clip.effects ?? []).includes('glow');
  const fonts = useSyncExternalStore(subscribeFonts, uploadedFontFamilies);
  const [presets, setPresets] = useState<UserTextPreset[]>(() => loadUserPresets());
  const [presetName, setPresetName] = useState('');
  const fontRef = useRef<HTMLInputElement>(null);
  const setGlow = (on: boolean) => setX((c) => {
    const list = (c.effects ?? []).filter((x) => x !== 'glow');
    if (on) {
      list.push('glow');
      c.glowObj = c.glowObj ?? { intensity: 0.6, range: 14 };
    }
    c.effects = list;
  });
  const applyGlowToAll = () => {
    const g = clip.glowObj ?? { intensity: 0.6, range: 14 };
    store.commit((d) => {
      for (const tr of d.tracks) {
        if (tr.kind !== 'text') continue;
        for (const c of tr.clips) {
          const tc = c as TextClip;
          tc.glowObj = { ...g };
          const list = (tc.effects ?? []).filter((x) => x !== 'glow');
          list.push('glow');
          tc.effects = list;
        }
      }
    });
    store.toastMsg('info', 'Signature glow applied to every text clip.');
  };
  const applyUserPreset = (name: string, toAll: boolean) => {
    const preset = presets.find((x) => x.name === name);
    if (!preset) return;
    store.commit((d) => {
      for (const tr of d.tracks) {
        for (const c of tr.clips) {
          if ('text' in c && (toAll || c.id === clip.id)) applyPresetFields(c as TextClip, preset);
        }
      }
    });
  };
  const fontValue = !clip.fontFamily
    ? '__preset'
    : FONT_STACKS.some((f) => f.stack === clip.fontFamily) || fonts.includes(clip.fontFamily)
      ? clip.fontFamily
      : '__custom';
  return (
    <>
      <Section title="Text">
        <textarea className="field w-full" rows={2} value={clip.text}
          onChange={(e) => setX((c) => { c.text = e.target.value; }, false)}
          onBlur={() => snapshot()} />
        <p className="pb-1 text-[11px] leading-snug text-[#a8a8a8]">
          Tip: wrap a word in **double asterisks** to highlight it in the highlight colour.
        </p>
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Preset</span>
          <select className="field" value={clip.style}
            onChange={(e) => {
              setX((c) => { c.style = e.target.value; });
              const st = loadSettings();
              saveSettings({ ...st, lastTextStyle: e.target.value });
            }}>
            {Object.keys(TEXT_PRESETS).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        {presets.length > 0 && (
          <label className="flex items-center justify-between gap-2 py-0.5">
            <span className="text-[12px] text-[#a8a8a8]">My presets</span>
            <select className="field" value="" onChange={(e) => { if (e.target.value) applyUserPreset(e.target.value, false); }}>
              <option value="">apply…</option>
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </label>
        )}
        <div className="flex items-center gap-1.5 py-0.5">
          <input className="field min-w-0 flex-1" placeholder="Name for this style…" value={presetName}
            onChange={(e) => setPresetName(e.target.value)} />
          <button className="btn small" disabled={!presetName.trim()}
            onClick={() => { setPresets(saveUserPreset(presetName.trim(), clip)); setPresetName(''); }}>
            Save preset
          </button>
        </div>
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-1.5 py-0.5">
            <button className="btn small" onClick={() => { const n = presets[presets.length - 1]?.name; if (n) applyUserPreset(n, true); }}>
              Apply last preset to all text
            </button>
            <select className="field" value="" onChange={(e) => { if (e.target.value) setPresets(deleteUserPreset(e.target.value)); }}>
              <option value="">delete preset…</option>
              {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
        )}
        <Num label="Font size" value={clip.fontSize ?? TEXT_PRESETS[clip.style]?.fontSize ?? 54} step={2} min={8} max={300}
          onCommit={(v) => setX((c) => { c.fontSize = v; })} />
        <Num label="Font weight" value={clip.fontWeight ?? 700} step={100} min={100} max={900}
          onCommit={(v) => setX((c) => { c.fontWeight = v; })} />
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Font</span>
          <select className="field" style={{ width: 170 }} value={fontValue}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__preset') setX((c) => { c.fontFamily = undefined; });
              else if (v !== '__custom') setX((c) => { c.fontFamily = v; });
            }}>
            <option value="__preset">Preset default</option>
            {FONT_STACKS.map((f) => <option key={f.stack} value={f.stack}>{f.label}</option>)}
            {fonts.map((f) => <option key={f} value={f}>{f} (uploaded)</option>)}
            <option value="__custom">Custom stack…</option>
          </select>
        </label>
        {fontValue === '__custom' && (
          <input className="field w-full" value={clip.fontFamily ?? ''} placeholder="CSS font stack"
            onChange={(e) => setX((c) => { c.fontFamily = e.target.value || undefined; }, false)}
            onBlur={() => snapshot()} />
        )}
        <div className="flex items-center gap-1.5 py-0.5">
          <button className="btn small" onClick={() => fontRef.current?.click()}>Upload font (.ttf/.otf)</button>
          <input ref={fontRef} type="file" accept=".ttf,.otf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFont(f); e.target.value = ''; }} />
          {fonts.map((f) => (
            <span key={f} className="flex items-center gap-1 rounded bg-[#2a2a2a] px-1.5 py-0.5 text-[11px]">
              {f}
              <button title="Remove font" onClick={() => void removeFont(f)}>×</button>
            </span>
          ))}
        </div>
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Colour</span>
          <input type="color" value={clip.color ?? TEXT_PRESETS[clip.style]?.color ?? '#ffffff'}
            onChange={(e) => setX((c) => { c.color = e.target.value; }, false)} />
        </label>
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Highlight colour</span>
          <span className="flex items-center gap-1.5">
            <input type="color" value={clip.highlightColor ?? '#FFE135'}
              onChange={(e) => setX((c) => { c.highlightColor = e.target.value; }, false)} />
            {clip.highlightColor && (
              <button className="btn small" onClick={() => setX((c) => { c.highlightColor = undefined; })}>Clear</button>
            )}
          </span>
        </label>
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={!!clip.noFill} label="No fill (outline only)"
            onChange={(v) => setX((c) => { c.noFill = v; })} />
        </span>
        <Num label="Stroke width" value={clip.strokeWidth ?? 0} step={1} min={0} max={30}
          onCommit={(v) => setX((c) => { c.strokeWidth = v; })} />
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Stroke colour</span>
          <input type="color" value={clip.strokeColor ?? '#000000'}
            onChange={(e) => setX((c) => { c.strokeColor = e.target.value; }, false)} />
        </label>
      </Section>
      <Section title="Shadow & glow">
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={!!resolveShadow(clip)} label="Shadow"
            onChange={(v) => setX((c) => {
              if (v) { c.shadowObj = { ...DEFAULT_SHADOW }; c.shadow = undefined; }
              else { c.shadowObj = undefined; c.shadow = false; }
            })} />
        </span>
        {resolveShadow(clip) && (
          <>
            <label className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-[12px] text-[#a8a8a8]">Shadow colour</span>
              <input type="color" value={resolveShadow(clip)!.color}
                onChange={(e) => setX((c) => { c.shadowObj = { ...(c.shadowObj ?? DEFAULT_SHADOW), color: e.target.value }; }, false)} />
            </label>
            <Num label="Opacity" value={resolveShadow(clip)!.opacity} step={0.05} min={0} max={1}
              onCommit={(v) => setX((c) => { c.shadowObj = { ...(c.shadowObj ?? DEFAULT_SHADOW), opacity: v }; })} />
            <Num label="Blur (0 = hard edge)" value={resolveShadow(clip)!.blur} step={1} min={0} max={60}
              onCommit={(v) => setX((c) => { c.shadowObj = { ...(c.shadowObj ?? DEFAULT_SHADOW), blur: v }; })} />
            <Num label="Distance" value={resolveShadow(clip)!.distance} step={1} min={0} max={60}
              onCommit={(v) => setX((c) => { c.shadowObj = { ...(c.shadowObj ?? DEFAULT_SHADOW), distance: v }; })} />
            <Num label="Angle (°)" value={resolveShadow(clip)!.angle} step={5} min={0} max={360}
              onCommit={(v) => setX((c) => { c.shadowObj = { ...(c.shadowObj ?? DEFAULT_SHADOW), angle: v }; })} />
          </>
        )}
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={glow} label="Glow (in the text's own colour — never picked)" onChange={(v) => setGlow(v)} />
        </span>
        {glow && (
          <>
            <Slider label="Intensity" value={clip.glowObj?.intensity ?? 0.6} min={0} max={1}
              onLive={(v) => setX((c) => { c.glowObj = { intensity: v, range: c.glowObj?.range ?? 14 }; }, false)} />
            <Slider label="Range" value={clip.glowObj?.range ?? 14} min={0} max={60} step={1}
              onLive={(v) => setX((c) => { c.glowObj = { intensity: c.glowObj?.intensity ?? 0.6, range: v }; }, false)} />
            <button className="btn small" onClick={applyGlowToAll}>Apply this glow to all text clips</button>
          </>
        )}
      </Section>
      <Section title="Background plate">
        {!clip.plate ? (
          <button className="btn small" onClick={() => setX((c) => {
            c.plate = { color: '#000000', opacity: 0.55, radius: 6, padX: 14, padY: 8, offX: 0, offY: 0 };
          })}>Enable plate</button>
        ) : (
          <>
            <div className="flex items-center justify-between pb-1">
              <label className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
                <span>Plate colour</span>
                <input type="color" value={clip.plate.color}
                  onChange={(e) => setX((c) => { c.plate!.color = e.target.value; }, false)} />
              </label>
              <button className="btn small" onClick={() => setX((c) => { c.plate = null; })}>Disable</button>
            </div>
            <Slider label="Opacity" value={clip.plate.opacity} min={0} max={1}
              onLive={(v) => setX((c) => { c.plate!.opacity = v; }, false)} />
            <Num label="Corner radius" value={clip.plate.radius} step={1} min={0} max={60}
              onCommit={(v) => setX((c) => { c.plate!.radius = v; })} />
            <Num label="Pad X" value={clip.plate.padX} step={1} min={0} max={200}
              onCommit={(v) => setX((c) => { c.plate!.padX = v; })} />
            <Num label="Pad Y" value={clip.plate.padY} step={1} min={0} max={200}
              onCommit={(v) => setX((c) => { c.plate!.padY = v; })} />
            <Num label="Offset X" value={clip.plate.offX} step={1} min={-200} max={200}
              onCommit={(v) => setX((c) => { c.plate!.offX = v; })} />
            <Num label="Offset Y" value={clip.plate.offY} step={1} min={-200} max={200}
              onCommit={(v) => setX((c) => { c.plate!.offY = v; })} />
            <label className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-[12px] text-[#a8a8a8]">Shape (H.12)</span>
              <select className="field" value={clip.plate.shape ?? 'rect'}
                onChange={(e) => setX((c) => {
                  c.plate!.shape = e.target.value as 'rect' | 'bubble';
                  if (c.plate!.shape === 'bubble' && !c.plate!.tail) {
                    c.plate!.tail = 'bottom';
                    c.plate!.tailAt = 0.5;
                    c.plate!.tailSize = 14;
                  }
                })}>
                <option value="rect">rectangle</option>
                <option value="bubble">speech bubble</option>
              </select>
            </label>
            {clip.plate.shape === 'bubble' && (
              <>
                <label className="flex items-center justify-between gap-2 py-0.5">
                  <span className="text-[12px] text-[#a8a8a8]">Tail edge</span>
                  <select className="field" value={clip.plate.tail ?? 'bottom'}
                    onChange={(e) => setX((c) => { c.plate!.tail = e.target.value as 'bottom' | 'top' | 'left' | 'right'; })}>
                    {['bottom', 'top', 'left', 'right'].map((t2) => <option key={t2} value={t2}>{t2}</option>)}
                  </select>
                </label>
                <Slider label="Tail position" value={clip.plate.tailAt ?? 0.5} min={0.05} max={0.95}
                  onLive={(v) => setX((c) => { c.plate!.tailAt = v; }, false)} />
                <Num label="Tail size" value={clip.plate.tailSize ?? 14} step={1} min={4} max={60}
                  onCommit={(v) => setX((c) => { c.plate!.tailSize = v; })} />
              </>
            )}
          </>
        )}
      </Section>
      <Section title="Spacing & position">
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Alignment</span>
          <select className="field" value={clip.align ?? 'center'}
            onChange={(e) => setX((c) => { c.align = e.target.value as TextClip['align']; })}>
            <option value="left">left</option>
            <option value="center">centre</option>
            <option value="right">right</option>
          </select>
        </label>
        <Num label="Character spacing" value={clip.charSpacing ?? 0} step={0.5} min={-5} max={40}
          onCommit={(v) => setX((c) => { c.charSpacing = v; })} />
        <Num label="Line spacing" value={clip.lineSpacing ?? 1.1} step={0.05} min={0.8} max={2.5}
          onCommit={(v) => setX((c) => { c.lineSpacing = v; })} />
        <Slider label="Curve radius (H.11)" value={clip.curve ?? 0} min={-1200} max={1200} step={10}
          onLive={(v) => setX((c) => { c.curve = Math.abs(v) < 40 ? undefined : v; }, false)}
          format={(v) => (Math.abs(v) < 40 ? 'straight' : `${Math.round(v)}px ${v > 0 ? '∩' : '∪'}`)} />
        <p className="text-[11px] leading-snug text-[#a8a8a8]">
          Text on an arc: positive radius curves up (∩), negative down (∪); under ±40 px
          the text is straight. Single-line only in preview.
        </p>
        <Slider label="X (0–1)" value={clip.x ?? 0.5} min={0} max={1}
          onLive={(v) => setX((c) => { c.x = v; }, false)} />
        <Slider label="Y (0–1)" value={clip.y ?? 0.8} min={0} max={1}
          onLive={(v) => setX((c) => { c.y = v; }, false)} />
      </Section>
      <Section title="Animation">
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Animate in</span>
          <select className="field" value={clip.animIn ?? 'none'}
            onChange={(e) => setX((c) => { c.animIn = e.target.value as TextClip['animIn']; })}>
            {['none', 'pop', 'fade', 'slide', 'typewriter', 'word-reveal'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <Num label="In duration (s)" value={clip.animInDur ?? (clip.animIn === 'word-reveal' ? clip.dur : 0.28)} step={0.05} min={0.05} max={10}
          onCommit={(v) => setX((c) => { c.animInDur = v; })} />
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Animate out</span>
          <select className="field" value={clip.animOut ?? 'none'}
            onChange={(e) => setX((c) => { c.animOut = e.target.value as TextClip['animOut']; })}>
            {['none', 'pop', 'fade', 'slide'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <Num label="Out duration (s)" value={clip.animOutDur ?? 0.25} step={0.05} min={0.05} max={10}
          onCommit={(v) => setX((c) => { c.animOutDur = v; })} />
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Loop / combo</span>
          <select className="field" value={clip.animLoop ?? 'none'}
            onChange={(e) => setX((c) => { c.animLoop = e.target.value as TextClip['animLoop']; })}>
            {['none', 'wave', 'pulse', 'sway'].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
      </Section>
    </>
  );
}

function ProjectSection() {
  const project = useStore((s) => s.project);
  // FIX D: Home's Resize tile asks for this disclosure to land open
  // (the canvas fields live inside it) — one-shot, mount or live.
  const [settingsOpen, setSettingsOpen] = useState<boolean>(() => consumeProjectSettingsOpenRequest());
  useEffect(() => subscribeProjectSettingsOpen(() => {
    consumeProjectSettingsOpenRequest();
    setSettingsOpen(true);
  }), []);
  const [, setTick] = useState(0);
  useEffect(() => playback.onFrame(() => setTick((n) => (n + 1) % 100000)), []);
  void setTick;
  return (
    <>
      {/* R17 (§3.11): a compact project summary card; everything
          else lives in the Project settings disclosure below.
          FIX C: the default rail no longer leaks machinery copy —
          an empty project gets a Start here block with the two real
          first actions; a project with clips gets one plain line of
          selection guidance. */}
      <div className="border-b border-[#333] px-3 py-2.5">
        <div className="pb-0.5 text-[13px] font-medium">{project.name}</div>
        <div className="font-mono text-[11px] text-[#a8a8a8]">
          {project.canvas.w}×{project.canvas.h} · {project.canvas.fps}fps · length {projectDuration(project).toFixed(2)}s · {project.media.length} media
        </div>
        {project.tracks.every((t) => t.clips.length === 0) ? (
          <div className="pt-2.5">
            <div className="panel-title">Start here</div>
            <p className="pt-1 text-[11px] leading-relaxed text-[#a8a8a8]">
              This project is empty. Import media and it lands in the bin,
              ready to add to the timeline.
            </p>
            <div className="flex flex-wrap gap-1.5 pt-2">
              <button className="btn small" onClick={() => window.dispatchEvent(new Event('cutlab:import-media'))}>
                Import media
              </button>
              <button className="btn small" onClick={() => setPage('media')}>
                Open the Media page
              </button>
            </div>
          </div>
        ) : (
          <p className="pt-1.5 text-[11px] leading-relaxed text-[#a8a8a8]">
            Select a clip on the timeline to edit it — its timing, transform,
            colour and effects appear here.
          </p>
        )}
      </div>
      <div className="border-b border-[#333]">
        <button className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left" aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}>
          <span className="text-[11px] text-[#a8a8a8]">{settingsOpen ? '‹' : '›'}</span>
          <span className="panel-title">Project settings</span>
        </button>
      </div>
      {settingsOpen && (
      <>
      <Section title="Project">
        <div className="flex items-center gap-2 py-0.5">
          <span className="w-[86px] shrink-0 text-[12px] text-[#c9c9c9]">Background</span>
          <input type="color" value={project.canvas.bg ?? '#000000'} className="h-6 w-10 cursor-pointer rounded border border-[#333] bg-transparent"
            onChange={(e) => store.commit((d) => { d.canvas.bg = e.target.value; })} />
          <span className="font-mono text-[11px] text-[#a8a8a8]">{project.canvas.bg ?? '#000000'}</span>
          {project.canvas.bg && (
            <button className="btn small" onClick={() => store.commit((d) => { d.canvas.bg = undefined; })}>Black</button>
          )}
        </div>
        <Num label="Canvas width" value={project.canvas.w} step={10} min={16}
          onCommit={(v) => store.commit((d) => { d.canvas.w = Math.round(v); })} />
        <Num label="Canvas height" value={project.canvas.h} step={10} min={16}
          onCommit={(v) => store.commit((d) => { d.canvas.h = Math.round(v); })} />
        <label className="flex items-center justify-between gap-2 py-0.5">
          <span className="text-[12px] text-[#a8a8a8]">Frame rate</span>
          <select className="field" value={project.canvas.fps}
            onChange={(e) => store.commit((d) => { d.canvas.fps = Number(e.target.value); })}>
            {[24, 25, 30, 50, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </label>
      </Section>
      <Section title="Audio bus">
        <Num label="Master gain" value={project.audioBus?.masterGain ?? 1} step={0.05} min={0} max={2}
          onCommit={(v) => store.commit((d) => {
            d.audioBus = { ...(d.audioBus ?? { normalise: true, compEnabled: false, compThreshold: -18, compRatio: 3, compMakeup: 4, masterGain: 1 }), masterGain: v };
          })} />
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={project.audioBus?.normalise ?? true} label="Normalise mix to −14 LUFS at render"
            onChange={(v) => store.commit((d) => {
              d.audioBus = { ...(d.audioBus ?? { masterGain: 1, compEnabled: false, compThreshold: -18, compRatio: 3, compMakeup: 4, normalise: true }), normalise: v };
            })} />
        </span>
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={project.audioBus?.compEnabled ?? false} label="Dialogue compressor (render)"
            onChange={(v) => store.commit((d) => {
              d.audioBus = { ...(d.audioBus ?? { masterGain: 1, normalise: true, compThreshold: -18, compRatio: 3, compMakeup: 4, compEnabled: false }), compEnabled: v };
            })} />
        </span>
        {(project.audioBus?.compEnabled) && (
          <>
            <Num label="Threshold (dB)" value={project.audioBus.compThreshold} step={1} min={-48} max={0}
              onCommit={(v) => store.commit((d) => { if (d.audioBus) d.audioBus.compThreshold = v; })} />
            <Num label="Ratio" value={project.audioBus.compRatio} step={0.5} min={1} max={10}
              onCommit={(v) => store.commit((d) => { if (d.audioBus) d.audioBus.compRatio = v; })} />
            <Num label="Makeup (dB)" value={project.audioBus.compMakeup} step={0.5} min={0} max={24}
              onCommit={(v) => store.commit((d) => { if (d.audioBus) d.audioBus.compMakeup = v; })} />
          </>
        )}
        <span className="flex items-center gap-2 py-0.5 text-[12px] text-[#a8a8a8]">
          <Switch checked={project.audioBus?.ducking?.enabled ?? false} label="Duck music under dialogue (render)"
            onChange={(v) => store.commit((d) => {
              const base = d.audioBus ?? { masterGain: 1, normalise: true, compEnabled: false, compThreshold: -18, compRatio: 3, compMakeup: 4 };
              d.audioBus = { ...base, ducking: { ...(base.ducking ?? { amount: 10, attack: 20, release: 300 }), enabled: v } };
            })} />
        </span>
        {project.audioBus?.ducking?.enabled && (
          <>
            <Slider label="Duck amount (dB)" value={project.audioBus.ducking.amount} min={0} max={24} step={0.5}
              onLive={(v) => store.commit((d) => { if (d.audioBus?.ducking) d.audioBus.ducking.amount = v; }, { history: false })} />
            <Num label="Attack (ms)" value={project.audioBus.ducking.attack} step={5} min={0} max={500}
              onCommit={(v) => store.commit((d) => { if (d.audioBus?.ducking) d.audioBus.ducking.attack = v; })} />
            <Num label="Release (ms)" value={project.audioBus.ducking.release} step={25} min={20} max={2000}
              onCommit={(v) => store.commit((d) => { if (d.audioBus?.ducking) d.audioBus.ducking.release = v; })} />
            <p className="text-[11px] leading-snug text-[#a8a8a8]">
              Tracks assigned to the dialogue bus (track header) key the dip; music and
              effects buses dip. Unassigned tracks are never ducked.
            </p>
          </>
        )}
        <p className="pt-1 text-[11px] leading-snug text-[#a8a8a8]"
          title="Three-level model: fix per line (clip) → per role (track header volume) → per family (this bus). The studied dialogue recipe: low threshold, gentle ratio, just-visible reduction, makeup to taste.">
          Three-level model: clip → track → this bus. Hover for the dialogue recipe.
        </p>
      </Section>
      <Section title={`Markers (${project.markers.length})`}>
        {project.markers.length === 0 && <p className="text-[11px] text-[#a8a8a8]">No markers. Press M or use Beats in the timeline toolbar.</p>}
        <div className="flex max-h-[180px] flex-col gap-0.5 overflow-y-auto">
          {project.markers.map((m, i) => (
            <div key={i} className="flex items-center justify-between gap-2">
              <button className="btn small flex-1 text-left" onClick={() => playback.seek(m.t)}>
                <span style={{ color: m.label === 'beat' ? '#a8a8a8' : '#E31000' }}>◆</span>{' '}
                <span className="font-mono">{m.t.toFixed(2)}s</span> {m.label}
              </button>
              <button className="btn icon" style={{ padding: '0 4px' }} title="Delete marker"
                onClick={() => store.commit((d) => { d.markers.splice(i, 1); })}>×</button>
            </div>
          ))}
        </div>
      </Section>
      {project.tracks.filter((t) => t.kind === 'text').length > 0 && (
        <Section title="Captions">
          {project.tracks.filter((t) => t.kind === 'text').map((t, ti) => (
            <div key={t.id} className="flex items-center justify-between gap-2 py-0.5">
              <span className="text-[12px] text-[#a8a8a8]">
                Text track {ti + 1}{t.name ? ' · ' + t.name : ''} ({t.clips.length} clips)
              </span>
              <button className="btn small" onClick={() => downloadText(toSrt(project, t.id), (project.name.replace(/[^a-zA-Z0-9 ]+/g, '').trim() || 'captions') + '.srt')}>
                Download .srt
              </button>
            </div>
          ))}
          <p className="pt-1 text-[11px] leading-snug text-[#a8a8a8]">
            Sidecar subtitles for platforms that accept them; the same clips stay editable on the timeline.
          </p>
        </Section>
      )}
      <Section title="Project look (over every clip, last in the chain)">
        <ColorPanel
          grade={project.look ?? DEFAULT_GRADE}
          onPatch={(fn, history = true) => store.commit((d) => {
            if (!d.look) d.look = JSON.parse(JSON.stringify(DEFAULT_GRADE)) as Grade;
            fn(d.look);
          }, { history })} />
      </Section>
      </>
      )}
      <ShortcutsDisclosure />
    </>
  );
}

/** FIX C: the shortcuts table is no longer the default rail content —
 *  it lives behind this collapsed disclosure. The remap machinery
 *  (ShortcutsSection) is untouched and only mounts when opened.
 *  Help → Keyboard shortcuts opens it via services/inspectorNav. */
function ShortcutsDisclosure() {
  const [open, setOpen] = useState<boolean>(() => consumeShortcutsOpenRequest());
  useEffect(() => subscribeShortcutsOpen(() => {
    consumeShortcutsOpenRequest();
    setOpen(true);
  }), []);
  return (
    <div className="border-b border-[#333]">
      <button className="flex w-full items-center gap-1.5 px-3 py-2.5 text-left" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <span className="text-[11px] text-[#a8a8a8]">{open ? '‹' : '›'}</span>
        <span className="panel-title">Keyboard shortcuts</span>
      </button>
      {open && <ShortcutsSection />}
    </div>
  );
}

/** §P speed extras: ramp strip + presets, reverse, freeze, pitch, smooth
 *  slow-mo. Keys are source-time → speed (P.2); duration maths integrates
 *  the curve in types.clipDuration. */
function SpeedExtras({ clip, trackId }: { clip: VideoClip; trackId: string }) {
  const span = Math.max(0.01, clip.out - clip.in);
  const keys = clip.speedKeys ?? [];
  const W = 232, H = 56;
  const yOf = (v: number) => H - ((Math.log(Math.max(0.1, Math.min(4, v))) - Math.log(0.1)) / (Math.log(4) - Math.log(0.1))) * H;
  const vOf = (y: number) => Math.exp(Math.log(0.1) + (1 - y / H) * (Math.log(4) - Math.log(0.1)));
  const setKeys = (next: { t: number; speed: number }[] | undefined, history: boolean) =>
    patchClip(trackId, clip.id, (c) => { (c as VideoClip).speedKeys = next; }, history);
  const preset = (shape: [number, number][]) =>
    setKeys(shape.map(([f, v]) => ({ t: Math.round(f * span * 100) / 100, speed: v })), true);
  const frozen = clip.freezeAt != null;
  return (
    <div className="mt-1 border-t border-[#2c2c2c] pt-1.5">
      <div className="flex items-center gap-1 pb-1">
        <span className="field-label">Speed ramp</span>
        <div className="flex-1" />
        <button className="btn small" title="Fast in, slow through the peak, snap back"
          onClick={() => preset([[0, 1], [0.4, 1], [0.52, 0.25], [0.78, 0.25], [0.88, 1]])}>Peak slow-mo</button>
        <button className="btn small" onClick={() => preset([[0, 1], [1, 0.25]])}>Ramp ↓</button>
        <button className="btn small" onClick={() => preset([[0, 0.25], [1, 1]])}>Ramp ↑</button>
        {keys.length > 0 && <button className="btn small" onClick={() => setKeys(undefined, true)}>Clear</button>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-[#3a3a3a] bg-[#171717]"
        onPointerDown={(e) => {
          if (!e.altKey) return;
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const t = ((e.clientX - r.left) / r.width) * span;
          const v = vOf(((e.clientY - r.top) / r.height) * H);
          setKeys([...keys, { t: Math.round(t * 100) / 100, speed: Math.round(v * 100) / 100 }].sort((a, b) => a.t - b.t), true);
        }}>
        <line x1={0} y1={yOf(1)} x2={W} y2={yOf(1)} stroke="#2c2c2c" strokeDasharray="3 3" />
        {keys.length > 0 && (
          <polyline fill="none" stroke="#C0C0C0" strokeWidth="1.5"
            points={Array.from({ length: 33 }, (_, i) => {
              const t = (i / 32) * span;
              return `${(t / span) * W},${yOf(speedAtSource(keys, t))}`;
            }).join(' ')} />
        )}
        {keys.map((k, i) => (
          <circle key={i} cx={(k.t / span) * W} cy={yOf(k.speed)} r={4.5} fill="#E31000" style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.ctrlKey && e.altKey) {
                setKeys(keys.filter((_, j) => j !== i), true);
                return;
              }
              const r = (e.currentTarget.ownerSVGElement as unknown as SVGSVGElement).getBoundingClientRect();
              const move = (ev: PointerEvent) => {
                const t = Math.min(span, Math.max(0, ((ev.clientX - r.left) / r.width) * span));
                const v = vOf(((ev.clientY - r.top) / r.height) * H);
                setKeys(keys.map((q, j) => (j === i ? { t: Math.round(t * 100) / 100, speed: Math.round(v * 100) / 100 } : q)), false);
              };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }} />
        ))}
        {keys.length === 0 && (
          <text x={W / 2} y={H / 2 + 3} textAnchor="middle" fontSize="11" fill="#6f6f6f">
            constant {clip.speed}× — Alt+click adds a point, or use a preset
          </text>
        )}
      </svg>
      <p className="text-[11px] leading-snug text-[#a8a8a8]">
        Drag points · Ctrl+Alt+click deletes. By hand alternative (the taught PC route): split the clip and set a constant speed per piece.
      </p>
      <div className="flex flex-col gap-0.5 pt-0.5">
        <span className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
          <Switch checked={!!clip.reversed} label="Reverse (renders reversed; preview plays forward)"
            onChange={(v) => patchClip(trackId, clip.id, (c) => { (c as VideoClip).reversed = v; })} />
        </span>
        <span className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
          <Switch checked={!!clip.pitchPreserve} label="Preserve pitch at this speed"
            onChange={(v) => patchClip(trackId, clip.id, (c) => { (c as VideoClip).pitchPreserve = v; })} />
        </span>
        <span className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
          <Switch checked={!!clip.smoothSlowmo} label="Smooth slow-motion (optical flow at render)"
            onChange={(v) => patchClip(trackId, clip.id, (c) => { (c as VideoClip).smoothSlowmo = v; })} />
        </span>
        <div className="flex items-center gap-1.5 pt-0.5">
          <button className="btn small" title="Hold the frame under the playhead for this clip's whole length"
            onClick={() => patchClip(trackId, clip.id, (c) => {
              const vc = c as VideoClip;
              const local = Math.min(Math.max(playback.time - vc.start, 0), clipDuration(vc));
              vc.freezeAt = Math.round((vc.in + buildSpeedMap(vc).sourceAt(local)) * 1000) / 1000;
            })}>Freeze at playhead</button>
          {frozen && (
            <>
              <span className="font-mono text-[11px] text-[#a8a8a8]">frozen @{clip.freezeAt!.toFixed(2)}s</span>
              <button className="btn small" onClick={() => patchClip(trackId, clip.id, (c) => { (c as VideoClip).freezeAt = undefined; })}>Unfreeze</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


/** Compound clip controls (F.16): identity, nest session entry, master gain. */
function CompoundSection({ clip, trackId }: { clip: CompoundClip; trackId: string }) {
  const nestedCount = clip.nest.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <Section title="Compound">
      <label className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12px] text-[#a8a8a8]">Name</span>
        <input className="field" style={{ width: 150 }} value={clip.nest.name}
          onFocus={() => snapshot()}
          onChange={(e) => patchClip(trackId, clip.id, (c) => { (c as CompoundClip).nest.name = e.target.value; }, false)} />
      </label>
      <div className="pb-1.5 font-mono text-[11px] text-[#a8a8a8]">
        {clip.nest.tracks.length} nest track(s) · {nestedCount} clip(s) inside
      </div>
      <div className="flex gap-1.5">
        <button className="btn small" onClick={() => openNest(trackId, clip.id)}>Open nest</button>
        <button className="btn small" onClick={() => uncompoundSelected()}>Uncompound</button>
      </div>
      <Slider label="Nest volume" value={clip.volume ?? 1} min={0} max={1}
        onLive={(v) => patchClip(trackId, clip.id, (c) => { (c as CompoundClip).volume = v; }, false)} />
      <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
        Double-clicking the clip on the timeline also opens the nest. Inside, editing is
        isolated — autosave and cloud pause, and the whole session lands back here as
        one undo step.
      </p>
    </Section>
  );
}

/** Multicam angle switcher (F.17) + sync (D1.4). `media` mirrors the
 *  active angle; the clip's in/out express the active angle's window,
 *  shifted by the measured sync offsets on every switch. */
function MulticamSection({ clip, trackId }: { clip: VideoClip; trackId: string }) {
  const project = useStore((s) => s.project);
  const [syncing, setSyncing] = useState(false);
  const synced = (clip.angles ?? []).some((a) => a.syncOffset !== undefined);
  return (
    <Section title="Multicam">
      {(clip.angles ?? []).map((a, i) => (
        <label key={i} className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-[#e8e8e8]">
          <input type="radio" name={`mc-${clip.id}`} checked={(clip.activeAngle ?? 0) === i}
            onChange={() => setActiveAngle(trackId, clip.id, i)} />
          <span className="font-mono text-[11px] text-[#a8a8a8]">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate">{a.label}</span>
          {a.syncOffset !== undefined && (
            <span className="font-mono text-[11px] text-[#a8a8a8]" title="Measured offset vs angle 1">
              {a.syncOffset >= 0 ? '+' : ''}{a.syncOffset.toFixed(2)}s
            </span>
          )}
          <span className="font-mono text-[11px] text-[#a8a8a8]">
            {project.media.find((m) => m.id === a.media)?.kind ?? 'missing'}
          </span>
        </label>
      ))}
      <button className="btn small mt-1.5" disabled={syncing}
        onClick={async () => {
          setSyncing(true);
          try {
            await syncMulticamClip(clip, trackId);
          } catch (e) {
            store.toastMsg('error', e instanceof Error ? e.message : String(e));
          } finally {
            setSyncing(false);
          }
        }}>
        {syncing ? 'Syncing on server…' : synced ? 'Re-sync angles (server)' : 'Sync angles (server)'}
      </button>
      <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
        Sync measures each angle's audio against angle 1 and shifts its window by the
        measured offset. Press 1–9 while a multicam clip is under the playhead to cut
        to that angle there. An angle shorter than the window leaves its tail empty —
        never stretched.
      </p>
    </Section>
  );
}

/** Adjustment clip controls (I.12): the same Colour + Effects surfaces as a
 *  video clip, applied to the composite beneath the clip. */
function AdjustmentSections({ clip, trackId }: { clip: AdjustmentClip; trackId: string }) {
  const setA = (fn: (c: AdjustmentClip) => void, history = true) =>
    patchClip(trackId, clip.id, (c) => fn(c as AdjustmentClip), history);
  return (
    <>
      <Section title="Adjustment">
        <p className="text-[11px] leading-snug text-[#a8a8a8]">
          This clip's effects and grade filter everything BENEATH it on the timeline
          for its duration. Move it up or down the stack to change what it covers;
          trim it like a text clip.
        </p>
      </Section>
      <Section title="Colour">
        <ColourEntry
          layers={gradeLayersOf(clip)}
          onLayers={(next, history = true) => setA((c) => {
            c.grades = next;
            delete c.grade;
          }, history)} />
      </Section>
      <EffectsSection effects={clip.effects} patch={(fn, history = true) => setA((c) => fn(c), history)} />
      <AdjWindowSection clip={clip} trackId={trackId} />
    </>
  );
}

/**
 * AdjWindowSection (D2.1): an adjustment clip's grade window. The mask
 * limits the adjustment to a region; "Track this window" runs the
 * track lane on the clip beneath and lands the path as mask keyframes
 * (applied from the render queue), so the window follows the subject.
 * The preview outlines the window (select this clip); the masked
 * grade itself is exact in the render.
 */
function AdjWindowSection({ clip, trackId }: { clip: AdjustmentClip; trackId: string }) {
  const setA = (fn: (c: AdjustmentClip) => void, history = true) =>
    patchClip(trackId, clip.id, (c) => fn(c as AdjustmentClip), history);
  const armed = useSyncExternalStore(trackSeed.subscribe, trackSeed.get);
  const mask = clip.mask;
  const armTrackWindow = () => {
    const project = store.get().project;
    const adjTrackIdx = project.tracks.findIndex((t) => t.id === trackId);
    let beneath: VideoClip | undefined;
    let bestIdx = Infinity;
    project.tracks.forEach((t, ti) => {
      if (t.id === trackId || t.kind !== 'video') return;
      for (const c of t.clips) {
        const vc = c as VideoClip;
        if (!vc.media || (c as unknown as AdjustmentClip).adj) continue;
        if (clip.start >= vc.start && clip.start < vc.start + clipDuration(vc)) {
          const rank = ti > adjTrackIdx ? ti : 1000 + ti; // prefer the track just beneath
          if (rank < bestIdx) { bestIdx = rank; beneath = vc; }
        }
      }
    });
    if (!beneath) {
      store.toastMsg('error', 'No video clip sits beneath this adjustment at its start — tracking needs one.');
      return;
    }
    const seedClipT = clamp(clip.start - beneath.start, 0, Math.max(0, clipDuration(beneath) - 0.05));
    const target = beneath;
    playback.seek(clip.start);
    trackSeed.arm({
      clipId: target.id,
      seedClipT,
      onSeed: (box) => {
        void queueMaskTrackJob(clip, target, box, seedClipT).catch((e) => {
          store.toastMsg('error', e instanceof Error ? e.message : String(e));
        });
      },
    });
  };
  return (
    <Section title="Window (tracked grade)">
      {!mask ? (
        <div className="flex flex-col gap-1.5">
          <button className="btn" onClick={() => setA((c) => {
            c.mask = { shape: 'rect', x: 0.3, y: 0.25, w: 0.4, h: 0.5, feather: 0.02, invert: false };
          })}>Add window</button>
          <p className="text-[11px] leading-snug text-[#a8a8a8]">
            Limit this adjustment to a region of the frame — then track the window so
            the grade follows the subject.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center justify-between gap-2 py-0.5">
            <span className="text-[12px] text-[#a8a8a8]">Shape</span>
            <select className="field" value={mask.shape}
              onChange={(e) => setA((c) => { if (c.mask) c.mask.shape = e.target.value as typeof mask.shape; })}>
              <option value="rect">rectangle</option>
              <option value="circle">circle</option>
            </select>
          </label>
          <Slider label="Feather" value={mask.feather} min={0} max={0.1} step={0.002}
            format={(v) => `${Math.round(v * 100)}%`}
            onLive={(v) => setA((c) => { if (c.mask) c.mask.feather = v; }, false)} />
          <button className="btn" aria-pressed={!!armed} onClick={armTrackWindow}>
            {armed ? 'Drag a box around the subject on the stage…' : 'Track this window'}
          </button>
          {(clip.keyframes?.some((k) => k.mask) ?? false) && (
            <p className="text-[11px] leading-snug text-[#E8C268]">
              Tracked — {clip.keyframes!.filter((k) => k.mask).length} mask keyframes. The outline
              follows on the stage while this clip is selected.
            </p>
          )}
          <button className="btn" onClick={() => setA((c) => { c.mask = null; c.keyframes = (c.keyframes ?? []).filter((k) => !k.mask); })}>
            Remove window
          </button>
          <p className="text-[11px] leading-snug text-[#a8a8a8]">
            Tracking runs on the clip beneath this adjustment; apply the finished job
            from the render queue. The preview outlines the window — the masked grade
            is exact in the render.
          </p>
        </div>
      )}
    </Section>
  );
}

/** Editable shortcut reference (T.10): renders the SAME registry the App
 *  keyboard handler dispatches through. Click Change, press the new combo;
 *  conflicts are refused. Overrides persist per user (localStorage). */
function ShortcutsSection() {
  const [, setTick] = useState(0);
  const [capturing, setCapturing] = useState<string | null>(null);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      const combo = comboForEvent(e);
      if (!combo) return; // lone modifier — keep waiting
      const res = setKeymapOverride(capturing, combo);
      if (!res.ok) store.toastMsg('error', res.error);
      setCapturing(null);
      setTick((n) => n + 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);
  return (
    <Section title="Shortcuts">
      <div className="flex flex-col gap-0.5">
        {SHORTCUT_ACTIONS.map((a) => {
          const ov = keymapOverride(a.id);
          return (
            <div key={a.id} className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] text-[#a8a8a8]" title={a.label}>{a.label}</span>
              <span className="font-mono text-[11px] text-[#e8e8e8]">
                {ov ? displayCombo(ov) : a.hint}
                {ov ? ' •' : ''}
              </span>
              {capturing === a.id ? (
                <span className="px-1 text-[11px] text-[#E8C268]">press keys… (Esc cancels)</span>
              ) : (
                <button className="btn small" onClick={() => setCapturing(a.id)}>Change</button>
              )}
              {ov && (
                <button className="btn small" title="Back to the default binding"
                  onClick={() => { clearKeymapOverride(a.id); setTick((n) => n + 1); }}>Reset</button>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button className="btn small" onClick={() => { resetKeymap(); setTick((n) => n + 1); }}>
          Reset all to defaults
        </button>
        <span className="text-[11px] leading-snug text-[#a8a8a8]">Bindings are yours only (this browser).</span>
      </div>
    </Section>
  );
}
