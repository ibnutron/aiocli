import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve, sep } from 'node:path';
import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin, stdout } from 'node:process';
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

const CHOICES = ['Yes, I trust this folder', 'No, exit'];

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
  if (!stdin.isTTY || !stdout.isTTY || isTrusted(target)) {
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

function trustLines(folder: string, selected: number): string[] {
  const lines = [
    '',
    ` ${style.bold(style.accent('Do you trust the files in this folder?'))}`,
    '',
    ` ${style.bold(tildify(folder))}`,
    '',
    ' aiolah will be able to read, edit, and execute files here.',
    ` ${style.gray('Only continue in folders you trust: their files can steer what the model does,')}`,
    ` ${style.gray('and the commands it runs here run as you.')}`,
  ];
  if (!isRememberable(folder)) {
    lines.push('', ` ${style.yellow('This is your home or a root folder, so aiolah will ask again next time.')}`);
  }
  lines.push('');
  CHOICES.forEach((choice, index) => {
    const label = `${index + 1}. ${choice}`;
    lines.push(index === selected ? ` ${style.accent(`❯ ${label}`)}` : `   ${label}`);
  });
  lines.push('', ` ${style.gray('Enter to confirm · Esc to exit')}`, '');
  return lines;
}

/** ↑/↓, 1–2 and Enter, redrawn in place; Esc and Ctrl+C mean "No". */
function askTrust(folder: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    let selected = 0;
    let drawn = 0;
    const draw = () => {
      const lines = trustLines(folder, selected);
      stdout.write(`${drawn ? `\x1b[${drawn}A\r\x1b[J` : ''}${lines.join('\n')}\n`);
      drawn = lines.length;
    };

    const finish = (trusted: boolean) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      resolveAnswer(trusted);
    };

    const onKey = (sequence: string | undefined, key: Key | undefined) => {
      const name = key?.name;
      if ((key?.ctrl && name === 'c') || name === 'escape') {
        finish(false);
      } else if (name === 'up' || name === 'k') {
        selected = (selected + CHOICES.length - 1) % CHOICES.length;
        draw();
      } else if (name === 'down' || name === 'j' || name === 'tab') {
        selected = (selected + 1) % CHOICES.length;
        draw();
      } else if (sequence === '1' || sequence === '2') {
        selected = Number(sequence) - 1;
        draw();
        finish(selected === 0);
      } else if (name === 'return' || name === 'enter') {
        finish(selected === 0);
      }
    };

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    stdout.write('\x1b[?25l');
    draw();
  });
}
