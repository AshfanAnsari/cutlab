// CutLab account deletion — Phase 3 (PLAN-PHASE3-SURFACE.md C2)
//
// POST {"action":"delete_account"} with the caller's GoTrue session
// JWT as the Bearer token deletes that caller's whole account:
//
//   1. resolve the uid from the JWT (verified against GoTrue itself)
//   2. delete every storage object under users/<uid>/ in `cutlab`
//   3. delete the caller's rows from all six cutlab_ tables
//   4. admin-delete the auth user (service role)
//
// ORDER MATTERS: phase1-migration.sql made every cutlab_ user_id a FK
// with ON DELETE SET NULL, so deleting the auth user FIRST would
// orphan the rows (user_id = NULL, invisible to everyone, never
// cleaned). The sweep therefore runs rows-and-files first and the
// login last. If a middle step fails, the response says so and the
// account still exists — the user can retry, and the retry is
// idempotent (counts simply shrink).
//
// This function deploys with "Verify JWT" ON — the opposite of
// cutlab-mcp. Here the caller IS a Supabase session, so the platform
// gateway validates the JWT before this code runs; the GoTrue lookup
// below is a second check that also yields the uid + email.
//
// All privileged access uses the runtime-injected SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY. Every query is pinned to the resolved
// uid — there is no parameter that names another account.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BUCKET = "cutlab";

const TABLES = [
  "cutlab_projects",
  "cutlab_media",
  "cutlab_jobs",
  "cutlab_commands",
  "cutlab_tokens",
  "cutlab_project_versions",
] as const;

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

// ---------------------------------------------------------------------------
// relay helpers (service role; shape mirrors cutlab-mcp)
// ---------------------------------------------------------------------------

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function storage(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/storage/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// step 1: who is calling
// ---------------------------------------------------------------------------

async function resolveUser(req: Request): Promise<{ id: string; email: string | null }> {
  const auth = req.headers.get("authorization") ?? "";
  const jwt = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!jwt) throw new HttpError(401, "missing session token — sign in and try again");
  // Ask GoTrue who this token belongs to (the token is the caller's;
  // the apikey is the service key, which GoTrue accepts for user reads).
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!r.ok) throw new HttpError(401, "session token not recognised — sign in again and retry");
  const user = (await r.json()) as { id?: string; email?: string };
  if (!user.id) throw new HttpError(401, "session token carried no user id");
  return { id: user.id, email: user.email ?? null };
}

// ---------------------------------------------------------------------------
// step 2: storage sweep (recursive listing, batched deletes)
// ---------------------------------------------------------------------------

interface StorageListEntry { name: string; id: string | null }

async function listLevel(prefix: string): Promise<StorageListEntry[]> {
  const r = await storage(`object/list/${BUCKET}`, {
    method: "POST",
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: "name", order: "asc" } }),
  });
  if (!r.ok) throw new HttpError(502, `storage listing failed at ${prefix} (${r.status})`);
  return (await r.json()) as StorageListEntry[];
}

async function collectObjects(prefix: string, depth: number, out: string[]): Promise<void> {
  const entries = await listLevel(prefix);
  for (const e of entries) {
    const path = `${prefix}/${e.name}`;
    if (e.id === null) {
      if (depth < 12) await collectObjects(path, depth + 1, out);
    } else {
      out.push(path);
    }
  }
}

async function sweepStorage(uid: string): Promise<number> {
  const paths: string[] = [];
  await collectObjects(`users/${uid}`, 0, paths);
  let deleted = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const r = await storage(`object/${BUCKET}`, {
      method: "DELETE",
      body: JSON.stringify({ prefixes: batch }),
    });
    if (!r.ok) throw new HttpError(502, `storage delete failed (${r.status}) — account not deleted, retry is safe`);
    deleted += batch.length;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// step 3: row sweep (one DELETE per table, counted via representation)
// ---------------------------------------------------------------------------

async function sweepTable(table: string, uid: string): Promise<number> {
  const r = await rest(`${table}?user_id=eq.${uid}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  if (!r.ok) {
    throw new HttpError(502, `row sweep failed on ${table} (${r.status}: ${(await r.text()).slice(0, 200)}) — account not deleted, retry is safe`);
  }
  const rows = (await r.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) ? rows.length : 0;
}

// ---------------------------------------------------------------------------
// step 4: the login itself
// ---------------------------------------------------------------------------

async function deleteAuthUser(uid: string): Promise<void> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok && r.status !== 404) {
    throw new HttpError(502, `data swept but the login delete failed (${r.status}) — contact the owner with this message`);
  }
}

// ---------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ error: "cutlab-account: POST {\"action\":\"delete_account\"} with your session token as the Bearer token" }, 405);
  }
  try {
    const body = (await req.json().catch(() => null)) as { action?: string } | null;
    if (body?.action !== "delete_account") {
      throw new HttpError(400, "unknown action — the only action is \"delete_account\"");
    }
    const user = await resolveUser(req);
    const storageObjects = await sweepStorage(user.id);
    const tables: Record<string, number> = {};
    for (const t of TABLES) tables[t] = await sweepTable(t, user.id);
    await deleteAuthUser(user.id);
    return json({ ok: true, uid: user.id, email: user.email, storageObjects, tables });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: `internal error: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
});
