import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

export interface SessionRecord {
  id: string;
  model: string;
  /** Provider id the session last used (absent in sessions saved before providers existed). */
  provider?: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  history: Anthropic.MessageParam[];
}

const SESSIONS_DIR = join(homedir(), '.aiolah', 'sessions');

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function generateSessionId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function pathFor(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

export function saveSession(record: SessionRecord): void {
  ensureDir();
  writeFileSync(pathFor(record.id), JSON.stringify(record, null, 2), 'utf8');
}

export function loadSession(id: string): SessionRecord {
  try {
    return JSON.parse(readFileSync(pathFor(id), 'utf8')) as SessionRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`No saved session "${id}". List them with: aiolah sessions list`);
    }
    throw error;
  }
}

export function listSessions(): SessionRecord[] {
  ensureDir();
  return readdirSync(SESSIONS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf8')) as SessionRecord)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findLatestSession(): SessionRecord | undefined {
  return listSessions()[0];
}
