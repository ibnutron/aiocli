import type { Interface } from 'node:readline/promises';
import { stdout } from 'node:process';
import { ask } from './prompt.js';
import { matchSlashCommands, type SlashCommand } from './slash.js';
import {
  COLOR,
  MARGIN,
  columns,
  gitBranch,
  panelContentWidth,
  panelRow,
  scanner,
  style,
  tildify,
  truncate,
  visibleLength,
  wordmark,
} from './ui.js';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

type TtyWrite = (sequence: string | undefined, key: Key | undefined) => void;

export interface BoxInfo {
  /** Permission mode label, already colored (e.g. blue "Default"). */
  mode: string;
  model: string;
  provider: string;
  workspace: string;
  version: string;
}

export interface TerminalInputHandlers {
  /** Esc / Ctrl+C while a turn runs. */
  onInterrupt: () => void;
  /** Shift+Tab. */
  onCycleMode: () => void;
}

export type ConfirmAnswer = 'yes' | 'always' | 'no';

const MAX_MENU_ITEMS = 8;

/**
 * opencode-style input box for `aiolah chat`: a dark panel with an accent bar,
 * the mode · model line inside it and key hints underneath, always drawn at
 * the bottom of the conversation. Output printed with `print()` goes above it,
 * so the box stays in place while a turn runs (with a scanner bar and
 * "esc interrupt"); typing during a turn queues the message. Also hosts the
 * `/command` menu, the Allow/Deny question and the home screen.
 *
 * It takes over readline's key handler while mounted and hands keys back
 * (plain readline, for pickers and API key entry) when unmounted. Without a
 * TTY, or if that handler can't be found, every method falls back to plain
 * line input and output.
 */
export class TerminalInput {
  private original: TtyWrite | null = null;
  private mounted = false;
  private home = false;
  /** Row of the terminal cursor inside the drawn region (0 = region top). */
  private cursorRow = 0;

  private buffer = '';
  private cursor = 0;
  private pasting = false;
  private readonly history: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private readonly queue: string[] = [];
  private pendingRead: ((line: string | null) => void) | null = null;

  private menu: SlashCommand[] = [];
  private selected = 0;

  private busy = false;
  private activity = '';
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private notice = '';
  private exitArmedAt = 0;
  private lastKeyAt = 0;
  private pendingConfirm: {
    description: string;
    resolve: (answer: ConfirmAnswer) => void;
    shownAt: number;
  } | null = null;
  private readonly branch: string | null;

  constructor(
    private readonly rl: Interface,
    private readonly handlers: TerminalInputHandlers,
    private readonly info: () => BoxInfo,
  ) {
    this.branch = gitBranch(info().workspace);
    if (!stdout.isTTY || !COLOR) {
      return;
    }
    const target = rl as unknown as Record<string | symbol, unknown>;
    const key = findTtyWriteKey(rl);
    if (!key) {
      return;
    }
    this.original = (target[key] as TtyWrite).bind(rl);
    target[key] = (sequence: string | undefined, pressed: Key | undefined) => this.onKey(sequence, pressed ?? {});
    rl.setPrompt('');
    stdout.on('resize', () => {
      if (this.mounted) {
        if (this.home) {
          stdout.write('\x1b[2J\x1b[H');
          this.cursorRow = 0;
        }
        this.render();
      }
    });
  }

  get enhanced(): boolean {
    return this.original !== null;
  }

  /** Clears the screen and shows the logo with the box centered, until the first message. */
  showHome(): void {
    if (!this.enhanced) {
      return;
    }
    stdout.write('\x1b[2J\x1b[3J\x1b[H');
    this.home = true;
    this.cursorRow = 0;
  }

  /** One-off hint under the box (cleared on the next key press). */
  setNotice(text: string): void {
    this.notice = text;
    this.refresh();
  }

  /** Next message: a queued one, or waits for Enter. Null means the user quit. */
  read(): Promise<string | null> {
    if (this.queue.length) {
      return Promise.resolve(this.queue.shift()!);
    }
    if (!this.enhanced) {
      return ask(this.rl, '> ');
    }
    this.mount();
    return new Promise((resolve) => {
      this.pendingRead = resolve;
    });
  }

  /** Writes `text` (one or more lines) above the box. */
  print(text: string): void {
    if (!this.mounted) {
      stdout.write(`${text}\n`);
      return;
    }
    stdout.write(`${this.eraseSequence()}${text}\n`);
    this.cursorRow = 0;
    this.render();
  }

  /** Removes the box and gives the terminal back to plain readline (slash commands, pickers). */
  unmount(): void {
    if (!this.mounted) {
      return;
    }
    stdout.write(`${this.eraseSequence()}\x1b[?25h\x1b[?2004l`);
    this.mounted = false;
    this.cursorRow = 0;
  }

  /** Redraws the box (after the mode or model changed). */
  refresh(): void {
    if (this.mounted) {
      this.render();
    }
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.activity = '';
    if (!this.enhanced) {
      return;
    }
    if (busy && !this.timer) {
      this.timer = setInterval(() => {
        this.frame += 1;
        this.refresh();
      }, 90);
    } else if (!busy && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.refresh();
  }

  /** What the running turn is doing, shown next to the scanner. */
  setActivity(text: string): void {
    this.activity = text;
    this.refresh();
  }

  /** Allow/Deny question inside the box. */
  async confirm(description: string): Promise<ConfirmAnswer> {
    if (!this.enhanced || !this.mounted) {
      const answer = (await ask(this.rl, `Allow ${description}? [y/a/N] `))?.trim().toLowerCase();
      return answer === 'a' ? 'always' : answer === 'y' || answer === 'yes' ? 'yes' : 'no';
    }
    return new Promise((resolve) => {
      this.pendingConfirm = { description, resolve, shownAt: Date.now() };
      this.render();
    });
  }

  private mount(): void {
    if (!this.mounted) {
      // Bracketed paste: a pasted multi-line text arrives as one message, not one per line.
      stdout.write('\x1b[?2004h');
    }
    this.mounted = true;
    this.render();
  }

  private finishRead(line: string | null): void {
    const resolve = this.pendingRead;
    this.pendingRead = null;
    resolve?.(line);
  }

  private onKey(sequence: string | undefined, key: Key): void {
    if (!this.mounted) {
      this.original!(sequence, key);
      return;
    }
    const typing = Date.now() - this.lastKeyAt < 400;
    this.lastKeyAt = Date.now();

    if (key.name === 'tab' && key.shift) {
      this.handlers.onCycleMode();
      return;
    }

    if (this.pendingConfirm) {
      this.onConfirmKey(key, typing);
      return;
    }

    if (key.name === 'paste-start') {
      this.pasting = true;
      return;
    }
    if (key.name === 'paste-end') {
      this.pasting = false;
      return;
    }

    this.notice = '';
    if (!(key.ctrl && key.name === 'c')) {
      this.exitArmedAt = 0;
    }

    if (this.menu.length && !this.pasting) {
      if (key.name === 'up' || key.name === 'down') {
        const step = key.name === 'up' ? -1 : 1;
        this.selected = (this.selected + step + this.menu.length) % this.menu.length;
        this.render();
        return;
      }
      if (key.name === 'tab') {
        this.setBuffer(`/${this.menu[this.selected]!.name} `);
        this.afterEdit();
        return;
      }
      if (key.name === 'escape') {
        this.menu = [];
        this.render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        this.setBuffer(`/${this.menu[this.selected]!.name}`);
        this.submit();
        return;
      }
    }

    if (key.ctrl && key.name === 'c') {
      if (this.buffer) {
        this.setBuffer('');
      } else if (this.busy) {
        this.handlers.onInterrupt();
      } else if (Date.now() - this.exitArmedAt < 2000) {
        this.quit();
        return;
      } else {
        this.exitArmedAt = Date.now();
        this.notice = style.gray('Press ctrl+c again to exit');
      }
      this.afterEdit();
      return;
    }
    if (key.ctrl && key.name === 'd') {
      if (!this.buffer && !this.busy) {
        this.quit();
      }
      return;
    }
    if (key.name === 'escape') {
      if (this.busy) {
        this.handlers.onInterrupt();
      }
      return;
    }

    if ((key.name === 'return' || key.name === 'enter') && !key.meta) {
      if (this.pasting) {
        this.insert('\n');
      } else if (this.buffer[this.cursor - 1] === '\\') {
        this.buffer = `${this.buffer.slice(0, this.cursor - 1)}\n${this.buffer.slice(this.cursor)}`;
      } else {
        this.submit();
        return;
      }
      this.afterEdit();
      return;
    }
    if ((key.name === 'return' || key.name === 'enter') && key.meta) {
      this.insert('\n');
      this.afterEdit();
      return;
    }

    if (this.editKey(sequence, key)) {
      this.afterEdit();
    }
  }

  private onConfirmKey(key: Key, typing: boolean): void {
    // Keys typed in the moment the question appears, or in the middle of typing a
    // sentence, were meant for the input, not as an answer.
    if (Date.now() - this.pendingConfirm!.shownAt < 400) {
      return;
    }
    const plain = !key.ctrl && !key.meta && !typing ? key.sequence : undefined;
    const answer: ConfirmAnswer | null =
      key.name === 'return' || key.name === 'enter' || plain === 'y'
        ? 'yes'
        : plain === 'a'
          ? 'always'
          : plain === 'n' || key.name === 'escape' || (key.ctrl && key.name === 'c')
            ? 'no'
            : null;
    if (!answer) {
      return;
    }
    const { resolve } = this.pendingConfirm!;
    this.pendingConfirm = null;
    this.render();
    resolve(answer);
  }

  /** Cursor movement, deletion, history and plain typing. Returns false for ignored keys. */
  private editKey(sequence: string | undefined, key: Key): boolean {
    const { buffer, cursor } = this;
    switch (true) {
      case key.name === 'backspace' && (key.meta || key.ctrl):
      case key.ctrl && key.name === 'w': {
        const start = buffer.slice(0, cursor).replace(/\S+\s*$|\s+$/, '').length;
        this.buffer = buffer.slice(0, start) + buffer.slice(cursor);
        this.cursor = start;
        return true;
      }
      case key.name === 'backspace':
        if (cursor > 0) {
          this.buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          this.cursor -= 1;
        }
        return true;
      case key.name === 'delete' || (key.ctrl && key.name === 'd'):
        this.buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        return true;
      case key.name === 'left' || (key.ctrl && key.name === 'b'):
        this.cursor = Math.max(0, cursor - 1);
        return true;
      case key.name === 'right' || (key.ctrl && key.name === 'f'):
        this.cursor = Math.min(buffer.length, cursor + 1);
        return true;
      case key.name === 'home' || (key.ctrl && key.name === 'a'):
        this.cursor = buffer.lastIndexOf('\n', cursor - 1) + 1;
        return true;
      case key.name === 'end' || (key.ctrl && key.name === 'e'): {
        const end = buffer.indexOf('\n', cursor);
        this.cursor = end === -1 ? buffer.length : end;
        return true;
      }
      case key.ctrl && key.name === 'u':
        this.buffer = buffer.slice(cursor);
        this.cursor = 0;
        return true;
      case key.ctrl && key.name === 'k':
        this.buffer = buffer.slice(0, cursor);
        return true;
      case key.name === 'up':
        this.recall(1);
        return true;
      case key.name === 'down':
        this.recall(-1);
        return true;
      default:
        if (sequence && !key.ctrl && !key.meta && !sequence.startsWith('\x1b')) {
          // eslint-disable-next-line no-control-regex
          const text = sequence.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
          if (text) {
            this.insert(text);
            return true;
          }
        }
        return false;
    }
  }

  /** ↑/↓ through earlier messages; the unsent text comes back at the bottom. */
  private recall(step: 1 | -1): void {
    if (this.historyIndex === -1) {
      this.draft = this.buffer;
    }
    const index = Math.max(-1, Math.min(this.history.length - 1, this.historyIndex + step));
    if (index === this.historyIndex) {
      return;
    }
    this.historyIndex = index;
    this.setBuffer(index === -1 ? this.draft : this.history[this.history.length - 1 - index]!);
  }

  private insert(text: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + text + this.buffer.slice(this.cursor);
    this.cursor += text.length;
  }

  private setBuffer(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
  }

  private afterEdit(): void {
    const match = /^\/(\S*)$/.exec(this.buffer);
    const items = match ? matchSlashCommands(match[1] ?? '').slice(0, MAX_MENU_ITEMS) : [];
    const exact = items.length === 1 && `/${items[0]!.name}` === this.buffer;
    if (items.map((item) => item.name).join() !== this.menu.map((item) => item.name).join()) {
      this.selected = 0;
    }
    this.menu = exact ? [] : items;
    this.render();
  }

  private submit(): void {
    const text = this.buffer.trim();
    if (!text) {
      return;
    }
    if (this.history[this.history.length - 1] !== text) {
      this.history.push(text);
    }
    this.historyIndex = -1;
    this.draft = '';
    this.menu = [];
    this.setBuffer('');
    if (this.home) {
      // Leave the home screen. Start drawing from the last row so the box sits at the
      // bottom and the conversation scrolls up above it.
      this.home = false;
      stdout.write(`\x1b[2J\x1b[3J\x1b[${stdout.rows || 24};1H`);
      this.cursorRow = 0;
    }
    if (this.pendingRead) {
      this.render();
      this.finishRead(text);
    } else {
      this.queue.push(text);
      this.render();
    }
  }

  private quit(): void {
    this.unmount();
    this.finishRead(null);
  }

  /** Moves to the region's top-left and clears everything below. */
  private eraseSequence(): string {
    return `${this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : ''}\r\x1b[J`;
  }

  private render(): void {
    const { lines, cursor } = this.layout();
    const rows = stdout.rows || 24;
    // Never draw more than fits, or relative cursor moves would lose the region top.
    const visible = lines.slice(Math.max(0, lines.length - rows));
    const cursorRow = Math.max(0, cursor.row - (lines.length - visible.length));

    let output = `\x1b[?2026h\x1b[?25l${this.eraseSequence()}${visible.join('\r\n')}`;
    const up = visible.length - 1 - cursorRow;
    output += `${up > 0 ? `\x1b[${up}A` : ''}\r${cursor.col > 0 ? `\x1b[${cursor.col}C` : ''}`;
    output += this.pendingConfirm ? '' : '\x1b[?25h';
    output += '\x1b[?2026l';
    stdout.write(output);
    this.cursorRow = cursorRow;
  }

  private layout(): { lines: string[]; cursor: { row: number; col: number } } {
    const width = columns();
    const inner = panelContentWidth();
    const info = this.info();
    const lines: string[] = [];
    const margin = ' '.repeat(MARGIN);
    const contentColumn = MARGIN + 3;

    // Menu above the box, like opencode's command palette.
    const nameWidth = Math.max(0, ...this.menu.map((item) => `/${item.name}`.length)) + 2;
    const menuLines = this.menu.map((item, index) => {
      const name = `/${item.name}`.padEnd(nameWidth);
      const description = truncate(item.description, Math.max(8, inner - nameWidth));
      const text = `${name}${description}`.padEnd(inner + 2);
      return index === this.selected
        ? `${margin} ${COLOR ? `\x1b[48;5;141m\x1b[30m ${text}\x1b[39m\x1b[49m` : `>${text}`}`
        : `${margin}  ${style.white(name)}${style.gray(description)}`;
    });

    const box: string[] = [panelRow('')];
    let cursor = { row: 0, col: 0 };
    if (this.pendingConfirm) {
      box.push(panelRow(style.yellow('△ Permission required')));
      for (const row of wrapPlain(this.pendingConfirm.description, inner)) {
        box.push(panelRow(style.white(row)));
      }
      box.push(panelRow(''));
      box.push(
        panelRow(`${style.white('enter')} ${style.gray('allow')}  ${style.white('a')} ${style.gray('always')}  ${style.white('esc')} ${style.gray('deny')}`),
      );
      box.push(panelRow(''));
    } else {
      const { rows, row, col } = layoutInput(this.buffer, this.cursor, inner);
      const placeholder = this.busy
        ? 'Type to queue a message…'
        : this.home
          ? 'Ask anything… "What does this project do?"'
          : 'Ask anything…';
      const shown = this.buffer ? rows : wrapPlain(placeholder, inner);
      const firstInputRow = box.length;
      shown.forEach((text) => box.push(panelRow(this.buffer ? text : style.gray(text))));
      cursor = { row: firstInputRow + row, col: contentColumn + col };
      box.push(panelRow(''));
      box.push(panelRow(truncateStyled(`${info.mode} ${style.gray('·')} ${style.white(info.model || 'no model')} ${style.gray(info.provider)}`, inner)));
    }
    box.push(`${margin}${style.panelEdge('▀'.repeat(inner + 5))}`);

    // Status row: scanner + activity on the left, key hints on the right.
    const left = this.busy
      ? `${scanner(this.frame)}  ${this.activity ? style.gray(truncate(this.activity, 24)) + '  ' : ''}${style.white('esc')} ${style.gray('interrupt')}`
      : this.notice;
    const queued = this.queue.length ? `${style.accent(`${this.queue.length} queued`)}  ` : '';
    const right = `${queued}${style.white('shift+tab')} ${style.gray('mode')}  ${style.white('/')} ${style.gray('commands')}`;
    const room = width - MARGIN * 2 - 1;
    const status =
      visibleLength(left) + visibleLength(right) + 2 <= room
        ? `${left}${' '.repeat(room - visibleLength(left) - visibleLength(right))}${right}`
        : left || right;
    const statusLine = `${margin}${status}`;

    let top: string[] = [];
    let spacer: string[] = [];
    let footer: string[] = [];
    if (this.home) {
      const mark = wordmark();
      const pad = ' '.repeat(Math.max(0, Math.floor((width - mark.width) / 2)));
      // Center logo + box ignoring the menu, so opening the menu doesn't move the box.
      const rows = stdout.rows || 24;
      const above = Math.max(1, Math.floor((rows - (6 + box.length + 1) - 1) / 2) - 1);
      top = [...Array<string>(above).fill(''), ...mark.lines.map((line) => pad + line), '', ''];
      const version = info.version;
      const footerRoom = width - MARGIN * 2 - 1;
      const place = truncate(
        `${tildify(info.workspace)}${this.branch ? `:${this.branch}` : ''}`,
        footerRoom - version.length - 2,
      );
      footer = [
        `${margin}${style.gray(place)}${' '.repeat(Math.max(2, footerRoom - place.length - version.length))}${style.gray(version)}`,
      ];
      const used = top.length + box.length + 1 + footer.length;
      // The menu takes its rows from the blank lines above the logo (the logo moves up,
      // the box stays put); only what doesn't fit there comes out of the spacer below.
      const taken = Math.min(menuLines.length, above);
      top = top.slice(taken);
      spacer = Array<string>(Math.max(1, rows - used - (menuLines.length - taken))).fill('');
    }

    lines.push(...top, ...menuLines);
    const boxStart = lines.length;
    lines.push(...box, statusLine, ...spacer, ...footer);
    return { lines, cursor: { row: boxStart + cursor.row, col: cursor.col } };
  }
}

/** Wraps the input buffer to `width` and finds the cursor's row/column in it. */
function layoutInput(buffer: string, cursor: number, width: number): { rows: string[]; row: number; col: number } {
  const rows: string[] = [''];
  let row = 0;
  let col = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    const current = rows.length - 1;
    if (index === cursor) {
      if (rows[current]!.length >= width) {
        rows.push('');
      }
      row = rows.length - 1;
      col = rows[row]!.length;
    }
    if (index === buffer.length) {
      break;
    }
    const char = buffer[index]!;
    if (char === '\n') {
      rows.push('');
      continue;
    }
    if (rows[rows.length - 1]!.length >= width) {
      rows.push('');
    }
    rows[rows.length - 1] += char;
  }
  return { rows, row, col };
}

function wrapPlain(text: string, width: number): string[] {
  const rows: string[] = [];
  let rest = text.replace(/\s+/g, ' ');
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    rows.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  rows.push(rest);
  return rows.slice(0, 6);
}

/** Cuts a styled string to `width` visible columns (drops styling when it has to cut). */
function truncateStyled(text: string, width: number): string {
  if (visibleLength(text) <= width) {
    return text;
  }
  // eslint-disable-next-line no-control-regex
  return truncate(text.replace(/\x1b\[[0-9;]*m/g, ''), width);
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
