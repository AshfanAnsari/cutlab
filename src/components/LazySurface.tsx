/**
 * LazySurface — the P8 lazy split's loading boundary (2026-11-06).
 *
 * Loads a component module on demand (dynamic import) and renders it
 * with the caller's props once it arrives. While the chunk is in
 * flight it fills the exact region the surface will occupy with a
 * quiet loading state in the app's language (charcoal ground, one red
 * rule, mono label) so the page grammar never jumps. A chunk that
 * fails to download gets a plain-language error with a Retry button —
 * never a white screen, and the project in the store is untouched by
 * a loading failure.
 *
 * Loaded components are cached by label at module level: leaving a
 * page and coming back renders synchronously, no second skeleton.
 */
import { useEffect, useRef, useState, type ComponentType } from 'react';

type LoadState<P> =
  | { status: 'loading' }
  | { status: 'ready'; C: ComponentType<P> }
  | { status: 'error' };

const cache = new Map<string, ComponentType<never>>();

function LoadingBody({ label, note }: { label: string; note: string }) {
  return (
    <>
      <span aria-hidden className="h-[3px] w-10 rounded-full bg-[#e31000] animate-pulse motion-reduce:animate-none" />
      <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#c0c0c0]">
        Loading {label}
      </div>
      <div className="text-[12px] text-[#8a8a8a]">{note}</div>
    </>
  );
}

export default function LazySurface<P extends object>({
  load,
  label,
  variant = 'fill',
  ...rest
}: {
  load: () => Promise<{ default: ComponentType<P> }>;
  label: string;
  variant?: 'fill' | 'overlay';
} & P) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState<P>>(() => {
    const C = cache.get(label);
    return C ? { status: 'ready', C: C as ComponentType<P> } : { status: 'loading' };
  });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (cache.has(label)) return;
    let live = true;
    setState({ status: 'loading' });
    loadRef.current()
      .then((m) => {
        cache.set(label, m.default as ComponentType<never>);
        if (live) setState({ status: 'ready', C: m.default });
      })
      .catch(() => {
        if (live) setState({ status: 'error' });
      });
    return () => {
      live = false;
    };
  }, [attempt, label]);

  if (state.status === 'ready') {
    const C = state.C;
    return <C {...(rest as P)} />;
  }

  if (variant === 'overlay') {
    return (
      <div className="modal-overlay fixed inset-0 z-50 flex items-center justify-center px-4">
        <div
          className="modal-panel flex w-[320px] flex-col items-center gap-3 px-6 py-8 text-center"
          role={state.status === 'error' ? 'alert' : 'status'}
        >
          {state.status === 'error' ? (
            <>
              <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#e31000]">
                Couldn’t load {label}
              </div>
              <p className="text-[13px] leading-relaxed text-[#c0c0c0]">
                It failed to download — check your connection and try again.
              </p>
              <button type="button" className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
                Retry
              </button>
            </>
          ) : (
            <LoadingBody label={label} note="Fetching it now…" />
          )}
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[#161616] px-6 text-center"
        role="alert"
      >
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#e31000]">
          Couldn’t load {label}
        </div>
        <p className="max-w-[400px] text-[13px] leading-relaxed text-[#c0c0c0]">
          That part of the editor failed to download — check your connection and try again.
          Your project is untouched.
        </p>
        <button type="button" className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[#161616]"
      role="status"
      aria-label={`Loading ${label}`}
    >
      <LoadingBody label={label} note="Fetching that part of the editor…" />
    </div>
  );
}
