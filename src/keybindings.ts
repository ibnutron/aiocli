import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Key } from 'node:readline';
import { log } from './log.js';

/**
 * Custom shortcuts in Claude Code's keybindings.json format
 * (`{ "bindings": [{ "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor", "ctrl+s": null } }] }`),
 * read from ~/.aiolah/keybindings.json, or ~/.claude/keybindings.json when
 * aiolah has none. A key bound to an action runs it; a key bound to null does
 * nothing; other keys keep their default behaviour. Changes apply without a
 * restart. Chords ("ctrl+x ctrl+e") must be typed within 3 seconds.
 */
export const KEYBINDINGS_FILE = join(homedir(), '.aiolah', 'keybindings.json');
const CLAUDE_KEYBINDINGS_FILE = join(homedir(), '.claude', 'keybindings.json');

export type KeyContext = 'Global' | 'Chat' | 'Autocomplete' | 'Confirmation';

/** The actions aiolah supports, per context (names as in Claude Code). */
export const SUPPORTED_ACTIONS: Record<string, KeyContext> = {
  'app:interrupt': 'Global',
  'app:redraw': 'Global',
  'chat:submit': 'Chat',
  'chat:newline': 'Chat',
  'chat:cancel': 'Chat',
  'chat:cycleMode': 'Chat',
  'chat:externalEditor': 'Chat',
  'chat:clearInput': 'Chat',
  'chat:modelPicker': 'Chat',
  'history:previous': 'Chat',
  'history:next': 'Chat',
  'autocomplete:accept': 'Autocomplete',
  'autocomplete:dismiss': 'Autocomplete',
  'autocomplete:previous': 'Autocomplete',
  'autocomplete:next': 'Autocomplete',
  'confirm:yes': 'Confirmation',
  'confirm:no': 'Confirmation',
};

/** Keys aiolah always handles itself (as in Claude Code). */
const RESERVED = new Set(['ctrl+c', 'ctrl+d', 'ctrl+m', 'ctrl+[', 'ctrl+i', 'ctrl+h']);
const CHORD_TIMEOUT_MS = 3_000;
const RELOAD_CHECK_MS = 2_000;

const MODIFIER_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'meta',
  opt: 'meta',
  option: 'meta',
  meta: 'meta',
  shift: 'shift',
};
const KEY_ALIASES: Record<string, string> = { esc: 'escape', return: 'enter' };

/** "Ctrl+Shift+K" → "ctrl+shift+k" (modifiers in a fixed order). */
export function normalizeKeystroke(text: string): string | null {
  const parts = text.trim().toLowerCase().split('+').filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) return null;
    modifiers.add(modifier);
  }
  const ordered = ['ctrl', 'meta', 'shift'].filter((modifier) => modifiers.has(modifier));
  return [...ordered, KEY_ALIASES[key] ?? key].join('+');
}

/** The keystroke a readline key event stands for, in the same normalized form. */
export function keystrokeOf(sequence: string | undefined, key: Key): string | null {
  let name = key.name;
  if (!name && sequence && sequence.length === 1 && sequence >= ' ') {
    name = sequence.toLowerCase();
  }
  if (!name) return null;
  name = name === 'return' ? 'enter' : name;
  const parts = [key.ctrl ? 'ctrl' : '', key.meta ? 'meta' : '', key.shift ? 'shift' : ''].filter(Boolean);
  return [...parts, name].join('+');
}

interface BindingBlock {
  context?: string;
  bindings?: Record<string, string | null>;
}

type Table = Map<KeyContext, Map<string, string | null>>;

export class Keymap {
  private table: Table = new Map();
  private loadedFrom: { path: string; mtimeMs: number } | null = null;
  private checkedAt = 0;
  private chord: { keys: string[]; at: number } | null = null;

  /** Where the bindings came from (for /keybindings). */
  get source(): string | null {
    return this.loadedFrom?.path ?? null;
  }

  bindings(): { context: KeyContext; keys: string; action: string | null }[] {
    this.reloadIfChanged();
    return [...this.table].flatMap(([context, map]) => [...map].map(([keys, action]) => ({ context, keys, action })));
  }

  /**
   * What to do with a key in `context` (Global bindings apply everywhere):
   * an action name, null for "unbound", 'pending' while a chord is being
   * typed, or undefined to fall back to the default behaviour.
   */
  resolve(context: KeyContext, sequence: string | undefined, key: Key): string | null | 'pending' | undefined {
    this.reloadIfChanged();
    if (!this.table.size) return undefined;
    const stroke = keystrokeOf(sequence, key);
    if (!stroke) return undefined;
    const now = Date.now();
    const typed = this.chord && now - this.chord.at < CHORD_TIMEOUT_MS ? [...this.chord.keys, stroke] : [stroke];
    const sequenceText = typed.join(' ');
    const maps = [this.table.get(context), this.table.get('Global')].filter((map): map is Map<string, string | null> =>
      Boolean(map),
    );
    for (const map of maps) {
      if (map.has(sequenceText)) {
        this.chord = null;
        return map.get(sequenceText) ?? null;
      }
    }
    if (maps.some((map) => [...map.keys()].some((keys) => keys.startsWith(`${sequenceText} `)))) {
      this.chord = { keys: typed, at: now };
      return 'pending';
    }
    this.chord = null;
    // A chord that went nowhere: try the last key on its own.
    if (typed.length > 1) {
      return this.resolve(context, sequence, key);
    }
    return undefined;
  }

  private reloadIfChanged(): void {
    const now = Date.now();
    if (now - this.checkedAt < RELOAD_CHECK_MS && this.checkedAt) return;
    this.checkedAt = now;
    for (const path of [KEYBINDINGS_FILE, CLAUDE_KEYBINDINGS_FILE]) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (this.loadedFrom?.path === path && this.loadedFrom.mtimeMs === mtimeMs) return;
      this.table = parseKeybindings(path);
      this.loadedFrom = { path, mtimeMs };
      return;
    }
    this.table = new Map();
    this.loadedFrom = null;
  }
}

function parseKeybindings(path: string): Table {
  const table: Table = new Map();
  let file: { bindings?: BindingBlock[] };
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    log('WARN', 'keybindings: cannot read', { path, error: error instanceof Error ? error.message : String(error) });
    return table;
  }
  for (const block of file.bindings ?? []) {
    const context = block.context as KeyContext;
    if (!['Global', 'Chat', 'Autocomplete', 'Confirmation'].includes(context)) {
      log('INFO', 'keybindings: context not supported by aiolah, skipped', { context: block.context });
      continue;
    }
    const map = table.get(context) ?? new Map<string, string | null>();
    for (const [keys, action] of Object.entries(block.bindings ?? {})) {
      const normalized = keys.split(/\s+/).map(normalizeKeystroke);
      if (normalized.some((stroke) => stroke === null)) {
        log('WARN', 'keybindings: bad keystroke', { keys });
        continue;
      }
      const sequence = normalized.join(' ');
      if (normalized.length === 1 && RESERVED.has(sequence)) {
        log('WARN', 'keybindings: reserved shortcut', { keys });
        continue;
      }
      if (action !== null && !(action in SUPPORTED_ACTIONS)) {
        log('INFO', 'keybindings: action not supported by aiolah, skipped', { action });
        continue;
      }
      map.set(sequence, action);
    }
    table.set(context, map);
  }
  return table;
}

/** Starting file for /keybindings. */
export const KEYBINDINGS_TEMPLATE = `${JSON.stringify(
  {
    $docs: 'https://aiolah.com/docs?tab=cli',
    bindings: [{ context: 'Chat', bindings: { 'ctrl+g': 'chat:externalEditor', 'ctrl+j': 'chat:newline' } }],
  },
  null,
  2,
)}\n`;
