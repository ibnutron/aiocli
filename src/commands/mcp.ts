import { stdout } from 'node:process';
import { resolve } from 'node:path';
import {
  MCP_SCOPES,
  addMcpServer,
  describeConfig,
  projectChoices,
  removeMcpServer,
  saveProjectChoices,
  type McpScope,
  type McpServerConfig,
} from '../mcp/config.js';
import { formatMcpStatus, startMcp } from '../mcp/index.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { expandConfig, isRemoteServer, readMcpServers } from '../mcp/config.js';
import { StoredOAuthProvider, forgetOAuth, listenForAuthorizationCode } from '../mcp/oauth.js';
import { McpManager } from '../mcp/manager.js';
import { openBrowser } from './login.js';
import { style } from '../ui.js';

interface WorkspaceOptions {
  workspace: string;
}

interface AddOptions extends WorkspaceOptions {
  scope: string;
  transport: string;
  env?: string[];
  header?: string[];
}

interface RemoveOptions extends WorkspaceOptions {
  scope?: string;
}

const TRANSPORTS = ['stdio', 'http', 'sse'];

/** Collects a repeatable option (`-e A=1 -e B=2`). */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseScope(scope: string): McpScope {
  if (!(MCP_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`--scope must be one of: ${MCP_SCOPES.join(', ')}.`);
  }
  return scope as McpScope;
}

/** `KEY=value` pairs (env) or `Name: value` pairs (headers) into an object. */
function pairs(values: string[] | undefined, separator: '=' | ':', label: string): Record<string, string> | undefined {
  if (!values?.length) {
    return undefined;
  }
  return Object.fromEntries(
    values.map((value) => {
      const at = value.indexOf(separator);
      if (at < 1) {
        throw new Error(`${label} must look like ${separator === '=' ? 'KEY=value' : '"Name: value"'}: ${value}`);
      }
      return [value.slice(0, at).trim(), value.slice(at + 1).trim()];
    }),
  );
}

/** `aiolah mcp list`: every server visible here, started (approved ones only) to check it works. */
export async function mcpListCommand(options: WorkspaceOptions): Promise<void> {
  const manager = await startMcp(resolve(options.workspace), { ask: false });
  try {
    stdout.write(`${formatMcpStatus(manager.status)}\n`);
  } finally {
    await manager.close();
  }
}

/**
 * `aiolah mcp add <name> <command|url> [args…]`, like `claude mcp add`:
 * stdio by default (`aiolah mcp add boost -- php artisan boost:mcp`), or
 * `--transport http|sse` with a URL.
 */
export async function mcpAddCommand(name: string, target: string, args: string[], options: AddOptions): Promise<void> {
  const scope = parseScope(options.scope);
  if (!TRANSPORTS.includes(options.transport)) {
    throw new Error(`--transport must be one of: ${TRANSPORTS.join(', ')}.`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Server names may only contain letters, digits, "-" and "_".');
  }

  let config: McpServerConfig;
  if (options.transport === 'stdio') {
    if (options.header?.length) {
      throw new Error('--header is for http/sse servers; use --env for stdio servers.');
    }
    config = {
      command: target,
      ...(args.length ? { args } : {}),
      ...(options.env ? { env: pairs(options.env, '=', '--env') } : {}),
    };
  } else {
    if (args.length || options.env?.length) {
      throw new Error('http/sse servers take a URL only (use --header for tokens).');
    }
    try {
      new URL(target);
    } catch {
      throw new Error(`Not a valid URL: ${target}`);
    }
    config = {
      type: options.transport as 'http' | 'sse',
      url: target,
      ...(options.header ? { headers: pairs(options.header, ':', '--header') } : {}),
    };
  }

  const workspaceRoot = resolve(options.workspace);
  const file = addMcpServer(workspaceRoot, scope, name, config);
  if (scope === 'project') {
    // You added it yourself, so don't ask about it on the next start.
    const choices = projectChoices(workspaceRoot);
    choices.enabled = [...new Set([...choices.enabled, name])];
    choices.disabled = choices.disabled.filter((item) => item !== name);
    saveProjectChoices(workspaceRoot, choices);
  }
  stdout.write(`Added MCP server ${style.bold(name)} (${scope}) to ${file}\n  ${describeConfig(config)}\n`);
}

export async function mcpRemoveCommand(name: string, options: RemoveOptions): Promise<void> {
  const workspaceRoot = resolve(options.workspace);
  const scope = options.scope ? parseScope(options.scope) : undefined;
  const removed = removeMcpServer(workspaceRoot, name, scope);
  if (!removed.length) {
    throw new Error(`No MCP server named "${name}"${scope ? ` in the ${scope} scope` : ''}.`);
  }
  stdout.write(`Removed MCP server ${style.bold(name)} from ${removed.join(', ')}.\n`);
}

/** Forgets the Use / Don't use answers for this folder's `.mcp.json` servers. */
export async function mcpResetCommand(options: WorkspaceOptions): Promise<void> {
  saveProjectChoices(resolve(options.workspace), null);
  stdout.write('Project MCP server choices reset; you will be asked again on the next start.\n');
}

/** The remote server `name` visible from the workspace, with its URL filled in. */
function remoteServer(workspaceRoot: string, name: string) {
  const entry = readMcpServers(workspaceRoot).find((server) => server.name === name);
  if (!entry) {
    throw new Error(`No MCP server named "${name}" here (aiolah mcp list).`);
  }
  const config = expandConfig(entry.config);
  if (!isRemoteServer(config)) {
    throw new Error(`"${name}" is a local (stdio) server; only http/sse servers sign in with OAuth.`);
  }
  return { entry, url: config.url };
}

/**
 * `aiolah mcp auth <name>`: signs in to a remote MCP server that uses OAuth
 * (browser login, local callback, tokens kept in ~/.aiolah/mcp-oauth.json).
 */
export async function mcpAuthCommand(name: string, options: WorkspaceOptions & { browser?: boolean }): Promise<void> {
  const workspaceRoot = resolve(options.workspace);
  const { entry, url } = remoteServer(workspaceRoot, name);
  const provider = new StoredOAuthProvider(name, url);
  const callback = listenForAuthorizationCode();
  try {
    const first = await auth(provider, { serverUrl: url });
    if (first === 'REDIRECT' && provider.authorizationUrl) {
      const link = provider.authorizationUrl.toString();
      stdout.write(`Sign in to ${name} in your browser:\n\n  ${link}\n\nWaiting for the browser… (Ctrl+C to cancel)\n`);
      if (options.browser !== false) {
        openBrowser(link);
      }
      const code = await callback.code;
      const second = await auth(provider, { serverUrl: url, authorizationCode: code });
      if (second !== 'AUTHORIZED') {
        throw new Error('The server did not accept the sign-in.');
      }
    }
  } finally {
    callback.close();
  }
  const manager = new McpManager(workspaceRoot);
  await manager.start([entry]);
  const status = manager.status[0];
  await manager.close();
  stdout.write(
    status?.state === 'connected'
      ? `Signed in to ${style.bold(name)}: ${status.tools.length} tools available.\n`
      : `Signed in, but ${name} did not connect: ${status?.error ?? 'unknown error'}\n`,
  );
}

/** `aiolah mcp logout <name>`: forgets the server's OAuth tokens. */
export async function mcpLogoutCommand(name: string, options: WorkspaceOptions): Promise<void> {
  const { url } = remoteServer(resolve(options.workspace), name);
  stdout.write(forgetOAuth(name, url) ? `Signed out of ${name}.\n` : `Not signed in to ${name}.\n`);
}
