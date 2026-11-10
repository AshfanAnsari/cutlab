import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { store, useStore } from '../state/store';
import { getMediaRuntime } from '../services/mediaStore';
import { getSelectedMediaId, subscribeSelectedMedia } from '../services/mediaSelection';
import { mediaStatus } from './MediaBin';

/**
 * BinViewer (UI redesign §3.16): a click-to-play pane for the
 * selected bin item on the Media page. Play/pause, a scrub bar and
 * a Plex Mono timecode; images show full-frame; audio shows its
 * waveform (server peaks) with the same transport. It reads media
 * records only — no project state is touched, and nothing autoplays.
 */
function fmtT(t: number): string {
  if (!isFinite(t)) return '0:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export default function BinViewer() {
  const media = useStore((s) => s.project.media);
  const selId = useSyncExternalStore(subscribeSelectedMedia, getSelectedMediaId);
  const item = media.find((m) => m.id === selId) ?? media[0];
  const rt = item ? getMediaRuntime(item.id) : undefined;
  const elRef = useRef<HTMLMediaElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [metaDur, setMetaDur] = useState(0);
  const dur = item?.duration ?? metaDur;

  // Selection change swaps the item instantly; transport resets.
  useEffect(() => {
    setPlaying(false);
    setCur(0);
    setMetaDur(0);
  }, [item?.id]);

  // Waveform from the runtime peaks (audio items).
  useEffect(() => {
    const c = waveRef.current;
    if (!c || !rt?.peaks?.length) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#7d7d7d';
    const peaks = rt.peaks;
    const step = Math.max(1, Math.floor(peaks.length / W));
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let j = 0; j < step; j++) v = Math.max(v, peaks[Math.min(peaks.length - 1, x * step + j)] ?? 0);
      const h = Math.max(1, v * (H - 4));
      ctx.fillRect(x, (H - h) / 2, 1, h);
    }
  }, [item?.id, rt?.peaks]);

  if (!item) {
    return (
      // FIX B2 #13a: the empty Media page gets its one action where
      // the eye already is — a centred Import CTA in the viewer area
      // (the rail's import buttons stay).
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-[12px] text-[#a8a8a8]">Nothing in the bin yet — import files to preview them here.</p>
        <button className="btn primary justify-center px-4 py-2"
          onClick={() => window.dispatchEvent(new Event('cutlab:import-media'))}>
          Import media
        </button>
      </div>
    );
  }
  const st = mediaStatus(item);
  const isVideoLike = item.kind === 'video' || item.kind === 'matte' || item.kind === 'depth';
  const src = rt?.proxyUrl ?? rt?.url;
  const transport = (
    <div className="flex items-center gap-2 px-3 py-2">
      <button className="btn small" style={{ minWidth: 58 }} aria-label={playing ? 'Pause preview' : 'Play preview'}
        onClick={() => {
          const el = elRef.current;
          if (!el) return;
          if (el.paused) void el.play();
          else el.pause();
        }}>
        {playing ? 'Pause' : 'Play'}
      </button>
      <input type="range" min={0} max={Math.max(0.01, dur)} step={0.01} value={Math.min(cur, dur || 0)}
        className="min-w-0 flex-1" aria-label="Scrub preview"
        onChange={(e) => {
          const el = elRef.current;
          const v = Number(e.target.value);
          setCur(v);
          if (el) {
            try { el.currentTime = v; } catch { /* metadata race */ }
          }
        }} />
      <span className="shrink-0 font-mono text-[11px] text-[#a8a8a8]">{fmtT(cur)} / {fmtT(dur)}</span>
    </div>
  );
  // FIX B2 #9: a probe here is the first time many bundle-loaded
  // items ever meet a real element — write the measured duration /
  // dimensions back into the media record (no history step: this is
  // metadata, not an edit) so Details, cards, list and Sort by
  // Duration stop showing "—" and no-op'ing.
  const writeBackMeta = (el: HTMLMediaElement) => {
    if (!item) return;
    const d = isFinite(el.duration) ? el.duration : undefined;
    const v = el as HTMLVideoElement;
    const w = v.videoWidth || undefined;
    const h = v.videoHeight || undefined;
    if (d === undefined && !w) return;
    const cur = store.get().project.media.find((x) => x.id === item.id);
    if (!cur) return;
    const needDur = d !== undefined && (cur.duration == null || Math.abs(cur.duration - d) > 0.05);
    const needDims = !!w && !cur.width;
    if (!needDur && !needDims) return;
    store.commit((draft) => {
      const it = draft.media.find((x) => x.id === item.id);
      if (!it) return;
      if (needDur) it.duration = d;
      if (needDims) { it.width = w; it.height = h; }
    }, { history: false });
  };
  const mediaEvents = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTimeUpdate: (e: React.SyntheticEvent<HTMLMediaElement>) => setCur(e.currentTarget.currentTime),
    onLoadedMetadata: (e: React.SyntheticEvent<HTMLMediaElement>) => {
      setCur(e.currentTarget.currentTime);
      if (isFinite(e.currentTarget.duration)) setMetaDur(e.currentTarget.duration);
      writeBackMeta(e.currentTarget);
    },
  };
  return (
    <div className="flex h-full flex-col bg-[#161616]">
      <div className="relative min-h-0 flex-1">
        {!rt ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[12px]" style={{ color: '#E8C268' }}>
            {st.text} — the preview needs the file in this browser.
          </div>
        ) : item.kind === 'image' ? (
          <img src={rt.url} alt={item.src} className="h-full w-full object-contain"
            onLoad={(e) => {
              // FIX B2 #9 (image arm): dimensions write-back.
              const img = e.currentTarget;
              if (!img.naturalWidth) return;
              const cur = store.get().project.media.find((x) => x.id === item.id);
              if (cur && !cur.width) {
                store.commit((draft) => {
                  const it = draft.media.find((x) => x.id === item.id);
                  if (it) { it.width = img.naturalWidth; it.height = img.naturalHeight; }
                }, { history: false });
              }
            }} />
        ) : isVideoLike && src ? (
          <video ref={(el) => { elRef.current = el; }} src={src} playsInline preload="metadata"
            className="h-full w-full object-contain" {...mediaEvents} />
        ) : item.kind === 'audio' && src ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
            <audio ref={(el) => { elRef.current = el; }} src={src} preload="metadata" {...mediaEvents} />
            {rt.peaks?.length ? (
              <canvas ref={waveRef} width={640} height={72} className="w-full max-w-[640px]" aria-label="Waveform" />
            ) : (
              // FIX B2 #13b: no peaks yet — a designed placeholder
              // (name + duration), not a bare "audio" tag.
              <div className="flex flex-col items-center gap-1 px-4 text-center">
                <span className="max-w-full truncate text-[13px] font-medium text-[#ececec]" title={item.src}>{item.src}</span>
                <span className="font-mono text-[11px] text-[#a8a8a8]">audio · {fmtT(dur)}</span>
                <span className="text-[11px] leading-snug text-[#6f6f6f]">The waveform appears after a media job makes peaks for this file.</span>
              </div>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-[12px] text-[#a8a8a8]">{item.src}</div>
        )}
      </div>
      {(isVideoLike || item.kind === 'audio') && rt && (
        <div className="border-t border-[#2c2c2c]">{transport}</div>
      )}
    </div>
  );
}
