// Angle-cut flash (D1.4): after a number-key angle cut, the new
// segment's edge flashes once (150 ms). A nonce-carrying singleton the
// Timeline + preview angle strip subscribe to; the nonce makes repeat
// cuts to the same clip re-fire the animation.
let state: { clipId: string; nonce: number } | null = null;
const subs = new Set<() => void>();

export const angleFlash = {
  get(): { clipId: string; nonce: number } | null { return state; },
  fire(clipId: string) {
    state = { clipId, nonce: (state?.nonce ?? 0) + 1 };
    for (const fn of subs) fn();
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => { subs.delete(fn); };
  },
};
