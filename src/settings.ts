import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Your preferences in ~/.aiolah/settings.json (the same file that holds
 * hooks, in Claude Code's format): theme, vim mode and the status line.
 */
export interface UserSettings {
  theme?: 'dark' | 'light' | 'mono';
  vim?: boolean;
  /** Claude Code's shape: a command whose first line of output is shown under the input box. */
  statusLine?: { type?: 'command'; command?: string };
  [key: string]: unknown;
}

const SETTINGS_FILE = join(homedir(), '.aiolah', 'settings.json');

export function readUserSettings(): UserSettings {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as UserSettings;
  } catch {
    return {};
  }
}

/** Sets (or with `undefined` removes) one key, keeping everything else in the file. */
export function writeUserSetting<K extends keyof UserSettings>(key: K, value: UserSettings[K] | undefined): void {
  const settings = readUserSettings();
  if (value === undefined) {
    delete settings[key];
  } else {
    settings[key] = value;
  }
  mkdirSync(join(homedir(), '.aiolah'), { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(SETTINGS_FILE, 0o600);
}

export function settingsFilePath(): string {
  return SETTINGS_FILE;
}
