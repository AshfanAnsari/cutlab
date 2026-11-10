import { useEffect, useRef, useState } from 'react';
import { store } from '../state/store';
import {
  requestPasswordReset, signInWithEmail, signInWithProvider, signUpWithEmail,
} from '../services/auth';
import logoMark from '../assets/logo-mark.png';

/** Sign-in / create-account / reset dialog — AUTH REDESIGN 2026-11-06.
 *
 *  Split layout in CutLab's own skin (P1 charcoal + Signal Red, the one
 *  accent): a brand panel carrying the logo, the Fraunces wordmark and
 *  the landing start page's timeline-horizon base; the form panel
 *  carries real provider glyphs, stacked labelled fields, inline
 *  validation and one red primary. On narrow screens the brand panel
 *  collapses to a slim header band and the form stays fully usable.
 *
 *  Auth behaviour is unchanged from the previous surface: email
 *  sign-in / sign-up and the Google + GitHub provider flow ride the
 *  same services/auth calls (GoTrue), with the same toasts and the
 *  same confirmation-note path. The Forgot flow is new UI over the
 *  new requestPasswordReset service call (GoTrue /recover) — the old
 *  modal had no reset flow at all. Local editing never needs this
 *  dialog; it exists only for the cloud features. */

type Mode = 'signin' | 'signup' | 'forgot' | 'forgot-sent';
type Provider = 'google' | 'github';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function emailProblem(value: string): string {
  const v = value.trim();
  if (!v) return 'Enter your email address.';
  if (!EMAIL_RE.test(v)) return 'Enter a valid email address.';
  return '';
}

function passwordProblem(value: string, mode: Mode): string {
  if (!value) return mode === 'signup' ? 'Choose a password (6+ characters).' : 'Enter your password.';
  if (mode === 'signup' && value.length < 6) return 'Use at least 6 characters.';
  return '';
}

/** The real Google "G" glyph (official four-colour paths). */
function GoogleGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-.95.66-2.23 1.08-4.07 1.08-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.30 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.21A7.20 7.20 0 0 1 4.89 12c0-.77.14-1.52.38-2.21V6.70H1.29A11.98 11.98 0 0 0 0 12c0 1.94.46 3.77 1.29 5.30l3.98-3.09z" />
      <path fill="#EA4335" d="M12 4.83c1.76 0 3.35.61 4.60 1.80l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.70 1.29 6.70l3.98 3.09C6.22 6.94 8.87 4.83 12 4.83z" />
    </svg>
  );
}

/** The real GitHub mark (Octicons mark-github path). */
function GitHubGlyph() {
  return (
    <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69 1.31 0 .72.01 1.3.01 1.51 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="3.5" y1="3.5" x2="20.5" y2="20.5" />}
    </svg>
  );
}

/** The timeline-horizon base from the landing start page, miniaturised:
 *  ruler ticks, dim clip blocks, one Signal Red playhead. Purely
 *  decorative; identical motif, no new artwork. */
function TimelineHorizon() {
  const clips = [
    { w: '16%', alt: false }, { w: '10%', alt: true }, { w: '20%', alt: false },
    { w: '12%', alt: true }, { w: '22%', alt: false }, { w: '10%', alt: false },
    { w: '14%', alt: true }, { w: '18%', alt: false },
  ];
  return (
    <div className="auth-horizon" aria-hidden="true">
      <div className="auth-horizon-line" />
      <div className="auth-horizon-ruler" />
      <div className="auth-horizon-clips">
        {clips.map((c, i) => (
          <span key={i} className={'auth-horizon-clip' + (c.alt ? ' alt' : '')} style={{ width: c.w }} />
        ))}
      </div>
      <div className="auth-horizon-playhead"><span className="auth-horizon-glow" /></div>
    </div>
  );
}

const TITLES: Record<Mode, { title: string; sub: string }> = {
  signin: {
    title: 'Sign in',
    sub: 'Welcome back. Your cloud projects, renders and history are tied to your account.',
  },
  signup: {
    title: 'Create your account',
    sub: 'One account for cloud projects, renders and history. Local editing never needs one.',
  },
  forgot: {
    title: 'Reset your password',
    sub: 'Enter the email you signed up with and we’ll send a link to set a new password.',
  },
  'forgot-sent': {
    title: 'Check your email',
    sub: 'If an account exists for that address, a password-reset link is on its way. Open it on this device, then sign in here with the new password.',
  },
};

export default function AuthModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState<Provider | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState<{ email?: boolean; password?: boolean }>({});
  const [submitted, setSubmitted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Focus: land on the first field, trap Tab inside the dialog, close
  // on Escape, and hand focus back to whatever opened the modal.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    emailRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
    // onClose is stable enough for this mount-only effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emailErr = emailProblem(email);
  const passwordErr = mode === 'forgot' || mode === 'forgot-sent' ? '' : passwordProblem(password, mode);
  const formValid = !emailErr && !passwordErr;
  const showEmailErr = (touched.email || submitted) && emailErr !== '';
  const showPasswordErr = (touched.password || submitted) && passwordErr !== '';

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setNote('');
    setTouched({});
    setSubmitted(false);
    requestAnimationFrame(() => emailRef.current?.focus());
  }

  function startOAuth(provider: Provider) {
    setError('');
    setOauthBusy(provider);
    try {
      // Leaves for the provider; returns via the URL hash (initAuth).
      signInWithProvider(provider);
    } catch {
      setOauthBusy(null);
      setError(`Couldn’t start ${provider === 'google' ? 'Google' : 'GitHub'} sign-in — check the connection and try again.`);
    }
  }

  async function submit() {
    if (busy) return;
    setSubmitted(true);
    if (!formValid) return;
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (mode === 'signin') {
        const s = await signInWithEmail(email.trim(), password);
        store.toastMsg('info', `Signed in as ${s.user.email}.`);
        onClose();
      } else if (mode === 'signup') {
        const r = await signUpWithEmail(email.trim(), password);
        if (r.session) {
          store.toastMsg('info', `Account created — signed in as ${r.session.user.email}.`);
          onClose();
        } else {
          setNote('Account created. Your email needs confirming before the first sign-in — open the confirmation email, then sign in here.');
          switchMode('signin');
        }
      } else if (mode === 'forgot') {
        await requestPasswordReset(email.trim());
        setMode('forgot-sent');
        setSubmitted(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const primaryLabel = busy
    ? (mode === 'signin' ? 'Signing in…' : mode === 'signup' ? 'Creating account…' : 'Sending link…')
    : (mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link');
  const { title, sub } = TITLES[mode];

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="auth-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="auth-close" onClick={onClose} aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" />
          </svg>
        </button>

        {/* LEFT — brand panel (slim header band on narrow screens) */}
        <aside className="auth-brand">
          <div className="auth-brand-top">
            <img src={logoMark} alt="" width={34} height={34} draggable={false} />
            <span className="auth-wordmark">CutLab</span>
          </div>
          <p className="auth-brand-line">Your video editor, in the browser.</p>
          <span className="auth-brand-beta">Free during beta</span>
          <TimelineHorizon />
        </aside>

        {/* RIGHT — form panel */}
        <section className="auth-form">
          <h2 id="auth-title" className="auth-title">{title}</h2>
          <p className="auth-sub">{sub}</p>

          {mode === 'forgot-sent' ? (
            <>
              <div className="auth-notebox" role="status">
                Reset link sent to <strong>{email.trim()}</strong>. The link expires after a while —
                if it never arrives, check spam, then request a fresh one.
              </div>
              <button className="auth-primary" onClick={() => switchMode('signin')}>
                Back to sign in
              </button>
              <p className="auth-switch">
                Wrong address?{' '}
                <button className="auth-link" onClick={() => switchMode('forgot')}>Use a different email</button>
              </p>
            </>
          ) : (
            <>
              {mode !== 'forgot' && (
                <>
                  <div className="auth-oauth-row">
                    <button
                      type="button"
                      className="auth-oauth"
                      disabled={oauthBusy !== null || busy}
                      onClick={() => startOAuth('google')}
                    >
                      <span className="auth-oauth-glyph"><GoogleGlyph /></span>
                      <span className="auth-oauth-label">
                        {oauthBusy === 'google' ? 'Opening Google…' : 'Continue with Google'}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="auth-oauth"
                      disabled={oauthBusy !== null || busy}
                      onClick={() => startOAuth('github')}
                    >
                      <span className="auth-oauth-glyph"><GitHubGlyph /></span>
                      <span className="auth-oauth-label">
                        {oauthBusy === 'github' ? 'Opening GitHub…' : 'Continue with GitHub'}
                      </span>
                    </button>
                  </div>
                  <div className="auth-divider" aria-hidden="true">
                    <span className="auth-divider-line" />
                    <span className="auth-divider-text">or with email</span>
                    <span className="auth-divider-line" />
                  </div>
                </>
              )}

              <form
                noValidate
                onSubmit={(e) => { e.preventDefault(); void submit(); }}
              >
                <div className="auth-field">
                  <label className="auth-label" htmlFor="auth-email">Email</label>
                  <input
                    ref={emailRef}
                    id="auth-email"
                    type="email"
                    className="auth-input"
                    autoComplete="email"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="you@studio.com"
                    value={email}
                    aria-invalid={showEmailErr || undefined}
                    aria-describedby={showEmailErr ? 'auth-email-err' : undefined}
                    onChange={(e) => setEmail(e.target.value)}
                    onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                  />
                  {/* The slot is always rendered (fixed height) so a
                      validation message never shifts the layout —
                      found in QA: a blur-triggered error appearing
                      between mousedown and mouseup moved the clicked
                      button and the click missed. */}
                  <div className="auth-field-err-slot">
                    {showEmailErr && <p className="auth-field-err" id="auth-email-err">{emailErr}</p>}
                  </div>
                </div>

                {mode !== 'forgot' && (
                  <div className="auth-field">
                    <label className="auth-label" htmlFor="auth-password">Password</label>
                    <div className="auth-pw-wrap">
                      <input
                        id="auth-password"
                        type={showPw ? 'text' : 'password'}
                        className="auth-input auth-input-pw"
                        autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                        placeholder={mode === 'signup' ? 'At least 6 characters' : 'Your password'}
                        value={password}
                        aria-invalid={showPasswordErr || undefined}
                        aria-describedby={showPasswordErr ? 'auth-password-err' : undefined}
                        onChange={(e) => setPassword(e.target.value)}
                        onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                      />
                      <button
                        type="button"
                        className="auth-eye"
                        aria-label={showPw ? 'Hide password' : 'Show password'}
                        aria-pressed={showPw}
                        onClick={() => setShowPw((v) => !v)}
                      >
                        <EyeIcon off={showPw} />
                      </button>
                    </div>
                    <div className="auth-field-err-slot">
                      {showPasswordErr && <p className="auth-field-err" id="auth-password-err">{passwordErr}</p>}
                    </div>
                    {mode === 'signin' && (
                      <div className="auth-forgot-row">
                        <button type="button" className="auth-link auth-link-small"
                          onClick={() => switchMode('forgot')}>
                          Forgot password?
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {error && (
                  <div className="auth-alert" role="alert">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="auth-alert-icon">
                      <circle cx="12" cy="12" r="9.2" />
                      <path d="M12 7.5V13" />
                      <path d="M12 16.4v.1" />
                    </svg>
                    <span>{error}</span>
                  </div>
                )}
                {note && <div className="auth-notebox" role="status">{note}</div>}

                <button
                  type="submit"
                  className="auth-primary"
                  disabled={busy || oauthBusy !== null || !formValid}
                >
                  {busy && <span className="auth-spinner" aria-hidden="true" />}
                  {primaryLabel}
                </button>
              </form>

              <p className="auth-switch">
                {mode === 'signin' && (
                  <>New to CutLab?{' '}
                    <button className="auth-link" onClick={() => switchMode('signup')}>Create an account</button>
                  </>
                )}
                {mode === 'signup' && (
                  <>Already have an account?{' '}
                    <button className="auth-link" onClick={() => switchMode('signin')}>Sign in</button>
                  </>
                )}
                {mode === 'forgot' && (
                  <>Remembered it?{' '}
                    <button className="auth-link" onClick={() => switchMode('signin')}>Back to sign in</button>
                  </>
                )}
              </p>
              <p className="auth-fineprint">
                Editing on this device works signed out — nothing local changes either way.
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
