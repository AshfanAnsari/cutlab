-- CutLab Phase 3 — feedback table (PLAN-PHASE3-SURFACE.md C5).
-- Run in the Supabase dashboard SQL editor (project hjdyvaetxhvxzgsdlibt),
-- same pattern as jobs-v2/v3/v4 and phase1. DO NOT run as part of the
-- client build: until this runs, the in-app Feedback dialog's insert
-- is rejected by PostgREST (table missing) and the dialog shows its
-- error state with nothing sent — that ordering is deliberate
-- (client first, migration at deploy).
--
-- What changes:
--   new table cutlab_feedback — one row per in-app report. Policies
--   follow the Phase-1 lockdown exactly: the anon role gets NOTHING;
--   authenticated users may INSERT rows stamped with their own uid
--   and SELECT their own rows back (the app's "sent" state). They may
--   NOT update or delete (no policies exist for those commands). The
--   owner reads everything via the service key, which bypasses RLS.

create table if not exists public.cutlab_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('bug', 'idea', 'question', 'other')),
  message text not null check (char_length(message) between 1 and 4000),
  page text
);

create index if not exists cutlab_feedback_created_idx
  on public.cutlab_feedback (created_at desc);
create index if not exists cutlab_feedback_user_idx
  on public.cutlab_feedback (user_id);

alter table public.cutlab_feedback enable row level security;

grant select, insert on public.cutlab_feedback to authenticated;

drop policy if exists cutlab_feedback_insert_own on public.cutlab_feedback;
create policy cutlab_feedback_insert_own on public.cutlab_feedback
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists cutlab_feedback_select_own on public.cutlab_feedback;
create policy cutlab_feedback_select_own on public.cutlab_feedback
  for select to authenticated
  using (user_id = auth.uid());
