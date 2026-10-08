import type { Interface } from 'node:readline/promises';
import type { ChatSession } from './session.js';
import type { PickOptions, PickSection } from './terminalInput.js';
import { listSessions } from './persistence.js';
import { readAuth } from './config.js';
import { costLabel, fetchModels } from './models.js';
import {
  PROVIDERS,
  isConnected,
  listProviderModels,
  providerDef,
  recentSelections,
  resolveProviderModel,
  setActiveSelection,
} from './providers.js';
import { connectFlow, disconnectCommand } from './commands/connect.js';
import { style, tildify } from './ui.js';
import { formatMcpStatus, type McpManager } from './mcp/index.js';
import { checkLogin, expiryLabel } from './loginStatus.js';
import { INIT_PROMPT, USER_INSTRUCTIONS_FILE, loadInstructions } from './instructions.js';
import { join } from 'node:path';
import type { SessionRecord } from './persistence.js';
import { assistantReply, copyToClipboard, exportConversation, planUsage, workspaceDiff } from './chatCommands.js';
import { parseRule, projectRules, saveProjectRules } from './permissionRules.js';
import type { PermissionMode } from './permissions.js';
import { expandCommand, loadCustomCommands, type CustomCommand } from './customCommands.js';
import { RELEASE_NOTES } from './releaseNotes.js';
import { agentTemplate, loadAgents } from './agents.js';
import { loadHooks } from './hooks.js';
import { readUserSettings, settingsFilePath, writeUserSetting } from './settings.js';
import { THEMES, currentTheme, setTheme, type ThemeName } from './ui.js';
import { LOG_FILE } from './log.js';
import { KEYBINDINGS_FILE, KEYBINDINGS_TEMPLATE, Keymap, SUPPORTED_ACTIONS } from './keybindings.js';
import type { BackgroundTask, BackgroundTasks } from './backgroundTasks.js';
import { DEFAULT_LOOP_INTERVAL_MS, defaultLoopPrompt, formatInterval, parseInterval, type LoopRunner } from './loop.js';

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  /** Still works when typed, but isn't offered in the menu or /help. */
  hidden?: boolean;
}

/** Commands of `aiolah chat`, in the order the autocomplete menu and /help show them. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Start a new conversation (the current one stays in /resume)' },
  { name: 'resume', args: '[session]', description: 'Continue a saved conversation' },
  { name: 'compact', args: '[instructions]', description: 'Summarize the conversation to free up context' },
  { name: 'init', description: 'Create AGENTS.md with instructions for this project' },
  { name: 'memory', args: '[edit|user]', description: 'Show or edit the instruction files (AGENTS.md…)' },
  { name: 'plan', args: '[task|off]', description: 'Plan mode: look around read-only and propose a plan first' },
  {
    name: 'permissions',
    args: '[allow|deny|remove <rule>]',
    description: 'Rules that always allow or deny a tool here',
  },
  { name: 'rename', args: '<title>', description: 'Name this conversation (shown on /code and in /resume)' },
  { name: 'btw', args: '<question>', description: 'Ask a side question without adding it to the conversation' },
  { name: 'fork', description: 'Continue in a copy of this conversation (the original stays in /resume)' },
  { name: 'rewind', description: 'Go back to an earlier prompt: undo file changes and/or the conversation' },
  { name: 'add-dir', args: '<path>', description: 'Let the agent work in another directory too' },
  { name: 'release-notes', description: 'What changed in each aiolah version' },
  { name: 'agents', args: '[new <name>]', description: 'Subagents the agent can start (task tool); create one' },
  { name: 'hooks', description: 'Hooks from settings.json that run on tool calls and prompts' },
  { name: 'theme', args: '[dark|light|mono]', description: 'Colors of the chat' },
  { name: 'vim', description: 'Toggle vim editing mode in the input box' },
  { name: 'statusline', args: '[command|off]', description: 'A command whose output is shown under the input box' },
  { name: 'keybindings', args: '[edit]', description: 'Keyboard shortcuts; edit opens keybindings.json' },
  {
    name: 'loop',
    args: '[interval] [prompt|stop]',
    description: 'Run a prompt repeatedly, e.g. /loop 5m check the deploy',
  },
  {
    name: 'background',
    args: '<prompt>',
    description: 'Run a prompt in a copy of this conversation, in the background',
  },
  { name: 'tasks', args: '[id|stop <id>]', description: 'Background tasks: status and results' },
  { name: 'proactive', args: '[interval] [prompt]', description: 'Same as /loop', hidden: true },
  { name: 'bg', args: '<prompt>', description: 'Same as /background', hidden: true },
  { name: 'diff', args: '[full]', description: 'Show what changed in the workspace (git)' },
  { name: 'copy', args: '[N]', description: "Copy the assistant's last (or Nth-last) answer" },
  { name: 'export', args: '[file]', description: 'Save the conversation as a Markdown file' },
  { name: 'cost', description: 'Requests and tokens used in this conversation' },
  { name: 'usage', description: 'Your aiolah plan and the chat quota left' },
  { name: 'models', description: 'Switch model (all connected providers)' },
  { name: 'connect', args: '[provider]', description: 'Connect aiolah or your own provider key' },
  { name: 'disconnect', args: '<provider>', description: "Remove a provider's key (or sign out of aiolah)" },
  { name: 'status', description: 'Show provider, model, session and login' },
  { name: 'mcp', description: 'Show MCP servers and their tools' },
  {
    name: 'remote-control',
    args: '[name]',
    description: 'Control this chat from aiolah /code, the app or VS Code (again to disconnect)',
  },
  { name: 'sessions', description: 'List saved sessions (resume with: aiolah -r <id>)' },
  { name: 'help', description: 'Show commands and shortcuts' },
  { name: 'exit', description: 'Quit' },
  { name: 'model', args: '[id]', description: 'Switch model', hidden: true },
  { name: 'provider', args: '[id]', description: 'Switch provider', hidden: true },
  { name: 'rc', args: '[name]', description: 'Same as /remote-control', hidden: true },
  { name: 'new', description: 'Same as /clear', hidden: true },
  { name: 'reset', description: 'Same as /clear', hidden: true },
];

/** Folder whose custom commands and skills are offered (set by `aiolah chat`). */
let commandWorkspace: string | null = null;
let customCache: { at: number; commands: CustomCommand[] } | null = null;
const CUSTOM_CACHE_MS = 3_000;

export function setCommandWorkspace(workspaceRoot: string): void {
  commandWorkspace = workspaceRoot;
  customCache = null;
}

/** Prompt commands and skills of the workspace (re-read every few seconds, so new files show up). */
export function customCommands(): CustomCommand[] {
  if (!commandWorkspace) {
    return [];
  }
  if (!customCache || Date.now() - customCache.at > CUSTOM_CACHE_MS) {
    const builtIn = new Set(SLASH_COMMANDS.map((command) => command.name));
    customCache = {
      at: Date.now(),
      commands: loadCustomCommands(commandWorkspace).filter((command) => !builtIn.has(command.name)),
    };
  }
  return customCache.commands;
}

function asSlashCommand(command: CustomCommand): SlashCommand {
  const origin = command.source === 'built-in' ? '' : ` (${command.source} ${command.kind})`;
  return {
    name: command.name,
    args: command.argumentHint ?? (command.kind === 'skill' ? '[request]' : undefined),
    description: `${command.description}${origin}`,
  };
}

/** Menu commands whose name starts with `prefix` (without the slash). */
export function matchSlashCommands(prefix: string): SlashCommand[] {
  const lower = prefix.toLowerCase();
  return [...SLASH_COMMANDS.filter((command) => !command.hidden), ...customCommands().map(asSlashCommand)].filter(
    (command) => command.name.startsWith(lower),
  );
}

/** What a slash command may do with the chat screen. */
export interface SlashContext {
  rl: Interface;
  session: ChatSession;
  /** MCP servers of this chat. */
  mcp?: McpManager;
  /** Prints lines above the input box. */
  print: (text: string) => void;
  /** Dialog inside the input box; resolves to the picked value or null. */
  pick: (options: PickOptions) => Promise<string | null>;
  /** Shows a running indicator while something loads. */
  loading: (text: string | null) => void;
  /** Hands the terminal to plain readline (connect asks for keys); the box comes back on the next prompt. */
  suspend: () => void;
  clearScreen: () => void;
  /** Turns /remote-control on (with an optional device name) or off. */
  remoteControl?: (name?: string) => Promise<void>;
  /** Runs a prompt as a turn of the chat, shown as `label` (used by /init). */
  runPrompt?: (prompt: string, label: string) => Promise<void>;
  /** Opens a file in the user's editor (/memory edit). */
  editFile?: (path: string, template: string) => void;
  /** `/background` and `/tasks`. */
  background?: { tasks: BackgroundTasks; start: (prompt: string) => BackgroundTask };
  /** `/loop`. */
  loop?: {
    runner: LoopRunner;
    start: (intervalMs: number, prompt: string, label: string) => void;
    stop: () => boolean;
  };
  /** Parts of the chat screen that /vim and /statusline change. */
  ui?: { setVim: (enabled: boolean) => void; refreshStatusLine: () => Promise<void> };
  /** The chat's permission mode (/plan switches it). */
  permissionMode?: { get: () => PermissionMode; set: (mode: PermissionMode) => void };
}

const CONNECT_ACTION = '\u0000connect';
const LIST_TIMEOUT_MS = 15_000;

function helpText(): string {
  const visible = [...SLASH_COMMANDS.filter((command) => !command.hidden), ...customCommands().map(asSlashCommand)];
  const width = Math.max(...visible.map((command) => `/${command.name} ${command.args ?? ''}`.length)) + 2;
  const commands = visible.map(
    (command) =>
      `  ${style.accent(`/${command.name} ${command.args ?? ''}`.padEnd(width))}${style.gray(command.description)}`,
  );
  const shortcuts = [
    ['/', 'commands (Tab completes)'],
    ['esc', 'interrupt the running turn'],
    ['shift+tab', 'cycle permission mode'],
    ['ctrl+c', 'clear input · twice to quit'],
    ['↑ ↓', 'input history'],
    ['\\ enter', 'new line (also alt+enter)'],
  ].map(([key, description]) => `  ${style.bold(key!.padEnd(width))}${style.gray(description!)}`);
  return `${style.bold('Commands')}\n${commands.join('\n')}\n\n${style.bold('Shortcuts')}\n${shortcuts.join('\n')}`;
}

/** Handles one `/command` typed in `aiolah chat`. Returns 'exit' to quit. */
export async function handleSlash(line: string, context: SlashContext): Promise<'handled' | 'exit'> {
  const { session, print } = context;
  const [typed = '', ...args] = line.trim().slice(1).split(/\s+/);
  const arg = args.join(' ').trim() || undefined;
  // `/mod` runs the first matching command, like picking it from the menu.
  const known =
    SLASH_COMMANDS.some((item) => item.name === typed) || customCommands().some((item) => item.name === typed);
  const command = known ? typed : (matchSlashCommands(typed)[0]?.name ?? typed);

  try {
    switch (command) {
      case 'help':
      case '?':
      case '':
        print(helpText());
        return 'handled';

      case 'clear':
      case 'new':
      case 'reset':
        session.startNew();
        return 'handled';

      case 'resume': {
        const id = arg ?? (await pickSession(context));
        if (id) {
          session.resume(id);
        }
        return 'handled';
      }

      case 'compact': {
        if (!session.modelId) {
          print(style.yellow('  Choose a model first: /models'));
          return 'handled';
        }
        context.loading('Compacting the conversation…');
        let result: { before: number; after: number };
        try {
          result = await session.compact(arg);
        } finally {
          context.loading(null);
        }
        print(
          result.before
            ? style.gray(
                `  Conversation compacted: about ${formatTokens(result.before)} → ` +
                  `${formatTokens(result.after)} tokens.`,
              )
            : style.gray('  Nothing to compact yet.'),
        );
        return 'handled';
      }

      case 'init':
        if (!context.runPrompt) {
          print(style.yellow('  /init is only available in aiolah chat.'));
        } else if (!session.modelId) {
          print(style.yellow('  Choose a model first: /models'));
        } else {
          await context.runPrompt(INIT_PROMPT, '/init — create AGENTS.md for this project');
        }
        return 'handled';

      case 'plan': {
        if (!context.permissionMode) {
          print(style.yellow('  /plan is only available in aiolah chat.'));
          return 'handled';
        }
        if (arg === 'off') {
          context.permissionMode.set('default');
          print(style.gray('  Plan mode off — back to the default mode.'));
          return 'handled';
        }
        context.permissionMode.set('plan');
        print(style.gray('  Plan mode on: read-only until you approve a plan (/plan off or Shift+Tab to leave).'));
        if (arg && context.runPrompt && session.modelId) {
          await context.runPrompt(arg, arg);
        }
        return 'handled';
      }

      case 'permissions': {
        const [action = 'list', ...ruleParts] = args;
        const rule = ruleParts.join(' ').trim();
        const rules = projectRules(session.workspace);
        if (action === 'list' || !['allow', 'deny', 'remove'].includes(action)) {
          const row = (label: string, list: string[]) => {
            const shown = list.length ? list.map((item) => style.accent(item)).join(', ') : style.gray('none');
            return `  ${style.bold(label)} ${shown}`;
          };
          print(
            [
              row('allow', rules.allow),
              row('deny ', rules.deny),
              style.gray(
                '  /permissions allow "run_bash(npm test*)" · deny "run_bash(rm *)" · remove <rule>. ' +
                  'Rules: run_bash(<cmd>*), edit_file(<path>*), write_file(<path>*), mcp__<server>__<tool|*>.',
              ),
            ].join('\n'),
          );
          return 'handled';
        }
        const cleaned = rule.replace(/^["']|["']$/g, '');
        if (!parseRule(cleaned)) {
          print(style.yellow(`  Not a rule: ${rule || '(empty)'}. Example: run_bash(npm test*)`));
          return 'handled';
        }
        const without = (list: string[]) => list.filter((item) => item !== cleaned);
        const next =
          action === 'remove'
            ? { allow: without(rules.allow), deny: without(rules.deny) }
            : action === 'allow'
              ? { allow: [...without(rules.allow), cleaned], deny: without(rules.deny) }
              : { allow: without(rules.allow), deny: [...without(rules.deny), cleaned] };
        saveProjectRules(session.workspace, next);
        print(style.gray(`  ${action === 'remove' ? 'Removed' : `Will ${action}`} ${cleaned} in this folder.`));
        return 'handled';
      }

      case 'btw': {
        if (!arg) {
          print(style.yellow('  Usage: /btw <question>'));
          return 'handled';
        }
        if (!session.modelId) {
          print(style.yellow('  Choose a model first: /models'));
          return 'handled';
        }
        context.loading('Thinking about your side question…');
        let answer: string;
        try {
          answer = await session.aside(arg);
        } finally {
          context.loading(null);
        }
        print(`${style.gray('  btw — not added to the conversation')}\n${answer.replace(/^/gm, '  ')}`);
        return 'handled';
      }

      case 'fork': {
        const original = session.fork();
        print(style.gray(`  Forked: you are now in ${session.sessionId}; the original (${original}) is in /resume.`));
        return 'handled';
      }

      case 'rewind': {
        const checkpoints = session.listCheckpoints();
        if (!checkpoints.length) {
          print(style.gray('  Nothing to rewind yet in this chat.'));
          return 'handled';
        }
        const picked = await context.pick({
          title: 'Rewind to before…',
          sections: [
            {
              items: checkpoints
                .slice()
                .reverse()
                .map((checkpoint) => ({
                  label: checkpoint.prompt.replace(/\s+/g, ' ').slice(0, 70),
                  detail:
                    `${checkpoint.at.toLocaleTimeString()} · ` +
                    `${checkpoint.files} file${checkpoint.files === 1 ? '' : 's'} changed after`,
                  value: String(checkpoint.index),
                })),
            },
          ],
        });
        if (picked === null) {
          return 'handled';
        }
        const target = checkpoints[Number(picked)]!;
        const what = await context.pick({
          title: 'Restore',
          sections: [
            {
              items: [
                { label: 'Code and conversation', value: 'both', disabled: !target.conversation },
                { label: 'Conversation only', value: 'conversation', disabled: !target.conversation },
                { label: 'Code only', value: 'code' },
              ],
            },
          ],
        });
        if (what === null) {
          return 'handled';
        }
        const result = session.rewind(target.index, what as 'both' | 'code' | 'conversation');
        const restored =
          what === 'conversation' ? '' : `${result.files} file change${result.files === 1 ? '' : 's'} undone. `;
        const back = what === 'code' ? '' : `Conversation is back to before: "${result.prompt.slice(0, 80)}". `;
        print(style.gray(`  ${restored}${back}Changes made by shell commands are not undone.`));
        return 'handled';
      }

      case 'add-dir':
        if (!arg) {
          const dirs = session.additionalDirectories;
          print(
            style.gray(
              dirs.length ? `  Added: ${dirs.map((dir) => tildify(dir)).join(', ')}` : '  Usage: /add-dir <path>',
            ),
          );
        } else {
          print(style.gray(`  The agent can now also use ${tildify(session.addDir(arg))} (for this chat).`));
        }
        return 'handled';

      case 'agents': {
        const [action, name] = args;
        if (action === 'new') {
          if (!name || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
            print(style.yellow('  Usage: /agents new <name> (letters, digits, - and _)'));
            return 'handled';
          }
          const path = join(session.workspace, '.aiolah', 'agents', `${name.toLowerCase()}.md`);
          context.editFile?.(path, agentTemplate(name.toLowerCase()));
          print(style.gray(`  Saved agents in ${tildify(path)} are available from the next message.`));
          return 'handled';
        }
        print(
          [
            ...loadAgents(session.workspace).map(
              (agent) =>
                `  ${style.accent(agent.name)} ${style.gray(`(${agent.source})`)} ${agent.description}` +
                style.gray(` · tools: ${agent.tools ? agent.tools.join(', ') : 'all'}`),
            ),
            style.gray(
              '  The agent starts these with its task tool. /agents new <name> creates .aiolah/agents/<name>.md',
            ),
          ].join('\n'),
        );
        return 'handled';
      }

      case 'hooks': {
        const hooks = loadHooks(session.workspace);
        print(
          hooks.length
            ? hooks
                .map(
                  (hook) =>
                    `  ${style.accent(hook.event)}${hook.matcher ? style.gray(` [${hook.matcher}]`) : ''} ` +
                    hook.command +
                    style.gray(` · ${tildify(hook.source)}`),
                )
                .join('\n')
            : style.gray(
                '  No hooks. Add them to .aiolah/settings.json or ~/.aiolah/settings.json (Claude Code format): ' +
                  '{"hooks":{"PostToolUse":[{"matcher":"edit_file|write_file",' +
                  '"hooks":[{"type":"command","command":"npm run lint"}]}]}}',
              ),
        );
        return 'handled';
      }

      case 'theme': {
        const names = Object.keys(THEMES) as ThemeName[];
        const chosen =
          arg && names.includes(arg as ThemeName)
            ? (arg as ThemeName)
            : ((await context.pick({
                title: 'Theme',
                sections: [
                  {
                    items: names.map((name) => ({ label: name, value: name, current: name === currentTheme() })),
                  },
                ],
              })) as ThemeName | null);
        if (chosen) {
          setTheme(chosen);
          writeUserSetting('theme', chosen);
          print(style.gray(`  Theme: ${chosen} (saved in ${tildify(settingsFilePath())}).`));
        }
        return 'handled';
      }

      case 'vim': {
        const enabled = !readUserSettings().vim;
        writeUserSetting('vim', enabled);
        context.ui?.setVim(enabled);
        print(
          style.gray(
            enabled
              ? '  Vim mode on: Esc for normal mode (h l w b e 0 $ x dd D C i a A I, j/k history), Enter sends.'
              : '  Vim mode off.',
          ),
        );
        return 'handled';
      }

      case 'statusline': {
        if (!arg) {
          const current = readUserSettings().statusLine?.command;
          print(
            style.gray(
              current
                ? `  Status line: ${current}\n  It gets the session as JSON on stdin ` +
                    '(model, workspace, permission_mode, context_tokens…); /statusline off removes it.'
                : '  No status line. Example: /statusline echo "$(git branch --show-current) · $(date +%H:%M)"',
            ),
          );
          return 'handled';
        }
        writeUserSetting('statusLine', arg === 'off' ? undefined : { type: 'command', command: arg });
        await context.ui?.refreshStatusLine();
        print(style.gray(arg === 'off' ? '  Status line removed.' : '  Status line set.'));
        return 'handled';
      }

      case 'keybindings': {
        if (arg === 'edit') {
          context.editFile?.(KEYBINDINGS_FILE, KEYBINDINGS_TEMPLATE);
          print(style.gray(`  Saved changes to ${tildify(KEYBINDINGS_FILE)} apply right away.`));
          return 'handled';
        }
        const keymap = new Keymap();
        const custom = keymap.bindings();
        print(
          [
            ...[
              ['enter', 'send (while a turn runs: queue)'],
              ['\\ enter, alt+enter', 'new line'],
              ['esc', 'interrupt the running turn · close menus · vim normal mode'],
              ['shift+tab', 'cycle permission mode'],
              ['ctrl+c', 'clear input · twice to quit'],
              ['ctrl+d', 'quit (empty input)'],
              ['↑ ↓', 'input history · menu selection'],
              ['tab', 'complete a / command'],
              ['ctrl+a / ctrl+e', 'start / end of line'],
              ['ctrl+w, alt+backspace', 'delete the previous word'],
              ['ctrl+u / ctrl+k', 'delete to the start / end of the line'],
            ].map(([keys, action]) => `  ${style.bold(keys!.padEnd(24))}${style.gray(action!)}`),
            ...(custom.length
              ? [
                  style.bold(`  Custom (${tildify(keymap.source ?? KEYBINDINGS_FILE)})`),
                  ...custom.map(
                    (binding) =>
                      `  ${style.bold(binding.keys.padEnd(24))}${style.gray(`${binding.context} · `)}` +
                      (binding.action ?? style.gray('unbound')),
                  ),
                ]
              : []),
            style.gray(
              `  /keybindings edit opens ${tildify(KEYBINDINGS_FILE)} (Claude Code's format). ` +
                `Actions: ${Object.keys(SUPPORTED_ACTIONS).join(', ')}. ` +
                `/vim adds vim editing. Log: ${tildify(LOG_FILE)}`,
            ),
          ].join('\n'),
        );
        return 'handled';
      }

      case 'loop':
      case 'proactive': {
        if (!context.loop) {
          print(style.yellow('  /loop is only available in aiolah chat.'));
          return 'handled';
        }
        if (arg === 'stop' || arg === 'off') {
          print(style.gray(context.loop.stop() ? '  Loop stopped.' : '  No loop is running.'));
          return 'handled';
        }
        if (!session.modelId) {
          print(style.yellow('  Choose a model first: /models'));
          return 'handled';
        }
        const intervalMs = parseInterval(args[0]);
        const promptText = (intervalMs ? args.slice(1) : args).join(' ').trim();
        const prompt = promptText || defaultLoopPrompt(session.workspace);
        const every = intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
        const label = promptText ? promptText.slice(0, 50) : 'maintenance';
        print(
          style.gray(`  Running every ${formatInterval(every)} while this chat is open: ${label}. /loop stop ends it.`),
        );
        context.loop.start(every, prompt, label);
        return 'handled';
      }

      case 'background':
      case 'bg': {
        if (!context.background) {
          print(style.yellow('  /background is only available in aiolah chat.'));
          return 'handled';
        }
        if (!arg) {
          print(style.yellow('  Usage: /background <prompt>'));
          return 'handled';
        }
        if (!session.modelId) {
          print(style.yellow('  Choose a model first: /models'));
          return 'handled';
        }
        const task = context.background.start(arg);
        print(
          style.gray(
            `  Background task #${task.id} started in a copy of this conversation. ` +
              'Actions that need your approval are refused there (use /permissions or the mode to allow them). ' +
              '/tasks shows it.',
          ),
        );
        return 'handled';
      }

      case 'tasks': {
        const tasks = context.background?.tasks;
        if (!tasks) {
          print(style.yellow('  /tasks is only available in aiolah chat.'));
          return 'handled';
        }
        if (args[0] === 'stop') {
          print(
            style.gray(
              tasks.stop(Number(args[1]))
                ? `  Stopping task #${args[1]}.`
                : `  Task #${args[1] ?? '?'} is not running.`,
            ),
          );
          return 'handled';
        }
        if (args[0]) {
          const task = tasks.get(Number(args[0]));
          if (!task) {
            print(style.yellow(`  No task #${args[0]}.`));
            return 'handled';
          }
          print(
            [
              `  ${style.bold(`#${task.id}`)} ${task.status} · ${task.prompt}`,
              ...(task.denied.length
                ? [
                    style.yellow(
                      `  Refused (needed approval): ${task.denied.map((item) => item.slice(0, 60)).join('; ')}`,
                    ),
                  ]
                : []),
              task.result ? `${task.result.replace(/^/gm, '  ')}` : style.gray('  Still running…'),
              style.gray(
                `  Its conversation is saved as ${task.session.sessionId} (aiolah -r ${task.session.sessionId}).`,
              ),
            ].join('\n'),
          );
          return 'handled';
        }
        const list = tasks.list();
        print(
          list.length
            ? list
                .map((task) => {
                  const seconds = Math.round(
                    ((task.finishedAt ?? new Date()).getTime() - task.startedAt.getTime()) / 1000,
                  );
                  const age = style.gray(`${seconds}s`);
                  return `  ${style.accent(`#${task.id}`)} ${task.status.padEnd(8)} ${age} ${task.prompt.slice(0, 70)}`;
                })
                .join('\n') + style.gray('\n  /tasks <id> shows a result · /tasks stop <id>')
            : style.gray('  No background tasks. /background <prompt> starts one.'),
        );
        return 'handled';
      }

      case 'release-notes':
        print(
          RELEASE_NOTES.map(
            (release) =>
              `  ${style.bold(release.version)}\n` +
              release.changes.map((change) => `  ${style.gray('•')} ${change}`).join('\n'),
          ).join('\n\n'),
        );
        return 'handled';

      case 'rename':
        if (!arg) {
          print(style.yellow('  Usage: /rename <title>'));
        } else {
          session.rename(arg);
          print(style.gray(`  Renamed to "${session.title}".`));
        }
        return 'handled';

      case 'diff':
        print(
          workspaceDiff(session.workspace, arg === 'full')
            .split('\n')
            .map((line) =>
              line.startsWith('+') && !line.startsWith('+++')
                ? style.green(line)
                : line.startsWith('-') && !line.startsWith('---')
                  ? style.red(line)
                  : line,
            )
            .map((line) => `  ${line}`)
            .join('\n'),
        );
        return 'handled';

      case 'copy': {
        const reply = assistantReply(session, Math.max(1, Number(arg) || 1));
        if (!reply) {
          print(style.gray('  No answer to copy yet.'));
          return 'handled';
        }
        const method = copyToClipboard(reply);
        print(style.gray(method ? `  Copied ${reply.length} characters (${method}).` : '  Could not copy.'));
        return 'handled';
      }

      case 'export': {
        const path = exportConversation(session, arg);
        print(style.gray(`  Saved to ${tildify(path)}`));
        return 'handled';
      }

      case 'cost': {
        const { requests, inputTokens, outputTokens } = session.usage;
        const billing =
          providerDef(session.providerId).kind === 'aiolah'
            ? 'each request uses your aiolah plan quota (/usage)'
            : `billed by ${providerDef(session.providerId).name} to your own key`;
        print(
          style.gray(
            `  ${requests} model requests · ${formatTokens(inputTokens)} input + ${formatTokens(outputTokens)} ` +
              `output tokens this chat · ${billing}`,
          ),
        );
        return 'handled';
      }

      case 'usage':
        context.loading('Loading your plan…');
        try {
          print(style.gray(`  ${await planUsage()}`));
        } finally {
          context.loading(null);
        }
        return 'handled';

      case 'memory': {
        const projectFile = join(session.workspace, 'AGENTS.md');
        if (arg === 'edit' || arg === 'user') {
          const path = arg === 'user' ? USER_INSTRUCTIONS_FILE : projectFile;
          context.editFile?.(path, arg === 'user' ? USER_TEMPLATE : PROJECT_TEMPLATE);
          print(style.gray(`  Saved edits to ${tildify(path)} apply from the next message.`));
          return 'handled';
        }
        const files = loadInstructions(session.workspace);
        print(
          [
            files.length
              ? files
                  .map(
                    (file) =>
                      `  ${style.bold(tildify(file.path))} ${style.gray(
                        `(${file.scope}, ${file.content.length} chars` + `${file.truncated ? ', cut' : ''})`,
                      )}`,
                  )
                  .join('\n')
              : style.gray('  No instruction files yet. /init writes AGENTS.md for this project.'),
            style.gray(
              `  /memory edit opens ${tildify(projectFile)} · /memory user opens ${tildify(USER_INSTRUCTIONS_FILE)}`,
            ),
          ].join('\n'),
        );
        return 'handled';
      }

      case 'exit':
      case 'quit':
        return 'exit';

      case 'connect':
        await connect(context, arg);
        return 'handled';

      case 'disconnect':
        if (!arg) {
          print(style.yellow('Usage: /disconnect <provider>'));
        } else {
          context.suspend();
          await disconnectCommand(arg);
        }
        return 'handled';

      case 'models':
      case 'model':
        if (arg) {
          switchTo(context, session.providerId, arg);
        } else {
          await chooseModel(context);
        }
        return 'handled';

      case 'provider': {
        let id = arg;
        if (!id) {
          const connected = PROVIDERS.filter((provider) => isConnected(provider.id));
          id =
            (await context.pick({
              title: 'Switch provider',
              sections: [
                {
                  items: connected.map((provider) => ({
                    label: provider.name,
                    detail: provider.id,
                    value: provider.id,
                    current: provider.id === session.providerId,
                  })),
                },
              ],
            })) ?? undefined;
          if (!id) return 'handled';
        }
        if (!isConnected(id)) {
          print(style.yellow(`${providerDef(id).name} is not connected. Use /connect ${id}.`));
          return 'handled';
        }
        switchTo(context, id, await resolveProviderModel(id));
        return 'handled';
      }

      case 'sessions': {
        const sessions = listSessions().slice(0, 15);
        print(
          sessions.length
            ? sessions
                .map(
                  (item) =>
                    `  ${style.accent(item.id)}  ` +
                    `${style.gray(item.updatedAt.slice(0, 16).replace('T', ' '))}  ${tildify(item.workspace)}`,
                )
                .join('\n')
            : style.gray('  No saved sessions.'),
        );
        return 'handled';
      }

      case 'status': {
        const auth = readAuth();
        const login = auth ? await checkLogin(auth) : null;
        const row = (label: string, value: string) => `  ${style.gray(label.padEnd(10))}${value}`;
        print(
          [
            row('provider', `${providerDef(session.providerId).name} ${style.gray(`[${session.providerId}]`)}`),
            row('model', session.modelId || style.yellow('none — /models')),
            row('session', session.sessionId),
            row('context', `about ${formatTokens(session.contextTokens)} tokens (/compact to shrink)`),
            row('workspace', tildify(session.workspace)),
            row(
              'aiolah',
              auth
                ? `signed in as ${login?.user?.email ?? auth.user.email}` +
                    (auth.kind === 'setup-token' ? ' (AIOLAH_TOKEN)' : '')
                : style.yellow('not signed in — /connect aiolah'),
            ),
            ...(auth
              ? [row('login', login?.valid === false ? style.red(expiryLabel(login)) : expiryLabel(login))]
              : []),
          ].join('\n'),
        );
        return 'handled';
      }

      case 'mcp':
        print(formatMcpStatus(context.mcp?.status ?? []));
        return 'handled';

      case 'remote-control':
      case 'rc':
        if (!context.remoteControl) {
          print(style.yellow('  Remote Control is only available in aiolah chat.'));
          return 'handled';
        }
        context.loading('Connecting to aiolah…');
        try {
          await context.remoteControl(arg);
        } finally {
          context.loading(null);
        }
        return 'handled';

      default: {
        const custom = customCommands().find((item) => item.name === command);
        if (custom && context.runPrompt) {
          if (!session.modelId) {
            print(style.yellow('  Choose a model first: /models'));
          } else {
            await context.runPrompt(expandCommand(custom, arg ?? ''), `/${custom.name}${arg ? ` ${arg}` : ''}`);
          }
          return 'handled';
        }
        print(style.yellow(`  Unknown command /${typed}. Type /help.`));
        return 'handled';
      }
    }
  } catch (error) {
    context.loading(null);
    print(style.red(`  ${error instanceof Error ? error.message : String(error)}`));
    return 'handled';
  }
}

/**
 * opencode-style model picker: "Recent", then one group per connected provider
 * (loaded in parallel), with "Connect provider" on ctrl+a.
 */
async function chooseModel(context: SlashContext): Promise<void> {
  const { session } = context;
  const connected = PROVIDERS.filter((provider) => isConnected(provider.id)).sort(
    (a, b) => Number(b.id === session.providerId) - Number(a.id === session.providerId),
  );

  context.loading('Loading models…');
  const groups = await Promise.all(
    connected.map(async (provider): Promise<PickSection> => {
      try {
        const { models, title } = await withTimeout(modelItems(provider.id), LIST_TIMEOUT_MS);
        return {
          title: title ?? provider.name,
          items: models.map((model) => ({
            label: model.label,
            hint: model.hint,
            value: `${provider.id}\n${model.id}`,
            current: provider.id === session.providerId && model.id === session.modelId,
          })),
        };
      } catch (error) {
        return {
          title: provider.name,
          items: [
            {
              label: error instanceof Error ? error.message : String(error),
              value: '',
              disabled: true,
            },
          ],
        };
      }
    }),
  );
  context.loading(null);

  const labels = new Map<string, string>();
  for (const group of groups) {
    for (const item of group.items) {
      labels.set(item.value, item.label);
    }
  }
  const recent = recentSelections()
    .filter((item) => connected.some((provider) => provider.id === item.provider))
    .map((item) => {
      const value = `${item.provider}\n${item.model}`;
      return {
        label: labels.get(value) ?? item.model,
        detail: providerDef(item.provider).name,
        value,
        current: item.provider === session.providerId && item.model === session.modelId,
      };
    });

  const sections: PickSection[] = [...(recent.length ? [{ title: 'Recent', items: recent }] : []), ...groups];
  if (!connected.length) {
    sections.push({ items: [{ label: 'No provider connected yet — press ctrl+a', value: '', disabled: true }] });
  }

  const choice = await context.pick({
    title: 'Select model',
    sections,
    actions: [{ key: 'a', label: 'Connect provider', value: CONNECT_ACTION }],
  });
  if (choice === CONNECT_ACTION) {
    await connect(context);
    return;
  }
  if (choice) {
    const [provider = '', model = ''] = choice.split('\n');
    switchTo(context, provider, model);
  }
}

/** Models of one provider with display labels (aiolah's catalog has names, tiers and the plan name). */
async function modelItems(
  provider: string,
): Promise<{ title?: string; models: { id: string; label: string; hint?: string }[] }> {
  if (providerDef(provider).kind === 'aiolah') {
    const { data, plan } = await fetchModels();
    return {
      title: plan?.name ? `aiolah · ${plan.name}` : undefined,
      models: data.map((model) => ({
        id: model.id,
        label: model.name || model.id,
        hint: [costLabel(model.cost), model.tier ? model.tier.charAt(0).toUpperCase() + model.tier.slice(1) : undefined]
          .filter(Boolean)
          .join(' · ') || undefined,
      })),
    };
  }
  return { models: (await listProviderModels(provider)).map((id) => ({ id, label: id })) };
}

async function connect(context: SlashContext, providerId?: string): Promise<void> {
  if (!providerId) {
    const item = (provider: (typeof PROVIDERS)[number]) => ({
      label: provider.name,
      detail: provider.id,
      hint: isConnected(provider.id) ? 'Connected' : undefined,
      value: provider.id,
    });
    const isLocal = (provider: (typeof PROVIDERS)[number]) => provider.kind === 'openai' && !provider.needsKey;
    providerId =
      (await context.pick({
        title: 'Connect provider',
        sections: [
          { title: 'Popular', items: PROVIDERS.filter((provider) => provider.popular).map(item) },
          {
            title: 'Other',
            items: PROVIDERS.filter((provider) => !provider.popular && !isLocal(provider)).map(item),
          },
          { title: 'Local', items: PROVIDERS.filter((provider) => !provider.popular && isLocal(provider)).map(item) },
        ],
      })) ?? undefined;
    if (!providerId) {
      return;
    }
  }
  context.suspend();
  const result = await connectFlow(context.rl, providerId);
  if (result) {
    switchTo(context, result.provider, result.model ?? (await resolveProviderModel(result.provider)));
  }
}

function switchTo(context: SlashContext, provider: string, model: string): void {
  context.session.useModel(provider, model);
  setActiveSelection(provider, model);
  context.print(
    `  ${style.green('✓')} Now using ${style.bold(model)} ${style.gray(`· ${providerDef(provider).name}`)}`,
  );
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out loading models')), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const PROJECT_TEMPLATE = [
  '# AGENTS.md',
  '',
  'Instructions for coding agents working in this project (read at the start of every aiolah session).',
  '',
  '## Commands',
  '',
  '## Conventions',
  '',
].join('\n');

const USER_TEMPLATE = [
  '# My instructions',
  '',
  "Read by aiolah in every project, before the project's own AGENTS.md.",
  '',
].join('\n');

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

/** First words of the first prompt, to recognise a session in /resume. */
function sessionTitle(record: SessionRecord): string {
  for (const message of record.history) {
    if (message.role !== 'user') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .filter((block) => block.type === 'text')
            .map((block) => (block as { text: string }).text)
            .join(' ');
    if (text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, 70);
  }
  return '(empty)';
}

/** /resume without an id: pick one of the saved sessions, this folder's first. */
async function pickSession(context: SlashContext): Promise<string | null> {
  const all = listSessions().filter((record) => record.id !== context.session.sessionId && record.history.length);
  const here = all.filter((record) => record.workspace === context.session.workspace).slice(0, 30);
  const elsewhere = all.filter((record) => record.workspace !== context.session.workspace).slice(0, 20);
  if (!here.length && !elsewhere.length) {
    context.print(style.gray('  No saved sessions to resume.'));
    return null;
  }
  const item = (record: SessionRecord, showFolder: boolean) => ({
    label: record.title ?? sessionTitle(record),
    detail: `${record.updatedAt.slice(0, 16).replace('T', ' ')}${showFolder ? ` · ${tildify(record.workspace)}` : ''}`,
    value: record.id,
  });
  return context.pick({
    title: 'Resume a session',
    sections: [
      ...(here.length ? [{ title: 'This folder', items: here.map((record) => item(record, false)) }] : []),
      ...(elsewhere.length ? [{ title: 'Other folders', items: elsewhere.map((record) => item(record, true)) }] : []),
    ],
  });
}
