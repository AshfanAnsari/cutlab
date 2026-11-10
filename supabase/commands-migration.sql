-- CutLab LIVE CONTROL channel (FigCraft-style) for the shared Supabase project
-- (ref hjdyvaetxhvxzgsdlibt). Run once in the dashboard SQL editor, AFTER
-- migration.sql. Everything is cutlab_ prefixed; Study Home tables untouched.
--
-- How it works: the browser app, with its "Jarvis control" toggle ON, writes a
-- session announcement row (kind = 'session', command = {hello, userAgent})
-- and then polls for rows addressed to its session_id with status 'queued'.
-- Jarvis (server/control.py, secret key) inserts command rows
-- (kind = the command name, command = the args object); the app claims one at
-- a time (queued -> running), executes it against the editor store, and writes
-- the outcome back (status done/failed + result/error). getState commands use
-- `result` to hand the current project JSON back to Jarvis.
--
-- Exposure note (test phase): like the other cutlab_ tables this carries an
-- anon all-access policy — the publishable key is public by design. Anyone who
-- finds the public test deployment could queue commands to an app whose
-- control toggle is ON. Mitigations in the app: the toggle defaults OFF,
-- commands are addressed per session, and a visible "Jarvis is driving"
-- banner with a Stop button shows while control is live. Tighten when app
-- auth lands, together with the other cutlab_ policies.

create table if not exists public.cutlab_commands (
  id uuid primary key default gen_random_uuid(),
  session_id text not null,
  kind text not null,
  command jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The app's poll: one session's queued commands, oldest first.
create index if not exists cutlab_commands_session_queue_idx
  on public.cutlab_commands (session_id, status, created_at);

alter table public.cutlab_commands enable row level security;

-- Scoped to THIS table only, mirroring migration.sql's pattern.
drop policy if exists cutlab_commands_anon_all on public.cutlab_commands;
create policy cutlab_commands_anon_all on public.cutlab_commands
  for all to anon using (true) with check (true);
