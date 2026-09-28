import { homedir } from 'node:os';
import { stdout } from 'node:process';

/**
 * Terminal styling for the interactive chat (no dependencies). Colors are
 * off when stdout is not a TTY or NO_COLOR is set, so piped output stays plain.
 */
const COLOR = stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function paint(open: string, close: string): (text: string) => string {
  return (text) => (COLOR ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const style = {
  bold: paint('1', '22'),
  dim: paint('2', '22'),
  italic: paint('3', '23'),
  red: paint('31', '39'),
  green: paint('32', '39'),
  yellow: paint('33', '39'),
  blue: paint('34', '39'),
  cyan: paint('36', '39'),
  gray: paint('90', '39'),
  /** aiolah brand accent. */
  accent: paint('38;5;141', '39'),
  inverse: paint('7', '27'),
};

export const isInteractiveTerminal = stdout.isTTY === true;

export function terminalWidth(): number {
  return Math.max(40, Math.min(stdout.columns || 80, 120));
}

/** Visible length, ignoring ANSI escapes. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

/** Replaces the home directory with `~`. */
export function tildify(path: string): string {
  const home = homedir();
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** A dim full-width rule, optionally with labels on the left and right. */
export function rule(left = '', right = ''): string {
  const width = terminalWidth();
  const leftPart = left ? `${style.gray('── ')}${left} ` : '';
  const rightPart = right ? ` ${right}${style.gray(' ──')}` : '';
  const fill = Math.max(2, width - visibleLength(leftPart) - visibleLength(rightPart));
  return `${leftPart}${style.gray('─'.repeat(fill))}${rightPart}`;
}

const LOGO = ['▗▄▄▄▖', '▐▛▀▜▌', '▝▀▀▀▘'];

export interface BannerInfo {
  version: string;
  provider: string;
  model: string;
  account?: string;
  workspace: string;
}

/** Welcome header shown when `aiolah chat` starts. */
export function banner(info: BannerInfo): string {
  const lines = [
    `${style.bold('aiolah')} ${style.gray(`v${info.version}`)}`,
    `${info.model ? style.bold(info.model) : style.yellow('no model')} ${style.gray('·')} ${info.provider}${
      info.account ? style.gray(` · ${info.account}`) : ''
    }`,
    style.gray(tildify(info.workspace)),
  ];
  return LOGO.map((part, index) => ` ${style.accent(part)}  ${lines[index] ?? ''}`).join('\n') + '\n';
}

/** Tool call as a one-line title, e.g. `Read(src/app.ts)` or `Bash(npm test)`. */
export function toolTitle(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const labels: Record<string, [string, string]> = {
    read_file: ['Read', 'path'],
    write_file: ['Write', 'path'],
    edit_file: ['Update', 'path'],
    list_dir: ['List', 'path'],
    run_bash: ['Bash', 'command'],
  };
  const [label, key] = labels[name] ?? [name, ''];
  const argument = key ? String(args[key] ?? '') : JSON.stringify(args);
  return `${style.bold(label)}${style.gray('(')}${truncate(argument, terminalWidth() - label.length - 8)}${style.gray(')')}`;
}

/** Short summary of a tool result, shown under the tool title. */
export function toolSummary(name: string, input: unknown, result: string): string {
  const args = (input ?? {}) as Record<string, unknown>;
  if (/^Error:/.test(result)) {
    return style.red(truncate(result, terminalWidth() - 8));
  }
  if (result === 'User declined this action.') {
    return style.yellow('Declined');
  }
  if (result.startsWith('Interrupted by the user')) {
    return style.red('Interrupted');
  }
  const lineCount = (text: string) => (text ? text.replace(/\n$/, '').split('\n').length : 0);
  switch (name) {
    case 'read_file':
      return `Read ${style.bold(String(lineCount(result)))} lines`;
    case 'list_dir':
      return `Listed ${style.bold(String(lineCount(result)))} entries`;
    case 'write_file':
      return `Wrote ${style.bold(String(lineCount(String(args.content ?? ''))))} lines to ${String(args.path ?? '')}`;
    case 'edit_file': {
      const removed = lineCount(String(args.old_string ?? ''));
      const added = lineCount(String(args.new_string ?? ''));
      return `Updated ${String(args.path ?? '')} ${style.green(`+${added}`)} ${style.red(`-${removed}`)}`;
    }
    case 'run_bash': {
      const match = /^exit code: (-?\d+|null)\nstdout:\n([\s\S]*?)\nstderr:\n([\s\S]*)$/.exec(result);
      if (!match) {
        return truncate(result, terminalWidth() - 8);
      }
      const [, code, out = '', err = ''] = match;
      const output = (out.trim() || err.trim()).split('\n');
      const preview = output
        .slice(0, 3)
        .map((line) => truncate(line, terminalWidth() - 8))
        .join('\n     ');
      const more = output.length > 3 ? style.gray(`\n     … +${output.length - 3} lines`) : '';
      const status = code === '0' ? '' : style.red(`exit ${code}`) + (preview ? '\n     ' : '');
      return `${status}${style.gray(preview) || (code === '0' ? style.gray('(no output)') : '')}${more}`;
    }
    default:
      return truncate(result, terminalWidth() - 8);
  }
}

/**
 * Light Markdown rendering for model replies: headings, bold, inline code,
 * fenced code blocks, bullets and quotes. Keeps the text readable as-is when
 * colors are off.
 */
export function renderMarkdown(text: string): string {
  if (!COLOR) {
    return text;
  }
  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return style.gray(line);
      }
      if (inFence) {
        return style.cyan(line);
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        return style.bold(inline(heading[2] ?? ''));
      }
      if (/^\s*>\s?/.test(line)) {
        return style.gray('│ ') + style.italic(inline(line.replace(/^\s*>\s?/, '')));
      }
      return inline(line.replace(/^(\s*)[-*]\s+/, '$1• '));
    })
    .join('\n');
}

function inline(line: string): string {
  return line
    .replace(/`([^`]+)`/g, (_, code: string) => style.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => style.bold(bold));
}

/** Indents every line after the first so a block lines up after a `● ` marker. */
export function hangingIndent(text: string, indent = '  '): string {
  return text.replace(/\n/g, `\n${indent}`);
}

const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const SPINNER_WORDS = ['Thinking', 'Working', 'Pondering', 'Cooking', 'Crafting', 'Brewing'];

/** "✻ Thinking… (3s · esc to interrupt)" on one line; a no-op outside a TTY. */
export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private startedAt = 0;
  private word = SPINNER_WORDS[0]!;

  start(): void {
    if (!isInteractiveTerminal || this.timer) {
      return;
    }
    if (!this.startedAt) {
      this.startedAt = Date.now();
      this.word = SPINNER_WORDS[Math.floor(Math.random() * SPINNER_WORDS.length)]!;
    }
    stdout.write('\x1b[?25l');
    this.render();
    this.timer = setInterval(() => this.render(), 120);
  }

  /** Clears the line; `reset` also restarts the elapsed timer for the next turn. */
  stop(reset = false): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      stdout.write('\r\x1b[2K\x1b[?25h');
    }
    if (reset) {
      this.startedAt = 0;
    }
  }

  private render(): void {
    this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    stdout.write(
      `\r\x1b[2K${style.accent(SPINNER_FRAMES[this.frame]!)} ${style.accent(`${this.word}…`)} ${style.gray(
        `(${seconds}s · esc to interrupt)`,
      )}`,
    );
  }
}
