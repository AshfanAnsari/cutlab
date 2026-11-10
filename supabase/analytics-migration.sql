-- CutLab analytics — privacy-light product events (EXTRAS).
-- Run in the Supabase dashboard SQL editor (project hjdyvaetxhvxzgsdlibt),
-- same pattern as feedback / jobs-v2/v3/v4 and phase1. DO NOT run as
-- part of the client build: until this runs, the client's tracking
-- calls fail silently — services/analytics.ts swallows every error,
-- so a missing table costs no toast, no throw and no blocked UI.
-- That ordering is deliberate (client first, migration at deploy).
--
-- What changes:
--   new table cutlab_analytics_events — one row per product event.
--   Privacy-light by construction: rows carry an event name, an
--   optional page id and a small sanitised props bag. The client
--   sanitiser (services/analytics.ts) drops any prop key matching
--   email|name|message|text|token|password, caps props at 10 keys
--   and truncates string values at 120 chars — no PII, no free-text
--   capture, ever. user_id is stamped ONLY when the caller is signed
--   in; signed-out events store NULL.
--
--   RLS: INSERT is allowed for anon AND authenticated (product
--   analytics must count signed-out use too) — the anon policy
--   requires user_id IS NULL, and the authenticated policy requires
--   user_id IS NULL or user_id = auth.uid(), so no caller can stamp
--   another account's id. SELECT is authenticated-only and scoped
--   to the caller's own rows (user_id = auth.uid()); the app's
--   "Your activity" card reads exactly that. There are no UPDATE or
--   DELETE policies. Cross-account aggregates are NOT read by the
--   app at all — the owner reads them via the service key / SQL
--   editor, which bypasses RLS.

create table if not exists public.cutlab_analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid null references auth.users(id) on delete set null,
  event text not null check (char_length(event) between 1 and 64),
  page text null,
  props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists cutlab_analytics_events_created_event_idx
  on public.cutlab_analytics_events (created_at desc, event);
create index if not exists cutlab_analytics_events_user_idx
  on public.cutlab_analytics_events (user_id, created_at desc);

alter table public.cutlab_analytics_events enable row level security;

grant insert on public.cutlab_analytics_events to anon, authenticated;
grant select on public.cutlab_analytics_events to authenticated;

drop policy if exists cutlab_analytics_insert_anon on public.cutlab_analytics_events;
create policy cutlab_analytics_insert_anon on public.cutlab_analytics_events
  for insert to anon
  with check (user_id is null);

drop policy if exists cutlab_analytics_insert_auth on public.cutlab_analytics_events;
create policy cutlab_analytics_insert_auth on public.cutlab_analytics_events
  for insert to authenticated
  with check (user_id is null or user_id = auth.uid());

drop policy if exists cutlab_analytics_select_own on public.cutlab_analytics_events;
create policy cutlab_analytics_select_own on public.cutlab_analytics_events
  for select to authenticated
  using (user_id = auth.uid());
