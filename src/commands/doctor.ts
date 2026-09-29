import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdout } from 'node:process';
import { expiryLabel, loginNotice } from '../loginStatus.js';
import { apiRequest, readAuth, relayHostUrl, serverUrl } from '../config.js';
import { activeSelection, isConnected, providerDef, resolveProvider } from '../providers.js';
import { compareVersions, fetchRegistryInfo, isNpmInstall, packageRoot, packageVersion } from '../version.js';

type Status = 'ok' | 'warn' | 'fail';

const MARKS: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' };

/**
 * `aiolah doctor` — checks the install, credentials and connectivity to
 * aiolah (API, login, models, relay). Exits with code 1 when a check fails.
 */
export async function doctorCommand(): Promise<void> {
  let failed = false;
  const report = (status: Status, label: string, detail: string) => {
    failed ||= status === 'fail';
    stdout.write(`${MARKS[status]} ${label.padEnd(14)} ${detail}\n`);
  };

  const version = packageVersion();
  report(
    'ok',
    'Version',
    `aiolah ${version} (${isNpmInstall() ? 'npm install' : 'source checkout'} at ${packageRoot()})`,
  );

  try {
    const { latest } = await fetchRegistryInfo();
    if (!latest) {
      report('warn', 'Update', 'not published on npm yet');
    } else if (compareVersions(version, latest) < 0) {
      report('warn', 'Update', `${latest} is available — run "aiolah upgrade"`);
    } else {
      report('ok', 'Update', `up to date (npm latest ${latest})`);
    }
  } catch (error) {
    report('warn', 'Update', `could not reach the npm registry (${message(error)})`);
  }

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  report(
    nodeMajor >= 22 ? 'ok' : 'fail',
    'Node.js',
    `${process.versions.node}${nodeMajor >= 22 ? '' : ' — aiolah needs Node.js 22 or newer'}`,
  );

  const auth = readAuth();
  const server = serverUrl(auth);

  const provider = resolveProvider();
  const def = providerDef(provider);
  if (def.kind === 'aiolah') {
    report(
      auth ? 'ok' : 'fail',
      'Model calls',
      auth
        ? 'through aiolah with your login (billed to your plan)'
        : 'no credentials — run "aiolah auth login" or "aiolah connect <provider>"',
    );
  } else if (isConnected(provider)) {
    report(
      'ok',
      'Model calls',
      `${def.name} with your own key${activeSelection()?.model ? ` · ${activeSelection()?.model}` : ''}`,
    );
  } else {
    report('fail', 'Model calls', `${def.name} is selected but has no key — run "aiolah connect ${provider}"`);
  }

  const authFile = join(homedir(), '.aiolah', 'auth.json');
  if (auth) {
    const mode = statSync(authFile).mode & 0o777;
    report(
      process.platform === 'win32' || mode === 0o600 ? 'ok' : 'warn',
      'Credentials',
      process.platform === 'win32' || mode === 0o600
        ? authFile
        : `${authFile} has mode ${mode.toString(8)} — run "chmod 600 ${authFile}"`,
    );
  }

  try {
    const up = await fetch(`${server}/up`);
    report(up.ok ? 'ok' : 'fail', 'Server', `${server} (HTTP ${up.status})`);
  } catch (error) {
    report('fail', 'Server', `${server} unreachable (${message(error)})`);
  }

  if (auth) {
    try {
      const me = await apiRequest<{ user?: { email: string }; expires_at?: string | null }>(
        server,
        '/api/v1/app/cli/me',
        { token: auth.token },
      );
      if (me.status === 200 && me.data.user) {
        const state = {
          valid: true,
          expiresAt: me.data.expires_at ? new Date(me.data.expires_at) : null,
          kind: auth.kind ?? 'login',
        } as const;
        const warning = loginNotice(state);
        const detail = `signed in as ${me.data.user.email}, ${warning ?? expiryLabel(state)}`;
        report(warning ? 'warn' : 'ok', 'Login', detail);
        const models = await apiRequest<{ default: string | null; data: unknown[] }>(server, '/api/cli/models', {
          token: auth.token,
        });
        if (models.status === 200 && models.data.data.length > 0) {
          report('ok', 'Models', `${models.data.data.length} available, default ${models.data.default}`);
        } else {
          report(
            models.status === 200 ? 'warn' : 'fail',
            'Models',
            models.status === 200 ? 'none available for your plan' : `HTTP ${models.status}`,
          );
        }
      } else {
        report(
          'fail',
          'Login',
          me.status === 401
            ? `expired or revoked — run "aiolah ${auth.kind === 'setup-token' ? 'setup-token' : 'auth login'}"`
            : `token rejected (HTTP ${me.status}) — run "aiolah auth login"`,
        );
      }
    } catch (error) {
      report('fail', 'Login', `could not verify (${message(error)})`);
    }

    const relayHealth = relayHostUrl(server)
      .replace(/^ws/i, 'http')
      .replace(/\/host$/, '/health');
    try {
      const relay = await fetch(relayHealth);
      report(
        relay.ok ? 'ok' : 'warn',
        'Relay',
        `${relayHealth} (HTTP ${relay.status})${relay.ok ? '' : ' — "aiolah rc" will not connect'}`,
      );
    } catch (error) {
      report('warn', 'Relay', `${relayHealth} unreachable (${message(error)}) — "aiolah rc" will not connect`);
    }
  } else {
    report('warn', 'Login', 'not signed in to aiolah — run "aiolah auth login"');
  }

  stdout.write(failed ? '\nSome checks failed.\n' : '\nAll required checks passed.\n');
  if (failed) {
    process.exitCode = 1;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
}
