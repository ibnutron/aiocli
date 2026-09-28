import type { Interface } from 'node:readline/promises';
import { stdout } from 'node:process';
import type { ChatSession } from './session.js';
import { pick } from './prompt.js';
import { listSessions } from './persistence.js';
import { readAuth } from './config.js';
import {
  PROVIDERS,
  isConnected,
  listProviderModels,
  providerDef,
  resolveProviderModel,
  setActiveSelection,
} from './providers.js';
import { connectFlow, disconnectCommand } from './commands/connect.js';
import { style, tildify } from './ui.js';

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

/** Commands of `aiolah chat`, in the order the autocomplete menu and /help show them. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'model', args: '[id]', description: "Switch model (lists the provider's models without an id)" },
  { name: 'models', description: "List the current provider's models" },
  { name: 'provider', args: '[id]', description: 'Switch provider (keeps the conversation)' },
  { name: 'connect', args: '[provider]', description: 'Connect aiolah or your own provider key' },
  { name: 'disconnect', args: '<provider>', description: "Remove a provider's key (or sign out of aiolah)" },
  { name: 'status', description: 'Show provider, model, session and login' },
  { name: 'sessions', description: 'List saved sessions (resume with: aiolah -r <id>)' },
  { name: 'clear', description: 'Clear the screen' },
  { name: 'help', description: 'Show commands and shortcuts' },
  { name: 'exit', description: 'Quit' },
];

/** Commands whose name starts with `prefix` (without the slash). */
export function matchSlashCommands(prefix: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => command.name.startsWith(prefix.toLowerCase()));
}

function helpText(): string {
  const width = Math.max(...SLASH_COMMANDS.map((command) => `/${command.name} ${command.args ?? ''}`.length)) + 2;
  const commands = SLASH_COMMANDS.map(
    (command) => `  ${style.accent(`/${command.name} ${command.args ?? ''}`.padEnd(width))}${style.gray(command.description)}`,
  );
  const shortcuts = [
    ['/', 'commands (Tab completes)'],
    ['esc', 'interrupt the running turn'],
    ['shift+tab', 'cycle permission mode'],
    ['ctrl+c', 'clear input · twice to quit'],
    ['↑ ↓', 'input history'],
  ].map(([key, description]) => `  ${style.bold(key!.padEnd(width))}${style.gray(description!)}`);
  return `\n${style.bold('Commands')}\n${commands.join('\n')}\n\n${style.bold('Shortcuts')}\n${shortcuts.join('\n')}\n\n`;
}

/** Handles one `/command` typed in `aiolah chat`. Returns 'exit' to quit. */
export async function handleSlash(line: string, rl: Interface, session: ChatSession): Promise<'handled' | 'exit'> {
  const [typed = '', ...args] = line.trim().slice(1).split(/\s+/);
  const arg = args.join(' ').trim() || undefined;
  // `/mod` runs the first matching command, like picking it from the menu.
  const command = SLASH_COMMANDS.some((item) => item.name === typed)
    ? typed
    : (matchSlashCommands(typed)[0]?.name ?? typed);

  try {
    switch (command) {
      case 'help':
      case '?':
      case '':
        stdout.write(helpText());
        return 'handled';

      case 'clear':
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
        return 'handled';

      case 'exit':
      case 'quit':
        return 'exit';

      case 'connect': {
        const result = await connectFlow(rl, arg);
        if (result) {
          switchTo(session, result.provider, result.model ?? (await resolveProviderModel(result.provider)));
        }
        return 'handled';
      }

      case 'disconnect':
        if (!arg) {
          stdout.write('Usage: /disconnect <provider>\n');
        } else {
          await disconnectCommand(arg);
        }
        return 'handled';

      case 'provider': {
        let id = arg;
        if (!id) {
          const connected = PROVIDERS.filter((provider) => isConnected(provider.id));
          const choice = await pick(
            rl,
            'Switch provider:',
            connected.map(
              (provider) => `${provider.id === session.providerId ? '●' : ' '} ${provider.name}  [${provider.id}]`,
            ),
          );
          if (choice === null) return 'handled';
          id = connected[choice]!.id;
        }
        if (!isConnected(id)) {
          stdout.write(`${providerDef(id).name} is not connected. Use /connect ${id}.\n`);
          return 'handled';
        }
        switchTo(session, id, await resolveProviderModel(id));
        return 'handled';
      }

      case 'model': {
        let model = arg;
        if (!model) {
          const models = (await listProviderModels(session.providerId)).slice(0, 60);
          const choice = await pick(
            rl,
            `Models on ${providerDef(session.providerId).name}:`,
            models.map((id) => `${id === session.modelId ? '●' : ' '} ${id}`),
          );
          if (choice === null) return 'handled';
          model = models[choice]!;
        }
        switchTo(session, session.providerId, model);
        return 'handled';
      }

      case 'models': {
        const models = await listProviderModels(session.providerId);
        stdout.write(
          models.map((id) => (id === session.modelId ? style.accent(`● ${id}`) : `  ${id}`)).join('\n') + '\n',
        );
        return 'handled';
      }

      case 'sessions': {
        const sessions = listSessions().slice(0, 15);
        stdout.write(
          sessions.length
            ? sessions
                .map(
                  (item) =>
                    `${style.accent(item.id)}  ${style.gray(item.updatedAt.slice(0, 16).replace('T', ' '))}  ${tildify(item.workspace)}`,
                )
                .join('\n') + '\n'
            : style.gray('No saved sessions.\n'),
        );
        return 'handled';
      }

      case 'status': {
        const auth = readAuth();
        const row = (label: string, value: string) => `  ${style.gray(label.padEnd(10))}${value}\n`;
        stdout.write(
          row('provider', `${providerDef(session.providerId).name} ${style.gray(`[${session.providerId}]`)}`) +
            row('model', session.modelId || style.yellow('none — /model')) +
            row('session', session.sessionId) +
            row('workspace', tildify(session.workspace)) +
            row('aiolah', auth ? `signed in as ${auth.user.email}` : style.yellow('not signed in')),
        );
        return 'handled';
      }

      default:
        stdout.write(style.yellow(`Unknown command /${typed}. Type /help.\n`));
        return 'handled';
    }
  } catch (error) {
    stdout.write(style.red(`${error instanceof Error ? error.message : String(error)}\n`));
    return 'handled';
  }
}

function switchTo(session: ChatSession, provider: string, model: string): void {
  session.useModel(provider, model);
  setActiveSelection(provider, model);
  stdout.write(`${style.green('✓')} Now using ${style.bold(model)} ${style.gray(`· ${providerDef(provider).name}`)}\n`);
}
