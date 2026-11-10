// Payload + result contracts for the two v3 job types (parked-features
// plan). Kept beside jobs.ts so both lanes share one definition; the
// Supabase lane implements them, the file-bundle lane cannot (a prompt edit
// needs the always-on worker, and replication needs the relay round-trip).

import type { Project } from '../types';

/** Inline project JSON rides in the payload — no media upload needed; the
 *  result is a revised project JSON written by the worker. */
export interface PromptEditPayload {
  version: 1;
  type: 'prompt_edit';
  instruction: string;
  project: Project;
  /** SHA-256 of the user's BYO Claude token, when one is set. The worker
   *  refuses the job if a presented hash is unknown or revoked. */
  tokenHash?: string;
}

export interface PromptEditResult {
  /** LLM's one-paragraph account of what it changed (headline only — the
   *  Prompt tab's rows come from a client-side diff). */
  summary: string;
  /** Storage path of the revised project JSON (users/<uid>/jobs/<id>/output/revised.json). */
  revised: string;
  /** Which LLM lane served the job (freellmapi / nvidia), for the log. */
  lane?: string;
}

export interface ReplicatePayload {
  version: 1;
  type: 'replicate_analyse';
  /** Storage paths (relative to the cutlab bucket) of the uploaded
   *  reference video and the raw clips, uploaded before the job row. */
  reference: string;
  raws: string[];
}

export interface ReplicateSpecSegment {
  start: number;
  end: number;
  cutType: 'cut' | 'dissolve' | 'other';
  captionText: string | null;
  captionStart: number | null;
  captionEnd: number | null;
  styleNote: string;
}

export interface ReplicateSpec {
  duration: number;
  width: number;
  height: number;
  segments: ReplicateSpecSegment[];
  bpm: number | null;
  /** Beat times in seconds — become markers in the built project. */
  beats: number[];
  /** Per-cue caption text with timing, when the reference has speech. */
  captions: { start: number; end: number; text: string }[];
}

export interface ReplicateResult {
  /** Storage path of spec.json (users/<uid>/jobs/<id>/output/spec.json). */
  spec: string;
  cuts: number;
  bpm: number | null;
}
