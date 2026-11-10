-- CutLab storage policies for the private `cutlab` bucket.
-- Companion to migration.sql (which covers the cutlab_ tables). The bucket was
-- created through the Storage API, which creates no policies, so the browser
-- app's publishable key could not touch it until these were added.
-- Scoped to bucket_id = 'cutlab' only; no other bucket is affected.
-- The server worker uses the secret key, which bypasses storage RLS.

drop policy if exists cutlab_anon_select on storage.objects;
create policy cutlab_anon_select on storage.objects
  for select to anon using (bucket_id = 'cutlab');

drop policy if exists cutlab_anon_insert on storage.objects;
create policy cutlab_anon_insert on storage.objects
  for insert to anon with check (bucket_id = 'cutlab');

drop policy if exists cutlab_anon_update on storage.objects;
create policy cutlab_anon_update on storage.objects
  for update to anon using (bucket_id = 'cutlab') with check (bucket_id = 'cutlab');
