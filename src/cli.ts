#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { serveCommand } from './commands/serve.js';
import { attachCommand } from './commands/attach.js';
import { sessionsListCommand } from './commands/sessions.js';
import { loginCommand, logoutCommand, setupTokenCommand, statusCommand } from './commands/login.js';
import { relayCommand } from './commands/relay.js';
import { modelsCommand } from './commands/models.js';
import { connectCommand, disconnectCommand } from './commands/connect.js';
import { uninstallCommand } from './commands/uninstall.js';
import { runCommand } from './commands/run.js';
import { upgradeCommand } from './commands/upgrade.js';
import { doctorCommand } from './commands/doctor.js';
import { collect, mcpAddCommand, mcpListCommand, mcpRemoveCommand, mcpResetCommand } from './commands/mcp.js';
import { packageVersion } from './version.js';
import { addPermissionOptions } from './permissions.js';

loadPackageEnv();

// Output piped into `head` & co.: exit quietly once the reader goes away.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

const program = new Command();

program
  .name('aiolah')
  .description('Terminal AI coding agent with remote control, powered by aiolah')
  .version(packageVersion(), '-v, --version');

// `aiolah auth login|logout|status` — device-code sign-in to aiolah.
const auth = program.command('auth').description('Manage your aiolah login');
auth
  .command('login')
  .description('Sign in to aiolah in your browser (no API key needed; usage is billed to your plan)')
  .option('--server <url>', 'aiolah server URL (default https://aiolah.com or $AIOLAH_SERVER)')
  .option('--no-browser', 'only print the URL, do not try to open a browser')
  .action(loginCommand);
auth.command('logout').description("Sign out and revoke this machine's token").action(logoutCommand);
auth.command('status').alias('list').description('Show which account and credentials are in use').action(statusCommand);

program
  .command('login')
  .description('Shortcut for "aiolah auth login"')
  .option('--server <url>', 'aiolah server URL')
  .option('--no-browser', 'only print the URL, do not try to open a browser')
  .action(loginCommand);
program.command('logout').description('Shortcut for "aiolah auth logout"').action(logoutCommand);

program
  .command('setup-token')
  .description('Create a long-lived token for CI and scripts (printed, not saved; use it as AIOLAH_TOKEN)')
  .option('--server <url>', 'aiolah server URL')
  .option('--no-browser', 'only print the URL, do not try to open a browser')
  .action(setupTokenCommand);

addPermissionOptions(
  program
    .command('chat')
    .description('Start an interactive chat session in this terminal')
    .option('-m, --model <model>', 'model id (see "aiolah models"; default: the provider\'s default)')
    .option('-P, --provider <id>', 'model provider: aiolah (your plan) or one you connected (see "aiolah connect")')
    .option('-w, --workspace <dir>', 'workspace root for file/bash tools', '.')
    .option('-r, --resume <id>', 'resume a saved session by id')
    .option('-c, --continue', 'resume the most recently updated session')
    .option('--add-dir <dirs...>', 'other directories the agent may use besides the workspace'),
).action(chatCommand);

addPermissionOptions(
  program
    .command('serve')
    .description(
      'Let this machine be controlled remotely: via aiolah (/code, app, VS Code) after "aiolah auth login", ' +
        'or directly with --port and AIOLAH_REMOTE_TOKEN',
    )
    .option('-p, --port <port>', 'direct mode: listen on this port instead of connecting to the aiolah relay')
    .option('-n, --name <name>', 'relay mode: device name shown on /code')
    .option('-m, --model <model>', 'model id (see "aiolah models"; default: the provider\'s default)')
    .option('-P, --provider <id>', 'model provider: aiolah (your plan) or one you connected (see "aiolah connect")')
    .option('-w, --workspace <dir>', 'workspace root for file/bash tools', '.')
    .option('-r, --resume <id>', 'resume a saved session by id')
    .option('-c, --continue', 'resume the most recently updated session')
    .option('--cert <path>', 'TLS certificate path (enables wss)')
    .option('--key <path>', 'TLS private key path (enables wss)'),
).action(serveCommand);

// `aiolah remote-control` / `aiolah rc`: serve this folder through the
// aiolah relay only (never opens a port), under an optional device name.
addPermissionOptions(
  program
    .command('remote-control')
    .alias('rc')
    .description('Control this folder from aiolah /code, the app or VS Code (needs "aiolah auth login")')
    .argument('[name]', 'device name shown on /code (default: "<hostname> · <folder>")')
    .option('-n, --name <name>', 'device name shown on /code')
    .option('-m, --model <model>', 'model id (see "aiolah models"; default: the provider\'s default)')
    .option('-P, --provider <id>', 'model provider: aiolah (your plan) or one you connected (see "aiolah connect")')
    .option('-w, --workspace <dir>', 'workspace root for file/bash tools', '.')
    .option('-r, --resume <id>', 'resume a saved session by id')
    .option('-c, --continue', 'resume the most recently updated session'),
).action((name: string | undefined, options: Parameters<typeof serveCommand>[0]) =>
  serveCommand({ ...options, name: options.name ?? name, port: undefined }),
);

addPermissionOptions(
  program
    .command('run')
    .description(
      'Run one prompt non-interactively and print the answer (also: aiolah -p "<prompt>"); piped stdin is appended',
    )
    .argument('[prompt...]', 'the prompt')
    .option('-m, --model <model>', 'model id (see "aiolah models"; default: the provider\'s default)')
    .option('-P, --provider <id>', 'model provider: aiolah (your plan) or one you connected (see "aiolah connect")')
    .option('-w, --workspace <dir>', 'workspace root for file/bash tools', '.')
    .option('-r, --resume <id>', 'continue a saved session by id')
    .option('-c, --continue', 'continue the most recently updated session')
    .option('--output-format <format>', 'text or json', 'text')
    .option('--add-dir <dirs...>', 'other directories the agent may use besides the workspace'),
).action(runCommand);

program
  .command('attach <address>')
  .description('Attach to a running "aiolah serve" session, e.g. aiolah attach ws://host:4317')
  .action(attachCommand);

program
  .command('connect')
  .description(
    'Connect a model provider: your aiolah account or your own key (Anthropic, OpenAI, OpenRouter, Google, …)',
  )
  .argument('[provider]', 'provider id (omit to choose from a list)')
  .action(connectCommand);

program
  .command('disconnect')
  .description("Remove a provider's stored key (or sign out of aiolah)")
  .argument('<provider>', 'provider id')
  .action(disconnectCommand);

program
  .command('models')
  .description('List models: your aiolah plan by default, or a connected provider with --provider')
  .option('-P, --provider <id>', 'provider id (default: the active provider)')
  .action(modelsCommand);

program
  .command('relay')
  .description('Run the aiolah relay server (operators only; needs CLI_RELAY_SECRET)')
  .option('-p, --port <port>', 'port to listen on (127.0.0.1)', '4320')
  .option('--api <url>', 'aiolah Laravel base URL used to verify hosts (default $AIOLAH_SERVER)')
  .action(relayCommand);

program
  .command('upgrade')
  .alias('update')
  .description('Update aiolah to the latest (or a given) version from npm')
  .argument('[version]', 'version to install (default: latest)')
  .option('--check', 'only check whether an update is available')
  .action(upgradeCommand);

program
  .command('uninstall')
  .description('Sign out, delete ~/.aiolah and remove the npm package')
  .option(
    '--keep-config',
    'keep login, provider keys, device id, trusted folders and MCP servers (~/.aiolah/*.json, machine-id)',
  )
  .option('--keep-data', 'keep saved sessions (~/.aiolah/sessions)')
  .option('--dry-run', 'only show what would be removed')
  .option('-f, --force', 'do not ask for confirmation')
  .action(uninstallCommand);

program.command('doctor').description('Check installation, login and connectivity to aiolah').action(doctorCommand);

// `aiolah mcp …`, like `claude mcp …`: servers whose tools the model can use.
const mcp = program.command('mcp').description('Manage MCP servers (tools from other programs the model can use)');
mcp
  .command('list')
  .description('List MCP servers for this folder and check that they start')
  .option('-w, --workspace <dir>', 'project folder', '.')
  .action(mcpListCommand);
mcp
  .command('add')
  .description('Add a server: aiolah mcp add <name> -- <command> [args…], or aiolah mcp add -t http <name> <url>')
  .argument('<name>', 'server name (letters, digits, - and _)')
  .argument('<commandOrUrl>', 'command to start (stdio) or URL (http/sse)')
  .argument('[args...]', 'arguments for the command (put -- before them)')
  .option(
    '-s, --scope <scope>',
    'local (you, this folder), project (.mcp.json, shared) or user (you, everywhere)',
    'local',
  )
  .option('-t, --transport <transport>', 'stdio, http or sse', 'stdio')
  .option('-e, --env <KEY=value>', 'environment variable for a stdio server (repeatable)', collect)
  .option('-H, --header <"Name: value">', 'HTTP header for an http/sse server (repeatable)', collect)
  .option('-w, --workspace <dir>', 'project folder', '.')
  .action(mcpAddCommand);
mcp
  .command('remove')
  .description('Remove a server (from every scope unless --scope is given)')
  .argument('<name>', 'server name')
  .option('-s, --scope <scope>', 'local, project or user')
  .option('-w, --workspace <dir>', 'project folder', '.')
  .action(mcpRemoveCommand);
mcp
  .command('reset-project-choices')
  .description("Forget which of this folder's .mcp.json servers you allowed or declined")
  .option('-w, --workspace <dir>', 'project folder', '.')
  .action(mcpResetCommand);

const sessions = program.command('sessions').description('Manage saved chat sessions');
sessions.command('list').description('List saved sessions').action(sessionsListCommand);

program.parseAsync(normalizeArgv(process.argv)).catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

/**
 * Loads the `.env` that sits next to this package (not the caller's cwd, so
 * `aiolah serve` launched from another repo's npm script still finds the key).
 * Variables already present in the environment win over the file.
 */
function loadPackageEnv(): void {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    process.env[key] ??= value;
  }
}

/**
 * Shortcuts that don't fit commander's subcommand model:
 * - `aiolah` with no arguments starts `aiolah chat`;
 * - `aiolah -p "<prompt>"` / `aiolah --print "<prompt>"` is `aiolah run "<prompt>"`;
 * - chat options without a command (`aiolah -r <id>`, `aiolah -c`,
 *   `aiolah --permission-mode auto`) are options of `aiolah chat`.
 */
function normalizeArgv(argv: string[]): string[] {
  const [node = 'node', script = 'aiolah', first, ...rest] = argv;
  if (first === undefined) {
    return [node, script, 'chat'];
  }
  const topLevel = ['-v', '--version', '-h', '--help', '-p', '--print'];
  if (first.startsWith('-') && !topLevel.includes(first) && !first.startsWith('--print=')) {
    return [node, script, 'chat', first, ...rest];
  }
  if (first === '-p' || first === '--print') {
    return [node, script, 'run', ...rest];
  }
  if (first.startsWith('--print=')) {
    return [node, script, 'run', first.slice('--print='.length), ...rest];
  }
  return argv;
}
