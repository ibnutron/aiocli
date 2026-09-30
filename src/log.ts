import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * A small log for troubleshooting (like opencode's --print-logs / --log-level):
 * written to ~/.aiolah/logs/aiolah.log, and also to stderr with --print-logs.
 * Level: --log-level or AIOLAH_LOG_LEVEL (DEBUG, INFO, WARN, ERROR; default INFO).
 */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_DIR = join(homedir(), '.aiolah', 'logs');
export const LOG_FILE = join(LOG_DIR, 'aiolah.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

let threshold: LogLevel = parseLevel(process.env.AIOLAH_LOG_LEVEL) ?? 'INFO';
let printToStderr = false;
let fileBroken = false;

function parseLevel(value: string | undefined): LogLevel | null {
  const upper = value?.trim().toUpperCase();
  return (LOG_LEVELS as readonly string[]).includes(upper ?? '') ? (upper as LogLevel) : null;
}

export function configureLog(options: { print?: boolean; level?: string }): void {
  if (options.print !== undefined) printToStderr = options.print;
  const level = parseLevel(options.level);
  if (options.level !== undefined && !level) {
    throw new Error(`--log-level must be one of ${LOG_LEVELS.join(', ')}.`);
  }
  if (level) threshold = level;
}

export function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(threshold)) {
    return;
  }
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${data ? ` ${JSON.stringify(data)}` : ''}\n`;
  if (printToStderr) {
    process.stderr.write(line);
  }
  if (fileBroken) {
    return;
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    try {
      if (statSync(LOG_FILE).size > MAX_LOG_BYTES) {
        renameSync(LOG_FILE, `${LOG_FILE}.old`);
      }
    } catch {
      // no log file yet
    }
    appendFileSync(LOG_FILE, line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    fileBroken = true;
  }
}

/**
 * Takes the log flags out of argv (they may appear anywhere, before or after
 * the command) and applies them.
 */
export function extractLogFlags(argv: string[]): string[] {
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--print-logs') {
      configureLog({ print: true });
    } else if (arg === '--log-level') {
      configureLog({ level: argv[index + 1] ?? '' });
      index += 1;
    } else if (arg.startsWith('--log-level=')) {
      configureLog({ level: arg.slice('--log-level='.length) });
    } else {
      rest.push(arg);
    }
  }
  return rest;
}
