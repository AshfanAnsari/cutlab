/**
 * eq.ts — the 6-band parametric EQ model (D2.5), one canonical copy.
 *
 * Bands are peaking filters (freq Hz / gain dB / Q). The preview's
 * WebAudio biquads and Lane B's `equalizer` chain run the same RBJ
 * peaking maths, so a band dialled in the Inspector measures the same
 * in the render (acceptance: within 1.5 dB at probe frequencies).
 * `eqBands` supersedes the legacy 3-band fields (eqLow/eqMid/eqHigh,
 * which are dB per types.ts K.10) whenever present; the editor
 * migrates legacy values into bands on first touch.
 */
import type { EqBand } from '../types';

export const EQ_BAND_COUNT = 6;
const DEFAULT_FREQS = [80, 250, 800, 2500, 6000, 12000];

export function defaultEqBands(): EqBand[] {
  return DEFAULT_FREQS.map((freq) => ({ freq, gain: 0, q: 0.9 }));
}

/** Bands for a clip: its own when present, else the legacy 3-band
 *  values mapped onto bands 1/3/5 (200 Hz shelf → peaking at 200,
 *  1 kHz, 4 kHz), else flat defaults. */
export function bandsOf(clip: { eqBands?: EqBand[]; eqLow?: number; eqMid?: number; eqHigh?: number }): EqBand[] {
  if (clip.eqBands && clip.eqBands.length > 0) {
    const out = clip.eqBands.slice(0, EQ_BAND_COUNT).map((b) => ({
      freq: Math.min(16000, Math.max(30, b.freq || 1000)),
      gain: Math.min(18, Math.max(-18, b.gain || 0)),
      q: Math.min(10, Math.max(0.2, b.q || 0.9)),
    }));
    while (out.length < EQ_BAND_COUNT) out.push({ freq: DEFAULT_FREQS[out.length], gain: 0, q: 0.9 });
    return out;
  }
  if (clip.eqLow || clip.eqMid || clip.eqHigh) {
    const out = defaultEqBands();
    out[0] = { freq: 200, gain: clip.eqLow ?? 0, q: 0.7 };
    out[2] = { freq: 1000, gain: clip.eqMid ?? 0, q: 0.9 };
    out[4] = { freq: 4000, gain: clip.eqHigh ?? 0, q: 0.7 };
    return out;
  }
  return defaultEqBands();
}

export function eqActive(clip: { eqBands?: EqBand[]; eqLow?: number; eqMid?: number; eqHigh?: number }): boolean {
  if (clip.eqBands) return clip.eqBands.some((b) => Math.abs(b.gain) > 0.01);
  return !!(clip.eqLow || clip.eqMid || clip.eqHigh);
}
