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

/** `/theme`: colors of the accent and of the input panel. mono uses no 256-color codes. */
export const THEMES = {
  dark: { accent: '38;5;141', panel: '48;5;235', panelEdge: '38;5;235' },
  light: { accent: '38;5;91', panel: '48;5;254', panelEdge: '38;5;254' },
  mono: { accent: '1', panel: '7', panelEdge: '2' },
} as const;

export type ThemeName = keyof typeof THEMES;

let theme: ThemeName = 'dark';

export function setTheme(name: ThemeName): void {
  theme = name;
}

export function currentTheme(): ThemeName {
  return theme;
}

/** A style that follows the current theme. */
function themed(part: keyof (typeof THEMES)['dark'], close: string): (text: string) => string {
  return (text) => (COLOR ? `\x1b[${THEMES[theme][part]}m${text}\x1b[${close}m` : text);
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
  accent: themed('accent', '22;39'),
  /** Background of the input box and user messages. */
  panel: themed('panel', '27;49'),
  /** Foreground in the panel color, for the half-block bottom edge. */
  panelEdge: themed('panelEdge', '22;39'),
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

type LineKind = 'fence' | 'code' | 'heading' | 'quote' | 'text';

/**
 * Light Markdown for model replies, one source line at a time (code fences
 * span lines, so it keeps state). Rows come back unindented.
 */
class MarkdownLines {
  private inFence = false;

  /** What a line is, and its text without the Markdown marker. */
  classify(line: string): { kind: LineKind; text: string } {
    if (/^\s*```/.test(line)) return { kind: 'fence', text: line };
    if (this.inFence) return { kind: 'code', text: line };
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) return { kind: 'heading', text: heading[2] ?? '' };
    if (/^\s*>\s?/.test(line)) return { kind: 'quote', text: line.replace(/^\s*>\s?/, '') };
    return { kind: 'text', text: line.replace(/^(\s*)[-*]\s+/, '$1• ') };
  }

  /** Wrapped plain rows of a classified line (before styling). */
  wrap(kind: LineKind, text: string): string[] {
    return kind === 'fence' ? [text] : wrapText(text, kind === 'quote' ? replyWidth() - 2 : replyWidth());
  }

  style(kind: LineKind, row: string): string {
    switch (kind) {
      case 'fence':
        return style.gray(row);
      case 'code':
        return style.cyan(row);
      case 'heading':
        return style.bold(inline(row));
      case 'quote':
        return style.gray('│ ') + style.italic(inline(row));
      default:
        return inline(row);
    }
  }

  /** A whole line, as styled rows; `kind` continues a line whose start was already shown. */
  render(line: string, kind?: LineKind): string[] {
    const classified = kind ? { kind, text: line } : this.classify(line);
    if (classified.kind === 'fence') this.inFence = !this.inFence;
    return this.wrap(classified.kind, classified.text).map((row) => this.style(classified.kind, row));
  }
}

function replyWidth(): number {
  return columns() - CONTENT_INDENT - MARGIN - 1;
}

function indentRows(rows: string[]): string {
  const indent = ' '.repeat(CONTENT_INDENT);
  return rows.map((row) => (row ? indent + row : '')).join('\n');
}

/** Model reply: light Markdown, wrapped and indented under the message panels. */
export function assistantMessage(text: string): string {
  const lines = new MarkdownLines();
  return indentRows(text.split('\n').flatMap((line) => lines.render(line)));
}

/**
 * A reply shown while it is written: `push` takes each streamed piece and
 * returns the rows that are complete (a finished line, or the wrapped rows of
 * a long line that can no longer change); `end` returns the rest. Blank lines
 * at the start and end are dropped, as `assistantMessage(reply.trim())` does.
 */
export class AssistantStream {
  private readonly lines = new MarkdownLines();
  private partial = '';
  /** Set once rows of the current line were shown: the rest keeps its kind. */
  private continuing: LineKind | null = null;
  private blankRows = 0;
  private shownRows = 0;

  push(text: string): string {
    this.partial += text;
    const rows: string[] = [];
    let newline: number;
    while ((newline = this.partial.indexOf('\n')) !== -1) {
      rows.push(...this.completeLine(this.partial.slice(0, newline)));
      this.partial = this.partial.slice(newline + 1);
    }
    rows.push(...this.completeRows());
    return this.emit(rows);
  }

  end(): string {
    const rows = this.partial ? this.completeLine(this.partial) : [];
    this.partial = '';
    this.continuing = null;
    this.blankRows = 0;
    return this.emit(rows);
  }

  /** Whether anything was shown yet. */
  get started(): boolean {
    return this.shownRows > 0;
  }

  private completeLine(line: string): string[] {
    const kind = this.continuing ?? undefined;
    this.continuing = null;
    return this.lines.render(line, kind);
  }

  /** Rows of an unfinished long line that are final already (all but its last wrapped row). */
  private completeRows(): string[] {
    if (this.partial.length <= replyWidth()) return [];
    const { kind, text } = this.continuing
      ? { kind: this.continuing, text: this.partial }
      : this.lines.classify(this.partial);
    if (kind === 'fence') return [];
    const wrapped = this.lines.wrap(kind, text);
    if (wrapped.length < 2) return [];
    this.continuing = kind;
    this.partial = wrapped[wrapped.length - 1] ?? '';
    return wrapped.slice(0, -1).map((row) => this.lines.style(kind, row));
  }

  /** Holds blank rows back until more text follows, so none trail at the end. */
  private emit(rows: string[]): string {
    const out: string[] = [];
    for (const row of rows) {
      if (!row.trim()) {
        if (this.shownRows || out.length) this.blankRows += 1;
        continue;
      }
      out.push(...Array<string>(this.blankRows).fill(''), row);
      this.blankRows = 0;
    }
    this.shownRows += out.length;
    return out.length ? indentRows(out) : '';
  }
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
      return `${indent}${style.gray('→')} List ${style.gray(path)}${
        suffix || style.gray(` · ${count(result)} entries`)
      }`;
    case 'write_file':
      return `${indent}${style.gray('←')} Write ${style.gray(path)}${
        suffix || style.gray(` · ${count(String(args.content ?? ''))} lines`)
      }`;
    case 'edit_file':
      return `${indent}${style.gray('←')} Edit ${style.gray(path)}${
        suffix ||
        ` ${style.green(`+${count(String(args.new_string ?? ''))}`)} ` +
          style.red(`-${count(String(args.old_string ?? ''))}`)
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
    case 'task': {
      const report = result.trim().split('\n')[0] ?? '';
      return `${indent}${style.gray('→')} Task ${style.gray(`(${String(args.subagent_type ?? 'agent')})`)} ${truncate(
        String(args.description ?? ''),
        room / 2,
      )}${suffix || (report ? style.gray(` · ${truncate(report, room / 2)}`) : '')}`;
    }
    default: {
      const mcp = mcpParts(name);
      if (!mcp) {
        return `${indent}${style.gray('→')} ${name}${suffix}`;
      }
      const shownArgs = Object.keys(args).length ? ` ${style.gray(truncate(JSON.stringify(args), room / 2))}` : '';
      const firstLine = result.trim().split('\n')[0] ?? '';
      const preview = suffix || (firstLine ? style.gray(` · ${truncate(firstLine, room / 2)}`) : '');
      return `${indent}${style.gray('→')} ${mcp.server} · ${mcp.tool} ${style.gray('(MCP)')}${shownArgs}${preview}`;
    }
  }
}

/** `mcp__<server>__<tool>` → its parts, or null for a built-in tool. */
function mcpParts(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { server: match[1]!, tool: match[2]! } : null;
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
    task: `Subagent: ${String(args.description ?? '')}`,
  };
  const mcp = mcpParts(name);
  return labels[name] ?? (mcp ? `Calling ${mcp.server} · ${mcp.tool}` : name);
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
  const render = (word: string) => [0, 1, 2, 3].map((row) => [...word].map((letter) => GLYPHS[letter]![row]).join(' '));
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
        gitDir = resolve(
          current,
          readFileSync(gitDir, 'utf8')
            .replace(/^gitdir:\s*/, '')
            .trim(),
        );
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
      distance >= 0 && distance < SCANNER_COLORS.length ? style.fg(SCANNER_COLORS[distance]!, '■') : style.fg(238, '-');
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
  for (let index = 0; index < line.length;) {
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
