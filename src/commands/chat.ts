import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { ChatSession, TurnInterruptedError, type PromptOrigin } from '../session.js';
import { SessionSync } from '../sessionSync.js';
import { ChatRemote } from '../remoteChat.js';
import { readAuth } from '../config.js';
import { checkLogin, loginNotice } from '../loginStatus.js';
import type { ImageInput } from '../protocol.js';
import { findLatestSession } from '../persistence.js';
import { ensureTrusted } from '../trust.js';
import { mcpSummary, startMcp } from '../mcp/index.js';
import { handleSlash, setCommandWorkspace } from '../slash.js';
import { providerDef, resolveProvider, resolveProviderModel } from '../providers.js';
import { packageVersion } from '../version.js';
import { TerminalInput } from '../terminalInput.js';
import type { ConfirmFn } from '../tools/index.js';
import {
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
  addDir?: string[];
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  const workspaceRoot = resolve(options.workspace);
  // Asked before readline takes over stdin, and before any tool can run here.
  if (!(await ensureTrusted(workspaceRoot))) {
    process.exitCode = 1;
    return;
  }
  // Also before readline: new project servers are asked about in the same way.
  const mcp = await startMcp(workspaceRoot);
  setCommandWorkspace(workspaceRoot);
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const resumeId = options.resume ?? (options.continue ? findLatestSession()?.id : undefined);

  let permissionMode: PermissionMode = resolvePermissionMode(options);
  /** Tools the user allowed for the rest of this session ("always" at the Allow prompt). */
  const alwaysAllowed = new Set<string>();
  let chat: ChatSession | undefined;
  /** Set by /remote-control; shares this chat with /code. */
  let remote: ChatRemote | undefined;

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
      remote: remote?.active ?? false,
    }),
  );

  // Only reached when the permission mode wants a human answer (see ChatSession).
  // With /remote-control on, /code clients are asked too and the first answer wins.
  const confirm: ConfirmFn = async (description, tool) => {
    if (alwaysAllowed.has(tool)) {
      return true;
    }
    const remoteQuestion = remote?.ask(description) ?? null;
    const local = box
      .confirm(
        description
          .replace(/^run_bash: /, '$ ')
          .replace(/^write_file: /, 'Write ')
          .replace(/^edit_file: /, 'Edit ')
          .replace(/^mcp: /, 'MCP '),
      )
      .then((answer) => ({ answer }));
    const first = remoteQuestion
      ? await Promise.race([local, remoteQuestion.answer.then((allow) => ({ allow }))])
      : await local;
    if ('allow' in first) {
      box.cancelConfirm();
      return first.allow;
    }
    remoteQuestion?.cancel();
    if (first.answer === 'always') {
      alwaysAllowed.add(tool);
    }
    return first.answer !== 'no';
  };

  // A provider without a chosen model still opens the chat, so /model can pick one.
  const provider = resolveProvider(options.provider);
  let model = '';
  let modelHint: string | undefined;
  try {
    model = await resolveProviderModel(provider, options.model);
  } catch (error) {
    modelHint = error instanceof Error ? error.message : String(error);
  }
  chat = new ChatSession({
    provider,
    model,
    workspaceRoot,
    confirm,
    permissionMode: () => permissionMode,
    resumeId,
    mcp,
  });
  const session = chat;
  for (const dir of options.addDir ?? []) {
    session.addDir(dir);
  }

  // A stack: a subagent's tool calls run inside the `task` call that started it.
  const pendingTools: { name: string; input: unknown }[] = [];
  let toolsRan = 0;
  session.on('tool', ({ name, input, agent }: { name: string; input: unknown; agent?: string }) => {
    pendingTools.push({ name, input });
    box.setActivity(`${agent ? `${agent} › ` : ''}${toolActivity(name, input)}`);
  });
  session.on('tool_result', ({ name, result, agent }: { name: string; result: string; agent?: string }) => {
    const call = pendingTools.pop();
    toolsRan += 1;
    box.setActivity('');
    const line = toolLine(name, call?.input, result);
    box.print(agent ? line.replace(/^(\s*)/, `$1${style.gray(`${agent} ›`)} `) : line);
  });
  session.on('hook_error', ({ message }: { message: string }) => {
    box.print(style.yellow(`${' '.repeat(CONTENT_INDENT)}${message}`));
  });
  const sync = SessionSync.attach(session, { origin: 'terminal' });
  await session.startSession(resumeId ? 'resume' : 'startup');

  /** One turn with the chat's output: the prompt, tool lines, the answer and the footer. */
  async function runTurn(text: string, origin: PromptOrigin, images: ImageInput[] = [], label?: string): Promise<void> {
    const attached = images.length ? ` [${images.length} image${images.length === 1 ? '' : 's'}]` : '';
    const source = origin === 'remote' ? `\n${' '.repeat(CONTENT_INDENT)}${style.gray('from /code')}` : '';
    box.print(`${userMessage(`${label ?? text}${attached}`)}${source}\n`);
    if (!session.modelId) {
      box.print(`${' '.repeat(CONTENT_INDENT)}${style.yellow('Choose a model first:')} ${style.accent('/models')}\n`);
      return;
    }

    const startedAt = Date.now();
    toolsRan = 0;
    box.setBusy(true);
    try {
      const { reply } = await session.send(text, origin, images);
      box.setBusy(false);
      if (reply.trim()) {
        box.print(`${toolsRan ? '\n' : ''}${assistantMessage(reply.trim())}`);
      }
      box.print(`\n${turnFooter(modeLabel(permissionMode), session.modelId, Date.now() - startedAt)}\n`);
    } catch (error) {
      box.setBusy(false);
      const message =
        error instanceof TurnInterruptedError ? 'Interrupted' : error instanceof Error ? error.message : String(error);
      box.print(`${' '.repeat(CONTENT_INDENT)}${style.red(message)}`);
      box.print(`\n${turnFooter(modeLabel(permissionMode), session.modelId, Date.now() - startedAt, true)}\n`);
    } finally {
      pendingTools.length = 0;
    }
  }

  // /clear and /resume switch the conversation: redraw the screen for it.
  session.on('session_changed', ({ reason }: { reason: 'new' | 'resume' | 'fork' }) => {
    if (reason === 'fork') {
      box.refresh();
      return;
    }
    box.clearScreen();
    if (reason === 'resume') {
      const items = session.renderHistory();
      const shown = items.slice(-RESUME_TRANSCRIPT_ITEMS);
      if (items.length > shown.length) {
        box.print(style.gray(`${' '.repeat(CONTENT_INDENT)}… ${items.length - shown.length} earlier messages`));
      }
      for (const item of shown) {
        if (item.role === 'tool') {
          box.print(toolLine(item.name, item.input, item.result));
        } else if (item.role === 'user') {
          box.print(`\n${userMessage(item.text)}\n`);
        } else {
          box.print(assistantMessage(item.text.trim()));
        }
      }
      box.setNotice(style.gray(`Resumed session ${session.sessionId}`));
    } else {
      box.setNotice(style.gray('New conversation — the previous one is in /resume'));
    }
  });
  // Automatic compaction (near the context limit) shows in the status row.
  session.on('compact_start', ({ trigger }: { trigger: string }) => {
    if (trigger !== 'manual') {
      box.setActivity('Compacting the conversation…');
    }
  });
  session.on('compact_end', ({ trigger, ok }: { trigger: string; ok: boolean }) => {
    if (trigger !== 'manual' && ok) {
      box.print(style.gray(`${' '.repeat(CONTENT_INDENT)}Conversation compacted to fit the context window.`));
    }
  });

  /** `/memory edit`: opens an instruction file in $VISUAL / $EDITOR, creating it from a template. */
  function editFile(path: string, template: string): void {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, template, 'utf8');
    }
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
    box.unmount();
    stdin.setRawMode?.(false);
    const result = spawnSync(editor, [path], { stdio: 'inherit', shell: process.platform === 'win32' });
    stdin.setRawMode?.(true);
    if (result.error) {
      box.print(style.yellow(`${' '.repeat(CONTENT_INDENT)}Could not start ${editor}: ${result.error.message}`));
    }
  }

  /** `/remote-control [name]`: share this chat with /code, or stop sharing it. */
  async function toggleRemote(name?: string): Promise<void> {
    if (remote?.active) {
      remote.stop();
      box.print(`${' '.repeat(CONTENT_INDENT)}${style.gray('Remote Control disconnected.')}`);
      box.refresh();
      return;
    }
    const auth = readAuth();
    if (!auth) {
      const hint = `${style.yellow('Sign in to aiolah first:')} ${style.accent('/connect aiolah')}`;
      box.print(`${' '.repeat(CONTENT_INDENT)}${hint}`);
      return;
    }
    remote ??= new ChatRemote(session, sync, {
      runTurn: (text, images) => void runTurn(text, 'remote', images),
      notice: (line) => box.setNotice(style.gray(line)),
      modelChanged: () => box.refresh(),
      interrupted: () => box.cancelConfirm(),
    });
    const deviceName = name?.trim() || `${hostname()} · ${basename(workspaceRoot) || workspaceRoot}`;
    box.print(`${' '.repeat(CONTENT_INDENT)}${style.green(await remote.start(auth, deviceName))}`);
    box.refresh();
  }

  if (box.enhanced) {
    box.showHome();
  } else {
    stdout.write(
      `aiolah chat — ${providerDef(session.providerId).name} · ${session.modelId || 'no model'}, ` +
        `workspace ${workspaceRoot}\n` +
        `Type /help for commands, "exit" to quit.\n`,
    );
  }
  const mcpProblem = mcpSummary(mcp);
  if (modelHint) {
    box.setNotice(style.yellow(modelHint));
  } else if (mcpProblem) {
    box.setNotice(style.yellow(mcpProblem));
  } else if (resumeId) {
    box.setNotice(style.gray(`Resumed session ${session.sessionId}`));
  }
  // Checking also renews the login (it stays valid while used); warn when it is about to end.
  if (readAuth()) {
    void checkLogin().then((state) => {
      const notice = loginNotice(state);
      if (notice) {
        box.setNotice(style.yellow(notice));
      }
    });
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
          mcp,
          print: (text) => box.print(text),
          pick: (pickOptions) => box.pick(pickOptions),
          loading: (text) => {
            box.setBusy(text !== null);
            if (text) box.setActivity(text);
          },
          suspend: () => box.unmount(),
          clearScreen: () => box.clearScreen(),
          remoteControl: toggleRemote,
          runPrompt: async (prompt, label) => {
            await waitUntilIdle(session);
            await runTurn(prompt, 'terminal', [], label);
          },
          editFile,
          permissionMode: {
            get: () => permissionMode,
            set: (mode) => {
              permissionMode = mode;
              box.refresh();
            },
          },
        });
        if (result === 'exit') break;
        box.print('');
        continue;
      }

      // A prompt from /code may still be running; this one waits for it.
      await waitUntilIdle(session);
      await runTurn(line, 'terminal');
    }
  } finally {
    box.setBusy(false);
    box.unmount();
    rl.close();
    remote?.stop();
    await Promise.all([sync?.flush(), mcp.close()]);
    if (session.renderHistory().length) {
      stdout.write(`\nResume this session with:\naiolah --resume ${session.sessionId}\n\n`);
    }
  }
}

/** How many messages /resume shows again on screen. */
const RESUME_TRANSCRIPT_ITEMS = 30;

/** Resolves once the session has no running turn. */
function waitUntilIdle(session: ChatSession): Promise<void> {
  if (!session.isRunning) {
    return Promise.resolve();
  }
  return new Promise((resolveIdle) => {
    const done = () => {
      session.off('turn_end', done);
      session.off('turn_error', done);
      resolveIdle();
    };
    session.on('turn_end', done);
    session.on('turn_error', done);
  });
}

function modeLabel(mode: PermissionMode): string {
  switch (mode) {
    case 'acceptEdits':
      return style.yellow('Accept edits');
    case 'auto':
      return style.green('Auto');
    case 'plan':
      return style.cyan('Plan');
    case 'bypassPermissions':
      return style.red('Bypass');
    default:
      return style.blue('Default');
  }
}
