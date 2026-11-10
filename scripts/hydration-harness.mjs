#!/usr/bin/env node
/**
 * hydration-harness.mjs — verifies the Open-cloud HYDRATION data path
 * end to end, driving the exact REST calls loadProjectRemote makes in
 * src/services/jobsSupabase.ts (publishable key, same endpoints/shapes):
 *
 *   1. find the demo project row by name in cutlab_projects
 *   2. fetch its cutlab_media rows (the rows loadProjectRemote selects)
 *   3. for every project media entry: download proxy/thumb/peaks from the
 *      row's bucket paths — the files attachRemoteProjectMedia fetches —
 *      and check the peaks file parses as an array of numbers
 *   4. for assets with no proxy (audio), download the original — the file
 *      hydration installs as the local blob
 *   5. verify every original exists under projects/<id>/media/ with the
 *      same byte size as the local example file (the render leg's source:
 *      ensureLocalOriginals downloads these on demand)
 *
 * Read-only: creates nothing, deletes nothing.
 * Usage: node scripts/hydration-harness.mjs [projectName] [examplesDir]
 * Requires network access to the relay (this VM: NODE_USE_ENV_PROXY=1).
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://hjdyvaetxhvxzgsdlibt.supabase.co';
const KEY = 'sb_publishable_dC1gPRMT43_NsU-OjSxr_Q_dKoFRVqM';
const BUCKET = 'cutlab';
const NAME = process.argv[2] ?? 'Karina — Jarvis demo';
const EX = process.argv[3] ?? new URL('../examples', import.meta.url).pathname;

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a) { console.log(`[${stamp()}]`, ...a); }
let failures = 0;
function check(ok, msg) {
  console.log(`  ${ok ? 'OK ' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
}

async function sb(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('apikey', KEY);
  headers.set('Authorization', `Bearer ${KEY}`);
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}
async function select(path) { return (await sb(path)).json(); }
async function download(path) { return (await sb(`/storage/v1/object/${BUCKET}/${path}`)).blob(); }
async function listNames(prefix) {
  const res = await sb(`/storage/v1/object/list/${BUCKET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 500 }),
  });
  const rows = await res.json();
  return new Map(rows.filter((r) => r.id).map((r) => [r.name, r.metadata?.size ?? r.metadata?.contentLength]));
}

// 1. project row (listRemoteProjects + loadProjectRemote's select)
const projects = await select(
  `/rest/v1/cutlab_projects?name=eq.${encodeURIComponent(NAME)}&select=id,name,project,updated_at`,
);
check(projects.length === 1, `exactly one project row named "${NAME}" (found ${projects.length})`);
if (!projects.length) process.exit(1);
const { id: projectId, project } = projects[0];
log(`project ${projectId}: ${project.media.length} media entries, ${project.tracks.length} tracks`);

// 2. cutlab_media rows (loadProjectRemote's exact select)
const rows = await select(
  `/rest/v1/cutlab_media?project_id=eq.${projectId}&select=asset_id,src,kind,input_path,proxy_path,thumb_path,peaks_path`,
);
check(rows.length === project.media.length,
  `cutlab_media rows = ${rows.length} (project media entries = ${project.media.length})`);

// 5 (prep). originals present under the project prefix, sizes vs local
const originals = await listNames(`projects/${projectId}/media/`);
for (const m of project.media) {
  const localSize = (await stat(join(EX, 'media', m.src))).size;
  check(originals.get(m.src) === localSize,
    `original projects/${projectId.slice(0, 8)}…/media/${m.src} = ${originals.get(m.src)} B (local ${localSize} B)`);
}

// 3+4. per-asset hydration downloads
for (const m of project.media) {
  const row = rows.find((r) => r.asset_id === m.id) ?? rows.find((r) => r.src === m.src);
  check(!!row, `${m.src}: cutlab_media row found (asset ${m.id})`);
  if (!row) continue;
  check(row.input_path === `projects/${projectId}/media/${m.src}`,
    `${m.src}: input_path points at the project original`);
  for (const [label, path] of [['proxy', row.proxy_path], ['thumb', row.thumb_path], ['peaks', row.peaks_path]]) {
    if (!path) {
      console.log(`  --   ${m.src}: no ${label} (expected for ${m.kind})`);
      continue;
    }
    const blob = await download(path);
    check(blob.size > 0, `${m.src}: ${label} downloaded, ${blob.size} B`);
    if (label === 'peaks') {
      const parsed = JSON.parse(await blob.text());
      check(Array.isArray(parsed) && parsed.length > 0 && parsed.every((n) => typeof n === 'number'),
        `${m.src}: peaks parse as ${Array.isArray(parsed) ? parsed.length : '?'} numbers`);
    }
  }
  if (!row.proxy_path) {
    const blob = await download(row.input_path);
    check(blob.size > 0, `${m.src}: original downloaded as the playable blob, ${blob.size} B`);
  }
}

log(failures === 0 ? 'HYDRATION PATH VERIFIED — all checks passed' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
