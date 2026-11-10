import { useState } from 'react';
import { store } from '../state/store';
import { FEEDBACK_KINDS, FEEDBACK_MAX_CHARS, submitFeedback, type FeedbackKind } from '../services/feedback';

/**
 * Phase 3 C5 — the in-app feedback channel. Writes one row to
 * cutlab_feedback under the sender's account (services/feedback.ts);
 * the owner reads reports from the relay. Signed-in only: the TopBar
 * renders this entry point inside the account cluster.
 */
export default function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div
        className="modal-panel w-[440px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label="Send feedback"
      >
        <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
          <span className="text-[18px] font-semibold">Send feedback</span>
          <button className="btn icon" onClick={onClose} aria-label="Close feedback dialog">×</button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
          <label className="flex items-center justify-between gap-2">
            <span>What is this about?</span>
            <select
              className="field"
              value={kind}
              onChange={(e) => setKind(e.target.value as FeedbackKind)}
              aria-label="Feedback kind"
            >
              {FEEDBACK_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block">Your message</span>
            <textarea
              className="field w-full"
              rows={5}
              maxLength={FEEDBACK_MAX_CHARS}
              value={message}
              onChange={(e) => { setMessage(e.target.value); setNote(''); }}
              placeholder="What happened, or what would help? Steps to reproduce a bug are gold."
              aria-label="Feedback message"
            />
          </label>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] text-[#a8a8a8]">{message.length}/{FEEDBACK_MAX_CHARS}</span>
            {note && <span className="text-[11px] text-[#ff8a7a]">{note}</span>}
          </div>
          {/* FIX B1 #18: the ≥3-character rule existed in validateFeedback
              but was never stated — the Send button just stayed disabled. */}
          {message.trim().length < 3 && (
            <p className="-mt-1.5 text-[11px] leading-snug text-[#a8a8a8]">Write at least 3 characters — a few words so the report means something.</p>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || message.trim().length < 3}
              onClick={async () => {
                setBusy(true);
                try {
                  await submitFeedback(kind, message, 'editor');
                  onClose();
                  store.toastMsg('info', 'Feedback sent. Thank you — the owner reads every report.');
                } catch (e) {
                  setNote(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Sending…' : 'Send feedback'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
