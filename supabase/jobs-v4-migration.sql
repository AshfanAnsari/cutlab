-- CutLab jobs v4 — project version history (DaVinci-gaps D2.6).
-- Run in the Supabase dashboard SQL editor (project hjdyvaetxhvxzgsdlibt),
-- same pattern as jobs-v2/jobs-v3. DO NOT run as part of the client
-- build: until this runs, the worker's snapshot poller simply finds no
-- table and skips (it treats a missing table as "not deployed yet") —
-- that ordering is deliberate (code first, migration at deploy).
--
-- What changes:
--   new table cutlab_project_versions — one row per saved state of a
--   cloud project. The WORKER writes these (service role): its poll
--   loop watches cutlab_projects.updated_at and snapshots the project
--   JSON whenever it changes, so history exists even though saves are
--   client-side. The app (publishable key) reads them for a future
--   history/restore UI; restore itself is a client-side load of the
--   stored JSON.
--
-- Retention: the worker keeps at most 50 versions per project
-- (oldest pruned on insert) — the shared free-tier database is
-- 500 MB for everything, versions are a safety net, not an archive.

create table if not exists public.cutlab_project_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cutlab_projects(id) on delete cascade,
  project jsonb not null,
  -- The cutlab_projects.updated_at this snapshot was taken from; the
  -- worker dedupes on it (one version per saved state).
  source_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (project_id, source_updated_at)
);

create index if not exists cutlab_project_versions_project_idx
  on public.cutlab_project_versions (project_id, created_at desc);

alter table public.cutlab_project_versions enable row level security;

-- Same trust posture as the other cutlab_ tables (migration.sql): the
-- publishable key may read/write these rows; the worker's secret key
-- bypasses RLS regardless.
drop policy if exists cutlab_project_versions_anon_all on public.cutlab_project_versions;
create policy cutlab_project_versions_anon_all on public.cutlab_project_versions
  for all to anon using (true) with check (true);
