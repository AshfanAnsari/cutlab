// One-shot hand-offs INTO the Inspector rail from outside the editor
// (FIX D — Home's workspace prompt bar and quick tiles).
//
// Home's prompt bar promises "your words are waiting in the Prompt
// tab": the text travels through here as a sticky one-shot draft —
// whoever (Inspector / PromptPanel) mounts next consumes it, and
// whoever is already mounted hears the notification live. Tab-open
// requests ride the same channel as separate flags, so a draft, a
// bare Prompt-tab open, and a bare Inspector-tab open never get
// conflated. Same tiny-external-store shape as services/inspectorNav.ts.

let pendingText: string | null = null;
let pendingPromptTab = false;
let pendingInspectorTab = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

/** Prefill the Prompt tab's textarea with this text and open the tab. */
export function requestPromptDraft(text: string): void {
  pendingText = text;
  pendingPromptTab = true;
  notify();
}

/** Open the Prompt tab (no text change). */
export function requestPromptTabOpen(): void {
  pendingPromptTab = true;
  notify();
}

/** Open the Inspector tab (e.g. Resize canvas lands on Project). */
export function requestInspectorTabOpen(): void {
  pendingInspectorTab = true;
  notify();
}

/** Read-and-clear the pending draft text (PromptPanel). */
export function consumePromptDraft(): string | null {
  const v = pendingText;
  pendingText = null;
  return v;
}

/** Read-and-clear the pending Prompt-tab request (Inspector). */
export function consumePromptTabOpen(): boolean {
  const v = pendingPromptTab;
  pendingPromptTab = false;
  return v;
}

/** Read-and-clear the pending Inspector-tab request (Inspector). */
export function consumeInspectorTabOpen(): boolean {
  const v = pendingInspectorTab;
  pendingInspectorTab = false;
  return v;
}

export function subscribePromptDraft(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
