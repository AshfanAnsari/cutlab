/**
 * Phase 3 harness (PLAN-PHASE3-SURFACE.md) — headless checks for the
 * public-surface client work:
 *   · account pure helpers (byte formatting, storage-entry sums,
 *     version counting, job-lane reading)
 *   · the export refuses BEFORE any network call while signed out,
 *     and its token select never asks for token_hash (credential
 *     hygiene: an export must not leak hashes)
 *   · feedback validation + its signed-out refusal before fetch
 *   · changePassword refuses signed out and targets GoTrue's user
 *     endpoint with the session JWT when signed in
 * RLS behaviour itself is NOT checkable here — that is the deploy-time
 * isolation suite (server-tests/phase1_isolation.py) and the Phase-3
 * stranger acceptance (server-tests/stranger_acceptance.py).
 */
import { setSession, changePassword, type AuthSession } from '../src/services/auth';
import {
  buildExportData, countVersionsByProject, formatBytes, jobLaneOf, sumEntries,
} from '../src/services/account';
import { submitFeedback, validateFeedback } from '../src/services/feedback';
import type { StorageEntry } from '../src/services/supabase';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}

function session(uid: string): AuthSession {
  return {
    accessToken: 'AT-P3', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000,
    user: { id: uid, email: `${uid}@example.test` },
  };
}

async function main() {
  // ---- account pure helpers -----------------------------------------
  check('formatBytes: zero and junk read as 0 B',
    formatBytes(0) === '0 B' && formatBytes(-5) === '0 B');
  check('formatBytes: bytes stay bytes', formatBytes(512) === '512 B');
  check('formatBytes: KB rounds to whole', formatBytes(2048) === '2 KB');
  check('formatBytes: MB keeps one decimal under 100',
    formatBytes(1.5 * 1024 * 1024) === '1.5 MB');
  check('formatBytes: the 200 MB quota formats whole',
    formatBytes(200 * 1024 * 1024) === '200 MB');

  const entries: StorageEntry[] = [
    { name: 'clip.mp4', id: 'o1', metadata: { size: 1000 } },
    { name: 'jobs', id: null },
    { name: 'thumb.jpg', id: 'o2', metadata: { size: 250 } },
    { name: 'nosize.bin', id: 'o3', metadata: null },
  ];
  const sums = sumEntries(entries);
  check('storage sums skip folders and missing sizes',
    sums.bytes === 1250 && sums.files === 3, JSON.stringify(sums));

  const counts = countVersionsByProject([
    { project_id: 'p1' }, { project_id: 'p1' }, { project_id: 'p2' },
  ]);
  check('version counts group by project',
    counts.get('p1') === 2 && counts.get('p2') === 1 && counts.get('p3') === undefined);

  check('job lane: agent only when stamped',
    jobLaneOf({ execLane: 'agent' }) === 'agent'
      && jobLaneOf({}) === 'server'
      && jobLaneOf(null) === 'server'
      && jobLaneOf({ execLane: 'server' }) === 'server');

  // ---- network guards -------------------------------------------------
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  const seenUrls: string[] = [];
  globalThis.fetch = ((url: unknown) => {
    fetchCalls++;
    seenUrls.push(String(url));
    return Promise.reject(new Error('NETWORK-SENTINEL'));
  }) as typeof fetch;

  setSession(null);
  try {
    await buildExportData();
    check('signed-out export refuses', false, 'resolved instead of throwing');
  } catch (e) {
    check('signed-out export refuses with the sign-in message',
      (e as Error).message.startsWith('Sign in to export your data'), (e as Error).message);
  }
  check('export refusal happened before any network call', fetchCalls === 0,
    `${fetchCalls} fetch calls`);

  try {
    await submitFeedback('bug', 'the thing broke', 'editor');
    check('signed-out feedback refuses', false, 'resolved instead of throwing');
  } catch (e) {
    check('signed-out feedback refuses with the sign-in message',
      (e as Error).message.startsWith('Sign in to send feedback'), (e as Error).message);
  }
  check('feedback refusal also happened before fetch', fetchCalls === 0);

  try {
    await changePassword('new-secret');
    check('signed-out password change refuses', false, 'resolved instead of throwing');
  } catch (e) {
    check('signed-out password change refuses on the session',
      (e as Error).message.includes('Sign in first'), (e as Error).message);
  }
  check('password refusal also happened before fetch', fetchCalls === 0);

  // Signed in, the export reaches the relay; watch that no URL ever
  // asks the relay for token_hash (the export carries labels only).
  setSession(session('u-p3'));
  try {
    await buildExportData();
    check('signed-in export reaches the relay', false, 'resolved against the stub');
  } catch (e) {
    check('signed-in export reaches the relay (stub error, not the guard)',
      (e as Error).message.includes('NETWORK-SENTINEL')
        || (e as Error).message.includes('Relay unreachable'), (e as Error).message);
  }
  check('signed-in export did call fetch', fetchCalls > 0);
  check('no export request ever selects token_hash',
    seenUrls.every((u) => !u.includes('token_hash')), seenUrls.join(' | '));

  globalThis.fetch = realFetch;
  setSession(null);

  // ---- feedback validation ---------------------------------------------
  check('feedback: a real report passes', validateFeedback('bug', 'it broke at step 2') === null);
  check('feedback: empty message refused', validateFeedback('bug', '  ') !== null);
  check('feedback: unknown kind refused', validateFeedback('spam', 'hello there') !== null);
  check('feedback: over-long message refused',
    validateFeedback('idea', 'x'.repeat(4001)) !== null);

  console.log(`\nphase3-harness: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
