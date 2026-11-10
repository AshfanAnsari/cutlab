-- CutLab Phase 1 — lockdown + accounts (PLAN-PUBLIC-PRODUCT-DRAFT.md).
-- Run in the Supabase dashboard SQL editor (project hjdyvaetxhvxzgsdlibt),
-- same pattern as jobs-v2/v3/v4. DEPLOY ORDER MATTERS: run this FIRST,
-- then restart cutlab-worker, then redeploy the client. The Phase-1
-- client tolerates the pre-migration relay (its cloud calls fail with
-- clear errors; local editing is unaffected), and the Phase-1 worker
-- tolerates the missing columns (it reads user_id with .get() and
-- falls back to legacy paths), but the reverse order leaves a window
-- where the OLD client — which sends no JWT — is locked out by the new
-- policies while the new client is not yet live. Run it in one sitting.
--
-- What changes:
--   1. Every cutlab_ table gains user_id (references auth.users,
--      ON DELETE SET NULL — account deletion is a Phase-3 flow; for
--      now a deleted user's rows become unowned rather than blocking).
--   2. RLS flips from anon all-access to OWNER-ONLY: the anon role
--      keeps NO policies on the cutlab_ tables (the publishable key
--      alone can then do nothing — sign-in is what grants access), and
--      `authenticated` gets user_id = auth.uid() policies. The worker
--      (service role / secret key) bypasses RLS and is unaffected.
--   3. Storage: the anon policies on the `cutlab` bucket are replaced
--      with authenticated policies scoped to users/<uid>/… — plus a
--      read/write carve-out for the legacy projects/<pid>/… scope of
--      projects the caller owns, so a claimed pre-Phase-1 project
--      (the Karina demo) keeps hydrating without moving its objects.
--      Legacy jobs/… objects get no policy: they are transient.
--      Authenticated users may DELETE inside their own scope (this
--      also closes the long-standing "anon cannot delete" gap for
--      user-owned files; the worker sweep still owns legacy cleanup).
--   4. The bucket gains the platform per-file limit: 50 MB.
--   5. A BEFORE INSERT trigger on cutlab_jobs enforces the per-user
--      storage quota (200 MB of objects under users/<uid>/) at insert
--      time — inputs are uploaded BEFORE the row lands (the relay
--      protocol), so they are already counted when the trigger runs.
--   6. Existing rows keep user_id NULL (unowned, invisible to every
--      account) until the coordinator runs the CLAIM block at the
--      bottom of this file with the owner's uid.
--
-- Caps mirror src/services/relayAccess.ts and server/worker.py.

-- ------------------------------------------------------------------
-- 1. user_id columns + indexes
-- ------------------------------------------------------------------
alter table public.cutlab_projects
  add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.cutlab_media
  add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.cutlab_jobs
  add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.cutlab_commands
  add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.cutlab_tokens
  add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table public.cutlab_project_versions
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists cutlab_projects_user_idx
  on public.cutlab_projects (user_id);
create index if not exists cutlab_media_user_idx
  on public.cutlab_media (user_id);
create index if not exists cutlab_jobs_user_idx
  on public.cutlab_jobs (user_id, created_at desc);
create index if not exists cutlab_commands_user_idx
  on public.cutlab_commands (user_id);
create index if not exists cutlab_tokens_user_idx
  on public.cutlab_tokens (user_id);
create index if not exists cutlab_project_versions_user_idx
  on public.cutlab_project_versions (user_id);

-- Table privileges for the authenticated role (Supabase normally
-- grants these by default; stated so the lockdown does not depend on
-- that default having survived).
grant select, insert, update, delete on
  public.cutlab_projects, public.cutlab_media, public.cutlab_jobs,
  public.cutlab_commands, public.cutlab_tokens, public.cutlab_project_versions
to authenticated;

-- ------------------------------------------------------------------
-- 2. RLS: anon-all OUT, owner-only IN
-- ------------------------------------------------------------------
drop policy if exists cutlab_projects_anon_all on public.cutlab_projects;
drop policy if exists cutlab_projects_owner_all on public.cutlab_projects;
create policy cutlab_projects_owner_all on public.cutlab_projects
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cutlab_media_anon_all on public.cutlab_media;
drop policy if exists cutlab_media_owner_all on public.cutlab_media;
create policy cutlab_media_owner_all on public.cutlab_media
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Jobs: read/update/delete own rows; INSERT additionally refuses to
-- attach a job to somebody else's project (the worker reads the
-- project JSON by id with the service key — an unscoped project_id
-- would hand another user's project to the render lane). The policies
-- are split per command ON PURPOSE: Postgres ORs permissive policies,
-- so a plain `for all` insert check would silently bypass the
-- project-ownership condition below.
drop policy if exists cutlab_jobs_anon_all on public.cutlab_jobs;
drop policy if exists cutlab_jobs_owner_all on public.cutlab_jobs;
drop policy if exists cutlab_jobs_owner_select on public.cutlab_jobs;
drop policy if exists cutlab_jobs_owner_update on public.cutlab_jobs;
drop policy if exists cutlab_jobs_owner_delete on public.cutlab_jobs;
drop policy if exists cutlab_jobs_owner_insert on public.cutlab_jobs;
create policy cutlab_jobs_owner_select on public.cutlab_jobs
  for select to authenticated
  using (user_id = auth.uid());
create policy cutlab_jobs_owner_update on public.cutlab_jobs
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy cutlab_jobs_owner_delete on public.cutlab_jobs
  for delete to authenticated
  using (user_id = auth.uid());
create policy cutlab_jobs_owner_insert on public.cutlab_jobs
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (project_id is null or exists (
      select 1 from public.cutlab_projects p
      where p.id = project_id and p.user_id = auth.uid()))
  );

drop policy if exists cutlab_commands_anon_all on public.cutlab_commands;
drop policy if exists cutlab_commands_owner_all on public.cutlab_commands;
create policy cutlab_commands_owner_all on public.cutlab_commands
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cutlab_tokens_anon_all on public.cutlab_tokens;
drop policy if exists cutlab_tokens_owner_all on public.cutlab_tokens;
create policy cutlab_tokens_owner_all on public.cutlab_tokens
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists cutlab_project_versions_anon_all on public.cutlab_project_versions;
drop policy if exists cutlab_project_versions_owner_all on public.cutlab_project_versions;
create policy cutlab_project_versions_owner_all on public.cutlab_project_versions
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------------
-- 3. Storage policies for the `cutlab` bucket
--    own scope:        users/<auth.uid()>/…
--    legacy carve-out: projects/<pid>/… where the caller owns that
--                      project row (read + write; the worker's
--                      pre-Phase-1 publishes and Jarvis-authored
--                      originals for a claimed project live there)
-- ------------------------------------------------------------------
drop policy if exists cutlab_anon_select on storage.objects;
drop policy if exists cutlab_anon_insert on storage.objects;
drop policy if exists cutlab_anon_update on storage.objects;
drop policy if exists cutlab_auth_select on storage.objects;
drop policy if exists cutlab_auth_insert on storage.objects;
drop policy if exists cutlab_auth_update on storage.objects;
drop policy if exists cutlab_auth_delete on storage.objects;

create policy cutlab_auth_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'cutlab' and (
      ((storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text)
      or
      ((storage.foldername(name))[1] = 'projects'
        and exists (
          select 1 from public.cutlab_projects p
          where p.id::text = (storage.foldername(name))[2]
            and p.user_id = auth.uid()))
    )
  );

create policy cutlab_auth_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cutlab' and (
      ((storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text)
      or
      ((storage.foldername(name))[1] = 'projects'
        and exists (
          select 1 from public.cutlab_projects p
          where p.id::text = (storage.foldername(name))[2]
            and p.user_id = auth.uid()))
    )
  );

create policy cutlab_auth_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'cutlab' and (
      ((storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text)
      or
      ((storage.foldername(name))[1] = 'projects'
        and exists (
          select 1 from public.cutlab_projects p
          where p.id::text = (storage.foldername(name))[2]
            and p.user_id = auth.uid()))
    )
  )
  with check (
    bucket_id = 'cutlab' and (
      ((storage.foldername(name))[1] = 'users'
        and (storage.foldername(name))[2] = auth.uid()::text)
      or
      ((storage.foldername(name))[1] = 'projects'
        and exists (
          select 1 from public.cutlab_projects p
          where p.id::text = (storage.foldername(name))[2]
            and p.user_id = auth.uid()))
    )
  );

-- Delete is intentionally NARROWER: own users/ scope only. Legacy
-- projects/ objects are removed by the worker (service role).
create policy cutlab_auth_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'cutlab'
    and (storage.foldername(name))[1] = 'users'
    and (storage.foldername(name))[2] = auth.uid()::text
  );

-- ------------------------------------------------------------------
-- 4. Platform per-file limit: 50 MB (matches relayAccess.ts)
-- ------------------------------------------------------------------
update storage.buckets set file_size_limit = 52428800 where id = 'cutlab';

-- ------------------------------------------------------------------
-- 5. Per-user storage quota (200 MB), enforced at job insert
-- ------------------------------------------------------------------
create or replace function public.cutlab_user_storage_bytes(p_uid uuid)
returns bigint
language sql
security definer
set search_path = public, storage
as $$
  select coalesce(sum(coalesce((metadata->>'size')::bigint, 0)), 0)
  from storage.objects
  where bucket_id = 'cutlab'
    and name like 'users/' || p_uid::text || '/%';
$$;

create or replace function public.cutlab_enforce_job_quota()
returns trigger
language plpgsql
security definer
set search_path = public, storage
as $$
begin
  if new.user_id is not null
     and public.cutlab_user_storage_bytes(new.user_id) > 209715200 then
    raise exception
      'CutLab storage quota exceeded (200 MB per user) — delete old files and try again';
  end if;
  return new;
end;
$$;

drop trigger if exists cutlab_jobs_quota on public.cutlab_jobs;
create trigger cutlab_jobs_quota
  before insert on public.cutlab_jobs
  for each row execute function public.cutlab_enforce_job_quota();

-- ==================================================================
-- CLAIM — run ONCE, by hand, AFTER the owner creates their account.
-- Do NOT run this block as part of the migration above.
--
-- This relay has only ever served the owner, so every user_id NULL
-- row is his. Replace <OWNER_UID> with the owner's auth uid (the id
-- shown for his user in the dashboard under Authentication → Users —
-- and the same value that goes into OWNER_UID in
-- src/services/ownerConfig.ts before the client redeploy).
--
-- begin;
-- update public.cutlab_projects        set user_id = '<OWNER_UID>' where user_id is null;
-- update public.cutlab_media           set user_id = '<OWNER_UID>' where user_id is null;
-- update public.cutlab_jobs            set user_id = '<OWNER_UID>' where user_id is null;
-- update public.cutlab_commands        set user_id = '<OWNER_UID>' where user_id is null;
-- update public.cutlab_tokens          set user_id = '<OWNER_UID>' where user_id is null;
-- update public.cutlab_project_versions set user_id = '<OWNER_UID>' where user_id is null;
-- commit;
--
-- Storage objects are NOT moved by the claim: the demo project's
-- objects stay under projects/<pid>/… and policy section 3 above
-- keeps them readable/writable by the project's owner. New uploads
-- and publishes land under users/<OWNER_UID>/… automatically.
-- After the claim, the owner should toggle Jarvis control off/on once
-- so the session re-announces under his account (old session rows
-- carry no user_id, and commands stamped from them cannot be claimed
-- under the new policies — server/control.py copies the id from the
-- newest session row it can see).
-- ==================================================================
