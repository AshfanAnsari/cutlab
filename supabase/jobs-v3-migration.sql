-- CutLab jobs v3 — the two parked features (prompt editing +
-- replicate-an-edit, PLAN-PARKED-FEATURES-DRAFT.md). Run in the Supabase
-- dashboard SQL editor (project hjdyvaetxhvxzgsdlibt), same pattern as
-- jobs-v2-migration.sql. DO NOT run as part of the client build: until
-- this runs, prompt_edit / replicate_analyse inserts are rejected by the
-- type CHECK and the app shows its error state with nothing changed —
-- that ordering is deliberate (client first, migration at deploy).
--
-- What changes:
--   cutlab_jobs.type += 'prompt_edit', 'replicate_analyse'
--   new table cutlab_tokens — the BYO-Claude registry (Feature 1 §7).
--   Only token HASHES live here; the raw token exists solely in the
--   user's browser. The worker (service role) and the app (publishable
--   key, policy below) may read; revocation is an UPDATE of revoked_at.

alter table cutlab_jobs drop constraint if exists cutlab_jobs_type_check;
alter table cutlab_jobs add constraint cutlab_jobs_type_check
  check (type in ('media-analysis', 'render', 'transcribe', 'track',
                  'separate', 'prompt_edit', 'replicate_analyse'));

create table if not exists cutlab_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  label text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

alter table cutlab_tokens enable row level security;

-- The publishable key may look a token up by hash and revoke it — the
-- same trust posture as cutlab_jobs (migration.sql): this relay is a
-- single-user meeting point, and a hash alone grants nothing without a
-- matching future job.
drop policy if exists cutlab_tokens_anon_all on cutlab_tokens;
create policy cutlab_tokens_anon_all on cutlab_tokens
  for all to anon using (true) with check (true);
