-- CutLab relay schema for the shared Supabase project (ref hjdyvaetxhvxzgsdlibt).
-- Everything is cutlab_ prefixed so it never touches the Our Study Home tables
-- (profiles, user_data, wall_messages). Run once in the dashboard SQL editor.
-- The browser app uses the publishable key, so the cutlab_ tables carry RLS with
-- anon policies scoped to these tables only. The server worker uses the secret
-- key, which bypasses RLS. Tighten the anon policies when app auth lands.

create table if not exists public.cutlab_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled project',
  project jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cutlab_media (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.cutlab_projects(id) on delete cascade,
  asset_id text not null,
  src text not null,
  kind text not null check (kind in ('video', 'audio', 'image')),
  input_path text,
  proxy_path text,
  thumb_path text,
  peaks_path text,
  created_at timestamptz not null default now(),
  unique (project_id, asset_id)
);

create table if not exists public.cutlab_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('media-analysis', 'render')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  project_id uuid references public.cutlab_projects(id) on delete set null,
  payload jsonb not null,
  result jsonb,
  error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  claimed_at timestamptz,
  heartbeat_at timestamptz
);

create index if not exists cutlab_jobs_queue_idx
  on public.cutlab_jobs (status, created_at);

alter table public.cutlab_projects enable row level security;
alter table public.cutlab_media enable row level security;
alter table public.cutlab_jobs enable row level security;

-- Single-user tool policies: the publishable key may work with cutlab_ tables
-- only. Study Home tables keep their own existing policies, untouched here.
drop policy if exists cutlab_projects_anon_all on public.cutlab_projects;
create policy cutlab_projects_anon_all on public.cutlab_projects
  for all to anon using (true) with check (true);

drop policy if exists cutlab_media_anon_all on public.cutlab_media;
create policy cutlab_media_anon_all on public.cutlab_media
  for all to anon using (true) with check (true);

drop policy if exists cutlab_jobs_anon_all on public.cutlab_jobs;
create policy cutlab_jobs_anon_all on public.cutlab_jobs
  for all to anon using (true) with check (true);

-- Storage bucket is created through the Storage API, not here.
-- Bucket id: cutlab (private). Path conventions:
--   jobs/<job_id>/input/<src>        originals in transit for one job
--   jobs/<job_id>/output/<file>      results pack members / rendered mp4
--   projects/<project_id>/proxies/<file>   proxies kept while a project is active
-- Delete a job's input/ and output/ copies once the app has the results.
