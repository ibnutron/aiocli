import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { ChatSession, TurnInterruptedError } from '../session.js';
import { SessionSync } from '../sessionSync.js';
import { findLatestSession } from '../persistence.js';
import { ask } from '../prompt.js';
import { handleSlash } from '../slash.js';
import { providerDef, resolveProvider, resolveProviderModel } from '../providers.js';
import { readAuth } from '../config.js';
import { packageVersion } from '../version.js';
import { TerminalInput } from '../terminalInput.js';
import {
  applyPermissionMode,
  nextPermissionMode,
  resolvePermissionMode,
  type PermissionMode,
  type PermissionOptions,
} from '../permissions.js';
import {
  Spinner,
  banner,
  hangingIndent,
  renderMarkdown,
  rule,
  style,
  toolSummary,
  toolTitle,
} from '../ui.js';

interface ChatOptions extends PermissionOptions {
  model?: string;
  provider?: string;
  workspace: string;
  resume?: string;
  continue?: boolean;
}

const PROMPT = `${style.accent('❯')} `;

export async function chatCommand(options: ChatOptions): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout, historySize: 200 });
  const workspaceRoot = resolve(options.workspace);

  const resumeId = options.resume ?? (options.continue ? findLatestSession()?.id : undefined);

  let permissionMode: PermissionMode = resolvePermissionMode(options);
  /** Tools the user allowed for the rest of this session ("a" at the Allow prompt). */
  const alwaysAllowed = new Set<string>();

  const spinner = new Spinner();
  let session: ChatSession | undefined;

  const input = new TerminalInput(rl, {
    onInterrupt: () => session?.interrupt(),
    onCycleMode: () => {
      permissionMode = nextPermissionMode(permissionMode);
      if (input.mode === 'prompt') {
        redrawStatusLine();
      } else {
        spinner.stop();
        stdout.write(`${modeLabel(permissionMode, true)}\n`);
        spinner.start();
      }
    },
    onExit: () => rl.close(),
  });

  const confirm = applyPermissionMode(
    () => permissionMode,
    async (description, tool) => {
      if (alwaysAllowed.has(tool)) {
        return true;
      }
      const previousMode = input.mode;
      input.mode = 'passthrough';
      try {
        const answer = (
          await ask(
            rl,
            `\n${style.yellow('?')} Allow ${style.bold(description)}\n  ${style.gray('y')} yes  ${style.gray('a')} yes, don't ask again for ${tool}  ${style.gray('n')} no ${style.accent('❯')} `,
          )
        )
          ?.trim()
          .toLowerCase();
        if (answer === 'a') {
          alwaysAllowed.add(tool);
          return true;
        }
        return answer === 'y' || answer === 'yes';
      } finally {
        input.mode = previousMode;
      }
    },
  );

  // A provider without a chosen model still opens the chat, so /model can pick one.
  const provider = resolveProvider(options.provider);
  let model = '';
  let modelHint: string | undefined;
  try {
    model = await resolveProviderModel(provider, options.model);
  } catch (error) {
    modelHint = error instanceof Error ? error.message : String(error);
  }
  const chat = new ChatSession({ provider, model, workspaceRoot, confirm, resumeId });
  session = chat;

  const pendingTools: { name: string; input: unknown }[] = [];
  chat.on('tool', ({ name, input: toolInput }: { name: string; input: unknown }) => {
    spinner.stop();
    pendingTools.push({ name, input: toolInput });
    stdout.write(`${style.accent('●')} ${toolTitle(name, toolInput)}\n`);
  });
  chat.on('tool_result', ({ name, result }: { name: string; result: string }) => {
    const call = pendingTools.shift();
    stdout.write(`  ${style.gray('⎿')}  ${toolSummary(name, call?.input, result)}\n`);
    spinner.start();
  });
  chat.on('confirm_wait', () => spinner.stop());
  chat.on('confirm_done', () => stdout.write('\n'));
  const sync = SessionSync.attach(chat, { origin: 'terminal' });

  const auth = readAuth();
  stdout.write(
    '\n' +
      banner({
        version: packageVersion(),
        provider: providerDef(chat.providerId).name,
        model: chat.modelId,
        account: chat.providerId === 'aiolah' ? auth?.user.email : undefined,
        workspace: workspaceRoot,
      }) +
      '\n',
  );
  if (resumeId) {
    stdout.write(style.gray(`  Resumed session ${chat.sessionId}\n\n`));
  }
  if (modelHint) {
    stdout.write(`${style.yellow('!')} ${modelHint}\n\n`);
  }
  stdout.write(style.gray(`  Tips: type ${style.accent('/')} for commands · esc interrupts · shift+tab changes permissions\n\n`));

  function statusLine(): string {
    const right = chat.modelId
      ? `${style.bold(chat.modelId)} ${style.gray(providerDef(chat.providerId).name)}`
      : style.yellow('no model — /model');
    return rule(modeLabel(permissionMode), right);
  }

  /** Rewrites the status rule sitting just above the prompt. */
  function redrawStatusLine(): void {
    const { rows } = rl.getCursorPos();
    stdout.write(`\x1b7\x1b[${rows + 1}A\r\x1b[2K${statusLine()}\x1b8`);
  }

  try {
    while (true) {
      stdout.write(`${statusLine()}\n`);
      input.reset();
      input.mode = 'prompt';
      const line = await ask(rl, PROMPT);
      input.mode = 'passthrough';
      if (line === null || ['exit', 'quit'].includes(line.trim().toLowerCase())) {
        break;
      }
      if (!line.trim()) {
        continue;
      }
      if (line.trim().startsWith('/')) {
        if ((await handleSlash(line, rl, chat)) === 'exit') break;
        stdout.write('\n');
        continue;
      }

      if (!chat.modelId) {
        stdout.write(`${style.yellow('!')} Choose a model first: ${style.accent('/model')}\n\n`);
        continue;
      }

      stdout.write('\n');
      input.mode = 'busy';
      spinner.start();
      try {
        const { reply } = await chat.send(line);
        spinner.stop(true);
        if (reply.trim()) {
          stdout.write(`${style.accent('●')} ${hangingIndent(renderMarkdown(reply.trim()))}\n`);
        }
      } catch (error) {
        spinner.stop(true);
        if (error instanceof TurnInterruptedError) {
          stdout.write(`  ${style.gray('⎿')}  ${style.red('Interrupted')} ${style.gray('· what should aiolah do instead?')}\n`);
        } else {
          stdout.write(`${style.red('●')} ${style.red(error instanceof Error ? error.message : String(error))}\n`);
        }
      } finally {
        pendingTools.length = 0;
        input.mode = 'passthrough';
      }
      stdout.write('\n');
    }
  } finally {
    spinner.stop(true);
    rl.close();
    await sync?.flush();
  }
}

function modeLabel(mode: PermissionMode, withHint = false): string {
  const hint = withHint ? style.gray(' (shift+tab to cycle)') : '';
  switch (mode) {
    case 'acceptEdits':
      return `${style.yellow('⏵⏵ accept edits on')}${hint}`;
    case 'bypassPermissions':
      return `${style.red('⏵⏵ bypass permissions on')}${hint}`;
    default:
      return `${style.gray('? /help')}${withHint ? style.gray(' · asks before edits (shift+tab to cycle)') : ''}`;
  }
}
