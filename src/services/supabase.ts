// Supabase relay client — the hosted meeting point between this light
// browser app and the CutLab server worker (DEPLOYMENT.md, Option B).
//
// Plain fetch against the PostgREST + Storage REST APIs; no SDK. The
// publishable key is the apikey on every call; the Authorization bearer
// is the signed-in user's JWT when a session exists (services/auth.ts
// registers the provider below), so RLS scopes every row and object to
// that user. Signed out, the bearer stays the publishable key (the anon
// role) — since the Phase-1 migration the anon role holds NO cutlab
// policies, so cloud features require sign-in while local editing,
// which never calls this module's endpoints for its own data, is
// unaffected. The secret key never appears in the app — it lives on
// the server, where the worker uses it.
//
// Contract: tables cutlab_projects / cutlab_media / cutlab_jobs /
// cutlab_commands / cutlab_tokens / cutlab_project_versions; bucket
// `cutlab`. Since Phase 1, app-written objects live under
// users/<uid>/jobs/<job_id>/… and users/<uid>/projects/<project_id>/…
// (services/relayAccess.ts builds every path); pre-Phase-1 objects keep
// their legacy jobs/… / projects/… paths, which the worker still reads
// (see supabase/phase1-migration.sql for the policy split).

export const SUPABASE_URL = 'https://hjdyvaetxhvxzgsdlibt.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_dC1gPRMT43_NsU-OjSxr_Q_dKoFRVqM';
export const RELAY_BUCKET = 'cutlab';

let authTokenProvider: (() => Promise<string | null>) | null = null;

/** services/auth.ts registers its session-token getter here (kept as a
 *  registration so this module never imports the auth module). */
export function setAuthTokenProvider(fn: () => Promise<string | null>): void {
  authTokenProvider = fn;
}

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('apikey', SUPABASE_PUBLISHABLE_KEY);
  let bearer = SUPABASE_PUBLISHABLE_KEY;
  if (authTokenProvider) {
    try {
      bearer = (await authTokenProvider()) ?? SUPABASE_PUBLISHABLE_KEY;
    } catch { /* a token-refresh hiccup must not sink the request */ }
  }
  headers.set('Authorization', `Bearer ${bearer}`);
  let res: Response;
  try {
    res = await fetch(SUPABASE_URL + path, { ...init, headers });
  } catch (e) {
    throw new Error(`Relay unreachable (${e instanceof Error ? e.message : String(e)}). Check the network connection.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Relay request failed (${res.status}) on ${path.split('?')[0]} — ${body.slice(0, 300)}`);
  }
  return res;
}

/** GET rows from a PostgREST table/view path (path starts with /rest/v1/). */
export async function restSelect<T>(path: string): Promise<T[]> {
  const res = await sb(path);
  return (await res.json()) as T[];
}

/** INSERT one row; returns the inserted row when the table yields one. */
export async function restInsert<T>(table: string, row: Record<string, unknown>): Promise<T | null> {
  const res = await sb(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const rows = (await res.json().catch(() => [])) as T[];
  return rows[0] ?? null;
}

/** PATCH rows matching a PostgREST path (filters in the query string);
 *  returns the updated rows (empty when the guard matched nothing). */
export async function restPatch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await sb(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  return (await res.json().catch(() => null)) as T;
}

/** INSERT … ON CONFLICT (pk) DO UPDATE — the project-save primitive. */
export async function restUpsert(table: string, row: Record<string, unknown>, onConflict: string): Promise<void> {
  await sb(`/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
}

/** Upload (create-or-replace) one object in the relay bucket. */
export async function storageUpload(path: string, blob: Blob): Promise<void> {
  await sb(`/storage/v1/object/${RELAY_BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' },
    body: blob,
  });
}

/** Download one object from the relay bucket. Throws on 404. */
export async function storageDownload(path: string): Promise<Blob> {
  const res = await sb(`/storage/v1/object/${RELAY_BUCKET}/${path}`);
  return res.blob();
}

export interface StorageEntry {
  name: string;
  /** null marks a folder entry (the list API returns folders inline). */
  id: string | null;
  metadata?: { size?: number; mimetype?: string } | null;
}

/** List one level of a bucket prefix (folders come back as entries
 *  with id null; callers recurse). The account usage meter uses this. */
export async function storageList(prefix: string, limit = 1000): Promise<StorageEntry[]> {
  const res = await sb(`/storage/v1/object/list/${RELAY_BUCKET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  });
  return (await res.json()) as StorageEntry[];
}

/** Delete objects from the relay bucket (test cleanup / job hygiene). */
export async function storageRemove(paths: string[]): Promise<void> {
  if (!paths.length) return;
  await sb(`/storage/v1/object/${RELAY_BUCKET}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  });
}
