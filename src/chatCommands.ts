import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { stdout } from 'node:process';
import { apiRequest, readAuth } from './config.js';
import type { ChatSession } from './session.js';

/** Tool results longer than this are cut in exports. */
const EXPORT_RESULT_CHARS = 2_000;
const DIFF_MAX_LINES = 400;

/** The last (or `nth`-last) answer of the assistant, for /copy. */
export function assistantReply(session: ChatSession, nth = 1): string | null {
  const answers = session.renderHistory().filter((item) => item.role === 'assistant' && item.text.trim());
  const item = answers[answers.length - nth];
  return item && item.role === 'assistant' ? item.text.trim() : null;
}

/**
 * Copies `text` with the system clipboard tool, and also through OSC 52 so it
 * works in terminals over SSH. Returns how it was copied, or null.
 */
export function copyToClipboard(text: string): string | null {
  const tools: [string, string[]][] =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['powershell', ['-NoProfile', '-Command', '$input | Set-Clipboard']]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];
  let method: string | null = null;
  for (const [command, args] of tools) {
    const result = spawnSync(command, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!result.error && result.status === 0) {
      method = command;
      break;
    }
  }
  if (stdout.isTTY) {
    stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    method ??= 'the terminal (OSC 52)';
  }
  return method;
}

/** `/export [file]`: the conversation as Markdown; returns the path written. */
export function exportConversation(session: ChatSession, target?: string): string {
  const name = target?.trim() || `aiolah-session-${session.sessionId}.md`;
  const path = isAbsolute(name) ? name : join(session.workspace, name);
  const lines = [
    `# ${session.title ?? 'aiolah session'}`,
    '',
    `- Session: ${session.sessionId}`,
    `- Model: ${session.modelId || 'none'} (${session.providerId})`,
    `- Workspace: ${session.workspace}`,
    `- Exported: ${new Date().toISOString()}`,
    '',
  ];
  for (const item of session.renderHistory()) {
    if (item.role === 'tool') {
      const result =
        item.result.length > EXPORT_RESULT_CHARS
          ? `${item.result.slice(0, EXPORT_RESULT_CHARS)}\n… (cut)`
          : item.result;
      lines.push(`**Tool \`${item.name}\`** \`${JSON.stringify(item.input ?? {})}\``, '', '````', result, '````', '');
    } else {
      lines.push(`## ${item.role === 'user' ? 'User' : 'Assistant'}`, '', item.text.trim(), '');
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'), 'utf8');
  return path;
}

/** `/diff`: what changed in the workspace according to git (stat, or the full diff with `full`). */
export function workspaceDiff(workspaceRoot: string, full: boolean): string {
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const inside = git('rev-parse', '--is-inside-work-tree');
  if (inside.error || inside.status !== 0) {
    return 'This workspace is not a git repository, so there is no diff to show.';
  }
  const status = git('status', '--short').stdout.trimEnd();
  if (!status) {
    return 'No changes: the working tree is clean.';
  }
  if (!full) {
    const stat = git('diff', 'HEAD', '--stat').stdout.trimEnd();
    return [status, stat ? `\n${stat}` : '', '\n/diff full shows the changes themselves.'].filter(Boolean).join('\n');
  }
  const diff = git('diff', 'HEAD').stdout.trimEnd().split('\n').filter(Boolean);
  const untracked = status
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => `new file (untracked): ${line.slice(3)}`);
  const shown = diff.slice(0, DIFF_MAX_LINES);
  return [
    ...shown,
    ...(diff.length > shown.length ? [`… ${diff.length - shown.length} more lines (git diff HEAD)`] : []),
    ...untracked,
  ].join('\n');
}

interface MeWithQuota {
  plan?: { name: string; is_free: boolean };
  quota?: { remaining: number | null; resets_at: string | null; credits: number } | null;
  /** Monthly credits (cost based) + top-up balance, sent by newer servers. */
  credits?: { limit: number | null; used: number; remaining: number | null; unlimited: boolean; resets_at: string; top_up?: number } | null;
}

/** `/usage`: the aiolah plan and the chat quota left (model requests through aiolah use it). */
export async function planUsage(): Promise<string> {
  const auth = readAuth();
  if (!auth) {
    return 'Not signed in to aiolah (/connect aiolah); with your own provider key, usage is billed by that provider.';
  }
  const me = await apiRequest<MeWithQuota>(auth.server, '/api/v1/app/cli/me', { token: auth.token });
  if (me.status !== 200 || !me.data.plan) {
    return `Could not load your plan from aiolah (HTTP ${me.status}).`;
  }
  const fmt = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: value < 10 ? 1 : 0 });
  const monthly = me.data.credits;
  if (monthly) {
    const left = monthly.unlimited || monthly.remaining === null
      ? `${fmt(monthly.used)} credits used this month (not limited)`
      : `${fmt(monthly.remaining)} of ${fmt(monthly.limit ?? 0)} monthly credits left, resets ${new Date(monthly.resets_at).toLocaleDateString()}`;
    const topUp = monthly.top_up ? ` · ${fmt(monthly.top_up)} top-up credits (never expire)` : '';
    return `Plan ${me.data.plan.name} · ${left}${topUp}\nEach request costs credits by model (see aiolah models: $ cheap · $$ mid · $$$ expensive).`;
  }
  const quota = me.data.quota;
  const remaining =
    quota?.remaining === null || quota?.remaining === undefined ? 'unlimited' : `${quota.remaining} left`;
  const reset = quota?.resets_at ? `, resets ${new Date(quota.resets_at).toLocaleString()}` : '';
  const credits = quota?.credits ? ` · ${quota.credits} extra credits` : '';
  return `Plan ${me.data.plan.name} · chat requests: ${remaining}${reset}${credits}`;
}
