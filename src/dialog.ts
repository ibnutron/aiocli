import { emitKeypressEvents, type Key } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { style } from './ui.js';

export interface SelectDialog {
  /** First line, already styled. */
  title: string;
  /** Lines between the title and the choices (plain text is indented, not styled). */
  body: string[];
  choices: string[];
  /** Footer hint; defaults to "Enter to confirm · Esc to cancel". */
  hint?: string;
}

/**
 * Claude Code-style question drawn in place before the chat box exists:
 * ↑/↓ (or Tab, j/k) to move, a number to pick directly, Enter to confirm.
 * Resolves to the chosen index, or null for Esc / Ctrl+C. Needs a TTY on
 * both stdin and stdout; callers check that first.
 */
export function selectDialog(dialog: SelectDialog): Promise<number | null> {
  return new Promise((resolveAnswer) => {
    let selected = 0;
    let drawn = 0;
    const draw = () => {
      const lines = [
        '',
        ` ${dialog.title}`,
        ...dialog.body.map((line) => (line ? ` ${line}` : '')),
        '',
        ...dialog.choices.map((choice, index) => {
          const label = `${index + 1}. ${choice}`;
          return index === selected ? ` ${style.accent(`❯ ${label}`)}` : `   ${label}`;
        }),
        '',
        ` ${style.gray(dialog.hint ?? 'Enter to confirm · Esc to cancel')}`,
        '',
      ];
      stdout.write(`${drawn ? `\x1b[${drawn}A\r\x1b[J` : ''}${lines.join('\n')}\n`);
      drawn = lines.length;
    };

    const finish = (choice: number | null) => {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?25h');
      resolveAnswer(choice);
    };

    const onKey = (sequence: string | undefined, key: Key | undefined) => {
      const name = key?.name;
      const count = dialog.choices.length;
      if ((key?.ctrl && name === 'c') || name === 'escape') {
        finish(null);
      } else if (name === 'up' || name === 'k') {
        selected = (selected + count - 1) % count;
        draw();
      } else if (name === 'down' || name === 'j' || name === 'tab') {
        selected = (selected + 1) % count;
        draw();
      } else if (sequence && /^[1-9]$/.test(sequence) && Number(sequence) <= count) {
        selected = Number(sequence) - 1;
        draw();
        finish(selected);
      } else if (name === 'return' || name === 'enter') {
        finish(selected);
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

/** Both ends are a terminal, so a dialog can be shown. */
export function canAsk(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}
