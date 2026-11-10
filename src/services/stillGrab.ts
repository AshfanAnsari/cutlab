/**
 * stillGrab.ts — grab the current frame as a canvas (Q.11's route,
 * shared). One canonical copy: the Cover maker downloads it as a PNG;
 * the viewer's compare wipe (D2.7, V.4) holds it as the reference
 * still. The grab is the PRIMARY video element's frame, cover-fit
 * into the project canvas — the same frame the Cover has always used.
 */
import { playback } from '../engine/playback';

export function grabStageStill(canvasW: number, canvasH: number): HTMLCanvasElement | null {
  const video = playback.getPrimaryVideoElement();
  if (!video || video.videoWidth === 0) return null;
  const fc = document.createElement('canvas');
  fc.width = canvasW;
  fc.height = canvasH;
  const ctx = fc.getContext('2d');
  if (!ctx) return null;
  const scale = Math.max(canvasW / video.videoWidth, canvasH / video.videoHeight);
  const dw = video.videoWidth * scale, dh = video.videoHeight * scale;
  try {
    ctx.drawImage(video, (canvasW - dw) / 2, (canvasH - dh) / 2, dw, dh);
  } catch {
    return null; // frame not drawable (not decoded / cross-origin)
  }
  return fc;
}
