import { apiRequest, rememberExpiry, readAuth, type StoredAuth } from './config.js';

/** Shown at startup when the login ends within this many days (as in Claude Code). */
const WARN_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export const LOGIN_EXPIRED_MESSAGE = 'Login expired · Please run `aiolah auth login`';

const SETUP_TOKEN_EXPIRED_MESSAGE = 'AIOLAH_TOKEN expired or was revoked · create a new one with `aiolah setup-token`';

/** What to tell the user when aiolah rejects the token in use (401). */
export function expiredMessage(): string {
  return process.env.AIOLAH_TOKEN?.trim() ? SETUP_TOKEN_EXPIRED_MESSAGE : LOGIN_EXPIRED_MESSAGE;
}

interface MeResponse {
  user?: { name: string; email: string };
  expires_at?: string | null;
  kind?: 'login' | 'setup-token';
}

export interface LoginState {
  valid: boolean;
  expiresAt: Date | null;
  kind: 'login' | 'setup-token';
  user?: { name: string; email: string };
}

/**
 * Asks aiolah about the login in use. The call itself extends a login (the
 * server renews it while it is used), and the new expiry is saved locally.
 * Null when not signed in or aiolah can't be reached.
 */
export async function checkLogin(auth: StoredAuth | null = readAuth()): Promise<LoginState | null> {
  if (!auth) {
    return null;
  }
  try {
    const me = await apiRequest<MeResponse>(auth.server, '/api/v1/app/cli/me', { token: auth.token });
    if (me.status === 401) {
      return { valid: false, expiresAt: auth.expiresAt ? new Date(auth.expiresAt) : null, kind: auth.kind ?? 'login' };
    }
    if (me.status !== 200) {
      return null;
    }
    rememberExpiry(me.data.expires_at);
    return {
      valid: true,
      expiresAt: me.data.expires_at ? new Date(me.data.expires_at) : null,
      kind: me.data.kind ?? auth.kind ?? 'login',
      user: me.data.user,
    };
  } catch {
    return null;
  }
}

/** Startup notice: the warning a few days before expiry, or that the login has expired. */
export function loginNotice(state: LoginState | null): string | null {
  if (!state) {
    return null;
  }
  if (!state.valid) {
    return state.kind === 'setup-token' ? SETUP_TOKEN_EXPIRED_MESSAGE : LOGIN_EXPIRED_MESSAGE;
  }
  const days = daysLeft(state.expiresAt);
  if (days === null || days > WARN_DAYS) {
    return null;
  }
  const what = state.kind === 'setup-token' ? 'token' : 'login';
  const renew =
    state.kind === 'setup-token' ? 'run aiolah setup-token for a new one' : 'run aiolah auth login to renew';
  const when = days <= 1 ? 'less than a day' : `${days} days`;
  return `Your ${what} expires in ${when} · ${renew}`;
}

/** "valid until 29 Oct 2026 (30 days)" or "Expired — log in again", for /status and `aiolah auth status`. */
export function expiryLabel(state: LoginState | null): string {
  if (!state) {
    return 'unknown (aiolah not reachable)';
  }
  if (!state.valid) {
    return 'Expired — log in again';
  }
  if (!state.expiresAt) {
    return 'does not expire';
  }
  const days = daysLeft(state.expiresAt) ?? 0;
  const date = state.expiresAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const renewal = state.kind === 'login' ? ', extended while you use it' : '';
  return `valid until ${date} (${days <= 1 ? 'less than a day' : `${days} days`}${renewal})`;
}

function daysLeft(expiresAt: Date | null): number | null {
  return expiresAt ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / DAY_MS)) : null;
}
