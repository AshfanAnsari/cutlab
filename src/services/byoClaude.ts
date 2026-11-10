// Bring-your-own Claude token (parked-features plan, Feature 1 §7).
// The user pastes a token issued by the assistant (or generates one locally
// and hands the HASH to the assistant to register). The app never stores a
// password and never sends the token anywhere except into the local store
// and, hashed, to the relay's cutlab_tokens table where Verify checks it
// exists and is not revoked. The worker only ever sees the hash with the
// job, so a relay row can never leak the raw token.
//
// Phase 1: token rows are scoped to an account (user_id). Generating a
// token while signed in registers its hash under your account in the
// same step; the worker refuses a job whose token belongs to a
// different account than the job itself (tokenScopeAllows below is the
// rule; server/worker.py check_byo_token enforces the same rule).
//
// Token format: clt_ + 32 base64url chars. The token itself is the user's
// key to the assistant's processing lane — treat it like a password.

import { restPatch, restSelect, restUpsert } from './supabase';
import { currentUserId } from './auth';

const LS_KEY = 'cutlab.byo';

export type ByoStatus = 'unset' | 'connected' | 'revoked' | 'unknown' | 'unreachable';

function randToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return 'clt_' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function loadByoToken(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveByoToken(token: string) {
  try {
    if (token) localStorage.setItem(LS_KEY, token);
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode: token simply will not persist */ }
}

export function generateByoToken(): string {
  const t = randToken();
  saveByoToken(t);
  return t;
}

/** SHA-256 hex of the token — what the relay stores and what jobs carry. */
export async function byoTokenHash(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The token-scoping rule (Phase 1): a token may only drive jobs owned
 * by the account that registered it. Either side being unscoped (a
 * pre-Phase-1 row) allows the pairing — the lockdown migration claims
 * legacy rows to the owner, after which both sides are always set for
 * app-submitted work. Pure; the worker enforces the identical rule.
 */
export function tokenScopeAllows(
  tokenUserId: string | null | undefined,
  jobUserId: string | null | undefined,
): boolean {
  if (tokenUserId && jobUserId && tokenUserId !== jobUserId) return false;
  return true;
}

/**
 * Register a token's hash in the relay under the signed-in account, so
 * Verify can find it and the worker will honour it for that account's
 * jobs. Signed out, this is a no-op returning false (the hash then
 * needs registering by the coordinator, as before Phase 1). Never
 * throws — Verify reports the registry's actual state either way.
 */
export async function registerByoToken(token: string): Promise<boolean> {
  const uid = currentUserId();
  if (!uid || !token) return false;
  try {
    const hash = await byoTokenHash(token);
    await restUpsert('cutlab_tokens', { token_hash: hash, user_id: uid }, 'token_hash');
    return true;
  } catch {
    return false;
  }
}

interface TokenRow { revoked_at: string | null }

/**
 * Verify the stored token against the relay's registry.
 * - 'connected'   : hash found, not revoked.
 * - 'revoked'     : hash found but revoked.
 * - 'unknown'     : hash not found (or the registry table does not exist yet).
 * - 'unreachable' : FIX B1 #19 — the relay could not be reached at all;
 *                   previously this collapsed into 'unknown', so a dead
 *                   connection was misreported as a bad token.
 */
export async function verifyByoToken(): Promise<ByoStatus> {
  const token = loadByoToken();
  if (!token) return 'unset';
  try {
    const hash = await byoTokenHash(token);
    const rows = await restSelect<TokenRow>(
      `/rest/v1/cutlab_tokens?token_hash=eq.${hash}&select=revoked_at&limit=1`,
    );
    if (!rows.length) return 'unknown';
    return rows[0].revoked_at ? 'revoked' : 'connected';
  } catch (e) {
    return e instanceof Error && e.message.startsWith('Relay unreachable') ? 'unreachable' : 'unknown';
  }
}

/** Revoke the stored token in the relay registry. The local copy is kept
 *  so the user can see which token died; Verify will report 'revoked'. */
export async function revokeByoToken(): Promise<boolean> {
  const token = loadByoToken();
  if (!token) return false;
  try {
    const hash = await byoTokenHash(token);
    await restPatch(`/rest/v1/cutlab_tokens?token_hash=eq.${hash}`, { revoked_at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}
