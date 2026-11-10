// Scopes (N.7): waveform + RGB parade + vectorscope computed from the live
// preview frame on small canvases — eyes adapt to a cast in ~10 s, scopes
// don't (EM II §6.4). Client-side only; the frame is already decoded here.
import { useEffect, useRef } from 'react';
import { playback } from '../engine/playback';

const SW = 120; // sample width
const SH = 68; // sample height

export default function Scopes() {
  const waveRef = useRef<HTMLCanvasElement>(null);
  const paradeRef = useRef<HTMLCanvasElement>(null);
  const vecRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const draw = () => {
      const video = playback.getPrimaryVideoElement();
      const wave = waveRef.current, parade = paradeRef.current, vec = vecRef.current;
      if (!video || !wave || !parade || !vec || video.readyState < 2 || video.videoWidth === 0) return;
      if (!frameRef.current) frameRef.current = document.createElement('canvas');
      const fc = frameRef.current;
      fc.width = SW;
      fc.height = SH;
      const fctx = fc.getContext('2d', { willReadFrequently: true });
      if (!fctx) return;
      try {
        fctx.drawImage(video, 0, 0, SW, SH);
      } catch {
        return; // frame not drawable yet
      }
      const data = fctx.getImageData(0, 0, SW, SH).data;
      // --- waveform (luma by column) ---
      const wctx = wave.getContext('2d');
      if (wctx) {
        wctx.fillStyle = '#141414';
        wctx.fillRect(0, 0, wave.width, wave.height);
        wctx.fillStyle = 'rgba(192,192,192,0.85)';
        for (let x = 0; x < SW; x++) {
          for (let y = 0; y < SH; y++) {
            const i = (y * SW + x) * 4;
            const luma = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
            const py = wave.height - 2 - luma * (wave.height - 4);
            const sx = (x / SW) * wave.width;
            wctx.fillRect(sx, py, Math.max(1, wave.width / SW), 1.4);
          }
        }
      }
      // --- parade (per-channel columns) ---
      const pctx = parade.getContext('2d');
      if (pctx) {
        pctx.fillStyle = '#141414';
        pctx.fillRect(0, 0, parade.width, parade.height);
        const third = parade.width / 3;
        const colors = ['rgba(255,90,80,0.8)', 'rgba(110,230,130,0.8)', 'rgba(100,150,255,0.8)'];
        for (let ch = 0; ch < 3; ch++) {
          pctx.fillStyle = colors[ch];
          for (let x = 0; x < SW; x++) {
            for (let y = 0; y < SH; y++) {
              const i = (y * SW + x) * 4;
              const v = data[i + ch] / 255;
              const py = parade.height - 2 - v * (parade.height - 4);
              pctx.fillRect(ch * third + (x / SW) * third, py, Math.max(1, third / SW), 1.4);
            }
          }
        }
      }
      // --- vectorscope (Cb/Cr scatter) ---
      const vctx = vec.getContext('2d');
      if (vctx) {
        const S = vec.width;
        vctx.fillStyle = '#141414';
        vctx.fillRect(0, 0, S, S);
        vctx.strokeStyle = '#333';
        vctx.beginPath();
        vctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
        vctx.stroke();
        vctx.fillStyle = 'rgba(232,194,104,0.7)';
        for (let i = 0; i < data.length; i += 16) {
          const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
          const cb = (b - (0.2126 * r + 0.7152 * g + 0.0722 * b)) * 0.56;
          const cr = (r - (0.2126 * r + 0.7152 * g + 0.0722 * b)) * 0.71;
          vctx.fillRect(S / 2 + cb * S, S / 2 - cr * S, 1.3, 1.3);
        }
      }
    };
    draw();
    const iv = setInterval(draw, 160);
    return () => clearInterval(iv);
  }, []);

  const label = (t: string) => <div className="font-mono text-[11px] uppercase tracking-wide text-[#a8a8a8]">{t}</div>;
  return (
    <div className="flex flex-wrap gap-2">
      <div>{label('Waveform')}<canvas ref={waveRef} width={118} height={64} className="rounded border border-[#3a3a3a]" /></div>
      <div>{label('Parade')}<canvas ref={paradeRef} width={118} height={64} className="rounded border border-[#3a3a3a]" /></div>
      <div>{label('Vectorscope')}<canvas ref={vecRef} width={64} height={64} className="rounded border border-[#3a3a3a]" /></div>
    </div>
  );
}
