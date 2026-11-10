import { useState } from 'react';
import { store, useStore } from '../state/store';
import { findClip } from '../state/actions';
import type { AudioClip, Track } from '../types';
import Preview, { LevelMeter } from './Preview';
import ZoneTabs from './ZoneTabs';
import { useNarrow } from '../services/useNarrow';
import Timeline from './Timeline';
import { EqBandsSection, Num } from './Inspector';
import Switch from './Switch';

/**
 * Audio page (§2.5): the timeline in audio-focus mode (video/text
 * lanes as thin reference rows) with the viewer at rail width; a
 * selected-clip editor band (the Inspector's EQ, mounted wide);
 * and the mixer row — one strip per audio track + the bus strip.
 * The strip fader writes the same Track.volume the header slider
 * writes; the bus strip writes Project.audioBus. One field, two
 * views — no new model.
 */
export default function AudioPage() {
  const project = useStore((s) => s.project);
  const selected = useStore((s) => s.selected);
  const [zoneOpen, setZoneOpen] = useState(true);
  const phone = useNarrow();
  const [zone, setZone] = useState('timeline');
  const found = selected ? findClip(project, selected.trackId, selected.clipId) : { track: undefined, clip: undefined };
  const selClip = found.clip && 'media' in found.clip ? (found.clip as AudioClip) : undefined;
  const selTrack = found.track;
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio');

  const setEq = (fn: (c: AudioClip) => void, history = true) => {
    if (!selClip || !selTrack) return;
    store.commit((d) => {
      const t = d.tracks.find((x) => x.id === selTrack.id);
      const c = t?.clips.find((x) => x.id === selClip.id) as AudioClip | undefined;
      if (c) fn(c);
    }, { history });
  };

  const editorBand = selClip && selTrack ? (
        <div className="shrink-0 border-t border-[#3a3a3a] bg-[#1b1b1b]">
          <button className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left" aria-expanded={zoneOpen}
            onClick={() => setZoneOpen((v) => !v)}>
            <span className="text-[11px] text-[#a8a8a8]">{zoneOpen ? '‹' : '›'}</span>
            <span className="panel-title">Selected clip — EQ</span>
            <span className="truncate text-[11px] text-[#a8a8a8]">
              {project.media.find((m) => m.id === selClip.media)?.src ?? selClip.id}
            </span>
          </button>
          {zoneOpen && (
            <div className="max-h-[240px] overflow-y-auto px-3 pb-2">
              <div className="[&>div]:border-b-0 [&>div]:px-0 [&>div]:py-1">
                <EqBandsSection clip={selClip} setEq={setEq} />
              </div>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <span className="flex items-center gap-1.5 text-[11px] text-[#a8a8a8]">
                  <Switch size="sm" checked={!!selClip.denoise} label="Denoise this clip (K.12 — applied at render)"
                    onChange={(v) => setEq((c) => { c.denoise = v; })} />
                </span>
                <p className="text-[11px] leading-snug text-[#a8a8a8]">
                  Volume line: keyframe the clip's volume in the Inspector's Clip audio section — the same fields, wide here so nothing clips.
                </p>
              </div>
            </div>
          )}
        </div>
  ) : null;
  const mixerRow = (
      <div className="flex shrink-0 items-stretch gap-2 overflow-x-auto border-t border-[#3a3a3a] bg-[#161616] px-3 py-2.5">
        {audioTracks.length === 0 && (
          <p className="text-[12px] text-[#a8a8a8]">No audio tracks yet — add one from the timeline's Add group.</p>
        )}
        {audioTracks.map((t) => (
          <MixerStrip key={t.id} track={t} />
        ))}
        <BusStrip />
      </div>
  );

  if (phone) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* FIX B2 #17: the phone header uses the compact rail variant
            (the full viewer overflowed the toolbar by ~364 px and
            pushed the transport under the PageBar). 320 px gives the
            compact strip + the 120 px stage floor + the transport
            deck room to all stay reachable above the zones. */}
        <div className="flex h-[320px] shrink-0 flex-col overflow-hidden border-b border-[#3a3a3a]">
          <Preview compact />
        </div>
        <ZoneTabs label="Audio zones" active={zone} onChange={setZone} zones={[
          { id: 'timeline', label: 'Timeline' }, { id: 'eq', label: 'EQ' }, { id: 'mixer', label: 'Mixer' },
        ]} />
        {zone === 'timeline' && (
          <div className="flex min-h-0 flex-1 flex-col"><Timeline audioFocus /></div>
        )}
        {zone === 'eq' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {selClip ? editorBand : (
              <p className="px-3 py-3 text-[12px] text-[#a8a8a8]">Select a clip on the timeline to edit its EQ here.</p>
            )}
          </div>
        )}
        {zone === 'mixer' && <div className="min-h-0 flex-1 overflow-y-auto">{mixerRow}</div>}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Timeline audioFocus />
        </div>
        <div className="flex w-[264px] shrink-0 flex-col overflow-hidden border-l border-[#3a3a3a]">
          <Preview compact />
        </div>
      </div>
      {editorBand}
      {mixerRow}
    </div>
  );
}


const dbOf = (v: number) => (v <= 0.001 ? '−∞' : (20 * Math.log10(v)).toFixed(1));

function MixerStrip({ track }: { track: Track }) {
  const selected = useStore((s) => s.selected);
  const project = useStore((s) => s.project);
  const isSel = selected?.trackId === track.id;
  const vol = track.volume ?? 1;
  const letter = 'A';
  const ordinal = project.tracks.filter((t) => t.kind === 'audio').findIndex((t) => t.id === track.id) + 1;
  const firstClip = track.clips[0] as AudioClip | undefined;
  const flagStyle = (on?: boolean) => (on ? { borderColor: '#707070', color: '#fff', background: '#404040' } : undefined);
  const toggle = (flag: 'muted' | 'solo') =>
    store.commit((d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      if (t) t[flag] = !t[flag];
    });
  return (
    <div className={'flex w-[132px] shrink-0 flex-col gap-1.5 rounded-md border p-2 ' + (isSel ? 'border-[#707070] bg-[#242424]' : 'border-[#3a3a3a] bg-[#212121]')}>
      <button className="flex items-center gap-1.5 text-left" title="Select this track's first clip"
        onClick={() => {
          if (firstClip) store.set({ selected: { trackId: track.id, clipId: firstClip.id } });
        }}>
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-[#555]" style={{ background: track.color ?? 'transparent' }} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {letter}{ordinal}{track.name ? ` · ${track.name}` : ''}
        </span>
      </button>
      <select className="field w-full" style={{ padding: '1px 4px', fontSize: 11 }} value={track.bus ?? ''}
        aria-label={`${letter}${ordinal} bus`} title="Fairlight bus assignment"
        onChange={(e) => store.commit((d) => {
          const t = d.tracks.find((x) => x.id === track.id);
          if (t) t.bus = (e.target.value || undefined) as Track['bus'];
        })}>
        <option value="">bus: mix</option>
        <option value="dialogue">bus: dialogue</option>
        <option value="music">bus: music</option>
        <option value="fx">bus: fx</option>
      </select>
      <div className="flex items-end justify-center gap-2 py-0.5">
        <input type="range" min={0} max={1} step={0.01} value={vol} aria-label={`${letter}${ordinal} volume`}
          style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 26, height: 104 }}
          onPointerDown={() => store.commit(() => undefined, { history: true })}
          onChange={(e) => store.commit((d) => {
            const t = d.tracks.find((x) => x.id === track.id);
            if (t) t.volume = Number(e.target.value);
          }, { history: false })} />
        <span className="font-mono text-[11px] text-[#a8a8a8]">{dbOf(vol)} dB</span>
      </div>
      {firstClip && (
        <label className="flex items-center gap-1.5 text-[11px] text-[#a8a8a8]">
          Clip pan
          <input type="range" min={-1} max={1} step={0.05} value={firstClip.pan ?? 0} className="min-w-0 flex-1"
            aria-label="First clip pan"
            onChange={(e) => store.commit((d) => {
              const t = d.tracks.find((x) => x.id === track.id);
              const c = t?.clips[0] as AudioClip | undefined;
              if (c) c.pan = Number(e.target.value);
            }, { history: false })} />
        </label>
      )}
      <div className="flex gap-1.5">
        <button className="btn small flex-1" aria-pressed={!!track.muted} style={flagStyle(track.muted)}
          onClick={() => toggle('muted')}>M</button>
        <button className="btn small flex-1" aria-pressed={!!track.solo} style={flagStyle(track.solo)}
          onClick={() => toggle('solo')}>S</button>
        <button className="btn small flex-1" disabled={!firstClip} title="Select the track's first clip (its EQ opens above)"
          onClick={() => {
            if (firstClip) store.set({ selected: { trackId: track.id, clipId: firstClip.id } });
          }}>EQ</button>
      </div>
    </div>
  );
}

function BusStrip() {
  const project = useStore((s) => s.project);
  const bus = project.audioBus ?? { masterGain: 1, normalise: true, compEnabled: false, compThreshold: -18, compRatio: 3, compMakeup: 4 };
  const patch = (fn: (b: NonNullable<typeof project.audioBus>) => void, history = true) =>
    store.commit((d) => {
      d.audioBus = { ...(d.audioBus ?? { masterGain: 1, normalise: true, compEnabled: false, compThreshold: -18, compRatio: 3, compMakeup: 4 }) };
      fn(d.audioBus);
    }, { history });
  return (
    <div className="sticky right-0 flex w-[168px] shrink-0 flex-col gap-1.5 rounded-md border border-[#3a3a3a] bg-[#242424] p-2">
      <span className="text-[12px] font-medium">Master bus</span>
      <div className="flex items-end gap-2">
        <input type="range" min={0} max={2} step={0.01} value={bus.masterGain} aria-label="Master gain"
          style={{ writingMode: 'vertical-lr', direction: 'rtl', width: 26, height: 104 }}
          onPointerDown={() => store.commit(() => undefined, { history: true })}
          onChange={(e) => patch((b) => { b.masterGain = Number(e.target.value); }, false)} />
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[11px] text-[#a8a8a8]">×{bus.masterGain.toFixed(2)}</span>
          <LevelMeter width={110} />
        </div>
      </div>
      <span className="flex items-center gap-1.5 text-[11px] text-[#a8a8a8]">
        <Switch size="sm" checked={bus.normalise} label="Normalise −14 LUFS"
          onChange={(v) => patch((b) => { b.normalise = v; })} />
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-[#a8a8a8]">
        <Switch size="sm" checked={bus.compEnabled} label="Dialogue compressor"
          onChange={(v) => patch((b) => { b.compEnabled = v; })} />
      </span>
      {bus.compEnabled && (
        <div className="[&_input]:w-full">
          <Num label="Threshold" value={bus.compThreshold} step={1} min={-48} max={0}
            onCommit={(v) => patch((b) => { b.compThreshold = v; })} />
          <Num label="Ratio" value={bus.compRatio} step={0.5} min={1} max={10}
            onCommit={(v) => patch((b) => { b.compRatio = v; })} />
          <Num label="Makeup" value={bus.compMakeup} step={0.5} min={0} max={24}
            onCommit={(v) => patch((b) => { b.compMakeup = v; })} />
        </div>
      )}
    </div>
  );
}
