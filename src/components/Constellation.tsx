import { useEffect, useRef } from 'react';

/**
 * CONSTELLATION — the drifting-dot field (UI ADOPTION 2026-11-06,
 * studied from the remake's InteractiveBackdrop; this is the
 * restrained in-app cut, code ours). Silver keyframe dots drift
 * slowly, faint hairlines join near neighbours, ~1 in 10 dots is
 * Signal Red. Built for small brand zones (the workspace Home
 * headline), NOT as a full-screen effect: low counts, capped DPR,
 * the loop pauses while the tab is hidden, and under
 * prefers-reduced-motion it paints ONE static frame and stops.
 * Pointer-transparent and aria-hidden — pure motif.
 */
export default function Constellation({ className = '' }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let running = false;
    let w = 0;
    let h = 0;
    interface Dot { x: number; y: number; vx: number; vy: number; size: number; alpha: number; red: boolean }
    let dots: Dot[] = [];

    const seed = () => {
      const count = Math.max(8, Math.min(26, Math.floor(w / 44)));
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.36,
        vy: (Math.random() - 0.5) * 0.36,
        size: Math.random() < 0.15 ? 2.6 : 1.4,
        alpha: Math.random() * 0.3 + 0.12,
        red: Math.random() < 0.1,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < dots.length; i++) {
        const p = dots[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.red ? `rgba(227,16,0,${p.alpha})` : `rgba(236,236,236,${p.alpha})`;
        ctx.fill();
        for (let j = i + 1; j < dots.length; j++) {
          const q = dots[j];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const d = Math.hypot(dx, dy);
          if (d < 100) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.strokeStyle = p.red || q.red
              ? `rgba(227,16,0,${0.12 * (1 - d / 100)})`
              : `rgba(168,168,168,${0.09 * (1 - d / 100)})`;
            ctx.lineWidth = 0.75;
            ctx.stroke();
          }
        }
      }
    };

    const step = () => {
      for (const p of dots) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0) p.x = w;
        if (p.x > w) p.x = 0;
        if (p.y < 0) p.y = h;
        if (p.y > h) p.y = 0;
      }
      draw();
      raf = requestAnimationFrame(step);
    };

    const start = () => {
      if (running || reduced) return;
      running = true;
      raf = requestAnimationFrame(step);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      draw();
    };

    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };

    resize();
    if (reduced) draw();
    else start();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden className={`pointer-events-none ${className}`} />;
}
