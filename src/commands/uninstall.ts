import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readAuth } from '../config.js';
import { ask } from '../prompt.js';
import { PACKAGE_NAME, isNpmInstall, packageRoot } from '../version.js';
import { logoutCommand } from './login.js';

interface UninstallOptions {
  keepConfig?: boolean;
  keepData?: boolean;
  dryRun?: boolean;
  force?: boolean;
}

const CONFIG_DIR = join(homedir(), '.aiolah');
/** Login, provider keys, this machine's device id, the folders you trusted and your MCP servers. */
const CONFIG_FILES = ['auth.json', 'providers.json', 'machine-id', 'trusted.json', 'mcp.json', 'mcp-approvals.json'];
/** Saved conversations. */
const DATA_DIRS = ['sessions'];

/**
 * Removes the CLI: signs out (revoking this machine's token on aiolah),
 * deletes ~/.aiolah (config and/or saved sessions, unless kept) and runs
 * `npm uninstall -g @aiolah/cli` for an npm install.
 */
export async function uninstallCommand(options: UninstallOptions): Promise<void> {
  const paths = [
    ...(options.keepConfig ? [] : CONFIG_FILES.map((file) => join(CONFIG_DIR, file))),
    ...(options.keepData ? [] : DATA_DIRS.map((dir) => join(CONFIG_DIR, dir))),
  ].filter((path) => existsSync(path));
  const npmInstall = isNpmInstall();
  const signedIn = !options.keepConfig && readAuth() !== null;

  stdout.write('aiolah uninstall will:\n');
  if (signedIn) stdout.write('  - sign out and revoke this machine’s token on aiolah\n');
  for (const path of paths) stdout.write(`  - delete ${path}\n`);
  stdout.write(
    npmInstall
      ? `  - run: npm uninstall -g ${PACKAGE_NAME}\n`
      : `  - leave the source checkout at ${realpathSync(packageRoot())} (delete it yourself)\n`,
  );
  stdout.write('Devices you registered with "aiolah rc" stay listed on aiolah.com/code until you remove them there.\n');

  if (options.dryRun) {
    stdout.write('Dry run: nothing was changed.\n');
    return;
  }

  if (!options.force) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await ask(rl, 'Continue? [y/N] ');
    rl.close();
    if (answer?.trim().toLowerCase() !== 'y') {
      stdout.write('Cancelled.\n');
      return;
    }
  }

  if (signedIn) {
    await logoutCommand();
  }
  for (const path of paths) {
    rmSync(path, { recursive: true, force: true });
  }
  if (existsSync(CONFIG_DIR) && readdirSync(CONFIG_DIR).length === 0) {
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  }

  if (!npmInstall) {
    stdout.write('Removed aiolah’s files. The source checkout was left in place.\n');
    return;
  }

  const result = spawnSync('npm', ['uninstall', '-g', PACKAGE_NAME], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(
      `npm uninstall failed. Run "npm uninstall -g ${PACKAGE_NAME}" yourself (on Linux/macOS it may need sudo).`,
    );
  }
  stdout.write('aiolah was uninstalled.\n');
}
