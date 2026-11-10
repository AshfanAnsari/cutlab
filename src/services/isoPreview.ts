/**
 * isoPreview.ts — D1.5: which clips' isolation stems are actually
 * audible in the preview right now.
 *
 * A video clip's sound rides its picture element, so isolation needs
 * two sides to agree: the Preview mounts a hidden stem <audio> element
 * per isolated clip and registers it here once it can play; the
 * playback engine mutes the picture element's own sound ONLY for
 * clips registered here — so a stem that failed to load (project
 * opened without its local files) never leaves the preview silent.
 */

const audible = new Set<string>();

export function setStemAudible(clipId: string, on: boolean): void {
  if (on) audible.add(clipId);
  else audible.delete(clipId);
}

export function stemAudible(clipId: string): boolean {
  return audible.has(clipId);
}
