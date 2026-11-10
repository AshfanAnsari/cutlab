import { useEffect, useState } from 'react';
import { store } from '../state/store';
import { changePassword, signOut } from '../services/auth';
import {
  deleteAccount, downloadExport, formatBytes, loadAccountSnapshot,
  type AccountSnapshot,
} from '../services/account';
import {
  loadOwnAnalyticsEvents, summariseEvents, type AnalyticsSummary,
} from '../services/analytics';

const ACTIVITY_LABELS: Record<string, string> = {
  page_view: 'Page views',
  project_created: 'Projects created',
  project_opened: 'Projects opened',
  render_queued: 'Renders queued',
  export_downloaded: 'Data exports',
  feedback_sent: 'Feedback sent',
  mcp_token_created: 'Connect tokens created',
};

/**
 * Phase 3 C1 — the Account surface. Everything shown is a live relay
 * read scoped to the signed-in user (services/account.ts): cloud
 * projects with version counts, the storage meter against the real
 * 200 MB quota, job history for both render lanes, connect-token
 * labels, the data export, password change, and account deletion
 * (C2 — the cutlab-account function does the sweep server-side).
 */
export default function AccountPanel({
  onClose, onLoadProject,
}: {
  onClose: () => void;
  onLoadProject: (id: string) => void;
}) {
  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [loadError, setLoadError] = useState('');
  const [pw, setPw] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwNote, setPwNote] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteNote, setDeleteNote] = useState('');
  const [activity, setActivity] = useState<AnalyticsSummary | null>(null);
  const [activityFailed, setActivityFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadAccountSnapshot()
      .then((s) => { if (live) setSnap(s); })
      .catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, []);

  // Your activity (EXTRAS): the user's own analytics rows for the
  // last 30 days (RLS scopes the read). Deliberately independent of
  // the snapshot load — a missing analytics table (migration not
  // deployed yet) degrades to the empty state, never an error here.
  useEffect(() => {
    let live = true;
    loadOwnAnalyticsEvents(30)
      .then((rows) => { if (live) setActivity(summariseEvents(rows, { days: 30 })); })
      .catch(() => { if (live) setActivityFailed(true); });
    return () => { live = false; };
  }, []);

  const usagePct = snap ? Math.min(100, (snap.usage.bytes / snap.usage.quotaBytes) * 100) : 0;

  return (
    <div className="modal-overlay fixed inset-0 z-40 flex items-center justify-center" onClick={onClose}>
      <div
        className="modal-panel max-h-[88vh] w-[560px] max-w-[94vw] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label="Your account"
      >
        <div className="flex items-center justify-between border-b border-[#3a3a3a] px-4 py-3">
          <span className="text-[18px] font-semibold">Your account</span>
          <button className="btn icon" onClick={onClose} aria-label="Close account panel">×</button>
        </div>

        {!snap && !loadError && (
          <p className="px-4 py-6 text-[13px] text-[#a8a8a8]">Reading your account from the relay…</p>
        )}
        {loadError && (
          <div className="px-4 py-6">
            <p className="text-[13px] text-[#ff8a7a]">Could not read your account: {loadError}</p>
            <p className="pt-2 text-[12px] text-[#a8a8a8]">Local editing is unaffected. Check the connection and open this panel again.</p>
          </div>
        )}

        {snap && (
          <div className="flex flex-col gap-5 px-4 py-4 text-[13px]">
            <section>
              <div className="panel-title mb-1.5">Signed in as</div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{snap.email}</span>
                <button
                  className="btn small"
                  onClick={() => {
                    void signOut().then(() => {
                      onClose();
                      store.toastMsg('info', 'Signed out. Local projects are untouched.');
                    });
                  }}
                >
                  Sign out
                </button>
              </div>
            </section>

            <section>
              <div className="panel-title mb-1.5">Storage</div>
              <div
                className="h-2 overflow-hidden rounded-full bg-[#333]"
                role="progressbar"
                aria-valuenow={Math.round(usagePct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Storage used"
              >
                <div
                  className="h-full"
                  style={{ width: `${usagePct}%`, background: usagePct >= 90 ? '#E31000' : '#C0C0C0' }}
                />
              </div>
              <p className="pt-1.5 text-[12px] text-[#a8a8a8]">
                {formatBytes(snap.usage.bytes)} of {formatBytes(snap.usage.quotaBytes)} used
                {' · '}{snap.usage.files} file{snap.usage.files === 1 ? '' : 's'} in your relay space.
                Single files can be up to {formatBytes(snap.usage.perFileBytes)}.
              </p>
            </section>

            <section>
              <div className="panel-title mb-1.5">Cloud projects</div>
              {snap.projects.length === 0 && (
                <p className="text-[12px] text-[#a8a8a8]">No cloud projects yet. “Save cloud” in the top bar puts the current project here.</p>
              )}
              <div className="flex flex-col gap-1.5">
                {snap.projects.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-md border border-[#3a3a3a] bg-[#262626] px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{p.name}</div>
                      <div className="font-mono text-[11px] text-[#a8a8a8]">
                        Updated {new Date(p.updatedAt).toLocaleString()}
                        {' · '}{p.versionCount} saved version{p.versionCount === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button className="btn small" onClick={() => onLoadProject(p.id)}>Open</button>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <div className="panel-title mb-1.5">Recent jobs</div>
              {snap.jobs.length === 0 && (
                <p className="text-[12px] text-[#a8a8a8]">No jobs yet. Server renders and media analyses you queue will show up here.</p>
              )}
              <div className="flex flex-col gap-1">
                {snap.jobs.map((j) => (
                  <div key={j.id} className="flex items-center gap-2 text-[12px]">
                    <span className="w-[118px] shrink-0 font-mono text-[11px] text-[#a8a8a8]">
                      {new Date(j.createdAt).toLocaleString()}
                    </span>
                    <span className="flex-1 truncate">{j.type}</span>
                    <span className="rounded-full border border-[#3a3a3a] bg-[#2a2a2a] px-2 py-0.5 text-[11px] text-[#c9c9c9]">
                      {j.execLane === 'agent' ? (j.agentBy ? `your Muse (${j.agentBy})` : 'your Muse') : 'CutLab server'}
                    </span>
                    <span style={j.status === 'failed' ? { color: '#ff8a7a' } : undefined}>{j.status}</span>
                  </div>
                ))}
              </div>
              {snap.jobs.some((j) => j.error) && (
                <p className="pt-1 text-[11px] text-[#ff8a7a]">
                  Latest failure: {snap.jobs.find((j) => j.error)?.error}
                </p>
              )}
            </section>

            <section>
              <div className="panel-title mb-1.5">Connect tokens</div>
              {snap.tokens.length === 0 && (
                <p className="text-[12px] text-[#a8a8a8]">None registered. Generate one under Settings, in the Connections section, to let your own Muse work on your projects.</p>
              )}
              {snap.tokens.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  <span className="flex-1 truncate">{t.label || 'Unlabelled token'}</span>
                  <span className="font-mono text-[11px] text-[#a8a8a8]">{new Date(t.createdAt).toLocaleDateString()}</span>
                  <span style={t.revokedAt ? { color: '#ff8a7a' } : undefined}>
                    {t.revokedAt ? 'revoked' : 'active'}
                  </span>
                </div>
              ))}
            </section>

            <section className="border-t border-[#3a3a3a] pt-3">
              <div className="panel-title mb-1.5">Your activity</div>
              {(activityFailed || !activity || activity.total === 0) && (
                <p className="text-[12px] text-[#a8a8a8]">No activity recorded yet — analytics starts counting once the migration is deployed.</p>
              )}
              {activity && activity.total > 0 && (
                <>
                  <p className="mb-2 text-[12px] text-[#a8a8a8]">
                    {activity.total} event{activity.total === 1 ? '' : 's'} in the last 30 days
                    {' · '}{activity.byEvent.page_view ?? 0} page view{(activity.byEvent.page_view ?? 0) === 1 ? '' : 's'}
                    {' · '}{activity.byEvent.render_queued ?? 0} render{(activity.byEvent.render_queued ?? 0) === 1 ? '' : 's'} queued.
                    Counts cover this account only — page names and event types, never content.
                  </p>
                  <div className="flex flex-col gap-1">
                    {activity.topEvents.slice(0, 5).map((t) => (
                      <div key={t.event} className="flex items-center gap-2 text-[12px]">
                        <span className="flex-1 truncate">{ACTIVITY_LABELS[t.event] ?? t.event}</span>
                        <span className="font-mono text-[11px] text-[#a8a8a8]">{t.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="border-t border-[#3a3a3a] pt-3">
              <div className="panel-title mb-1.5">Your data</div>
              <p className="mb-2 text-[12px] leading-snug text-[#a8a8a8]">
                Download everything the relay holds for your account: projects, the media
                manifest, job history and your connect-token labels. Token hashes are never
                included in the export.
              </p>
              <button
                className="btn small"
                disabled={exportBusy}
                onClick={async () => {
                  setExportBusy(true);
                  try {
                    await downloadExport();
                    store.toastMsg('info', 'Data export downloaded (cutlab-data-export.zip).');
                  } catch (e) {
                    store.toastMsg('error', 'Export failed — ' + (e instanceof Error ? e.message : String(e)));
                  } finally {
                    setExportBusy(false);
                  }
                }}
              >
                {exportBusy ? 'Preparing…' : 'Export my data'}
              </button>
            </section>

            <section className="border-t border-[#3a3a3a] pt-3">
              <div className="panel-title mb-1.5">Change password</div>
              <div className="flex items-center gap-2">
                <label className="sr-only" htmlFor="account-new-password">New password</label>
                <input
                  id="account-new-password"
                  type="password"
                  className="field"
                  style={{ width: 220 }}
                  placeholder="New password"
                  value={pw}
                  onChange={(e) => { setPw(e.target.value); setPwNote(''); }}
                />
                <button
                  className="btn small"
                  disabled={pwBusy || pw.length < 6}
                  onClick={async () => {
                    setPwBusy(true);
                    try {
                      await changePassword(pw);
                      setPw('');
                      setPwNote('Password changed.');
                    } catch (e) {
                      setPwNote(e instanceof Error ? e.message : String(e));
                    } finally {
                      setPwBusy(false);
                    }
                  }}
                >
                  {pwBusy ? 'Saving…' : 'Change password'}
                </button>
              </div>
              {pwNote && <p className="pt-1.5 text-[11px] text-[#c9c9c9]">{pwNote}</p>}
            </section>

            <section className="border-t border-[#5a2018] pt-3">
              <div className="panel-title mb-1.5" style={{ color: '#ff8a7a' }}>Delete account</div>
              <p className="mb-2 text-[12px] leading-snug text-[#a8a8a8]">
                Deletes your login, every cloud project, media record, job and connect token,
                and all files in your relay space. Local projects in this browser are not
                touched. This cannot be undone. Export your data first if you want a copy.
              </p>
              <label className="mb-2 block text-[12px] text-[#a8a8a8]">
                Type your email address to confirm
                <input
                  type="text"
                  className="field mt-1 block"
                  style={{ width: 260 }}
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={snap.email}
                  aria-label="Type your email address to confirm deletion"
                />
              </label>
              <button
                className="btn small"
                disabled={deleteBusy || confirmText.trim().toLowerCase() !== snap.email.toLowerCase()}
                onClick={async () => {
                  setDeleteBusy(true);
                  setDeleteNote('');
                  try {
                    const result = await deleteAccount();
                    const rows = Object.values(result.tables).reduce((a, b) => a + b, 0);
                    onClose();
                    store.toastMsg(
                      'info',
                      `Account deleted: ${result.storageObjects} file(s) and ${rows} record(s) removed. You are signed out.`,
                    );
                  } catch (e) {
                    setDeleteNote(e instanceof Error ? e.message : String(e));
                  } finally {
                    setDeleteBusy(false);
                  }
                }}
              >
                {deleteBusy ? 'Deleting…' : 'Delete my account'}
              </button>
              {deleteNote && <p className="pt-1.5 text-[11px] text-[#ff8a7a]">{deleteNote}</p>}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
