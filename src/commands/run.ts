import { stderr, stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { ChatSession } from '../session.js';
import { SessionSync } from '../sessionSync.js';
import { findLatestSession } from '../persistence.js';
import { resolveSelection } from '../providers.js';
import { resolvePermissionMode, type PermissionOptions } from '../permissions.js';
import type { ConfirmFn } from '../tools/index.js';
import { mcpSummary, startMcp } from '../mcp/index.js';

const STDIN_GRACE_MS = 300;

interface RunOptions extends PermissionOptions {
  model?: string;
  provider?: string;
  workspace: string;
  resume?: string;
  continue?: boolean;
  outputFormat: string;
  addDir?: string[];
}

/**
 * Non-interactive mode for scripts and CI: one prompt in (arguments and/or
 * piped stdin), the final answer out, then exit. Nobody can answer an
 * Allow/Deny prompt here, so whatever the permission mode doesn't allow is
 * denied (use --permission-mode acceptEdits or --dangerously-skip-permissions).
 */
export async function runCommand(promptParts: string[], options: RunOptions): Promise<void> {
  if (!['text', 'json'].includes(options.outputFormat)) {
    throw new Error('--output-format must be "text" or "json".');
  }

  let prompt = promptParts.join(' ').trim();
  if (!stdin.isTTY) {
    // With a prompt argument, only take stdin if something is actually piped —
    // an open-but-silent stdin (CI, spawned processes) must not hang the run.
    const piped = (await readStdin(prompt ? STDIN_GRACE_MS : null)).trim();
    if (piped) {
      prompt = prompt ? `${prompt}\n\n${piped}` : piped;
    }
  }
  if (!prompt) {
    throw new Error('No prompt given. Usage: aiolah run "<prompt>" (or pipe input into it).');
  }

  // Only reached when the permission mode wants a human answer, and nobody can give one here.
  const confirm: ConfirmFn = async (description, tool) => {
    const hint = description.includes(' — auto mode: ')
      ? '--dangerously-skip-permissions'
      : ['write_file', 'edit_file'].includes(tool)
        ? '--permission-mode acceptEdits'
        : '--permission-mode auto or --dangerously-skip-permissions';
    stderr.write(`[denied] ${description} — nobody can confirm in non-interactive mode; allow it with ${hint}\n`);
    return false;
  };

  const resumeId = options.resume ?? (options.continue ? findLatestSession()?.id : undefined);
  const workspaceRoot = resolve(options.workspace);
  // Nobody can approve new project servers here: only approved ones start.
  const mcp = await startMcp(workspaceRoot);
  const mcpProblem = mcpSummary(mcp);
  if (mcpProblem) {
    stderr.write(`[mcp] ${mcpProblem.replace(' — see /mcp', '')}\n`);
  }
  const session = new ChatSession({
    ...(await resolveSelection(options)),
    workspaceRoot,
    confirm,
    permissionMode: resolvePermissionMode(options),
    resumeId,
    mcp,
  });

  for (const dir of options.addDir ?? []) {
    session.addDir(dir);
  }
  session.on('tool', ({ name, input }) => {
    stderr.write(`[tool] ${name} ${JSON.stringify(input)}\n`);
  });
  session.on('hook_error', ({ message }: { message: string }) => stderr.write(`[hook] ${message}\n`));
  await session.startSession(resumeId ? 'resume' : 'startup');
  const sync = SessionSync.attach(session, { origin: 'script' });

  let reply: string;
  try {
    ({ reply } = await session.send(prompt, 'script'));
  } finally {
    // Make sure the session reaches aiolah before the process exits.
    await Promise.all([sync?.flush(), mcp.close()]);
  }

  if (options.outputFormat === 'json') {
    stdout.write(`${JSON.stringify({ session_id: session.sessionId, model: session.modelId, result: reply })}\n`);
  } else {
    stdout.write(`${reply}\n`);
  }
}

/**
 * Reads stdin to EOF. With `graceMs`, gives up (returning '') if no data
 * arrives within that time; once data starts flowing it reads to the end.
 */
function readStdin(graceMs: number | null): Promise<string> {
  return new Promise((resolveRead, rejectRead) => {
    const chunks: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;

    const finish = () => {
      clearTimeout(timer);
      stdin.off('data', onData).off('end', finish).off('error', rejectRead);
      stdin.pause();
      resolveRead(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string) => {
      clearTimeout(timer);
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };

    stdin.on('data', onData).on('end', finish).on('error', rejectRead);
    if (graceMs !== null) {
      timer = setTimeout(finish, graceMs);
    }
  });
}
