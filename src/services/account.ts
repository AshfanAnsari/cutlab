// Account data service (Phase 3, PLAN-PHASE3-SURFACE.md C1).
//
// Everything the TopBar Account surface shows comes from here; the
// component renders, this module talks to the relay. All reads ride
// the signed-in user's JWT (services/supabase.ts), so RLS scopes every
// row and object to the caller — there is no parameter that widens
// that, and requireUserId refuses before any network call when signed
// out.
//
// Quota numbers are REAL relay reads: the footprint is the sum of the
// object sizes under the caller's users/<uid>/ storage scope (the
// listing the DB quota trigger counts too), against the 200 MB
// working quota from services/relayAccess.ts. Media published for the
// owner's pre-Phase-1 projects lives under the legacy projects/<pid>/
// scope and is NOT in that prefix; the export manifest lists those
// rows (cutlab_media) so nothing the account owns is invisible.

import JSZip from 'jszip';
import { restSelect, storageList, SUPABASE_URL, type StorageEntry } from './supabase';
import { currentSession, setSession } from './auth';
import { requireUserId, USER_STORAGE_QUOTA_BYTES, MAX_FILE_BYTES } from './relayAccess';
import { downloadBlob } from './projectIO';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface AccountProject {
  id: string;
  name: string;
  updatedAt: string;
  versionCount: number;
}

export interface StorageUsage {
  bytes: number;
  files: number;
  quotaBytes: number;
  perFileBytes: number;
}

export interface AccountJob {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  execLane: 'server' | 'agent';
  agentBy?: string;
  error?: string;
}

export interface AccountToken {
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface AccountSnapshot {
  email: string;
  projects: AccountProject[];
  usage: StorageUsage;
  jobs: AccountJob[];
  tokens: AccountToken[];
}

// ---------------------------------------------------------------------------
// Pure helpers (harness-covered)
// ---------------------------------------------------------------------------

/** "1.9 MB" / "812 KB" / "0 B" — the one formatter for account sizes. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${Number.isInteger(v) || v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Sum one listing level: file entries carry their size; folders don't. */
export function sumEntries(entries: StorageEntry[]): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const e of entries) {
    if (e.id === null) continue; // folder entry
    files += 1;
    bytes += e.metadata?.size ?? 0;
  }
  return { bytes, files };
}

/** Group version rows by project id (the version-count join, client side). */
export function countVersionsByProject(rows: { project_id: string }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.project_id, (out.get(r.project_id) ?? 0) + 1);
  return out;
}

/** The execution lane of a job payload (Phase 2 rule: absent = server). */
export function jobLaneOf(payload: Record<string, unknown> | null | undefined): 'server' | 'agent' {
  return payload?.execLane === 'agent' ? 'agent' : 'server';
}

// ---------------------------------------------------------------------------
// Relay reads
// ---------------------------------------------------------------------------

export async function listAccountProjects(): Promise<AccountProject[]> {
  requireUserId('view your account');
  const [projects, versions] = await Promise.all([
    restSelect<{ id: string; name: string; updated_at: string }>(
      '/rest/v1/cutlab_projects?select=id,name,updated_at&order=updated_at.desc&limit=50',
    ),
    restSelect<{ project_id: string }>(
      '/rest/v1/cutlab_project_versions?select=project_id&limit=5000',
    ).catch(() => [] as { project_id: string }[]), // pre-v4 relay: no history yet
  ]);
  const counts = countVersionsByProject(versions);
  return projects.map((p) => ({
    id: p.id, name: p.name, updatedAt: p.updated_at,
    versionCount: counts.get(p.id) ?? 0,
  }));
}

/** Recursive footprint of the caller's storage scope. Depth-capped and
 *  page-capped so a pathological tree degrades to a partial total
 *  instead of an unbounded walk. */
export async function getStorageUsage(): Promise<StorageUsage> {
  const uid = requireUserId('measure your storage');
  const root = `users/${uid}`;
  let bytes = 0;
  let files = 0;
  const queue: { prefix: string; depth: number }[] = [{ prefix: root, depth: 0 }];
  while (queue.length) {
    const { prefix, depth } = queue.shift()!;
    const entries = await storageList(prefix);
    const sums = sumEntries(entries);
    bytes += sums.bytes;
    files += sums.files;
    if (depth < 8) {
      for (const e of entries) {
        if (e.id === null) queue.push({ prefix: `${prefix}/${e.name}`, depth: depth + 1 });
      }
    }
  }
  return { bytes, files, quotaBytes: USER_STORAGE_QUOTA_BYTES, perFileBytes: MAX_FILE_BYTES };
}

export async function listAccountJobs(limit = 30): Promise<AccountJob[]> {
  requireUserId('view your jobs');
  const rows = await restSelect<{
    id: string; type: string; status: string; created_at: string;
    payload: Record<string, unknown> | null; error: string | null;
  }>(`/rest/v1/cutlab_jobs?select=id,type,status,created_at,payload,error&order=created_at.desc&limit=${limit}`);
  return rows.map((r) => ({
    id: r.id, type: r.type, status: r.status, createdAt: r.created_at,
    execLane: jobLaneOf(r.payload),
    agentBy: (r.payload?.agentClaim as { by?: string } | undefined)?.by,
    error: r.error ?? undefined,
  }));
}

/** Connect tokens for the export + account view: LABELS AND DATES
 *  ONLY. The token_hash column is never selected here — an export must
 *  not become a credential leak. */
export async function listAccountTokens(): Promise<AccountToken[]> {
  requireUserId('view your connect tokens');
  const rows = await restSelect<{ label: string | null; created_at: string; revoked_at: string | null }>(
    '/rest/v1/cutlab_tokens?select=label,created_at,revoked_at&order=created_at.desc&limit=100',
  );
  return rows.map((r) => ({ label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at }));
}

export async function loadAccountSnapshot(): Promise<AccountSnapshot> {
  const session = currentSession();
  if (!session) throw new Error('Sign in to view your account.');
  const [projects, usage, jobs, tokens] = await Promise.all([
    listAccountProjects(), getStorageUsage(), listAccountJobs(), listAccountTokens(),
  ]);
  return { email: session.user.email, projects, usage, jobs, tokens };
}

// ---------------------------------------------------------------------------
// Export my data
// ---------------------------------------------------------------------------

export interface ExportData {
  exportedAt: string;
  account: { id: string; email: string };
  projects: unknown[];
  mediaManifest: unknown[];
  jobs: unknown[];
  connectTokens: AccountToken[];
}

/** Assemble everything the relay holds for this account. Refuses
 *  (via requireUserId) BEFORE any fetch while signed out. */
export async function buildExportData(): Promise<ExportData> {
  const uid = requireUserId('export your data');
  const session = currentSession()!;
  const [projects, mediaManifest, jobs, connectTokens] = await Promise.all([
    restSelect<Record<string, unknown>>(
      '/rest/v1/cutlab_projects?select=id,name,project,created_at,updated_at&order=updated_at.desc&limit=200',
    ),
    restSelect<Record<string, unknown>>(
      '/rest/v1/cutlab_media?select=id,project_id,asset_id,src,kind,input_path,proxy_path,thumb_path,peaks_path,created_at&order=created_at.asc&limit=2000',
    ),
    restSelect<Record<string, unknown>>(
      '/rest/v1/cutlab_jobs?select=id,type,status,project_id,payload,result,error,created_at,updated_at&order=created_at.desc&limit=500',
    ),
    listAccountTokens(),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    account: { id: uid, email: session.user.email },
    projects, mediaManifest, jobs, connectTokens,
  };
}

/** Download the export as one zip (projects, media manifest, jobs,
 *  token labels) with a README that says what each file is. */
export async function downloadExport(): Promise<void> {
  const data = await buildExportData();
  const zip = new JSZip();
  zip.file('README.txt',
    'CutLab data export\n'
    + `Exported: ${data.exportedAt}\nAccount: ${data.account.email}\n\n`
    + 'projects.json       — your cloud projects, full JSON, the same shape the editor opens.\n'
    + 'media-manifest.json — every media asset the relay tracks for you, with its storage paths.\n'
    + '                      (Originals you uploaded for jobs are listed by path; download them\n'
    + '                      from the app while signed in. Project files themselves are above.)\n'
    + 'jobs.json           — your job history: server renders, analyses and agent renders.\n'
    + 'connect-tokens.json — your connect tokens by label and date. Hashes are never exported.\n');
  zip.file('projects.json', JSON.stringify(data.projects, null, 2));
  zip.file('media-manifest.json', JSON.stringify(data.mediaManifest, null, 2));
  zip.file('jobs.json', JSON.stringify(data.jobs, null, 2));
  zip.file('connect-tokens.json', JSON.stringify(data.connectTokens, null, 2));
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, 'cutlab-data-export.zip');
}

// ---------------------------------------------------------------------------
// Delete account (Phase 3 C2 — the cutlab-account Edge Function)
// ---------------------------------------------------------------------------

export interface DeleteAccountResult {
  storageObjects: number;
  tables: Record<string, number>;
}

/** Ask the cutlab-account function to delete this account: storage
 *  sweep, row sweep, then the login itself. On success the local
 *  session is cleared (the account it belonged to no longer exists).
 *  A function that is not deployed yet answers 404 — reported plainly. */
export async function deleteAccount(): Promise<DeleteAccountResult> {
  const session = currentSession();
  if (!session) throw new Error('Sign in first — account deletion needs your session.');
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/cutlab-account`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'delete_account' }),
    });
  } catch (e) {
    throw new Error(`Account service unreachable (${e instanceof Error ? e.message : String(e)}). Nothing was deleted.`);
  }
  if (res.status === 404) {
    throw new Error('Account deletion is not switched on yet on the server. Nothing was deleted — contact the owner.');
  }
  const data = (await res.json().catch(() => null)) as
    | { storageObjects?: number; tables?: Record<string, number>; error?: string }
    | null;
  if (!res.ok) throw new Error(data?.error ?? `Deletion failed (${res.status}). Nothing was confirmed deleted.`);
  setSession(null);
  return { storageObjects: data?.storageObjects ?? 0, tables: data?.tables ?? {} };
}
