import type { Project } from '../types';

/**
 * UI redesign W1 rider: parse a prompt-edit revised project. The worker
 * uploads the bare project, but legacy artefacts may still be the envelope
 * shape { project, summary, lane } — accept both, so no stored or
 * in-flight artefact of the old shape can ever reject an edit again.
 */
export function parseRevisedProject(text: string): Project {
  const parsed = JSON.parse(text) as Project | { project: Project };
  return ((parsed as { project?: Project }).project ?? parsed) as Project;
}
