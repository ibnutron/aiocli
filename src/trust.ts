import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { stdout } from 'node:process';
import { canAsk, selectDialog } from './dialog.js';
import { style, tildify } from './ui.js';

/**
 * Folders the user said they trust (the first-run question, as in Claude
 * Code). Stored at ~/.aiolah/trusted.json with mode 0600.
 */
interface TrustFile {
  folders: string[];
}

const CONFIG_DIR = join(homedir(), '.aiolah');
const TRUST_FILE = join(CONFIG_DIR, 'trusted.json');

function readTrusted(): string[] {
  try {
    const data = JSON.parse(readFileSync(TRUST_FILE, 'utf8')) as Partial<TrustFile>;
    return Array.isArray(data.folders) ? data.folders.filter((folder) => typeof folder === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The home folder and filesystem roots are never remembered: trusting them
 * would trust every project underneath, so they are asked about every time.
 */
function isRememberable(folder: string): boolean {
  return folder !== resolve(homedir()) && folder !== parse(folder).root;
}

/** A folder is trusted when it, or a folder above it, was trusted before. */
export function isTrusted(folder: string): boolean {
  const target = resolve(folder);
  return readTrusted().some((trusted) => target === trusted || target.startsWith(trusted + sep));
}

export function rememberTrust(folder: string): void {
  const target = resolve(folder);
  if (!isRememberable(target) || isTrusted(target)) {
    return;
  }
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const file: TrustFile = { folders: [...readTrusted(), target].sort() };
  writeFileSync(TRUST_FILE, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  chmodSync(TRUST_FILE, 0o600);
}

/**
 * Asks "Do you trust the files in this folder?" the first time aiolah runs
 * interactively in a folder, before any tool can touch it. Returns false when
 * the user declines (the caller exits). Without a terminal (scripts, CI,
 * `aiolah run`) there is nobody to ask, so the folder is used as is.
 */
export async function ensureTrusted(folder: string): Promise<boolean> {
  const target = resolve(folder);
  if (!canAsk() || isTrusted(target)) {
    return true;
  }
  const trusted = await askTrust(target);
  if (trusted) {
    rememberTrust(target);
  } else {
    stdout.write(`${style.gray('Exited without opening this folder.')}\n`);
  }
  return trusted;
}

/** "Do you trust the files in this folder?" — true for Yes. */
async function askTrust(folder: string): Promise<boolean> {
  const body = [
    '',
    style.bold(tildify(folder)),
    '',
    'aiolah will be able to read, edit, and execute files here.',
    style.gray('Only continue in folders you trust: their files can steer what the model does,'),
    style.gray('and the commands it runs here run as you.'),
  ];
  if (!isRememberable(folder)) {
    body.push('', style.yellow('This is your home or a root folder, so aiolah will ask again next time.'));
  }
  const choice = await selectDialog({
    title: style.bold(style.accent('Do you trust the files in this folder?')),
    body,
    choices: ['Yes, I trust this folder', 'No, exit'],
    hint: 'Enter to confirm · Esc to exit',
  });
  return choice === 0;
}
