import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

/**
 * Slash commands and skills that are prompts, in Claude Code's format so
 * existing ones work unchanged:
 * - commands: `commands/<name>.md` (subfolders give `folder:name`), body with
 *   `$ARGUMENTS` or `$1`…`$9`, optional frontmatter `description` / `argument-hint`;
 * - skills: `skills/<name>/SKILL.md` with frontmatter `name` and `description`;
 *   run with `/<name>`, and the model can load one itself with the use_skill tool.
 * Looked up in the project (`.aiolah/`, `.claude/`) and for the user
 * (`~/.aiolah/`, `~/.claude/`); a project's command wins over the user's.
 */
export interface CustomCommand {
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  kind: 'command' | 'skill';
  source: 'project' | 'user' | 'built-in';
  path?: string;
}

const PROJECT_DIRS = ['.aiolah', '.claude'];
const USER_DIRS = [join(homedir(), '.aiolah'), join(homedir(), '.claude')];
const MAX_BODY_CHARS = 40_000;

/** Prompts that ship with aiolah (like Claude Code's /review, /security-review and /simplify). */
const BUILT_IN: CustomCommand[] = [
  {
    name: 'review',
    description: 'Review the changes in this workspace for bugs and risks',
    argumentHint: '[focus or branch]',
    kind: 'command',
    source: 'built-in',
    body: [
      'Review the code changes in this workspace. Find them with read-only commands: `git status`, `git diff HEAD`,',
      'and, on a branch, `git log --oneline main..HEAD` / `git diff main...HEAD` (use the default branch name).',
      '',
      'Report, most severe first and with file:line references:',
      '- correctness bugs and edge cases that break;',
      '- risky changes (data loss, security, breaking behaviour or APIs);',
      '- missing or weak tests for what changed;',
      '- simpler or more idiomatic alternatives, briefly.',
      'Say plainly when something looks fine. Do not change any files.',
      '',
      'Focus or target (optional): $ARGUMENTS',
    ].join('\n'),
  },
  {
    name: 'security-review',
    description: 'Review the pending changes for security vulnerabilities',
    argumentHint: '[focus]',
    kind: 'command',
    source: 'built-in',
    body: [
      'Do a security review of the pending changes in this workspace (`git status`, `git diff HEAD`, and on a branch',
      '`git diff main...HEAD`). Look for injection (SQL, command, template), broken authentication or authorization,',
      'secrets in code or logs, unsafe deserialization, path traversal, SSRF, XSS/CSRF, insecure defaults and',
      'vulnerable dependency changes. For each finding give severity, file:line, how it could be exploited and a fix.',
      'Only report issues you can point to in the code; say so when you find none. Do not change any files.',
      '',
      'Focus (optional): $ARGUMENTS',
    ].join('\n'),
  },
  {
    name: 'simplify',
    description: 'Simplify the recently changed code without changing behaviour',
    argumentHint: '[file or area]',
    kind: 'command',
    source: 'built-in',
    body: [
      'Simplify the recently changed code (see `git diff HEAD`), or the file or area given below: remove duplication',
      'and dead code, reuse existing helpers, flatten needless nesting and abstractions, and follow the conventions',
      'around it. Keep the behaviour exactly the same. Apply the changes, then run the relevant tests or checks if',
      'the project has them, and summarize what you simplified.',
      '',
      'Target (optional): $ARGUMENTS',
    ].join('\n'),
  },
];

/** `---\nkey: value\n---` at the top of a file; the rest is the body. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) {
    return { meta: {}, body: text };
  }
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair) {
      meta[pair[1]!.toLowerCase()] = pair[2]!.trim().replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: text.slice(match[0].length) };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').slice(0, MAX_BODY_CHARS);
  } catch {
    return null;
  }
}

function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry);
      try {
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (entry.endsWith('.md')) {
          files.push(path);
        }
      } catch {
        // unreadable entry
      }
    }
  };
  walk(dir);
  return files;
}

function commandsIn(base: string, source: CustomCommand['source']): CustomCommand[] {
  const found: CustomCommand[] = [];
  const commandsDir = join(base, 'commands');
  for (const path of markdownFiles(commandsDir)) {
    const text = readText(path);
    if (text === null) continue;
    const { meta, body } = parseFrontmatter(text);
    const name = relative(commandsDir, path).replace(/\.md$/, '').split(sep).join(':').toLowerCase();
    const firstLine =
      body
        .trim()
        .split('\n')[0]
        ?.replace(/^#+\s*/, '') ?? '';
    found.push({
      name,
      description: meta.description || firstLine.slice(0, 80) || 'Custom command',
      argumentHint: meta['argument-hint'],
      body: body.trim(),
      kind: 'command',
      source,
      path,
    });
  }
  const skillsDir = join(base, 'skills');
  let skillDirs: string[] = [];
  try {
    skillDirs = readdirSync(skillsDir);
  } catch {
    skillDirs = [];
  }
  for (const entry of skillDirs) {
    const path = join(skillsDir, entry, 'SKILL.md');
    const text = existsSync(path) ? readText(path) : null;
    if (text === null) continue;
    const { meta, body } = parseFrontmatter(text);
    found.push({
      name: (meta.name || entry).toLowerCase(),
      description: meta.description || 'Skill',
      body: body.trim(),
      kind: 'skill',
      source,
      path,
    });
  }
  return found;
}

/**
 * Every prompt command available in `workspaceRoot`: project first, then the
 * user's, then the built-in ones; the first of each name wins.
 */
export function loadCustomCommands(workspaceRoot: string): CustomCommand[] {
  const root = resolve(workspaceRoot);
  const all = [
    ...PROJECT_DIRS.flatMap((dir) => commandsIn(join(root, dir), 'project')),
    ...USER_DIRS.flatMap((dir) => commandsIn(dir, 'user')),
    ...BUILT_IN,
  ];
  const byName = new Map<string, CustomCommand>();
  for (const command of all) {
    if (/^[a-z0-9][a-z0-9:_-]*$/.test(command.name) && !byName.has(command.name)) {
      byName.set(command.name, command);
    }
  }
  return [...byName.values()];
}

/** The prompt a command sends: `$ARGUMENTS` / `$1`… filled in, or the arguments appended. */
export function expandCommand(command: CustomCommand, args: string): string {
  if (command.kind === 'skill') {
    return [
      `Use the skill "${command.name}" below for this request.`,
      '',
      `<skill name="${command.name}">`,
      command.body,
      '</skill>',
      '',
      `Request: ${args.trim() || '(follow the skill)'}`,
    ].join('\n');
  }
  const positional = args.trim() ? args.trim().split(/\s+/) : [];
  const hasPlaceholder = /\$ARGUMENTS|\$[1-9]/.test(command.body);
  const filled = command.body
    .replace(/\$ARGUMENTS/g, args.trim())
    .replace(/\$([1-9])/g, (_, index: string) => positional[Number(index) - 1] ?? '');
  return hasPlaceholder || !args.trim() ? filled : `${filled}\n\nARGUMENTS: ${args.trim()}`;
}
