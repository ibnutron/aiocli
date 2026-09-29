import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { ChatSession, TurnInterruptedError } from '../session.js';
import { SessionSync } from '../sessionSync.js';
import { findLatestSession } from '../persistence.js';
import { ensureTrusted } from '../trust.js';
import { handleSlash } from '../slash.js';
import { providerDef, resolveProvider, resolveProviderModel } from '../providers.js';
import { packageVersion } from '../version.js';
import { TerminalInput } from '../terminalInput.js';
import {
  applyPermissionMode,
  nextPermissionMode,
  resolvePermissionMode,
  type PermissionMode,
  type PermissionOptions,
} from '../permissions.js';
import { CONTENT_INDENT, assistantMessage, style, toolActivity, toolLine, turnFooter, userMessage } from '../ui.js';

interface ChatOptions extends PermissionOptions {
  model?: string;
  provider?: string;
  workspace: string;
  resume?: string;
  continue?: boolean;
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  const workspaceRoot = resolve(options.workspace);
  // Asked before readline takes over stdin, and before any tool can run here.
  if (!(await ensureTrusted(workspaceRoot))) {
    process.exitCode = 1;
    return;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const resumeId = options.resume ?? (options.continue ? findLatestSession()?.id : undefined);

  let permissionMode: PermissionMode = resolvePermissionMode(options);
  /** Tools the user allowed for the rest of this session ("always" at the Allow prompt). */
  const alwaysAllowed = new Set<string>();
  let chat: ChatSession | undefined;

  const box = new TerminalInput(
    rl,
    {
      onInterrupt: () => chat?.interrupt(),
      onCycleMode: () => {
        permissionMode = nextPermissionMode(permissionMode);
        box.refresh();
      },
    },
    () => ({
      mode: modeLabel(permissionMode),
      model: chat?.modelId ?? '',
      provider: chat ? providerDef(chat.providerId).name : '',
      workspace: workspaceRoot,
      version: packageVersion(),
    }),
  );

  const confirm = applyPermissionMode(
    () => permissionMode,
    async (description, tool) => {
      if (alwaysAllowed.has(tool)) {
        return true;
      }
      const answer = await box.confirm(
        description
          .replace(/^run_bash: /, '$ ')
          .replace(/^write_file: /, 'Write ')
          .replace(/^edit_file: /, 'Edit '),
      );
      if (answer === 'always') {
        alwaysAllowed.add(tool);
      }
      return answer !== 'no';
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
  chat = new ChatSession({ provider, model, workspaceRoot, confirm, resumeId });
  const session = chat;

  const pendingTools: { name: string; input: unknown }[] = [];
  let toolsRan = 0;
  session.on('tool', ({ name, input }: { name: string; input: unknown }) => {
    pendingTools.push({ name, input });
    box.setActivity(toolActivity(name, input));
  });
  session.on('tool_result', ({ name, result }: { name: string; result: string }) => {
    const call = pendingTools.shift();
    toolsRan += 1;
    box.setActivity('');
    box.print(toolLine(name, call?.input, result));
  });
  const sync = SessionSync.attach(session, { origin: 'terminal' });

  if (box.enhanced) {
    box.showHome();
  } else {
    stdout.write(
      `aiolah chat — ${providerDef(session.providerId).name} · ${session.modelId || 'no model'}, workspace ${workspaceRoot}\n` +
        `Type /help for commands, "exit" to quit.\n`,
    );
  }
  if (modelHint) {
    box.setNotice(style.yellow(modelHint));
  } else if (resumeId) {
    box.setNotice(style.gray(`Resumed session ${session.sessionId}`));
  }

  try {
    while (true) {
      const line = await box.read();
      if (line === null || ['exit', 'quit'].includes(line.trim().toLowerCase())) {
        break;
      }
      if (!line.trim()) {
        continue;
      }
      if (line.trim().startsWith('/')) {
        box.print(style.gray(`${' '.repeat(CONTENT_INDENT)}${line.trim()}`));
        const result = await handleSlash(line, {
          rl,
          session,
          print: (text) => box.print(text),
          pick: (pickOptions) => box.pick(pickOptions),
          loading: (text) => {
            box.setBusy(text !== null);
            if (text) box.setActivity(text);
          },
          suspend: () => box.unmount(),
          clearScreen: () => box.clearScreen(),
        });
        if (result === 'exit') break;
        box.print('');
        continue;
      }

      box.print(`${userMessage(line)}\n`);
      if (!session.modelId) {
        box.print(`${' '.repeat(CONTENT_INDENT)}${style.yellow('Choose a model first:')} ${style.accent('/models')}\n`);
        continue;
      }

      const startedAt = Date.now();
      toolsRan = 0;
      box.setBusy(true);
      try {
        const { reply } = await session.send(line);
        box.setBusy(false);
        if (reply.trim()) {
          box.print(`${toolsRan ? '\n' : ''}${assistantMessage(reply.trim())}`);
        }
        box.print(`\n${turnFooter(modeLabel(permissionMode), session.modelId, Date.now() - startedAt)}\n`);
      } catch (error) {
        box.setBusy(false);
        const message =
          error instanceof TurnInterruptedError
            ? 'Interrupted'
            : error instanceof Error
              ? error.message
              : String(error);
        box.print(`${' '.repeat(CONTENT_INDENT)}${style.red(message)}`);
        box.print(`\n${turnFooter(modeLabel(permissionMode), session.modelId, Date.now() - startedAt, true)}\n`);
      } finally {
        pendingTools.length = 0;
      }
    }
  } finally {
    box.setBusy(false);
    box.unmount();
    rl.close();
    await sync?.flush();
  }
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return style.yellow('Accept edits');
    case 'bypassPermissions':
      return style.red('Bypass');
    default:
      return style.blue('Default');
  }
}
