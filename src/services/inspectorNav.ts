// One-shot navigation requests INTO the Inspector rail (FIX C).
//
// Help → Keyboard shortcuts (TopBar) needs to land the user on the
// Inspector's shortcuts disclosure, open. The rail may not be mounted
// yet (Prompt tab active, panel collapsed, phone zone elsewhere), so
// the request is a sticky one-shot flag plus a live notification:
// whoever mounts next consumes the flag in its initial state, and
// whoever is already mounted hears the notification directly. Same
// tiny-external-store shape as services/scopesDock.ts.

let pending = false;
const listeners = new Set<() => void>();

export function requestShortcutsOpen(): void {
  pending = true;
  for (const fn of [...listeners]) fn();
}

/** Read-and-clear the pending request (mount-time initial state). */
export function consumeShortcutsOpenRequest(): boolean {
  const v = pending;
  pending = false;
  return v;
}

export function subscribeShortcutsOpen(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// FIX D: Home's Resize-canvas tile needs the Project settings
// disclosure (which holds the canvas fields) to land OPEN — same
// one-shot shape as the shortcuts request above, separate flag.
let pendingProjectSettings = false;
const projectSettingsListeners = new Set<() => void>();

export function requestProjectSettingsOpen(): void {
  pendingProjectSettings = true;
  for (const fn of [...projectSettingsListeners]) fn();
}

/** Read-and-clear the pending request (mount-time initial state). */
export function consumeProjectSettingsOpenRequest(): boolean {
  const v = pendingProjectSettings;
  pendingProjectSettings = false;
  return v;
}

export function subscribeProjectSettingsOpen(fn: () => void): () => void {
  projectSettingsListeners.add(fn);
  return () => {
    projectSettingsListeners.delete(fn);
  };
}
