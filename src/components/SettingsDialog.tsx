import { useState } from 'react';
import { store } from '../state/store';
import { loadSettings, saveSettings, type CutlabSettings } from '../services/settings';
import { mediaStore, unregisterMedia } from '../services/mediaStore';
import {
  generateByoToken, loadByoToken, registerByoToken, revokeByoToken, saveByoToken, verifyByoToken, type ByoStatus,
} from '../services/byoClaude';
import type { TransitionType } from '../types';
import Switch from './Switch';
import SegmentedToggle from './SegmentedToggle';

/**
 * Settings dialog — extracted from TopBar (FIX D) so the SAME surface
 * opens from the editor's menus/avatar and from Home's workspace rail.
 * It owns its draft: opening always starts from loadSettings(), Save
 * writes through saveSettings, Cancel discards. Connections applies
 * immediately and never rode the draft flow (see below).
 */

const TRANSITION_OPTIONS: TransitionType[] = ['cut', 'dissolve', 'flash', 'glare', 'slide', 'shake', 'blur-pulse', 'zoom', 'flip', 'invert-flash', 'mask-wipe'];

/** Settings → Connections (parked-features plan, Feature 1 §7): the
 *  bring-your-own-Claude token. The token lives only in this browser's
 *  local storage; Verify checks its hash against the relay registry; the
 *  raw token is never written into a project file. Applies immediately —
 *  it does not ride the Settings draft/Save flow. */
function ConnectionsSection() {
  const [token, setToken] = useState(() => loadByoToken());
  const [status, setStatus] = useState<ByoStatus>(() => (loadByoToken() ? 'unknown' : 'unset'));
  const [busy, setBusy] = useState(false);
  const [justConnected, setJustConnected] = useState(false);
  const [note, setNote] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'done' | 'failed'>('idle');

  async function verify(value: string) {
    saveByoToken(value.trim());
    setBusy(true);
    setNote('');
    const s = await verifyByoToken();
    setStatus(s);
    setBusy(false);
    if (s === 'connected') {
      setJustConnected(true);
      setTimeout(() => setJustConnected(false), 1000);
    } else if (s === 'revoked') {
      setNote('This token has been revoked. Generate a new one or ask for a fresh token.');
    } else if (s === 'unreachable') {
      setNote('Couldn’t reach the relay, so the token couldn’t be checked — this is a connection problem, not a problem with your token. Check the connection and verify again.');
    } else if (s === 'unknown') {
      setNote('Not recognised by the relay yet — if you generated it here, its hash still needs registering on the server.');
    }
  }

  /** Copy the token from state (never the masked input's DOM value).
   *  Async clipboard API first; a temporary-textarea execCommand copy
   *  is the fallback for contexts where that API is unavailable. */
  async function copyToken() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(token);
      ok = true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = token;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch { ok = false; }
    }
    setCopyState(ok ? 'done' : 'failed');
    if (!ok) setNote('Copy failed — select and copy manually');
    setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <div className="border-t border-[#3a3a3a] pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="panel-title">Connections</div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            status === 'connected'
              ? `border-[#3f6212] bg-[#1d2a10] text-[#a3d635] ${justConnected ? 'cl-chip-pulse' : ''}`
              : 'border-[#3a3a3a] bg-[#2a2a2a] text-[#a8a8a8]'
          }`}
        >
          {status === 'connected' ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <p className="mb-2 text-[12px] leading-snug text-[#a8a8a8]">
        Bring your own Muse: paste the personal connect token the assistant
        issued you, or generate one here and share its hash for registration.
        The token is scoped to your own projects and travels through the
        relay only — never into a project file. It covers BOTH kinds of
        help: prompt edits in your own chat, and rendering — queue a render
        with "My Muse" in Export and your Muse renders it on its own
        machine with this same token.
      </p>
      <label className="flex items-center justify-between gap-2">
        <span>Personal connect token</span>
        <div className="flex items-center gap-2">
          <input
            type="password"
            className="field"
            style={{ width: 168 }}
            placeholder="clt_…"
            value={token}
            onChange={(e) => { setToken(e.target.value); setStatus(e.target.value ? 'unknown' : 'unset'); setCopyState('idle'); }}
          />
          <button type="button" className="btn small" disabled={busy || !token.trim()} onClick={() => void copyToken()}>
            {copyState === 'done' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
          </button>
        </div>
      </label>
      {note && <p className="pt-1.5 text-[11px] leading-snug text-[#c9a227]">{note}</p>}
      <div className="flex gap-2 pt-2">
        <button className="btn small" disabled={busy || !token.trim()} onClick={() => void verify(token)}>
          {busy ? 'Verifying…' : 'Verify'}
        </button>
        <button
          className="btn small"
          onClick={() => {
            const t = generateByoToken();
            setToken(t);
            setCopyState('idle');
            setStatus('unknown');
            setNote('New token generated and saved in this browser.');
            // Signed in, the hash registers under the account in the
            // same step and Verify can find it straight away.
            void registerByoToken(t).then(() => verify(t));
          }}
        >
          Generate new token
        </button>
        <button
          className="btn small"
          disabled={busy || status !== 'connected'}
          onClick={async () => {
            setBusy(true);
            const ok = await revokeByoToken();
            setBusy(false);
            if (ok) { setStatus('revoked'); setNote('Token revoked — the relay will refuse it from now on.'); }
            else setNote('Revoke did not go through. Check the connection and try again.');
          }}
        >
          Revoke
        </button>
      </div>
    </div>
  );
}
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<CutlabSettings>(() => loadSettings());

  const clearMediaCache = async () => {
    const recs = await mediaStore.all();
    for (const r of recs) {
      await mediaStore.remove(r.meta.id);
      unregisterMedia(r.meta.id);
    }
    onClose();
    store.toastMsg('info', `Local media cache cleared (${recs.length} file(s)). Project clips that used them now show as not imported — re-import to rebind.`);
  };

  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="modal-panel w-[440px] max-w-[92vw]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
          <span className="text-[18px] font-semibold">Settings</span>
          <button className="btn icon" onClick={onClose}>×</button>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3 text-[13px]">
          <div className="panel-title">Defaults for new work</div>
          <div className="flex items-center justify-between gap-2">
            <span>Timeline snapping on at start</span>
            <Switch checked={draft.snapDefault} ariaLabel="Timeline snapping on at start"
              onChange={(v) => setDraft({ ...draft, snapDefault: v })} />
          </div>
          <div>
            <span className="block pb-1.5">New project canvas</span>
            <SegmentedToggle
              stretch
              ariaLabel="New project canvas"
              value={draft.defaultCanvas}
              onChange={(v) => setDraft({ ...draft, defaultCanvas: v as CutlabSettings['defaultCanvas'] })}
              options={[
                { value: '9:16', label: '9:16', sub: '720×1280' },
                { value: '16:9', label: '16:9', sub: '1280×720' },
                { value: '1:1', label: '1:1', sub: '960×960' },
              ]}
            />
          </div>
          <label className="flex items-center justify-between gap-2">
            <span>Transition for clips added from the bin</span>
            <select className="field" value={draft.defaultTransition}
              onChange={(e) => setDraft({ ...draft, defaultTransition: e.target.value as TransitionType })}>
              {TRANSITION_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between gap-2">
            <span>Default transition duration (s)</span>
            <input type="number" className="field" style={{ width: 86 }} step={0.05} min={0.05} max={1.5}
              value={draft.defaultTransitionDur}
              onChange={(e) => setDraft({ ...draft, defaultTransitionDur: Number(e.target.value) })} />
          </label>
          <ConnectionsSection />
          <div className="border-t border-[#3a3a3a] pt-3">
            <div className="panel-title mb-1.5">Local storage</div>
            <p className="mb-2 text-[12px] leading-snug text-[#a8a8a8]">
              Originals, proxies and thumbnails are cached in this browser. Clearing the
              cache frees space; clips that used the files will show as not imported
              until you re-import them (same file names rebind automatically).
            </p>
            <button className="btn small" onClick={() => void clearMediaCache()}>Clear local media cache</button>
          </div>
          <div className="flex justify-end gap-2 border-t border-[#3a3a3a] pt-3">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={() => { saveSettings(draft); onClose(); store.toastMsg('info', 'Settings saved.'); }}>
              Save settings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
