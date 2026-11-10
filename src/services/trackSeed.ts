// Track seed arming (D1.3c): the Inspector arms the stage with the clip
// being tracked; Preview's overlay lets the user drag the seed box on
// the frame and fires onSeed with canvas fractions. One-shot: firing or
// disarming clears it. Same singleton shape as services/qualifier.ts.
import type { TrackSeedBox } from './analysisJobs';

export interface TrackSeedArm {
  clipId: string;
  /** Clip-local seconds the seed frame sits at (from the playhead). */
  seedClipT: number;
  onSeed: (box: TrackSeedBox) => void;
}

let current: TrackSeedArm | null = null;
const subs = new Set<() => void>();
function notify() { for (const fn of subs) fn(); }

export const trackSeed = {
  get(): TrackSeedArm | null { return current; },
  arm(next: TrackSeedArm) { current = next; notify(); },
  disarm() { if (current) { current = null; notify(); } },
  fire(box: TrackSeedBox) {
    const a = current;
    current = null;
    notify();
    a?.onSeed(box);
  },
  subscribe(fn: () => void): () => void {
    subs.add(fn);
    return () => { subs.delete(fn); };
  },
};
