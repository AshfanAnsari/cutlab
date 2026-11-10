// Colour panel (§N): white balance, exposure set, primaries wheels, curves,
// HSL, LUT — one panel used for a clip's grade and for the project look.
// The studied order is the panel order: LUT → primaries → curves → HSL.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CurvePt, Grade, GradeKey, WheelVal } from '../types';
import { DEFAULT_GRADE_KEY, matteView, stagePicker } from '../services/qualifier';
import { setPage } from '../services/pages';
import { setGalleryHero } from '../services/gallery';
import { HSL_CHANNELS } from '../types';
import { DEFAULT_GRADE, FILMIC_S_CURVE, MAX_GRADE_LAYERS } from '../services/grade';
import { listLuts, removeLut, subscribeLuts, uploadLut } from '../services/luts';
import { playback } from '../engine/playback';
import { idb } from '../services/db';
import { useNarrow } from '../services/useNarrow';
import { Num, Slider } from './Inspector';
import Switch from './Switch';

type Patch = (fn: (g: Grade) => void, history?: boolean) => void;

function Wheel({ label, value, onPatch }: { label: string; value: WheelVal; onPatch: Patch }) {
  const padRef = useRef<HTMLDivElement>(null);
  const set = (patch: Partial<WheelVal>, history: boolean) => onPatch((g) => {
    const key = label.toLowerCase() as 'lift' | 'gamma' | 'gain' | 'offset';
    g[key] = { ...g[key], ...patch };
  }, history);
  const fromEvent = (e: React.PointerEvent) => {
    const r = padRef.current!.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * 2 - 1;
    const y = ((e.clientY - r.top) / r.height) * 2 - 1;
    return {
      r: Math.max(-1, Math.min(1, x * 0.7 - y * 0.3)),
      g: Math.max(-1, Math.min(1, -x * 0.4 - y * 0.55)),
      b: Math.max(-1, Math.min(1, y * 0.85)),
    };
  };
  // Dot position is the exact inverse of fromEvent's pointer→value map
  // (y = b / 0.85, x = (r + 0.3y) / 0.7), so the dot tracks the pointer.
  const dotX = Math.max(-48, Math.min(48, (1.4286 * value.r + 0.5042 * value.b) * 50));
  const dotY = Math.max(-48, Math.min(48, 1.1765 * value.b * 50));
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        ref={padRef}
        className="relative h-[62px] w-[62px] cursor-crosshair touch-none rounded-full border border-[#4a4a4a]"
        style={{ background: 'conic-gradient(from 0deg, #7a4a44, #7a7444, #4a7a4e, #44707a, #4a4a7a, #74447a, #7a4a44)' }}
        title={`${label} wheel — drag to tint`}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          set(fromEvent(e), true);
        }}
        onPointerMove={(e) => {
          if (e.buttons > 0) set(fromEvent(e), false);
        }}
      >
        <span className="absolute h-2 w-2 rounded-full border border-white bg-black/60"
          style={{ left: `calc(50% + ${dotX}% - 4px)`, top: `calc(50% + ${dotY}% - 4px)` }} />
      </div>
      <span className="text-[11px] text-[#a8a8a8]">{label}</span>
      <input type="range" min={-1} max={1} step={0.01} value={value.master} className="w-[62px]"
        aria-label={`${label} master`}
        onChange={(e) => set({ master: Number(e.target.value) }, false)} />
    </div>
  );
}

function CurveEditor({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  const [chan, setChan] = useState<'master' | 'r' | 'g' | 'b'>('master');
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 232, H = 104;
  const pts: CurvePt[] = grade.curves?.[chan] ?? [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const X = (x: number) => x * W;
  const Y = (y: number) => H - y * H;
  const toPt = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)),
    };
  };
  const write = (next: CurvePt[] | undefined, history: boolean) => onPatch((g) => {
    g.curves = { ...(g.curves ?? {}), [chan]: next };
  }, history);
  const path = (() => {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const seg: string[] = [];
    for (let i = 0; i <= 32; i++) {
      const x = i / 32;
      let y = sorted[sorted.length - 1].y;
      if (x <= sorted[0].x) y = sorted[0].y;
      else {
        for (let j = 1; j < sorted.length; j++) {
          if (x <= sorted[j].x) {
            const a = sorted[j - 1], b = sorted[j];
            y = b.x === a.x ? b.y : a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
            break;
          }
        }
      }
      seg.push(`${X(x).toFixed(1)},${Y(y).toFixed(1)}`);
    }
    return seg.join(' ');
  })();
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {(['master', 'r', 'g', 'b'] as const).map((c) => (
          <button key={c} className="btn small" aria-pressed={chan === c}
            style={chan === c ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
            onClick={() => setChan(c)}>
            {c === 'master' ? 'RGB' : c.toUpperCase()}
          </button>
        ))}
        <div className="flex-1" />
        <button className="btn small" title="The studied filmic S-curve"
          onClick={() => write(FILMIC_S_CURVE.map((p) => ({ ...p })), true)}>S-curve</button>
        <button className="btn small" onClick={() => write(undefined, true)}>Reset</button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-[#3a3a3a] bg-[#171717]"
        onDoubleClick={(e) => {
          const p = toPt(e);
          write([...pts, { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }], true);
        }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} stroke="#242424">
            <line x1={X(f)} y1={0} x2={X(f)} y2={H} />
            <line x1={0} y1={Y(f)} x2={W} y2={Y(f)} />
          </g>
        ))}
        <text x={2} y={H - 2} fontSize={7} fill="#6f6f6f">0</text>
        <text x={W - 8} y={9} fontSize={7} fill="#6f6f6f">1</text>
        <line x1={0} y1={H} x2={W} y2={0} stroke="#2c2c2c" />
        <polyline points={path} fill="none" stroke="#C0C0C0" strokeWidth="1.5" />
        {pts.map((p, i) => (
          <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={4} fill="#E31000" style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.altKey) {
                if (pts.length > 2) write(pts.filter((_, j) => j !== i), true);
                return;
              }
              const move = (ev: PointerEvent) => {
                const np = toPt(ev);
                write(pts.map((q, j) => (j === i ? { x: Math.round(np.x * 100) / 100, y: Math.round(np.y * 100) / 100 } : q)), false);
              };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }} />
        ))}
      </svg>
      <p className="mt-0.5 text-[11px] text-[#a8a8a8]">Drag points · double-click adds · Alt+click deletes.</p>
    </div>
  );
}

/** Hue-vs curves (N.12): x = source hue 0..1, y = bend −1..1 (hue shift
 *  ±180° for hueHue, saturation delta for hueSat). Same gestures as the RGB
 *  curve editor: drag points, double-click adds, Alt+click deletes. */
function HueCurveEditor({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  const [which, setWhich] = useState<'hueHue' | 'hueSat' | 'lumSat'>('hueHue');
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 232, H = 84;
  const pts: CurvePt[] = grade.hueCurves?.[which] ?? [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const X = (x: number) => x * W;
  const Y = (y: number) => (1 - (y + 1) / 2) * H;
  const toPt = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(-1, 1 - ((e.clientY - r.top) / r.height) * 2)),
    };
  };
  const write = (next: CurvePt[] | undefined, history: boolean) => onPatch((g) => {
    g.hueCurves = { ...(g.hueCurves ?? {}), [which]: next };
  }, history);
  const path = (() => {
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const seg: string[] = [];
    for (let i = 0; i <= 32; i++) {
      const x = i / 32;
      let y = sorted[sorted.length - 1].y;
      if (x <= sorted[0].x) y = sorted[0].y;
      else {
        for (let j = 1; j < sorted.length; j++) {
          if (x <= sorted[j].x) {
            const a = sorted[j - 1], b = sorted[j];
            y = b.x === a.x ? b.y : a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
            break;
          }
        }
      }
      seg.push(`${X(x).toFixed(1)},${Y(y).toFixed(1)}`);
    }
    return seg.join(' ');
  })();
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        {(['hueHue', 'hueSat', 'lumSat'] as const).map((c) => (
          <button key={c} className="btn small" aria-pressed={which === c}
            style={which === c ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
            onClick={() => setWhich(c)}>
            {c === 'hueHue' ? 'Hue → Hue' : c === 'hueSat' ? 'Hue → Sat' : 'Lum → Sat'}
          </button>
        ))}
        <div className="flex-1" />
        <button className="btn small" onClick={() => write(undefined, true)}>Reset</button>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full rounded border border-[#3a3a3a] bg-[#171717]"
        onDoubleClick={(e) => {
          const p = toPt(e);
          write([...pts, { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }], true);
        }}>
        <defs>
          <linearGradient id="cl-huegrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#f00" /><stop offset="0.17" stopColor="#ff0" />
            <stop offset="0.33" stopColor="#0f0" /><stop offset="0.5" stopColor="#0ff" />
            <stop offset="0.67" stopColor="#00f" /><stop offset="0.83" stopColor="#f0f" />
            <stop offset="1" stopColor="#f00" />
          </linearGradient>
          <linearGradient id="cl-lumgrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#000" /><stop offset="0.5" stopColor="#808080" />
            <stop offset="1" stopColor="#fff" />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={W} height={H} fill={which === 'lumSat' ? 'url(#cl-lumgrad)' : 'url(#cl-huegrad)'} opacity={0.18} />
        {[0.25, 0.75].map((f) => (
          <line key={f} x1={X(f)} y1={0} x2={X(f)} y2={H} stroke="#242424" />
        ))}
        <line x1={0} y1={Y(0.5)} x2={W} y2={Y(0.5)} stroke="#242424" />
        <line x1={0} y1={Y(-0.5)} x2={W} y2={Y(-0.5)} stroke="#242424" />
        <text x={2} y={9} fontSize={7} fill="#6f6f6f">+1</text>
        <text x={2} y={H - 2} fontSize={7} fill="#6f6f6f">−1</text>
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#3a3a3a" />
        <polyline points={path} fill="none" stroke="#C0C0C0" strokeWidth="1.5" />
        {pts.map((p, i) => (
          <circle key={i} cx={X(p.x)} cy={Y(p.y)} r={4} fill="#E31000" style={{ cursor: 'grab' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.altKey) {
                if (pts.length > 2) write(pts.filter((_, j) => j !== i), true);
                return;
              }
              const move = (ev: PointerEvent) => {
                const np = toPt(ev);
                write(pts.map((q, j) => (j === i ? { x: Math.round(np.x * 100) / 100, y: Math.round(np.y * 100) / 100 } : q)), false);
              };
              const up = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', up);
            }} />
        ))}
      </svg>
    </div>
  );
}

const cloneGrade = (g: Grade): Grade => JSON.parse(JSON.stringify(g)) as Grade;

/** Serial grade stack editor (D1.1): a layer strip (numbered chips,
 *  drag to reorder with a 150 ms settle, per-layer enable toggle, add /
 *  remove, cap MAX_GRADE_LAYERS) over the single-layer ColorPanel.
 *  With no layers yet, layer 1 is a phantom that materialises on the
 *  first edit — the Colour section keeps its always-editable feel.
 *  Switching layers swaps the controls in place (same panel, new data),
 *  so the section height never jumps. */
/**
 * KeySection (D1.2): qualifier-lite controls for the stack's ACTIVE
 * layer. Ranges travel inside the layer's Grade.key; Lane B applies the
 * exact HSV selection (services/qualifier.ts holds the shared formula).
 * The matte view is a sampled approximation and says so, in the UI.
 */
function KeySection({ grade, patchActive, clipId }: {
  grade: Grade;
  patchActive: Patch;
  clipId: string;
}) {
  const key = grade.key;
  const [matteOn, setMatteOn] = useState(() => matteView.get()?.clipId === clipId);
  const [pulse, setPulse] = useState(false);
  const armed = useSyncExternalStore(stagePicker.subscribe, stagePicker.isArmed);
  // Keep the stage matte in sync with the key being edited; stop the
  // matte when this section unmounts (another clip gets selected).
  useEffect(() => {
    if (matteOn) matteView.set(key ? { clipId, key } : null);
  }, [matteOn, key, clipId]);
  useEffect(() => () => {
    if (matteView.get()?.clipId === clipId) matteView.set(null);
    stagePicker.disarm();
  }, [clipId]);

  const patchKey = (fn: (k: GradeKey) => void) => patchActive((g) => { if (g.key) fn(g.key); });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const ks = (label: string, val: number, min: number, max: number, step: number,
    apply: (k: GradeKey, v: number) => void, format?: (v: number) => string) => (
    <Slider label={label} value={val} min={min} max={max} step={step} format={format}
      onLive={(v) => patchKey((k) => apply(k, v))} />
  );

  return (
    <div className="border-t border-[#333] pt-2">
      <div className="flex items-center gap-2">
        <span className="panel-title">Qualifier — grade only the selected colour</span>
        <span className="ml-auto">
          <Switch size="sm" checked={!!key} ariaLabel="Qualifier on/off"
            onChange={(v) => patchActive((g) => { if (v) g.key = { ...DEFAULT_GRADE_KEY }; else delete g.key; })} />
        </span>
      </div>
      {key && (
        <div className="mt-1">
          <div className="flex items-center gap-2 py-0.5">
            <span className="w-[86px] shrink-0 text-[12px] text-[#a8a8a8]">Hue centre</span>
            <div aria-hidden className="h-[6px] min-w-0 flex-1 rounded-full"
              style={{ background: 'linear-gradient(90deg, #c23b2e, #c2852e, #b8b83a, #3f9e4d, #2e7fc2, #6a3fa0, #c23b2e)' }} />
            <span className="rounded px-1.5 py-0.5 font-mono text-[11px] text-[#e8e8e8]"
              style={{ background: pulse ? 'rgba(232,194,104,0.35)' : 'transparent', transition: 'background 180ms ease-out' }}>
              {Math.round(key.hue * 360)}°
            </span>
          </div>
          <Slider label="Hue centre" value={key.hue} min={0} max={1} step={0.005}
            format={(v) => `${Math.round(v * 360)}°`}
            onLive={(v) => patchKey((k) => { k.hue = v; })} />
          {ks('Hue width', key.hueWidth, 0.02, 0.5, 0.005, (k, v) => { k.hueWidth = v; }, pct)}
          {ks('Hue softness', key.hueSoft, 0, 0.25, 0.005, (k, v) => { k.hueSoft = v; }, pct)}
          {ks('Saturation min', key.satMin, 0, 1, 0.01, (k, v) => { k.satMin = Math.min(v, k.satMax); }, pct)}
          {ks('Saturation max', key.satMax, 0, 1, 0.01, (k, v) => { k.satMax = Math.max(v, k.satMin); }, pct)}
          {ks('Sat feather', key.satSoft, 0, 0.3, 0.005, (k, v) => { k.satSoft = v; }, pct)}
          {ks('Luma min', key.lumaMin, 0, 1, 0.01, (k, v) => { k.lumaMin = Math.min(v, k.lumaMax); }, pct)}
          {ks('Luma max', key.lumaMax, 0, 1, 0.01, (k, v) => { k.lumaMax = Math.max(v, k.lumaMin); }, pct)}
          {ks('Luma feather', key.lumaSoft, 0, 0.3, 0.005, (k, v) => { k.lumaSoft = v; }, pct)}
          <div className="mt-1.5 flex gap-1.5">
            <span className="inline-flex items-center text-[11px] text-[#a8a8a8]">
              <Switch size="sm" checked={matteOn} label="Matte view" onChange={(v) => setMatteOn(v)} />
            </span>
            <button className="btn small" aria-pressed={armed}
              style={armed ? { borderColor: '#E8C268', color: '#E8C268' } : undefined}
              onClick={() => stagePicker.arm((hue) => {
                patchKey((k) => { k.hue = hue; });
                setPulse(true);
                setTimeout(() => setPulse(false), 200);
              })}>{armed ? 'Click the stage…' : 'Pick hue from stage'}</button>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
            The layer's grade lands only inside the selection. Matte preview is a sampled
            approximation — the render applies the exact selection.
          </p>
        </div>
      )}
    </div>
  );
}

export function GradeStackEditor({ layers, onLayers, clipId, singleLook = false }: {
  layers: Grade[];
  onLayers: (next: Grade[], history?: boolean) => void;
  /** D1.2: when set, the qualifier Key section shows under the panel. */
  clipId?: string;
  /** FIX B2 #3: project-look mode. The data model holds ONE look
   *  grade, so the editor presents exactly that — no + Layer, no
   *  reorder, no per-chip remove (clearing the look is a separate,
   *  confirmed action on the Colour page). Clip mode keeps the
   *  real multi-layer stack. */
  singleLook?: boolean;
}) {
  const [active, setActive] = useState(0);
  const [drag, setDrag] = useState<{ idx: number; dx: number } | null>(null);
  const phantom = layers.length === 0;
  const eff = phantom ? [cloneGrade(DEFAULT_GRADE)] : layers;
  const cur = Math.min(active, eff.length - 1);
  const CHIP_W = 46;

  const patchActive: Patch = (fn, history = true) => {
    const next = eff.map(cloneGrade);
    fn(next[cur]);
    onLayers(next, history);
  };
  const addLayer = () => {
    if (eff.length >= MAX_GRADE_LAYERS) return;
    onLayers([...eff.map(cloneGrade), cloneGrade(DEFAULT_GRADE)], true);
    setActive(eff.length);
  };
  const removeLayer = (i: number) => {
    const next = eff.filter((_, j) => j !== i).map(cloneGrade);
    onLayers(next, true);
    setActive((a) => Math.max(0, Math.min(a, next.length - 1)));
  };
  const toggleEnabled = (i: number) => {
    const next = eff.map(cloneGrade);
    next[i].enabled = next[i].enabled === false ? undefined : false;
    if (next[i].enabled === undefined) delete next[i].enabled;
    onLayers(next, true);
  };
  const dragTarget = drag ? Math.max(0, Math.min(eff.length - 1, drag.idx + Math.round(drag.dx / CHIP_W))) : -1;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="panel-title mb-1">{singleLook ? 'Project look — a single grade' : 'Grade layers — applied in order, 1 first'}</div>
        <div className="flex items-center gap-1.5">
          {eff.map((g, i) => {
            const isDrag = drag?.idx === i;
            let shift = 0;
            if (drag && !isDrag && dragTarget !== drag.idx) {
              if (drag.idx < dragTarget && i > drag.idx && i <= dragTarget) shift = -CHIP_W;
              if (drag.idx > dragTarget && i < drag.idx && i >= dragTarget) shift = CHIP_W;
            }
            return (
              <div
                key={i}
                className="relative flex items-center gap-1 rounded border px-1.5 py-1"
                style={{
                  borderColor: i === cur ? '#C0C0C0' : '#4a4a4a',
                  background: '#242424',
                  opacity: g.enabled === false ? 0.4 : 1,
                  transform: isDrag ? `translateX(${drag.dx}px)` : `translateX(${shift}px)`,
                  transition: isDrag ? 'opacity 150ms' : 'transform 150ms, opacity 150ms',
                  zIndex: isDrag ? 3 : 1,
                  cursor: singleLook ? 'default' : 'grab',
                  touchAction: 'none',
                }}
                title={singleLook ? 'The project look — one grade, applied last over every clip' : 'Drag to reorder'}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return;
                  setActive(i);
                  if (singleLook) return;
                  const startX = e.clientX;
                  const startIdx = i;
                  setDrag({ idx: startIdx, dx: 0 });
                  const move = (ev: PointerEvent) => setDrag({ idx: startIdx, dx: ev.clientX - startX });
                  const up = (ev: PointerEvent) => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                    const dx = ev.clientX - startX;
                    const target = Math.max(0, Math.min(eff.length - 1, startIdx + Math.round(dx / CHIP_W)));
                    setDrag(null);
                    if (target !== startIdx) {
                      const next = eff.map(cloneGrade);
                      const [moved] = next.splice(startIdx, 1);
                      next.splice(target, 0, moved);
                      onLayers(next, true);
                      setActive(target);
                    }
                  };
                  window.addEventListener('pointermove', move);
                  window.addEventListener('pointerup', up);
                }}
              >
                <button
                  className="h-2.5 w-2.5 shrink-0 rounded-full border border-[#a8a8a8]"
                  style={{ background: g.enabled === false ? 'transparent' : '#E8C268' }}
                  title={g.enabled === false ? 'Layer disabled — click to enable' : 'Layer on — click to disable'}
                  onClick={() => toggleEnabled(i)}
                />
                <span className="text-[11px] font-semibold text-[#e8e8e8]">{i + 1}</span>
                {!singleLook && (
                  <button className="px-0.5 text-[11px] text-[#a8a8a8]" title="Remove layer"
                    onClick={() => removeLayer(i)}>×</button>
                )}
              </div>
            );
          })}
          {!singleLook && (
            <button className="btn small" disabled={eff.length >= MAX_GRADE_LAYERS}
              title={eff.length >= MAX_GRADE_LAYERS ? `Stack is capped at ${MAX_GRADE_LAYERS} layers` : 'Add a grade layer'}
              onClick={addLayer}>+ Layer</button>
          )}
        </div>
        <p className="mt-1 text-[11px] leading-snug text-[#a8a8a8]">
          {singleLook
            ? 'This one grade IS the project look — the deck below edits the same grade. It applies last, over every clip’s own stack.'
            : 'Drag a chip to reorder. A dimmed layer is bypassed. The project look still applies last, over the stack.'}
        </p>
      </div>
      <ColorPanel grade={eff[cur]} onPatch={patchActive} />
      {clipId && <KeySection grade={eff[cur]} patchActive={patchActive} clipId={clipId} />}
    </div>
  );
}

/** Colour blocks (W8): ColorPanel's sections as standalone pieces —
 *  the stacked panel (Inspector project look, grade-stack editor)
 *  composes them in the original order; the Colour page's deck
 *  (ColourDeck) composes the same blocks as columns. One copy of
 *  every control, two arrangements. */

export function LutBlock({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  const luts = useSyncExternalStore(subscribeLuts, listLuts);
  const lutRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="panel-title mb-1">LUT (applies at render, head of chain)</div>
      <div className="flex items-center gap-1.5">
        <select className="field flex-1" value={grade.lutId ?? ''}
          onChange={(e) => onPatch((g) => { g.lutId = e.target.value || undefined; }, true)}>
          <option value="">No LUT</option>
          {luts.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.size}³)</option>)}
        </select>
        <button className="btn small" onClick={() => lutRef.current?.click()}>Upload .cube</button>
        <input ref={lutRef} type="file" accept=".cube" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLut(f); e.target.value = ''; }} />
      </div>
      {grade.lutId && (
        <>
          <Slider label="Strength" value={grade.lutStrength ?? 0.5} min={0} max={1}
            onLive={(v) => onPatch((g) => { g.lutStrength = v; }, false)} />
          <button className="btn small" onClick={() => void removeLut(grade.lutId!)}>Remove this LUT file</button>
        </>
      )}
      <p className="text-[11px] leading-snug text-[#a8a8a8]">Preview stays un-LUTed; half strength is the house default.</p>
    </div>
  );
}

export function HeroBlock() {
  const [hero, setHero] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    void idb.get<string>('kv', 'heroFrame').then((v) => { if (v) setHero(v); }).catch(() => undefined);
  }, []);
  const grab = (setter: (v: string) => void, persist = false) => {
    const video = playback.getPrimaryVideoElement();
    if (!video || video.videoWidth === 0) return;
    const cv = document.createElement('canvas');
    cv.width = 176;
    cv.height = Math.max(56, Math.round((176 / video.videoWidth) * video.videoHeight));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, cv.width, cv.height);
    const url = cv.toDataURL('image/jpeg', 0.82);
    setter(url);
    if (persist) {
      void idb.set('kv', 'heroFrame', url).catch(() => undefined);
      setGalleryHero(url);
    }
  };
  return (
    <div>
      <div className="panel-title mb-1">Hero frame — match everything to one shot</div>
      <div className="flex gap-1.5">
        <button className="btn small" onClick={() => grab(setHero, true)}>Grab hero frame</button>
        <button className="btn small" onClick={() => grab(setCurrent)}>Capture current</button>
      </div>
      {(hero || current) && (
        <div className="mt-1.5 flex gap-1.5">
          {hero && <figure><img src={hero} alt="Hero frame" className="w-[118px] rounded border border-[#3a3a3a]" /><figcaption className="text-[11px] text-[#a8a8a8]">hero</figcaption></figure>}
          {current && <figure><img src={current} alt="Current frame" className="w-[118px] rounded border border-[#3a3a3a]" /><figcaption className="text-[11px] text-[#a8a8a8]">current</figcaption></figure>}
        </div>
      )}
    </div>
  );
}

export function PrimariesBlock({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  const s = (label: string, val: number, min: number, max: number, apply: (g: Grade, v: number) => void, step = 0.01) => (
    <Slider label={label} value={val} min={min} max={max} step={step}
      onLive={(v) => onPatch((g) => apply(g, v), false)} />
  );
  return (
    <div>
      <div className="panel-title mb-1">White balance & exposure</div>
      {s('Temperature', grade.temperature, -1, 1, (g, v) => { g.temperature = v; })}
      {s('Tint', grade.tint, -1, 1, (g, v) => { g.tint = v; })}
      {s('Exposure', grade.exposure, -2, 2, (g, v) => { g.exposure = v; }, 0.02)}
      {s('Highlights', grade.highlights, -1, 1, (g, v) => { g.highlights = v; })}
      {s('Shadows', grade.shadows, -1, 1, (g, v) => { g.shadows = v; })}
      {s('Contrast', grade.contrast, -1, 1, (g, v) => { g.contrast = v; })}
      <Num label="Pivot" value={grade.pivot} step={0.05} min={0} max={1}
        onCommit={(v) => onPatch((g) => { g.pivot = v; }, true)} />
      <div className="panel-title mb-1 mt-3">Primaries wheels</div>
      <div className="grid grid-cols-4 gap-1">
        <Wheel label="Lift" value={grade.lift} onPatch={onPatch} />
        <Wheel label="Gamma" value={grade.gamma} onPatch={onPatch} />
        <Wheel label="Gain" value={grade.gain} onPatch={onPatch} />
        <Wheel label="Offset" value={grade.offset} onPatch={onPatch} />
      </div>
    </div>
  );
}

export function CurvesBlock({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  return (
    <div>
      <div className="panel-title mb-1">Curves</div>
      <CurveEditor grade={grade} onPatch={onPatch} />
      <div className="panel-title mb-1 mt-3">Hue curves</div>
      <HueCurveEditor grade={grade} onPatch={onPatch} />
      <p className="mt-0.5 text-[11px] leading-snug text-[#a8a8a8]">
        x = source hue; Hue→Hue bends hue (top = +180°), Hue→Sat bends saturation.
        Preview applies the curves' average shift — Lane B applies them per-hue.
      </p>
    </div>
  );
}

export function HslBlock({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  const [hslChan, setHslChan] = useState<string>('green');
  const hsl = grade.hsl?.[hslChan] ?? { h: 0, s: 0, l: 0 };
  const setHsl = (patch: Partial<{ h: number; s: number; l: number }>, history: boolean) =>
    onPatch((g) => {
      g.hsl = { ...(g.hsl ?? {}), [hslChan]: { ...(g.hsl?.[hslChan] ?? { h: 0, s: 0, l: 0 }), ...patch } };
    }, history);
  return (
    <div>
      <div className="panel-title mb-1">HSL (applies at render)</div>
      <div className="mb-1 flex flex-wrap gap-1">
        {HSL_CHANNELS.map((c) => (
          <button key={c} className="btn small" aria-pressed={hslChan === c}
            style={hslChan === c ? { borderColor: '#C0C0C0', color: '#fff' } : undefined}
            onClick={() => setHslChan(c)}>{c}</button>
        ))}
      </div>
      <Slider label="Hue shift" value={hsl.h} min={-180} max={180} step={1}
        onLive={(v) => setHsl({ h: v }, false)} format={(v) => `${Math.round(v)}°`} />
      <Slider label="Saturation" value={hsl.s} min={-100} max={100} step={1}
        onLive={(v) => setHsl({ s: v }, false)} format={(v) => `${Math.round(v)}`} />
      <Slider label="Luminance" value={hsl.l} min={-100} max={100} step={1}
        onLive={(v) => setHsl({ l: v }, false)} format={(v) => `${Math.round(v)}`} />
      <p className="text-[11px] leading-snug text-[#a8a8a8]">The green-spill fix lives here: pick green, Saturation → −100.</p>
    </div>
  );
}

export default function ColorPanel({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="panel-title mb-1">Scopes</div>
        <p className="text-[11px] text-[#a8a8a8]">Shown under the viewer — the dock is the one live scopes surface (toggle Scopes in the viewer strip).</p>
      </div>
      <HeroBlock />
      <LutBlock grade={grade} onPatch={onPatch} />
      <PrimariesBlock grade={grade} onPatch={onPatch} />
      <CurvesBlock grade={grade} onPatch={onPatch} />
      <HslBlock grade={grade} onPatch={onPatch} />
      <button className="btn small" onClick={() => onPatch((g) => { Object.assign(g, JSON.parse(JSON.stringify(DEFAULT_GRADE))); }, true)}>
        Reset grade
      </button>
    </div>
  );
}

/** The Colour page's bottom deck (§2.4): the same blocks as labelled
 *  horizontal columns with dividers; each column scrolls internally
 *  only if the window is short. FIX B2 #4: on a phone the four
 *  columns stack vertically at full width (Primaries → Curves →
 *  HSL → LUT) and the deck scrolls as one column — at 390 px the
 *  desktop row squeezed each column to ~97 px, smeared the wheels
 *  off the left edge and pushed LUT upload off-screen. */
export function ColourDeck({ grade, onPatch }: { grade: Grade; onPatch: Patch }) {
  const narrow = useNarrow();
  const reset = (
    <button className="btn small mt-3" onClick={() => onPatch((g) => { Object.assign(g, JSON.parse(JSON.stringify(DEFAULT_GRADE))); }, true)}>
      Reset grade
    </button>
  );
  if (narrow) {
    const block = 'w-full px-3 py-2.5';
    return (
      <div className="h-full overflow-y-auto">
        <div className={block}><PrimariesBlock grade={grade} onPatch={onPatch} /></div>
        <div className={block + ' border-t border-[#3a3a3a]'}><CurvesBlock grade={grade} onPatch={onPatch} /></div>
        <div className={block + ' border-t border-[#3a3a3a]'}><HslBlock grade={grade} onPatch={onPatch} /></div>
        <div className={block + ' border-t border-[#3a3a3a]'}>
          <LutBlock grade={grade} onPatch={onPatch} />
          {reset}
        </div>
      </div>
    );
  }
  const col = 'deck-col min-w-0 flex-1 overflow-y-auto px-3 py-2.5';
  return (
    <div className="flex h-full">
      <div className={col}><PrimariesBlock grade={grade} onPatch={onPatch} /></div>
      <div className={col + ' border-l border-[#3a3a3a]'}><CurvesBlock grade={grade} onPatch={onPatch} /></div>
      <div className={col + ' border-l border-[#3a3a3a]'}><HslBlock grade={grade} onPatch={onPatch} /></div>
      <div className={col + ' border-l border-[#3a3a3a]'}>
        <LutBlock grade={grade} onPatch={onPatch} />
        {reset}
      </div>
    </div>
  );
}

/** ColourEntry (§3.13): the Inspector's slim colour entry — the
 *  clip's grade layers as on/off chips plus the door to the Colour
 *  page, where the stack, wheels, curves and qualifier now live.
 *  The grade data itself is untouched by the move. */
export function ColourEntry({ layers, onLayers }: {
  layers: Grade[];
  onLayers: (next: Grade[], history?: boolean) => void;
}) {
  const toggle = (i: number) => {
    const next = layers.map(cloneGrade);
    next[i].enabled = next[i].enabled === false ? true : false;
    onLayers(next, true);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {layers.map((g, i) => (
          <button key={i} className="btn small" aria-pressed={g.enabled !== false}
            style={{ opacity: g.enabled === false ? 0.45 : 1 }}
            title={g.enabled === false ? `Layer ${i + 1} is off — click to enable` : `Layer ${i + 1} is on — click to bypass`}
            onClick={() => toggle(i)}>
            <span className="h-2 w-2 rounded-full border border-[#a8a8a8]"
              style={{ background: g.enabled === false ? 'transparent' : '#E8C268' }} />
            Layer {i + 1}
          </button>
        ))}
        <span className="text-[11px] text-[#a8a8a8]">
          {layers.filter((g) => g.enabled !== false).length} of {layers.length} on
        </span>
      </div>
      <button className="btn" onClick={() => setPage('colour')}>Open Colour page</button>
      <p className="text-[11px] leading-snug text-[#a8a8a8]">
        Wheels, curves, the qualifier and the layer stack live on the Colour page — the grade itself is unchanged.
      </p>
    </div>
  );
}
