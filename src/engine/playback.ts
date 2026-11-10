// Playback engine: one master clock; preview media elements are followers.
// Preview smoothness comes from proxy media + native element decoding —
// the clock only corrects drift, it never pushes frames itself.
import type { AudioClip, Project, VideoClip } from '../types';
import { buildSpeedMap, clipAtTime, volumeAt } from './compose';
import { clipDuration, projectDuration } from '../types';
import { getMediaRuntime, pickRuntimeUrl } from '../services/mediaStore';
import { bandsOf } from '../services/eq';
import { stemAudible } from '../services/isoPreview';
import { clamp } from '../utils/time';

type FrameListener = (t: number) => void;

interface ElNodes {
  pan: StereoPannerNode; low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode;
  /** D2.5: six parametric peaking bands in series after the legacy
   *  shelves — set per clip from eqBands (or flat when none). */
  bands: BiquadFilterNode[];
}

class PlaybackEngine {
  time = 0;
  playing = false;
  // WebAudio graph (K.9/K.10/K.15/K.16): each element routes once through
  // EQ → pan → master gain → analysers → destination. Created lazily on
  // play (a user gesture); any failure leaves the element unrouted and the
  // plain element path keeps working.
  private actx: AudioContext | null = null;
  private elNodes = new Map<HTMLMediaElement, ElNodes>();
  private elFailed = new Set<HTMLMediaElement>();
  private masterGain: GainNode | null = null;
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;

  private ensureGraph(el: HTMLMediaElement): ElNodes | null {
    if (this.elFailed.has(el)) return null;
    const existing = this.elNodes.get(el);
    if (existing) return existing;
    try {
      if (!this.actx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.actx = new AC();
        this.masterGain = this.actx.createGain();
        const splitter = this.actx.createChannelSplitter(2);
        this.analyserL = this.actx.createAnalyser();
        this.analyserR = this.actx.createAnalyser();
        this.analyserL.fftSize = 256;
        this.analyserR.fftSize = 256;
        this.masterGain.connect(splitter);
        splitter.connect(this.analyserL, 0);
        splitter.connect(this.analyserR, 1);
        this.masterGain.connect(this.actx.destination);
      }
      if (this.actx.state === 'suspended') void this.actx.resume();
      const src = this.actx.createMediaElementSource(el);
      const low = this.actx.createBiquadFilter();
      low.type = 'lowshelf';
      low.frequency.value = 200;
      const mid = this.actx.createBiquadFilter();
      mid.type = 'peaking';
      mid.frequency.value = 1000;
      mid.Q.value = 0.9;
      const high = this.actx.createBiquadFilter();
      high.type = 'highshelf';
      high.frequency.value = 4000;
      const bands: BiquadFilterNode[] = [];
      for (let i = 0; i < 6; i++) {
        const b = this.actx.createBiquadFilter();
        b.type = 'peaking';
        b.frequency.value = [80, 250, 800, 2500, 6000, 12000][i];
        b.Q.value = 0.9;
        b.gain.value = 0;
        bands.push(b);
      }
      const pan = this.actx.createStereoPanner();
      src.connect(low);
      low.connect(mid);
      mid.connect(high);
      high.connect(bands[0]);
      for (let i = 0; i < 5; i++) bands[i].connect(bands[i + 1]);
      bands[5].connect(pan);
      pan.connect(this.masterGain!);
      const nodes = { pan, low, mid, high, bands };
      this.elNodes.set(el, nodes);
      return nodes;
    } catch {
      this.elFailed.add(el);
      return null;
    }
  }

  /** The first registered <video> element (§N scopes draw from it). */
  getPrimaryVideoElement(): HTMLVideoElement | null {
    for (const el of this.elements.values()) {
      if (el.tagName === 'VIDEO') return el as HTMLVideoElement;
    }
    return null;
  }

  /** Stereo RMS levels for the transport meter (K.15); zeros without a graph. */
  getLevels(): { l: number; r: number } {
    const rms = (a: AnalyserNode | null) => {
      if (!a) return 0;
      const buf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      return Math.min(1, Math.sqrt(sum / buf.length) * 2.4);
    };
    return { l: rms(this.analyserL), r: rms(this.analyserR) };
  }
  /** Shuttle multiplier (J/K/L): 1 normal, ±2/±4 shuttle, negative = reverse.
   *  FIX B1 #3: reverse is NOT a negative playbackRate — Chromium rejects
   *  those (the setter throws, which used to kill the rAF loop and freeze
   *  the playhead). While rate < 0 the master clock steps backwards and
   *  sync() seeks each element backwards with it, elements paused. */
  rate = 1;
  /** Loop the whole timeline (or the I/O range when transport sets one). */
  loop = false;
  private raf = 0;
  private lastTs = 0;
  private frameListeners = new Set<FrameListener>();
  private elements = new Map<string, HTMLMediaElement>();
  private projectGetter: (() => Project) | null = null;

  setProjectGetter(fn: () => Project) {
    this.projectGetter = fn;
  }

  registerElement(trackId: string, el: HTMLMediaElement | null) {
    if (el) {
      this.elements.set(trackId, el);
      // FIX B2 #1: a freshly mounted element has no src until sync()
      // runs — and nothing else calls sync on page entry or project
      // load, so pages opened with a "Still loading the frame…" stage
      // and empty scopes. Registration is the one moment every page
      // shares: schedule a forced sync so the paused frame at the
      // playhead (and the scopes that draw from it) appears at once.
      requestAnimationFrame(() => this.sync(true));
    } else this.elements.delete(trackId);
  }

  /** FIX B2 #1: force every registered element onto the playhead's
   *  frame right now (paused). Called on page entry / project load
   *  so a page never opens with a blank stage or undrawn scopes. */
  refresh() {
    this.sync(true);
    this.emit();
  }

  onFrame(fn: FrameListener): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.frameListeners) fn(this.time);
  }

  play() {
    if (this.playing) return;
    for (const el of this.elements.values()) this.ensureGraph(el);
    const p = this.projectGetter?.();
    if (p && this.time >= projectDuration(p) - 1e-9) this.time = 0;
    this.playing = true;
    this.lastTs = performance.now();
    const loop = (ts: number) => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      this.time += dt * this.rate;
      const proj = this.projectGetter?.();
      const dur = proj ? projectDuration(proj) : 0;
      // Loop honours the project I/O range when one is set (D.14).
      const loopStart = this.loop && proj?.rangeIn != null ? proj.rangeIn : 0;
      const loopEnd = this.loop && proj?.rangeOut != null ? Math.min(proj.rangeOut, dur) : dur;
      if (this.time >= loopEnd && this.rate > 0) {
        if (this.loop) {
          this.time = loopStart;
          this.sync(true);
          this.emit();
          this.raf = requestAnimationFrame(loop);
          return;
        }
        this.time = dur;
        this.playing = false;
        this.rate = 1;
        this.sync(true);
        this.emit();
        return;
      }
      if (this.time <= 0 && this.rate < 0) {
        if (this.loop) {
          this.time = loopEnd;
        } else {
          this.time = 0;
          this.playing = false;
          this.rate = 1;
          this.sync(true);
          this.emit();
          return;
        }
      }
      // sync() guards itself, but the loop must survive anything a
      // media element throws at it — a dead loop is a frozen editor.
      try { this.sync(false); } catch { /* clock keeps running */ }
      this.emit();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    this.sync(false);
    this.emit();
  }

  /** J/L shuttle: step the rate in one direction (1 → 2 → 4), starting playback. */
  shuttle(dir: 1 | -1) {
    if (this.playing && Math.sign(this.rate) === dir) {
      this.rate = Math.min(4, Math.abs(this.rate) * 2) * dir;
    } else {
      this.rate = dir;
    }
    if (!this.playing) this.play();
    this.emit();
  }

  pause() {
    this.playing = false;
    this.rate = 1;
    cancelAnimationFrame(this.raf);
    for (const el of this.elements.values()) {
      if (!el.paused) el.pause();
    }
    this.sync(true);
    this.emit();
  }

  seek(t: number) {
    const proj = this.projectGetter?.();
    const dur = proj ? projectDuration(proj) : 0;
    this.time = clamp(t, 0, Math.max(0, dur));
    this.sync(true);
    this.emit();
  }

  step(frames: number, fps: number) {
    this.pause();
    this.seek(this.time + frames / fps);
  }

  /** Set an element's playbackRate without ever throwing: negative
   *  rates are refused by Chromium, so callers pass the magnitude and
   *  handle reverse themselves; any refusal is swallowed — a media
   *  element must never take the playback loop down with it. */
  private safeRate(el: HTMLMediaElement, v: number) {
    try { el.playbackRate = Math.max(0.05, Math.abs(v) || 1); } catch { /* not ready / refused */ }
  }

  /** Align every registered element with the master clock. Guarded:
   *  one element's exception must not kill the rAF loop (FIX B1 #3). */
  private sync(force: boolean) {
    try { this.syncTracks(force); } catch { /* media hiccup — clock keeps running */ }
  }

  private syncTracks(force: boolean) {
    const proj = this.projectGetter?.();
    if (!proj) return;
    const anySolo = proj.tracks.some((tr) => tr.solo && tr.kind === 'audio');
    for (const track of proj.tracks) {
      if (track.kind === 'text') continue;
      const el = this.elements.get(track.id);
      if (!el) continue;
      // Track flags (E.4/E.5): muted tracks are silent; when any audio track
      // is soloed, non-solo audio tracks are silent.
      const trackSilent = !!track.muted || (anySolo && track.kind === 'audio' && !track.solo);
      const clip = clipAtTime(track.clips, this.time) as VideoClip | AudioClip | undefined;
      if (!clip) {
        if (!el.paused) el.pause();
        el.dataset.clipId = '';
        continue;
      }
      // D1.5: an audio clip with voice isolation ON plays its stem
      // (same timing, so every mapping below is unchanged). A video
      // clip's stem plays on its own element in the Preview; here we
      // only mute the picture element once that stem reports audible.
      const ov = clip.audioOverride;
      const stemRt = ov?.enabled ? getMediaRuntime(ov.stemMedia) : undefined;
      const rt = track.kind === 'audio' && stemRt ? stemRt : getMediaRuntime(clip.media);
      if (!rt) continue;
      const local = this.time - clip.start;
      // Server-first preview: play the ready-made server proxy whenever one
      // is attached; the original is only a pre-proxy fallback. Server
      // proxies carry the source audio, so clip sound survives. The
      // D2.6 quality setting can force originals.
      const wantSrc = pickRuntimeUrl(rt);
      const srcKey = clip.id + '|' + wantSrc;
      // P.2/P.5/P.6: ramped or frozen clips map output time through the
      // speed map; constant-speed clips keep the direct maths.
      const mapped = (clip.speedKeys && clip.speedKeys.length > 0) || clip.freezeAt != null;
      const smap = mapped ? buildSpeedMap(clip) : null;
      (el as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = !!clip.pitchPreserve;
      if (clip.freezeAt != null) {
        if (el.dataset.clipId !== srcKey || Math.abs(el.currentTime - clip.freezeAt) > 0.05) {
          el.dataset.clipId = srcKey;
          if (el.src !== wantSrc) el.src = wantSrc;
          try { el.currentTime = clip.freezeAt; } catch { /* not ready */ }
        }
        if (!el.paused) el.pause();
        continue;
      }
      if (el.dataset.clipId !== srcKey) {
        el.dataset.clipId = srcKey;
        if (el.src !== wantSrc) el.src = wantSrc;
        this.safeRate(el, (smap ? smap.speedAt(local) : (clip.speed || 1)) * this.rate);
        const target = clip.in + (smap ? smap.sourceAt(local) : local * (clip.speed || 1));
        try { el.currentTime = target; } catch { /* element not ready yet */ }
        if (this.playing && this.rate > 0) void el.play().catch(() => undefined);
        continue;
      }
      this.safeRate(el, (smap ? smap.speedAt(local) : (clip.speed || 1)) * this.rate);
      const expected = clip.in + (smap ? smap.sourceAt(local) : local * (clip.speed || 1));
      if (this.rate < 0) {
        // FIX B1 #3 reverse shuttle: the master clock is stepping
        // backwards — drag the element's playhead backwards with it
        // (rAF-rate seek) instead of asking for a negative rate.
        if (!el.paused) el.pause();
        try { el.currentTime = expected; } catch { /* ignore */ }
      } else if (force || Math.abs(el.currentTime - expected) > 0.18) {
        try { el.currentTime = expected; } catch { /* ignore */ }
      }
      const trackVol = track.volume ?? 1;
      if (track.kind === 'audio') {
        const ac = clip as AudioClip;
        el.volume = trackSilent ? 0 : clamp(volumeAt(ac, clipDuration(ac), local) * trackVol, 0, 1);
      } else {
        const vc = clip as VideoClip;
        const iso = !!vc.audioOverride?.enabled && stemAudible(vc.id);
        el.volume = vc.muted || trackSilent || iso
          ? 0
          : clamp(volumeAt(vc, clipDuration(vc), local) * trackVol, 0, 1);
        el.muted = vc.muted || trackSilent || iso;
      }
      // Pan + EQ through the graph when routed (K.9/K.10 + D2.5).
      const nodes = this.elNodes.get(el);
      if (nodes) {
        const ac = clip as AudioClip & VideoClip;
        nodes.pan.pan.value = clamp(ac.pan ?? 0, -1, 1);
        if (ac.eqBands && ac.eqBands.length > 0) {
          // Parametric bands supersede the legacy shelves (flat them).
          nodes.low.gain.value = 0;
          nodes.mid.gain.value = 0;
          nodes.high.gain.value = 0;
          const bands = bandsOf(ac);
          for (let i = 0; i < 6; i++) {
            nodes.bands[i].frequency.value = bands[i].freq;
            nodes.bands[i].gain.value = bands[i].gain;
            nodes.bands[i].Q.value = bands[i].q;
          }
        } else {
          nodes.low.gain.value = ac.eqLow ?? 0;
          nodes.mid.gain.value = ac.eqMid ?? 0;
          nodes.high.gain.value = ac.eqHigh ?? 0;
          for (const b of nodes.bands) b.gain.value = 0;
        }
      }
      if (this.masterGain && proj.audioBus) this.masterGain.gain.value = proj.audioBus.masterGain;
      if (this.playing && this.rate > 0 && el.paused) void el.play().catch(() => undefined);
      if ((!this.playing || this.rate < 0) && !el.paused) el.pause();
    }
  }
}

export const playback = new PlaybackEngine();
