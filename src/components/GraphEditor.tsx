// Graph editor (M.5): the selected clip's value curve for one property —
// the true interpolated path (sampled from the same solver the preview
// uses), draggable keyframe points, and draggable Bezier handles for
// keys whose ease is 'bezier'. Ease surgery lives here: arrivals ease
// out, holds stay linear, overshoot only on purpose (EM II §4.6).
import { useRef, useState } from 'react';
import { store } from '../state/store';
import type { Keyframe, Transform, VideoClip } from '../types';
import { clipDuration } from '../types';
import { kfValue } from '../engine/compose';
import { copyKeyframes, pasteKeyframes } from '../state/actions';
import { clamp, qFrame } from '../utils/time';

const PROPS: (keyof Transform)[] = ['x', 'y', 'scale', 'rotation', 'opacity'];
const W = 248;
const H = 118;
const PAD = 10;

export default function GraphEditor({ clip, trackId }: { clip: VideoClip; trackId: string }) {
  const [prop, setProp] = useState<keyof Transform>('y');
  const [sel, setSel] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const dur = Math.max(0.05, clipDuration(clip));
  const base = clip.transform;
  const kfs = clip.keyframes ?? [];
  const keyedIdx = kfs
    .map((k, i) => ({ k, i }))
    .filter(({ k }) => typeof k[prop] === 'number');
  const points = [
    { t: 0, v: base[prop], idx: -1 },
    ...keyedIdx.map(({ k, i }) => ({ t: k.t, v: k[prop] as number, idx: i })),
  ].sort((a, b) => a.t - b.t);
  const vs = points.map((p) => p.v);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const vPad = Math.max(0.05, (vMax - vMin) * 0.25);
  const lo = vMin - vPad;
  const hi = vMax + vPad;
  const X = (t: number) => PAD + (t / dur) * (W - PAD * 2);
  const Y = (v: number) => H - PAD - ((v - lo) / Math.max(1e-6, hi - lo)) * (H - PAD * 2);
  const invX = (px: number) => ((px - PAD) / (W - PAD * 2)) * dur;
  const invY = (py: number) => lo + ((H - PAD - py) / (H - PAD * 2)) * (hi - lo);

  // The true curve: sample the shipped solver.
  const samples: string[] = [];
  for (let i = 0; i <= 48; i++) {
    const t = (i / 48) * dur;
    samples.push(`${X(t).toFixed(1)},${Y(kfValue(kfs, base, prop, t, dur)).toFixed(1)}`);
  }

  const patch = (fn: (c: VideoClip) => void, history: boolean) => {
    store.commit((d) => {
      const tr = d.tracks.find((x) => x.id === trackId);
      const c = tr?.clips.find((x) => x.id === clip.id) as VideoClip | undefined;
      if (c) fn(c);
    }, { history });
  };

  const toLocal = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * W,
      y: ((e.clientY - r.top) / r.height) * H,
    };
  };

  const dragPoint = (e: React.PointerEvent, kfIdx: number) => {
    e.stopPropagation();
    store.commit(() => undefined, { history: true });
    const move = (ev: PointerEvent) => {
      const r = svgRef.current!.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const py = ((ev.clientY - r.top) / r.height) * H;
      const fps = store.get().project.canvas.fps;
      patch((c) => {
        const k = c.keyframes![kfIdx];
        k.t = clamp(qFrame(invX(px), fps), 0, dur);
        (k[prop] as number) = Math.round(invY(py) * 1000) / 1000;
        c.keyframes!.sort((a, b) => a.t - b.t);
      }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragHandle = (e: React.PointerEvent, kfIdx: number, which: 'h1' | 'h2') => {
    e.stopPropagation();
    const kf = kfs[kfIdx];
    const prev = [...points].filter((p) => p.t < kf.t).pop() ?? { t: 0, v: base[prop] };
    store.commit(() => undefined, { history: true });
    const move = (ev: PointerEvent) => {
      const pt = toLocal(ev as unknown as React.PointerEvent);
      patch((c) => {
        const k = c.keyframes![kfIdx];
        const segT = Math.max(0.01, k.t - prev.t);
        const segV = (k[prop] as number) - prev.v || 1;
        const h = k.easeHandles ?? { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
        if (which === 'h1') {
          h.x1 = clamp((invX(pt.x) - prev.t) / segT, 0, 1);
          h.y1 = (invY(pt.y) - prev.v) / segV;
        } else {
          h.x2 = clamp(1 - (k.t - invX(pt.x)) / segT, 0, 1);
          h.y2 = 1 - ((k[prop] as number) - invY(pt.y)) / segV;
        }
        k.easeHandles = { ...h };
      }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const selKf: Keyframe | undefined = kfs[sel];
  const selPrev = selKf ? ([...points].filter((p) => p.t < selKf.t).pop() ?? { t: 0, v: base[prop] }) : null;

  return (
    <div className="mt-2 rounded border border-[#3a3a3a] bg-[#1e1e1e] p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <span className="panel-title">Curve</span>
        <select className="field" style={{ padding: '1px 4px', fontSize: 11 }} value={prop}
          onChange={(e) => setProp(e.target.value as keyof Transform)} aria-label="Curve property">
          {PROPS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <div className="flex-1" />
        <button className="btn small" title="Set every segment to ease in-out"
          onClick={() => patch((c) => { for (const k of c.keyframes ?? []) k.ease = 'easeInOut'; }, true)}>
          Smooth all
        </button>
        <button className="btn small" title="Segments after hold keyframes stay linear"
          onClick={() => patch((c) => {
            const ks = [...(c.keyframes ?? [])].sort((a, b) => a.t - b.t);
            for (let i = 1; i < ks.length; i++) if (ks[i - 1].hold) ks[i].ease = 'linear';
            c.keyframes = ks;
          }, true)}>
          Holds linear
        </button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full rounded bg-[#171717]" role="img" aria-label={`${prop} curve`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} stroke="#242424">
            <line x1={X(dur * f)} y1={PAD} x2={X(dur * f)} y2={H - PAD} />
            <line x1={PAD} y1={Y(lo + f * (hi - lo))} x2={W - PAD} y2={Y(lo + f * (hi - lo))} />
          </g>
        ))}
        <text x={PAD + 1} y={PAD + 6} fontSize={7} fill="#6f6f6f">{hi.toFixed(2)}</text>
        <text x={PAD + 1} y={H - 2} fontSize={7} fill="#6f6f6f">{lo.toFixed(2)}</text>
        <line x1={PAD} y1={Y(0)} x2={W - PAD} y2={Y(0)} stroke="#333" strokeWidth="1" />
        <polyline points={samples.join(' ')} fill="none" stroke="#C0C0C0" strokeWidth="1.5" />
        {selKf?.ease === 'bezier' && selPrev && (() => {
          const h = selKf.easeHandles ?? { x1: 0.33, y1: 0, x2: 0.67, y2: 1 };
          const segT = Math.max(0.01, selKf.t - selPrev.t);
          const segV = ((selKf[prop] as number) ?? selPrev.v) - selPrev.v || 1;
          const c1 = { x: X(selPrev.t + h.x1 * segT), y: Y(selPrev.v + h.y1 * segV) };
          const c2 = { x: X(selKf.t - (1 - h.x2) * segT), y: Y(((selKf[prop] as number) ?? selPrev.v) - (1 - h.y2) * segV) };
          const end = { x: X(selKf.t), y: Y((selKf[prop] as number) ?? selPrev.v) };
          const start = { x: X(selPrev.t), y: Y(selPrev.v) };
          return (
            <g>
              <line x1={start.x} y1={start.y} x2={c1.x} y2={c1.y} stroke="#E31000" strokeWidth="0.75" />
              <line x1={end.x} y1={end.y} x2={c2.x} y2={c2.y} stroke="#E31000" strokeWidth="0.75" />
              <circle cx={c1.x} cy={c1.y} r={3.5} fill="#E31000" style={{ cursor: 'grab' }}
                onPointerDown={(e) => dragHandle(e, sel, 'h1')} />
              <circle cx={c2.x} cy={c2.y} r={3.5} fill="#E31000" style={{ cursor: 'grab' }}
                onPointerDown={(e) => dragHandle(e, sel, 'h2')} />
            </g>
          );
        })()}
        {points.map((p) =>
          p.idx < 0 ? (
            <circle key="base" cx={X(p.t)} cy={Y(p.v)} r={3} fill="#666" />
          ) : (
            <circle key={p.idx} cx={X(p.t)} cy={Y(p.v)} r={sel === p.idx ? 4.5 : 3.5}
              fill={sel === p.idx ? '#E31000' : '#FFD75E'} stroke="#1e1e1e" strokeWidth="1"
              style={{ cursor: 'grab' }}
              onPointerDown={(e) => { setSel(p.idx); dragPoint(e, p.idx); }} />
          ),
        )}
      </svg>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <button className="btn small" onClick={copyKeyframes}>Copy keyframes</button>
        <button className="btn small" onClick={pasteKeyframes}>Paste keyframes</button>
        {selKf && (
          <span className="font-mono text-[11px] text-[#a8a8a8]">
            key @{selKf.t.toFixed(2)}s · ease {selKf.ease ?? 'linear'}{selKf.hold ? ' · hold' : ''}
          </span>
        )}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
        Drag points to retime/reshape. Set a key's ease to "bezier" in the list above, select it,
        and pull the red handles. The drawn curve is the shipped solver's own output.
      </p>
    </div>
  );
}
