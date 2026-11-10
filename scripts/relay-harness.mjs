#!/usr/bin/env node
/**
 * relay-harness.mjs — end-to-end verification of the LIVE Supabase relay,
 * driving the exact REST calls src/services/jobsSupabase.ts makes
 * (same endpoints, headers, payload shapes), against examples/ media:
 *
 *   1. insert a cutlab_projects row (Karina acceptance project)
 *   2. media-analysis job: upload inputs -> queue row -> poll -> verify
 *      manifest + download proxy/thumb/peaks
 *   3. render job: upload inputs -> queue row (project_id) -> poll ->
 *      download the MP4 and compare bytes to the known-good 7,518,804
 *   4. delete every row/object the harness created
 *
 * Usage: node scripts/relay-harness.mjs [examplesDir]
 * Requires network access to the relay (this VM: NODE_USE_ENV_PROXY=1).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE = 'https://hjdyvaetxhvxzgsdlibt.supabase.co';
const KEY = 'sb_publishable_dC1gPRMT43_NsU-OjSxr_Q_dKoFRVqM';
const BUCKET = 'cutlab';
const EXPECTED_RENDER_BYTES = 7_518_804;
const EX = process.argv[2] ?? new URL('../examples', import.meta.url).pathname;

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a) { console.log(`[${stamp()}]`, ...a); }

async function sb(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('apikey', KEY);
  headers.set('Authorization', `Bearer ${KEY}`);
  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}
async function select(path) { return (await sb(path)).json(); }
async function insert(table, row) {
  const res = await sb(`/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  return (await res.json())[0] ?? null;
}
async function upload(path, buf, type) {
  await sb(`/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': type, 'x-upsert': 'true' },
    body: buf,
  });
}
async function download(path) { return (await sb(`/storage/v1/object/${BUCKET}/${path}`)).blob(); }

async function waitForJob(jobId, pollMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const [row] = await select(`/rest/v1/cutlab_jobs?id=eq.${jobId}&select=id,status,result,error`);
    if (!row) throw new Error('job row vanished');
    if (row.status !== last) { last = row.status; log(`  job ${jobId.slice(0, 8)} -> ${last}`); }
    if (row.status === 'done') return row;
    if (row.status === 'failed') throw new Error(`job failed: ${row.error}`);
    if (Date.now() > deadline) throw new Error('timeout waiting for job');
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function listAll(prefix) {
  const res = await sb(`/storage/v1/object/list/${BUCKET}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, limit: 1000 }),
  });
  const rows = await res.json();
  const out = [];
  for (const x of rows) {
    if (x.id) out.push(`${prefix}/${x.name}`);
    else out.push(...await listAll(`${prefix}/${x.name}`));
  }
  return out;
}
async function removeObjects(paths) {
  if (!paths.length) return;
  await sb(`/storage/v1/object/${BUCKET}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: paths }),
  });
}
async function deleteRows(table, filter) {
  await sb(`/rest/v1/${table}?${filter}`, { method: 'DELETE' });
}

const created = { jobs: [], projects: [], prefixes: [] };
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

try {
  const project = JSON.parse(await readFile(join(EX, 'karina.cutlab.json'), 'utf8'));
  const mediaDir = join(EX, 'media');
  const files = new Map();
  for (const m of project.media) {
    files.set(m.src, await readFile(join(mediaDir, m.src)));
  }
  log(`loaded project "${project.name}" with ${files.size} media files`);

  // ---- 1. project row ------------------------------------------------------
  const projRow = await insert('cutlab_projects', { name: 'harness-karina', project });
  created.projects.push(projRow.id);
  log(`project row inserted: ${projRow.id}`);

  // ---- 2. media-analysis job ------------------------------------------------
  const mediaJobId = randomUUID();
  created.jobs.push(mediaJobId); created.prefixes.push(`jobs/${mediaJobId}`);
  const upStart = Date.now();
  for (const m of project.media) {
    await upload(`jobs/${mediaJobId}/input/${m.src}`, files.get(m.src), m.src.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
  }
  log(`media job inputs uploaded in ${((Date.now() - upStart) / 1000).toFixed(1)}s`);
  const payload = {
    version: 1, type: 'media-analysis', createdAt: new Date().toISOString(), fps: project.canvas.fps,
    items: project.media.map((m) => ({
      id: m.id, src: m.src, kind: m.kind,
      requests: m.kind === 'image' ? ['thumbnail'] : ['proxy', 'thumbnail', 'peaks'],
    })),
  };
  const qStart = Date.now();
  await insert('cutlab_jobs', { id: mediaJobId, type: 'media-analysis', status: 'queued', payload });
  const mediaRow = await waitForJob(mediaJobId, 2500, 10 * 60_000);
  const mediaSecs = ((Date.now() - qStart) / 1000).toFixed(1);
  log(`media job done in ${mediaSecs}s (queue -> done)`);
  const { manifest, outputPrefix } = mediaRow.result ?? {};
  check('media result has manifest + outputPrefix', !!manifest && !!outputPrefix, outputPrefix ?? '');
  check('manifest covers all media', Object.keys(manifest?.items ?? {}).length === project.media.length,
    `${Object.keys(manifest?.items ?? {}).length}/${project.media.length} items`);
  const p1 = manifest.items['P1_playful_handface.mp4'];
  const proxy = await download(outputPrefix + p1.proxy);
  const thumb = await download(outputPrefix + p1.thumb);
  const peaks = JSON.parse(await (await download(outputPrefix + p1.peaks)).text());
  check('P1 proxy downloads', proxy.size > 10_000, `${proxy.size} B`);
  check('P1 thumb downloads', thumb.size > 1_000, `${thumb.size} B`);
  check('P1 peaks are a 240-number array', Array.isArray(peaks) && peaks.length === 240, `${peaks.length} peaks`);

  // ---- 3. render job ----------------------------------------------------------
  const renderJobId = randomUUID();
  created.jobs.push(renderJobId); created.prefixes.push(`jobs/${renderJobId}`);
  for (const m of project.media) {
    await upload(`jobs/${renderJobId}/input/${m.src}`, files.get(m.src), m.src.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4');
  }
  const renderPayload = {
    version: 1, type: 'render', lane: 'B', createdAt: new Date().toISOString(),
    output: { container: 'mp4', crf: 18, color: 'bt709', stripMetadata: true },
    command: 'python3 server/render_job.py <this-bundle.zip> --out render.mp4',
  };
  const rStart = Date.now();
  await insert('cutlab_jobs', {
    id: renderJobId, type: 'render', status: 'queued', project_id: projRow.id, payload: renderPayload,
  });
  const renderRow = await waitForJob(renderJobId, 5000, 30 * 60_000);
  const renderSecs = ((Date.now() - rStart) / 1000).toFixed(1);
  log(`render job done in ${renderSecs}s (queue -> done)`);
  const out = renderRow.result?.outputs?.[0];
  check('render result has outputs[0]', !!out?.path, out?.path ?? '');
  const mp4 = await download(out.path);
  check('rendered MP4 byte size matches known-good', mp4.size === EXPECTED_RENDER_BYTES,
    `${mp4.size} vs ${EXPECTED_RENDER_BYTES}`);
  check('result.outputs[0].bytes matches download', out.bytes === mp4.size, `${out.bytes}`);
  await writeFile('/tmp/harness_render.mp4', Buffer.from(await mp4.arrayBuffer()));
  log('render saved to /tmp/harness_render.mp4 for ffprobe checks');
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  failures++;
} finally {
  // ---- 4. cleanup -------------------------------------------------------------
  try {
    const objs = [];
    for (const p of created.prefixes) objs.push(...await listAll(p));
    await removeObjects(objs);
    if (created.jobs.length) await deleteRows('cutlab_jobs', `id=in.(${created.jobs.join(',')})`);
    if (created.projects.length) await deleteRows('cutlab_projects', `id=in.(${created.projects.join(',')})`);
    log(`cleanup: removed ${objs.length} object(s), ${created.jobs.length} job row(s), ${created.projects.length} project row(s)`);
  } catch (e) {
    console.error('CLEANUP ERROR:', e.message);
    failures++;
  }
}

console.log(failures === 0 ? '\nHARNESS: ALL CHECKS PASSED' : `\nHARNESS: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
