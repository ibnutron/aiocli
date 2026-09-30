import type { Interface } from 'node:readline/promises';
import { stdout } from 'node:process';
import { ask, pick as pickFromList } from './prompt.js';
import { matchSlashCommands, type SlashCommand } from './slash.js';
import { Keymap, type KeyContext } from './keybindings.js';
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
  wrapAnsi,
} from './ui.js';

interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
  /** Raw CSI code; `[<` starts an SGR mouse report. */
  code?: string;
}

type TtyWrite = (sequence: string | undefined, key: Key | undefined) => void;

export interface BoxInfo {
  /** Permission mode label, already colored (e.g. blue "Default"). */
  mode: string;
  model: string;
  provider: string;
  workspace: string;
  version: string;
  /** This chat is shared with /code through /remote-control. */
  remote?: boolean;
  /** Output of the /statusline command, shown under the box when nothing else is. */
  statusLine?: string;
}

export interface TerminalInputHandlers {
  /** Esc / Ctrl+C while a turn runs. */
  onInterrupt: () => void;
  /** Shift+Tab. */
  onCycleMode: () => void;
  /** chat:externalEditor (keybindings.json): edit the input in $EDITOR; resolves to the new text. */
  onExternalEditor?: (text: string) => Promise<string | null>;
}

export type ConfirmAnswer = 'yes' | 'always' | 'no';

export interface PickItem {
  label: string;
  /** Dimmed text after the label (e.g. the provider). */
  detail?: string;
  /** Right-aligned hint (e.g. "Free"). */
  hint?: string;
  value: string;
  /** Marked with ● (the current choice). */
  current?: boolean;
  /** Shown but not selectable (e.g. "Could not load models"). */
  disabled?: boolean;
}

export interface PickSection {
  title?: string;
  items: PickItem[];
}

export interface PickOptions {
  title: string;
  sections: PickSection[];
  /** Ctrl+<key> shortcuts shown at the bottom; picking one resolves to its value. */
  actions?: { key: string; label: string; value: string }[];
}

type PickRow = { header: string } | { item: PickItem };

/** Clickable area of the box: `row` is an index into the laid-out lines, columns are 0-based. */
interface Hotspot {
  row: number;
  from: number;
  to: number;
  action: () => void;
}

const MAX_TRANSCRIPT = 2000;

interface PickState {
  options: PickOptions;
  query: string;
  /** Index into the selectable items of the filtered rows. */
  selected: number;
  resolve: (value: string | null) => void;
}

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
  /** The box was taken down for plain readline output (connect); re-anchor on mount. */
  private suspended = false;

  /**
   * Screen model: the box is always drawn on the last `regionHeight` rows;
   * above it, `contentRows` rows show the end of `transcript` (everything
   * printed), top-aligned until the screen fills up, then scrolling.
   */
  private readonly transcript: string[] = [];
  private contentRows = 0;
  private regionHeight = 0;
  private regionTop = 1;
  private lineOffset = 0;
  private hotspots: Hotspot[] = [];
  private mouseOn = false;
  /** SGR mouse report being assembled from single-character key events. */
  private mouseReport: string | null = null;

  private buffer = '';
  private cursor = 0;
  /** Shortcuts from keybindings.json. */
  private readonly keymap = new Keymap();
  /** /vim: Esc switches to normal mode, i/a/A/I back to insert. */
  private vimEnabled = false;
  private vimNormal = false;
  private vimPending = '';
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
  private picking: PickState | null = null;
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
        stdout.write('\x1b[2J');
        this.regionHeight = 0;
        this.render();
      }
    });
    process.once('exit', () => {
      stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?25h');
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
    this.transcript.length = 0;
    this.contentRows = 0;
    this.regionHeight = 0;
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

  /**
   * Writes `text` (one or more lines) above the box. Once the area above the
   * box is full, the whole screen scrolls (so older lines reach the terminal's
   * scrollback) and the box is redrawn at the bottom.
   */
  print(text: string): void {
    if (!this.mounted) {
      stdout.write(`${text}\n`);
      return;
    }
    const width = columns();
    const lines = text.split('\n').flatMap((line) => wrapAnsi(line, width));
    this.transcript.push(...lines);
    this.transcript.splice(0, Math.max(0, this.transcript.length - MAX_TRANSCRIPT));

    const rows = screenRows();
    const area = Math.max(1, rows - this.regionHeight);
    let output = '\x1b[?2026h\x1b[?25l';
    for (let start = 0; start < lines.length; start += area) {
      const chunk = lines.slice(start, start + area);
      const scroll = Math.max(0, chunk.length - (area - this.contentRows));
      if (scroll) {
        output += `\x1b[${rows};1H${'\n'.repeat(scroll)}`;
      }
      const first = this.contentRows - scroll + 1;
      chunk.forEach((line, index) => {
        output += `\x1b[${first + index};1H\x1b[2K${line}`;
      });
      this.contentRows = first - 1 + chunk.length;
    }
    stdout.write(output);
    this.render();
  }

  /** Removes the box and gives the terminal back to plain readline (connect asks for keys). */
  unmount(): void {
    if (!this.mounted) {
      return;
    }
    stdout.write(`\x1b[${this.regionTop};1H\x1b[J\x1b[?25h\x1b[?2004l${this.mouseOn ? '\x1b[?1000l\x1b[?1006l' : ''}`);
    this.mouseOn = false;
    this.mounted = false;
    this.suspended = true;
    this.regionHeight = 0;
  }

  /** Clears the screen and scrollback; the box stays at the bottom. */
  clearScreen(): void {
    if (!this.enhanced) {
      stdout.write('\x1b[2J\x1b[3J\x1b[H');
      return;
    }
    this.home = false;
    stdout.write('\x1b[2J\x1b[3J');
    this.transcript.length = 0;
    this.contentRows = 0;
    this.regionHeight = 0;
    this.refresh();
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

  /**
   * opencode-style dialog inside the box: a title, a search field, grouped
   * items (↑/↓, Enter; typing filters), Esc to cancel. Resolves to the picked
   * item's or action's value, or null.
   */
  async pick(options: PickOptions): Promise<string | null> {
    if (!this.enhanced) {
      const items = options.sections.flatMap((section) =>
        section.items.filter((item) => !item.disabled).map((item) => ({ ...item, section: section.title })),
      );
      const choice = await pickFromList(
        this.rl,
        options.title,
        items.map((item) => `${item.current ? '●' : ' '} ${item.label}${item.detail ? `  ${item.detail}` : ''}`),
      );
      return choice === null ? null : items[choice]!.value;
    }
    this.mount();
    return new Promise((resolve) => {
      const flat = options.sections.flatMap((section) => section.items.filter((item) => !item.disabled));
      this.picking = {
        options,
        query: '',
        selected: Math.max(
          0,
          flat.findIndex((item) => item.current),
        ),
        resolve,
      };
      this.render();
    });
  }

  private finishPick(value: string | null): void {
    const state = this.picking!;
    this.picking = null;
    this.render();
    state.resolve(value);
  }

  private onPickKey(sequence: string | undefined, key: Key): void {
    const state = this.picking!;
    const selectable = pickRows(state).filter((row): row is { item: PickItem } => 'item' in row && !row.item.disabled);
    const page = Math.max(1, this.pickListHeight() - 2);
    const action = key.ctrl ? state.options.actions?.find((candidate) => candidate.key === key.name) : undefined;
    if (action) {
      this.finishPick(action.value);
      return;
    }
    switch (true) {
      case key.name === 'escape' || (key.ctrl && key.name === 'c'):
        this.finishPick(null);
        return;
      case key.name === 'return' || key.name === 'enter':
        if (selectable[state.selected]) {
          this.finishPick(selectable[state.selected]!.item.value);
        }
        return;
      case key.name === 'up':
        state.selected = (state.selected - 1 + selectable.length) % Math.max(1, selectable.length);
        break;
      case key.name === 'down':
        state.selected = (state.selected + 1) % Math.max(1, selectable.length);
        break;
      case key.name === 'pageup':
        state.selected = Math.max(0, state.selected - page);
        break;
      case key.name === 'pagedown':
        state.selected = Math.min(selectable.length - 1, state.selected + page);
        break;
      case key.name === 'backspace':
        state.query = state.query.slice(0, -1);
        state.selected = 0;
        break;
      default:
        if (sequence && !key.ctrl && !key.meta && !sequence.startsWith('\x1b') && sequence >= ' ') {
          state.query += sequence;
          state.selected = 0;
          break;
        }
        return;
    }
    this.render();
  }

  /** Rows the dialog's list may use on this screen. */
  private pickListHeight(): number {
    return Math.max(4, (stdout.rows || 24) - 12);
  }

  private pickLines(inner: number): { lines: string[]; searchRow: number; spots: Hotspot[] } {
    const state = this.picking!;
    const rows = pickRows(state);
    const lines: string[] = [];
    const spots: Hotspot[] = [];
    const contentColumn = MARGIN + 3;
    lines.push(panelRow(''));
    const title = style.bold(style.white(state.options.title));
    spots.push({
      row: lines.length,
      from: contentColumn + inner - 5,
      to: contentColumn + inner + 2,
      action: () => this.finishPick(null),
    });
    lines.push(panelRow(`${title}${' '.repeat(Math.max(1, inner - visibleLength(title) - 3))}${style.gray('esc')}`));
    lines.push(panelRow(''));
    const searchRow = lines.length;
    lines.push(panelRow(state.query ? style.white(truncate(state.query, inner)) : style.gray('Search')));
    lines.push(panelRow(''));

    let selectableIndex = -1;
    const rendered = rows.map((row) => {
      if ('header' in row) {
        return { text: style.accent(style.bold(truncate(row.header, inner))), selected: false, value: undefined };
      }
      const { item } = row;
      const isSelected = !item.disabled && ++selectableIndex === state.selected;
      const marker = item.current ? '● ' : '  ';
      const hint = item.hint ?? '';
      const room = inner - marker.length - (hint ? hint.length + 2 : 0);
      const label = truncate(item.label, room);
      const detail = item.detail ? truncate(item.detail, Math.max(0, room - label.length - 1)) : '';
      const plain = `${marker}${label}${detail ? ` ${detail}` : ''}`;
      const gap = ' '.repeat(Math.max(hint ? 2 : 0, inner - plain.length - hint.length));
      const value = item.disabled ? undefined : item.value;
      if (isSelected) {
        const text = `${plain}${gap}${hint}`.padEnd(inner);
        return {
          text: COLOR ? `\x1b[48;5;141m\x1b[30m${text}\x1b[39m\x1b[49m` : `>${text.slice(1)}`,
          selected: true,
          value,
        };
      }
      const styledLabel = item.disabled ? style.gray(label) : style.white(label);
      return {
        text: `${marker}${styledLabel}${detail ? ` ${style.gray(detail)}` : ''}${gap}${style.gray(hint)}`,
        selected: false,
        value,
      };
    });
    if (!rendered.length) {
      rendered.push({ text: style.gray('No matches'), selected: false, value: undefined });
    }
    // Keep the selected item in view.
    const height = this.pickListHeight();
    const selectedAt = Math.max(
      0,
      rendered.findIndex((row) => row.selected),
    );
    const start = Math.min(Math.max(0, selectedAt - Math.floor(height / 2)), Math.max(0, rendered.length - height));
    for (const row of rendered.slice(start, start + height)) {
      const { value } = row;
      if (value !== undefined) {
        spots.push({
          row: lines.length,
          from: MARGIN,
          to: contentColumn + inner + 2,
          action: () => this.finishPick(value),
        });
      }
      lines.push(panelRow(row.text));
    }

    const actions = state.options.actions ?? [];
    if (actions.length) {
      lines.push(panelRow(''));
      let column = contentColumn;
      for (const action of actions) {
        const width = `${action.label} ctrl+${action.key}`.length;
        spots.push({
          row: lines.length,
          from: column,
          to: column + width,
          action: () => this.finishPick(action.value),
        });
        column += width + 3;
      }
      lines.push(
        panelRow(
          truncateStyled(
            actions.map((action) => `${style.white(action.label)} ${style.gray(`ctrl+${action.key}`)}`).join('   '),
            inner,
          ),
        ),
      );
    }
    lines.push(panelRow(''));
    return { lines, searchRow, spots };
  }

  private mount(): void {
    if (!this.mounted) {
      // Bracketed paste: a pasted multi-line text arrives as one message, not one per line.
      stdout.write('\x1b[?2004h');
    }
    if (this.suspended) {
      // Plain readline wrote below the old box: scroll it up out of the box's way
      // and keep it on screen (it isn't in the transcript, so don't repaint over it).
      const rows = screenRows();
      const height = Math.min(this.layout().lines.length, rows);
      stdout.write(`\x1b[${rows};1H${'\n'.repeat(height)}`);
      this.regionHeight = height;
      this.contentRows = rows - height;
      this.suspended = false;
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
    if (this.mouseReport !== null) {
      if (sequence === 'M' || sequence === 'm') {
        const report = this.mouseReport;
        this.mouseReport = null;
        this.onMouse(report, sequence === 'M');
      } else {
        this.mouseReport += sequence ?? '';
      }
      return;
    }
    if (key.code === '[<') {
      this.mouseReport = '';
      return;
    }
    if (!this.picking && !this.pasting) {
      const context: KeyContext = this.pendingConfirm ? 'Confirmation' : this.menu.length ? 'Autocomplete' : 'Chat';
      const action = this.keymap.resolve(context, sequence, key);
      if (action !== undefined) {
        if (typeof action === 'string' && action !== 'pending') {
          this.runAction(action);
        }
        return;
      }
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
    if (this.picking) {
      this.onPickKey(sequence, key);
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
        this.runMenuItem(this.menu[this.selected]!);
        return;
      }
      if (key.name === 'escape') {
        this.menu = [];
        this.render();
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        this.runMenuItem(this.menu[this.selected]!);
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
      } else if (this.vimEnabled && !this.vimNormal) {
        this.vimNormal = true;
        this.cursor = Math.max(0, this.cursor - 1);
        this.render();
      }
      return;
    }

    if (this.vimEnabled && this.vimNormal && !this.pasting && !key.ctrl && !key.meta) {
      if (key.name === 'return' || key.name === 'enter') {
        this.vimNormal = false;
        this.submit();
        return;
      }
      if (this.vimKey(sequence, key)) {
        this.afterEdit();
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
    if (answer) {
      this.answerConfirm(answer);
    }
  }

  /** Runs a keybindings.json action. */
  private runAction(action: string): void {
    switch (action) {
      case 'app:interrupt':
        if (this.busy) this.handlers.onInterrupt();
        return;
      case 'app:redraw':
      case 'chat:clearInput':
        this.regionHeight = 0;
        this.render();
        return;
      case 'chat:submit':
        this.submit();
        return;
      case 'chat:newline':
        this.insert('\n');
        this.afterEdit();
        return;
      case 'chat:cancel':
        this.setBuffer('');
        this.afterEdit();
        return;
      case 'chat:cycleMode':
        this.handlers.onCycleMode();
        return;
      case 'chat:modelPicker':
        this.setBuffer('/models');
        this.submit();
        return;
      case 'chat:externalEditor':
        void this.handlers.onExternalEditor?.(this.buffer).then((text) => {
          if (text !== null) {
            this.setBuffer(text.replace(/\n+$/, ''));
          }
          this.afterEdit();
        });
        return;
      case 'history:previous':
        this.recall(1);
        this.afterEdit();
        return;
      case 'history:next':
        this.recall(-1);
        this.afterEdit();
        return;
      case 'autocomplete:accept':
        if (this.menu.length) this.runMenuItem(this.menu[this.selected]!);
        return;
      case 'autocomplete:dismiss':
        this.menu = [];
        this.render();
        return;
      case 'autocomplete:previous':
      case 'autocomplete:next':
        if (this.menu.length) {
          const step = action === 'autocomplete:previous' ? -1 : 1;
          this.selected = (this.selected + step + this.menu.length) % this.menu.length;
          this.render();
        }
        return;
      case 'confirm:yes':
        this.answerConfirm('yes');
        return;
      case 'confirm:no':
        this.answerConfirm('no');
        return;
    }
  }

  /** Turns vim editing mode on or off (/vim). */
  setVim(enabled: boolean): void {
    this.vimEnabled = enabled;
    this.vimNormal = false;
    this.vimPending = '';
    this.refresh();
  }

  /** Normal-mode keys of /vim. Returns true when the buffer or cursor changed. */
  private vimKey(sequence: string | undefined, key: Key): boolean {
    const { buffer, cursor } = this;
    const lineStart = buffer.lastIndexOf('\n', cursor - 1) + 1;
    const lineEndAt = buffer.indexOf('\n', cursor);
    const lineEnd = lineEndAt === -1 ? buffer.length : lineEndAt;
    const pending = this.vimPending;
    this.vimPending = '';
    const insert = (at: number) => {
      this.cursor = Math.max(0, Math.min(buffer.length, at));
      this.vimNormal = false;
    };
    switch (
      key.name === 'left'
        ? 'h'
        : key.name === 'right'
          ? 'l'
          : key.name === 'up'
            ? 'k'
            : key.name === 'down'
              ? 'j'
              : sequence
    ) {
      case 'h':
        this.cursor = Math.max(lineStart, cursor - 1);
        return true;
      case 'l':
        this.cursor = Math.min(Math.max(lineStart, lineEnd - 1), cursor + 1);
        return true;
      case '0':
        this.cursor = lineStart;
        return true;
      case '$':
        this.cursor = Math.max(lineStart, lineEnd - 1);
        return true;
      case 'w': {
        const match = /\S*\s+\S/.exec(buffer.slice(cursor));
        this.cursor = match ? cursor + match[0].length - 1 : buffer.length;
        return true;
      }
      case 'b': {
        const before = buffer.slice(0, cursor).replace(/\s+$/, '');
        this.cursor = before.replace(/\S+$/, '').length;
        return true;
      }
      case 'e': {
        const match = /^\s*\S+/.exec(buffer.slice(cursor + 1));
        this.cursor = match ? cursor + match[0].length : cursor;
        return true;
      }
      case 'x':
        this.buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
        this.cursor = Math.min(cursor, Math.max(0, this.buffer.length - 1));
        return true;
      case 'X':
        if (cursor > lineStart) {
          this.buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          this.cursor = cursor - 1;
        }
        return true;
      case 'D':
      case 'C':
        this.buffer = buffer.slice(0, cursor) + buffer.slice(lineEnd);
        if (sequence === 'C') insert(cursor);
        else this.cursor = Math.max(lineStart, cursor - 1);
        return true;
      case 'd':
      case 'c':
        if (pending === sequence) {
          this.buffer = buffer.slice(0, lineStart) + buffer.slice(Math.min(buffer.length, lineEnd + 1));
          this.cursor = Math.min(lineStart, this.buffer.length);
          if (sequence === 'c') insert(this.cursor);
        } else {
          this.vimPending = sequence ?? '';
        }
        return true;
      case 'S':
        this.buffer = buffer.slice(0, lineStart) + buffer.slice(lineEnd);
        insert(lineStart);
        return true;
      case 'i':
        insert(cursor);
        return true;
      case 'a':
        insert(Math.min(lineEnd, cursor + 1));
        return true;
      case 'A':
        insert(lineEnd);
        return true;
      case 'I':
        insert(lineStart);
        return true;
      case 'k':
        this.recall(1);
        return true;
      case 'j':
        this.recall(-1);
        return true;
      default:
        return false;
    }
  }

  /** Closes an open Allow/Deny question that was answered elsewhere (e.g. from /code). */
  cancelConfirm(): void {
    this.answerConfirm('no');
  }

  private answerConfirm(answer: ConfirmAnswer): void {
    const pending = this.pendingConfirm;
    if (!pending) {
      return;
    }
    this.pendingConfirm = null;
    this.render();
    pending.resolve(answer);
  }

  /**
   * Menu choice (Tab, Enter or a click): commands that need an argument are
   * completed into the input, the others run right away.
   */
  private runMenuItem(item: SlashCommand): void {
    if (item.args?.startsWith('<')) {
      this.setBuffer(`/${item.name} `);
      this.afterEdit();
      return;
    }
    this.setBuffer(`/${item.name}`);
    this.submit();
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
    // Leaving the home screen: the box shrinks to the bottom, the conversation starts at the top.
    this.home = false;
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

  /** Draws the box on the bottom rows (and the conversation above it when the box changed height). */
  private render(): void {
    const { lines, cursor, hotspots } = this.layout();
    const rows = screenRows();
    const height = Math.min(lines.length, rows);
    const offset = lines.length - height;
    const top = rows - height + 1;

    let output = '\x1b[?2026h\x1b[?25l';
    if (height !== this.regionHeight) {
      output += this.paintContent(rows - height);
    }
    lines.slice(offset).forEach((line, index) => {
      output += `\x1b[${top + index};1H\x1b[2K${line}`;
    });

    // Mouse reporting only while a dialog is open, so text selection works otherwise.
    const wantMouse = Boolean(this.picking || this.pendingConfirm);
    if (wantMouse !== this.mouseOn) {
      output += wantMouse ? '\x1b[?1000h\x1b[?1006h' : '\x1b[?1000l\x1b[?1006l';
      this.mouseOn = wantMouse;
    }

    const cursorRow = Math.max(top, top + cursor.row - offset);
    output += `\x1b[${cursorRow};${cursor.col + 1}H${this.pendingConfirm ? '' : '\x1b[?25h'}\x1b[?2026l`;
    stdout.write(output);

    this.regionHeight = height;
    this.regionTop = top;
    this.lineOffset = offset;
    this.hotspots = hotspots;
  }

  /** Repaints the rows above the box with the end of the transcript. */
  private paintContent(area: number): string {
    const tail = area > 0 ? this.transcript.slice(-area) : [];
    let output = '';
    for (let row = 1; row <= area; row += 1) {
      output += `\x1b[${row};1H\x1b[2K${tail[row - 1] ?? ''}`;
    }
    this.contentRows = tail.length;
    return output;
  }

  private onMouse(report: string, pressed: boolean): void {
    const [button = 0, x = 0, y = 0] = report.split(';').map(Number);
    if (this.picking && (button === 64 || button === 65)) {
      this.onPickKey(undefined, { name: button === 64 ? 'up' : 'down' });
      return;
    }
    if (!pressed || button !== 0) {
      return;
    }
    const row = y - this.regionTop + this.lineOffset;
    this.hotspots.find((spot) => spot.row === row && x - 1 >= spot.from && x - 1 < spot.to)?.action();
  }

  private layout(): { lines: string[]; cursor: { row: number; col: number }; hotspots: Hotspot[] } {
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

    let box: string[] = [panelRow('')];
    let boxSpots: Hotspot[] = [];
    let cursor = { row: 0, col: 0 };
    if (this.picking) {
      const { lines: pickLines, searchRow, spots } = this.pickLines(inner);
      box = pickLines;
      boxSpots = spots;
      cursor = { row: searchRow, col: contentColumn + Math.min(this.picking.query.length, inner) };
    } else if (this.pendingConfirm) {
      box.push(panelRow(style.yellow('△ Permission required')));
      for (const row of wrapPlain(this.pendingConfirm.description, inner)) {
        box.push(panelRow(style.white(row)));
      }
      box.push(panelRow(''));
      const answer = (value: ConfirmAnswer) => () => this.answerConfirm(value);
      boxSpots = [
        { row: box.length, from: contentColumn, to: contentColumn + 11, action: answer('yes') },
        { row: box.length, from: contentColumn + 13, to: contentColumn + 21, action: answer('always') },
        { row: box.length, from: contentColumn + 23, to: contentColumn + 31, action: answer('no') },
      ];
      box.push(
        panelRow(
          `${style.white('enter')} ${style.gray('allow')}  ${style.white('a')} ${style.gray('always')}  ` +
            `${style.white('esc')} ${style.gray('deny')}`,
        ),
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
      box.push(
        panelRow(
          truncateStyled(
            `${info.mode} ${style.gray('·')} ${style.white(info.model || 'no model')} ${style.gray(info.provider)}`,
            inner,
          ),
        ),
      );
    }
    box.push(`${margin}${style.panelEdge('▀'.repeat(inner + 5))}`);

    // Status row: scanner + activity on the left, key hints on the right.
    const vimMode = this.vimEnabled
      ? `${this.vimNormal ? style.yellow('-- NORMAL --') : style.gray('-- INSERT --')}  `
      : '';
    const left = this.busy
      ? `${scanner(this.frame)}  ${this.activity ? style.gray(truncate(this.activity, 24)) + '  ' : ''}` +
        `${style.white('esc')} ${style.gray('interrupt')}`
      : `${vimMode}${this.notice || style.gray(this.info().statusLine ?? '')}`;
    const queued = this.queue.length ? `${style.accent(`${this.queue.length} queued`)}  ` : '';
    const remote = this.info().remote ? `${style.green('/rc active')}  ` : '';
    const right = this.picking
      ? `${style.white('↑↓')} ${style.gray('select')}  ${style.white('enter')} ${style.gray('confirm')}`
      : `${remote}${queued}${style.white('shift+tab')} ${style.gray('mode')}  ` +
        `${style.white('/')} ${style.gray('commands')}`;
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
      const rows = screenRows();
      const above = Math.max(1, Math.floor((rows - (6 + box.length + 1) - 1) / 2) - 1);
      top = [...Array<string>(above).fill(''), ...mark.lines.map((line) => pad + line), '', ''];
      const version = info.version;
      const footerRoom = width - MARGIN * 2 - 1;
      const place = truncate(
        `${tildify(info.workspace)}${this.branch ? `:${this.branch}` : ''}`,
        footerRoom - version.length - 2,
      );
      footer = [
        `${margin}${style.gray(place)}` +
          `${' '.repeat(Math.max(2, footerRoom - place.length - version.length))}${style.gray(version)}`,
      ];
      const used = top.length + box.length + 1 + footer.length;
      // The menu takes its rows from the blank lines above the logo (the logo moves up,
      // the box stays put); only what doesn't fit there comes out of the spacer below.
      const taken = Math.min(menuLines.length, above);
      top = top.slice(taken);
      spacer = Array<string>(Math.max(1, rows - used - (menuLines.length - taken))).fill('');
    }

    lines.push(...top);
    const menuStart = lines.length;
    lines.push(...menuLines);
    const boxStart = lines.length;
    lines.push(...box, statusLine, ...spacer, ...footer);
    const hotspots: Hotspot[] = [
      ...this.menu.map((item, index) => ({
        row: menuStart + index,
        from: MARGIN,
        to: width,
        action: () => this.runMenuItem(item),
      })),
      ...boxSpots.map((spot) => ({ ...spot, row: boxStart + spot.row })),
    ];
    return { lines, cursor: { row: boxStart + cursor.row, col: cursor.col }, hotspots };
  }
}

function screenRows(): number {
  return Math.max(8, stdout.rows || 24);
}

/** The dialog's rows after filtering by the search query (every word must match). */
function pickRows(state: PickState): PickRow[] {
  const words = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: PickRow[] = [];
  for (const section of state.options.sections) {
    const items = section.items.filter((item) => {
      const haystack = `${item.label} ${item.detail ?? ''} ${section.title ?? ''} ${item.value}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    if (!items.length) {
      continue;
    }
    if (section.title) {
      if (rows.length) {
        rows.push({ header: '' });
      }
      rows.push({ header: section.title });
    }
    rows.push(...items.map((item) => ({ item })));
  }
  return rows;
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
