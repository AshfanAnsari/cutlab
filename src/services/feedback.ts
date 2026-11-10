// Feedback (Phase 3 C5 — support channel).
//
// One insert into cutlab_feedback (supabase/feedback-migration.sql:
// authenticated INSERT + read-own policies; the owner reads all rows
// with the service key). Signed out, the submit refuses before any
// network call — the table takes account-scoped reports only.

import { restInsert } from './supabase';
import { requireUserId } from './relayAccess';

export type FeedbackKind = 'bug' | 'idea' | 'question' | 'other';

export const FEEDBACK_KINDS: { value: FeedbackKind; label: string }[] = [
  { value: 'bug', label: 'Something is broken' },
  { value: 'idea', label: 'An idea' },
  { value: 'question', label: 'A question' },
  { value: 'other', label: 'Something else' },
];

export const FEEDBACK_MAX_CHARS = 4000;

/** Pure validation, harness-covered. Returns a friendly error or null. */
export function validateFeedback(kind: string, message: string): string | null {
  if (!FEEDBACK_KINDS.some((k) => k.value === kind)) return 'Pick what kind of feedback this is.';
  const text = message.trim();
  if (text.length < 3) return 'Write a few words so the report means something.';
  if (text.length > FEEDBACK_MAX_CHARS) return `Keep it under ${FEEDBACK_MAX_CHARS} characters.`;
  return null;
}

export async function submitFeedback(kind: FeedbackKind, message: string, page: string): Promise<void> {
  const uid = requireUserId('send feedback');
  const problem = validateFeedback(kind, message);
  if (problem) throw new Error(problem);
  await restInsert('cutlab_feedback', {
    user_id: uid, kind, message: message.trim(), page,
  });
}
