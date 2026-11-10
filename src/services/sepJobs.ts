/**
 * sepJobs.ts — D1.5 voice-isolation job state, per clip.
 *
 * The separate (demucs) run takes ~a minute on the worker; the timeline
 * chip and the Inspector button both read this map so the user sees
 * queued -> working -> ready/failed without either component owning
 * the job. Terminal states are cleared by the consumer once the
 * clip's audioOverride lands (ready) or after the failure toast.
 */

export type SepStatus = 'queued' | 'working' | 'ready' | 'failed';

const statuses = new Map<string, SepStatus>();
const subs = new Set<() => void>();

export function getSepStatus(clipId: string): SepStatus | undefined {
  return statuses.get(clipId);
}

export function setSepStatus(clipId: string, status: SepStatus | undefined): void {
  if (status === undefined) statuses.delete(clipId);
  else statuses.set(clipId, status);
  subs.forEach((fn) => fn());
}

export function subscribeSepStatus(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
