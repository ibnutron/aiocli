import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { log } from './log.js';

/**
 * Hooks in Claude Code's settings format, so existing ones work:
 * `{ "hooks": { "<Event>": [{ "matcher": "<regex>", "hooks": [{ "type": "command", "command": "…" }] }] } }`
 * read from ~/.aiolah/settings.json and the project's .aiolah/ and .claude/
 * settings.json / settings.local.json. The command gets the event as JSON on
 * stdin; exit code 2 blocks (its stderr goes back to the model or the user),
 * other non-zero codes are reported and ignored, and on exit 0 the stdout of
 * UserPromptSubmit / SessionStart hooks is added as context.
 */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks?: HookCommand[];
}

export interface ConfiguredHook {
  event: HookEvent;
  matcher: string;
  command: string;
  timeoutMs: number;
  source: string;
}

export interface HookResult {
  /** A hook exited with code 2. */
  blocked: boolean;
  /** stderr of blocking hooks (the reason). */
  reason: string;
  /** stdout of hooks that exited 0, for events that add context. */
  context: string;
  /** Hooks that failed otherwise (shown, not fatal). */
  errors: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 10_000;

/** Claude Code's tool names, so matchers written for it (Bash, Edit|Write, …) also match aiolah's tools. */
const CLAUDE_TOOL_NAMES: Record<string, string> = {
  run_bash: 'Bash',
  write_file: 'Write',
  edit_file: 'Edit',
  read_file: 'Read',
  list_dir: 'LS',
  task: 'Task',
};

function settingsFiles(workspaceRoot: string): string[] {
  const root = resolve(workspaceRoot);
  return [
    join(homedir(), '.aiolah', 'settings.json'),
    ...['.aiolah', '.claude'].flatMap((dir) => [
      join(root, dir, 'settings.json'),
      join(root, dir, 'settings.local.json'),
    ]),
  ];
}

export function loadHooks(workspaceRoot: string): ConfiguredHook[] {
  const hooks: ConfiguredHook[] = [];
  for (const file of settingsFiles(workspaceRoot)) {
    let settings: { hooks?: Record<string, HookGroup[]> };
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const event of HOOK_EVENTS) {
      for (const group of settings.hooks?.[event] ?? []) {
        for (const hook of group.hooks ?? []) {
          if ((hook.type ?? 'command') === 'command' && hook.command) {
            hooks.push({
              event,
              matcher: group.matcher ?? '',
              command: hook.command,
              timeoutMs: hook.timeout ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS,
              source: file,
            });
          }
        }
      }
    }
  }
  return hooks;
}

function matches(matcher: string, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*' || toolName === undefined) {
    return true;
  }
  let pattern: RegExp;
  try {
    pattern = new RegExp(`^(?:${matcher})$`);
  } catch {
    return false;
  }
  return pattern.test(toolName) || pattern.test(CLAUDE_TOOL_NAMES[toolName] ?? '');
}

function runCommand(
  command: string,
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, AIOLAH_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      stderr += `\n(hook timed out after ${Math.round(timeoutMs / 1000)}s)`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout = (stdout + chunk.toString('utf8')).slice(0, MAX_OUTPUT_CHARS)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(0, MAX_OUTPUT_CHARS)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * Runs the hooks of `event` (those whose matcher fits `payload.tool_name`) one
 * after another with the event as JSON on stdin.
 */
export async function runHooks(
  workspaceRoot: string,
  event: HookEvent,
  payload: Record<string, unknown>,
): Promise<HookResult> {
  const result: HookResult = { blocked: false, reason: '', context: '', errors: [] };
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
  const hooks = loadHooks(workspaceRoot).filter((hook) => hook.event === event && matches(hook.matcher, toolName));
  if (!hooks.length) {
    return result;
  }
  const input = JSON.stringify({ hook_event_name: event, cwd: resolve(workspaceRoot), ...payload });
  for (const hook of hooks) {
    const { code, stdout, stderr } = await runCommand(hook.command, input, resolve(workspaceRoot), hook.timeoutMs);
    log(code === 0 ? 'DEBUG' : 'INFO', 'hook ran', { event, command: hook.command, exit: code });
    if (code === 2) {
      result.blocked = true;
      result.reason = [result.reason, stderr.trim() || `blocked by hook: ${hook.command}`].filter(Boolean).join('\n');
    } else if (code === 0) {
      if (stdout.trim() && (event === 'UserPromptSubmit' || event === 'SessionStart')) {
        result.context = [result.context, stdout.trim()].filter(Boolean).join('\n');
      }
    } else {
      result.errors.push(`${event} hook "${hook.command}" failed (exit ${code ?? 'error'}): ${stderr.trim()}`);
    }
  }
  return result;
}
