// Relay access rules (Phase 1 — lockdown + accounts). One canonical
// home for: who may use the cloud (a signed-in user), where their
// objects live (users/<uid>/…), and the abuse caps. Every service that
// writes to the relay goes through here — no module builds a storage
// path or checks a session on its own.
//
// The numbers (chosen for the shared free tier — 1 GB bucket, 500 MB
// DB — and stated in PLAN-PUBLIC-PRODUCT Phase 1's acceptance):
//   MAX_FILE_BYTES           50 MB per object. This is also the bucket's
//                            platform file_size_limit (set by
//                            phase1-migration.sql), so the relay itself
//                            refuses bigger files even if a client lies.
//   USER_STORAGE_QUOTA_BYTES 200 MB per user, enforced at insert time
//                            by a DB trigger (phase1-migration.sql —
//                            counts the caller's objects under
//                            users/<uid>/ in storage.objects) and
//                            re-checked by the worker when a job is
//                            claimed. The client-side guard here is
//                            the per-file cap: a fast, friendly
//                            failure before any bytes move.

import { currentUserId } from './auth';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const USER_STORAGE_QUOTA_BYTES = 200 * 1024 * 1024;

/** The signed-in user's id, or a friendly refusal. Cloud features call
 *  this BEFORE touching the relay; local features never call it. */
export function requireUserId(what: string): string {
  const uid = currentUserId();
  if (!uid) {
    throw new Error(
      `Sign in to ${what} — cloud features need an account so your work stays yours. `
      + 'Your local project is untouched.',
    );
  }
  return uid;
}

/** This user's storage scope root. */
export function userPrefix(uid: string): string {
  return `users/${uid}`;
}

/** Where one job's uploads live for this user. */
export function jobInputPath(uid: string, jobId: string, name: string): string {
  return `${userPrefix(uid)}/jobs/${jobId}/input/${name}`;
}

/** The prefix the worker reports results under for this user's job. */
export function jobScopePrefix(uid: string, jobId: string): string {
  return `${userPrefix(uid)}/jobs/${jobId}`;
}

/** This user's scope for one project's published media. */
export function projectScopePrefix(uid: string, projectId: string): string {
  return `${userPrefix(uid)}/projects/${projectId}`;
}

/** Friendly per-file cap check, run before any upload starts. */
export function assertFileCap(sizeBytes: number, label: string): void {
  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(
      `"${label}" is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — the relay takes files up to `
      + `${MAX_FILE_BYTES / (1024 * 1024)} MB each. Trim or compress it and try again.`,
    );
  }
}
