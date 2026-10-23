/**
 * Sign-in form for an authenticated engine.
 *
 * Used in two places, which is why it is its own component:
 *
 *   1. the connect dialog, between probing (which reveals `authRequired`) and
 *      listing cubes; and
 *   2. the re-sign-in dialog, when a query comes back 401 because the session
 *      expired mid-use.
 *
 * The token never comes back to the browser — the Plateau server keeps it — so this
 * form only ever gets the user, roles and expiry. That is deliberate: a bearer
 * credential should not be in page memory, browser storage, or a screenshot.
 */

import { useState } from 'react';
import { ApiError, loginToEngine, type EngineSessionInfo } from '../api';

interface EngineLoginFormProps {
  url: string;
  /** Pre-fills the user name when one is already known (a re-login). */
  initialUser?: string;
  submitLabel?: string;
  /** Autofocus the user field; false in a dialog that opens on a retry. */
  autoFocus?: boolean;
  onSuccess: (session: EngineSessionInfo) => void;
}

export function EngineLoginForm({
  url,
  initialUser = '',
  submitLabel = 'Sign in',
  autoFocus = true,
  onSuccess,
}: EngineLoginFormProps) {
  const [user, setUser] = useState(initialUser);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!user.trim() || !password) {
      setError('Enter both a user name and a password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const session = await loginToEngine(url, user.trim(), password);
      setPassword('');
      onSuccess(session);
    } catch (loginError) {
      // The engine returns ONE message for wrong user and wrong password, on
      // purpose, and there is no point pretending otherwise.
      const message =
        loginError instanceof ApiError
          ? loginError.message
          : loginError instanceof Error
            ? loginError.message
            : 'Sign-in failed';
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="engine-login" onSubmit={submit}>
      <p className="engine-login-note">
        This engine requires a sign-in. Plateau signs in on your behalf and keeps the
        session; your password is not stored.
      </p>
      <div className="engine-login-fields">
        <label>
          <span>User</span>
          <input
            type="text"
            autoComplete="username"
            value={user}
            autoFocus={autoFocus}
            disabled={busy}
            data-testid="engine-user"
            onChange={(event) => setUser(event.target.value)}
          />
        </label>
        <label>
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            disabled={busy}
            data-testid="engine-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="engine-login-error" role="alert" data-testid="engine-login-error">
          {error}
        </p>
      )}
      <div className="engine-login-actions">
        <button type="submit" className="button-primary" disabled={busy} data-testid="engine-login-submit">
          {busy ? 'Signing in' : submitLabel}
        </button>
      </div>
    </form>
  );
}
