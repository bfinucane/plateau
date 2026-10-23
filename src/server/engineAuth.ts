/**
 * Engine sessions: the login token, held server-side.
 *
 * Plateau's SERVER is the engine's client, so this is where a bearer token lives.
 * It never enters the browser: the login route returns the user, roles and expiry,
 * and the token itself stays in this process's memory. That satisfies the handover's
 * storage rules without asking a browser to hold a credential for a backend it
 * cannot reach directly.
 *
 * Two deliberate choices:
 *
 *   1. **Keyed by engine URL.** One Plateau server can hold sessions for several
 *      engines (a dev engine here, another there), and a token for one must never be
 *      sent to another.
 *   2. **Expiry is checked on read, not on a timer.** A session past `expiresAt` is
 *      dropped when next asked for, so an idle process does not keep a dead token
 *      around and a clock jump cannot leave one armed.
 *
 * There is no logout endpoint on the engine (yet); dropping the token is the client
 * half of logging out, and the engine's in-memory session expires on its own.
 */

import { ProtocolError, type LoginResponse } from '../core/protocol.js';
import { HttpEngineTransport } from './httpTransport.js';

/** What a login hands back to the UI: everything except the token. */
export interface EngineSessionInfo {
  user: string;
  roles: string[];
  /** Unix timestamp in SECONDS, as the engine reports it. */
  expiresAt: number;
}

interface StoredSession extends EngineSessionInfo {
  token: string;
}

/** Sessions by normalised engine URL. */
const sessions = new Map<string, StoredSession>();

/** Normalises an engine URL the same way the transport does. */
function keyFor(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Five seconds of slack: a token about to expire is treated as expired. */
const EXPIRY_SKEW_MS = 5_000;

/** Public view of the session for an engine, or null when there is no LIVE one. */
export function sessionInfo(url: string): EngineSessionInfo | null {
  // Ask for the token first: that is what drops an expired session, so this cannot
  // report a sign-in as valid after it has effectively ended.
  if (tokenFor(url) === undefined) return null;
  const session = sessions.get(keyFor(url));
  if (!session) return null;
  return { user: session.user, roles: session.roles, expiresAt: session.expiresAt };
}

/** True when a live session exists for the engine. */
export function isAuthenticated(url: string): boolean {
  return tokenFor(url) !== undefined;
}

/**
 * The bearer token for an engine, or undefined.
 *
 * An expired session is forgotten here rather than returned, so the next request
 * goes out unauthenticated and the engine answers 401 — the single, honest signal
 * that the UI turns into "sign in again".
 */
export function tokenFor(url: string): string | undefined {
  const key = keyFor(url);
  const session = sessions.get(key);
  if (!session) return undefined;

  const expiresAtMs = session.expiresAt * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - EXPIRY_SKEW_MS <= Date.now()) {
    sessions.delete(key);
    return undefined;
  }
  return session.token;
}

/** Forgets a session: logout, or a 401 proving the token is dead. */
export function dropSession(url: string): void {
  sessions.delete(keyFor(url));
}

/**
 * Logs in to an engine and keeps the token server-side.
 *
 * The response's token is validated before being stored: a 200 without a usable
 * token is a broken engine, and storing `undefined` would turn every later request
 * into a confusing anonymous one.
 */
export async function loginToEngine(
  url: string,
  user: string,
  password: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EngineSessionInfo> {
  const key = keyFor(url);
  if (!key) {
    throw new ProtocolError('invalid_argument', 'An engine URL is required to sign in.');
  }
  if (!user.trim()) {
    throw new ProtocolError('invalid_argument', 'A user name is required.');
  }

  const transport = new HttpEngineTransport({
    baseUrl: key,
    timeoutMs: options.timeoutMs ?? 10_000,
    fetchImpl: options.fetchImpl,
  });

  if (typeof transport.login !== 'function') {
    throw new ProtocolError(
      'engine_error',
      'This engine does not expose a login route, so it cannot be signed in to.',
    );
  }

  const response: LoginResponse = await transport.login({ user, password });
  if (typeof response?.token !== 'string' || response.token.length === 0) {
    throw new ProtocolError(
      'engine_error',
      'The engine accepted the login but returned no token.',
    );
  }

  const info: EngineSessionInfo = {
    user: typeof response.user === 'string' && response.user ? response.user : user,
    roles: Array.isArray(response.roles) ? response.roles.map(String) : [],
    // A missing/garbled expiry is treated as "now", so the token is not trusted
    // indefinitely: re-login is cheap, a stale credential is not.
    expiresAt: Number.isFinite(response.expiresAt) ? Number(response.expiresAt) : 0,
  };

  sessions.set(key, { ...info, token: response.token });
  return info;
}

/** Test helper: forget every session (no production caller). */
export function resetEngineSessions(): void {
  sessions.clear();
}
