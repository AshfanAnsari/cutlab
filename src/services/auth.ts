// Supabase Auth (Phase 1 — lockdown + accounts, PLAN-PUBLIC-PRODUCT).
//
// Plain fetch against the GoTrue REST API, mirroring supabase.ts (no
// SDK). A session is { user id + email, access JWT, refresh token,
// expiry } persisted in localStorage; supabase.ts asks this module for
// the current access token on every relay call, so RLS sees the
// signed-in user. Signed out, relay calls fall back to the publishable
// key (the anon role) — after the Phase-1 migration the anon role has
// no cutlab policies at all, so cloud features require sign-in while
// local editing never touches the relay and is completely unaffected.
//
// OAuth (Google/GitHub) uses the implicit flow: the browser leaves for
// the provider via /auth/v1/authorize and returns with the tokens in
// the URL hash, which initAuth() parses and clears. Provider
// enablement + the redirect allow-list live in the Supabase dashboard
// (coordinator step — see the Phase-1 deploy checklist in BUILD-LOG).

import { useSyncExternalStore } from 'react';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, setAuthTokenProvider } from './supabase';

export interface AuthUser { id: string; email: string }

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires */
  expiresAt: number;
  user: AuthUser;
}

const LS_KEY = 'cutlab.auth.session.v1';
const REFRESH_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------
// Session state (tiny external store, same pattern as services/control.ts)
// ---------------------------------------------------------------------------

let session: AuthSession | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function useAuth(): AuthSession | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => session,
  );
}

export function currentSession(): AuthSession | null {
  if (!hydrated) {
    session = readStoredSession();
    hydrated = true;
  }
  return session;
}

export function currentUserId(): string | null {
  return currentSession()?.user.id ?? null;
}

/** Replace (or clear) the session: persists, notifies subscribers.
 *  Also the seam the headless harness uses to stage a session. */
export function setSession(next: AuthSession | null): void {
  session = next;
  hydrated = true;
  try {
    if (next) localStorage.setItem(LS_KEY, JSON.stringify(next));
    else localStorage.removeItem(LS_KEY);
  } catch { /* private mode: session simply will not persist */ }
  emit();
}

function readStoredSession(): AuthSession | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthSession;
    if (!parsed?.accessToken || !parsed?.user?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (harness-covered)
// ---------------------------------------------------------------------------

/** True when the access token is expired or inside the refresh skew. */
export function sessionNeedsRefresh(s: AuthSession, nowMs: number): boolean {
  return s.expiresAt - nowMs <= REFRESH_SKEW_MS;
}

export type AuthCallback =
  | { kind: 'tokens'; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: 'error'; message: string }
  | null;

/** Parse an OAuth implicit-flow return hash ("#access_token=…&…").
 *  Returns null for any hash that is not an auth callback. */
export function parseAuthCallbackHash(hash: string): AuthCallback {
  if (!hash || !hash.includes('access_token=') && !hash.includes('error')) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const err = params.get('error_description') ?? params.get('error');
  if (err) return { kind: 'error', message: err };
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  return {
    kind: 'tokens',
    accessToken,
    refreshToken,
    expiresIn: Number(params.get('expires_in') ?? 3600) || 3600,
  };
}

/** The provider authorize URL (implicit flow back to this app). */
export function providerAuthorizeUrl(provider: 'google' | 'github', redirectTo: string): string {
  return `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}`
    + `&redirect_to=${encodeURIComponent(redirectTo)}`;
}

// ---------------------------------------------------------------------------
// GoTrue calls (publishable key only — never the user's JWT)
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: { id: string; email?: string };
}

async function authCall(
  path: string, body?: Record<string, unknown>, jwt?: string, method?: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(SUPABASE_URL + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${jwt ?? SUPABASE_PUBLISHABLE_KEY}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`Sign-in service unreachable (${e instanceof Error ? e.message : String(e)}). Check the network connection.`);
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg = (data?.['msg'] as string) ?? (data?.['error_description'] as string)
      ?? (data?.['message'] as string) ?? `request failed (${res.status})`;
    throw new Error(friendlyAuthError(msg));
  }
  return data;
}

function friendlyAuthError(msg: string): string {
  if (/invalid login credentials/i.test(msg)) return 'That email and password did not match. Check them and try again.';
  if (/already registered/i.test(msg)) return 'An account with this email already exists — sign in instead.';
  if (/password should be at least/i.test(msg)) return msg.replace(/^./, (c) => c.toUpperCase());
  if (/email not confirmed/i.test(msg)) return 'This account’s email is not confirmed yet — open the confirmation email, then sign in.';
  return `Sign-in problem: ${msg}`;
}

function toSession(t: TokenResponse): AuthSession {
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    user: { id: t.user.id, email: t.user.email ?? '' },
  };
}

export async function signInWithEmail(email: string, password: string): Promise<AuthSession> {
  const data = (await authCall('/auth/v1/token?grant_type=password', { email, password })) as TokenResponse;
  const s = toSession(data);
  setSession(s);
  return s;
}

/** Create an account. When the project requires email confirmation the
 *  response carries a user but NO session — reported honestly so the UI
 *  can tell the user to confirm first instead of pretending sign-in. */
export async function signUpWithEmail(
  email: string, password: string,
): Promise<{ session: AuthSession | null; needsConfirmation: boolean }> {
  const data = (await authCall('/auth/v1/signup', { email, password })) as Partial<TokenResponse>;
  if (data.access_token && data.refresh_token && data.user) {
    const s = toSession(data as TokenResponse);
    setSession(s);
    return { session: s, needsConfirmation: false };
  }
  return { session: null, needsConfirmation: true };
}

/** Ask GoTrue to email a password-reset link (POST /auth/v1/recover).
 *  The link returns to this app; GoTrue answers 200 whether or not the
 *  email has an account, so the UI never confirms existence either
 *  way. Added with the 2026-11-06 auth redesign — the modal's Forgot
 *  flow had no service call before this; it follows the same
 *  authCall/friendlyAuthError pattern as sign-in. */
export async function requestPasswordReset(email: string): Promise<void> {
  const redirectTo = typeof window !== 'undefined'
    ? window.location.origin + window.location.pathname
    : '';
  await authCall(
    `/auth/v1/recover?redirect_to=${encodeURIComponent(redirectTo)}`,
    { email },
  );
}

/** Change the signed-in account's password (GoTrue user update with
 *  the session JWT). Phase 3 account settings. */
export async function changePassword(newPassword: string): Promise<void> {
  const s = currentSession();
  if (!s) throw new Error('Sign in first — password changes need your session.');
  if (newPassword.length < 6) throw new Error('Password should be at least 6 characters.');
  await authCall('/auth/v1/user', { password: newPassword }, s.accessToken, 'PUT');
}

export async function signOut(): Promise<void> {
  const s = currentSession();
  if (s) {
    try { await authCall('/auth/v1/logout', {}, s.accessToken); } catch { /* local sign-out still proceeds */ }
  }
  setSession(null);
}

// ---------------------------------------------------------------------------
// Token provision for supabase.ts + refresh
// ---------------------------------------------------------------------------

let refreshInFlight: Promise<AuthSession | null> | null = null;

async function refreshSession(): Promise<AuthSession | null> {
  const s = currentSession();
  if (!s?.refreshToken) return null;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const data = (await authCall('/auth/v1/token?grant_type=refresh_token', {
          refresh_token: s.refreshToken,
        })) as TokenResponse;
        const next = toSession(data);
        setSession(next);
        return next;
      } catch {
        // A dead refresh token means the session is over — clear it so
        // the UI returns to signed-out instead of retrying forever.
        setSession(null);
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

/** The access token supabase.ts sends: the session's JWT, transparently
 *  refreshed when it is about to expire; null when signed out. */
export async function validAccessToken(): Promise<string | null> {
  const s = currentSession();
  if (!s) return null;
  if (!sessionNeedsRefresh(s, Date.now())) return s.accessToken;
  const next = await refreshSession();
  return next?.accessToken ?? null;
}

setAuthTokenProvider(validAccessToken);

// ---------------------------------------------------------------------------
// OAuth + boot
// ---------------------------------------------------------------------------

/** Leave for the provider; returns via the URL hash (see initAuth). */
export function signInWithProvider(provider: 'google' | 'github'): void {
  const redirectTo = window.location.origin + window.location.pathname;
  window.location.href = providerAuthorizeUrl(provider, redirectTo);
}

/**
 * Boot step (App calls this once): complete an OAuth return if the URL
 * carries one, otherwise restore the stored session and refresh it if
 * it is near expiry. Returns a user-facing error message to toast, or
 * null. Never throws — auth trouble must not block local editing.
 */
export async function initAuth(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && window.location.hash) {
      const cb = parseAuthCallbackHash(window.location.hash);
      if (cb?.kind === 'error') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        return `Sign-in did not complete: ${cb.message}`;
      }
      if (cb?.kind === 'tokens') {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        const me = (await authCall('/auth/v1/user', undefined, cb.accessToken)) as { id: string; email?: string };
        setSession({
          accessToken: cb.accessToken,
          refreshToken: cb.refreshToken,
          expiresAt: Date.now() + cb.expiresIn * 1000,
          user: { id: me.id, email: me.email ?? '' },
        });
        return null;
      }
    }
    const s = currentSession();
    if (s && sessionNeedsRefresh(s, Date.now())) {
      await refreshSession();
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
