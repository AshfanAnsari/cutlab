-- CutLab MCP upgrade — Phase 1 full agent control surface
-- (cutlab-filmcraft-parity UPGRADE-PLAN.md §3).
-- Run in the Supabase dashboard SQL editor (project hjdyvaetxhvxzgsdlibt),
-- same pattern as phase1/jobs-v2/v3/v4. DEPLOY ORDER MATTERS: run this
-- BEFORE redeploying the cutlab-mcp Edge Function with the Phase 1
-- tools. The Phase 1 function tolerates the pre-migration relay (its
-- project loader probes for the revision column and falls back to
-- unguarded last-writer-wins saves, reporting revisionTracked: false),
-- and the pre-Phase-1 function never reads the column — but only with
-- the column in place do agent writes get optimistic-concurrency
-- protection, so run it in the same sitting as the redeploy.
--
-- What changes:
--   cutlab_projects gains `revision` — a monotonically increasing
--   counter bumped by every MCP agent write (and only agent writes;
--   the client app saves through its own upsert and leaves the value
--   alone, which simply means an agent's expected_revision check is
--   against the last agent-known state). Guarded agent saves PATCH
--   with revision=eq.<old>; zero rows back = a concurrent write won
--   and the agent is told to reload instead of stomping it.
--
-- Nothing else: quotas, RLS and the jobs type CHECK are untouched
-- (the Phase 1 'still' job type lands with its worker support in
-- Phase 4, behind its own migration).

alter table public.cutlab_projects
  add column if not exists revision integer not null default 1;
