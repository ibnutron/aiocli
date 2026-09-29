import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { stdout } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiRequest, clearAuth, readAuth, serverUrl, writeAuth } from '../config.js';
import { PROVIDERS, activeSelection, isConnected, resolveProvider } from '../providers.js';
import { checkLogin, expiryLabel } from '../loginStatus.js';

interface LoginOptions {
  server?: string;
  browser?: boolean;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  token?: string;
  kind?: 'login' | 'setup-token';
  expires_at?: string | null;
  user?: { name: string; email: string };
  error?: string;
}

type ApprovedToken = Required<Pick<TokenResponse, 'token' | 'user'>> & TokenResponse;

/**
 * Device authorization flow: print a code, the user approves it in a browser
 * where they are already signed in to aiolah, and we receive a token scoped to
 * the CLI. No password or API key ever touches the terminal.
 */
export async function loginCommand(options: LoginOptions): Promise<void> {
  const server = (options.server ?? serverUrl(null)).replace(/\/+$/, '');
  const approved = await deviceFlow(server, 'login', options.browser !== false);
  writeAuth({ server, token: approved.token, user: approved.user, expiresAt: approved.expires_at ?? null });
  stdout.write(`\nLogged in as ${approved.user.name} <${approved.user.email}> on ${server}.\n`);
}

/**
 * `aiolah setup-token` (like `claude setup-token`): the same browser approval,
 * but the result is a long-lived token for CI and scripts. It is printed, not
 * saved; set it as AIOLAH_TOKEN where you want to use it. It can only make
 * model requests (no remote control, devices or session sync).
 */
export async function setupTokenCommand(options: LoginOptions): Promise<void> {
  const server = (options.server ?? serverUrl(null)).replace(/\/+$/, '');
  const approved = await deviceFlow(server, 'setup-token', options.browser !== false);
  const until = approved.expires_at ? ` It is valid until ${new Date(approved.expires_at).toUTCString()}.` : '';
  stdout.write(
    `\nLong-lived token for ${approved.user.email} on ${server}:\n\n  ${approved.token}\n\n` +
      `It is not saved anywhere. Set it as AIOLAH_TOKEN where you want to use it, e.g.\n` +
      `  export AIOLAH_TOKEN=<token>        (macOS, Linux, WSL)\n` +
      `  $env:AIOLAH_TOKEN = "<token>"      (PowerShell)\n` +
      `It can only make model requests (no remote control).${until}\n`,
  );
}

async function deviceFlow(
  server: string,
  kind: 'login' | 'setup-token',
  openInBrowser: boolean,
): Promise<ApprovedToken> {
  const start = await apiRequest<DeviceCodeResponse>(server, '/api/v1/app/cli/device-codes', {
    method: 'POST',
    body: { machine_name: hostname(), kind },
  });
  if (start.status !== 200) {
    throw new Error(`Could not start login on ${server} (HTTP ${start.status}).`);
  }
  const codes = start.data;

  stdout.write(
    `\nTo sign in, open:\n\n  ${codes.verification_uri_complete}\n\n` +
      `and confirm this code: ${codes.user_code}\n\nWaiting for approval… (Ctrl+C to cancel)\n`,
  );
  if (openInBrowser) {
    openBrowser(codes.verification_uri_complete);
  }

  const deadline = Date.now() + codes.expires_in * 1000;
  let interval = codes.interval * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await apiRequest<TokenResponse>(server, '/api/v1/app/cli/device-codes/token', {
      method: 'POST',
      body: { device_code: codes.device_code },
    });

    if (poll.status === 200 && poll.data.token && poll.data.user) {
      return poll.data as ApprovedToken;
    }
    if (poll.status === 428) {
      continue;
    }
    if (poll.status === 429) {
      interval += 5000;
      continue;
    }
    if (poll.status === 403) {
      throw new Error('Login was denied in the browser.');
    }
    if (poll.status === 410) {
      break;
    }
    throw new Error(`Unexpected response while waiting for approval (HTTP ${poll.status}).`);
  }

  throw new Error(`The login code expired. Run \`aiolah ${kind === 'login' ? 'auth login' : 'setup-token'}\` again.`);
}

export async function logoutCommand(): Promise<void> {
  const auth = readAuth();
  if (!auth) {
    stdout.write('Not logged in.\n');
    return;
  }
  try {
    await apiRequest(auth.server, '/api/v1/app/cli/token', { method: 'DELETE', token: auth.token });
  } catch {
    // Offline: still forget the token locally; it can be revoked from the web app.
  }
  clearAuth();
  stdout.write(`Logged out from ${auth.server}.\n`);
}

export async function statusCommand(): Promise<void> {
  const auth = readAuth();
  const active = activeSelection();
  const connected = PROVIDERS.filter((provider) => provider.kind !== 'aiolah' && isConnected(provider.id));
  stdout.write(
    `Active provider: ${resolveProvider()}${active?.model ? ` · ${active.model}` : ''}\n` +
      `Own keys: ${
        connected.length ? connected.map((provider) => provider.id).join(', ') : 'none (aiolah connect <provider>)'
      }\n`,
  );
  if (process.env.ANTHROPIC_API_KEY) {
    stdout.write('Model calls: ANTHROPIC_API_KEY is set, so chat uses your own Anthropic key.\n');
  }
  if (!auth) {
    stdout.write('Not logged in to aiolah. Run `aiolah auth login`.\n');
    process.exitCode = 1;
    return;
  }
  const state = await checkLogin(auth);
  const source = auth.kind === 'setup-token' ? 'AIOLAH_TOKEN' : 'Login';
  if (!state?.valid || !state.user) {
    stdout.write(
      state
        ? `${source}: ${expiryLabel(state)} (${auth.server}). Run \`aiolah auth login\`.\n`
        : `Could not reach ${auth.server} to check the login.\n`,
    );
    process.exitCode = 1;
    return;
  }
  stdout.write(
    `Logged in as ${state.user.name} <${state.user.email}> on ${auth.server}.\n${source}: ${expiryLabel(state)}\n`,
  );
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Headless machine: the URL above is enough.
  }
}
