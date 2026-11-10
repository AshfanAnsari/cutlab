/**
 * Phase 1 harness (PLAN-PUBLIC-PRODUCT-DRAFT.md) — headless checks for
 * the lockdown + accounts client work:
 *   · auth helpers (OAuth callback parsing, refresh skew, provider URLs)
 *   · the session store (signed-out default, set/clear round-trip)
 *   · relay path builders + the file cap + the sign-in guard
 *   · cloud writes refusing BEFORE any network call while signed out,
 *     and reaching the network while signed in (fetch is stubbed)
 *   · the Jarvis-control owner gate matrix
 *   · connect-token scoping (client mirror of the worker rule)
 *   · signed-out local mode: project normalisation runs with no
 *     session and no relay involved
 * RLS behaviour itself is NOT checkable here — that is the deploy-time
 * isolation suite (server-tests/phase1_isolation.py).
 */
import {
  currentSession, currentUserId, parseAuthCallbackHash,
  providerAuthorizeUrl, sessionNeedsRefresh, setSession,
  type AuthSession,
} from '../src/services/auth';
import {
  MAX_FILE_BYTES, USER_STORAGE_QUOTA_BYTES,
  assertFileCap, jobInputPath, jobScopePrefix, projectScopePrefix,
  requireUserId, userPrefix,
} from '../src/services/relayAccess';
import { controlGate } from '../src/services/control';
import { tokenScopeAllows } from '../src/services/byoClaude';
import { jobService } from '../src/services/jobsSupabase';
import { normalizeProject } from '../src/services/projectIO';
import type { Project } from '../src/model/types';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ''}`); }
}
function throws(name: string, fn: () => unknown, needle: string) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, (e as Error).message.includes(needle), (e as Error).message); }
}

const now = 1_800_000_000_000;
function session(uid: string, expiresAt: number): AuthSession {
  return {
    accessToken: 'AT', refreshToken: 'RT', expiresAt,
    user: { id: uid, email: `${uid}@example.test` },
  };
}

async function main() {
  // ---- auth helpers ------------------------------------------------
  const parsed = parseAuthCallbackHash(
    '#access_token=AT9&refresh_token=RT9&expires_in=3600&token_type=bearer');
  check('callback hash parses into tokens',
    parsed?.kind === 'tokens' && parsed.accessToken === 'AT9'
      && parsed.refreshToken === 'RT9' && parsed.expiresIn === 3600);
  const denied = parseAuthCallbackHash('#error=access_denied&error_description=Nope%20way');
  check('callback error surfaces its description',
    denied?.kind === 'error' && denied.message === 'Nope way');
  check('non-auth hashes are a no-op', parseAuthCallbackHash('') === null
    && parseAuthCallbackHash('#foo=bar') === null);

  check('refresh skew: inside 60s refreshes',
    sessionNeedsRefresh(session('u', now + 30_000), now) === true);
  check('refresh skew: fresh session does not',
    sessionNeedsRefresh(session('u', now + 3_600_000), now) === false);

  const gh = providerAuthorizeUrl('github', 'https://app.example.test/cutlab/');
  check('provider URL targets GoTrue authorize with the provider',
    gh.includes('/auth/v1/authorize?provider=github&redirect_to=')
      && gh.includes(encodeURIComponent('https://app.example.test/cutlab/')), gh);
  const gg = providerAuthorizeUrl('google', 'http://localhost:5173/');
  check('google provider URL likewise', gg.includes('provider=google'), gg);

  // ---- session store + signed-out defaults -------------------------
  check('signed-out by default: no session', currentSession() === null
    && currentUserId() === null);
  throws('requireUserId refuses signed-out work',
    () => requireUserId('cloud saves'), 'Sign in to cloud saves');
  setSession(session('u1', now + 3_600_000));
  check('session store round-trips', currentUserId() === 'u1'
    && currentSession()?.user.email === 'u1@example.test');
  check('requireUserId returns the uid when signed in',
    requireUserId('cloud saves') === 'u1');
  setSession(null);
  check('sign-out clears the store', currentSession() === null);

  // ---- relay paths + caps ------------------------------------------
  check('user prefix', userPrefix('u1') === 'users/u1');
  check('job input path is owner-scoped',
    jobInputPath('u1', 'JOB9', 'clip a.mp4') === 'users/u1/jobs/JOB9/input/clip a.mp4');
  check('job scope prefix', jobScopePrefix('u1', 'JOB9') === 'users/u1/jobs/JOB9');
  check('project scope prefix',
    projectScopePrefix('u1', 'P7') === 'users/u1/projects/P7');
  check('caps are the documented free-tier numbers',
    MAX_FILE_BYTES === 50 * 1024 * 1024
      && USER_STORAGE_QUOTA_BYTES === 200 * 1024 * 1024);
  assertFileCap(1024, 'small.mp4');
  check('file cap passes a small file', true);
  throws('file cap refuses an oversize file',
    () => assertFileCap(MAX_FILE_BYTES + 1, 'huge.mp4'), '50 MB');

  // ---- cloud guard: no network while signed out --------------------
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.reject(new Error('NETWORK-SENTINEL'));
  }) as typeof fetch;
  const probeProject = normalizeProject({
    version: 1, name: 'guard probe', canvas: { w: 720, h: 1280, fps: 30 },
    media: [], tracks: [],
  }) as Project;
  const saveRemote = jobService.saveProjectRemote!.bind(jobService);
  try {
    await saveRemote(probeProject);
    check('signed-out cloud save refuses', false, 'resolved instead of throwing');
  } catch (e) {
    check('signed-out cloud save refuses with the sign-in message',
      (e as Error).message.startsWith('Sign in to save projects to the cloud'),
      (e as Error).message);
  }
  check('signed-out refusal happened before any network call', fetchCalls === 0,
    `${fetchCalls} fetch calls`);
  setSession(session('u1', Date.now() + 3_600_000));
  try {
    await saveRemote(probeProject);
    check('signed-in cloud save reaches the relay', false, 'resolved against the stub');
  } catch (e) {
    check('signed-in cloud save reaches the relay (stub error, not the guard)',
      (e as Error).message.includes('NETWORK-SENTINEL'), (e as Error).message);
  }
  check('signed-in save did call fetch', fetchCalls > 0);
  globalThis.fetch = realFetch;
  setSession(null);

  // ---- Jarvis-control owner gate ------------------------------------
  const owner = session('owner-uid', now + 3_600_000);
  const other = session('someone-else', now + 3_600_000);
  check('gate: signed out refuses', controlGate(null, 'owner-uid').allowed === false
    && /Sign in/.test(controlGate(null, 'owner-uid').reason));
  check('gate: unconfigured owner refuses everyone',
    controlGate(owner, '').allowed === false
      && /not configured/.test(controlGate(owner, '').reason));
  check('gate: non-owner refuses',
    controlGate(other, 'owner-uid').allowed === false
      && /owner-only/.test(controlGate(other, 'owner-uid').reason));
  const okGate = controlGate(owner, 'owner-uid');
  check('gate: the owner passes', okGate.allowed === true && okGate.reason === '');

  // ---- connect-token scoping ----------------------------------------
  check('token scope: same account passes', tokenScopeAllows('u1', 'u1') === true);
  check('token scope: another account’s job refused',
    tokenScopeAllows('u1', 'u2') === false);
  check('token scope: legacy unscoped rows still pass',
    tokenScopeAllows(null, 'u2') === true && tokenScopeAllows('u1', null) === true
      && tokenScopeAllows(undefined, undefined) === true);

  // ---- signed-out local mode unchanged -------------------------------
  const local = normalizeProject({
    version: 1, name: 'Local only', canvas: { w: 1080, h: 1920, fps: 30 },
    media: [], tracks: [],
  });
  check('local project normalises with no session and no relay',
    local.name === 'Local only' && currentSession() === null);

  console.log(`\nphase1-harness: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
