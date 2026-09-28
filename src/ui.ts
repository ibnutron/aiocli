import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stdout } from 'node:process';

/**
 * Terminal styling for the interactive chat (no dependencies), modelled on
 * opencode's TUI. Colors are off when stdout is not a TTY or NO_COLOR is set,
 * so piped output stays plain.
 */
export const COLOR = stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function paint(open: string, close: string): (text: string) => string {
  return (text) => (COLOR ? `\x1b[${open}m${text}\x1b[${close}m` : text);
}

export const style = {
  bold: paint('1', '22'),
  italic: paint('3', '23'),
  red: paint('31', '39'),
  green: paint('32', '39'),
  yellow: paint('33', '39'),
  blue: paint('38;5;75', '39'),
  cyan: paint('36', '39'),
  gray: paint('90', '39'),
  white: paint('97', '39'),
  /** aiolah brand accent. */
  accent: paint('38;5;141', '39'),
  /** Background of the input box and user messages. */
  panel: paint('48;5;235', '49'),
  /** Foreground in the panel color, for the half-block bottom edge. */
  panelEdge: paint('38;5;235', '39'),
  /** Custom 256-color foreground. */
  fg: (color: number, text: string) => (COLOR ? `\x1b[38;5;${color}m${text}\x1b[39m` : text),
};

/** Full terminal width (at least 30 columns). */
export function columns(): number {
  return Math.max(30, stdout.columns || 80);
}

/** Visible length, ignoring ANSI escapes. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length;
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

/** Hard-wraps plain text to `width` columns, breaking on spaces where possible. */
export function wrapText(text: string, width: number): string[] {
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    let rest = line;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) {
        cut = width;
      }
      rows.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, '');
    }
    rows.push(rest);
  }
  return rows;
}

/** Left margin of the box / message bar, and where text inside it starts. */
export const MARGIN = 2;
export const CONTENT_INDENT = MARGIN + 3;

/**
 * One row of an opencode-style panel: margin, colored bar, dark background.
 * `content` must already fit in `panelContentWidth()`.
 */
export function panelRow(content: string, bar: (text: string) => string = style.accent): string {
  const width = panelContentWidth();
  const padding = ' '.repeat(Math.max(0, width - visibleLength(content)));
  // Re-open the background after any color reset inside the content.
  const body = COLOR ? content.replace(/\x1b\[(0|49)m/g, '$&\x1b[48;5;235m') : content;
  return `${' '.repeat(MARGIN)}${bar('┃')}${style.panel(`  ${body}${padding}  `)}`;
}

/** Text width inside a panel row: margin, bar and 2+2 padding, same margin on the right. */
export function panelContentWidth(): number {
  return columns() - MARGIN - 1 - 4 - MARGIN;
}

/** A submitted user message, shown as a panel in the conversation. */
export function userMessage(text: string): string {
  const rows = wrapText(text, panelContentWidth());
  return [panelRow(''), ...rows.map((row) => panelRow(row)), panelRow('')].join('\n');
}

/** Model reply: light Markdown, wrapped and indented under the message panels. */
export function assistantMessage(text: string): string {
  const width = columns() - CONTENT_INDENT - MARGIN - 1;
  const indent = ' '.repeat(CONTENT_INDENT);
  let inFence = false;
  const rows: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      rows.push(style.gray(line));
      continue;
    }
    if (inFence) {
      rows.push(...wrapText(line, width).map((row) => style.cyan(row)));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      rows.push(...wrapText(heading[2] ?? '', width).map((row) => style.bold(inline(row))));
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      rows.push(...wrapText(line.replace(/^\s*>\s?/, ''), width - 2).map((row) => style.gray('│ ') + style.italic(inline(row))));
      continue;
    }
    rows.push(...wrapText(line.replace(/^(\s*)[-*]\s+/, '$1• '), width).map(inline));
  }
  return rows.map((row) => (row ? indent + row : '')).join('\n');
}

function inline(line: string): string {
  if (!COLOR) {
    return line;
  }
  return line
    .replace(/`([^`]+)`/g, (_, code: string) => style.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, bold: string) => style.bold(bold));
}

/** Tool call and its result in one line (plus a short preview for shell output). */
export function toolLine(name: string, input: unknown, result: string): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const indent = ' '.repeat(CONTENT_INDENT);
  const room = columns() - CONTENT_INDENT - 12;
  const path = truncate(String(args.path ?? ''), room);
  const count = (text: string) => (text ? text.replace(/\n$/, '').split('\n').length : 0);

  let suffix: string;
  if (/^Error:/.test(result)) {
    suffix = style.red(` · ${truncate(result.replace(/^Error:\s*/, ''), room)}`);
  } else if (result === 'User declined this action.') {
    suffix = style.yellow(' · declined');
  } else if (result.startsWith('Interrupted by the user')) {
    suffix = style.red(' · interrupted');
  } else {
    suffix = '';
  }

  switch (name) {
    case 'read_file':
      return `${indent}${style.gray('→')} Read ${style.gray(path)}${suffix || style.gray(` · ${count(result)} lines`)}`;
    case 'list_dir':
      return `${indent}${style.gray('→')} List ${style.gray(path)}${suffix || style.gray(` · ${count(result)} entries`)}`;
    case 'write_file':
      return `${indent}${style.gray('←')} Write ${style.gray(path)}${
        suffix || style.gray(` · ${count(String(args.content ?? ''))} lines`)
      }`;
    case 'edit_file':
      return `${indent}${style.gray('←')} Edit ${style.gray(path)}${
        suffix ||
        ` ${style.green(`+${count(String(args.new_string ?? ''))}`)} ${style.red(`-${count(String(args.old_string ?? ''))}`)}`
      }`;
    case 'run_bash': {
      const title = `${indent}${style.gray('$')} ${truncate(String(args.command ?? ''), room)}`;
      const match = /^exit code: (-?\d+|null)\nstdout:\n([\s\S]*?)\nstderr:\n([\s\S]*)$/.exec(result);
      if (suffix || !match) {
        return `${title}${suffix}`;
      }
      const [, code, out = '', err = ''] = match;
      const output = (out.trim() || err.trim()).split('\n').filter(Boolean);
      const preview = output.slice(0, 4).map((line) => `${indent}  ${style.gray(truncate(line, room))}`);
      if (output.length > 4) {
        preview.push(`${indent}  ${style.gray(`… +${output.length - 4} lines`)}`);
      }
      return [`${title}${code === '0' ? '' : style.red(` · exit ${code}`)}`, ...preview].join('\n');
    }
    default:
      return `${indent}${style.gray('→')} ${name}${suffix}`;
  }
}

/** Short label of a running tool, for the status row under the input box. */
export function toolActivity(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  const labels: Record<string, string> = {
    read_file: `Reading ${String(args.path ?? '')}`,
    list_dir: `Listing ${String(args.path ?? '')}`,
    write_file: `Writing ${String(args.path ?? '')}`,
    edit_file: `Editing ${String(args.path ?? '')}`,
    run_bash: `Running ${String(args.command ?? '')}`,
  };
  return labels[name] ?? name;
}

/** "▣ Default · model · 3.2s" under a finished reply. */
export function turnFooter(mode: string, model: string, milliseconds: number, failed = false): string {
  const seconds = (milliseconds / 1000).toFixed(1);
  return `${' '.repeat(CONTENT_INDENT)}${failed ? style.red('▣') : style.accent('▣')} ${mode} ${style.gray(
    `· ${model} · ${seconds}s`,
  )}`;
}

/** 4-row block letters for the home-screen wordmark. */
const GLYPHS: Record<string, string[]> = {
  a: ['    ', '▀▀▀█', '█▀▀█', '▀▀▀▀'],
  i: ['▄', '▄', '█', '▀'],
  o: ['    ', '█▀▀█', '█  █', '▀▀▀▀'],
  l: ['█', '█', '█', '▀'],
  h: ['█   ', '█▀▀█', '█  █', '▀  ▀'],
};

/** "aiolah" wordmark: "aio" dimmed, "lah" bright, like opencode's open/code. */
export function wordmark(): { lines: string[]; width: number } {
  const render = (word: string) =>
    [0, 1, 2, 3].map((row) => [...word].map((letter) => GLYPHS[letter]![row]).join(' '));
  const left = render('aio');
  const right = render('lah');
  return {
    lines: left.map((part, row) => `${style.gray(part)} ${style.white(right[row]!)}`),
    width: visibleLength(`${left[0]} ${right[0]}`),
  };
}

/** Current git branch of `dir` (walking up to the repository root), or null. */
export function gitBranch(dir: string): string | null {
  for (let current = dir; ; current = dirname(current)) {
    try {
      let gitDir = join(current, '.git');
      if (statSync(gitDir).isFile()) {
        gitDir = resolve(current, readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
      }
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7);
    } catch {
      if (dirname(current) === current) {
        return null;
      }
    }
  }
}

const SCANNER_COLORS = [141, 98, 61, 60];

/** Knight-rider bar shown while a turn runs ("--■■■--"), frame by frame. */
export function scanner(frame: number, width = 8): string {
  const span = width - 1;
  const cycle = frame % (span * 2);
  const head = cycle <= span ? cycle : span * 2 - cycle;
  const direction = cycle <= span ? -1 : 1;
  let bar = '';
  for (let index = 0; index < width; index += 1) {
    const distance = (index - head) * direction;
    bar +=
      distance >= 0 && distance < SCANNER_COLORS.length
        ? style.fg(SCANNER_COLORS[distance]!, '■')
        : style.fg(238, '-');
  }
  return bar;
}

/**
 * Splits a styled line into rows of at most `width` visible columns; colors
 * still open at a break are re-applied on the next row.
 */
export function wrapAnsi(line: string, width: number): string[] {
  const rows: string[] = [];
  // eslint-disable-next-line no-control-regex
  const escape = /\x1b\[[0-9;?]*[a-zA-Z]/y;
  let current = '';
  let active = '';
  let count = 0;
  for (let index = 0; index < line.length; ) {
    escape.lastIndex = index;
    const match = escape.exec(line);
    if (match) {
      current += match[0];
      if (match[0].endsWith('m')) {
        active = match[0] === '\x1b[0m' ? '' : active + match[0];
      }
      index += match[0].length;
      continue;
    }
    if (count === width) {
      rows.push(active ? `${current}\x1b[0m` : current);
      current = active;
      count = 0;
    }
    current += line[index];
    count += 1;
    index += 1;
  }
  rows.push(current);
  return rows;
}
