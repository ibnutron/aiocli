import type { Interface } from 'node:readline/promises';
import { stdout } from 'node:process';
import { matchSlashCommands, type SlashCommand } from './slash.js';
import { style, terminalWidth, truncate } from './ui.js';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

type TtyWrite = (sequence: string | undefined, key: Key | undefined) => void;

/**
 * - `prompt`: the main `❯` prompt — slash menu, Shift+Tab, Ctrl+C handling;
 * - `busy`: a turn is running — keys are swallowed except Esc/Ctrl+C (interrupt) and Shift+Tab;
 * - `passthrough`: plain readline (pickers, API key entry, Allow/Deny questions).
 */
export type InputMode = 'prompt' | 'busy' | 'passthrough';

export interface TerminalInputHandlers {
  onInterrupt: () => void;
  onCycleMode: () => void;
  onExit: () => void;
}

const MAX_MENU_ITEMS = 8;

/**
 * Adds a Claude Code / opencode style layer on top of a terminal readline:
 * a live `/command` menu under the prompt (↑/↓ to choose, Tab to complete,
 * Enter to run), Esc to interrupt, Shift+Tab to cycle the permission mode and
 * Ctrl+C to clear the line (twice to quit). Hooks readline's internal key
 * handler; when that isn't available (not a TTY, other Node internals) the
 * prompt simply works as plain readline.
 */
export class TerminalInput {
  mode: InputMode = 'passthrough';
  private original: TtyWrite | null = null;
  private menuRows = 0;
  private selected = 0;
  private items: SlashCommand[] = [];
  private exitArmedAt = 0;

  constructor(
    private readonly rl: Interface,
    private readonly handlers: TerminalInputHandlers,
  ) {
    if (!stdout.isTTY) {
      return;
    }
    const target = rl as unknown as Record<string | symbol, unknown>;
    const key = findTtyWriteKey(rl);
    if (!key) {
      return;
    }
    const original = (target[key] as TtyWrite).bind(rl);
    this.original = original;
    target[key] = (sequence: string | undefined, pressed: Key | undefined) => this.onKey(sequence, pressed ?? {});
  }

  get enhanced(): boolean {
    return this.original !== null;
  }

  private onKey(sequence: string | undefined, key: Key): void {
    const original = this.original!;

    if (key.name === 'tab' && key.shift) {
      this.handlers.onCycleMode();
      return;
    }

    if (this.mode === 'busy') {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        this.handlers.onInterrupt();
      }
      return;
    }

    if (this.mode === 'passthrough') {
      original(sequence, key);
      return;
    }

    if (key.ctrl && key.name === 'c') {
      this.onCtrlC();
      return;
    }
    if (key.ctrl && key.name === 'd' && !this.rl.line) {
      this.clearMenu();
      this.handlers.onExit();
      return;
    }
    this.exitArmedAt = 0;

    const menuOpen = this.items.length > 0;
    if (menuOpen && (key.name === 'up' || key.name === 'down')) {
      const step = key.name === 'up' ? -1 : 1;
      this.selected = (this.selected + step + this.items.length) % this.items.length;
      this.drawMenu();
      return;
    }
    if (menuOpen && key.name === 'tab') {
      this.replaceLine(`/${this.items[this.selected]!.name} `);
      this.refreshMenu();
      return;
    }
    if (menuOpen && key.name === 'escape') {
      this.clearMenu();
      this.items = [];
      return;
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (menuOpen) {
        const chosen = this.items[this.selected]!;
        if (this.rl.line.trim() !== `/${chosen.name}`) {
          this.replaceLine(`/${chosen.name}`);
        }
      }
      this.items = [];
      original(sequence, key);
      // readline moved to the line below the prompt, where the menu starts.
      if (this.menuRows) {
        stdout.write('\x1b[J');
        this.menuRows = 0;
      }
      return;
    }
    if (key.name === 'tab') {
      return;
    }

    original(sequence, key);
    this.refreshMenu();
  }

  /** Called before each main prompt so a fresh prompt starts without a menu. */
  reset(): void {
    this.items = [];
    this.menuRows = 0;
    this.selected = 0;
    this.exitArmedAt = 0;
  }

  private onCtrlC(): void {
    if (this.rl.line) {
      this.replaceLine('');
      this.refreshMenu();
      return;
    }
    if (Date.now() - this.exitArmedAt < 2000) {
      this.clearMenu();
      this.handlers.onExit();
      return;
    }
    this.exitArmedAt = Date.now();
    this.drawLines([style.gray('  Press Ctrl+C again to exit')]);
  }

  private replaceLine(text: string): void {
    const original = this.original!;
    original(undefined, { ctrl: true, name: 'e' });
    original(undefined, { ctrl: true, name: 'u' });
    if (text) {
      original(text, { sequence: text });
    }
  }

  private refreshMenu(): void {
    const line = this.rl.line;
    const match = /^\/(\S*)$/.exec(line);
    const items = match ? matchSlashCommands(match[1] ?? '').slice(0, MAX_MENU_ITEMS) : [];
    const exact = items.length === 1 && `/${items[0]!.name}` === line;
    if (!items.length || exact) {
      this.items = [];
      this.clearMenu();
      return;
    }
    if (items.map((item) => item.name).join() !== this.items.map((item) => item.name).join()) {
      this.selected = 0;
    }
    this.items = items;
    this.drawMenu();
  }

  private drawMenu(): void {
    const width = terminalWidth();
    const nameWidth = Math.max(...this.items.map((item) => `/${item.name} ${item.args ?? ''}`.length)) + 2;
    this.drawLines(
      this.items.map((item, index) => {
        const name = `/${item.name} ${item.args ?? ''}`.padEnd(nameWidth);
        const description = truncate(item.description, Math.max(10, width - nameWidth - 6));
        return index === this.selected
          ? `  ${style.accent(style.bold(name))}${description}`
          : `  ${style.gray(name)}${style.gray(description)}`;
      }),
    );
  }

  /** Draws `lines` under the input, keeping the cursor where it is. */
  private drawLines(lines: string[]): void {
    const { cols } = this.rl.getCursorPos();
    const count = lines.length;
    // Make room first (scrolls if the prompt is on the last row), then come back.
    let output = `${'\n'.repeat(count)}\x1b[${count}A\x1b[${cols + 1}G\x1b7`;
    for (const line of lines) {
      output += `\r\n\x1b[2K${line}`;
    }
    output += '\x1b[J\x1b8';
    stdout.write(output);
    this.menuRows = count;
  }

  private clearMenu(): void {
    if (!this.menuRows) {
      return;
    }
    stdout.write('\x1b7\x1b[1B\r\x1b[J\x1b8');
    this.menuRows = 0;
  }
}

/** readline's key handler: `kTtyWrite` (a symbol) in current Node, `_ttyWrite` in older releases. */
function findTtyWriteKey(rl: Interface): string | symbol | null {
  for (let proto: object | null = rl; proto; proto = Object.getPrototypeOf(proto)) {
    for (const symbol of Object.getOwnPropertySymbols(proto)) {
      if (symbol.description === '_ttyWrite' && typeof (proto as Record<symbol, unknown>)[symbol] === 'function') {
        return symbol;
      }
    }
    if (typeof (proto as Record<string, unknown>)._ttyWrite === 'function') {
      return '_ttyWrite';
    }
  }
  return null;
}
