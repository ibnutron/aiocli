import type { Interface } from 'node:readline/promises';
import type { ChatSession } from './session.js';
import type { PickOptions, PickSection } from './terminalInput.js';
import { listSessions } from './persistence.js';
import { readAuth } from './config.js';
import { fetchModels } from './models.js';
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

export interface SlashCommand {
  name: string;
  args?: string;
  description: string;
  /** Still works when typed, but isn't offered in the menu or /help. */
  hidden?: boolean;
}

/** Commands of `aiolah chat`, in the order the autocomplete menu and /help show them. */
export const SLASH_COMMANDS: SlashCommand[] = [
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
  { name: 'clear', description: 'Clear the screen' },
  { name: 'help', description: 'Show commands and shortcuts' },
  { name: 'exit', description: 'Quit' },
  { name: 'model', args: '[id]', description: 'Switch model', hidden: true },
  { name: 'provider', args: '[id]', description: 'Switch provider', hidden: true },
  { name: 'rc', args: '[name]', description: 'Same as /remote-control', hidden: true },
];

/** Menu commands whose name starts with `prefix` (without the slash). */
export function matchSlashCommands(prefix: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => !command.hidden && command.name.startsWith(prefix.toLowerCase()));
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
}

const CONNECT_ACTION = '\u0000connect';
const LIST_TIMEOUT_MS = 15_000;

function helpText(): string {
  const visible = SLASH_COMMANDS.filter((command) => !command.hidden);
  const width = Math.max(...visible.map((command) => `/${command.name} ${command.args ?? ''}`.length)) + 2;
  const commands = visible.map(
    (command) => `  ${style.accent(`/${command.name} ${command.args ?? ''}`.padEnd(width))}${style.gray(command.description)}`,
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
  const command = SLASH_COMMANDS.some((item) => item.name === typed)
    ? typed
    : (matchSlashCommands(typed)[0]?.name ?? typed);

  try {
    switch (command) {
      case 'help':
      case '?':
      case '':
        print(helpText());
        return 'handled';

      case 'clear':
        context.clearScreen();
        return 'handled';

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
                    `  ${style.accent(item.id)}  ${style.gray(item.updatedAt.slice(0, 16).replace('T', ' '))}  ${tildify(item.workspace)}`,
                )
                .join('\n')
            : style.gray('  No saved sessions.'),
        );
        return 'handled';
      }

      case 'status': {
        const auth = readAuth();
        const row = (label: string, value: string) => `  ${style.gray(label.padEnd(10))}${value}`;
        print(
          [
            row('provider', `${providerDef(session.providerId).name} ${style.gray(`[${session.providerId}]`)}`),
            row('model', session.modelId || style.yellow('none — /models')),
            row('session', session.sessionId),
            row('workspace', tildify(session.workspace)),
            row('aiolah', auth ? `signed in as ${auth.user.email}` : style.yellow('not signed in — /connect aiolah')),
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

      default:
        print(style.yellow(`  Unknown command /${typed}. Type /help.`));
        return 'handled';
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
        hint: model.tier ? model.tier.charAt(0).toUpperCase() + model.tier.slice(1) : undefined,
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
  context.print(`  ${style.green('✓')} Now using ${style.bold(model)} ${style.gray(`· ${providerDef(provider).name}`)}`);
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
