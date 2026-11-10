-- CutLab jobs v2 — widen the relay's CHECK constraints for the Lane B
-- parity pass. Run in the Supabase dashboard SQL editor (project
-- hjdyvaetxhvxzgsdlibt), same pattern as commands-migration.sql.
--
-- What changes:
--   cutlab_jobs.type   += 'transcribe', 'track', 'separate'
--   cutlab_jobs.status += 'cancelled'   (app sets it; the worker stops
--                                        picking the job up / aborts it)
--   cutlab_media.kind  += 'matte', 'depth' (Lane B compositing kinds)
--
-- The original migration created these as inline unnamed CHECKs, so
-- Postgres gave them the default names used below. If a DROP fails with
-- "does not exist", list the actual names first with:
--   select conname from pg_constraint
--   where conrelid = 'cutlab_jobs'::regclass and contype = 'c';

alter table cutlab_jobs drop constraint if exists cutlab_jobs_type_check;
alter table cutlab_jobs add constraint cutlab_jobs_type_check
  check (type in ('media-analysis', 'render', 'transcribe', 'track', 'separate'));

alter table cutlab_jobs drop constraint if exists cutlab_jobs_status_check;
alter table cutlab_jobs add constraint cutlab_jobs_status_check
  check (status in ('queued', 'running', 'done', 'failed', 'cancelled'));

alter table cutlab_media drop constraint if exists cutlab_media_kind_check;
alter table cutlab_media add constraint cutlab_media_kind_check
  check (kind in ('video', 'audio', 'image', 'matte', 'depth'));
