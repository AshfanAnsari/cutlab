// Cover maker (Q.11): grab the current stage frame, add one styled text
// overlay, download a PNG at canvas size — the in-editor thumbnail route
// from EM I §12 Ep 16, in our own minimal form.
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { grabStageStill } from '../services/stillGrab';
import { downloadBlob } from '../services/projectIO';

export function CoverForm() {
  const canvas = useStore((s) => s.project.canvas);
  const [text, setText] = useState('');
  const [yFrac, setYFrac] = useState(0.78);
  const [fontPx, setFontPx] = useState(Math.round(canvas.h * 0.075));
  const [hasFrame, setHasFrame] = useState(false);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const fc = grabStageStill(canvas.w, canvas.h);
    if (fc) {
      frameRef.current = fc;
      setHasFrame(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, canvas.w, canvas.h);
    if (frameRef.current) ctx.drawImage(frameRef.current, 0, 0);
    if (text.trim()) {
      ctx.font = `800 ${fontPx}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const y = yFrac * canvas.h;
      ctx.lineWidth = Math.max(2, fontPx * 0.14);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(text, canvas.w / 2, y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, canvas.w / 2, y);
    }
  }, [text, yFrac, fontPx, hasFrame, canvas]);


  return (
    <div className="flex flex-col gap-2">
          <div className="flex justify-center rounded bg-black/40 p-2">
            <canvas ref={cvRef} width={canvas.w} height={canvas.h}
              style={{ width: canvas.w >= canvas.h ? 300 : 'auto', height: canvas.w >= canvas.h ? 'auto' : 300, maxWidth: '100%' }} />
          </div>
          {!hasFrame && (
            <p className="text-[11px] text-[#e8c468]">No video frame at the playhead — the cover starts from a plain field; park the playhead on the frame you want first.</p>
          )}
          <input className="field" placeholder="Cover text" value={text} maxLength={60}
            onChange={(e) => setText(e.target.value)} />
          <label className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
            <span className="w-20">Text height</span>
            <input type="range" min={0.1} max={0.95} step={0.01} value={yFrac} className="flex-1"
              onChange={(e) => setYFrac(Number(e.target.value))} />
          </label>
          <label className="flex items-center gap-2 text-[12px] text-[#a8a8a8]">
            <span className="w-20">Text size</span>
            <input type="range" min={20} max={Math.round(canvas.h * 0.16)} step={2} value={fontPx} className="flex-1"
              onChange={(e) => setFontPx(Number(e.target.value))} />
          </label>
          <button className="btn primary justify-center py-2"
            onClick={() => {
              cvRef.current?.toBlob((b) => {
                if (b) downloadBlob(b, 'cutlab-cover.png');
              }, 'image/png');
            }}>
            Download cover PNG ({canvas.w}×{canvas.h})
          </button>
    </div>
  );
}

export default function CoverMaker({ onClose }: { onClose: () => void }) {
  // FIX B2 #18: Escape closes, like every other dialog in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="modal-panel w-[440px] max-w-[94vw]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
          <span className="text-[18px] font-semibold">Cover / thumbnail</span>
          <button className="btn icon" onClick={onClose}>×</button>
        </div>
        <div className="px-4 py-3">
          <CoverForm />
        </div>
      </div>
    </div>
  );
}
